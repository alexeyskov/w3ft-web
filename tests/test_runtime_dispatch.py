"""Check the dispatch cache in real shared WASM, including hash collisions."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DispatchCacheTests(unittest.TestCase):
    def test_cached_and_uncached_dispatch_preserve_targets_faults_budgets_and_threads(self):
        compilers = sorted((ROOT / 'var/toolchains').glob('wasi-sdk-*/bin/clang'))
        if not compilers or not shutil.which('node'):
            self.skipTest('wasi-sdk and Node are required')
        compiler = compilers[-1]
        sdk = compiler.parent.parent
        with tempfile.TemporaryDirectory(prefix='wc3-dispatch-cache-') as directory:
            out = Path(directory)
            addresses = [0x400000 + index * 16 for index in range(86000)]
            # Deliberately collide two *different* functions, then an absent
            # target. A cache hit must compare the full guest address.
            slot = lambda address: ((address * 2654435761) & 0xffffffff) >> 20
            first = addresses[0]
            second = next(address for address in addresses[1:] if slot(address) == slot(first))
            missing = next(address for address in range(0x600000, 0x700000) if slot(address) == slot(first))
            (out / 'dispatch_entries.inc').write_text(
                'static const uint32_t count = 86000;\nstatic const uint32_t addresses[] = {'
                + ','.join(hex(address) for address in addresses) + '};\n'
                + 'static const guest_fn_t functions[] = {'
                + ','.join('leaf_b' if address == second else 'leaf_a' for address in addresses) + '};\n'
                + 'const Wc3LiftTable wc3_tables[] = {{&count, addresses, functions}};\n'
                + 'const unsigned wc3_table_count = 1;\n')
            (out / 'targets.json').write_text(json.dumps({'first': first, 'second': second, 'missing': missing}))
            flags = ['--target=wasm32-wasip1-threads', '-pthread', '-matomics', '-mbulk-memory', '-mtail-call',
                     '-O1', '-std=c11', '-nostartfiles', '-I' + str(ROOT / 'runtime'), '-I' + str(out),
                     '-Wl,--no-entry,--import-memory,--export-memory,--shared-memory,--max-memory=268435456,--initial-memory=8388608',
                     '-Wl,-z,stack-size=1048576', '-Wl,--export=malloc,--export=free,--export=_initialize',
                     '-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align']
            sources = [sdk / 'share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o',
                       *(ROOT / path for path in ('runtime/cpu.c', 'runtime/pe.c', 'runtime/runtime.c',
                                                 'tests/runtime_dispatch_fixture.c'))]
            for name, bits in [('cached', 12), ('uncached', 0)]:
                compiled = subprocess.run([str(compiler), *flags, f'-DWC3_DISPATCH_CACHE_BITS={bits}',
                                           *map(str, sources), '-lm', '-o', str(out / f'{name}.wasm')],
                                          capture_output=True, text=True)
                self.assertEqual(compiled.returncode, 0, compiled.stderr)
            tested = subprocess.run(['node', str(ROOT / 'tests/runtime_dispatch_test.mjs'), str(out)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
            report = json.loads(tested.stdout)
            self.assertEqual(report['functionCount'], 86000)
            self.assertEqual(report['collisionChecks'], 20000)
            self.assertEqual(report['workers'], 4)
            print(json.dumps(report))


if __name__ == '__main__':
    unittest.main()
