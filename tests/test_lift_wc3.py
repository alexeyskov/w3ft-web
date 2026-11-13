"""Target-isolation and real PE translation tests; no Warcraft assets needed."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    import pefile  # noqa: F401
    import capstone  # noqa: F401
    HAVE_DEPS = True
except ImportError:
    HAVE_DEPS = False

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lift_wc3", ROOT / "tools/lift_wc3.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def pe32_fixture():
    """Two executable functions and a standard HIGHLOW relocation seed."""
    data = bytearray(0x800)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3c, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", data, 0x84, 0x14c, 3, 0, 0, 0, 224, 0x102)
    optional = 0x98
    struct.pack_into("<H", data, optional, 0x10b)
    struct.pack_into("<I", data, optional + 16, 0x1000)
    struct.pack_into("<I", data, optional + 20, 0x1000)
    struct.pack_into("<I", data, optional + 28, 0x400000)
    struct.pack_into("<II", data, optional + 32, 0x1000, 0x200)
    struct.pack_into("<II", data, optional + 56, 0x4000, 0x200)
    struct.pack_into("<I", data, optional + 92, 16)
    struct.pack_into("<II", data, optional + 96 + 5 * 8, 0x3000, 12)
    for index, (name, rva, raw, flags) in enumerate([
        (b".text", 0x1000, 0x200, 0x60000020),
        (b".data", 0x2000, 0x400, 0xc0000040),
        (b".reloc", 0x3000, 0x600, 0x42000040),
    ]):
        at = optional + 224 + index * 40
        data[at:at + len(name)] = name
        struct.pack_into("<IIII", data, at + 8, 0x20, rva, 0x200, raw)
        struct.pack_into("<I", data, at + 36, flags)
    # call second function; ret. Second loads a numeric operand that would
    # be rewritten into a split-screen address by the unmodified NFS profile.
    data[0x200:0x206] = b"\xe8\x0b\x00\x00\x00\xc3"
    data[0x210:0x216] = b"\xb8\xac\x00\x89\x00\xc3"
    struct.pack_into("<I", data, 0x400, 0x401010)
    struct.pack_into("<IIHH", data, 0x600, 0x2000, 12, 0x3000, 0)
    return data


@unittest.skipUnless(HAVE_DEPS, "Install requirements.txt for lifter tests")
class LifterTests(unittest.TestCase):
    def test_flag_liveness_reaches_a_fixed_point_past_64_blocks(self):
        vendor = SimpleNamespace(CC={}, X86_OP_IMM=2, F_ALL=63,
                                 _flag_defuse=lambda insn: (0, 63 if insn.mnemonic == 'ret' else 0))
        # Address order is the reverse of control flow; a capped reverse scan
        # needs one iteration per edge and would lose flags at the entry.
        blocks = {}
        for address in range(200):
            blocks[address] = [SimpleNamespace(address=address, size=1,
                mnemonic='jmp' if address else 'ret',
                operands=[SimpleNamespace(type=2, imm=address-1)] if address else [])]
        after = adapter.flag_liveness(vendor, blocks, sorted(blocks), lambda _: True)
        self.assertEqual(set(after.values()), {63})

    def test_rebase_applies_relocations_before_discovery_and_keeps_input_hash(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / "fixture.dll"
            original = pe32_fixture(); image.write_bytes(original)
            report = adapter.generate(image, root / "lift", max_functions=0, image_base=0x02000000)
            self.assertEqual(report['image_base'], '0x02000000')
            self.assertEqual(report['preferred_base'], '0x00400000')
            self.assertEqual(report['image_size'], 0x4000)
            self.assertEqual(report['sha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual(image.read_bytes(), original)
            self.assertEqual(report['generated_functions'], 2)
            code = (root / 'lift/shard_0000.c').read_text()
            self.assertIn('sub_02001010', code)
            self.assertNotIn('sub_00401010', code)
            self.assertIn('0x8900acu', code)  # a numeric constant is not a pointer relocation

    def test_rebase_refuses_missing_or_unsupported_relocations(self):
        for kind in ('stripped', 'missing', 'unsupported'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); image = root / 'fixture.dll'; data = pe32_fixture()
                if kind == 'stripped': struct.pack_into('<H', data, 0x96, 0x103)
                elif kind == 'missing': struct.pack_into('<II', data, 0x98 + 96 + 5 * 8, 0, 0)
                else: struct.pack_into('<H', data, 0x608, 0xa000)
                image.write_bytes(data)
                with self.assertRaisesRegex(ValueError, '[Rr]elocat'):
                    adapter.generate(image, root / 'lift', image_base=0x02000000)

    def test_nfs_settings_cannot_leak_into_target(self):
        with patch.dict(os.environ, {"FTOL2INL": "1", "LREGS": "1", "FLAGABI": "/missing", "INLINE_LIST": "/missing"}):
            with adapter.isolated_lifter() as lifter:
                self.assertFalse(lifter._FTOL2INL)
                self.assertEqual(lifter._retpast(), set())
                self.assertEqual(lifter.split_operand(0x8900ac, 0x401000, True), "0x8900acu")
                self.assertEqual(os.environ["FLAGABI"], "")
                self.assertEqual(os.environ["LREGS"], "0")
                self.assertEqual(os.environ["FLAGOPT"], "1")
            self.assertEqual(os.environ["FTOL2INL"], "1")
            self.assertEqual(os.environ["FLAGABI"], "/missing")

    def test_flag_liveness_eliminates_only_overwritten_flags(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / 'flags.exe'
            data = pe32_fixture()
            # cmp eax,1; je branch; xor eax,eax; ret; branch: xor edx,edx; ret
            # Both exits replace arithmetic flags except undefined AF, which
            # the runtime preserves. CMP needs only ZF and the preserved AF.
            data[0x200:0x20b] = bytes.fromhex('83f801740331c0c331d2c3')
            struct.pack_into('<I', data, 0x400, 0x401000)
            image.write_bytes(data)
            report = adapter.generate(image, root / 'lift', max_functions=0)
            source = (root / 'lift/shard_0000.c').read_text()
            self.assertEqual(report['failed_functions'], 0)
            self.assertRegex(source, r'FLAGS_SUB_M\([^;]*0x0cu\)')
            self.assertIn('0x3fu', source, 'Returned flags remain observable to the caller')

    def test_pe_relocations_and_references_generate_real_c(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "fixture.exe"
            image.write_bytes(pe32_fixture())
            report = adapter.generate(image, root / "lift", max_functions=0, functions_per_shard=1)
            self.assertEqual(report["generated_functions"], 2)
            self.assertEqual(report["failed_functions"], 0)
            self.assertEqual(report["relocations"]["highlow_slots"], 1)
            self.assertEqual(report["pending_candidates"], 0)
            self.assertEqual(report["unresolved_direct_targets"], [])
            self.assertFalse(report["runtime_available"])
            self.assertFalse(report["complete_program"])
            source = "\n".join(path.read_text() for path in (root / "lift").glob("shard_*.c"))
            self.assertIn("0x8900acu", source)
            self.assertNotIn("SPLIT_", source)
            self.assertIn("sub_00401010(c)", source)
            self.assertEqual(json.loads((root / "lift/report.json").read_text())["generated_functions"], 2)

    def test_limit_reports_unresolved_code_and_preserves_prior_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "fixture.exe"
            image.write_bytes(pe32_fixture())
            report = adapter.generate(image, root / "lift", max_functions=1)
            self.assertEqual(report["generated_functions"], 1)
            self.assertEqual(report["pending_candidates"], 1)
            self.assertEqual(report["unresolved_direct_targets"], ["0x00401010"])
            with self.assertRaisesRegex(ValueError, "not empty"):
                adapter.generate(image, root / "lift", max_functions=0)

    def test_unsupported_instruction_is_reported_without_claiming_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "fixture.exe"
            data = pe32_fixture()
            data[0x200:0x207] = b"\x0f\xa2\x0f\x31\xcd\x80\xc3"  # cpuid; rdtsc; int 80h; ret
            image.write_bytes(data)
            report = adapter.generate(image, root / "lift", max_functions=1)
            self.assertEqual(report["unsupported_instructions"], 1)
            self.assertEqual(report["unsupported_kinds"], {"int": 1})
            header = (root / "lift/decls.h").read_text()
            self.assertIn("void unsupported_insn(CPU *, uint32_t, const char *);", header)
            self.assertIn("void cpuid_shim(CPU *);", header)
            self.assertIn("uint64_t rdtsc_shim(void);", header)
            self.assertFalse(report["wasm_built"])

    def test_vendor_sources_match_pinned_provenance(self):
        import hashlib
        provenance = json.loads((adapter.VENDOR / "provenance.json").read_text())
        for name, expected in provenance["files"].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((adapter.VENDOR / name).read_bytes()).hexdigest(), expected)

    def test_lock_and_far_jump_have_explicit_semantics(self):
        for code, expected, unsupported in [
            (b"\xf0\x01\x08\xc3", "WC3_ATOMIC_ADD", 0),
            (b"\xf0\x0f\xc1\x08\xc3", "WC3_ATOMIC_XADD", 0),
            (b"\xf0\x0f\xc7\x08\xc3", "WC3_ATOMIC_CMPXCHG8B", 0),
            (b"\xff\x2d\x00\x20\x40\x00", "unsupported-memory-operand-6", 1),
        ]:
            with self.subTest(code=code.hex()), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                data = pe32_fixture(); data[0x200:0x200 + len(code)] = code
                image = root / "fixture.exe"; image.write_bytes(data)
                report = adapter.generate(image, root / "lift", max_functions=1, module_name="fixture")
                self.assertEqual(report["failed_functions"], 0)
                self.assertEqual(report["unsupported_instructions"], unsupported)
                self.assertIn(expected, (root / "lift/shard_0000.c").read_text())
                self.assertIn("wc3_fixture_function", (root / "lift/fntab.c").read_text())

    def test_additional_executable_sections_are_discovered(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = pe32_fixture()
            # Turn .data into a separately named executable section. The first
            # function directly calls it; this also exercises cross-section C.
            at = 0x98 + 224 + 40
            data[at:at + 8] = b"MSSMIXER"
            struct.pack_into("<I", data, at + 36, 0x60000020)
            data[0x200:0x206] = b"\xe8\xfb\x0f\x00\x00\xc3"
            data[0x400:0x406] = b"\xb8\x09\x00\x00\x00\xc3"
            image = root / "fixture.exe"; image.write_bytes(data)
            report = adapter.generate(image, root / "lift", max_functions=0)
            self.assertEqual(report["generated_functions"], 2)
            self.assertEqual(report["excluded_executable_sections"], [])
            self.assertEqual([item["name"] for item in report["static_coverage"]["sections"]], [".text", "MSSMIXER"])

    def test_empty_decode_becomes_a_runtime_fault(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); data = pe32_fixture()
            struct.pack_into("<I", data, 0x98 + 224 + 8, 1)
            data[0x200] = 0x0f  # incomplete two-byte instruction
            image = root / "fixture.exe"; image.write_bytes(data)
            report = adapter.generate(image, root / "lift", max_functions=1)
            self.assertEqual(report["empty_blocks"], 1)
            self.assertIn("empty decoded block", (root / "lift/shard_0000.c").read_text())

    @unittest.skipUnless(shutil.which('clang'), 'clang executes the translated fixture')
    def test_long_straight_line_code_continues_across_decoder_chunks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code = b'\x31\xc0' + b'\x40' * 8001 + b'\xc3'  # xor eax,eax; inc eax...; ret
            data = pe32_fixture()[:0x200] + code
            struct.pack_into('<H', data, 0x86, 1)
            struct.pack_into('<II', data, 0x98 + 96 + 5 * 8, 0, 0)
            struct.pack_into('<I', data, 0x98 + 56, 0x4000)
            struct.pack_into('<I', data, 0x98 + 224 + 8, len(code))
            struct.pack_into('<I', data, 0x98 + 224 + 16, len(code))
            image = root / 'fixture.exe'; image.write_bytes(data)
            report = adapter.generate(image, root / 'lift', max_functions=0)
            self.assertEqual(report['capped_blocks'], 0)
            self.assertEqual(report['split_blocks'], 2)
            self.assertEqual(report['functions'][0]['instructions'], 8003)
            self.assertEqual(report['unsupported_instructions'], 0)
            (root / 'main.c').write_text('''
#include "cpu.h"
#include <assert.h>
#include <stdlib.h>
uint8_t *g_mem; uint64_t g_mem_size;
_Noreturn void wc3_cpu_fault(CPU *c,uint32_t p,const char *s) { abort(); }
void sub_00401000(CPU *);
int main(void) {
  g_mem_size=8192;g_mem=calloc(1,8192);CPU c={0};c.esp=4096;MR32(4096)=1234;
  sub_00401000(&c);assert(c.eax==8001);assert(c.eip==1234);assert(c.esp==4100);
  free(g_mem);return 0;
}
''')
            subprocess.run(['clang', '-std=c11', '-O1', '-I'+str(ROOT / 'runtime'),
                            str(root / 'main.c'), str(root / 'lift/shard_0000.c'),
                            str(ROOT / 'runtime/cpu.c'), '-lm', '-o', str(root / 'run')],
                           check=True, capture_output=True, text=True)
            subprocess.run([str(root / 'run')], check=True)

    def test_fixed_exe_data_callbacks_are_discovered_without_relocations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); data = pe32_fixture()
            struct.pack_into("<II", data, 0x98 + 96 + 5 * 8, 0, 0)  # no relocation directory
            data[0x200] = 0xc3  # entry returns; second callback is data-only
            image = root / "fixture.exe"; image.write_bytes(data)
            report = adapter.generate(image, root / "auto", max_functions=0)
            self.assertEqual(report["generated_functions"], 2)
            callback = next(item for item in report["functions"] if item["address"] == "0x00401010")
            self.assertEqual(callback["origin"], ["data_pointer"])
            scan = report["relocations"]["data_pointer_scan"]
            self.assertTrue(scan["enabled"])
            self.assertIn({"slot": "0x00402000", "target": "0x00401010"}, scan["matches"])
            without = adapter.generate(image, root / "never", max_functions=0, scan_data_pointers="never")
            self.assertEqual(without["generated_functions"], 1)

    def test_fixed_exe_code_callbacks_are_discovered_to_a_fixed_point(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); data = pe32_fixture()
            struct.pack_into("<II", data, 0x98 + 96 + 5 * 8, 0, 0)
            struct.pack_into("<I", data, 0x400, 0)
            # A constructor pointer passed to a helper via PUSH, then another
            # callback loaded by MOV inside that constructor. Neither appears
            # in relocations/data/direct CALL operands.
            data[0x200:0x207] = b"\x68\x10\x10\x40\x00\x58\xc3"
            data[0x210:0x216] = b"\xb9\x18\x10\x40\x00\xc3"
            data[0x218] = 0xc3
            image = root / "fixture.exe"; image.write_bytes(data)
            report = adapter.generate(image, root / "auto", max_functions=0)
            self.assertEqual(report["generated_functions"], 3)
            self.assertEqual(report["unresolved_code_pointer_targets"], [])
            self.assertEqual(report["code_pointer_scan"]["unique_targets"], 2)
            self.assertEqual([item["origin"] for item in report["functions"][1:]], [["code_pointer"], ["code_pointer"]])
            without = adapter.generate(image, root / "never", max_functions=0, scan_code_pointers="never")
            self.assertEqual(without["generated_functions"], 1)

    def test_code_pointer_scan_uses_decoded_address_producing_operands(self):
        for code, expected in [(b"\x8d\x0d\x10\x10\x40\x00\xc3", 2),  # lea ecx,[401010]
                               (b"\x3d\x10\x10\x40\x00\xc3", 1),  # cmp eax,401010
                               (b"\xc3\x68\x10\x10\x40\x00", 1)]:  # undecoded bytes after RET
            with self.subTest(code=code.hex()), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); data = pe32_fixture()
                struct.pack_into("<II", data, 0x98 + 96 + 5 * 8, 0, 0)
                struct.pack_into("<I", data, 0x400, 0)
                data[0x200:0x200 + len(code)] = code
                image = root / "fixture.exe"; image.write_bytes(data)
                report = adapter.generate(image, root / "lift", max_functions=0)
                self.assertEqual(report["generated_functions"], expected)


@unittest.skipUnless(shutil.which("clang"), "clang is required for native CPU helper checks")
class NativeCPUTests(unittest.TestCase):
    def test_reserved_pages_block_reads_writes_and_atomics_until_committed(self):
        source = r'''
#include "cpu.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
uint8_t *g_mem;
uint64_t g_mem_size;
_Noreturn void wc3_cpu_fault(CPU *c, uint32_t address, const char *reason) {
    (void)c; fprintf(stderr, "%u:%s\n", address, reason); exit(77);
}
int main(int argc, char **argv) {
    g_mem_size=4*WC3_PAGE_BYTES; g_mem=calloc(1,(size_t)g_mem_size); CPU c={0};
    assert(!g_page_access); MR32(4096)=123;  /* standalone fixture fallback */
    assert(wc3_memory_permissions_init(g_mem_size));
    assert(g_page_count==4 && (g_page_access[0]&15)==15);
    /* Partial range protects its entire page, as VirtualProtect does. */
    assert(wc3_memory_protect(4097,1,0));
    assert((g_page_access[0]&15)==13);
    if(argc>1) {
        if(!strcmp(argv[1],"read")) return MR8(4096);
        if(!strcmp(argv[1],"write")) MR32(4096)=999;
        if(!strcmp(argv[1],"cross")) MR32(4094)=999;
        if(!strcmp(argv[1],"middle")) (void)wc3_mem_ptr(0,3*WC3_PAGE_BYTES);
        if(!strcmp(argv[1],"atomic")) wc3_atomic_rmw(&c,4096,32,WC3_ATOMIC_ADD,1,0);
        if(!strcmp(argv[1],"bounds")) (void)wc3_mem_ptr(UINT32_MAX,SIZE_MAX);
        return 2; /* access unexpectedly succeeded */
    }
    assert(!wc3_memory_protect(4096,0,1));
    assert(!wc3_memory_protect(4096,1,2)); /* no fake read-only mode */
    assert(!wc3_memory_protect(UINT32_MAX,2,1));
    assert((g_page_access[0]&15)==13);
    assert(wc3_memory_protect(4096,WC3_PAGE_BYTES,1)); /* MEM_COMMIT */
    assert(MR32(4096)==123); MR32(4096)=456; assert(MR32(4096)==456);
    assert(wc3_atomic_rmw(&c,4096,32,WC3_ATOMIC_ADD,1,0)==456);
    assert(MR32(4096)==457);
    assert(wc3_memory_protect(4095,2,0)); /* both crossed pages */
    assert((g_page_access[0]&15)==12);
    assert(wc3_memory_protect(0,8192,1)); assert((g_page_access[0]&15)==15);
    assert(wc3_memory_permissions_init(g_mem_size)); /* safe replacement */
    assert((g_page_access[0]&15)==15);
    free(g_page_access); free(g_mem); return 0;
}
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "test.c").write_text(source)
            # Page permissions are enforced in guest code only by the strict
            # diagnostic build; the default build keeps the bounds check.
            subprocess.run(["clang", "-std=c11", "-O2", "-pthread", "-DWC3_STRICT_MEMORY=1", "-I" + str(ROOT / "runtime"),
                            str(root / "test.c"), str(ROOT / "runtime/cpu.c"), "-lm", "-o", str(root / "test")],
                           check=True, capture_output=True, text=True)
            subprocess.run([str(root / "test")], check=True, capture_output=True, text=True)
            for mode in ("read", "write", "cross", "middle", "atomic", "bounds"):
                with self.subTest(mode=mode):
                    blocked = subprocess.run([str(root / "test"), mode], capture_output=True, text=True)
                    self.assertEqual(blocked.returncode, 77)
                    self.assertIn("out of range" if mode == "bounds" else "NOACCESS page", blocked.stderr)

    def test_default_access_path_checks_bounds_without_page_scan(self):
        source = r'''
#include "cpu.h"
#include <stdio.h>
#include <stdlib.h>
uint8_t *g_mem;
uint64_t g_mem_size;
_Noreturn void wc3_cpu_fault(CPU *c, uint32_t address, const char *reason) {
    (void)c; fprintf(stderr, "%u:%s\n", address, reason); exit(77);
}
int main(int argc, char **argv) {
    /* wc3_init allocates 16 bytes of slack after the guest capacity. */
    g_mem_size=4*WC3_PAGE_BYTES; g_mem=calloc(1,(size_t)g_mem_size+16);
    if(!wc3_memory_permissions_init(g_mem_size)||!wc3_memory_protect(4096,1,0)) return 3;
    MR32(4096)=7; if(MR32(4096)!=7) return 4;   /* reserved page: not scanned */
    MR32(4*WC3_PAGE_BYTES-4)=9; if(MR8(4*WC3_PAGE_BYTES-4)!=9) return 5;
    if(argc>1) (void)MR8(4*WC3_PAGE_BYTES);    /* first byte past capacity */
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "test.c").write_text(source)
            subprocess.run(["clang", "-std=c11", "-O2", "-pthread", "-I" + str(ROOT / "runtime"),
                            str(root / "test.c"), str(ROOT / "runtime/cpu.c"), "-lm", "-o", str(root / "test")],
                           check=True, capture_output=True, text=True)
            subprocess.run([str(root / "test")], check=True, capture_output=True, text=True)
            blocked = subprocess.run([str(root / "test"), "bounds"], capture_output=True, text=True)
            self.assertEqual(blocked.returncode, 77)
            self.assertIn("out of range", blocked.stderr)

    def test_cpu_abi_matches_upstream_and_helpers_execute(self):
        old = (adapter.VENDOR / "runtime/cpu.h").read_text()
        new = (ROOT / "runtime/cpu.h").read_text()
        extract = lambda text: text[text.index("typedef struct CPU {"):text.index("} CPU;") + len("} CPU;")]
        self.assertEqual(extract(new), extract(old))
        source = r'''
#include "cpu.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
uint8_t *g_mem;
uint64_t g_mem_size;
_Noreturn void wc3_cpu_fault(CPU *c, uint32_t address, const char *reason) {
    (void)c; (void)address; fprintf(stderr, "%s\n", reason); exit(77);
}
static void *increment(void *unused) {
    (void)unused; CPU c = {0};
    for (int i=0; i<10000; i++) wc3_atomic_rmw(&c, 128, 32, WC3_ATOMIC_ADD, 1, 0);
    return NULL;
}
int main(int argc, char **argv) {
    (void)argv; g_mem_size=256; g_mem=calloc(1,256); CPU c={0};
    if(argc>1) wc3_atomic_rmw(&c, 3, 32, WC3_ATOMIC_ADD, 1, 0);
    MR32(1)=0x3f800000; assert(MRF32(1)==1.0f);
    MRF64(3)=2.5; assert(MRF64(3)==2.5);
    MR8(32)=255; wc3_atomic_rmw(&c,32,8,WC3_ATOMIC_ADD,1,0);
    assert(MR8(32)==0 && c.cf && c.zf && c.af && !c.of);
    MR8(32)=127; c.cf=1; wc3_atomic_rmw(&c,32,8,WC3_ATOMIC_ADC,0,0);
    assert(MR8(32)==128 && !c.cf && c.of && c.sf);
    MR8(32)=0; c.cf=1; wc3_atomic_rmw(&c,32,8,WC3_ATOMIC_SBB,255,0);
    assert(MR8(32)==0 && c.cf && c.zf && c.af);
    MR32(32)=2; c.eax=1; wc3_atomic_rmw(&c,32,32,WC3_ATOMIC_CMPXCHG,9,c.eax);
    assert(MR32(32)==2 && c.eax==2 && !c.zf && c.cf && c.sf);
    c.eax=2; wc3_atomic_rmw(&c,32,32,WC3_ATOMIC_CMPXCHG,9,c.eax);
    assert(MR32(32)==9 && c.eax==2 && c.zf && !c.cf);
    MR64(40)=0x100000002ull; c.of=1;
    wc3_atomic_rmw(&c,40,64,WC3_ATOMIC_CMPXCHG8B,9,3);
    assert(c.eax==2 && c.edx==1 && !c.zf && c.of);
    wc3_atomic_rmw(&c,40,64,WC3_ATOMIC_CMPXCHG8B,9,0x100000002ull);
    assert(MR64(40)==9 && c.zf && c.of);
    MR16(48)=0xffff; c.cf=1; wc3_atomic_rmw(&c,48,16,WC3_ATOMIC_INC,0,0);
    assert(MR16(48)==0 && c.cf && c.zf);
    MR32(52)=3; c.of=1; uint64_t old=wc3_atomic_rmw(&c,52,32,WC3_ATOMIC_XCHG,7,0);
    assert(old==3 && MR32(52)==7 && c.of);
    wc3_atomic_rmw(&c,52,32,WC3_ATOMIC_BTR,1,0); assert(MR32(52)==5 && c.cf);
    pthread_t threads[4];
    for(int i=0;i<4;i++) assert(!pthread_create(&threads[i],NULL,increment,NULL));
    for(int i=0;i<4;i++) assert(!pthread_join(threads[i],NULL));
    assert(MR32(128)==40000); wc3_memory_fence(); free(g_mem); return 0;
}
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "test.c").write_text(source)
            subprocess.run(["clang", "-std=c11", "-O2", "-pthread", "-I" + str(ROOT / "runtime"),
                            str(root / "test.c"), str(ROOT / "runtime/cpu.c"), "-lm", "-o", str(root / "test")],
                           check=True, capture_output=True, text=True)
            subprocess.run([str(root / "test")], check=True, capture_output=True, text=True)
            bad = subprocess.run([str(root / "test"), "unaligned"], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 77)
            self.assertIn("unaligned LOCK operand", bad.stderr)


if __name__ == "__main__":
    unittest.main()
