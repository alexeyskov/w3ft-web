#!/usr/bin/env python3
"""First and second launch of the original game through the site's Play button.

A fresh Chromium profile: before the game starts, the launcher downloads what
it reads up to the main menu (var/runtime/boot-<language>.json, make boot-set)
with a progress bar; the intro cinematic then plays from this device, and the
main menu opens right after it is skipped, without game data from the server.
The second launch in the same profile downloads almost nothing.
Needs the packaged runtime, the recorded set and a running server.
"""
import argparse
import asyncio
import json
from pathlib import Path
import tempfile
import time

from playwright.async_api import async_playwright

PROGRESS = '''() => {
  window.loadingSeen = [];
  // Registered after the site's own listener: the loading screen is already drawn.
  window.addEventListener('warcraft-session-progress', event => loadingSeen.push({...event.detail, at: performance.now(),
    bar: !document.getElementById('game-loading-bar').hidden, text: document.getElementById('game-loading-detail').textContent}));
}'''


async def launch(page, output, label, timeout):
    """Play → loading screen → cinematic → skip → main menu. Returns timings and traffic."""
    traffic = {'data': 0}

    def count(request):
        if '/api/assets/' in request.url or '/api/maps/' in request.url:
            asyncio.ensure_future(add(request))

    async def add(request):
        try:
            sizes = await request.sizes()
            traffic['data'] += sizes['responseBodySize']
        except Exception:
            pass

    async def until(expression, seconds=timeout):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if await page.evaluate(f'() => !!({expression})'):
                return
            assert await page.evaluate('document.body.dataset.phase') != 'error', await page.locator('#launch-message').inner_text()
            await asyncio.sleep(0.2)
        await page.screenshot(path=str(output / f'{label}-timeout.png'))
        raise TimeoutError(expression)

    await page.evaluate(PROGRESS)
    started = time.monotonic()
    await page.locator('#launch').click()
    await until('loadingSeen.some(p => p.phase === "download") && loadingSeen.at(-1).phase === "starting"', timeout)
    await until('[...document.querySelectorAll("#game-stage video")].some(v => v.currentTime > 1)')
    prepared = time.monotonic() - started
    source = await page.evaluate('[...document.querySelectorAll("#game-stage video")].map(v => v.currentSrc)[0]')
    page.on('request', count)
    await page.keyboard.press('Escape')
    skipped = time.monotonic()
    await until('!document.querySelector("#game-stage video") && +document.getElementById("diagnostic-canvas").dataset.frames > 0', 120)
    frames = int(await page.evaluate('document.getElementById("diagnostic-canvas").dataset.frames'))
    await until(f'+document.getElementById("diagnostic-canvas").dataset.frames > {frames + 30}', 120)
    menu = time.monotonic() - skipped
    await asyncio.sleep(2)
    await page.screenshot(path=str(output / f'{label}-menu.png'))
    page.remove_listener('request', count)
    downloads = [p for p in await page.evaluate('loadingSeen') if p['phase'] == 'download' and p['total'] > 0]
    bar_visible = bool(downloads) and all(p['bar'] for p in downloads)
    await page.locator('#stop-diagnostic').dispatch_event('click')
    await until('!document.getElementById("launch").disabled', 60)
    return {'progressTexts': [downloads[0]['text'], downloads[-1]['text']] if downloads else [], 'secondsToCinematic': round(prepared, 1), 'secondsMenuAfterSkip': round(menu, 1), 'barVisible': bar_visible,
            'cinematicSource': source.split(':')[0], 'downloadTotalMB': round(downloads[-1]['total'] / 1048576, 1) if downloads else 0,
            'downloadReached': round(downloads[-1]['done'] / downloads[-1]['total'], 3) if downloads else None,
            'gameDataAfterSkipMB': round(traffic['data'] / 1048576, 2)}


async def main(url, output, timeout, language):
    output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        # A fresh profile on disk, like a player's browser: its HTTP cache keeps
        # the WebAssembly module between launches.
        profile = tempfile.TemporaryDirectory()
        context = await playwright.chromium.launch_persistent_context(profile.name, viewport={'width': 1280, 'height': 900}, locale='ru-RU',
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(url)
            await page.wait_for_selector('#launch:not([disabled])', timeout=timeout * 1000)
            # A window, not fullscreen: Escape must reach the game, not leave fullscreen.
            await page.evaluate("language => { const s = JSON.parse(localStorage.getItem('wc3-launch-settings') || '{}'); s.fullscreen = false; localStorage.setItem('wc3-launch-settings', JSON.stringify(s)); localStorage.setItem('wc3-language', language); }", language)
            await page.reload()
            await page.wait_for_selector('#launch:not([disabled])', timeout=timeout * 1000)
            first = await launch(page, output, 'first', timeout)
            second = await launch(page, output, 'second', timeout)
            print(json.dumps({'first': first, 'second': second}), flush=True)
            assert first['barVisible'] and first['downloadReached'] == 1, first
            assert first['cinematicSource'] == 'blob', 'The intro cinematic must play from this device'
            assert first['gameDataAfterSkipMB'] < 1, f'The main menu still downloaded game data: {first}'
            assert first['secondsMenuAfterSkip'] < 5, first
            assert second['downloadTotalMB'] < 1, f'The second launch downloaded again: {second}'
            assert second['cinematicSource'] == 'blob' and second['gameDataAfterSkipMB'] < 1, second
            assert not errors, errors
        finally:
            await context.close()
            profile.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--output', type=Path, default=Path('var/reports/first-launch'))
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--language', default='ru', help='page and game language')
    args = parser.parse_args()
    asyncio.run(main(args.url, args.output, args.timeout, args.language))
