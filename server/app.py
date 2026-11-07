"""Local server for the WC3 port: assets, maps and a room-scoped frame relay.

No route executes an EXE. A playable Warcraft WebAssembly runtime is not yet
implemented. /api/status makes that distinction explicit.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
from urllib.parse import quote

from aiohttp import web

from .compression import GzipCache, accepts_gzip, compressible
from .geoip import GeoLanguage
from .maps import MapCatalog
from .presence import Presence
from .relay import Relay

ROOT = Path(__file__).resolve().parents[1]
STATE = web.AppKey("state", dict)
SECURITY_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
        "style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; "
        "worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'self'",
}


def default_maps_dir():
    supplied = ROOT / "resources/Maps"
    return supplied if supplied.is_dir() else ROOT / "var/maps"


def read_report(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def runtime_status(root):
    """An extension contract, not an assertion that any game has been tested."""
    result = {"installed": False, "playableVerified": False,
              "reason": "Движок Warcraft III ещё не перенесён в WebAssembly.",
              "capabilities": {"campaign": False, "skirmish": False, "multiplayer": False}}
    manifest_path = root / "runtime.json"
    if not manifest_path.is_file():
        return result
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("abi") != "wc3-browser-v1":
            raise ValueError("Unsupported runtime ABI")
        for key, suffix in (("module", ".mjs"), ("wasm", ".wasm")):
            name = manifest[key]
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not name.endswith(suffix):
                raise ValueError("Invalid runtime file name")
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Runtime file missing")
        with (root / manifest["wasm"]).open("rb") as stream:
            if stream.read(8) != b"\0asm\x01\0\0\0":
                raise ValueError("Invalid WebAssembly module")
            # Uncompressed size: the launcher's progress for a gzip download.
            wasm_size = os.fstat(stream.fileno()).st_size
        capabilities = manifest.get("capabilities", {})
        if not isinstance(capabilities, dict):
            raise ValueError("Invalid runtime capabilities")
        result.update(installed=True, reason="Подключён внешний runtime; совместимость требует проверки.",
                      moduleUrl="/runtime/" + manifest["module"], wasmUrl="/runtime/" + manifest["wasm"], wasmSize=wasm_size,
                      capabilities={key: capabilities.get(key) is True for key in result["capabilities"]})
        result["diagnostics"] = manifest.get("diagnostics") is True
        result["graphics"] = manifest.get("graphics", "webgpu")
        if result["diagnostics"]:
            result["reason"] = "Доступен запуск оригинальной игры. Совместимость и производительность ещё проверяются."
    except (OSError, KeyError, TypeError, ValueError) as error:
        result["reason"] = "Runtime не загружен: " + str(error)
    return result


def game_summary(game, report):
    required = ("war3.exe", "game.dll", "Storm.dll", "Mss32.dll", "war3.mpq", "War3x.mpq", "War3Patch.mpq")
    names = {p.name.casefold() for p in game.iterdir() if p.is_file()} if game.is_dir() else set()
    missing = [name for name in required if name.casefold() not in names]
    versions = report.get("game_version", [])
    return {"prepared": not missing, "missing": missing,
            "version": versions[0].get("file_version") if versions else None,
            "binaries": [{"path": b["path"], "sha256": b["sha256"], "size": b["size"],
                          "importCount": sum(len(i["symbols"]) for i in b.get("imports", []))}
                         for b in report.get("binaries", []) if b["path"].casefold() in ("game.dll", "war3.exe")],
            "inspectionAvailable": bool(report)}


LOCALIZED_ARCHIVES = ("war3.mpq", "War3x.mpq", "War3xLocal.mpq", "War3Patch.mpq")


def game_languages(base_language, locales):
    """Base installation language first, then prepared localizations (tools/prepare_locale.py)."""
    languages = [base_language]
    if locales.is_dir():
        for directory in sorted(locales.iterdir()):
            names = {p.name.casefold() for p in directory.iterdir() if p.is_file()} if directory.is_dir() and not directory.is_symlink() else set()
            if (re.fullmatch(r"[a-z]{2}", directory.name) and directory.name != base_language and "locale.json" in names
                    and all(name.casefold() in names for name in LOCALIZED_ARCHIVES)):
                languages.append(directory.name)
    return languages


def localized_assets(game, locales, base_language, language):
    """Base installation files with the language's archives and cinematics in their place.

    A localization's files get IDs of their own, so both languages can be
    downloaded concurrently; the paths stay those of the base installation.
    """
    entries = asset_entries(game)
    if language == base_language:
        return entries
    if language not in game_languages(base_language, locales):
        raise ValueError("Unknown game language")
    merged = {entry["path"].casefold(): entry for entry in entries}
    for entry in asset_entries(locales / language, prefix=f"locales/{language}/"):
        if entry["path"].casefold() != "locale.json":
            merged[entry["path"].casefold()] = {**entry, "path": merged.get(entry["path"].casefold(), entry)["path"], "language": language}
    return list(merged.values())


def asset_entries(root, prefix=""):
    result = []
    if not root.is_dir():
        return result
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            relative = path.relative_to(root).as_posix()
            identifier = hashlib.sha256((prefix + relative).encode()).hexdigest()
            # Browsers keep downloaded game data per version: a replaced file
            # (other size or modification time) is downloaded again.
            version = hashlib.sha256(f"{info.st_size}:{info.st_mtime_ns}".encode()).hexdigest()[:16]
            result.append({"id": identifier, "path": relative, "size": info.st_size, "version": version,
                           "downloadUrl": f"/api/assets/{identifier}"})
    return result


def byte_range(value, size):
    if value is None:
        return (0, size - 1, 200)
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or size == 0 or not any(match.groups()):
        raise ValueError("Invalid byte range")
    first, last = match.groups()
    if first:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
        if start >= size or end < start:
            raise ValueError("Unsatisfiable byte range")
    else:
        length = int(last)
        if not length:
            raise ValueError("Invalid suffix length")
        start, end = max(0, size - length), size - 1
    return start, end, 206


async def stream_file(request, stream, name, *, etag=None, attachment=False):
    # The already-open descriptor prevents path replacement during streaming.
    try:
        size = os.fstat(stream.fileno()).st_size
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
        identity_etag = '"' + etag + '"' if etag else None
        try:
            requested_range = request.headers.get("Range")
            # Without a matching strong validator, a resumed request must get
            # the whole current file rather than concatenate different versions.
            if "If-Range" in request.headers and request.headers["If-Range"] != identity_etag:
                requested_range = None
            start, end, status = byte_range(requested_range, size)
        except ValueError:
            return web.Response(status=416, headers={"Content-Range": f"bytes */{size}"})
        # A whole compressible file goes gzip-encoded to browsers that accept
        # it (compression.py); ranges always refer to the original bytes.
        gzip_wanted = False
        if compressible(name, size):
            headers["Vary"] = "Accept-Encoding"
            gzip_wanted = status == 200 and accepts_gzip(request.headers.get("Accept-Encoding"))
        if etag:
            # Each encoding is its own representation with its own validator.
            headers["ETag"] = '"' + etag + ('-gzip"' if gzip_wanted else '"')
            if request.headers.get("If-None-Match") == headers["ETag"]:
                return web.Response(status=304, headers=headers)
        compressed = None
        if gzip_wanted:
            try:
                compressed = await request.app[STATE]["gzip"].get(stream)
            except OSError:
                compressed = None
            if compressed is not None:
                headers["Content-Encoding"] = "gzip"
            elif identity_etag:
                headers["ETag"] = identity_etag
        headers["Content-Length"] = str(len(compressed) if compressed is not None else max(0, end - start + 1))
        headers["Content-Type"] = {".wasm": "application/wasm", ".mjs": "text/javascript"}.get(
            Path(name).suffix, mimetypes.guess_type(name)[0] or "application/octet-stream")
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        if attachment:
            headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(Path(name).name)
        response = web.StreamResponse(status=status, headers=headers)
        try:
            await response.prepare(request)
            if request.method != "HEAD" and compressed is not None:
                view = memoryview(compressed)
                for offset in range(0, len(view), 256 * 1024):
                    await response.write(view[offset:offset + 256 * 1024])
            elif request.method != "HEAD":
                stream.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    block = await asyncio.to_thread(stream.read, min(256 * 1024, remaining))
                    if not block:
                        break
                    await response.write(block)
                    remaining -= len(block)
            await response.write_eof()
        except ConnectionError:
            # The browser dropped the download: a video element switching byte
            # ranges, a Worker stopped together with the game, a closed page.
            # That is normal; aiohttp treats the finished response as aborted.
            pass
        return response
    finally:
        stream.close()


async def status(request):
    state = request.app[STATE]
    report = await asyncio.to_thread(read_report, state["report"])
    languages = await asyncio.to_thread(game_languages, state["base_language"], state["locales"])
    return web.json_response({"schemaVersion": 1, "game": {**game_summary(state["game"], report), "languages": languages},
                              "runtime": runtime_status(state["runtime"]),
                              "transport": {"available": True, "protocol": "wc3-frame-relay-v1",
                                            "gameNetworkingImplemented": False,
                                            "connectedPeers": sum(len(r.peers) for r in state["relay"].rooms.values())},
                              "presence": state["presence"].counts()})


async def maps(request):
    return web.json_response(await asyncio.to_thread(request.app[STATE]["maps"].manifest))


async def download_map(request):
    catalog = request.app[STATE]["maps"]
    identifier = request.match_info["id"]
    try:
        path = await asyncio.to_thread(catalog.resolve_map, identifier)
        stream = await asyncio.to_thread(catalog.open_map, identifier)
    except (ValueError, KeyError, OSError):
        raise web.HTTPNotFound(text="Map not found")
    return await stream_file(request, stream, path.name, attachment=True)


async def assets(request):
    state = request.app[STATE]
    language = request.query.get("language", state["base_language"])
    try:
        files = await asyncio.to_thread(localized_assets, state["game"], state["locales"], state["base_language"], language)
    except ValueError:
        raise web.HTTPBadRequest(text="Unknown game language")
    return web.json_response({"files": files, "language": language})


async def download_asset(request):
    state = request.app[STATE]
    identifier = request.match_info["id"]

    def find():
        for language in game_languages(state["base_language"], state["locales"]):
            root = state["game"] if language == state["base_language"] else state["locales"] / language
            prefix = "" if language == state["base_language"] else f"locales/{language}/"
            for entry in asset_entries(root, prefix=prefix):
                if entry["id"] == identifier:
                    return root, entry
        return None, None
    root, entry = await asyncio.to_thread(find)
    if entry is None:
        raise web.HTTPNotFound(text="Asset not found")
    try:
        files = state["asset_files"] if root == state["game"] else MapCatalog(root)
        stream = await asyncio.to_thread(files._open_relative, entry["path"])
    except (OSError, ValueError):
        raise web.HTTPNotFound(text="Asset not found")
    return await stream_file(request, stream, entry["path"])


async def static_file(request):
    state = request.app[STATE]
    location = "runtime_files" if request.path.startswith("/runtime/") else "web_files"
    name = request.match_info.get("path", "") or "index.html"
    # Dotfiles and unknown source files are never a web route.
    if any(part.startswith(".") for part in name.split("/")):
        raise web.HTTPNotFound()
    try:
        stream = await asyncio.to_thread(state[location]._open_relative, name)
    except (OSError, ValueError):
        raise web.HTTPNotFound()
    # Revalidation instead of a new download (the runtime WASM is ~180 MB).
    info = os.fstat(stream.fileno())
    return await stream_file(request, stream, name, etag=f"{info.st_size:x}-{info.st_mtime_ns:x}")


async def compress_runtime(app):
    """Compress the WebAssembly runtime (about 10 s in a thread) when the
    server starts, so the first player already gets the 19 MB download."""
    state = app[STATE]
    status = runtime_status(state["runtime"])

    async def warm(name):
        try:
            stream = await asyncio.to_thread(state["runtime_files"]._open_relative, name)
        except (OSError, ValueError):
            return
        try:
            await state["gzip"].get(stream)
        except OSError:
            pass
        finally:
            stream.close()

    task = asyncio.create_task(warm(status["wasmUrl"].removeprefix("/runtime/"))) if status["installed"] else None
    yield
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def headers(request, response):
    response.headers.update(SECURITY_HEADERS)


def create_app(*, game_dir=None, maps_dir=None, runtime_dir=None, report_path=None, web_dir=None,
               locales_dir=None, base_language="ru", geoip_path=None):
    app = web.Application(client_max_size=1024 * 1024)
    game = Path(game_dir or ROOT / "var/game").absolute()
    runtime = Path(runtime_dir or ROOT / "var/runtime").absolute()
    relay, presence = Relay(), Presence()
    geo = GeoLanguage(geoip_path or ROOT / "var/geoip/dbip-country-lite.csv.gz")
    app[STATE] = {"game": game, "maps": MapCatalog(maps_dir or default_maps_dir()),
                  "runtime": runtime, "report": Path(report_path or ROOT / "var/reports/game.json"),
                  "relay": relay, "presence": presence, "geo": geo, "gzip": GzipCache(), "asset_files": MapCatalog(game),
                  "locales": Path(locales_dir or ROOT / "var/locales").absolute(), "base_language": base_language,
                  "runtime_files": MapCatalog(runtime), "web_files": MapCatalog(web_dir or ROOT / "web")}
    app.on_response_prepare.append(headers)
    app.cleanup_ctx.append(geo.watch)
    app.cleanup_ctx.append(compress_runtime)
    app.on_shutdown.append(relay.shutdown)
    app.on_shutdown.append(presence.shutdown)
    app.router.add_get("/api/status", status)
    app.router.add_get("/api/maps", maps)
    app.router.add_get("/api/maps/{id}/download", download_map)
    app.router.add_get("/api/assets", assets)
    app.router.add_get("/api/assets/{id}", download_asset)
    app.router.add_get("/api/lobbies", relay.list_lobbies)
    app.router.add_post("/api/lobbies", relay.create_lobby)
    app.router.add_get("/api/relay/{room}", relay.connect)
    app.router.add_get("/api/presence", presence.connect)
    app.router.add_get("/api/locale", geo.handler)
    app.router.add_get("/runtime/{path:.*}", static_file)
    app.router.add_get("/{path:.*}", static_file)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--game-dir", type=Path, default=ROOT / "var/game")
    parser.add_argument("--maps-dir", type=Path, default=default_maps_dir())
    parser.add_argument("--runtime-dir", type=Path, default=ROOT / "var/runtime")
    parser.add_argument("--report-path", type=Path, default=ROOT / "var/reports/game.json")
    parser.add_argument("--locales-dir", type=Path, default=ROOT / "var/locales",
                        help="Other game languages prepared by tools/prepare_locale.py")
    parser.add_argument("--base-language", default="ru", help="Language of the base installation")
    parser.add_argument("--geoip", type=Path, default=ROOT / "var/geoip/dbip-country-lite.csv.gz",
                        help="DB-IP country database from tools/fetch_geoip.py: default page language")
    args = parser.parse_args()
    web.run_app(create_app(game_dir=args.game_dir, maps_dir=args.maps_dir,
                           runtime_dir=args.runtime_dir, report_path=args.report_path,
                           locales_dir=args.locales_dir, base_language=args.base_language,
                           geoip_path=args.geoip),
                host=args.host, port=args.port)


if __name__ == "__main__":
    main()
