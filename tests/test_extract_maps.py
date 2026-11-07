from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from tools.extract_maps import extract_maps, safe_member_path, write_new_file


class Archive:
    def __init__(self, members, listing=None, failures=None, flags=None):
        self.members = dict(members)
        if listing is not None:
            self.members[b"(listfile)"] = listing
        self.names = list(self.members)
        self.failures = failures or {}
        self.block_table = [SimpleNamespace(size=len(self.members[n]),
                            archived_size=len(self.members[n]),
                            flags=(flags or {}).get(n, 0x80000000)) for n in self.names]
        self.file = BytesIO()

    def get_hash_table_entry(self, name):
        name = name.encode() if isinstance(name, str) else name
        for i, existing in enumerate(self.names):
            if name.lower() == existing.lower():
                return SimpleNamespace(block_table_index=i)
        return None

    def read_file(self, name):
        index = self.get_hash_table_entry(name).block_table_index
        name = self.names[index]
        if name in self.failures:
            raise self.failures[name]
        return self.members[name]


class ExtractMapsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.game = self.root / "game"
        self.game.mkdir()
        self.output = self.root / "maps"
        self.archives = {}

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, filename, members, listing=None, **kwargs):
        (self.game / filename).write_bytes(b"fixture")
        archive = Archive(members, listing=listing, **kwargs)
        self.archives[filename] = archive
        return archive

    def extract(self):
        return extract_maps(self.game, self.output,
                            archive_factory=lambda filename, **_: self.archives[Path(filename).name])

    def test_priority_probes_overlay_even_when_listfile_omits_map(self):
        self.archive("War3Patch.mpq", {b"Maps\\Test.w3x": b"new"}, listing=b"text.txt\r\n")
        self.archive("War3x.mpq", {b"Maps\\Test.w3x": b"old"}, listing=b"Maps\\Test.w3x\r\n")
        report = self.extract()
        self.assertEqual((self.output / "Maps/Test.w3x").read_bytes(), b"new")
        self.assertEqual(report["maps"][0]["archive"], "War3Patch.mpq")
        self.assertEqual(report["extracted"], 1)
        self.assertTrue(report["complete"])

    def test_unsupported_overlay_does_not_fall_back_to_old_map(self):
        self.archive("War3Patch.mpq", {b"map.w3x": b"new"}, listing=b"map.w3x",
                     failures={b"map.w3x": RuntimeError("Unsupported compression")})
        self.archive("war3.mpq", {b"map.w3x": b"old"}, listing=b"map.w3x")
        report = self.extract()
        self.assertFalse((self.output / "map.w3x").exists())
        self.assertEqual(report["extracted"], 0)
        self.assertFalse(report["complete"])
        self.assertIn("Unsupported compression", report["errors"][0]["error"])

    def test_missing_listfile_is_reported_but_overlay_is_still_probed(self):
        self.archive("War3Patch.mpq", {b"map.w3x": b"new"})
        self.archive("war3.mpq", {b"map.w3x": b"old"}, listing=b"map.w3x")
        report = self.extract()
        self.assertEqual((self.output / "map.w3x").read_bytes(), b"new")
        self.assertFalse(report["complete"])
        self.assertEqual(report["errors"][0]["archive"], "War3Patch.mpq")

    def test_never_overwrites_existing_maps(self):
        self.output.mkdir()
        (self.output / "map.w3x").write_bytes(b"user content")
        self.archive("war3.mpq", {b"map.w3x": b"builtin"}, listing=b"map.w3x")
        report = self.extract()
        self.assertEqual((self.output / "map.w3x").read_bytes(), b"user content")
        self.assertEqual(report["preserved"], 1)
        self.assertEqual(report["maps"][0]["status"], "preserved-existing")
        self.assertEqual(list(self.output.glob(".extract-*")), [])

    def test_rejects_traversal_and_symlinks(self):
        for name in [b"..\\outside.w3x", b"/outside.w3x", b"C:\\outside.w3x",
                     b"a//outside.w3x", b"./outside.w3x", b"a\x00.w3x"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_member_path(name)
        self.output.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (self.output / "linked").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            write_new_file(self.output, "linked/secret.w3x", b"data")
        self.assertEqual(list(outside.iterdir()), [])

    def test_malformed_archive_size_is_not_written(self):
        archive = self.archive("war3.mpq", {b"map.w3x": b"data"}, listing=b"map.w3x")
        archive.block_table[0].size += 3
        report = self.extract()
        self.assertEqual(report["extracted"], 0)
        self.assertIn("size does not match", report["errors"][0]["error"])

    def test_deleted_and_patch_members_are_not_extracted(self):
        self.archive("War3Patch.mpq", {b"deleted.w3x": b"xx", b"patch.w3x": b"xx"},
                     listing=b"deleted.w3x\npatch.w3x", flags={
                         b"deleted.w3x": 0x82000000, b"patch.w3x": 0x80100000})
        report = self.extract()
        self.assertEqual(report["extracted"], 0)
        self.assertEqual(len(report["errors"]), 2)

    def test_empty_game_directory_does_not_report_success(self):
        report = self.extract()
        self.assertFalse(report["complete"])
        self.assertEqual(report["candidateCount"], 0)


if __name__ == "__main__":
    unittest.main()
