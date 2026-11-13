"""Deep virtual recursion must use the guest stack in both WASM variants."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_runtime', ROOT / 'tools/build_runtime.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
FIXTURE = ROOT / 'tests/runtime_self_call_fixture.c'


def wrapped_fixture():
    source = FIXTURE.read_text()
    start = source.index('void sub_00401000(')
    end = source.index('\n/* An ordinary', start)
    helper = source[start:end].replace('sub_00401000', 'sub_00403000').replace('L_00401000', 'L_00403000')
    helper = helper.replace('c->edi = MR32(c->esp + 12u);', 'c->edi = 0x55;')
    helper = helper.replace('POP32(c->eip); c->esp += 4u; return;', 'POP32(c->eip); return;')
    wrapper = '''void sub_00401000(CPU *restrict c) {
    goto L_00401000;
L_00401000:;
    PUSH32(c->esi);
    c->esi = c->ecx;
    PUSH32(0x401005u); sub_00403000(c);
    if (MR8(c->esp+0x8u) & 0x1u) c->eax = c->esi;
    { uint32_t _t; POP32(_t); c->esi = _t; }
    POP32(c->eip); c->esp += 4u; return;
}
'''
    return source[:start] + helper + wrapper + source[end:]


class SelfCallTests(unittest.TestCase):
    def test_unsupported_control_flow_stays_untouched(self):
        source = FIXTURE.read_text()
        result, count = builder.self_call_source(source)
        self.assertEqual(count, 1)
        self.assertIn('wc3_self_resume_1', result)
        for replacement in ('DISPATCH_TAIL(c, _ct);', 'sub_00402000(c);', 'return;', 'DISPATCH_CALL(c, c->edx);'):
            changed = source.replace('DISPATCH_CALL(c, _ct);', replacement)
            with self.subTest(replacement=replacement):
                self.assertEqual(builder.self_call_source(changed), (changed, 0))
        local = '#define WC3_LREGS\n' + source
        self.assertEqual(builder.self_call_source(local), (local, 0))

    def test_overlapping_decoded_blocks_share_a_continuation(self):
        source = FIXTURE.read_text().replace('0x401030u', '0x401020u')
        result, count = builder.self_call_source(source)
        self.assertEqual(count, 1)
        self.assertEqual(result.count('wc3_self_resume_0:;'), 1)
        self.assertEqual(result.count('case 0x401020u:'), 1)

    def test_wrapper_inlining_is_bounded_and_tracks_callee_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'fixture.c'
            source.write_text(wrapped_fixture())
            callees = builder.virtual_callees([source])
            before, count = builder.inline_virtual_wrappers(source.read_text(), callees)
            self.assertEqual(count, 1)
            self.assertIn('wc3_inline_0_00403000', before)
            callees['00403000'] = callees['00403000'].replace('c->edi = 0x55;', 'c->edi = 0x66;')
            after, count = builder.inline_virtual_wrappers(source.read_text(), callees)
            self.assertNotEqual(before, after, 'Changed callee changes the caller input used by the object cache')
            twice = source.read_text().replace('PUSH32(0x401005u); sub_00403000(c);',
                'PUSH32(0x401005u); sub_00403000(c); PUSH32(0x401008u); sub_00403000(c);')
            self.assertEqual(builder.inline_virtual_wrappers(twice, callees), (twice, 0))

    def test_deep_recursion_in_real_wasm(self):
        compilers = sorted((ROOT / 'var/toolchains').glob('wasi-sdk-*/bin/clang'))
        if not compilers or not shutil.which('node'):
            self.skipTest('Local WASI SDK and Node are required')
        compiler = compilers[-1]
        sdk = compiler.parent.parent
        with tempfile.TemporaryDirectory(prefix='wc3-self-call-') as directory:
            out = Path(directory)
            link = ['-nostartfiles', '-I' + str(ROOT / 'runtime'), '-DWC3_GUEST_BASE=0x00800000u', '-DWC3_GUEST_WINDOW=0x08000000u',
                    '-Wl,--no-entry,--import-memory,--export-memory,--shared-memory,--max-memory=268435456,--initial-memory=8388608',
                    '-Wl,-z,stack-size=1048576', '-Wl,--export=malloc,--export=free,--export=_initialize', '-Wl,--export=__stack_pointer']
            runtime = [sdk / 'share/wasi-sysroot/lib/wasm32-wasip1-threads/crt1-reactor.o',
                       *(ROOT / p for p in ('runtime/cpu.c', 'runtime/pe.c', 'runtime/runtime.c'))]
            for name, fixture in [('visitor', FIXTURE.read_text()), ('wrapper', wrapped_fixture())]:
                fixture_path = out / (name + '.c')
                fixture_path.write_text(fixture)
                callees = builder.virtual_callees([fixture_path])
                for variant in ('original', 'standard', 'compat'):
                    text = fixture
                    if variant != 'original':
                        text, _ = builder.inline_virtual_wrappers(text, callees)
                        text, count = builder.self_call_source(text)
                        self.assertGreaterEqual(count, 1)
                        text, _ = builder.local_register_source(text)
                        self.assertIn('uint32_t wc3_self_depth = 0;', text)
                    if variant == 'compat':
                        text, _ = builder.trampoline_source(text)
                    source = out / (variant + '.c')
                    source.write_text(text)
                    compiled = subprocess.run([str(compiler), *builder.variant_flags('compat' if variant == 'compat' else 'standard'),
                                               *link, *map(str, runtime), str(source), '-lm', '-o', str(out / (variant + '.wasm'))],
                                              capture_output=True, text=True, timeout=60)
                    self.assertEqual(compiled.returncode, 0, compiled.stderr)
                tested = subprocess.run(['node', str(ROOT / 'tests/runtime_self_call_test.mjs'), str(out)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
                print(name + ': ' + tested.stdout.strip())


if __name__ == '__main__':
    unittest.main()
