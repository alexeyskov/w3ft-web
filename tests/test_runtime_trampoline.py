"""The build for engines without WebAssembly tail calls (runtime/cpu.h)."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_runtime", ROOT / "tools/build_runtime.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class TrampolineSourceTests(unittest.TestCase):
    def test_every_direct_call_is_followed_by_tail_resume(self):
        source = ("void sub_00401000(CPU *restrict c) {\n"
                  "    PUSH32(0x401005u); sub_00402000(c);\n"
                  "    { uint32_t _ct = c->eax; PUSH32(0x401009u); DISPATCH_CALL(c, _ct); }\n"
                  "    PUSH32(0x40100eu); sub_00403000(c);\n"
                  "    { PUSH32(0x401013u); sub_00404000(c); PUSH32(0x401018u); sub_00405000(c); }\n"
                  "    DISPATCH_TAIL(c, c->edx);   /* indirect tail call */\n"
                  "}\n/* ===== sub_00402000  (3 insns, 1 blocks) ===== */\n")
        result, calls = builder.trampoline_source(source)
        self.assertEqual(calls, 4)
        self.assertIn("sub_00402000(c); TAIL_RESUME(c);\n", result)
        self.assertIn("sub_00403000(c); TAIL_RESUME(c);\n", result)
        self.assertIn("sub_00404000(c); TAIL_RESUME(c); PUSH32(0x401018u); sub_00405000(c); TAIL_RESUME(c); }", result)
        self.assertEqual(result.count("\n"), source.count("\n"), "Line numbers stay those of the shard")

    def test_a_call_written_another_way_is_refused(self):
        for line in ("    c->eax = sub_00402000(c);", "    return sub_00402000(c);", "    if (c->eax) sub_00402000(c);",
                     "void sub_00402000(CPU *restrict c);", "    sub_00402000(&other);"):
            with self.subTest(line=line), self.assertRaisesRegex(ValueError, "Unrecognized call"):
                builder.trampoline_source("void sub_00401000(CPU *restrict c) {\n" + line + "\n}\n")

    def test_compat_flags_replace_tail_calls_with_the_trampoline(self):
        flags = builder.variant_flags("compat")
        self.assertNotIn("-mtail-call", flags)
        self.assertIn("-mno-tail-call", flags)
        self.assertIn("-DWC3_TAIL_TRAMPOLINE=1", flags)
        self.assertEqual(builder.variant_flags("standard"), builder.FLAGS)


class TrampolineWasmTests(unittest.TestCase):
    def test_both_builds_make_the_same_guest_jumps(self):
        compilers = sorted((ROOT / "var/toolchains").glob("wasi-sdk-*/bin/clang"))
        if not compilers or not shutil.which("node"):
            self.skipTest("wasi-sdk and Node are required")
        compiler = compilers[-1]
        sdk = compiler.parent.parent
        fixture = (ROOT / "tests/runtime_trampoline_fixture.c").read_text()
        with tempfile.TemporaryDirectory(prefix="wc3-trampoline-") as directory:
            out = Path(directory)
            link = ["-nostartfiles", "-I" + str(ROOT / "runtime"), "-DWC3_GUEST_BASE=0x00800000u", "-DWC3_GUEST_WINDOW=0x08000000u",
                    "-Wl,--no-entry,--import-memory,--export-memory,--shared-memory,--max-memory=268435456,--initial-memory=8388608",
                    "-Wl,-z,stack-size=1048576", "-Wl,--export=malloc,--export=free,--export=_initialize",
                    "-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align"]
            runtime = [sdk / "share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o",
                       *(ROOT / path for path in ("runtime/cpu.c", "runtime/pe.c", "runtime/runtime.c"))]
            for variant in ("standard", "compat"):
                source = out / f"{variant}.c"
                localized, count = builder.local_register_source(fixture)
                self.assertEqual(count, 10)
                source.write_text(builder.trampoline_source(localized)[0] if variant == "compat" else localized)
                compiled = subprocess.run([str(compiler), *builder.variant_flags(variant), *link, *map(str, runtime),
                                           str(source), "-lm", "-o", str(out / f"{variant}.wasm")],
                                          capture_output=True, text=True)
                self.assertEqual(compiled.returncode, 0, compiled.stderr)
            self.assertIn("+tail-call", builder.wasm_features(out / "standard.wasm"))
            self.assertNotIn("+tail-call", builder.wasm_features(out / "compat.wasm"))
            tested = subprocess.run(["node", str(ROOT / "tests/runtime_trampoline_test.mjs"), str(out)],
                                    capture_output=True, text=True, timeout=300)
            self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
            report = json.loads(tested.stdout)
            self.assertGreater(report["compat"]["tlsBytes"], report["standard"]["tlsBytes"], "The pending jump is per thread")
            print(json.dumps(report))


if __name__ == "__main__":
    unittest.main()
