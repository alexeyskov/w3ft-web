"""Register caching must preserve the full guest ABI, including caller flags."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_build', ROOT / 'tools/build_runtime.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

FIXTURE = r'''
#include "cpu.h"
#include <stdio.h>
#include <stdlib.h>
static uint8_t memory[65536];
uint8_t *g_mem = memory;
uint64_t g_mem_size = sizeof memory;
uint8_t *g_page_access;
uint32_t g_page_count;
_Noreturn void wc3_mem_fault(uint32_t address) { (void)address; abort(); }
void dispatch_indirect(CPU *c, uint32_t address) {
    /* This callback consumes caller flags and changes registers and flags. */
    c->ebx ^= eflags_get(c) + address;
    c->eax = c->eax * 3u + c->edx;
    c->cf ^= 1u; c->zf ^= 1u;
    c->eip = MR32(c->esp); c->esp += 4u;
}
void sub_00402000(CPU *restrict c) {
    goto L_00402000;
L_00402000:;
    c->edx += c->eax;
    FLAGS_SUB(c->eax, c->edx, c->eax - c->edx, 32);
    POP32(c->eip); return;
}
void sub_00401000(CPU *restrict c) {
    goto L_00401000;
L_00401000:;
    c->ecx &= 63u;
L_00401010:;
    if (!c->ecx) goto L_00401070;
    c->eax += c->ecx;
    PUSH32(c->eax); PUSH32(c->edx);
    MR32(0x1000u + 4u * c->ecx) = c->eax;
    { uint32_t _t; POP32(_t); c->edx = _t; }
    { uint32_t _t; POP32(_t); c->eax = _t; }
    FLAGS_SUB(c->eax, c->edx, c->eax - c->edx, 32);
    { uint32_t _ct = c->edi; PUSH32(0x401030u); DISPATCH_CALL(c, _ct); }
    if (c->cf) goto L_00401040;
    c->eax ^= c->ebx;
    goto L_00401050;
L_00401040:;
    c->edx += c->ebx;
L_00401050:;
    PUSH32(0x401055u); sub_00402000(c);
    c->esi ^= eflags_get(c);
    c->ecx -= 1u;
    goto L_00401010;
L_00401070:;
    eflags_set(c, c->esi);
    POP32(c->eip); return;
}
int main(void) {
    uint32_t hash = 0x12345678u;
    for (unsigned n = 0; n < 512; ++n) {
        CPU cpu = {0}; cpu.eax = n * 0x1234567u; cpu.ecx = n;
        cpu.edx = n * 421u; cpu.edi = 0x401000u;
        cpu.esp = 0x8000u; cpu.esi = 0x202u;
        MR32(cpu.esp) = 0x42u;
        sub_00401000(&cpu);
        if (cpu.esp != 0x8004u || cpu.eip != 0x42u) abort();
        const uint8_t *bytes = (const uint8_t *)&cpu;
        for (unsigned i = 0; i < sizeof cpu; ++i) hash = hash * 16777619u ^ bytes[i];
        for (unsigned i = 0x1000u; i < 0x1100u; ++i) hash = hash * 16777619u ^ memory[i];
    }
    printf("%08x\n", hash);
}
'''


class LocalRegistersTests(unittest.TestCase):
    def compare_execution(self, fixture):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = []
            for name, source in [('original', fixture), ('local', builder.local_register_source(fixture)[0])]:
                path = root / (name + '.c'); path.write_text(source)
                binary = root / name
                process = subprocess.run(['clang', '-std=c11', '-O2', '-I' + str(ROOT / 'runtime'),
                                          str(path), '-o', str(binary)], capture_output=True, text=True)
                self.assertEqual(process.returncode, 0, process.stderr)
                output = subprocess.run([str(binary)], capture_output=True, text=True, timeout=15)
                self.assertEqual(output.returncode, 0, output.stderr)
                outputs.append(output.stdout)
            self.assertEqual(outputs[0], outputs[1], 'All guest state and memory must remain bit-identical')

    def test_indirect_calls_flush_flags_and_compat_resumes_before_reloading(self):
        source, count = builder.local_register_source(FIXTURE)
        self.assertEqual(count, 2)
        self.assertIn('c->cf = _r_cf;', source)
        self.assertIn('c->of = _r_of; DISPATCH_CALL(c, _ct); LR_FG; LR_FF;', source)
        compat, calls = builder.trampoline_source(source[:source.index('int main')])
        self.assertEqual(calls, 1)
        self.assertIn('sub_00402000(c); TAIL_RESUME(c); LR_FG; LR_FF;', compat)

    def test_unknown_cpu_helpers_and_self_loops_stay_in_struct_form(self):
        for body in ('wc3_atomic_rmw(c, 1u, 32u, 0u, 1u, 0u);',
                     'wc3_self_return:; c->eax = 1;', 'wc3_inline_0_done:;',
                     'c->r[1] += 1;'):
            source = 'void sub_00401000(CPU *restrict c) {\n' + body + '\n}\n'
            with self.subTest(body=body):
                self.assertEqual(builder.local_register_source(source), (source, 0))

    @unittest.skipUnless(shutil.which('clang'), 'Native clang required')
    def test_differential_register_flags_stack_and_memory(self):
        self.compare_execution(FIXTURE)

    @unittest.skipUnless(shutil.which('clang'), 'Native clang required')
    def test_differential_popad_and_conditional_boundaries(self):
        bodies = {
            'popad': '''
    { uint32_t _sp=c->esp; PUSH32(c->eax); PUSH32(c->ecx); PUSH32(c->edx);
      PUSH32(c->ebx); PUSH32(_sp); PUSH32(c->ebp); PUSH32(c->esi); PUSH32(c->edi); }
    PUSH32(0x401030u); sub_00402000(c);
    { uint32_t _t; POP32(c->edi); POP32(c->esi); POP32(c->ebp); POP32(_t);
      POP32(c->ebx); POP32(c->edx); POP32(c->ecx); POP32(c->eax); (void)_t; }
''',
            'conditional_call': '''
    c->ebx ^= c->eax + 0x123u;
    c->cf ^= 1u;
    if (c->eax & 1u) { PUSH32(0x401030u); sub_00402000(c); }
''',
            'conditional_helper': '''
    c->ebx ^= c->eax + 0x123u;
    c->cf ^= 1u;
    if (c->eax == 0xffffffffu) { unsupported_insn(c, 0x401030u, "branch-out"); POP32(c->eip); return; }
''',
        }
        start = FIXTURE.index('void sub_00401000(')
        end = FIXTURE.index('int main(void)')
        helper = 'void unsupported_insn(CPU *c, uint32_t address, const char *name) { (void)c; (void)address; (void)name; abort(); }\n'
        for name, body in bodies.items():
            fixture = (FIXTURE[:start] + helper + 'void sub_00401000(CPU *restrict c) {\n'
                       + body + '    POP32(c->eip); return;\n}\n' + FIXTURE[end:])
            with self.subTest(boundary=name):
                self.compare_execution(fixture)
