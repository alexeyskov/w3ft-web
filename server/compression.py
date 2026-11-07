"""gzip for whole-file downloads (HTTP Content-Encoding: gzip).

gzip is the encoding every browser decompresses itself, over HTTP and HTTPS,
so pages and workers receive the original bytes. Measured with level 9: the
WebAssembly runtime shrinks from 175 MB to 19 MB, game executables 2–3×,
scripts and pages about 3×. Game archives (MPQ), maps and cinematics are
compressed already (about 2% smaller) and are read in byte ranges: they are
sent as they are, as is every range request.

Each file version (device, inode, size, modification time) is compressed once,
in a thread, and kept in memory (the runtime, executables and scripts take
about 25 MB). Concurrent requests share one compression.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import os
from pathlib import Path
import zlib

COMPRESSIBLE = frozenset({".wasm", ".mjs", ".js", ".css", ".html", ".json", ".svg", ".txt", ".exe", ".dll"})
MIN_SIZE = 1024
MAX_SIZE = 512 * 1024 * 1024


def compressible(name, size):
    return Path(name).suffix.lower() in COMPRESSIBLE and MIN_SIZE <= size <= MAX_SIZE


def accepts_gzip(header):
    """Whether an Accept-Encoding value allows gzip (q > 0)."""
    gzip = wildcard = None
    for item in (header or "").split(","):
        name, *parameters = [part.strip() for part in item.split(";")]
        quality = 1.0
        for parameter in parameters:
            if parameter.lower().startswith("q="):
                try:
                    quality = float(parameter[2:])
                except ValueError:
                    quality = 0.0
        name = name.lower()
        if name in ("gzip", "x-gzip"):
            gzip = quality > 0
        elif name == "*":
            wildcard = quality > 0
    return gzip if gzip is not None else bool(wildcard)


class GzipCache:
    def __init__(self, limit=256 * 1024 * 1024, level=9):
        self.limit, self.level = limit, level
        self.entries: OrderedDict[tuple, bytes | None] = OrderedDict()
        self.pending: dict[tuple, asyncio.Future] = {}
        self.size = 0

    @staticmethod
    def key(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    def _compress(self, descriptor, size):
        try:
            compressor, parts, offset = zlib.compressobj(self.level, zlib.DEFLATED, 31), [], 0
            while offset < size:
                chunk = os.pread(descriptor, min(1 << 20, size - offset), offset)
                if not chunk:
                    raise OSError("File shrank while compressing")
                parts.append(compressor.compress(chunk))
                offset += len(chunk)
            parts.append(compressor.flush())
            data = b"".join(parts)
            # Already compressed data (a packed executable) is sent as it is.
            return data if len(data) < size * 0.9 else None
        finally:
            os.close(descriptor)

    def _store(self, key, task):
        self.pending.pop(key, None)
        if task.cancelled() or task.exception() is not None:
            return
        data = task.result()
        if data is not None and len(data) > self.limit:
            return
        self.entries[key] = data
        self.size += len(data or b"")
        while self.size > self.limit:
            _, old = self.entries.popitem(last=False)
            self.size -= len(old or b"")

    async def get(self, stream):
        """gzip bytes of an open file, or None when it does not compress."""
        info = os.fstat(stream.fileno())
        key = self.key(info)
        if key in self.entries:
            self.entries.move_to_end(key)
            return self.entries[key]
        task = self.pending.get(key)
        if task is None:
            # The compression owns a duplicate descriptor: the request that
            # started it may end (and close its file) first.
            descriptor = os.dup(stream.fileno())
            task = asyncio.ensure_future(asyncio.to_thread(self._compress, descriptor, info.st_size))
            self.pending[key] = task
            task.add_done_callback(lambda done, key=key: self._store(key, done))
        return await asyncio.shield(task)
