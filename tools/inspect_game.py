#!/usr/bin/env python3
"""Inspect a local Warcraft III installation without executing game binaries.

Only Python's standard library is required. PE addresses are image RVAs, not
guessed offsets; version values come from the VERSIONINFO resource.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
from typing import Any


class PEError(ValueError):
    pass


class PE:
    def __init__(self, data: bytes):
        self.data = data
        if self.slice(0, 2) != b"MZ":
            raise PEError("Missing DOS signature")
        self.pe_offset = self.unpack("I", 0x3C)[0]
        if self.slice(self.pe_offset, 4) != b"PE\0\0":
            raise PEError("Missing PE signature")
        coff = self.pe_offset + 4
        (self.machine, count, self.timestamp, _, _, optional_size,
         self.characteristics) = self.unpack("HHIIIHH", coff)
        optional = coff + 20
        self.slice(optional, optional_size)
        magic = self.unpack("H", optional)[0]
        if magic not in (0x10B, 0x20B):
            raise PEError(f"Unsupported optional header: {magic:#x}")
        self.bits = 32 if magic == 0x10B else 64
        self.entry_rva = self.unpack("I", optional + 16)[0]
        self.image_base = self.unpack("I" if self.bits == 32 else "Q",
                                      optional + (28 if self.bits == 32 else 24))[0]
        self.image_size, self.header_size = self.unpack("II", optional + 56)
        self.subsystem = self.unpack("H", optional + 68)[0]
        count_offset = 92 if self.bits == 32 else 108
        if optional_size < count_offset + 4:
            raise PEError("Truncated optional header")
        directory_count = min(self.unpack("I", optional + count_offset)[0], 16)
        if count_offset + 4 + directory_count * 8 > optional_size:
            raise PEError("Data directories exceed optional header")
        self.directories = [self.unpack("II", optional + count_offset + 4 + i * 8)
                            for i in range(directory_count)]
        self.sections = []
        if count > 96:
            raise PEError("Unreasonable PE section count")
        for i in range(count):
            offset = optional + optional_size + i * 40
            name = self.slice(offset, 8).rstrip(b"\0").decode("ascii", "replace")
            virtual_size, rva, raw_size, raw_offset = self.unpack("IIII", offset + 8)
            flags = self.unpack("I", offset + 36)[0]
            self.slice(raw_offset, raw_size)
            self.sections.append({"name": name, "rva": rva,
                                  "virtual_size": virtual_size, "raw_offset": raw_offset,
                                  "raw_size": raw_size, "characteristics": flags,
                                  "executable": bool(flags & 0x20000000)})

    def slice(self, offset: int, size: int) -> bytes:
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise PEError(f"File access out of bounds: offset={offset:#x}, size={size}")
        return self.data[offset:offset + size]

    def unpack(self, fmt: str, offset: int) -> tuple:
        return struct.unpack("<" + fmt, self.slice(offset, struct.calcsize("<" + fmt)))

    def offset(self, rva: int, size: int = 1) -> int:
        if 0 <= rva < self.header_size and rva + size <= self.header_size:
            self.slice(rva, size)
            return rva
        for section in self.sections:
            delta = rva - section["rva"]
            if 0 <= delta and delta + size <= section["raw_size"]:
                result = section["raw_offset"] + delta
                self.slice(result, size)
                return result
        raise PEError(f"RVA {rva:#x} (size {size}) is not backed by file data")

    def cstring(self, rva: int) -> str:
        start = self.offset(rva)
        end = self.data.find(b"\0", start, min(start + 4096, len(self.data)))
        if end < 0:
            raise PEError("Unterminated PE string")
        # Check that the full string remains inside the same file-backed span.
        self.offset(rva, end - start + 1)
        return self.data[start:end].decode("ascii", "replace")

    def directory(self, index: int) -> tuple[int, int]:
        return self.directories[index] if index < len(self.directories) else (0, 0)

    def imports(self) -> list[dict[str, Any]]:
        rva, size = self.directory(1)
        if not rva or not size:
            return []
        result = []
        for i in range(min(size // 20, 4096)):
            desc = self.unpack("IIIII", self.offset(rva + i * 20, 20))
            if not any(desc):
                return result
            original_thunk, _, _, name_rva, first_thunk = desc
            library = self.cstring(name_rva)
            symbols = []
            thunk = original_thunk or first_thunk
            width = self.bits // 8
            for j in range(65536):
                value = self.unpack("I" if width == 4 else "Q",
                                    self.offset(thunk + j * width, width))[0]
                if value == 0:
                    break
                if value & (1 << (self.bits - 1)):
                    symbols.append({"ordinal": value & 0xFFFF})
                else:
                    symbols.append({"name": self.cstring(value + 2),
                                    "hint": self.unpack("H", self.offset(value, 2))[0]})
            else:
                raise PEError("Import thunk table has no terminator")
            result.append({"library": library, "symbols": symbols})
        raise PEError("Import descriptor table has no terminator within its directory")

    def exports(self) -> dict[str, Any] | None:
        rva, size = self.directory(0)
        if not rva or not size:
            return None
        values = self.unpack("IIHHIIIIIII", self.offset(rva, 40))
        _, _, _, _, name_rva, base, functions, count, addresses, names, ordinals = values
        if functions > 1000000 or count > functions:
            raise PEError("Invalid export table size")
        symbols = []
        named = {}
        for i in range(count):
            name = self.cstring(self.unpack("I", self.offset(names + 4 * i, 4))[0])
            ordinal = self.unpack("H", self.offset(ordinals + 2 * i, 2))[0]
            if ordinal >= functions:
                raise PEError("Export ordinal exceeds address table")
            named[ordinal] = name
        for i in range(functions):
            address = self.unpack("I", self.offset(addresses + 4 * i, 4))[0]
            if not address:
                continue
            symbol = {"ordinal": base + i, "rva": address}
            if i in named:
                symbol["name"] = named[i]
            if rva <= address < rva + size:
                symbol["forwarder"] = self.cstring(address)
            symbols.append(symbol)
        return {"library": self.cstring(name_rva), "symbols": symbols}

    def versions(self) -> list[dict[str, Any]]:
        resource_rva, resource_size = self.directory(2)
        if not resource_rva or not resource_size:
            return []

        def resource_offset(relative: int, length: int) -> int:
            if relative < 0 or relative + length > resource_size:
                raise PEError("Resource directory access out of bounds")
            return self.offset(resource_rva + relative, length)

        def entries(relative: int):
            at = resource_offset(relative, 16)
            named, ids = self.unpack("HH", at + 12)
            if named + ids > 65536:
                raise PEError("Unreasonable resource directory entry count")
            for i in range(named + ids):
                yield self.unpack("II", resource_offset(relative + 16 + i * 8, 8))

        versions = []
        for identifier, child in entries(0):
            if identifier != 16 or not child & 0x80000000:
                continue
            for _, language_directory in entries(child & 0x7FFFFFFF):
                if not language_directory & 0x80000000:
                    continue
                for language, leaf in entries(language_directory & 0x7FFFFFFF):
                    if leaf & 0x80000000:
                        raise PEError("Unexpected resource depth")
                    data_rva, length, _, _ = self.unpack("IIII", resource_offset(leaf, 16))
                    blob = self.slice(self.offset(data_rva, length), length)
                    value = parse_version_info(blob)
                    value["language_id"] = language
                    versions.append(value)
        return versions

    def describe(self) -> dict[str, Any]:
        return {"format": f"PE{self.bits}", "machine": self.machine,
                "machine_name": {0x14C: "i386", 0x8664: "x86_64"}.get(self.machine, "unknown"),
                "image_base": self.image_base, "entrypoint_rva": self.entry_rva,
                "entrypoint_va": self.image_base + self.entry_rva,
                "image_size": self.image_size, "timestamp": self.timestamp,
                "subsystem": self.subsystem, "characteristics": self.characteristics,
                "sections": self.sections, "versions": self.versions(),
                "imports": self.imports(), "exports": self.exports(),
                "has_tls_directory": bool(self.directory(9)[0]),
                "has_delay_imports": bool(self.directory(13)[0])}


def parse_version_info(blob: bytes) -> dict[str, Any]:
    """Read VS_VERSIONINFO, including fixed file/product versions and strings."""
    result: dict[str, Any] = {"strings": {}}

    def walk(start: int, limit: int, depth: int = 0):
        if depth > 8 or start + 6 > limit:
            raise PEError("Invalid VERSIONINFO node")
        length, value_length, kind = struct.unpack_from("<HHH", blob, start)
        end = start + length
        if length < 6 or end > limit:
            raise PEError("VERSIONINFO node exceeds its parent")
        cursor = start + 6
        key_start = cursor
        while cursor + 2 <= end and blob[cursor:cursor + 2] != b"\0\0":
            cursor += 2
        if cursor + 2 > end:
            raise PEError("Unterminated VERSIONINFO key")
        key = blob[key_start:cursor].decode("utf-16le", "replace")
        cursor = (cursor + 2 + 3) & ~3
        byte_length = value_length * 2 if kind == 1 else value_length
        if cursor + byte_length > end:
            raise PEError("VERSIONINFO value exceeds its node")
        value = blob[cursor:cursor + byte_length]
        if key == "VS_VERSION_INFO" and len(value) >= 52:
            fixed = struct.unpack_from("<13I", value)
            if fixed[0] != 0xFEEF04BD:
                raise PEError("Invalid VS_FIXEDFILEINFO signature")
            for name, high, low in (("file_version", fixed[2], fixed[3]),
                                    ("product_version", fixed[4], fixed[5])):
                result[name] = ".".join(map(str, (high >> 16, high & 65535,
                                                low >> 16, low & 65535)))
        elif kind == 1 and value:
            result["strings"][key] = value.decode("utf-16le", "replace").rstrip("\0")
        cursor = (cursor + byte_length + 3) & ~3
        while cursor + 6 <= end:
            child_length = struct.unpack_from("<H", blob, cursor)[0]
            if not child_length:
                break
            walk(cursor, end, depth + 1)
            cursor = (cursor + child_length + 3) & ~3

    walk(0, len(blob))
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_installation(root: Path) -> dict[str, Any]:
    root = root.resolve(strict=True)
    binaries, assets, maps = [], [], []
    for path in sorted(root.rglob("*"), key=lambda p: str(p).casefold()):
        if path.is_symlink():
            raise ValueError(f"Installation contains a symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if path.suffix.lower() in {".exe", ".dll", ".asi", ".ax", ".flt", ".m3d"}:
            entry = {"path": relative, "size": path.stat().st_size, "sha256": sha256_file(path)}
            try:
                entry.update(PE(path.read_bytes()).describe())
            except (PEError, struct.error) as exc:
                entry["error"] = str(exc)
            binaries.append(entry)
        elif path.suffix.lower() == ".mpq":
            assets.append({"path": relative, "size": path.stat().st_size,
                           "sha256": sha256_file(path)})
        elif path.suffix.lower() in {".w3x", ".w3m", ".w3n"}:
            maps.append({"path": relative, "size": path.stat().st_size,
                         "sha256": sha256_file(path)})
    local = {Path(item["path"]).name.casefold() for item in binaries}
    for binary in binaries:
        for imported in binary.get("imports", []):
            imported["present_in_installation"] = imported["library"].casefold() in local
    core = next((b for b in binaries if b["path"].casefold() == "game.dll"), None)
    return {"schema_version": 1, "installation": str(root),
            "game_version": core.get("versions", []) if core else [],
            "binaries": binaries, "archives": assets, "loose_maps": maps,
            "limitations": ["No game binary was executed.",
                            "MPQ archives were hashed, not unpacked; embedded maps are not listed.",
                            "Import tables do not enumerate dynamically resolved APIs or delay imports.",
                            "This inventory does not establish WebAssembly compatibility."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game", type=Path, nargs="?", default=Path("var/game"))
    parser.add_argument("--output", type=Path, default=Path("var/reports/game.json"))
    args = parser.parse_args()
    report = inspect_installation(args.game)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Inspected {len(report['binaries'])} binaries; report: {args.output}")
    for version in report["game_version"]:
        print(f"game.dll file version: {version.get('file_version', 'unknown')}")


if __name__ == "__main__":
    main()
