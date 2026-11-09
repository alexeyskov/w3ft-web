#!/usr/bin/env python3
"""Admin login and targeted kick in a real browser; owns/cleans its local server.

Default: fixture games. --real-game additionally starts and stops the installed
Warcraft runtime in Chromium. No admin password or browser profile is retained.
"""
import argparse
import asyncio
from pathlib import Path
import runpy
import secrets
import sys
import tempfile

from aiohttp import web
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.admin_auth import password_hash
from server.app import ROOT, create_app

FIXTURE = '''
export async function runDiagnostics(options) {
  window.fixtureActive = true;
  let frames = 0;
  const timer = setInterval(() => options.onFrame({frames:++frames,width:800,height:600}), 20);
  return {async stop(){clearInterval(timer); window.fixtureActive=false;},
          async finish(){options.onReport({fixture:true});}, key(){}};
}
'''

# Before admin controls, pages sent no control version, ignored kick messages,
# and reconnected after every close. Keep those behaviors in this regression.
LEGACY_PRESENCE = '''
import {PresenceCounter as Current} from '/src/presence.mjs?legacy-base=1';
export class PresenceCounter extends Current {
  send() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(this.state)); }
  kick() {}
  connect() {
    window.legacyConnectAttempts = (window.legacyConnectAttempts || 0) + 1;
    super.connect();
    const closed = this.socket.onclose;
    this.socket.onclose = () => closed({});
  }
}
'''


async def main(browser_name, real_game):
    smoke = runpy.run_path(str(ROOT / 'tests/browser_smoke.py'))
    password = secrets.token_urlsafe(24)
    output = ROOT / 'var/qa/admin'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        options = {} if real_game else dict(game_dir=root / 'game', maps_dir=root / 'maps',
                                            runtime_dir=root / 'runtime', geoip_path=root / 'geoip')
        runner = web.AppRunner(create_app(**options, admin_password_hash=password_hash(password)))
        await runner.setup()
        try:
            site = web.TCPSite(runner, '127.0.0.1', 0)
            await site.start()
            base = f'http://127.0.0.1:{runner.addresses[0][1]}'
            print(f'Temporary admin test server: {base}', flush=True)
            async with async_playwright() as p:
                browser = await getattr(p, browser_name).launch()
                try:
                    errors = []
                    async def player(agent, fixture=FIXTURE, *, legacy=False):
                        context = await browser.new_context(user_agent=agent, locale='en-US')
                        page = await context.new_page()
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        await smoke['fixture_runtime'](page, fixture)
                        if legacy:
                            await page.route('**/src/presence.mjs', lambda route: route.fulfill(
                                status=200, content_type='text/javascript', body=LEGACY_PRESENCE))
                        await page.goto(base)
                        await smoke['wait_for'](page, '!document.getElementById("launch").disabled')
                        await page.locator('#tab-game').click()
                        await page.locator('#fullscreen-enabled').uncheck()
                        await page.locator('#launch').click()
                        return context, page

                    first_context, first = await player('QA first <img src=x onerror=alert(1)>')
                    second_context, second = await player('QA second')
                    await smoke['wait_for'](first, 'window.fixtureActive === true')
                    await smoke['wait_for'](second, 'window.fixtureActive === true')
                    context = await browser.new_context(locale='en-US', viewport={'width': 1200, 'height': 900})
                    admin = await context.new_page()
                    admin.on('pageerror', lambda error: errors.append(str(error)))
                    await admin.goto(base + '/admin')
                    await admin.locator('#login-panel').wait_for(state='visible')
                    assert await admin.locator('#dashboard').is_hidden()
                    await admin.locator('#password').fill('incorrect test password')
                    await admin.locator('#login-submit').click()
                    await smoke['wait_for'](admin, 'document.getElementById("message").textContent.includes("Incorrect")')
                    await admin.locator('#password').fill(password)
                    await admin.locator('#login-submit').click()
                    await admin.locator('#dashboard').wait_for(state='visible')
                    await smoke['wait_for'](admin, 'document.querySelectorAll(".session").length === 2')
                    assert await admin.locator('.session img').count() == 0, 'A visitor browser string became HTML'
                    assert await admin.locator('#password').input_value() == ''
                    await admin.screenshot(path=str(output / f'{browser_name}-sessions.png'), full_page=True)

                    async def kick(text):
                        card = admin.locator('.session').filter(has_text=text)
                        await card.locator('button').click()
                        assert text in await admin.locator('#kick-target').inner_text()
                        await admin.locator('#kick-confirm').click()
                        await admin.locator('#kick-dialog').wait_for(state='hidden')

                    await kick('QA first')
                    await first.locator('#game-view').wait_for(state='hidden')
                    assert await first.locator('#launch').is_disabled()
                    assert 'administrator' in await first.locator('#launch-message').inner_text()
                    assert await first.evaluate('fixtureActive') is False
                    assert await second.evaluate('fixtureActive') is True
                    await asyncio.sleep(1.5)  # automatic presence retry normally starts at one second
                    await admin.locator('#refresh').click()
                    await smoke['wait_for'](admin, 'document.querySelectorAll(".session").length === 1')
                    assert 'QA second' in await admin.locator('#sessions').inner_text()
                    # The kicked page cannot recreate a lobby through a still-open form.
                    await first.locator('#tab-online').click()
                    assert await first.locator('#create-lobby').is_disabled()
                    await first.reload()
                    await smoke['wait_for'](first, '!document.getElementById("launch").disabled')
                    assert await first.locator('#launch-message').is_hidden(), 'Reload starts a new session'

                    pending_context, pending = await player('QA pending download', '''
                      export function prepareGame(){
                        window.preparing = true;
                        let resolve;
                        return {done:new Promise(r=>{resolve=r}),cancel(){window.cancelled=true;resolve({cancelled:true,release(){}})}};
                      }
                      export async function runDiagnostics(){throw new Error('Cancelled startup must not run');}
                    ''')
                    await smoke['wait_for'](pending, 'window.preparing === true')
                    await admin.locator('#refresh').click()
                    await admin.locator('.session').filter(has_text='QA pending download').wait_for()
                    await kick('QA pending download')
                    await pending.locator('#game-view').wait_for(state='hidden')
                    assert await pending.evaluate('window.cancelled') is True
                    assert await pending.locator('#launch').is_disabled()
                    await pending_context.close()

                    legacy_context, legacy = await player('QA legacy launcher', legacy=True)
                    await smoke['wait_for'](legacy, 'window.fixtureActive === true')
                    cookies = await legacy_context.cookies()
                    cookie = next(cookie for cookie in cookies if cookie['name'] == 'w3ft_presence')
                    assert cookie['httpOnly'] and cookie['path'] == '/api/presence'
                    await admin.locator('#refresh').click()
                    legacy_card = admin.locator('.session').filter(has_text='QA legacy launcher')
                    await legacy_card.wait_for()
                    assert await legacy_card.locator('button').is_enabled()
                    await legacy_card.locator('button').click()
                    assert 'single-player game may keep running' in await admin.locator('#kick-hint').inner_text()
                    await admin.screenshot(path=str(output / f'{browser_name}-legacy-confirm.png'), full_page=True)
                    await admin.locator('#kick-confirm').click()
                    await admin.locator('#kick-dialog').wait_for(state='hidden')
                    assert 'Connection closed' in await admin.locator('#message').inner_text()
                    await smoke['wait_for'](legacy, 'window.legacyConnectAttempts >= 3')
                    await admin.locator('#refresh').click()
                    await smoke['wait_for'](admin, '!document.getElementById("sessions").textContent.includes("QA legacy launcher")')
                    assert await legacy.evaluate('fixtureActive'), 'A legacy game cannot be stopped remotely'
                    assert await second.evaluate('fixtureActive'), 'Another visitor on the same IP must stay connected'
                    assert '1 in game' in await admin.locator('#counts').inner_text()
                    await legacy.unroute('**/src/presence.mjs')
                    await legacy.reload()
                    await smoke['wait_for'](legacy, '!document.getElementById("launch").disabled')
                    await admin.locator('#playing-only').uncheck()
                    await admin.locator('#refresh').click()
                    await legacy_card.wait_for()
                    assert 'Older launcher' not in await legacy_card.inner_text(), 'Reload must restore a current session'
                    await legacy_context.close()
                    await admin.locator('#playing-only').check()

                    for language in ('ru', 'en'):
                        await admin.locator('#admin-language').select_option(language)
                        await admin.set_viewport_size({'width': 390, 'height': 844})
                        assert await admin.evaluate('document.documentElement.scrollWidth <= innerWidth')
                        await admin.screenshot(path=str(output / f'{browser_name}-mobile-{language}.png'), full_page=True)
                    await admin.locator('#logout').click()
                    await admin.locator('#login-panel').wait_for(state='visible')
                    assert await admin.locator('.session').count() == 0
                    assert await admin.evaluate("fetch('/api/admin/sessions').then(r=>r.status)") == 401
                    await first_context.close()
                    await second_context.close()

                    if real_game:
                        game_context = await browser.new_context(locale='en-US', user_agent='QA original Warcraft')
                        game = await game_context.new_page()
                        game.on('pageerror', lambda error: errors.append(str(error)))
                        await game.goto(base)
                        await smoke['wait_for'](game, '!document.getElementById("launch").disabled')
                        await game.locator('#tab-game').click()
                        await game.locator('#fullscreen-enabled').uncheck()
                        await game.locator('#launch').click()
                        async with asyncio.timeout(180):
                            while not await game.evaluate('Number(document.getElementById("diagnostic-canvas").dataset.frames) > 5'):
                                if await game.locator('.cinematic-prompt button').count():
                                    await game.locator('.cinematic-prompt button').last.click()
                                elif await game.locator('video').count():
                                    await game.locator('#diagnostic-canvas').press('Escape')
                                if await game.locator('#game-view').is_hidden():
                                    raise AssertionError(await game.locator('#launch-message').inner_text())
                                await asyncio.sleep(0.2)
                        print('Original Warcraft is drawing frames; sending admin kick.', flush=True)
                        await admin.locator('#password').fill(password)
                        await admin.locator('#login-submit').click()
                        await admin.locator('.session').filter(has_text='QA original Warcraft').wait_for()
                        await kick('QA original Warcraft')
                        await game.locator('#game-view').wait_for(state='hidden', timeout=30000)
                        assert await game.locator('#launch').is_disabled()
                        (output / 'original-game.log').write_text(await game.evaluate("localStorage.getItem('wc3-last-log') || ''"))
                        await game.screenshot(path=str(output / 'original-game-kicked.png'), full_page=True)
                        await game_context.close()
                        print('Original Warcraft runtime stopped through admin panel.', flush=True)
                    await context.close()
                    assert not errors, errors
                    print(f'{browser_name}: login, current and legacy kicks, rejected legacy retries, reload, logout and RU/EN layout passed.', flush=True)
                except BaseException:
                    if 'game' in locals() and not game.is_closed():
                        (output / 'failure-game.log').write_text(await game.evaluate("localStorage.getItem('wc3-last-log') || ''"))
                    if 'admin' in locals() and not admin.is_closed():
                        await admin.screenshot(path=str(output / f'{browser_name}-failure.png'), full_page=True)
                    raise
                finally:
                    await browser.close()
        finally:
            await runner.cleanup()
            print('Test browsers and local server stopped.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--real-game', action='store_true')
    args = parser.parse_args()
    asyncio.run(main(args.browser, args.real_game))
