"""Bounded MPQ sector reader using mpyq's header/hash/block table parser.

mpyq 0.2.5 treats full raw sectors inside compressed multi-sector members as
compressed when further sectors remain. This reader compares each sector with
its own expected length. The storage/decryption rules follow StormLib:
https://github.com/ladislav-zezula/StormLib/blob/master/src/SFileReadFile.cpp

Supported payload codecs: raw, zlib (0x02), bzip2 (0x10). Unsupported codecs,
incremental patches and PKWARE implode raise explicit errors. Sector CRCs are
skipped; this reader does not authenticate archives.
"""

from __future__ import annotations

import bz2
import struct
import zlib


def decode_sector(data: bytes, expected_size: int) -> bytes:
    if len(data) == expected_size:
        return data
    if not data or len(data) > expected_size:
        raise ValueError("Invalid MPQ sector length")
    mask = data[0]
    if mask == 0x02:
        decoder = zlib.decompressobj()
        result = decoder.decompress(data[1:], expected_size + 1)
    elif mask == 0x10:
        decoder = bz2.BZ2Decompressor()
        result = decoder.decompress(data[1:], max_length=expected_size + 1)
    else:
        raise NotImplementedError(f"Unsupported MPQ compression mask 0x{mask:02x}")
    if len(result) != expected_size or not decoder.eof:
        raise ValueError("Decoded MPQ sector size does not match expected length")
    return result


class MPQReader:
    supports_encryption = True

    def __init__(self, filename, listfile=False):
        from mpyq import MPQArchive

        # Open externally so constructor failures never leak file descriptors.
        self.file = open(filename, "rb")
        try:
            self._archive = MPQArchive(self.file, listfile=False)
        except BaseException:
            self.file.close()
            raise
        self.header = self._archive.header
        self.block_table = self._archive.block_table
        self.hash_table = self._archive.hash_table
        self.files = self.read_file(b"(listfile)").splitlines() if listfile else None

    def get_hash_table_entry(self, member):
        return self._archive.get_hash_table_entry(member)

    def _decrypt(self, data, key):
        # MPQ transforms 32-bit words only; the final 1–3 bytes are unchanged.
        length = len(data) // 4 * 4
        return self._archive._decrypt(data[:length], key & 0xffffffff) + data[length:]

    def read_file(self, member):
        entry = self.get_hash_table_entry(member)
        if entry is None:
            return None
        if not 0 <= entry.block_table_index < len(self.block_table):
            raise ValueError("Invalid MPQ block index")
        block = self.block_table[entry.block_table_index]
        flags = block.flags
        if not flags & 0x80000000 or flags & 0x02000000:
            return None
        if flags & 0x00100000:
            raise NotImplementedError("Incremental MPQ patches are unsupported")
        if flags & 0x00000100:
            raise NotImplementedError("PKWARE implode is unsupported")
        if block.size > 256 * 1024 * 1024 or block.archived_size > 256 * 1024 * 1024:
            raise ValueError("MPQ member exceeds 256 MiB extraction limit")
        self.file.seek(self.header["offset"] + block.offset)
        raw = self.file.read(block.archived_size)
        if len(raw) != block.archived_size:
            raise ValueError("Truncated MPQ member")
        if block.size == 0:
            return b""
        encrypted = bool(flags & 0x00010000)
        compressed = bool(flags & 0x00000200)
        key = 0
        if encrypted:
            name = member.encode("utf-8") if isinstance(member, str) else member
            key = self._archive._hash(name.replace(b"/", b"\\").rsplit(b"\\", 1)[-1], "TABLE")
            if flags & 0x00020000:
                key = ((key + block.offset) ^ block.size) & 0xffffffff
        if flags & 0x01000000:
            if encrypted:
                raw = self._decrypt(raw, key)
            return decode_sector(raw, block.size) if compressed else raw

        shift = self.header["sector_size_shift"]
        if not 0 <= shift <= 15:
            raise ValueError("Invalid MPQ sector size shift")
        sector_size = 512 << shift
        count = (block.size + sector_size - 1) // sector_size
        if compressed:
            offset_count = count + 1 + bool(flags & 0x04000000)
            table_size = offset_count * 4
            table = raw[:table_size]
            if len(table) != table_size:
                raise ValueError("Truncated MPQ sector table")
            if encrypted:
                table = self._decrypt(table, key - 1)
            offsets = struct.unpack(f"<{offset_count}I", table)
            if offsets[0] < table_size or offsets[count] > len(raw):
                raise ValueError("MPQ sector offsets outside member bounds")
        else:
            offsets = [min(i * sector_size, block.size) for i in range(count + 1)]

        result = bytearray()
        for index in range(count):
            start, end = offsets[index:index + 2]
            if start > end or end > len(raw):
                raise ValueError("Invalid MPQ sector offsets")
            sector = raw[start:end]
            if encrypted:
                sector = self._decrypt(sector, key + index)
            expected = min(sector_size, block.size - len(result))
            if compressed:
                sector = decode_sector(sector, expected)
            if len(sector) != expected:
                raise ValueError("Invalid decoded MPQ sector length")
            result.extend(sector)
        return bytes(result)
