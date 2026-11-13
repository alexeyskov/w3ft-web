#!/usr/bin/env python3
"""Record what the game reads up to its main menu, for each game language.

The launcher downloads this set before a launch, with progress (client.mjs
prepareGame), so the main menu opens without loading block by block from the
server. Startup intros and background caching are disabled while recording.
A fresh Chromium profile runs the
packaged runtime to the main menu with the launcher's default settings; the
game data stored on the way (game-cache.mjs)
are written to var/runtime/boot-<language>.json: files read whole (the
executables) and the 256 KiB blocks read from the archives.
Map headers come with the map catalog and are not part of the set.

Needs the packaged runtime (make runtime) and Playwright with Chromium. The
tool starts its own server unless --url names one. Record again after
changing the game files or the runtime; a stale set only loads slower.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import datetime
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
BLOCK = 256 * 1024
# The launcher's defaults (web/src/app.mjs): resolution and Warcraft's Video options.
RESOLUTION = {"width": 1280, "height": 960}
GRAPHICS = {"gamma": 30, "modeldetail": 2, "animquality": 2, "texquality": 2, "particles": 2,
            "lights": 2, "unitshadows": 1, "occlusion": 1, "spellfilter": 2}
BOOT = r'''async ({language, resolution, graphicsSettings}) => {
  const status = await (await fetch('/api/status')).json();
  if (!status.runtime.installed) throw new Error('The runtime is not packaged (make runtime)');
  const module = await import(status.runtime.moduleUrl);
  const canvas = document.createElement('canvas');
  canvas.width = resolution.width; canvas.height = resolution.height;
  canvas.style = 'position:fixed;inset:0;width:1024px;height:768px;z-index:10;background:black';
  document.body.append(canvas);
  window.probe = {frames: 0, report: null};
  window.session = await module.runDiagnostics({canvas, wasmUrl: status.runtime.wasmUrl, resolution, graphicsSettings, language,
    audioEnabled: false, timeout: 0, dispatchBudget: 0, backgroundCache: false, skipIntro: true,
    onReport: report => probe.report = report, onFrame: frame => probe.frames = frame.frames});
}'''
INDEX = r'''async () => {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('game-data');
  return JSON.parse(await (await (await directory.getFileHandle('index.json')).getFile()).text()).files;
}'''


def cache_key(kind, identifier, version):
    # web/runtime/game-cache.mjs cacheKey()
    return re.sub(r"[^A-Za-z0-9_-]", "_", f"{kind}-{str(identifier)[:32]}-{str(version)[:16]}")


def ranges(blocks):
    result = []
    for block in blocks:
        if result and result[-1][1] == block - 1:
            result[-1][1] = block
        else:
            result.append([block, block])
    return result


async def record(browser, url, language, timeout):
    context = await browser.new_context(viewport={"width": 1024, "height": 768})
    page = await context.new_page()
    media = []
    page.on("request", lambda request: media.append(request.url) if request.resource_type == "media" else None)
    await page.goto(url)
    started = time.monotonic()
    await page.evaluate(BOOT, {"language": language, "resolution": RESOLUTION, "graphicsSettings": GRAPHICS})

    async def until(expression, seconds, stopping=False):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = await page.evaluate(f"() => ({{done: !!({expression}), error: window.probe?.report?.error?.message || null}})")
            if state["error"] and not stopping:
                raise RuntimeError(f"{language}: the game stopped: {state['error']}")
            if state["done"]:
                return
            await asyncio.sleep(0.25)
        raise TimeoutError(f"{language}: {expression}")

    await until('!document.querySelector("video") && probe.frames > 30', timeout)
    menu = time.monotonic() - started
    await asyncio.sleep(10)  # the menu settles; it reads nothing more
    await page.evaluate("session.finish()")
    await until("!!probe.report", 60, stopping=True)
    index = await page.evaluate(INDEX)
    await context.close()
    return index, media, menu


def manifest(language, index, media, assets):
    by_key = {cache_key("a", f["id"], f["version"]): f for f in assets if f.get("version")}
    by_url = {f["downloadUrl"]: f for f in assets}
    files, total = [], 0
    for key, stored in sorted(index.items()):
        asset = by_key.get(key)
        if not asset:  # maps (their headers come with the catalog) or other versions
            continue
        count = (asset["size"] + BLOCK - 1) // BLOCK
        bits = base64.b64decode(stored["blocks"])
        blocks = [block for block in range(count) if block >> 3 < len(bits) and bits[block >> 3] >> (block & 7) & 1]
        if not blocks:
            continue
        entry = {"path": asset["path"], "size": asset["size"], "version": asset["version"]}
        if len(blocks) == count:
            entry["whole"] = True
        else:
            entry["blocks"] = ranges(blocks)
        files.append(entry)
        total += sum(min(BLOCK, asset["size"] - block * BLOCK) for block in blocks)
    cinematics = []
    for address in media:
        asset = by_url.get("/" + address.split("/", 3)[-1].split("?")[0])
        if asset and asset["path"] not in cinematics:
            cinematics.append(asset["path"])
    return {"schemaVersion": 1, "language": language, "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "resolution": RESOLUTION, "files": files, "media": cinematics}, total


def free_port():
    with contextlib.closing(socket.socket()) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def read_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


@contextlib.contextmanager
def server(url):
    if url:
        yield url.rstrip("/")
        return
    port = free_port()
    process = subprocess.Popen([sys.executable, "-m", "server.app", "--port", str(port)], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    address = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                read_json(address + "/api/status")
                break
            except OSError:
                time.sleep(0.2)
        yield address
    finally:
        process.terminate()
        process.wait(timeout=20)


async def main(args):
    with server(args.url) as url:
        status = read_json(url + "/api/status")
        if not status["runtime"].get("installed"):
            raise SystemExit("The runtime is not packaged: run make runtime first")
        languages = args.languages or status["game"]["languages"]
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                                                             "--autoplay-policy=no-user-gesture-required"])
            try:
                for language in languages:
                    index, media, menu = await record(browser, url, language, args.timeout)
                    assets = read_json(f"{url}/api/assets?language={language}")["files"]
                    data, total = manifest(language, index, media, assets)
                    target = args.output_dir / f"boot-{language}.json"
                    temporary = target.with_suffix(".partial")
                    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
                    os.replace(temporary, target)
                    print(f"{target}: {len(data['files'])} files, {total / 1048576:.1f} MB of game data, cinematic {', '.join(data['media']) or 'none'}; "
                          f"main menu after {menu:.0f} s", flush=True)
            finally:
                await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", help="a running server (default: start one)")
    parser.add_argument("--languages", nargs="*", help="default: every game language the server offers")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "var/runtime")
    parser.add_argument("--timeout", type=int, default=300, help="seconds for the cinematic and the menu to appear")
    asyncio.run(main(parser.parse_args()))
