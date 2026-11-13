"""Growing memory and native CRT ABI against real shared WebAssembly."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def compile_fixture(output):
    compiler = sorted((ROOT / 'var/toolchains').glob('wasi-sdk-*/bin/clang'))[-1]
    sdk = compiler.parent.parent
    flags = ['--target=wasm32-wasip1-threads', '-pthread', '-matomics', '-mbulk-memory',
             '-mtail-call', '-O2', '-std=c11', '-nostartfiles', '-I'+str(ROOT/'runtime'),
             '-DWC3_GROWING_GUEST=1', '-DWC3_HEAP_BASE=0x04000000u',
             '-DWC3_HEAP_LIMIT=0x7fff0000u', '-DWC3_MAIN_STACK_TOP=0x01fff000u',
             '-Wl,--no-entry,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296,--initial-memory=67108864',
             '-Wl,-z,stack-size=16777216', '-Wl,--export=malloc,--export=free,--export=_initialize',
             '-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align']
    sources = [sdk/'share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o',
               *(ROOT/path for path in ('runtime/cpu.c', 'runtime/pe.c', 'runtime/runtime.c', 'tests/native_runtime_fixture.c'))]
    subprocess.run([str(compiler), *flags, *map(str,sources), '-lm', '-o', str(output)], check=True, capture_output=True)


class NativeRuntimeTests(unittest.TestCase):
    def test_qsort_falls_back_without_mutation_when_native_arena_is_full(self):
        if not list((ROOT/'var/toolchains').glob('wasi-sdk-*/bin/clang')) or not shutil.which('node'):
            self.skipTest('WASI SDK and Node required')
        with tempfile.TemporaryDirectory() as temporary:
            module=Path(temporary)/'fixture.wasm'
            compile_fixture(module)
            result=subprocess.run(['node',str(ROOT/'tests/native_qsort_fallback_fixture.mjs'),str(module)],
                                  capture_output=True,text=True,timeout=60)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('Native qsort arena exhaustion fallback passed',result.stdout)

    def test_growth_arena_and_crt(self):
        if not list((ROOT/'var/toolchains').glob('wasi-sdk-*/bin/clang')) or not shutil.which('node'):
            self.skipTest('WASI SDK and Node required')
        with tempfile.TemporaryDirectory() as temporary:
            module=Path(temporary)/'fixture.wasm'
            compile_fixture(module)
            result=subprocess.run(['node',str(ROOT/'tests/native_runtime_fixture.mjs'),str(module)],capture_output=True,text=True,timeout=60)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('Native CRT and growing memory passed',result.stdout)


if __name__=='__main__':
    unittest.main()
