#!/usr/bin/env python3
"""Extract listed map/campaign members from the supplied game MPQs.

Uses mpyq 0.2.5 tables with a corrected sector reader; unsupported codecs/patches are reported
and never silently replaced by older archive contents. Existing files are never
overwritten. This does not reconstruct files absent from every (listfile).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import uuid


ARCHIVE_PRIORITY = ("War3Patch.mpq", "War3xLocal.mpq", "War3x.mpq", "war3.mpq")
EXTENSIONS = {".w3m", ".w3x", ".w3n"}
MAX_MAP_BYTES = 256 * 1024 * 1024


def safe_member_path(member: bytes | str) -> str:
    text = member.decode("utf-8") if isinstance(member, bytes) else member
    text = text.replace("\\", "/")
    parts = text.split("/")
    if (not text or any(part in ("", ".", "..") for part in parts)
            or ":" in text or "\0" in text
            or any(ord(c) < 32 for c in text)):
        raise ValueError("Unsafe MPQ member path")
    return PurePosixPath(*parts).as_posix()


def write_new_file(root: Path, relative: str, data: bytes) -> bool:
    """Install bytes exclusively, rejecting symlinked output components."""
    parts = safe_member_path(relative).split("/")
    root.mkdir(parents=True, exist_ok=True)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, flags)
    temporary_name = None
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o755, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        temporary_name = ".extract-" + uuid.uuid4().hex
        descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_name, parts[-1], src_dir_fd=directory,
                    dst_dir_fd=directory, follow_symlinks=False)
        except FileExistsError:
            return False
        return True
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=directory)
            except FileNotFoundError:
                pass
        os.close(directory)


def _read_member(archive, member: bytes | str, limit: int = MAX_MAP_BYTES) -> bytes:
    entry = archive.get_hash_table_entry(member)
    if entry is None:
        raise ValueError("Member absent from archive hash table")
    if not 0 <= entry.block_table_index < len(archive.block_table):
        raise ValueError("Invalid archive block index")
    block = archive.block_table[entry.block_table_index]
    if not block.flags & 0x80000000 or block.flags & 0x02000000:
        raise ValueError("Member is marked deleted or absent")
    if block.flags & 0x00100000:
        raise NotImplementedError("MPQ patch streams require StormLib; mpyq cannot apply them")
    if block.flags & 0x00000100:
        raise NotImplementedError("PKWARE implode compression is not supported by mpyq")
    if block.flags & 0x00010000 and not getattr(archive, "supports_encryption", False):
        raise NotImplementedError("Encrypted MPQ members are not supported by mpyq")
    if block.size > limit or block.archived_size > limit:
        raise ValueError(f"Member exceeds extraction limit ({limit} bytes)")
    data = archive.read_file(member)
    if data is None or len(data) != block.size:
        raise ValueError("Decoded MPQ member size does not match its block table")
    return data


def extract_maps(game_dir: str | Path, output_dir: str | Path,
                 archive_factory=None) -> dict:
    if archive_factory is None:
        try:
            import mpyq  # noqa: F401 -- fail with a useful dependency message
            try:
                from tools.mpq_reader import MPQReader
            except ModuleNotFoundError:
                from mpq_reader import MPQReader
        except ImportError as error:
            raise RuntimeError("Install the project Python dependencies (mpyq==0.2.5)") from error
        archive_factory = MPQReader
    game_dir, output_dir = Path(game_dir), Path(output_dir)
    report = {"schemaVersion": 1, "priority": list(ARCHIVE_PRIORITY),
              "archives": [], "maps": [], "errors": [],
              "extracted": 0, "preserved": 0}
    archives = []
    candidates = {}
    try:
        for filename in ARCHIVE_PRIORITY:
            path = game_dir / filename
            item = {"name": filename, "status": "missing", "listedMaps": 0}
            report["archives"].append(item)
            if not path.is_file() or path.is_symlink():
                continue
            try:
                archive = archive_factory(str(path), listfile=False)
                archives.append((filename, archive))
                listing = _read_member(archive, b"(listfile)", limit=32 * 1024 * 1024)
                for member in listing.splitlines():
                    if not member:
                        continue
                    # Ignore non-map members without interpreting their paths.
                    if not member.lower().endswith((b".w3m", b".w3x", b".w3n")):
                        continue
                    relative = safe_member_path(member)
                    item["listedMaps"] += 1
                    # MPQ lookup is case-insensitive. First spelling is from
                    # the highest-priority listfile and is deterministic.
                    candidates.setdefault(relative.casefold(), (member, relative))
                item["status"] = "read"
            except Exception as error:
                item["status"] = "error"
                report["errors"].append({"archive": filename, "error": str(error)})

        for _, (member, relative) in sorted(candidates.items()):
            chosen = None
            # Probe every overlay, including ones that omit the member in
            # their listfile. Never fall back after a higher-priority failure.
            for archive_name, archive in archives:
                if archive.get_hash_table_entry(member) is not None:
                    chosen = (archive_name, archive)
                    break
            if chosen is None:
                report["errors"].append({"member": relative, "error": "No archive contains listed member"})
                continue
            archive_name, archive = chosen
            try:
                data = _read_member(archive, member)
                created = write_new_file(output_dir, relative, data)
                report["maps"].append({
                    "path": relative, "archive": archive_name,
                    "sourceSize": len(data),
                    "sourceSha256": hashlib.sha256(data).hexdigest(),
                    "status": "extracted" if created else "preserved-existing",
                })
                report["extracted" if created else "preserved"] += 1
            except Exception as error:
                report["errors"].append({"archive": archive_name, "member": relative,
                                         "error": str(error)})
    finally:
        for _, archive in archives:
            archive.file.close()
    report["candidateCount"] = len(candidates)
    report["complete"] = not report["errors"] and bool(archives)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", type=Path, default=Path("var/game"))
    parser.add_argument("--output", type=Path, default=Path("var/maps/Builtin"))
    parser.add_argument("--report", type=Path, default=Path("var/reports/maps-extraction.json"))
    args = parser.parse_args()
    try:
        report = extract_maps(args.game, args.output)
    except RuntimeError as error:
        parser.exit(2, str(error) + "\n")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    # Atomic report update; extraction itself never overwrites map files.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.report.parent,
                                     prefix=".maps-report-", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    temporary.replace(args.report)
    print(json.dumps({"extracted": report["extracted"], "preserved": report["preserved"],
                      "errors": len(report["errors"]), "report": str(args.report)},
                     ensure_ascii=False))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
