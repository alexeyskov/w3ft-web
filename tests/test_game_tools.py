import io
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import zipfile

from tools.inspect_game import PE, PEError, parse_version_info
from tools.prepare_game import archive_plan, prepare_game


def minimal_pe():
    image = bytearray(0x600)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", image, 0x84, 0x14C, 1, 0, 0, 0, 224, 0x102)
    optional = 0x98
    struct.pack_into("<H", image, optional, 0x10B)
    struct.pack_into("<I", image, optional + 16, 0x1000)
    struct.pack_into("<I", image, optional + 28, 0x400000)
    struct.pack_into("<II", image, optional + 56, 0x2000, 0x200)
    struct.pack_into("<H", image, optional + 68, 2)
    struct.pack_into("<I", image, optional + 92, 16)
    section = optional + 224
    image[section:section + 8] = b".text\0\0\0"
    struct.pack_into("<IIII", image, section + 8, 0x500, 0x1000, 0x400, 0x200)
    struct.pack_into("<I", image, section + 36, 0x60000020)
    return image


class PEInspectionTests(unittest.TestCase):
    def test_sections_and_virtual_entrypoint(self):
        result = PE(bytes(minimal_pe())).describe()
        self.assertEqual(result["entrypoint_va"], 0x401000)
        self.assertEqual(result["machine_name"], "i386")
        self.assertTrue(result["sections"][0]["executable"])

    def test_import_names_and_ordinals(self):
        image = minimal_pe()
        struct.pack_into("<II", image, 0x98 + 96 + 8, 0x1000, 40)
        struct.pack_into("<IIIII", image, 0x200, 0x1080, 0, 0, 0x1060, 0x1080)
        image[0x260:0x26D] = b"KERNEL32.dll\0"
        struct.pack_into("<III", image, 0x280, 0x10A0, 0x8000007B, 0)
        struct.pack_into("<H", image, 0x2A0, 5)
        image[0x2A2:0x2AE] = b"ExitProcess\0"
        imports = PE(bytes(image)).imports()
        self.assertEqual(imports, [{"library": "KERNEL32.dll", "symbols": [
            {"name": "ExitProcess", "hint": 5}, {"ordinal": 123}]}])

    def test_unbacked_virtual_memory_is_not_read_as_file_data(self):
        pe = PE(bytes(minimal_pe()))
        with self.assertRaisesRegex(PEError, "not backed"):
            pe.offset(0x1400)

    def test_truncated_pe_is_rejected(self):
        with self.assertRaises(PEError):
            PE(b"MZ")
        with self.assertRaises(PEError):
            PE(bytes(minimal_pe()[:0x400]))

    def test_fixed_version_resource(self):
        key = "VS_VERSION_INFO\0".encode("utf-16le")
        value_at = (6 + len(key) + 3) & ~3
        blob = bytearray(value_at + 52)
        struct.pack_into("<HHH", blob, 0, len(blob), 52, 0)
        blob[6:6 + len(key)] = key
        struct.pack_into("<13I", blob, value_at, 0xFEEF04BD, 0x10000,
                         0x1001A, 0x000119C8, 0x1001A, 0x000119C8,
                         0x3F, 0, 0x40004, 1, 0, 0, 0)
        result = parse_version_info(bytes(blob))
        self.assertEqual(result["file_version"], "1.26.1.6600")
        self.assertEqual(result["product_version"], "1.26.1.6600")

    def test_invalid_version_length_is_rejected(self):
        with self.assertRaises(PEError):
            parse_version_info(b"\xff\xff\0\0\0\0")


class ArchivePreparationTests(unittest.TestCase):
    def archive(self, names):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for name, data in names:
                archive.writestr(name, data)
        stream.seek(0)
        return stream

    def test_rejects_path_traversal_and_windows_paths(self):
        for name in ("../escape", "/absolute", "game/../../escape", "C:/escape",
                     "game\\..\\escape", "game//bad", "./game"):
            with self.subTest(name=name), zipfile.ZipFile(self.archive([(name, b"bad")])) as archive:
                with self.assertRaises(ValueError):
                    archive_plan(archive)

    def test_rejects_symlinks(self):
        entry = zipfile.ZipInfo("game/link")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.archive([(entry, b"../../escape")])) as archive:
            with self.assertRaisesRegex(ValueError, "symlinks"):
                archive_plan(archive)

    def test_rejects_case_collisions_and_file_directories(self):
        for names in (("game/A", "game/a"), ("game/file", "game/file/child")):
            with zipfile.ZipFile(self.archive([(name, b"x") for name in names])) as archive:
                with self.assertRaises(ValueError):
                    archive_plan(archive)

    def test_size_limit(self):
        with zipfile.ZipFile(self.archive([("game/file", b"1234")])) as archive:
            with self.assertRaisesRegex(ValueError, "size limit"):
                archive_plan(archive, max_bytes=3)

    def test_stream_extracts_and_strips_wrapper(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "game.zip"
            source.write_bytes(self.archive([("Warcraft III/", b""),
                                            ("Warcraft III/game.dll", b"sample"),
                                            ("Warcraft III/Maps/", b"")]).getvalue())
            destination = root / "game"
            prepare_game(source, destination)
            self.assertEqual((destination / "game.dll").read_bytes(), b"sample")
            self.assertTrue((destination / "Maps").is_dir())
            with self.assertRaises(FileExistsError):
                prepare_game(source, destination)

    def test_invalid_archive_leaves_no_partial_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "bad.zip"
            source.write_bytes(self.archive([("game/good", b"x"), ("../bad", b"y")]).getvalue())
            with self.assertRaises(ValueError):
                prepare_game(source, root / "game")
            self.assertFalse((root / "game").exists())
            self.assertEqual(list(root.iterdir()), [source])


if __name__ == "__main__":
    unittest.main()
