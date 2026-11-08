#!/usr/bin/env python3
"""Build the Warcraft reactor from pinned, generated PE modules.

Incremental objects are keyed by source, headers, compiler and flags. This
build produces a real WASM artifact, not evidence of playable Warcraft.

--variant compat builds the same code for engines without WebAssembly tail
calls (Safari before 18.2, Chrome before 112, Firefox before 121) as
wc3-compat.wasm: a lifted tail jump returns and its caller makes it
(runtime/cpu.h), so every direct call in lifted code is followed by
TAIL_RESUME in the copy of the shard that this build compiles.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODULES = [ROOT / "var/lift-v2" / name for name in ("war3", "game", "storm", "ijl15")]
FLAGS = ["--target=wasm32-wasip1-threads", "-pthread", "-matomics", "-mbulk-memory", "-mtail-call",
         "-O1", "-fno-delete-null-pointer-checks", "-std=c11",
         "-Wno-parentheses-equality"]
VARIANTS = {
    "standard": {"artifact": "wc3.wasm", "metadata": "build.json", "objects": "objects", "link_log": "link.log"},
    "compat": {"artifact": "wc3-compat.wasm", "metadata": "build-compat.json", "objects": "objects-compat",
               "link_log": "link-compat.log"},
}
TRAMPOLINE_VERSION = 1
# A call statement of its own: at the start of a line or after ; { }.
DIRECT_CALL = re.compile(r"(?:^|(?<=[;{}]))[ \t]*sub_[0-9a-f]{8}\(c\);", re.M)
CALL_LIKE = re.compile(r"\bsub_[0-9a-f]{8}\(")
DEFINITION = re.compile(r"^void sub_[0-9a-f]{8}\(CPU \*restrict c\) \{$", re.M)


def variant_flags(variant):
    if variant == "standard":
        return list(FLAGS)
    return ["-mno-tail-call" if flag == "-mtail-call" else flag for flag in FLAGS] + ["-DWC3_TAIL_TRAMPOLINE=1"]


def trampoline_source(text, name="source"):
    """The compat build's copy of lifted C: TAIL_RESUME after each direct call.

    The lifter writes a direct call only as `sub_XXXXXXXX(c);`. Any other
    reference to a lifted function followed by a parenthesis is refused: a
    call left without TAIL_RESUME would run a pending tail jump at the wrong
    level of the guest stack.
    """
    result, calls = DIRECT_CALL.subn(lambda match: match.group(0) + " TAIL_RESUME(c);", text)
    if len(CALL_LIKE.findall(text)) != calls + len(DEFINITION.findall(text)):
        raise ValueError(f"Unrecognized call to a lifted function in {name}; cannot build without tail calls")
    return result, calls


def wasm_features(path):
    """Feature names from a linked module's target_features section."""
    def leb(stream):
        value = shift = 0
        while True:
            byte = stream.read(1)
            if not byte:
                raise ValueError(f"Truncated WebAssembly module: {path}")
            value |= (byte[0] & 0x7f) << shift; shift += 7
            if byte[0] < 0x80:
                return value
    with path.open("rb") as stream:
        if stream.read(8) != b"\0asm\x01\0\0\0":
            raise ValueError(f"Not a WebAssembly module: {path}")
        while header := stream.read(1):
            size = leb(stream); end = stream.tell() + size
            if header[0] == 0:
                name = stream.read(leb(stream)).decode()
                if name == "target_features":
                    features = []
                    for _ in range(leb(stream)):
                        prefix = stream.read(1).decode()
                        features.append(prefix + stream.read(leb(stream)).decode())
                    return features
            stream.seek(end)
    return []


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sdk_path(explicit):
    if explicit:
        sdk = explicit.resolve()
    else:
        options = sorted((ROOT / "var/toolchains").glob("wasi-sdk-*"))
        sdk = next((path for path in reversed(options) if (path / "bin/clang").is_file()), None)
    if not sdk or not (sdk / "bin/clang").is_file():
        raise ValueError("Unpack wasi-sdk in var/toolchains or provide --sdk PATH")
    return sdk


def module_inputs(folders):
    modules, names, addresses = [], set(), set()
    for folder in folders:
        folder = folder.resolve()
        report_path = folder / "report.json"
        report = json.loads(report_path.read_text())
        name = report.get("module")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z_][a-z0-9_]*", name) or name in names:
            raise ValueError(f"Invalid or duplicate module name in {report_path}")
        if report.get("pending_candidates") or report.get("failed_functions"):
            raise ValueError(f"Incomplete generation in {report_path}; regenerate before linking")
        names.add(name)
        for function in report["functions"]:
            if function["status"] != "generated":
                continue
            address = int(function["address"], 16)
            if address in addresses:
                raise ValueError(f"Overlapping guest function 0x{address:08x}; relocate modules before lifting")
            addresses.add(address)
        sources = sorted(folder.glob("shard_*.c")) + [folder / "fntab.c"]
        if len(sources) < 2 or not all(path.is_file() for path in sources):
            raise ValueError(f"Missing generated C in {folder}")
        modules.append({"name": name, "folder": folder, "report": report, "sources": sources})
    if not modules:
        raise ValueError("At least one generated module is required")
    return modules


def registry_source(modules):
    lines = ['#include "runtime.h"']
    for module in modules:
        prefix = f"wc3_{module['name']}"
        lines += [f"extern const uint32_t {prefix}_count;",
                  f"extern const uint32_t {prefix}_address[];",
                  f"extern const guest_fn_t {prefix}_function[];"]
    lines.append("const Wc3LiftTable wc3_tables[] = {")
    for module in modules:
        prefix = f"wc3_{module['name']}"
        lines.append(f"    {{ &{prefix}_count, {prefix}_address, {prefix}_function }},")
    lines += ["};", f"const unsigned wc3_table_count = {len(modules)}u;", ""]
    return "\n".join(lines)


def build(args):
    started = time.monotonic()
    variant = getattr(args, "variant", "standard")
    names = VARIANTS[variant]
    sdk = sdk_path(args.sdk)
    compiler = sdk / "bin/clang"
    version = subprocess.run([str(compiler), "--version"], check=True, capture_output=True, text=True).stdout
    modules = module_inputs(args.module_dirs)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = output / names["objects"]
    cache.mkdir(exist_ok=True)
    headers = sorted((ROOT / "runtime").glob("*.h"))
    original_header_hashes = {str(path): digest(path) for path in headers}
    header_key = json.dumps(original_header_hashes, sort_keys=True)
    flags = variant_flags(variant) + (["-DWC3_STRICT_MEMORY=1"] if getattr(args, "strict_memory", False) else [])
    configuration = {"compiler": str(compiler), "version": version, "flags": flags}
    if variant != "standard":
        configuration.update(variant=variant, trampoline=TRAMPOLINE_VERSION)
    configuration_key = json.dumps(configuration, sort_keys=True)

    def compile_source(source, module, include=None):
        object_path = cache / module / (source.stem + ".o")
        object_path.parent.mkdir(exist_ok=True)
        hash_path = object_path.with_suffix(".sha256")
        source_hash = digest(source)
        include_hash = digest(include / "decls.h") if include else ""
        key = hashlib.sha256((source_hash + include_hash + header_key + configuration_key).encode()).hexdigest()
        if object_path.exists() and hash_path.exists() and hash_path.read_text().strip() == key:
            return {"path": object_path, "cached": True, "source": str(source), "sha256": source_hash}
        temporary = object_path.with_suffix(".tmp.o")
        command = [str(compiler), *flags, "-I" + str(ROOT / "runtime")]
        if include:
            command += ["-I" + str(include)]
        text = None
        if include and variant == "compat":
            # Lifted C goes to the compiler from memory; the shards stay as generated.
            text, _ = trampoline_source(source.read_text(), str(source))
            command += ["-x", "c", "-c", "-", "-o", str(temporary)]
        else:
            command += ["-c", str(source), "-o", str(temporary)]
        process = subprocess.run(command, input=text, capture_output=True, text=True)
        object_path.with_suffix(".log").write_text(process.stdout + process.stderr)
        if process.returncode:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Compile failed: {source}\n{process.stderr[-6000:]}")
        temporary.replace(object_path)
        hash_path.write_text(key + "\n")
        return {"path": object_path, "cached": False, "source": str(source), "sha256": source_hash}

    jobs = [(source, module["name"], module["folder"])
            for module in modules for source in module["sources"]]
    objects = []
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = [executor.submit(compile_source, *job) for job in jobs]
        for index, future in enumerate(as_completed(futures), 1):
            objects.append(future.result())
            if index % 100 == 0 or index == len(jobs):
                print(json.dumps({"phase": "objects", "done": index, "total": len(jobs),
                                  "cached": sum(item["cached"] for item in objects),
                                  "seconds": round(time.monotonic() - started)}), flush=True)
    if args.objects_only:
        return {"objects": len(objects), "cached_objects": sum(item["cached"] for item in objects),
                "linked": False, "playable": False}
    # The runtime is intentionally compiled last: its implementation can be
    # completed while independent game shards compile. Headers must stay fixed.
    if {str(path): digest(path) for path in headers} != original_header_hashes:
        raise RuntimeError("Runtime headers changed during compilation; rerun to rebuild affected objects")
    registry = output / "registry.c"
    registry.write_text(registry_source(modules))
    for source in [ROOT / "runtime/cpu.c", ROOT / "runtime/pe.c", ROOT / "runtime/runtime.c", registry]:
        objects.append(compile_source(source, "runtime"))
    if {str(path): digest(path) for path in headers} != original_header_hashes:
        raise RuntimeError("Runtime headers changed during final compilation; rerun")
    wasm = output / names["artifact"]
    temporary = wasm.with_suffix(".tmp.wasm")
    link_flags = ["-Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296",
                  "-Wl,--initial-memory=67108864", "-Wl,-z,stack-size=16777216",
                  "-Wl,--export=malloc,--export=free,--export=_initialize,--no-entry",
                  "-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align",
                  "-nostartfiles"]
    # wasi-sdk 34's threads target rejects -mexec-model=reactor. Select its
    # shipped reactor startup object explicitly instead of a command _start.
    reactor = sdk / "share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o"
    if not reactor.is_file():
        raise RuntimeError(f"Missing WASI reactor startup: {reactor}")
    command = [str(compiler), *flags, *link_flags,
               str(reactor),
               *(str(item["path"]) for item in sorted(objects, key=lambda item: str(item["path"]))),
               "-lm", "-o", str(temporary)]
    process = subprocess.run(command, capture_output=True, text=True)
    (output / names["link_log"]).write_text(process.stdout + process.stderr)
    if process.returncode:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"WASM link failed; see {output / names['link_log']}\n{process.stderr[-8000:]}")
    features = wasm_features(temporary)
    if variant == "compat" and "+tail-call" in features:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("The compat module still uses WebAssembly tail calls")
    temporary.replace(wasm)
    result = {
        "schema": 1, "artifact": names["artifact"], "variant": variant, "features": features,
        "sha256": digest(wasm), "bytes": wasm.stat().st_size,
        "configuration": configuration, "link_flags": link_flags, "runtime_headers": original_header_hashes,
        "memory": {"import": "env.memory", "shared": True, "initial_pages": 1024,
                   "maximum_pages": 65536, "stack_bytes": 16777216,
                   "guest_capacity": 0x78000000, "guest_base": 0x04000000, "guest_window": 0x80000000,
                   "layout": "runtime/cpu.h WC3_GUEST_BASE/WC3_GUEST_WINDOW; wc3_memory_base() after wc3_init"},
        "worker_abi": {"version": 1, "shared_instances": True,
                       "initialization": ["instantiate with existing env.memory", "set __stack_pointer", "__wasm_init_tls(nativeTlsBase)"],
                       "initialize_main_instance_only": True, "context": "wc3_context_create/call_context/destroy",
                       "tls_size": "__tls_size.value", "tls_alignment": "__tls_align.value", "stack_alignment": 16,
                       "guest_teb_bytes": 8192},
        "modules": [{"name": module["name"], "image": module["report"]["image"],
                     "image_sha256": module["report"]["sha256"],
                     "sha256": module["report"]["sha256"],
                     "liftDirectory": str(module["folder"].relative_to(ROOT)) if module["folder"].is_relative_to(ROOT) else str(module["folder"]),
                     "symbol": f"wc3_{module['name']}",
                     "image_base": module["report"]["image_base"],
                     "functions": module["report"]["generated_functions"],
                     "unsupported_instructions": module["report"]["unsupported_instructions"]}
                    for module in modules],
        "sources": [{key: value for key, value in item.items() if key not in ("path", "cached")} for item in objects],
        "strict_memory": bool(getattr(args, "strict_memory", False)),
        "wasm_built": True, "playable": False, "campaign_verified": False, "multiplayer_verified": False,
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    (output / names["metadata"]).write_text(json.dumps(result, indent=2) + "\n")
    return {key: result[key] for key in ("artifact", "sha256", "bytes", "wasm_built", "playable", "elapsed_seconds")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--module-dirs", type=Path, nargs="+", default=DEFAULT_MODULES)
    parser.add_argument("--output", type=Path, default=ROOT / "var/runtime")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 8))
    parser.add_argument("--objects-only", action="store_true")
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="standard",
                        help="compat: wc3-compat.wasm for engines without WebAssembly tail calls")
    parser.add_argument("--strict-memory", action="store_true",
                        help="Diagnostic build: guest accesses also check page permissions (slower)")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    try:
        print(json.dumps(build(args), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"build_runtime: {exc}\n")


if __name__ == "__main__":
    main()
