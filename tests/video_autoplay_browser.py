"""Autoplay denial must allow a real tap or skip, never abort the guest.

Both browsers enforce their real autoplay policy on a page with no user
activation. Playback and decoding use a real generated audio/video clip.
"""
import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HEADERS = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}
SETUP = """async ({language='en'}={}) => {
  const {VideoDispatcher}=await import('/video-bridge.mjs');
  window.events=[];window.messages=[];window.guestInput=[];
  const canvas=document.querySelector('canvas');canvas.tabIndex=0;
  for(const type of ['pointerdown','pointerup','click'])canvas.parentElement.addEventListener(type,e=>guestInput.push(e.type));
  window.dispatcher=new VideoDispatcher({canvas,language,onEvent:e=>events.push(e),log:m=>messages.push(m)});
  await dispatcher.execute({id:1,method:'load',url:'/api/assets/fixture.webm'});
  window.element=dispatcher.players.get(1).video;
  const control=new SharedArrayBuffer(16384),start=performance.now();
  await dispatcher.handle({id:1,method:'play',control});
  const status=new Int32Array(control,0,2),response=JSON.parse(new TextDecoder().decode(new Uint8Array(control,8,status[1]).slice()));
  return {status:status[0],response,elapsed:performance.now()-start};
}"""


@contextmanager
def fixture_server(clip):
    # A real HTTP origin: WebKit does not expose SharedArrayBuffer on pages
    # fulfilled by Playwright routing, even with COOP/COEP response headers.
    class Handler(BaseHTTPRequestHandler):
        def send(self, body=b'', content_type='text/html', status=200, headers=None):
            if isinstance(body, str):
                body = body.encode()
            self.send_response(status)
            for name, value in {**HEADERS, 'Content-Type': content_type, 'Content-Length': str(len(body)), **(headers or {})}.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            name = urlsplit(self.path).path.rsplit('/', 1)[-1]
            if name == 'fixture.webm':
                start, end = 0, len(clip) - 1
                byte_range = self.headers.get('Range')
                if byte_range:
                    first, last = byte_range.removeprefix('bytes=').split('-')
                    start = int(first or 0)
                    end = min(int(last), end) if last else end
                headers = {'Accept-Ranges': 'bytes'}
                if byte_range:
                    headers['Content-Range'] = f'bytes {start}-{end}/{len(clip)}'
                self.send(clip[start:end + 1], 'video/webm', 206 if byte_range else 200, headers)
            elif name.endswith('.mjs'):
                self.send((ROOT / 'web/runtime' / name).read_text(), 'text/javascript')
            else:
                # evaluate() grants user activation; start from the page itself.
                script = """try {
                  const result=await (%s)({language:new URLSearchParams(location.search).get('language')||'en'});
                  await fetch('/autoplay-result',{method:'POST',body:JSON.stringify(result)});
                }catch(error){await fetch('/autoplay-result',{method:'POST',body:JSON.stringify({error:String(error)})});}""" % SETUP
                self.send('<section><canvas width="640" height="480"></canvas></section><script type="module">' + script + '</script>')

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.send(status=204)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}'
        finally:
            server.shutdown()
            thread.join()


def main():
    with tempfile.TemporaryDirectory() as temp:
        fixture = Path(temp) / 'fixture.webm'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=64x48:rate=24:duration=1.5',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:v', 'libvpx',
                        '-c:a', 'libopus', '-shortest', str(fixture)], check=True)
        clip = fixture.read_bytes()

    with fixture_server(clip) as url, sync_playwright() as playwright:
        for engine in ('chromium', 'webkit'):
            args = {'args': ['--autoplay-policy=user-gesture-required']} if engine == 'chromium' else {}
            browser = getattr(playwright, engine).launch(**args)
            try:
                for case in ('tap', 'click', 'skip', 'cancel', 'decode'):
                    context = browser.new_context(has_touch=True, viewport={'width': 800, 'height': 600})
                    try:
                        page = context.new_page()
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        with page.expect_request('**/autoplay-result') as completed:
                            page.goto(url + '/?language=' + ('ru' if case == 'skip' else 'en'))
                        outcome = completed.value.post_data_json
                        assert outcome.get('status') == 1 and outcome['response']['blocked'], outcome
                        assert outcome['elapsed'] < 2000, 'The guest must be released before its 20-second RPC timeout'
                        assert page.locator('.cinematic-prompt').is_visible()
                        assert not page.evaluate('element.muted'), 'Do not silently mute the cinematic'

                        if case in ('tap', 'click'):
                            button = page.get_by_role('button', name='Play cinematic', exact=True)
                            button.tap() if case == 'tap' else button.click()
                            page.wait_for_function('element.currentTime > 0.05 && !element.paused')
                            assert not page.locator('.cinematic-prompt').count()
                            assert page.evaluate('guestInput') == [], 'The tap leaked into game input'
                            assert page.evaluate('document.activeElement === document.querySelector("canvas")')
                            page.wait_for_function('events.some(e=>e.event === "ended")')
                            assert page.evaluate('events.filter(e=>e.event === "ended").length') == 1
                            replay = page.evaluate("async()=>dispatcher.execute({id:1,method:'seek',position:0})")
                            assert not replay['ended'], 'Seeking back must clear the previous completion state'
                        elif case == 'skip':
                            page.get_by_role('button', name='Пропустить', exact=True).tap()
                            assert page.evaluate('element.paused && element.currentTime === 0')
                            page.evaluate('element.dispatchEvent(new Event("ended"))')
                            assert page.evaluate('events') == [{'type': 'video-event', 'id': 1, 'event': 'ended'}]
                            assert page.evaluate('guestInput') == []
                            assert not page.locator('.cinematic-prompt').count()
                        elif case == 'cancel':
                            page.evaluate("async()=>{await dispatcher.execute({id:1,method:'stop'});}")
                            assert not page.locator('.cinematic-prompt').count()
                            # A rejected play promise arriving after Stop must not recreate controls.
                            page.evaluate("""async()=>{
                              let reject; element.play=()=>new Promise((resolve,no)=>{reject=no;});
                              const pending=dispatcher.execute({id:1,method:'play'});
                              await dispatcher.execute({id:1,method:'stop'});
                              reject(new DOMException('Denied late','NotAllowedError'));await pending;
                            }""")
                            assert not page.locator('.cinematic-prompt').count()
                            page.evaluate("async()=>{element.play=()=>Promise.reject(new DOMException('Denied','NotAllowedError'));await dispatcher.execute({id:1,method:'play'});dispatcher.destroy();}")
                            assert not page.locator('video,.cinematic-prompt').count()
                            assert page.evaluate('events') == []
                        else:
                            result = page.evaluate("""async()=>{
                              await dispatcher.execute({id:1,method:'stop'});
                              element.play=()=>Promise.reject(new DOMException('Cannot decode','NotSupportedError'));
                              try{await dispatcher.execute({id:1,method:'play'});return null;}catch(error){return error.name;}
                            }""")
                            assert result == 'NotSupportedError', 'Real playback errors must not be mistaken for autoplay denial'
                            assert not page.locator('.cinematic-prompt').count()
                        page.evaluate('dispatcher.destroy()')
                        assert not page.locator('video,.cinematic-prompt').count()
                        assert not errors, errors
                        print(json.dumps({'browser': engine, 'case': case, 'passed': True}), flush=True)
                    finally:
                        context.close()
            finally:
                browser.close()


if __name__ == '__main__':
    main()
