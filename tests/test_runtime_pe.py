"""Compile the PE loader natively and inspect data; never execute guest code."""
import ctypes as C
import mmap
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
U8 = C.c_uint8
U32 = C.c_uint32


class Module(C.Structure):
    pass


class Loader(C.Structure):
    pass


Module._fields_ = [
    ("loader", C.POINTER(Loader)), ("name", C.c_char * 128),
    ("base", U32), ("size", U32), ("preferred_base", U32), ("entrypoint", U32),
    ("directory_rva", U32 * 16), ("directory_size", U32 * 16),
    ("characteristics", C.c_uint16), ("is_dll", U8), ("state", C.c_int),
    ("dependencies", C.POINTER(Module) * 32), ("dependency_count", C.c_size_t),
]
Loader._fields_ = [("memory", C.POINTER(U8)), ("capacity", C.c_uint64),
                   ("modules", Module * 32), ("module_count", C.c_size_t)]


class Export(C.Structure):
    _fields_ = [("address", U32), ("forwarded", C.c_int), ("forwarder", C.c_char * 256)]


Resolver = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_char_p, C.c_char_p,
                       C.c_uint16, C.POINTER(U32))
Initializer = C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(Module), U32, U32, U32)


def fixture(*, imports=True, exports=True, relocations=True, library="dep.dll", dll=True):
    image = bytearray(0xA00)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", image, 0x84, 0x14C, 1, 0, 0, 0, 224,
                     0x2102 if dll else 0x102)
    optional = 0x98
    struct.pack_into("<H", image, optional, 0x10B)
    for offset, value in ((16, 0x1000), (28, 0x10000), (32, 0x1000),
                          (36, 0x200), (56, 0x3000), (60, 0x200), (92, 16)):
        struct.pack_into("<I", image, optional + offset, value)
    section = optional + 224
    image[section:section + 8] = b".text\0\0\0"
    struct.pack_into("<IIII", image, section + 8, 0x1000, 0x1000, 0x800, 0x200)
    struct.pack_into("<I", image, section + 36, 0x60000020)

    def put(rva, fmt, *values):
        struct.pack_into("<" + fmt, image, rva - 0x1000 + 0x200, *values)

    def string(rva, text):
        start = rva - 0x1000 + 0x200
        data = text.encode("ascii") + b"\0"
        image[start:start + len(data)] = data

    image[0x200:0x204] = b"CODE"
    put(0x1040, "I", 0x10123)
    if imports:
        struct.pack_into("<II", image, optional + 96 + 8, 0x1100, 40)
        put(0x1100, "IIIII", 0x1160, 0, 0, 0x1150, 0x1180)
        string(0x1150, library)
        put(0x1160, "III", 0x11A0, 0x80000007, 0)
        put(0x1180, "III", 0x11A0, 0x80000007, 0)
        put(0x11A0, "H", 0)
        string(0x11A2, "CallNamed")
    if exports:
        struct.pack_into("<II", image, optional + 96, 0x1200, 0x100)
        put(0x1200, "IIHHIIIIIII", 0, 0, 0, 0, 0x12D0, 5, 3, 2,
            0x1240, 0x1250, 0x1258)
        put(0x1240, "III", 0x1000, 0x1010, 0x1280)
        put(0x1250, "II", 0x1260, 0x1270)
        put(0x1258, "HH", 0, 2)
        string(0x1260, "Named")
        string(0x1270, "Forward")
        string(0x1280, "OTHER.#42")
        string(0x12D0, "fixture.dll")
    if relocations:
        struct.pack_into("<II", image, optional + 96 + 5 * 8, 0x1400, 12)
        put(0x1400, "IIHH", 0x1000, 12, 0x3040, 0)
    return image


class NativePELoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("clang") or shutil.which("cc")
        if not compiler:
            raise unittest.SkipTest("A C compiler is required for native loader tests")
        cls.build = tempfile.TemporaryDirectory(prefix="wc3-pe-test-")
        output = Path(cls.build.name) / "loader.so"
        subprocess.run([compiler, "-shared", "-fPIC", "-std=c11", "-Wall", "-Wextra", "-Werror",
                        str(ROOT / "runtime/pe.c"), "-o", str(output)], check=True,
                       capture_output=True, text=True)
        cls.lib = C.CDLL(str(output))
        cls.lib.wc3_pe_loader_init.argtypes = [C.POINTER(Loader), C.POINTER(U8), C.c_uint64]
        cls.lib.wc3_pe_loader_init.restype = None
        cls.lib.wc3_pe_load.argtypes = [C.POINTER(Loader), C.c_char_p, C.POINTER(U8), C.c_size_t,
                                      U32, C.POINTER(C.POINTER(Module)), C.c_char_p, C.c_size_t]
        cls.lib.wc3_pe_load.restype = C.c_int
        cls.lib.wc3_pe_link.argtypes = [C.POINTER(Module), Resolver, C.c_void_p, C.c_char_p, C.c_size_t]
        cls.lib.wc3_pe_link.restype = C.c_int
        cls.lib.wc3_pe_export.argtypes = [C.POINTER(Module), C.c_char_p, C.c_uint16,
                                        C.POINTER(Export), C.c_char_p, C.c_size_t]
        cls.lib.wc3_pe_export.restype = C.c_int
        cls.lib.wc3_pe_initialize.argtypes = [C.POINTER(Module), Initializer, C.c_void_p,
                                            C.c_char_p, C.c_size_t]
        cls.lib.wc3_pe_initialize.restype = C.c_int
        cls.lib.wc3_pe_find.argtypes = [C.POINTER(Loader), C.c_char_p]
        cls.lib.wc3_pe_find.restype = C.POINTER(Module)
        cls.lib.wc3_pe_find_address.argtypes = [C.POINTER(Loader), U32]
        cls.lib.wc3_pe_find_address.restype = C.POINTER(Module)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.memory = (U8 * 0x80000)()
        self.loader = Loader()
        self.lib.wc3_pe_loader_init(C.byref(self.loader), self.memory, len(self.memory))
        self.error = C.create_string_buffer(512)

    def load(self, image=None, name=b"fixture.dll", base=0, expected=True):
        image = fixture() if image is None else image
        source = (U8 * len(image)).from_buffer_copy(image)
        module = C.POINTER(Module)()
        result = self.lib.wc3_pe_load(C.byref(self.loader), name, source, len(source), base,
                                     C.byref(module), self.error, len(self.error))
        self.assertEqual(bool(result), expected, self.error.value.decode())
        return module

    def uint(self, address):
        return struct.unpack("<I", bytes(self.memory[address:address + 4]))[0]

    def resolver(self, calls, fail_ordinal=False):
        @Resolver
        def resolve(_context, library, name, ordinal, out):
            calls.append((library, name, ordinal))
            if fail_ordinal and name is None:
                return 0
            out[0] = 0x70000 + (4 if name else ordinal * 4)
            return 1
        return resolve

    def test_headers_sections_zero_fill_and_queries(self):
        module = self.load()
        self.assertEqual(bytes(self.memory[0x10000:0x10002]), b"MZ")
        self.assertEqual(bytes(self.memory[0x11000:0x11004]), b"CODE")
        self.assertEqual(bytes(self.memory[0x11800:0x13000]), bytes(0x1800))
        self.assertEqual(module.contents.state, 1)
        self.assertEqual(module.contents.entrypoint, 0x11000)
        self.assertEqual(self.lib.wc3_pe_find(C.byref(self.loader), b"FIXTURE.DLL").contents.base, 0x10000)
        self.assertEqual(self.lib.wc3_pe_find_address(C.byref(self.loader), 0x12FFF).contents.base, 0x10000)
        self.assertFalse(self.lib.wc3_pe_find_address(C.byref(self.loader), 0x13000))

    def test_relocation_applies_highlow_and_ignores_padding(self):
        module = self.load(base=0x20000)
        self.assertEqual(self.uint(0x21040), 0x20123)
        self.assertEqual(module.contents.entrypoint, 0x21000)

    def test_relocation_failure_is_not_registered(self):
        for image in (fixture(relocations=False), fixture()):
            if struct.unpack_from("<I", image, 0x98 + 96 + 5 * 8)[0] != 0:
                struct.pack_into("<H", image, 0x608, 0xA040)
            self.load(image, base=0x20000, expected=False)
            self.assertEqual(self.loader.module_count, 0)
            self.assertEqual(bytes(self.memory[0x20000:0x23000]), bytes(0x3000))

    def test_relocation_target_bounds(self):
        image = fixture()
        struct.pack_into("<I", image, 0x600, 0xFFFFF000)
        self.load(image, base=0x20000, expected=False)
        self.assertIn(b"outside", self.error.value)

    def test_bad_headers_sections_and_directories_rejected(self):
        samples = [fixture()[:100], fixture()[:0x300]]
        for offset, value in ((0x3C, 0xFFFFFFFF), (0x98 + 56, 0xFFFFFFFF),
                              (0x178 + 12, 0x2FFF), (0x178 + 20, 0xFFFFFF00),
                              (0x98 + 96, 0x4000)):
            image = fixture(); struct.pack_into("<I", image, offset, value); samples.append(image)
        for image in samples:
            with self.subTest(size=len(image)):
                self.load(image, expected=False)
                self.assertEqual(self.loader.module_count, 0)

    def test_overlapping_modules_and_duplicate_names_rejected(self):
        self.load()
        self.load(name=b"second.dll", base=0x11000, expected=False)
        self.assertIn(b"overlaps", self.error.value)
        self.load(name=b"FIXTURE.DLL", base=0x20000, expected=False)
        self.assertEqual(self.loader.module_count, 1)
        self.assertEqual(bytes(self.memory[0x11000:0x11004]), b"CODE")

    def test_named_and_ordinal_imports_and_atomic_failure(self):
        module = self.load()
        before = bytes(self.memory[0x11180:0x1118C])
        calls = []
        self.assertFalse(self.lib.wc3_pe_link(module, self.resolver(calls, True), None, self.error, 512))
        self.assertEqual(bytes(self.memory[0x11180:0x1118C]), before)
        self.assertEqual(module.contents.state, 1)
        calls = []
        self.assertTrue(self.lib.wc3_pe_link(module, self.resolver(calls), None, self.error, 512), self.error.value)
        self.assertEqual(calls, [(b"dep.dll", b"CallNamed", 0), (b"dep.dll", None, 7)])
        self.assertEqual(self.uint(0x11180), 0x70004)
        self.assertEqual(self.uint(0x11184), 0x7001C)
        self.assertEqual(module.contents.state, 2)

    def test_original_first_thunk_fallback(self):
        image = fixture(); struct.pack_into("<I", image, 0x300, 0)
        module = self.load(image)
        self.assertTrue(self.lib.wc3_pe_link(module, self.resolver([]), None, self.error, 512))
        self.assertEqual(self.uint(0x11180), 0x70004)

    def test_bad_import_iat_bounds(self):
        image = fixture(); struct.pack_into("<I", image, 0x310, 0x2FFF)
        module = self.load(image)
        self.assertFalse(self.lib.wc3_pe_link(module, self.resolver([]), None, self.error, 512))
        self.assertIn(b"outside", self.error.value)

    def test_named_ordinal_and_forwarded_exports(self):
        module = self.load()
        out = Export()
        self.assertTrue(self.lib.wc3_pe_export(module, b"Named", 0, C.byref(out), self.error, 512))
        self.assertEqual(out.address, 0x11000)
        self.assertFalse(out.forwarded)
        self.assertTrue(self.lib.wc3_pe_export(module, None, 6, C.byref(out), self.error, 512))
        self.assertEqual(out.address, 0x11010)
        self.assertTrue(self.lib.wc3_pe_export(module, b"Forward", 0, C.byref(out), self.error, 512))
        self.assertTrue(out.forwarded)
        self.assertEqual(out.forwarder, b"OTHER.#42")
        self.assertFalse(self.lib.wc3_pe_export(module, b"Missing", 0, C.byref(out), self.error, 512))
        self.assertEqual(out.address, 0)

    def test_malformed_export_table_is_bounded(self):
        image = fixture(); struct.pack_into("<I", image, 0x400 + 28, 0x2FFF)
        module = self.load(image)
        self.assertFalse(self.lib.wc3_pe_export(module, b"Named", 0, C.byref(Export()), self.error, 512))

    def test_forwarder_must_terminate_inside_export_directory(self):
        image = fixture()
        image[0x480:0x500] = b"X" * 0x80
        module = self.load(image)
        self.assertFalse(self.lib.wc3_pe_export(module, b"Forward", 0, C.byref(Export()), self.error, 512))
        self.assertIn(b"forwarder", self.error.value)

    def test_source_cannot_alias_destination(self):
        image = fixture()
        C.memmove(C.addressof(self.memory) + 0x10000, bytes(image), len(image))
        source = C.cast(C.addressof(self.memory) + 0x10000, C.POINTER(U8))
        output = C.POINTER(Module)()
        self.assertFalse(self.lib.wc3_pe_load(C.byref(self.loader), b"alias.dll", source,
                                             len(image), 0, C.byref(output), self.error, 512))
        self.assertIn(b"aliases", self.error.value)

    def test_initialization_cycle_and_failure_state(self):
        dependency = self.load(fixture(library="root.dll"), name=b"dep.dll", base=0x20000)
        module = self.load(name=b"root.dll")
        resolve = self.resolver([])
        for image in (dependency, module):
            self.assertTrue(self.lib.wc3_pe_link(image, resolve, None, self.error, 512))
        calls = []

        @Initializer
        def reject(_context, image, entry, base, reason):
            calls.append(image.contents.name)
            return 0

        self.assertFalse(self.lib.wc3_pe_initialize(module, reject, None, self.error, 512))
        self.assertEqual(calls, [b"dep.dll"])
        self.assertEqual(dependency.contents.state, 2)
        self.assertEqual(module.contents.state, 2)

        @Initializer
        def accept(_context, image, entry, base, reason):
            calls.append(image.contents.name)
            return 1

        self.assertTrue(self.lib.wc3_pe_initialize(module, accept, None, self.error, 512))
        self.assertEqual(calls, [b"dep.dll", b"dep.dll", b"root.dll"])

    def test_dependency_initialization_order_and_once_only(self):
        dependency = self.load(fixture(imports=False), name=b"dep.dll", base=0x20000)
        module = self.load()
        resolve = self.resolver([])
        self.assertTrue(self.lib.wc3_pe_link(module, resolve, None, self.error, 512))
        order = []

        @Initializer
        def initialize(_context, image, entry, base, reason):
            order.append((image.contents.name, entry, base, reason))
            return 1

        self.assertFalse(self.lib.wc3_pe_initialize(module, initialize, None, self.error, 512))
        self.assertEqual(order, [])
        self.assertTrue(self.lib.wc3_pe_link(dependency, resolve, None, self.error, 512))
        self.assertTrue(self.lib.wc3_pe_initialize(module, initialize, None, self.error, 512), self.error.value)
        self.assertEqual(order, [(b"dep.dll", 0x21000, 0x20000, 1),
                                 (b"fixture.dll", 0x11000, 0x10000, 1)])
        self.assertTrue(self.lib.wc3_pe_initialize(module, initialize, None, self.error, 512))
        self.assertEqual(len(order), 2)
        self.assertEqual(module.contents.state, 4)

    def test_executable_entrypoint_is_not_called_as_dllmain(self):
        module = self.load(fixture(imports=False, dll=False), name=b"test.exe")
        self.assertTrue(self.lib.wc3_pe_link(module, self.resolver([]), None, self.error, 512))
        calls = []

        @Initializer
        def initialize(*arguments):
            calls.append(arguments); return 1

        self.assertTrue(self.lib.wc3_pe_initialize(module, initialize, None, self.error, 512))
        self.assertEqual(calls, [])

    @unittest.skipUnless((ROOT / "var/game/game.dll").is_file(), "Prepared local game is not available")
    def test_real_game_dll_and_exe_load_and_link_without_execution(self):
        memory = mmap.mmap(-1, 0x80000000)
        pointer = C.cast(C.addressof(C.c_char.from_buffer(memory)), C.POINTER(U8))
        self.lib.wc3_pe_loader_init(C.byref(self.loader), pointer, 0x80000000)
        calls = []
        resolve = self.resolver(calls)
        try:
            game = self.load((ROOT / "var/game/game.dll").read_bytes(), name=b"game.dll")
            executable = self.load((ROOT / "var/game/war3.exe").read_bytes(), name=b"war3.exe")
            storm = self.load((ROOT / "var/game/Storm.dll").read_bytes(), name=b"Storm.dll")
            miles = self.load((ROOT / "var/game/Mss32.dll").read_bytes(), name=b"Mss32.dll")
            for module in (game, executable, storm, miles):
                self.assertTrue(self.lib.wc3_pe_link(module, resolve, None, self.error, 512), self.error.value)
            out = Export()
            self.assertTrue(self.lib.wc3_pe_export(game, b"GameMain", 0, C.byref(out), self.error, 512))
            self.assertEqual(out.address, 0x6F009850)
            self.assertEqual(game.contents.entrypoint, 0x6F7E15B8)
            self.assertEqual(len(calls), 668 + 494 + 259 + 132)
            self.assertGreaterEqual(game.contents.dependency_count, 2)
        finally:
            memory.close()


if __name__ == "__main__":
    unittest.main()
