#!/usr/bin/env python3
"""Safely unpack the supplied installation ZIP into a local game directory."""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile


MAX_UNCOMPRESSED_BYTES = 8 * 1024 ** 3
MAX_MEMBERS = 100000


def archive_plan(archive: zipfile.ZipFile, max_bytes: int = MAX_UNCOMPRESSED_BYTES):
    entries = archive.infolist()
    if len(entries) > MAX_MEMBERS:
        raise ValueError("Archive has too many members")
    if sum(entry.file_size for entry in entries) > max_bytes:
        raise ValueError("Archive exceeds the uncompressed size limit")
    paths = []
    for entry in entries:
        # ZIP paths use '/', but reject Windows traversal and drive-qualified paths too.
        name = entry.filename
        if "\\" in name or "\0" in name or name.startswith("/"):
            raise ValueError(f"Unsafe ZIP path: {name!r}")
        parts = name.rstrip("/").split("/")
        if not parts or any(part in {"", ".", ".."} or ":" in part for part in parts):
            raise ValueError(f"Unsafe ZIP path: {name!r}")
        mode = entry.external_attr >> 16
        file_type = stat.S_IFMT(mode)
        if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError(f"ZIP symlinks and special files are forbidden: {name!r}")
        if entry.flag_bits & 1:
            raise ValueError(f"Encrypted ZIP member is unsupported: {name!r}")
        paths.append((entry, parts))
    # Strip a single wrapping folder, preserving installations with files at their root.
    roots = {parts[0] for _, parts in paths}
    strip = (len(roots) == 1 and all(len(parts) > 1 or entry.is_dir()
                                   for entry, parts in paths))
    plan, seen, file_paths = [], set(), set()
    for entry, parts in paths:
        parts = parts[1:] if strip else parts
        if not parts:
            continue
        relative = PurePosixPath(*parts)
        key = relative.as_posix().casefold()
        if key in seen:
            raise ValueError(f"Duplicate or case-colliding ZIP path: {relative}")
        seen.add(key)
        if not entry.is_dir():
            file_paths.add(key)
        plan.append((entry, relative))
    for _, relative in plan:
        if any(parent.as_posix().casefold() in file_paths for parent in relative.parents
               if parent != PurePosixPath(".")):
            raise ValueError(f"A file is used as a ZIP directory: {relative}")
    return plan


def prepare_game(source: Path, destination: Path, max_bytes: int = MAX_UNCOMPRESSED_BYTES) -> Path:
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Destination already exists; refusing to overwrite: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve() / destination.name
    staging = None
    try:
        with zipfile.ZipFile(source) as archive:
            plan = archive_plan(archive, max_bytes)
            staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
            for entry, relative in plan:
                target = staging.joinpath(*relative.parts)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with archive.open(entry) as stream, target.open("xb") as output:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        written += len(chunk)
                        if written > entry.file_size:
                            raise ValueError(f"ZIP member exceeds its declared size: {entry.filename}")
                        output.write(chunk)
                if written != entry.file_size:
                    raise ValueError(f"ZIP member size mismatch: {entry.filename}")
                target.chmod(0o644)
        # This tool never modifies an already prepared installation.
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"Destination appeared during extraction: {destination}")
        staging.rename(destination)
        staging = None
        return destination
    finally:
        if staging is not None:
            shutil.rmtree(staging)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?", default=Path("resources/Warcraft_III.zip"))
    parser.add_argument("--destination", type=Path, default=Path("var/game"))
    parser.add_argument("--max-bytes", type=int, default=MAX_UNCOMPRESSED_BYTES)
    args = parser.parse_args()
    try:
        target = prepare_game(args.archive, args.destination, args.max_bytes)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"Preparation failed: {exc}\n")
    print(f"Game files prepared in {target}")
    print(f"Inspect with: python3 tools/inspect_game.py '{target}'")


if __name__ == "__main__":
    main()
