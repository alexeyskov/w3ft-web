from io import BytesIO
import struct
from types import SimpleNamespace
import unittest
import zlib

from tools.mpq_reader import MPQReader, decode_sector


def reader_for(sectors, size, flags=0x80000200):
    table_size = (len(sectors) + 1) * 4
    positions = [table_size]
    for sector in sectors:
        positions.append(positions[-1] + len(sector))
    data = struct.pack(f"<{len(positions)}I", *positions) + b"".join(sectors)
    reader = MPQReader.__new__(MPQReader)
    reader.file = BytesIO(data)
    reader.header = {"offset": 0, "sector_size_shift": 0}
    reader.block_table = [SimpleNamespace(offset=0, size=size,
                                          archived_size=len(data), flags=flags)]
    reader._archive = SimpleNamespace(get_hash_table_entry=lambda _: SimpleNamespace(block_table_index=0))
    return reader


class MPQReaderTests(unittest.TestCase):
    def test_mixed_raw_and_zlib_sectors_with_exact_sector_multiple(self):
        # Regression: mpyq tries to decompress this raw sector because more
        # than 512 bytes remain in the file. It also rounds exact multiples up.
        raw = b"x" * 512
        packed = b"\x02" + zlib.compress(b"z" * 512)
        reader = reader_for([raw, packed], 1024)
        self.assertEqual(reader.read_file(b"test.w3x"), raw + b"z" * 512)

    def test_last_raw_sector_uses_remaining_length(self):
        packed = b"\x02" + zlib.compress(b"z" * 512)
        reader = reader_for([packed, b"plain trailing bytes"], 512 + 20)
        self.assertEqual(reader.read_file(b"test.w3x"), b"z" * 512 + b"plain trailing bytes")

    def test_invalid_sector_offsets_raise(self):
        reader = reader_for([b"x" * 512], 512)
        reader.file.seek(0)
        reader.file.write(struct.pack("<II", 2, 999999))
        with self.assertRaisesRegex(ValueError, "offsets"):
            reader.read_file(b"test.w3x")

    def test_unsupported_codec_is_identified(self):
        with self.assertRaisesRegex(NotImplementedError, "0x08"):
            decode_sector(b"\x08whatever", 512)

    def test_zlib_output_is_bounded_and_size_checked(self):
        payload = b"\x02" + zlib.compress(b"a" * 100_000)
        with self.assertRaisesRegex(ValueError, "size"):
            decode_sector(payload, 512)

    def test_truncated_sector_is_rejected(self):
        with self.assertRaises(ValueError):
            decode_sector(b"", 512)

    def test_uncompressed_file_has_no_sector_offset_table(self):
        reader = reader_for([], 20, flags=0x80000000)
        reader.file = BytesIO(b"plain trailing bytes")
        reader.block_table[0].archived_size = 20
        self.assertEqual(reader.read_file(b"test"), b"plain trailing bytes")

    def test_encryption_keeps_partial_final_word(self):
        reader = MPQReader.__new__(MPQReader)
        reader._archive = SimpleNamespace(_decrypt=lambda data, key: bytes(len(data)))
        self.assertEqual(reader._decrypt(b"1234567", 5), bytes(4) + b"567")


if __name__ == "__main__":
    unittest.main()
