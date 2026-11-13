#!/usr/bin/env python3
"""PE32 -> C translation for the Warcraft browser runtime.

Uses the pinned MIT nfsu2-web lifter with its NFS-specific operand rewrites,
return-past addresses and address-based optimizations explicitly disabled.
Outputs private, game-derived C plus a report of unresolved work.
"""
from __future__ import annotations

import argparse
import collections
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "nfsu2"
# Even an inherited NFS build environment must not alter this target.
# Register locals are applied by build_runtime after its recursion pass;
# enabling upstream LREGS here would hide the virtual self-call patterns.
LIFT_ENV = {
    "FTOL2INL": "0", "INLINE_LIST": "", "INLINE": "0", "OVERRIDE": "",
    "HOOKS": "", "FLAGABI": "", "FLAGOPT": "1", "JTSWITCH": "0",
    "LREGS": "0", "X87OPT": "0", "X87PC": "1", "RETEIP": "1",
    "WATCH": "0", "COVERAGE": "0",
}
RUNTIME_DECLARATIONS = (
    "void dispatch_indirect(CPU *, uint32_t);\n"
    "void unsupported_insn(CPU *, uint32_t, const char *);\n"
    "void cpuid_shim(CPU *);\n"
    "uint64_t rdtsc_shim(void);\n"
)


def flag_liveness(vendor, blocks, addrs, in_text):
    """Conservative upstream def/use rules, with an uncapped worklist.

    The original pass stops after 64 scans. Large, non-address-ordered CFGs
    may need more iterations; incomplete liveness can omit a required flag.
    Only six bits per block can change, so this monotone worklist terminates.
    """
    successors, predecessors, uses = {}, {a: set() for a in addrs}, {}
    for address in addrs:
        instructions = blocks[address]
        successors[address] = set()
        uses[address] = [(i.address, *vendor._flag_defuse(i)) for i in instructions]
        if not instructions:
            successors[address].add(None)
            continue
        last = instructions[-1]; name = last.mnemonic
        conditional = (name.startswith('j') and name[1:] in vendor.CC) or name in (
            'jecxz', 'jcxz', 'loop', 'loope', 'loopz', 'loopne', 'loopnz')
        if name == 'jmp' or conditional:
            operand = last.operands[0] if last.operands else None
            target = operand.imm if operand is not None and operand.type == vendor.X86_OP_IMM else None
            successors[address].add(target if target in blocks else None)
            if conditional:
                next_address = last.address + last.size
                successors[address].add(next_address if next_address in blocks else None)
        elif name in ('ret', 'retf', 'iret', 'iretd'):
            successors[address].add(None)
        else:
            next_address = last.address + last.size
            successors[address].add(next_address if next_address in blocks else None)
        for target in successors[address]:
            if target is not None:
                predecessors[target].add(address)
    live = {a: 0 for a in addrs}; after = {}
    pending = collections.deque(reversed(addrs)); queued = set(addrs)
    while pending:
        address = pending.popleft(); queued.remove(address)
        current = 0
        for target in successors[address]:
            current |= vendor.F_ALL if target is None else live[target]
        for instruction, defined, used in reversed(uses[address]):
            # Overlapping decoded blocks can contain the same instruction.
            # Its emitted copies use one mask, so retain every successor's use.
            after[instruction] = after.get(instruction, 0) | current
            current = (current & ~defined) | used
        if current != live[address]:
            live[address] = current
            for previous in predecessors[address] - queued:
                pending.append(previous); queued.add(previous)
    return after


@contextlib.contextmanager
def isolated_lifter():
    """Use pristine vendored code; configure the new target in this adapter."""
    old = {key: os.environ.get(key) for key in LIFT_ENV}
    old_path = sys.path[:]
    os.environ.update(LIFT_ENV)
    sys.path.insert(0, str(VENDOR / "tools"))
    try:
        spec = importlib.util.spec_from_file_location("wc3_vendor_lift", VENDOR / "tools/lift.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # ImageBase == 0x400000 is not proof of NFS identity. Never use the
        # original split_reloc table even when a WC3 operand matches it.
        module.split_operand = lambda value, ip=0, immediate=False: f"0x{value & 0xffffffff:x}u"
        module._retpast = lambda: set()
        module._FTOL2INL = False
        module._ABI = None
        module.flag_liveness = lambda blocks, addrs, in_text: flag_liveness(module, blocks, addrs, in_text)
        yield module
    finally:
        sys.path[:] = old_path
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def pe_seeds(pe, in_code, scan_data_pointers="auto"):
    """Read normal PE metadata. Never apply SPEED2's unnamed-section reader."""
    base = pe.OPTIONAL_HEADER.ImageBase
    seeds: dict[int, set[str]] = collections.defaultdict(set)
    entry = base + pe.OPTIONAL_HEADER.AddressOfEntryPoint
    if in_code(entry):
        seeds[entry].add("entrypoint")
    for export in getattr(getattr(pe, "DIRECTORY_ENTRY_EXPORT", None), "symbols", []):
        address = base + export.address
        if not export.forwarder and in_code(address):
            seeds[address].add("export")
    relocations = 0
    unsupported = collections.Counter()
    invalid = 0
    for block in getattr(pe, "DIRECTORY_ENTRY_BASERELOC", []):
        for item in block.entries:
            if item.type == 0:
                continue
            if item.type != 3:
                unsupported[item.type] += 1
                continue
            relocations += 1
            data = pe.get_data(item.rva, 4)
            if len(data) != 4:
                invalid += 1
                continue
            target = struct.unpack("<I", data)[0]
            if in_code(target):
                seeds[target].add("relocation_pointer")
    scan = {"mode": scan_data_pointers,
            "enabled": scan_data_pointers == "always" or (scan_data_pointers == "auto" and relocations == 0),
            "sections": [], "matches": [],
            "caveat": "Aligned pointers in initialized non-executable data are candidate callbacks, not proven function boundaries."}
    if scan["enabled"]:
        for section in pe.sections:
            # Fixed-address EXEs may have CRT initializer callbacks but no
            # base relocation directory. Recover their data references without
            # hardcoding a Warcraft address or interpreting arbitrary strings.
            flags = section.Characteristics
            if flags & 0x20000000 or not (flags & 0x40 and flags & 0x40000000):
                continue
            data = section.get_data()
            size = min(section.Misc_VirtualSize or section.SizeOfRawData, len(data))
            section_base = base + section.VirtualAddress
            matches = 0
            first = (-section_base) % 4
            for offset in range(first, size - 3, 4):
                target = struct.unpack_from("<I", data, offset)[0]
                if in_code(target):
                    seeds[target].add("data_pointer")
                    scan["matches"].append({"slot": f"0x{section_base + offset:08x}", "target": f"0x{target:08x}"})
                    matches += 1
            scan["sections"].append({"name": section.Name.rstrip(b"\0").decode("latin1"),
                                     "address": f"0x{section_base:08x}", "backed_bytes": size,
                                     "scanned_slots": max(0, (size - first) // 4), "matches": matches})
    scan["unique_targets"] = len({item["target"] for item in scan["matches"]})
    ordered = sorted(seeds, key=lambda address: ("entrypoint" not in seeds[address],
                                               "export" not in seeds[address], address))
    return ordered, seeds, {
        "highlow_slots": relocations,
        "invalid_slots": invalid,
        "unsupported_types": dict(sorted(unsupported.items())),
        "directory_present": hasattr(pe, "DIRECTORY_ENTRY_BASERELOC"),
        "data_pointer_scan": scan,
    }


def inspect_imports(pe):
    return [{"dll": item.dll.decode("latin1"), "symbols": [
        {"name": imp.name.decode("latin1") if imp.name else None,
         "ordinal": imp.ordinal, "iat": f"0x{imp.address:08x}"}
        for imp in item.imports
    ]} for item in getattr(pe, "DIRECTORY_ENTRY_IMPORT", [])]


def executable_sections(pe):
    base = pe.OPTIONAL_HEADER.ImageBase
    result = []
    for section in pe.sections:
        if not section.Characteristics & 0x20000000:
            continue
        data = section.get_data()
        size = min(section.Misc_VirtualSize or section.SizeOfRawData, len(data))
        if size:
            result.append((section.Name.rstrip(b"\0").decode("latin1"),
                           base + section.VirtualAddress, data[:size]))
    result.sort(key=lambda item: item[1])
    if not result:
        raise ValueError("No backed executable PE sections")
    if result[-1][1] + len(result[-1][2]) - result[0][1] > 256 * 1024 * 1024:
        raise ValueError("Executable section span exceeds the bounded 256 MiB adapter limit")
    for previous, current in zip(result, result[1:]):
        if previous[1] + len(previous[2]) > current[1]:
            raise ValueError("Overlapping executable sections")
    return result


def target_lifter(vendor):
    """Separate target-specific fixes from the pristine upstream lifter."""
    class WarcraftLifter(vendor.Lifter):
        def __init__(self, pe, sections, comments=True):
            self.comments = comments
            self.trap = True
            self.traps = 0
            self.trap_kinds = collections.Counter()
            self.hooks = set()
            self.watch = self.cov = False
            self.retpast = set()
            self.IB = pe.OPTIONAL_HEADER.ImageBase
            self.secs = [(s.Name.rstrip(b"\0").decode("latin1"), self.IB + s.VirtualAddress,
                          s.Misc_VirtualSize, s.get_data()) for s in pe.sections]
            self.code_ranges = [(address, address + len(data)) for _, address, data in sections]
            self.TVA = self.code_ranges[0][0]
            self.TSZ = self.code_ranges[-1][1] - self.TVA
            blob = bytearray(self.TSZ)
            for _, address, data in sections:
                blob[address - self.TVA:address - self.TVA + len(data)] = data
            self.TDATA = bytes(blob)
            self.md = vendor.Cs(vendor.CS_ARCH_X86, vendor.CS_MODE_32)
            self.md.detail = True

        def in_text(self, address):
            return any(low <= address < high for low, high in self.code_ranges)

        def discover(self, entry, maxins=4000):
            # Upstream stops straight-line decoding after maxins, even in
            # large generated initializers. Continue in a new basic block;
            # lift() emits a real fall-through GOTO without an x86 CALL/RET.
            blocks, calls, pending = {}, set(), collections.deque([entry])
            self.split_blocks = 0
            self.capped_endpoints = set()
            while pending:
                address = pending.popleft()
                if address in blocks:
                    continue
                found, targets = super().discover(address, maxins=maxins)
                calls.update(targets)
                for start, block in found.items():
                    if start in blocks:
                        continue
                    blocks[start] = block
                    if len(block) <= maxins:
                        continue
                    last = block[-1]
                    mnemonic = last.mnemonic
                    if (mnemonic in ('ret', 'repz ret', 'retf', 'jmp', 'hlt', 'ud2', 'int3') or
                            mnemonic.startswith('j') or mnemonic.startswith('loop')):
                        continue
                    next_address = last.address + last.size
                    if self.in_text(next_address):
                        pending.append(next_address)
                        self.split_blocks += 1
                    else:
                        self.capped_endpoints.add(last.address)
            self.capped_blocks = len(self.capped_endpoints)
            self.empty_blocks = sum(not block for block in blocks.values())
            return blocks, calls

        def lift(self, entry):
            source, targets = super().lift(entry)
            for address, block in self.last_blocks.items():
                if not block:
                    marker = f"L_{address:08x}:; /* --- block --- */"
                    source = source.replace(marker, marker + f'\n    wc3_cpu_fault(c, 0x{address:08x}u, "empty decoded block");')
            return source, targets

        def rd(self, operand):
            if operand.type == vendor.X86_OP_MEM and operand.size not in (1, 2, 4, 8):
                # e.g. far indirect JMP m16:32. This was upstream KeyError:6
                # outside insn()'s error handler. Trap explicitly; segment
                # transitions are not supported by the flat Win32 CPU ABI.
                kind = f"unsupported-memory-operand-{operand.size}"
                self.traps += 1
                self.trap_kinds[kind] += 1
                return f'(wc3_cpu_fault(c, 0x{self.entry:08x}u, "{kind}"), 0u)'
            return super().rd(operand)

        def insn(self, instruction, targets):
            lines = self.target_insn(instruction, targets)
            if instruction.address in self.capped_endpoints:
                lines.append(f'wc3_cpu_fault(c, 0x{instruction.address:08x}u, "static block length limit reached");')
            return lines

        def target_insn(self, instruction, targets):
            mnemonic = instruction.mnemonic
            operands = instruction.operands
            locked = mnemonic.startswith("lock ")
            operation = mnemonic.removeprefix("lock ")
            memory_xchg = operation == "xchg" and any(o.type == vendor.X86_OP_MEM for o in operands)
            if locked or memory_xchg or operation == "cmpxchg8b":
                supported = {"add", "adc", "sub", "sbb", "and", "or", "xor", "inc", "dec", "neg", "not",
                             "xchg", "xadd", "cmpxchg", "cmpxchg8b", "bts", "btr", "btc"}
                if operation not in supported or not operands or operands[0].type != vendor.X86_OP_MEM:
                    raise vendor.Unsupported(f"invalid-lock-{operation}")
                bits = operands[0].size * 8
                if bits not in (8, 16, 32, 64):
                    raise vendor.Unsupported(f"lock-width-{bits}")
                address = self.ea(operands[0].mem)
                value = self.rd(operands[1]) if len(operands) > 1 else "0u"
                compare = "c->eax" if operation == "cmpxchg" else "0u"
                if operation == "cmpxchg8b":
                    value = "(((uint64_t)c->ecx << 32) | c->ebx)"
                    compare = "(((uint64_t)c->edx << 32) | c->eax)"
                if operation in ("bts", "btr", "btc"):
                    # Register bit indices address a bit string, including
                    # negative offsets. Immediate indices only select a bit
                    # within the encoded word (assembler adjusts displacement).
                    if operands[1].type == vendor.X86_OP_REG:
                        address = f"(({address}) + (((int{bits}_t)({value}) >> {4 if bits == 16 else 5}) * {bits // 8}))"
                    value = f"(({value}) & {bits - 1}u)"
                result = (f"{{ uint64_t _old = wc3_atomic_rmw(c, (uint32_t)({address}), {bits}u, "
                          f"WC3_ATOMIC_{operation.upper()}, (uint64_t)({value}), (uint64_t)({compare}));")
                if operation in ("xchg", "xadd"):
                    result += " " + self.wr(operands[1], "(uint32_t)_old")
                return [result + " (void)_old; }"]
            if mnemonic in ("lfence", "sfence", "mfence"):
                return ["wc3_memory_fence();"]
            if mnemonic == "cmpxchg":
                bits = operands[0].size * 8
                if bits not in (8, 16, 32):
                    raise vendor.Unsupported(f"cmpxchg-width-{bits}")
                mask = (1 << bits) - 1
                return [f"{{ uint32_t _a=c->eax & 0x{mask:x}u, _d={self.rd(operands[0])}, _r=_a-_d; "
                        f"FLAGS_SUB(_a,_d,_r,{bits}); if(c->zf) {{ {self.wr(operands[0],self.rd(operands[1]))} }} "
                        f"else {{ c->eax=(c->eax & ~0x{mask:x}u) | _d; }} }}"]
            if mnemonic == "salc":
                return ["c->eax = (c->eax & 0xffffff00u) | ((c->cf & 1u) ? 0xffu : 0u);"]
            if mnemonic == "repz ret":
                # REP RET has ordinary near-return semantics on x86.
                return ["POP32(c->eip); return;"]
            if mnemonic in ("in", "out", "insb", "insw", "insd", "outsb", "outsw", "outsd", "cli", "sti",
                            "hlt", "clts", "invd", "wbinvd", "lgdt", "lidt", "lldt", "ltr", "arpl", "bound",
                            "into", "sysenter", "sysexit", "rdmsr", "wrmsr", "rdpmc", "int3", "retf",
                            "pfrcpit1", "pfrcpit2", "pfrsqit1", "pfnacc", "pfpnacc"):
                raise vendor.Unsupported(f"unimplemented-or-suspected-data:{mnemonic}")
            lines = super().insn(instruction, targets)
            # Upstream SSE memcpy and x87 tbyte helpers bypass MR*. Keep their
            # unaligned behavior but validate the whole operand before access.
            for operand in operands:
                if operand.type == vendor.X86_OP_MEM and operand.size:
                    direct = f"g_mem + (uint32_t){self.ea(operand.mem)}"
                    checked = f"wc3_mem_ptr((uint32_t){self.ea(operand.mem)}, {operand.size}u)"
                    lines = [line.replace(direct, checked) for line in lines]
            return lines
    return WarcraftLifter


def generate(image: Path, output: Path, max_functions: int = 128,
             functions_per_shard: int = 64, comments: bool = True, module_name: str | None = None,
             scan_data_pointers: str = "auto", scan_code_pointers: str = "auto", image_base: int | None = None):
    import pefile

    try:
        pe = pefile.PE(str(image))
    except pefile.PEFormatError as exc:
        raise ValueError(f"Invalid PE image: {exc}") from exc
    if pe.FILE_HEADER.Machine != 0x14C or pe.OPTIONAL_HEADER.Magic != 0x10B:
        raise ValueError("Expected an x86 PE32 executable or DLL")
    preferred_base = pe.OPTIONAL_HEADER.ImageBase
    if image_base is not None and image_base != preferred_base:
        if image_base < 0x10000 or image_base & 0xffff or image_base + pe.OPTIONAL_HEADER.SizeOfImage > 0x80000000:
            raise ValueError("Image base must be 64 KiB aligned and fit in Win32 user memory")
        relocations = getattr(pe, 'DIRECTORY_ENTRY_BASERELOC', [])
        if pe.FILE_HEADER.Characteristics & 1 or not relocations:
            raise ValueError("Cannot rebase an image without usable base relocations")
        for block in relocations:
            for entry in block.entries:
                if entry.type not in (0, 3):
                    raise ValueError(f"Unsupported PE32 relocation type {entry.type}")
                if entry.type == 3 and (entry.rva + 4 > pe.OPTIONAL_HEADER.SizeOfImage or len(pe.get_data(entry.rva, 4)) != 4):
                    raise ValueError("Relocation target is outside the backed image")
        # Relocate the in-memory PE before reading code, callback pointers and
        # jump tables. The on-disk input and its recorded SHA-256 stay original.
        # The runtime applies the same HIGHLOW relocations when loading it.
        pe.relocate_image(image_base)
    sections = executable_sections(pe)
    if scan_data_pointers not in ("auto", "always", "never"):
        raise ValueError("scan-data-pointers must be auto, always or never")
    if scan_code_pointers not in ("auto", "always", "never"):
        raise ValueError("scan-code-pointers must be auto, always or never")
    module_name = module_name or re.sub(r"[^a-z0-9_]", "_", image.stem.lower())
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", module_name):
        raise ValueError("Module name must be a lowercase C identifier")
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output directory is not empty: {output}; choose a new directory")
    base = pe.OPTIONAL_HEADER.ImageBase
    low = sections[0][1]
    high = sections[-1][1] + len(sections[-1][2])
    queue, origins, relocs = pe_seeds(pe, lambda address: any(start <= address < start + len(data)
                                                            for _, start, data in sections), scan_data_pointers)
    code_scan = {"mode": scan_code_pointers,
                 "enabled": scan_code_pointers == "always" or
                            (scan_code_pointers == "auto" and relocs["highlow_slots"] == 0),
                 "matches": [],
                 "caveat": "Code-address immediates in decoded PUSH/MOV and absolute LEA operands are callback candidates, not proven function boundaries. Computed pointers are not resolved."}
    code_pointer_matches = set()
    code_pointer_targets = set()
    if not queue:
        raise ValueError("No entry/export/relocation seeds in .text; refusing to guess code")
    output.mkdir(parents=True, exist_ok=True)
    pending = collections.deque(queue)
    queued = set(queue)
    visited = set()
    reports, sources, references = [], [], set()
    errors, trap_kinds = [], collections.Counter()
    unique_insns = {}
    with isolated_lifter() as vendor:
        lifter = target_lifter(vendor)(pe, sections, comments=comments)
        while pending and (max_functions == 0 or len(reports) < max_functions):
            address = pending.popleft()
            if address in visited:
                continue
            visited.add(address)
            lifter.traps = lifter.truncated = lifter.oob_branch = 0
            lifter.trap_kinds.clear()
            result = {"address": f"0x{address:08x}", "origin": sorted(origins.get(address, {"direct_call"}))}
            try:
                source, targets = lifter.lift(address)
                # Upstream sometimes explicitly treats decoded instructions as
                # no-ops. Report these separately from Unsupported exceptions.
                suspect = sum(bool(re.search(r"no effect|refinement step skipped|/\* pfnacc|/\* pfpnacc|int3: padding", line))
                              for line in source.splitlines())
                result.update({
                    "status": "generated", "unsupported_instructions": lifter.traps,
                    "unsupported_kinds": dict(lifter.trap_kinds),
                    "truncated_labels": lifter.truncated,
                    "capped_blocks": lifter.capped_blocks,
                    "split_blocks": lifter.split_blocks,
                    "empty_blocks": lifter.empty_blocks,
                    "out_of_range_branches": lifter.oob_branch,
                    "instructions_requiring_semantic_review": suspect,
                    "instructions": sum(len(block) for block in lifter.last_blocks.values()),
                    "suspected_data_or_privileged": any(
                        kind.startswith(("unimplemented-or-suspected-data:", "unsupported-memory-operand-"))
                        or kind in ("ljmp", "lcall", "iretd", "daa", "das", "aaa", "aas", "aam", "aad")
                        for kind in lifter.trap_kinds
                    ),
                })
                trap_kinds.update(lifter.trap_kinds)
                for block in lifter.last_blocks.values():
                    for insn in block:
                        unique_insns[insn.address] = insn.size
                        if code_scan["enabled"]:
                            candidate = None
                            if insn.mnemonic in ("push", "mov") and insn.operands:
                                operand = insn.operands[-1]
                                if operand.type == vendor.X86_OP_IMM and operand.size == 4:
                                    candidate = operand.imm & 0xffffffff
                            elif insn.mnemonic == "lea" and len(insn.operands) == 2:
                                operand = insn.operands[1]
                                if (operand.type == vendor.X86_OP_MEM and operand.size == 4 and
                                        not operand.mem.base and not operand.mem.index and not operand.mem.segment):
                                    candidate = operand.mem.disp & 0xffffffff
                            if candidate is not None and lifter.in_text(candidate):
                                origins[candidate].add("code_pointer")
                                code_pointer_targets.add(candidate)
                                code_pointer_matches.add((insn.address, candidate, insn.mnemonic))
                                if candidate not in queued:
                                    pending.append(candidate)
                                    queued.add(candidate)
                sources.append((address, source))
                for target in sorted(targets):
                    if lifter.in_text(target):
                        references.add(target)
                        if target not in queued:
                            pending.append(target)
                            queued.add(target)
            except Exception as exc:
                result.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"})
                errors.append(result)
            reports.append(result)
            if len(reports) % 1000 == 0:
                progress = {"status": "lifting", "attempted": len(reports),
                            "generated": len(sources), "pending": len(pending),
                            "runtime_available": False}
                (output / "progress.json").write_text(json.dumps(progress) + "\n")
                print(json.dumps(progress), file=sys.stderr, flush=True)
    generated = {address for address, _ in sources}
    for item in reports:
        item["origin"] = sorted(origins.get(int(item["address"], 16), {"direct_call"}))
    code_scan["matches"] = [{"instruction": f"0x{instruction:08x}", "target": f"0x{target:08x}",
                             "mnemonic": mnemonic}
                            for instruction, target, mnemonic in sorted(code_pointer_matches)]
    code_scan["unique_targets"] = len(code_pointer_targets)
    declarations = sorted(generated | references)
    (output / "decls.h").write_text(
        '/* Game-derived declarations; link with the separate runtime/ CPU and host. */\n'
        '#pragma once\n#include "cpu.h"\n' + RUNTIME_DECLARATIONS +
        "\n".join(f"void sub_{address:08x}(CPU *c);" for address in declarations) + "\n"
    )
    for start in range(0, len(sources), functions_per_shard):
        (output / f"shard_{start // functions_per_shard:04d}.c").write_text(
            '/* Experimental generated code. Not a playable game/runtime. */\n'
            '#include "cpu.h"\n#include "decls.h"\n#include <math.h>\n\n' +
            "\n\n".join(source for _, source in sources[start:start + functions_per_shard]) + "\n"
        )
    (output / "fntab.c").write_text(
        '#include "decls.h"\n#include <stdint.h>\n'
        'typedef void (*wc3_lift_fn)(CPU *);\n'
        f'const uint32_t wc3_{module_name}_count = {len(sources)}u;\n'
        f'const uint32_t wc3_{module_name}_address[] = {{' +
        (", ".join(f"0x{address:08x}u" for address, _ in sources) or "0") + '};\n'
        f'const wc3_lift_fn wc3_{module_name}_function[] = {{' +
        (", ".join(f"sub_{address:08x}" for address, _ in sources) or "0") + '};\n'
    )
    # Count actual covered bytes, without double-counting overlapping decode
    # paths or treating all bytes in a discovered function range as executed.
    covered = bytearray(high - low)
    for address, size in unique_insns.items():
        start, end = max(0, address - low), min(high - low, address - low + size)
        covered[start:end] = b"\1" * (end - start)
    summary = {
        "schema": 2, "image": image.name, "module": module_name, "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
        "image_base": f"0x{base:08x}", "entrypoint": f"0x{base + pe.OPTIONAL_HEADER.AddressOfEntryPoint:08x}",
        "preferred_base": f"0x{preferred_base:08x}", "image_size": pe.OPTIONAL_HEADER.SizeOfImage,
        "upstream": json.loads((VENDOR / "provenance.json").read_text()),
        "profile": {"nfs_operand_patches": False, "nfs_retpast_addresses": False,
                    "nfs_inline_addresses": False, "nfs_hooks": False, "environment": LIFT_ENV},
        "runtime_available": False, "complete_program": False,
        "wasm_built": False, "gameplay_verified": False,
        "explicit_traps_for_empty_or_capped_blocks": True,
        "limits": {"max_functions": max_functions, "functions_per_shard": functions_per_shard,
                   "max_instructions_per_block": 4000},
        "seed_count": len(queue), "relocations": relocs, "imports": inspect_imports(pe),
        "code_pointer_scan": code_scan,
        "candidate_caveat": "Relocation targets can be basic blocks or data, not proven function starts. Counts are static candidates.",
        "attempted_functions": len(reports), "generated_functions": len(sources),
        "failed_functions": len(errors), "pending_candidates": len(pending),
        "suspected_data_or_privileged_candidates": sum(item.get("suspected_data_or_privileged", False) for item in reports),
        "suspicion_caveat": "Privileged/far/legacy instructions may indicate data decoded as code. Candidates are retained with explicit traps, never silently accepted or discarded.",
        "unsupported_instructions": sum(trap_kinds.values()), "unsupported_kinds": dict(trap_kinds),
        "truncated_labels": sum(item.get("truncated_labels", 0) for item in reports),
        "capped_blocks": sum(item.get("capped_blocks", 0) for item in reports),
        "split_blocks": sum(item.get("split_blocks", 0) for item in reports),
        "empty_blocks": sum(item.get("empty_blocks", 0) for item in reports),
        "instructions_requiring_semantic_review": sum(item.get("instructions_requiring_semantic_review", 0) for item in reports),
        "unresolved_direct_targets": [f"0x{address:08x}" for address in sorted(references - generated)],
        "unresolved_code_pointer_targets": [f"0x{address:08x}" for address in sorted(code_pointer_targets - generated)],
        "static_coverage": {"sections": [{"name": name, "address": address, "bytes": len(data)}
                                         for name, address, data in sections],
                            "backed_bytes": sum(len(data) for _, _, data in sections),
                            "decoded_bytes": sum(covered), "unique_instruction_addresses": len(unique_insns),
                            "meaning": "Static decoding only; not runtime or gameplay coverage"},
        "excluded_executable_sections": [],
        "functions": reports,
        "remaining": ["CPU/Win32 multi-module runtime", "Storm/MPQ and Miles integration",
                      "D3D8 or OpenGL renderer", "WASI/browser host", "WC3 networking and determinism",
                      "Campaign/save/load/multiplayer acceptance tests"],
    }
    (output / "report.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    (output / "progress.json").write_text(json.dumps({"status": "complete", "attempted": len(reports),
                                                    "generated": len(sources), "runtime_available": False}) + "\n")
    (output / "README.txt").write_text(
        "Static translation. This directory contains C sources; tools/build_runtime.py builds the runtime from them.\n"
        "The separate runtime/ CPU/PE loader and browser host are linked by tools/build_runtime.py.\n"
        "report.json describes this translation pass; runtime checks and WASM metadata are recorded separately.\n"
        "Successful translation/build does not verify campaign or multiplayer.\n"
        "Generated from the user's binary; keep these outputs out of source control.\n"
    )
    pe.close()
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="war3.exe or game.dll (x86 PE32)")
    parser.add_argument("--output", type=Path, required=True, help="New or empty output directory")
    parser.add_argument("--image-base", type=lambda value: int(value, 0),
                        help="Relocate the PE before translating (e.g. 0x02000000); input file is not modified")
    parser.add_argument("--max-functions", type=int, default=128, help="Bounded analysis; 0 means unlimited")
    parser.add_argument("--functions-per-shard", type=int, default=64)
    parser.add_argument("--no-comments", action="store_true")
    parser.add_argument("--module", help="C symbol prefix (default: sanitized image stem)")
    parser.add_argument("--scan-data-pointers", choices=("auto", "always", "never"), default="auto",
                        help="Scan aligned data pointers for callbacks; auto only when no HIGHLOW relocations exist")
    parser.add_argument("--scan-code-pointers", choices=("auto", "always", "never"), default="auto",
                        help="Discover callback addresses in decoded PUSH/MOV/absolute LEA operands; auto without HIGHLOW relocations")
    parser.add_argument("--strict", action="store_true", help="Fail on lift errors, unsupported/capped/empty blocks or semantic warnings")
    args = parser.parse_args()
    if args.max_functions < 0 or args.functions_per_shard < 1:
        parser.error("max-functions must be nonnegative; functions-per-shard must be positive")
    try:
        report = generate(args.image.resolve(), args.output.resolve(), args.max_functions,
                          args.functions_per_shard, not args.no_comments, args.module,
                          args.scan_data_pointers, args.scan_code_pointers, args.image_base)
    except (OSError, ValueError, ImportError) as exc:
        parser.exit(2, f"lift_wc3: {exc}\n")
    print(json.dumps({key: report[key] for key in (
        "image", "attempted_functions", "generated_functions", "failed_functions",
        "unsupported_instructions", "truncated_labels", "capped_blocks", "pending_candidates",
        "runtime_available", "wasm_built", "gameplay_verified")}, indent=2))
    print(f"Report: {args.output / 'report.json'}")
    if args.strict and any(report[key] for key in (
        "failed_functions", "unsupported_instructions", "truncated_labels", "capped_blocks",
        "empty_blocks", "instructions_requiring_semantic_review")):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
