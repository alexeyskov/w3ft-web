#!/usr/bin/env python3
"""Browser integration checks against an already running local server.

Run: python3 tests/browser_smoke.py --url http://127.0.0.1:8080
Requires Playwright and its Chromium browser. Game-launch tests use an explicit
mock runtime; passing these checks does not establish Warcraft compatibility.
"""
import argparse
import asyncio
import json
import time
from pathlib import Path

from playwright.async_api import async_playwright


async def wait_for(page, expression):
    # Evaluate via DevTools rather than injecting eval into a CSP-protected page.
    async with asyncio.timeout(30):
        while not await page.evaluate(expression):
            await asyncio.sleep(.05)


async def check_storage(page):
    result = await page.evaluate("""async () => {
      const {SaveStore} = await import('/src/storage.mjs');
      const store = new SaveStore();
      const db = await store.open();
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const rejects = async callback => { try { await callback(); return false; } catch { return true; } };
      const seed = (count, size = 0) => new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        const files = tx.objectStore('files'); files.clear();
        const data = new ArrayBuffer(size);
        for (let i = 0; i < count; i++) files.put({path: `save-${i}`, data, modified: 1});
      });
      const archive = async paths => {
        const value = new Uint8Array([7]);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), b => b.toString(16).padStart(2, '0')).join('');
        return JSON.stringify({format: 'wc3-web-saves-v1', files: paths.map(path => ({path, data: 'Bw==', sha256, modified: 1}))});
      };
      await seed(0);
      await store.write('Profiles/Test.w3v', new Uint8Array([1, 2, 3]));
      const exported = await store.export();
      await store.remove('Profiles/Test.w3v');
      await store.import(exported);
      check((await store.read('Profiles/Test.w3v')).join(',') === '1,2,3', 'Save roundtrip');
      check(await rejects(() => store.write('../escape', new Uint8Array())), 'Traversal rejected');
      const corrupt = JSON.parse(exported); corrupt.files[0].sha256 = 'bad';
      check(await rejects(() => store.import(JSON.stringify(corrupt))), 'Integrity check');
      check((await store.read('Profiles/Test.w3v'))[0] === 1, 'Corrupt import preserved data');
      await store.applyChanges({files:[{path:'Save/new.w3z',data:new Uint8Array([4,5])}],deleted:['Profiles/Test.w3v']});
      check(await store.read('Profiles/Test.w3v')===null&&(await store.read('Save/new.w3z')).join(',')==='4,5','Overlay replacement and deletion');
      check(await rejects(()=>store.applyChanges({files:[{path:'bad',data:new Uint8Array(32*1024*1024+1)}],deleted:['Save/new.w3z']})), 'Oversized overlay rejected');
      check((await store.read('Save/new.w3z')).join(',')==='4,5'&&await store.read('bad')===null,'Overlay deletion rolls back with failed replacement');

      await seed(4096);
      check(await rejects(() => store.write('extra', new Uint8Array([1]))), 'Write file-count quota');
      const countImport = await archive(['save-0', 'extra']);
      check(await rejects(() => store.import(countImport)), 'Import merged file-count quota');
      check((await store.read('save-0')).length === 0 && await store.read('extra') === null, 'Quota import atomicity');

      await seed(4095);
      const concurrent = await Promise.allSettled([
        store.write('concurrent-a', new Uint8Array([1])),
        store.write('concurrent-b', new Uint8Array([1])),
      ]);
      check(concurrent.filter(x => x.status === 'fulfilled').length === 1, 'Concurrent quota serialized');
      check((await store.list()).length === 4096, 'Concurrent file-count cap');

      await seed(4, 32 * 1024 * 1024);
      check(await rejects(() => store.write('extra', new Uint8Array([1]))), 'Write total-size quota');
      const sizeImport = await archive(['extra']);
      check(await rejects(() => store.import(sizeImport)), 'Import merged total-size quota');
      check(await store.read('extra') === null, 'No partial oversized import');
      await store.write('save-0', new Uint8Array([2]));
      await store.write('extra', new Uint8Array([3]));
      check((await store.read('extra'))[0] === 3, 'Replacing a file releases quota');
      await seed(0);
      return {roundtrip: true, integrity: true, countQuota: true, concurrentQuota: true, sizeQuota: true};
    }""")
    print("IndexedDB:", json.dumps(result))


async def check_default_language(browser, base):
    # Without a chosen language the page follows the visitor's country
    # (/api/locale), else the browser; a chosen language always wins.
    async def open_page(locale, country=None, hang=False):
        context = await browser.new_context(locale=locale)
        page = await context.new_page()
        if hang:
            await page.route('**/api/locale', lambda route: None)  # never answers
        elif country is not None:
            await page.route('**/api/locale', lambda route: route.fulfill(json={'language': country}))
        started = time.monotonic()
        await page.goto(base)
        await wait_for(page, '!document.documentElement.hasAttribute("data-pending-language")')
        return context, page, time.monotonic() - started

    context, page, _ = await open_page('en-US')
    assert await page.evaluate('document.documentElement.lang') == 'en', 'Unknown country: browser language'
    assert await page.locator('#launch').inner_text() == 'Play\nEnter'
    await context.close()
    context, page, _ = await open_page('en-US', 'ru')
    assert await page.evaluate('document.documentElement.lang') == 'ru', 'CIS country: Russian'
    assert await page.locator('#language').input_value() == 'ru'
    await page.locator('#language').select_option('en')
    await page.reload()
    await wait_for(page, '!document.documentElement.hasAttribute("data-pending-language")')
    assert await page.evaluate('document.documentElement.lang') == 'en', 'A chosen language wins over the country'
    await context.close()
    context, page, _ = await open_page('ru-RU', 'en')
    assert await page.evaluate('document.documentElement.lang') == 'en', 'Other countries: English'
    await context.close()
    context, page, elapsed = await open_page('ru-RU', hang=True)
    assert await page.evaluate('document.documentElement.lang') == 'ru' and elapsed < 4, 'A silent server must not hold the page'
    assert await page.locator('#launch').is_visible()
    await context.close()
    print('Default page language: country, browser fallback and chosen language passed')


async def check_loading_screen(browser, base):
    # The launcher downloads what the game needs first (runtime prepareGame),
    # with a progress bar, then starts it with the copies on this device.
    context = await browser.new_context(viewport={'width': 1280, 'height': 900}, locale='ru-RU')
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    async def status(route):
        response = await route.fetch()
        value = await response.json()
        value['runtime'].update(diagnostics=True, installed=True, moduleUrl='/runtime/loading-fixture.mjs', wasmSize=1000)
        value['game']['prepared'] = True
        await route.fulfill(json=value)
    await page.route('**/api/status', status)
    await page.route('**/runtime/loading-fixture.mjs', lambda route: route.fulfill(
        content_type='text/javascript', body='''
          // No Warcraft code runs: prepareGame waits for the test, runDiagnostics records its options.
          export function prepareGame(options) {
            window.fixturePrepare = options;
            let finish; const done = new Promise(resolve => finish = resolve);
            const result = cancelled => ({cancelled, media:new Map([['/api/assets/intro', 'blob:fixture']]), release(){ window.fixtureReleased = true; }});
            window.fixturePrepareFinish = () => finish(result(false));
            return {done, cancel(){ window.fixturePrepareCancelled = true; finish(result(true)); }};
          }
          export async function runDiagnostics(options) {
            window.fixtureOptions = options;
            options.onFrame({frames:1, width:options.resolution.width, height:options.resolution.height});
            return {async stop(){}, async finish(){ options.onReport({fixture:true}); }, key(){}};
          }
        '''))
    await page.goto(base)
    await wait_for(page, '!document.getElementById("launch").disabled')
    await page.locator('#launch').click()
    await wait_for(page, '!!window.fixturePrepare')
    assert await page.evaluate('fixturePrepare.wasmSize === 1000 && fixturePrepare.language === "ru"')
    assert await page.locator('#game-loading-title').inner_text() == 'Загрузка файлов игры'
    assert await page.locator('#game-loading-bar').is_hidden(), 'No bar before the sizes are known'
    await page.evaluate('fixturePrepare.onProgress({done: 10 * 1048576, total: 40 * 1048576})')
    assert await page.locator('#game-loading-bar').is_visible()
    assert await page.locator('#game-loading-detail').inner_text() == '10 из 40 МБ · 25%'
    assert await page.locator('#game-loading-bar').get_attribute('aria-valuenow') == '25'
    assert await page.evaluate('document.getElementById("game-loading-fill").style.width') == '25%'
    await page.evaluate('fixturePrepareFinish()')
    await wait_for(page, '!!window.fixtureOptions')
    assert await page.evaluate('fixtureOptions.media.get("/api/assets/intro") === "blob:fixture"'), 'The cinematic copy was not passed'
    assert await page.evaluate('fixtureOptions.audioContext instanceof AudioContext'), 'Sound must start from the Play click'
    await wait_for(page, 'document.getElementById("game-loading").hidden')
    await page.locator('#stop-diagnostic').dispatch_event('click')
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.evaluate('window.fixtureReleased === true && fixtureOptions.audioContext.state === "closed"'), 'The session must release its copies and sound'
    # Stop during the download: nothing starts.
    await page.evaluate('window.fixturePrepare = null; window.fixtureOptions = null')
    await page.locator('#launch').click()
    await wait_for(page, '!!window.fixturePrepare')
    await page.locator('#stop-diagnostic').dispatch_event('click')
    await wait_for(page, 'window.fixturePrepareCancelled === true && !document.getElementById("launch").disabled')
    assert await page.evaluate('window.fixtureOptions === null'), 'A cancelled download must not start the game'
    assert not errors, errors
    await context.close()
    print('Loading screen: download progress, local cinematic, sound from the click, cancellation passed')


async def check_touch_controls(browser, base):
    # An Android phone held sideways: Chromium with touch emulation (pointer: coarse).
    context = await browser.new_context(viewport={'width': 915, 'height': 412}, device_scale_factor=2.625, is_mobile=True, has_touch=True,
                                        locale='ru-RU', user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    async def status(route):
        response = await route.fetch()
        value = await response.json()
        value['runtime'].update(diagnostics=True, installed=True, moduleUrl='/runtime/touch-fixture.mjs')
        value['game']['prepared'] = True
        await route.fulfill(json=value)
    await page.route('**/api/status', status)
    await page.route('**/runtime/touch-fixture.mjs', lambda route: route.fulfill(
        content_type='text/javascript', body='''
          // The site's touch controls reach the runtime through key(); no Warcraft code runs.
          export async function runDiagnostics(options) {
            window.fixtureKeys=[];
            options.onFrame({frames:1,width:options.resolution.width,height:options.resolution.height});
            return {async stop(){window.fixtureStopped=true;}, async finish(){options.onReport({fixture:true});},
              key(type,{keyCode,text=''}){window.fixtureKeys.push([type,keyCode,text]);}};
          }
        '''))
    await page.goto(base)
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.evaluate('matchMedia("(pointer: coarse)").matches'), 'Touch emulation must make touch the primary input'
    await page.locator('#launch').tap()
    await wait_for(page, 'Array.isArray(window.fixtureKeys)')
    assert await page.locator('#touch-controls').is_visible(), 'A touch screen shows the on-screen keys'
    assert await page.locator('#rotate-hint').is_hidden(), 'Landscape needs no rotation hint'
    # The device keyboard: the hidden field takes the focus; its text reaches the game.
    await page.locator('#touch-keyboard-button').tap()
    assert await page.evaluate('document.activeElement?.id') == 'touch-keyboard'
    await page.keyboard.insert_text('Привет')
    await wait_for(page, 'fixtureKeys.filter(k => k[0] === "keydown").length >= 6')
    typed = await page.evaluate('fixtureKeys.filter(k => k[0] === "keydown").map(k => k[2]).join("")')
    assert typed == 'Привет', typed
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    downs = await page.evaluate('fixtureKeys.filter(k => k[0] === "keydown").slice(-2).map(k => k[1])')
    assert downs == [8, 13], downs
    await page.locator('#touch-keyboard-button').tap()
    assert await page.evaluate('document.activeElement?.id') != 'touch-keyboard', 'The keyboard button closes the keyboard again'
    await page.locator('#touch-escape').tap()
    assert await page.evaluate('fixtureKeys.slice(-2)') == [['keydown', 27, '\x1b'], ['keyup', 27, '']]
    if await page.evaluate('!!document.fullscreenElement'):
        assert await page.locator('#touch-exit').is_visible(), 'Fullscreen hides the toolbar: the touch keys offer a way out'
        await page.locator('#touch-exit').tap()
        await wait_for(page, '!document.fullscreenElement')
    assert await page.locator('#touch-exit').is_hidden() and await page.locator('#stop-diagnostic').is_visible()
    await page.set_viewport_size({'width': 412, 'height': 915})
    await wait_for(page, 'getComputedStyle(document.getElementById("rotate-hint")).display !== "none"')
    await page.evaluate("document.getElementById('stop-diagnostic').click()")
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert not errors, errors
    await context.close()
    print('Touch controls: on-screen keys, device keyboard bridge, rotation hint passed')


async def fixture_runtime(page, body, compat=False):
    """The site with a runtime module of the test's own: no Warcraft code runs.
    compat: whether the server has the build for browsers without tail calls."""
    async def status(route):
        response = await route.fetch()
        value = await response.json()
        value['runtime'].update(diagnostics=True, installed=True, moduleUrl='/runtime/notice-fixture.mjs',
                                wasmUrl='/runtime/wc3.wasm', wasmSize=1000)
        for key in ('compatWasmUrl', 'compatWasmSize'):
            value['runtime'].pop(key, None)
        if compat:
            value['runtime'].update(compatWasmUrl='/runtime/wc3-compat.wasm', compatWasmSize=2000)
        value['game']['prepared'] = True
        await route.fulfill(json=value)
    await page.route('**/api/status', status)
    await page.route('**/runtime/notice-fixture.mjs', lambda route: route.fulfill(content_type='text/javascript', body=body))


async def check_user_agreement(browser, base):
    context = await browser.new_context(locale='ru-RU', viewport={'width': 1440, 'height': 1000})
    try:
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await fixture_runtime(page, 'export async function runDiagnostics(){throw new Error("Agreement must not launch the game")}')
        await page.goto(base)
        await wait_for(page, '!document.getElementById("launch").disabled')
        await page.evaluate('''() => {
          window.agreementLaunches=0;
          document.getElementById('launch').addEventListener('click', event => {
            window.agreementLaunches++; event.preventDefault(); event.stopImmediatePropagation();
          }, true);
        }''')
        base_url = page.url
        output = Path('var/qa')
        output.mkdir(parents=True, exist_ok=True)
        for language, title, date, final_heading in (
            ('ru', 'Пользовательское соглашение', '9 ноября 2026 года', '9. Применимое законодательство'),
            ('en', 'User Agreement', 'November 9, 2026', '9. Governing Law'),
        ):
            await page.locator('#language').select_option(language)
            notice = page.locator('.agreement-notice')
            assert await notice.is_visible()
            assert await notice.locator('a').count() == 1
            await page.locator('#agreement-open').click()
            assert page.url == base_url, 'Agreement link navigated away from the launcher'
            assert await page.locator('#user-agreement').is_visible()
            assert await page.locator('#agreement-title').inner_text() == title
            assert await page.locator('#user-agreement time').inner_text() == date
            article = page.locator(f'[data-agreement-language="{language}"]')
            assert await article.is_visible() and await article.locator('h4').count() == 9
            assert await page.locator('[data-agreement-language]:visible').count() == 1
            await page.locator('#agreement-body').focus()
            await page.keyboard.press('Enter')
            assert await page.evaluate('window.agreementLaunches') == 0
            for width in (1440, 390, 320):
                await page.set_viewport_size({'width': width, 'height': 844})
                await page.evaluate('document.getElementById("agreement-body").scrollTop=0')
                assert await page.evaluate('''() => {
                  const modal=document.getElementById('user-agreement');
                  const body=document.getElementById('agreement-body');
                  const rect=modal.getBoundingClientRect();
                  return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight
                    && body.scrollWidth<=body.clientWidth && body.scrollHeight>body.clientHeight;
                }'''), f'Agreement overflow at {width}px'
                await page.screenshot(path=str(output / f'agreement-{language}-{width}.png'), full_page=True)
                await article.locator('h4').last.scroll_into_view_if_needed()
                assert await article.locator('h4').last.inner_text() == final_heading
                assert await page.locator('#agreement-close').is_visible(), 'Close button scrolled out of view'
            await page.keyboard.press('Escape')
            assert await page.locator('#user-agreement').is_hidden()
            await wait_for(page, 'document.getElementById("agreement-open") === document.activeElement')
            await page.locator('#agreement-open').click()
            assert await page.locator('#agreement-body').evaluate('node => node.scrollTop') == 0
            await page.locator('#agreement-close').click()
            assert await page.locator('#user-agreement').is_hidden()
        await page.locator('#status').evaluate('node => {node.tabIndex=0;node.focus()}')
        await page.keyboard.press('Enter')
        assert await page.evaluate('window.agreementLaunches') == 1, 'Closing the agreement broke the launch shortcut'
        assert not errors, errors
    finally:
        await context.close()
    print('User agreement: RU/EN, effective date, modal navigation, mobile scrolling and Enter isolation passed')


async def check_launch_notices(browser, base):
    # A screenshot from the game becomes a download; a running game is marked so
    # that a page the browser reloads mid-game (out of memory) says so once.
    context = await browser.new_context(viewport={'width': 1280, 'height': 900}, locale='ru-RU', accept_downloads=True)
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await fixture_runtime(page, '''
      export async function runDiagnostics(options) {
        window.fixtureMark = localStorage.getItem('wc3-game-running');
        options.onFrame({frames:1,width:options.resolution.width,height:options.resolution.height});
        setTimeout(() => options.onScreenshot({name:'WC3ScrnShot_110726_165125_01.png', blob:new Blob([new Uint8Array([137,80,78,71])], {type:'image/png'})}), 50);
        return {async stop(){}, async finish(){options.onReport({fixture:true});}, key(){}};
      }''')
    await page.goto(base)
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.locator('#device-warning').is_hidden() and await page.locator('#launch-message').is_hidden()
    async with page.expect_download() as downloaded:
        await page.locator('#launch').click()
    assert (await downloaded.value).suggested_filename == 'WC3ScrnShot_110726_165125_01.png'
    await wait_for(page, 'window.fixtureMark !== undefined')
    assert await page.evaluate('fixtureMark') is not None, 'A running game is marked'
    await page.evaluate("document.getElementById('stop-diagnostic').click()")
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.evaluate("localStorage.getItem('wc3-game-running')") is None, 'Closing the game removes the mark'
    assert 'Screenshot: WC3ScrnShot_110726_165125_01.png' in await page.evaluate("localStorage.getItem('wc3-last-log')")
    # The browser reloaded the page while the game ran.
    await page.evaluate("localStorage.setItem('wc3-game-running', new Date().toISOString())")
    await page.reload()
    await wait_for(page, '!document.getElementById("launch-message").hidden')
    assert 'Прошлый запуск прервался' in await page.locator('#launch-message').inner_text()
    await page.wait_for_timeout(1500)  # the log reaches storage within a second
    assert 'reloaded while the game ran' in await page.evaluate("localStorage.getItem('wc3-last-log') || ''")
    await page.locator('#language').select_option('en')
    assert 'The last launch was cut short' in await page.locator('#launch-message').inner_text()
    await page.locator('#language').select_option('ru')
    await page.reload()
    await wait_for(page, '!document.getElementById("launch").disabled')
    await page.wait_for_timeout(300)
    assert await page.locator('#launch-message').is_hidden(), 'The notice is shown once'
    # A game in another tab holds the lock: its mark is not an interruption.
    await page.evaluate("""() => { localStorage.setItem('wc3-game-running', 'other tab');
      navigator.locks.request('wc3-game-running', () => new Promise(() => {})); }""")
    other = await context.new_page()
    other.on('pageerror', lambda error: errors.append(str(error)))
    await fixture_runtime(other, 'export async function runDiagnostics() {}')
    await other.goto(base)
    await wait_for(other, '!document.getElementById("launch").disabled')
    await other.wait_for_timeout(300)
    assert await other.locator('#launch-message').is_hidden(), 'A game in another tab is no interruption'
    assert await other.evaluate("localStorage.getItem('wc3-game-running')") == 'other tab'
    for each in (page, other):  # no route handler may outlive the context
        await each.unroute_all(behavior='ignoreErrors')
    await context.close()
    # iPhone gets no experimental-support warning; an actual interrupted launch
    # still gets the same one-time notice as on other devices.
    context = await browser.new_context(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True, locale='ru-RU',
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1')
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(base)
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.locator('#device-warning').is_hidden()
    assert await page.locator('#launch-message').is_hidden()
    await page.evaluate("localStorage.setItem('wc3-game-running', new Date().toISOString())")
    await page.reload()
    await wait_for(page, '!document.getElementById("launch-message").hidden')
    assert await page.locator('#device-warning').is_hidden()
    assert 'Прошлый запуск прервался' in await page.locator('#launch-message').inner_text()
    await context.close()
    assert not errors, errors
    print('Launch notices: screenshot download, interrupted launch, other tab, iPhone without warning passed')


async def check_outdated_browser(browser, base):
    # A browser without WebAssembly tail calls starts the compatible build
    # (wc3-compat.wasm) and is told it may run slower; a current browser keeps
    # wc3.wasm. Without that build on the server, the page says so and keeps
    # Play disabled instead of failing with a compile error.
    recorder = '''
      export function prepareGame(options) {
        window.prepared = [options.wasmUrl, options.wasmSize];
        return {done:Promise.resolve({cancelled:false, media:new Map(), release(){}}), cancel(){}};
      }
      export async function runDiagnostics(options) {
        window.started = options.wasmUrl;
        options.onFrame({frames:1, width:options.resolution.width, height:options.resolution.height});
        return {async stop(){}, async finish(){options.onReport({fixture:true});}, key(){}};
      }'''
    for old, compat in ((False, True), (True, True), (True, False)):
        context = await browser.new_context(locale='ru-RU')
        if old:
            await context.add_init_script('WebAssembly.validate = () => false;')
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await fixture_runtime(page, recorder, compat=compat)
        await page.goto(base)
        if old and not compat:
            await wait_for(page, 'document.getElementById("status-sub").textContent.includes("хвостовые вызовы")')
            assert await page.locator('#launch').is_disabled(), 'Play must stay disabled'
            assert await page.locator('#status').inner_text() == 'Игра недоступна'
        else:
            await wait_for(page, '!document.getElementById("launch").disabled')
            warning = page.locator('#device-warning')
            if old:
                assert await warning.is_visible() and 'режиме совместимости' in await warning.inner_text()
            else:
                assert await warning.is_hidden(), 'A current browser gets no notice'
            await page.locator('#launch').click()
            await wait_for(page, 'window.started !== undefined')
            expected = ['/runtime/wc3-compat.wasm', 2000] if old else ['/runtime/wc3.wasm', 1000]
            assert await page.evaluate('[window.started, ...window.prepared]') == [expected[0], *expected], expected
            await page.evaluate("document.getElementById('stop-diagnostic').click()")
            await wait_for(page, '!document.getElementById("launch").disabled')
        await page.unroute_all(behavior='ignoreErrors')
        await context.close()
        assert not errors, errors
    print('Browsers without tail calls: compatible build with a notice, current browsers unchanged, '
          'notice and Play disabled without that build passed')


async def check_memory_test_page(browser, base):
    # /memory-test.html (iPhone and iPad): a test the browser cut short is
    # reported after the reload with the step and the memory filled.
    context = await browser.new_context(locale='ru-RU')
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(base + '/memory-test.html')
    await page.evaluate("""localStorage.setItem('wc3-memory-test', JSON.stringify({mode:'full', step:'fill', filledMB:1216, compileSeconds:9.5, grownMB:1984, ua:'iPhone'}))""")
    await page.reload()
    notice = await page.locator('#previous').inner_text()
    assert 'заполнено 1216 МБ' in notice and 'заполнение памяти' in notice, notice
    assert 'filled=1216 MB' in await page.locator('#details').inner_text()
    assert await page.locator('#full').is_enabled()
    await context.close()
    assert not errors, errors
    print('Memory test page: an interrupted test is reported after reload passed')


async def check_live_lobby_counts(browser, base):
    context = await browser.new_context(locale='en-US')
    await context.add_init_script("""localStorage.setItem('wc3-language','en');
      localStorage.setItem('wc3-launch-settings',JSON.stringify({version:2,fullscreen:false,audioEnabled:false}));""")
    errors = []
    async def status(route):
        response = await route.fetch()
        value = await response.json()
        value['runtime'].update(diagnostics=True, installed=True, moduleUrl='/runtime/presence-fixture.mjs')
        value['game']['prepared'] = True
        await route.fulfill(json=value)
    await context.route('**/api/status', status)
    await context.route('**/runtime/presence-fixture.mjs', lambda route: route.fulfill(
        content_type='text/javascript', body='''
          export async function runDiagnostics(options) {
            window.fixtureOptions=options;
            return {async stop(){},async finish(){options.onReport({fixture:true});}};
          }
        '''))
    release = asyncio.Event()
    try:
        observer, player = await context.new_page(), await context.new_page()
        for page in (observer, player):
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(base)
            await wait_for(page, '!document.getElementById("launch").disabled')
        await observer.locator('#tab-online').click()
        await wait_for(observer, 'document.querySelectorAll(".lobby-row").length >= 4')
        # Hold a real HTTP response with the empty roster. A newer WebSocket
        # snapshot must arrive without waiting for the 15-second polling timer,
        # and the delayed HTTP response must not overwrite it afterwards.
        captured, fulfilled = asyncio.Event(), asyncio.Event()
        async def stale_listing(route):
            response = await route.fetch()
            captured.set()
            await release.wait()
            await route.fulfill(response=response)
            fulfilled.set()
        await observer.route('**/api/lobbies', stale_listing)
        await observer.locator('#refresh-lobbies').click()
        async with asyncio.timeout(10):
            await captured.wait()
        await player.locator('#launch').click()
        await wait_for(player, 'document.body.dataset.phase === "running"')
        public_lan = '''document.getElementById("online-lan").textContent === "1" &&
          document.querySelector(".lobby-row small")?.textContent.startsWith("1 / 200")'''
        await wait_for(observer, public_lan)
        release.set()
        async with asyncio.timeout(10):
            await fulfilled.wait()
        await observer.unroute('**/api/lobbies', stale_listing)
        await observer.wait_for_timeout(100)
        assert await observer.evaluate(public_lan), 'A delayed HTTP roster overwrote live occupancy'

        # Keep the game and presence socket alive while only its relay drops.
        await player.evaluate('fixtureOptions.transport.socket.close()')
        await wait_for(observer, '''document.getElementById("online-lan").textContent === "0" &&
          document.getElementById("online-playing").textContent === "1" &&
          [...document.querySelectorAll(".lobby-row small")].every(n=>n.textContent.startsWith("0 /"))''')
        assert await player.evaluate('document.body.dataset.phase === "running"')
        await player.locator('#stop-diagnostic').click()
        await wait_for(player, '!document.getElementById("launch").disabled')

        # Private codes remain hidden; their aggregate explains LAN players
        # when every public lobby is empty, in either page language.
        await player.locator('#tab-online').click()
        await player.locator('[data-i18n="privateRoom"]').click()
        await player.locator('#room-code').fill('browser-private-code')
        await player.locator('#join-code').click()
        await wait_for(player, '!document.getElementById("joined-lobby").hidden')
        await player.locator('#launch').click()
        await wait_for(observer, '''document.getElementById("online-lan").textContent === "1" &&
          document.querySelector(".private-lobby-count")?.textContent === "Players in private lobbies: 1."''')
        assert await observer.evaluate('[...document.querySelectorAll(".lobby-row small")].every(n=>n.textContent.startsWith("0 /"))')
        assert 'browser-private-code' not in await observer.locator('#lobby-list').inner_text()
        await observer.locator('#language').select_option('ru')
        assert await observer.locator('.private-lobby-count').inner_text() == 'В лобби по коду: 1.'
        await player.close()
        await wait_for(observer, '''document.getElementById("online-lan").textContent === "0" &&
          document.getElementById("online-playing").textContent === "0" &&
          !document.querySelector(".private-lobby-count")''')
        assert not errors, errors
    finally:
        release.set()
        await context.close()
    print('Live lobby counts: synchronized roster, stale HTTP, dropped relay and private lobby privacy passed')


async def check_launch_and_lobby(browser, base):
    context = await browser.new_context(viewport={"width": 1440, "height": 1000}, locale='ru-RU')
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    async def status(route):
        response = await route.fetch()
        value = await response.json()
        value['runtime'].update(diagnostics=True, installed=True, moduleUrl='/runtime/launcher-fixture.mjs')
        value['game']['prepared'] = True
        await route.fulfill(json=value)
    await page.route('**/api/status', status)
    await page.route('**/runtime/launcher-fixture.mjs', lambda route: route.fulfill(
        content_type='text/javascript', body='''
          // Only launcher lifecycle is tested; no Warcraft code executes here.
          export async function runDiagnostics(options) {
            window.fixtureOptions=options;
            options.onStatus('Launcher fixture started');
            await new Promise(resolve=>window.fixtureReady=resolve);
            options.onFrame({frames:12,width:options.resolution.width,height:options.resolution.height});
            return {async stop(){window.fixtureStopped=true;},
              async finish(){await options.saves.write('save/launcher.bin',new Uint8Array([11,12]));
                options.onReport({fixture:true});}};
          }
        '''))
    await page.goto(base)
    await wait_for(page, '!document.getElementById("launch").disabled')
    await page.locator('#tab-game').click()
    assert await page.locator('#resolution').input_value() == '1280x960', 'Default resolution'
    assert await page.locator('#resolution option').count() == 8
    # Settings saved before version 2 recorded the old default 1024×768.
    for saved, expected in (({'resolution': '1024x768'}, '1280x960'), ({'version': 2, 'resolution': '1024x768'}, '1024x768'),
                            ({'resolution': '1600x1200'}, '1600x1200')):
        await page.evaluate('value => localStorage.setItem("wc3-launch-settings", JSON.stringify(value))', saved)
        await page.reload()
        await wait_for(page, '!document.getElementById("launch").disabled')
        assert await page.locator('#resolution').input_value() == expected, (saved, expected)
    await page.locator('#tab-game').click()
    await page.locator('#resolution').select_option('800x600')
    await page.locator('#audio-enabled').uncheck()
    # Warcraft's own Video options, chosen before launch.
    await page.locator('#video-texquality').select_option('0')
    await page.locator('#video-unitshadows').uncheck()
    await page.locator('#video-gamma').fill('55')
    await page.reload()
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.locator('#resolution').input_value() == '800x600', 'Resolution was not persisted'
    assert not await page.locator('#audio-enabled').is_checked(), 'Audio setting was not persisted'
    assert await page.locator('#video-texquality').input_value() == '0', 'Texture quality was not persisted'
    assert not await page.locator('#video-unitshadows').is_checked(), 'Shadows were not persisted'
    assert await page.locator('#video-gamma').input_value() == '55', 'Gamma was not persisted'
    await page.locator('#tab-online').click()
    await page.locator('#lobby-name').fill('Launcher browser test')
    await page.locator('#create-lobby').click()
    await wait_for(page, '!document.getElementById("joined-lobby").hidden && !document.getElementById("launch").disabled')
    assert await page.locator('#joined-name').inner_text() == 'Launcher browser test'
    assert '1 / 200' in await page.locator('#joined-players').inner_text()

    # Second browser joins the listed lobby through the same UI and real relay.
    guest_context = await browser.new_context(locale='ru-RU')
    guest = await guest_context.new_page()
    await guest.goto(base)
    await wait_for(guest, '!document.getElementById("launch").disabled')
    await guest.locator('#tab-online').click()
    await guest.locator('.lobby-row', has_text='Launcher browser test').locator('button').click()
    await wait_for(page, 'document.getElementById("joined-players").textContent.includes("2 / 200")')
    await wait_for(guest, 'document.getElementById("joined-players").textContent.includes("2 / 200")')
    await guest.locator('#leave-lobby').click()
    await wait_for(page, 'document.getElementById("joined-players").textContent.includes("1 / 200")')
    await guest_context.close()
    await page.bring_to_front()
    # Delay completion of the real fullscreen request to make the startup/stop
    # race deterministic, while still exercising Chromium's true fullscreen.
    await page.evaluate('''() => {
      window.originalFullscreen = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function(options) {
        const entered = window.originalFullscreen.call(this, options);
        return Promise.all([entered, new Promise(resolve => window.fixtureFullscreenReady = resolve)]);
      };
    }''')

    await page.locator('#launch').click()
    await wait_for(page, '!!window.fixtureReady')
    await wait_for(page, 'document.fullscreenElement?.id === "game-view"')
    assert await page.evaluate('document.fullscreenElement?.id') == 'game-view', 'Launch must request true fullscreen during user gesture'
    assert await page.locator('#launch').is_disabled(), 'A second session must not start'
    assert await page.evaluate('fixtureOptions.timeout === 0 && fixtureOptions.dispatchBudget === 0'), 'Interactive launch must not expire'
    assert await page.evaluate('fixtureOptions.transport.peerId > 0'), 'Actual lobby was not passed'
    assert await page.evaluate('fixtureOptions.resolution.width === 800 && fixtureOptions.resolution.height === 600 && fixtureOptions.audioEnabled === false')
    assert await page.evaluate('!fixtureOptions.map'), 'Browser must not choose a game map'
    assert await page.evaluate('fixtureOptions.language') == 'ru', 'The game language must follow the page language'
    assert await page.evaluate('fixtureOptions.graphicsSettings') == {'gamma': 55, 'modeldetail': 2, 'animquality': 2, 'texquality': 0, 'particles': 2, 'lights': 2, 'unitshadows': 0, 'occlusion': 1, 'spellfilter': 2}
    assert await page.locator('#video-modeldetail').is_disabled(), 'Graphics settings must not change during a session'
    # OK in the game's Video options updates the launcher; invalid values are ignored.
    await page.evaluate("fixtureOptions.onGraphicsSetting('modeldetail', 1); fixtureOptions.onGraphicsSetting('modeldetail', 7)")
    assert await page.locator('#video-modeldetail').input_value() == '1', 'In-game graphics change was not shown'
    assert await page.evaluate("JSON.parse(localStorage.getItem('wc3-launch-settings')).graphics.modeldetail") == 1, 'In-game graphics change was not stored'
    # "Playing now": this page's game runs over its LAN lobby.
    await wait_for(page, 'document.getElementById("online-playing").textContent === "1" && document.getElementById("online-lan").textContent === "1" && +document.getElementById("online-site").textContent >= 1')
    assert await page.locator('#stop-diagnostic').is_hidden(), 'The toolbar must not cover the fullscreen game'
    assert await page.locator('#touch-controls').is_hidden() and await page.locator('#rotate-hint').is_hidden(), 'A mouse and keyboard get no touch controls'
    # A user leaves fullscreen with a held Escape first. Clicking the hidden
    # button directly keeps the cancellation race with an unsettled request.
    await page.locator('#stop-diagnostic').dispatch_event('click')
    assert await page.locator('#launch').is_disabled(), 'A late controller is still pending'
    await page.evaluate('fixtureReady()')
    await wait_for(page, 'window.fixtureStopped')
    assert await page.locator('#launch').is_disabled(), 'Fullscreen transition must settle before another game starts'
    await page.evaluate('() => { fixtureFullscreenReady(); Element.prototype.requestFullscreen = originalFullscreen; }')
    await wait_for(page, 'window.fixtureStopped && !document.getElementById("launch").disabled')
    assert await page.evaluate('document.fullscreenElement === null'), 'Fullscreen was not released on cancellation'
    await wait_for(page, 'document.getElementById("online-playing").textContent === "0" && document.getElementById("online-lan").textContent === "0"')
    assert await page.evaluate('fixtureOptions.transport.socket.readyState === WebSocket.OPEN'), 'Stopping must retain Garena-style lobby membership'
    await page.evaluate('window.fixtureReady=null')
    await page.locator('#launch').click()
    await wait_for(page, '!!window.fixtureReady')
    await page.evaluate('fixtureReady()')
    await wait_for(page, 'document.body.dataset.phase === "running"')
    bounds = await page.locator('#diagnostic-canvas').bounding_box()
    assert abs(bounds['width']/bounds['height']-4/3)<.002, 'Fullscreen must preserve actual canvas bounds without internal letterboxing'
    assert await page.locator('#diagnostic-fullscreen').is_hidden(), 'The toolbar must not cover the fullscreen game'
    await page.evaluate('document.exitFullscreen()')  # what a held Escape does
    await wait_for(page, 'document.fullscreenElement === null')
    assert await page.locator('#diagnostic-fullscreen').is_visible(), 'The toolbar must return after fullscreen'
    await page.set_viewport_size({'width': 900, 'height': 650})
    await page.wait_for_timeout(100)
    bounds = await page.locator('#diagnostic-canvas').bounding_box()
    assert abs(bounds['width']/bounds['height']-4/3)<.002, 'Window resize must preserve game coordinates'
    await page.locator('#diagnostic-fullscreen').click()
    await wait_for(page, 'document.fullscreenElement?.id === "game-view"')
    await page.evaluate('document.exitFullscreen()')
    await wait_for(page, 'document.fullscreenElement === null')
    await page.locator('#stop-diagnostic').click()
    await wait_for(page, '!document.getElementById("launch").disabled')
    assert await page.evaluate('fixtureOptions.transport.socket.readyState === WebSocket.OPEN'), 'Finished game disconnected the lobby'
    assert await page.evaluate("async()=>Array.from(await fixtureOptions.saves.read('save/launcher.bin')).join(',')") == '11,12'
    await page.locator('#leave-lobby').click()
    await wait_for(page, 'fixtureOptions.transport.socket === null')
    # Play outside a lobby: the server seats the player in the first shared
    # lobby with a free seat, and the game gets that lobby's transport.
    await page.evaluate('window.fixtureReady=null')
    await page.locator('#launch').click()
    await wait_for(page, '!!window.fixtureReady')
    assert await page.evaluate('fixtureOptions.transport.room') == 'shared-ru-1', 'Play did not join Russian shared lobby 1'
    assert await page.evaluate('fixtureOptions.transport.lobby.language') == 'ru'
    assert await page.evaluate('fixtureOptions.transport.lobby.maxPlayers') == 200
    await page.evaluate('fixtureReady()')
    await wait_for(page, 'document.body.dataset.phase === "running"')
    assert await page.locator('#joined-name').inner_text() == 'Общее лобби 1'
    await page.evaluate('document.fullscreenElement && document.exitFullscreen()')
    await wait_for(page, 'document.fullscreenElement === null')
    await page.locator('#stop-diagnostic').click()
    await wait_for(page, '!document.getElementById("launch").disabled')
    await page.locator('#leave-lobby').click()
    await wait_for(page, 'fixtureOptions.transport.socket === null')
    await page.reload()
    async with page.expect_download() as downloaded:
        await page.locator('#download-log').click()
    downloaded = await downloaded.value
    assert 'Launcher fixture started' in Path(await downloaded.path()).read_text(), 'Last game log must survive reload'
    assert not errors, errors
    await context.close()
    print('Launcher fixture: public lobby/create/join/leave, late cancellation, settings, fullscreen/resize, restart, persistent log and save passed')


async def main(base):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            context = await browser.new_context(viewport={"width": 1440, "height": 1000}, locale='ru-RU')
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            map_requests = []
            page.on('request', lambda request: map_requests.append(request.url) if '/api/maps' in request.url else None)
            await page.goto(base)
            await wait_for(page, 'document.body.dataset.phase !== "loading"')
            assert await page.locator('h1').inner_text() == 'The Frozen Throne Reborn'
            assert await page.evaluate('crossOriginIsolated'), 'COOP/COEP headers missing'
            assert await page.locator('#map-list, .crest, .hero, [data-mode]').count() == 0, 'Old marketing/map selection UI remains'
            assert not map_requests, 'Launcher must not fetch the map catalog'
            assert 'Donate' not in await page.locator('body').inner_text()
            assert await page.locator('[data-info-tab]').count() == 2
            assert await page.locator('#info-pane-about').is_visible()
            assert await page.locator('#info-pane-credits').is_hidden()
            assert 'русская и английская версии Warcraft' in await page.locator('#info-pane-about').inner_text()
            await page.locator('#info-tab-credits').click()
            assert await page.locator('#info-pane-credits').is_visible()
            assert await page.locator('#tab-saves').get_attribute('aria-selected') == 'true', 'Info tabs changed the game pane'
            assert await page.locator('#info-pane-credits a').first.get_attribute('href') == 'https://github.com/alexeyskov/w3ft-web'
            await page.keyboard.press('Home')
            assert await page.locator('#info-tab-about').get_attribute('aria-selected') == 'true'
            await page.keyboard.press('ArrowRight')
            assert await page.locator('#info-tab-credits').get_attribute('aria-selected') == 'true'
            assert await page.locator('#info-tab-credits').evaluate('(node)=>node===document.activeElement')
            # A standalone diagnostic canvas has its own Enter handling while
            # the site's normal session flag is false. Do not launch another
            # original game in response to that canvas's keyboard input.
            await page.evaluate('''() => {
              window.fixtureLaunchEvents=0;
              window.fixturePreventLaunch=event=>{window.fixtureLaunchEvents++;event.preventDefault();event.stopImmediatePropagation();};
              document.getElementById('launch').addEventListener('click',fixturePreventLaunch,true);
              const canvas=document.createElement('canvas');canvas.id='outside-game-canvas';canvas.tabIndex=0;
              canvas.style='position:fixed;left:0;bottom:0;width:8px;height:8px';
              document.body.append(canvas);
              const handled=document.createElement('div');handled.id='handled-key';handled.tabIndex=0;
              handled.addEventListener('keydown',event=>event.preventDefault());document.body.append(handled);
            }''')
            await page.locator('#outside-game-canvas').press('Enter')
            await page.locator('#handled-key').press('Enter')
            await page.evaluate("document.getElementById('outside-game-canvas').addEventListener('keydown',event=>event.preventDefault())")
            await page.locator('#outside-game-canvas').press('Enter')
            assert await page.evaluate('fixtureLaunchEvents') == 0, 'Handled/canvas Enter tried to launch a second game'
            await page.evaluate('''() => {
              document.getElementById('launch').removeEventListener('click',fixturePreventLaunch,true);
              document.getElementById('outside-game-canvas').remove();document.getElementById('handled-key').remove();
            }''')
            discord = page.locator('#discord')
            assert await discord.get_attribute('href') == 'https://discord.gg/pN2896BKA'
            # The invitation opens in a new tab; the launcher stays.
            assert (await discord.get_attribute('target'), await discord.get_attribute('rel')) == ('_blank', 'noopener noreferrer')
            assert await discord.get_attribute('aria-disabled') is None
            await page.locator('#changelog-open').click()
            assert await page.locator('#changelog').is_visible()
            await page.keyboard.press('Escape')
            assert await page.locator('#changelog').is_hidden()
            await page.locator('#language').select_option('en')
            assert await page.locator('#launch').inner_text() == 'Play\nEnter'
            assert await page.locator('#info-tab-about').inner_text() == 'About'
            assert await page.locator('#info-tab-credits').inner_text() == 'Credits'
            assert await page.locator('#info-pane-credits').is_visible(), 'Language change reset the info tab'
            assert 'The launcher layout, static recompilation tools' in await page.locator('#info-pane-credits').inner_text()
            Path('var/qa').mkdir(parents=True, exist_ok=True)
            await page.locator('#about-project').screenshot(path='var/qa/info-credits-en.png')
            await page.locator('#info-tab-about').click()
            assert 'Russian and English editions of Warcraft' in await page.locator('#info-pane-about').inner_text()
            await page.locator('#about-project').screenshot(path='var/qa/info-about-en.png')
            await page.locator('#language').select_option('ru')
            assert await page.locator('#info-tab-about').inner_text() == 'О проекте'
            await page.locator('#info-tab-credits').click()
            assert 'Оформление лаунчера' in await page.locator('#info-pane-credits').inner_text()
            await page.locator('#about-project').screenshot(path='var/qa/info-credits-ru.png')
            await page.locator('#info-tab-about').click()
            await page.locator('#tab-saves').focus()
            await page.keyboard.press('ArrowRight')
            assert await page.locator('#tab-online').get_attribute('aria-selected') == 'true'
            await page.locator('#tab-saves').click()
            Path('var/qa').mkdir(parents=True, exist_ok=True)
            await page.screenshot(path='var/qa/launcher-desktop.png', full_page=True)
            for width in [1024, 820, 768, 390, 320]:
                await page.set_viewport_size({'width': width, 'height': 844})
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Horizontal overflow at {width}px'
                assert await page.locator('#about-project').is_visible(), f'About card hidden at {width}px'
                if width <= 800:
                    content=await page.locator('.content').bounding_box()
                    info=await page.locator('#about-project').bounding_box()
                    assert info['y']>=content['y']+content['height'], 'Mobile info precedes game controls'
            await page.set_viewport_size({'width': 390, 'height': 844})
            await page.screenshot(path='var/qa/launcher-mobile.png', full_page=True)
            await check_storage(page)
            await page.evaluate("""async () => {
                const {SaveStore} = await import('/src/storage.mjs');
                await new SaveStore().write('Profiles/Reload.w3v', new Uint8Array([4, 5, 6]));
            }""")
            await page.reload()
            await wait_for(page, "document.getElementById('save-count').textContent === '1'")
            async with page.expect_download() as downloaded:
                await page.locator('#export-saves').click()
            exported = Path(await (await downloaded.value).path()).read_bytes()
            archive = json.loads(exported)
            assert archive['format'] == 'wc3-web-saves-v1' and len(archive['files']) == 1
            await page.evaluate("""async () => {
                const {SaveStore} = await import('/src/storage.mjs');
                await new SaveStore().remove('Profiles/Reload.w3v');
            }""")
            await page.locator('#import-saves').set_input_files({'name':'saves.json','mimeType':'application/json','buffer':exported})
            await wait_for(page, 'document.getElementById("save-status").textContent.includes("восстановлены")')
            assert await page.evaluate("""async () => {
                const {SaveStore} = await import('/src/storage.mjs');
                return (await new SaveStore().read('Profiles/Reload.w3v')).join(',');
            }""") == '4,5,6'
            assert not errors, errors
            await context.close()
            await check_live_lobby_counts(browser, base)
            await check_launch_and_lobby(browser, base)
            await check_default_language(browser, base)
            await check_user_agreement(browser, base)
            await check_touch_controls(browser, base)
            await check_loading_screen(browser, base)
            await check_launch_notices(browser, base)
            await check_outdated_browser(browser, base)
            await check_memory_test_page(browser, base)
            print('Browser integration passed. Warcraft execution was not tested.')
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    asyncio.run(main(parser.parse_args().url))
