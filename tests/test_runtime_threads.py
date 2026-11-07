"""Exercise real shared WASM instances against the C runtime using synthetic PEs."""
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

from tests.test_runtime_pe import fixture

ROOT = Path(__file__).resolve().parents[1]


class SharedWasmRuntimeTests(unittest.TestCase):
    def test_parallel_contexts_native_tls_stacks_and_dll_notifications(self):
        candidates = sorted((ROOT / "var/toolchains").glob("wasi-sdk-*/bin/clang"))
        if not candidates or not shutil.which("node"):
            self.skipTest("wasi-sdk and Node are required")
        compiler = candidates[-1]
        sdk = compiler.parent.parent
        with tempfile.TemporaryDirectory(prefix="wc3-runtime-threads-") as directory:
            out = Path(directory)
            for index, name in enumerate(("a.dll", "b.dll", "c.dll", "main.exe"), 1):
                image = fixture(imports=index in (1, 4), exports=True, relocations=False,
                                library="a.dll" if index == 4 else "b.dll", dll=index != 4)
                struct.pack_into("<I", image, 0x98 + 28, 0x400000 if index == 4 else index * 0x10000)
                if index in (1, 4):
                    image[0x3a2:0x3ac] = b"Named\0\0\0\0\0"
                    struct.pack_into("<I", image, 0x364, 0x80000005)
                (out / name).write_bytes(image)
            command = [str(compiler), "--target=wasm32-wasip1-threads", "-pthread", "-matomics", "-mbulk-memory",
                       "-mtail-call", "-O1", "-std=c11", "-nostartfiles", "-I" + str(ROOT / "runtime"),
                       "-Wl,--no-entry,--import-memory,--export-memory,--shared-memory,--max-memory=536870912,--initial-memory=8388608",
                       "-Wl,-z,stack-size=1048576", "-Wl,--export=malloc,--export=free,--export=_initialize",
                       "-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align",
                       str(sdk / "share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o"),
                       *(str(ROOT / path) for path in ("runtime/cpu.c", "runtime/pe.c", "runtime/runtime.c", "tests/runtime_threads_fixture.c")),
                       "-lm", "-o", str(out / "threads.wasm")]
            compiled = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            tested = subprocess.run(["node", str(ROOT / "tests/runtime_threads_test.mjs"), str(out)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
            self.assertIn('"atomicGuestIncrements":200000', tested.stdout)


if __name__ == "__main__":
    unittest.main()
