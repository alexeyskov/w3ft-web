#!/usr/bin/env python3
"""The original Warcraft on an emulated Android phone, by touch only.

Chromium emulates a phone held sideways (touch input, pointer: coarse). The
site's Play button launches the packaged runtime; after that only taps and
the device keyboard are used: startup skips the intro, a tap opens
Local Area Network, a tap selects the player name field and the on-screen
keyboard types a name; taps then start a match against the computer, where a
two-finger drag scrolls the camera and a pinch zooms. Each step is checked on
the rendered picture.
Real phones differ in speed and memory; this checks the touch input path.
"""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import time

from playwright.async_api import async_playwright

PHONE = dict(viewport={'width': 915, 'height': 412}, device_scale_factor=2.625, is_mobile=True, has_touch=True, locale='ru-RU',
             user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')
NAME_FIELD = (0.06, 0.165, 0.45, 0.195)  # inside the LAN player-name box, as fractions of the picture
STATS = '''async ([data, box]) => {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
  const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const [x0, y0, x1, y1] = [box[0] * image.width, box[1] * image.height, box[2] * image.width, box[3] * image.height].map(Math.round);
  const pixels = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let sum = 0, square = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const light = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    sum += light; square += light * light; count++;
  }
  const mean = sum / count;
  return {mean: Math.round(mean), deviation: Math.round(Math.sqrt(Math.max(0, square / count - mean * mean)))};
}'''
# Share of the picture that changed: pixels (of 160×120) whose luminance moved
# by more than 24 levels. Water and units animate a little on their own.
DIFFERENCE = '''async ([first, second]) => {
  const reduce = async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const canvas = new OffscreenCanvas(160, 120), context = canvas.getContext('2d');
    context.drawImage(await createImageBitmap(new Blob([bytes], {type: 'image/png'})), 0, 0, 160, 120);
    return context.getImageData(0, 0, 160, 120).data;
  };
  const [a, b] = [await reduce(first), await reduce(second)];
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs((a[i] + a[i + 1] + a[i + 2]) - (b[i] + b[i + 1] + b[i + 2])) / 3 > 24) changed++;
  return Math.round(changed / (a.length / 4) * 1000) / 1000;
}'''


async def main(url, output, timeout):
    output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        try:
            page = await (await browser.new_context(**PHONE)).new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))

            async def until(expression, seconds=timeout):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if await page.evaluate(f'() => !!({expression})'):
                        return
                    phase = await page.evaluate('document.body.dataset.phase')
                    assert phase != 'error', await page.locator('#launch-message').inner_text()
                    await asyncio.sleep(0.25)
                state = await page.evaluate('() => ({videos: [...document.querySelectorAll("#game-stage video")].map(v => [v.currentTime, v.paused, v.ended, getComputedStyle(v).display]), frames: document.getElementById("diagnostic-canvas").dataset.frames, phase: document.body.dataset.phase})')
                await page.screenshot(path=str(output / 'timeout.png'))
                raise TimeoutError(f'{expression}: {state}')

            async def picture(label):
                canvas = page.locator('#diagnostic-canvas')
                png = await canvas.screenshot()
                (output / f'{label}.png').write_bytes(png)
                return await page.evaluate(STATS, [base64.b64encode(png).decode(), NAME_FIELD])

            async def tap(x, y):  # fractions of the game picture
                box = await page.locator('#diagnostic-canvas').bounding_box()
                await page.touchscreen.tap(box['x'] + x * box['width'], box['y'] + y * box['height'])

            async def frame(label):
                png = await page.locator('#diagnostic-canvas').screenshot()
                (output / f'{label}.png').write_bytes(png)
                return base64.b64encode(png).decode()

            async def rendering(frames=20, seconds=120):
                # The first seconds of a match still load its data: wait until the
                # game draws continuously, or a still picture says nothing.
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    before = int(await page.evaluate('document.getElementById("diagnostic-canvas").dataset.frames'))
                    await asyncio.sleep(2)
                    if int(await page.evaluate('document.getElementById("diagnostic-canvas").dataset.frames')) - before >= frames:
                        return
                raise TimeoutError('The game does not draw new frames')

            cdp = await page.context.new_cdp_session(page)

            async def two_fingers(start, end, hold=1.0, steps=12):  # fractions of the picture, two points each
                box = await page.locator('#diagnostic-canvas').bounding_box()
                place = lambda points: [{'x': box['x'] + x * box['width'], 'y': box['y'] + y * box['height'], 'id': n + 1} for n, (x, y) in enumerate(points)]
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': place(start)})
                for step in range(1, steps + 1):
                    mix = [(a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps) for a, b in zip(start, end)]
                    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': place(mix)})
                    await asyncio.sleep(0.03)
                await asyncio.sleep(hold)
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})

            await page.goto(url)
            await until('!document.getElementById("launch").disabled')
            await page.locator('#launch').tap()
            assert await page.locator('#touch-controls').is_visible()
            await until('!document.querySelector("#game-stage video") && +document.getElementById("diagnostic-canvas").dataset.frames > 30', 60)
            await asyncio.sleep(3)  # the menu slides in
            menu = await picture('touch-menu')
            await tap(875 / 1024, 332 / 768)  # Local Area Network
            await asyncio.sleep(4)
            lan = await picture('touch-lan')
            assert lan['mean'] < menu['mean'] - 40, f'Local Area Network did not open: {menu} -> {lan}'
            await tap(230 / 1024, 138 / 768)  # player name field
            await asyncio.sleep(1)
            await page.locator('#touch-keyboard-button').tap()
            assert await page.evaluate('document.activeElement?.id') == 'touch-keyboard'
            await page.keyboard.insert_text('Mobile')
            await asyncio.sleep(2)
            named = await picture('touch-name')
            await page.screenshot(path=str(output / 'touch-screen.png'))
            # A match against the computer, by taps: Create Game, Create, a computer opponent, Start.
            for x, y, wait in ((398, 710, 5), (876, 649, 5), (165, 91, 2), (120, 164, 2), (878, 633, 45)):
                await tap(x / 1024, y / 768)
                await asyncio.sleep(wait)
            await rendering()
            still = [await frame('touch-match')]
            await asyncio.sleep(1.5)
            still.append(await frame('touch-match-still'))
            baseline = await page.evaluate(DIFFERENCE, still)
            # Fingers apart: the wheel turned forward, the camera zooms in on the base.
            await two_fingers([(0.45, 0.35), (0.55, 0.35)], [(0.25, 0.35), (0.75, 0.35)], hold=0.3)
            await asyncio.sleep(1.5)
            zoomed = await frame('touch-match-zoomed')
            zoom = await page.evaluate(DIFFERENCE, [still[1], zoomed])
            assert zoom > max(baseline * 3, 0.15), f'A pinch did not zoom: {baseline} vs {zoom}'
            await rendering()
            # Two fingers dragged to the left: the map follows them, the camera moves right.
            await two_fingers([(0.45, 0.35), (0.6, 0.35)], [(0.25, 0.35), (0.4, 0.35)])
            await asyncio.sleep(1)
            panned = await frame('touch-match-panned')
            scroll = await page.evaluate(DIFFERENCE, [zoomed, panned])
            assert scroll > max(baseline * 3, 0.15), f'Two fingers did not scroll the camera: {baseline} vs {scroll}'
            assert named['deviation'] > lan['deviation'] + 8, f'The typed name did not appear: {lan} -> {named}'
            # Leave as a phone user would: the exit key in fullscreen, then Close game.
            if await page.evaluate('!!document.fullscreenElement'):
                await page.locator('#touch-exit').tap()
                await until('!document.fullscreenElement', 10)
            await page.locator('#stop-diagnostic').tap()
            await until('!document.getElementById("launch").disabled', 60)
            assert not errors, errors
            result = {'passed': True, 'menu': menu, 'lan': lan, 'named': named, 'stillDifference': baseline,
                      'scrollDifference': scroll, 'zoomDifference': zoom, 'screenshots': str(output)}
            print(json.dumps(result), flush=True)
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--output', type=Path, default=Path('var/reports/touch'))
    parser.add_argument('--timeout', type=int, default=240, help='Seconds for the game to start')
    args = parser.parse_args()
    asyncio.run(main(args.url, args.output, args.timeout))
