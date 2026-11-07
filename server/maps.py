"""Read-only Warcraft III map catalogue; no game assets are bundled here.

The optional HM3W pre-header is documented by the format researchers at:
https://213cy.github.io/war3map/W3M%20and%20W3X%20Files%20Format.html
Only its name, flags and advertised player count are read. A valid pre-header
does not prove that an MPQ, its scripts, or its game-version requirements work.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import threading
from typing import BinaryIO


MAP_EXTENSIONS = frozenset({".w3m", ".w3x", ".w3n"})
_ID = re.compile(r"^[0-9a-f]{64}$")
_COLOR = re.compile(r"\|c[0-9a-fA-F]{8}|\|r")


def map_id(relative_path: str) -> str:
    """Stable identity for a server-relative POSIX path, independent of bytes."""
    _parts(relative_path)
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()


def _parts(relative_path: str) -> tuple[str, ...]:
    path = PurePosixPath(relative_path)
    if (
        not relative_path
        or path.is_absolute()
        or "\\" in relative_path
        or "\x00" in relative_path
        or any(part in ("", ".", "..") for part in relative_path.split("/"))
        or ":" in relative_path
    ):
        raise ValueError("Invalid map path")
    return path.parts


def parse_map_header(data: bytes) -> dict:
    """Parse at most 512 bytes. Missing/broken headers remain explicit.

    maxPlayers is the header's advertised slot count, not a multiplayer or
    campaign classification. Campaign (.w3n) archives need not have HM3W.
    """
    result = {"name": None, "flags": None, "maxPlayers": None,
              "headerStatus": "missing"}
    if not data.startswith(b"HM3W"):
        return result
    result["headerStatus"] = "invalid"
    data = data[:512]
    if len(data) != 512:
        return result
    end = data.find(b"\x00", 8)
    if end < 8 or end + 9 > len(data):
        return result
    flags, players = struct.unpack_from("<II", data, end + 1)
    raw_name = data[8:end]
    # Warcraft III strings normally use UTF-8. Do not guess a local codepage:
    # replacement characters expose undecodable bytes without breaking JSON.
    name = raw_name.decode("utf-8", errors="replace")
    name = _COLOR.sub("", name).replace("|n", " ")
    name = "".join(c for c in name if c.isprintable()).strip()
    result.update(name=name or None, flags=flags, maxPlayers=players,
                  headerStatus="hm3w")
    return result


def _signature(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns)


class MapCatalog:
    """Catalogue regular map files below a configured, trusted directory.

    Directory symlinks, file symlinks, sockets and named pipes are excluded.
    open_map anchors traversal to a directory descriptor and uses O_NOFOLLOW
    for every component; callers should stream this handle for downloads.
    """

    def __init__(self, root: str | Path = "var/maps") -> None:
        self.root = Path(root).expanduser().absolute()
        self._cache: dict[str, tuple[tuple[int, ...], dict]] = {}
        self._index: dict[str, str] = {}
        self._lock = threading.RLock()

    def _open_relative(self, relative_path: str) -> BinaryIO:
        parts = _parts(relative_path)
        # Fail closed on platforms without descriptor-relative no-follow opens.
        if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
            raise OSError("Safe map downloads require POSIX dir_fd/O_NOFOLLOW")
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open(self.root, directory_flags)
        try:
            for part in parts[:-1]:
                child = os.open(part, directory_flags, dir_fd=directory)
                os.close(directory)
                directory = child
            # O_NONBLOCK avoids hanging if a file was replaced with a FIFO.
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW |
                                 os.O_NONBLOCK, dir_fd=directory)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise FileNotFoundError("Map is not a regular file")
                stream = os.fdopen(descriptor, "rb")
            except BaseException:
                os.close(descriptor)
                raise
            return stream
        finally:
            os.close(directory)

    def _inspect(self, relative_path: str) -> dict:
        with self._open_relative(relative_path) as stream:
            before = os.fstat(stream.fileno())
            signature = _signature(before)
            cached = self._cache.get(relative_path)
            if cached and cached[0] == signature:
                return dict(cached[1])
            header = stream.read(512)
            digest = hashlib.sha256(header)
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
            if signature != _signature(os.fstat(stream.fileno())):
                raise OSError("Map changed while it was being indexed")
        path = PurePosixPath(relative_path)
        identifier = map_id(relative_path)
        extension = path.suffix.lower()
        metadata = parse_map_header(header) if extension != ".w3n" else {
            "name": None, "flags": None, "maxPlayers": None,
            "headerStatus": "not-applicable",
        }
        metadata.update({
            "id": identifier,
            "path": relative_path,
            "name": metadata["name"] or path.stem,
            "kind": "campaign" if extension == ".w3n" else "map",
            "extension": extension,
            "size": before.st_size,
            "sha256": digest.hexdigest(),
            "downloadUrl": f"/api/maps/{identifier}/download",
        })
        self._cache[relative_path] = (signature, metadata)
        return dict(metadata)

    def list_maps(self) -> list[dict]:
        with self._lock:
            records = []
            # Do not follow a root changed into a symlink between requests.
            if self.root.is_symlink() or not self.root.is_dir():
                self._cache.clear()
                self._index.clear()
                return records
            for parent, directories, files in os.walk(self.root, followlinks=False):
                directories[:] = sorted(
                    name for name in directories
                    if not (Path(parent) / name).is_symlink()
                )
                for filename in sorted(files):
                    path = Path(parent) / filename
                    if path.suffix.lower() not in MAP_EXTENSIONS:
                        continue
                    relative = path.relative_to(self.root).as_posix()
                    try:
                        records.append(self._inspect(relative))
                    except (OSError, ValueError):
                        # Removed/modified/symlink entries cannot be advertised.
                        continue
            records.sort(key=lambda item: (item["path"].casefold(), item["path"]))
            self._index = {item["id"]: item["path"] for item in records}
            keep = set(self._index.values())
            self._cache = {key: value for key, value in self._cache.items()
                           if key in keep}
            return records

    def manifest(self) -> dict:
        maps = self.list_maps()
        return {"schemaVersion": 1, "count": len(maps), "maps": maps}

    def _lookup(self, identifier: str) -> str:
        if not isinstance(identifier, str) or not _ID.fullmatch(identifier):
            raise FileNotFoundError("Map not found")
        with self._lock:
            # Refresh also handles map additions, removals and rename changes.
            self.list_maps()
            relative = self._index.get(identifier)
            if relative is None:
                raise FileNotFoundError("Map not found")
            return relative

    def open_map(self, identifier: str) -> BinaryIO:
        """Open an indexed map without following any symlinks; caller closes it."""
        relative = self._lookup(identifier)
        try:
            return self._open_relative(relative)
        except OSError as error:
            raise FileNotFoundError("Map not found") from error

    def resolve_map(self, identifier: str) -> Path:
        """Return the checked path. Use open_map for race-safe HTTP streaming."""
        relative = self._lookup(identifier)
        try:
            with self._open_relative(relative):
                pass
        except OSError as error:
            raise FileNotFoundError("Map not found") from error
        return self.root.joinpath(*_parts(relative))
