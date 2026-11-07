import hashlib
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from server.maps import MapCatalog, map_id, parse_map_header


def header(name="Тестовая карта", flags=4, players=12):
    data = b"HM3W" + bytes(4) + name.encode() + b"\0"
    data += struct.pack("<II", flags, players)
    return data.ljust(512, b"\0")


class MapHeaderTests(unittest.TestCase):
    def test_reads_utf8_name_flags_and_slots(self):
        data = parse_map_header(header("|cffff0000Тест|r|nкарта", 0x44, 12))
        self.assertEqual(data, {"name": "Тест карта", "flags": 0x44,
                               "maxPlayers": 12, "headerStatus": "hm3w"})

    def test_invalid_header_is_not_confused_with_no_header(self):
        self.assertEqual(parse_map_header(b"MPQ\x1a")["headerStatus"], "missing")
        for value in [b"HM3W", b"HM3W" + b"x" * 508,
                      b"HM3W" + b"x" * 500 + b"\0" + b"x" * 7]:
            result = parse_map_header(value)
            self.assertEqual(result["headerStatus"], "invalid")
            self.assertIsNone(result["maxPlayers"])

    def test_header_cannot_read_unbounded_bytes(self):
        self.assertEqual(parse_map_header(b"HM3W" + b"x" * 600 + b"\0" + bytes(8))
                         ["headerStatus"], "invalid")


class MapCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "maps"
        self.root.mkdir()
        self.catalog = MapCatalog(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def add(self, relative, data=None):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(header() + b"MPQ\x1a" if data is None else data)
        return path

    def test_catalog_has_content_hash_stable_id_and_download_url(self):
        path = self.add("Download/Тест.W3X")
        item = self.catalog.manifest()["maps"][0]
        self.assertEqual(item["id"], hashlib.sha256("Download/Тест.W3X".encode()).hexdigest())
        self.assertEqual(item["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(item["size"], path.stat().st_size)
        self.assertEqual(item["kind"], "map")
        self.assertEqual(item["extension"], ".w3x")
        self.assertEqual(item["downloadUrl"], "/api/maps/" + item["id"] + "/download")
        self.assertEqual(self.catalog.resolve_map(item["id"]), path)
        with self.catalog.open_map(item["id"]) as stream:
            self.assertEqual(stream.read(), path.read_bytes())
        self.assertEqual(self.catalog.manifest(), self.catalog.manifest())

    def test_content_replacement_changes_digest_but_not_id(self):
        path = self.add("map.w3x")
        before = self.catalog.list_maps()[0]
        path.write_bytes(header("Changed") + b"New contents")
        after = self.catalog.list_maps()[0]
        self.assertEqual(before["id"], after["id"])
        self.assertNotEqual(before["sha256"], after["sha256"])
        self.assertEqual(after["name"], "Changed")

    def test_catalog_filters_extensions_and_labels_campaigns_only(self):
        self.add("a.w3m")
        self.add("b.W3N", b"MPQ\x1a")
        self.add("campaign-single-multiplayer.w3x", b"MPQ\x1a")
        self.add("not-a-map.zip")
        items = self.catalog.manifest()["maps"]
        self.assertEqual(len(items), 3)
        self.assertEqual(items[1]["kind"], "campaign")
        self.assertEqual(items[1]["headerStatus"], "not-applicable")
        self.assertEqual(items[2]["kind"], "map")
        self.assertIsNone(items[2]["maxPlayers"])
        self.assertNotIn("multiplayer", items[2])

    def test_missing_root_and_deleted_map_are_handled(self):
        self.assertEqual(MapCatalog(self.base / "absent").manifest()["maps"], [])
        path = self.add("gone.w3x")
        identifier = self.catalog.list_maps()[0]["id"]
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.catalog.open_map(identifier)

    def test_rejects_user_paths_and_unknown_ids(self):
        self.add("map.w3x")
        for value in ("../secret", "/etc/passwd", "00", "x" * 64, "0" * 64,
                      "map.w3x", "%2e%2e", None):
            with self.subTest(value=value), self.assertRaises(FileNotFoundError):
                self.catalog.resolve_map(value)
        for value in ("../map.w3x", "/map.w3x", "a/../map.w3x", "a\\map.w3x",
                      "a//map.w3x", "C:map.w3x", "a/./map.w3x", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                map_id(value)

    def test_ignores_file_directory_and_root_symlinks(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "secret.w3x").write_bytes(header())
        (self.root / "linked.w3x").symlink_to(outside / "secret.w3x")
        (self.root / "linked-dir").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.catalog.list_maps(), [])
        alternate = self.base / "linked-root"
        alternate.symlink_to(outside, target_is_directory=True)
        self.assertEqual(MapCatalog(alternate).list_maps(), [])

    def test_symlink_swapped_in_after_lookup_is_rejected(self):
        path = self.add("map.w3x")
        identifier = self.catalog.list_maps()[0]["id"]
        secret = self.base / "secret.w3x"
        secret.write_bytes(b"private data")
        original = self.catalog._lookup

        def replace_after_lookup(value):
            relative = original(value)
            path.unlink()
            path.symlink_to(secret)
            return relative

        with patch.object(self.catalog, "_lookup", side_effect=replace_after_lookup):
            with self.assertRaises(FileNotFoundError):
                self.catalog.open_map(identifier)

    def test_directory_swapped_to_symlink_after_lookup_is_rejected(self):
        self.add("nested/map.w3x")
        identifier = self.catalog.list_maps()[0]["id"]
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "map.w3x").write_bytes(b"private")
        original = self.catalog._lookup

        def replace_after_lookup(value):
            relative = original(value)
            (self.root / "nested").rename(self.root / "old")
            (self.root / "nested").symlink_to(outside, target_is_directory=True)
            return relative

        with patch.object(self.catalog, "_lookup", side_effect=replace_after_lookup):
            with self.assertRaises(FileNotFoundError):
                self.catalog.open_map(identifier)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX named pipes")
    def test_named_pipes_are_ignored_without_hanging(self):
        os.mkfifo(self.root / "pipe.w3x")
        self.assertEqual(self.catalog.list_maps(), [])


if __name__ == "__main__":
    unittest.main()
