#!/usr/bin/env python3
"""Select a server custom map in Warcraft's own menu and start a single game.

The browser's map catalog is narrowed to the requested file so unrelated
maps cannot fail while navigating. Map bytes, the runtime and game UI are
unmodified. Requires privately prepared game/runtime files and Playwright;
screenshots and reports stay in var/. This is a short loading regression,
not verification of every trigger or a complete match.
"""
import argparse
import json
from pathlib import Path
import time

from playwright.sync_api import sync_playwright


def main(args):
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        launch = {'args': ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                           '--autoplay-policy=no-user-gesture-required']} if args.browser == 'chromium' else {}
        browser = getattr(p, args.browser).launch(**launch)
        context = browser.new_context(viewport={'width': 1024, 'height': 768})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            catalog = context.request.get(args.url + '/api/maps').json()
            selected = [item for item in catalog['maps'] if item['path'] == args.map]
            assert len(selected) == 1, f'Map not found: {args.map}'
            assert args.map.startswith('Custom/') and args.map.count('/') == 1
            context.route('**/api/maps', lambda route: route.fulfill(json={**catalog, 'maps': selected}))
            page.goto(args.url)
            page.evaluate('''async ({language,compat})=>{
              const status=await (await fetch('/api/status')).json();
              const module=await import(status.runtime.moduleUrl);
              const {SaveStore}=await import('/src/storage.mjs');
              const canvas=document.createElement('canvas');canvas.id='game-probe';canvas.width=1024;canvas.height=768;
              canvas.style='position:fixed;inset:0;width:1024px;height:768px;z-index:10;background:black';
              document.body.append(canvas);
              window.probe={frame:null,report:null,log:[],sceneFrames:0};
              window.session=await module.runDiagnostics({canvas,saves:new SaveStore(),language,
                wasmUrl:compat?status.runtime.compatWasmUrl:status.runtime.wasmUrl,
                resolution:{width:1024,height:768},audioEnabled:false,timeout:0,dispatchBudget:0,
                onStatus:m=>probe.log.push(m),onReport:r=>probe.report=r,
                onFrame:f=>{
                  const last=probe.frame,delta=f.frames-(last?.rendererFrames||0);
                  probe.sceneFrames=last&&delta>0&&(f.draws-last.draws)/delta>200?probe.sceneFrames+delta:0;
                  probe.frame={...f,rendererFrames:f.frames,frames:(last?.frames||0)+1};
                }});
            }''', {'language': args.language, 'compat': args.compat})

            def wait(expression, stopping=False, continue_loading=False):
                deadline = time.monotonic() + args.timeout
                progress = time.monotonic() + 30
                next_key = time.monotonic() + 1
                while not page.evaluate(expression):
                    report = page.evaluate('probe.report')
                    if report and not stopping:
                        raise RuntimeError(json.dumps(report.get('error')))
                    if time.monotonic() > deadline:
                        raise TimeoutError(expression)
                    if time.monotonic() > progress:
                        print(json.dumps({'waiting': expression, 'frame': page.evaluate('probe.frame')}), flush=True)
                        page.screenshot(path=str(args.output / 'progress.png'))
                        progress = time.monotonic() + 30
                    if continue_loading and time.monotonic() > next_key:
                        # Warcraft waits for "Press any key to continue" at
                        # the end of a single-player custom-map load.
                        page.locator('#game-probe').press('Space', delay=100)
                        next_key = time.monotonic() + 1
                    page.wait_for_timeout(100)
                if not stopping:
                    assert not page.evaluate('probe.report'), page.evaluate('probe.report.error')

            def frames(count):
                start = page.evaluate('probe.frame?.frames||0')
                wait(f'(probe.frame?.frames||0)>={start+count}')

            def click(x, y):
                page.mouse.move(x, y); frames(2)
                page.mouse.down(); frames(2); page.mouse.up()
                frames(10); page.wait_for_timeout(2000)

            wait('[...document.querySelectorAll("video")].some(v=>v.currentTime>2)')
            page.locator('#game-probe').press('Escape')
            wait('!document.querySelector("video") && probe.frame?.frames>=10')
            page.wait_for_timeout(3000)
            click(875, 180)  # Single player, fresh profile.
            click(125, 275)
            page.locator('#game-probe').press_sequentially('MapTest', delay=100)
            click(324, 278)  # Create profile.
            click(875, 488)  # Custom game.
            click(300, 54)  # Custom folder; only the requested map is mounted.
            page.locator('#game-probe').press('Enter'); frames(20)
            click(300, 80)  # Reading the map's script used to exhaust the stack.
            frames(30)
            page.screenshot(path=str(args.output / 'map-preview.png'))
            print(json.dumps({'selected': args.map, 'variant': 'compat' if args.compat else 'standard'}), flush=True)
            menu_textures = page.evaluate('probe.frame.textures')
            click(875, 633)  # Start game.
            # The loading screen also renders frames (~11 draws/frame).
            # Wait for sustained world rendering, not just a moving load bar.
            wait(f'probe.sceneFrames>=30 && probe.frame.textures>{menu_textures+100}', continue_loading=True)
            page.screenshot(path=str(args.output / 'gameplay.png'))
            before = page.evaluate('probe.frame')
            page.wait_for_timeout(10000)
            frames(30)
            after = page.evaluate('probe.frame')
            page.screenshot(path=str(args.output / 'gameplay-after.png'))
            assert not errors, errors
            print(json.dumps({'map': args.map, 'framesDuringPlay': after['frames'] - before['frames'],
                              'drawsDuringPlay': after['draws'] - before['draws'], 'errors': errors}), flush=True)
        finally:
            try:
                if page.evaluate('!!window.probe'):
                    if page.evaluate('!!window.session && !probe.report'):
                        page.evaluate('session.finish()')
                        page.wait_for_function('!!probe.report', timeout=20000)
                    (args.output / 'report.json').write_text(json.dumps(page.evaluate('probe'), ensure_ascii=False, indent=2))
                    page.screenshot(path=str(args.output / 'final.png'))
            finally:
                browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--map', default='Custom/DotA v6.83d_RU.w3x')
    parser.add_argument('--language', choices=('ru', 'en'), default='en')
    parser.add_argument('--browser', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--compat', action='store_true')
    parser.add_argument('--timeout', type=int, default=240)
    parser.add_argument('--output', type=Path, default=Path('var/qa/custom-map'))
    main(parser.parse_args())
