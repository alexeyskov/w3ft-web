#!/usr/bin/env python3
"""Real OPFS preload, repeat launch, cancellation and timeout; no game data."""
import asyncio
import json
from pathlib import Path
import time

from aiohttp import web
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
BLOCK = 256 * 1024
FILES = {
    'exec': {'id':'fixture-exec', 'path':'game.bin', 'version':'v1', 'body':b'e'*32768},
    'archive': {'id':'fixture-archive', 'path':'archive.mpq', 'version':'v1', 'body':bytes(range(256))*(BLOCK//256*3)},
    'movie': {'id':'fixture-movie', 'path':'WebMedia/Intro.webm', 'version':'v1', 'body':b'fixture movie'*5000},
}


async def main():
    counts = {'assets':0, 'wasm':0}
    stalled = asyncio.Event()
    releases = []

    async def headers(request, response):
        response.headers.update({'Cross-Origin-Opener-Policy':'same-origin', 'Cross-Origin-Embedder-Policy':'require-corp'})

    async def index(request):
        return web.Response(text='<canvas></canvas>', content_type='text/html')

    async def assets(request):
        if request.query.get('language') == 'flaky':
            counts['flakyList'] = counts.get('flakyList', 0) + 1
            if counts['flakyList'] == 1:
                return web.Response(status=503, text='restarting')
            return web.json_response({'files':[{'id':'fixture-flaky', 'path':'flaky.bin', 'version':'v1',
                                                'size':BLOCK, 'downloadUrl':'/api/assets/flaky'}]})
        if request.query.get('language') == 'cancel':
            files = [{'id':'fixture-cancel', 'path':'cancel.bin', 'version':'v1', 'size':BLOCK,
                      'downloadUrl':'/api/assets/stall'}]
        else:
            files = [{**{k:v for k,v in item.items() if k != 'body'}, 'size':len(item['body']),
                      'downloadUrl':'/api/assets/'+name} for name,item in FILES.items()]
        return web.json_response({'files':files})

    async def runtime(request):
        name = request.match_info['name']
        if name == 'test.wasm':
            counts['wasm'] += request.method != 'HEAD'
            return web.Response(body=b'\0asm\1\0\0\0' + b'w'*65536,
                                headers={'ETag':'"wasm-fixture-v1"','Cache-Control':'max-age=3600'})
        if name == 'build.json':
            return web.json_response({'modules':[{'image':'game.bin'}]})
        if name.startswith('boot-'):
            if name == 'boot-cancel.json':
                return web.json_response({'schemaVersion':1,'files':[{'path':'cancel.bin','size':BLOCK,'whole':True}]})
            return web.json_response({'schemaVersion':1,'files':[
                {'path':'game.bin','size':len(FILES['exec']['body']),'whole':True},
                {'path':'archive.mpq','size':len(FILES['archive']['body']),'blocks':[[0,0],[2,2]]}],
                'media':['WebMedia/Intro.webm']})
        source = ROOT / 'web/runtime' / name
        if not source.is_file() or '/' in name:
            raise web.HTTPNotFound()
        body = source.read_text()
        if name == 'range-request.mjs':
            body = body.replace('[250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]', '[20, 20]')
        if name == 'game-cache-worker.mjs' and request.query.get('short-timeout'):
            body = body.replace('const IDLE_TIMEOUT = 30000;', 'const IDLE_TIMEOUT = 150;')
        return web.Response(text=body, content_type='text/javascript')

    async def download(request):
        key = request.match_info['key']
        counts['assets'] += 1
        if key == 'flaky':
            counts['flaky'] = counts.get('flaky', 0) + 1
            if counts['flaky'] == 1:
                return web.Response(status=502, text='bad gateway')
            body = bytes(range(256)) * (BLOCK // 256)
            start, end = map(int, request.headers['Range'].removeprefix('bytes=').split('-'))
            return web.Response(body=body[start:end+1], status=206,
                                headers={'Content-Range': f'bytes {start}-{end}/{len(body)}'})
        if key == 'stall':
            release = asyncio.Event()
            releases.append(release)
            stalled.set()
            await release.wait()
            body = bytes(BLOCK)
        else:
            body = FILES[key]['body']
        status = 200
        answer_headers = {}
        if value := request.headers.get('Range'):
            start,end = map(int,value.removeprefix('bytes=').split('-'))
            answer_headers['Content-Range'] = f'bytes {start}-{end}/{len(body)}'
            body = body[start:end+1]
            status = 206
        return web.Response(body=body, status=status, headers=answer_headers)

    app = web.Application()
    app.on_response_prepare.append(headers)
    app.router.add_get('/',index)
    app.router.add_get('/api/assets',assets)
    app.router.add_get('/api/assets/{key}',download)
    app.router.add_get('/runtime/{name}',runtime)
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        await web.TCPSite(runner,'127.0.0.1',0).start()
        origin = f'http://127.0.0.1:{runner.addresses[0][1]}'
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page()
                errors = []
                page.on('pageerror',lambda error: errors.append(str(error)))
                await page.goto(origin)
                await page.evaluate("async()=>{window.client=await import('/runtime/client.mjs')}")
                async def prepare(skip_intro=True):
                    return await page.evaluate("""async skipIntro=>{
                      const messages=[];
                      const job=client.prepareGame({wasmUrl:'/runtime/test.wasm',wasmSize:65544,language:'en',skipIntro,onStatus:m=>messages.push(m)});
                      const done=await job.done;const movies=done.media.size;done.release();return {messages,movies};
                    }""", skip_intro)
                first = await prepare()
                assert first['movies'] == 0, first
                first_metrics = json.loads(next(m.split(': ',1)[1] for m in first['messages'] if m.startswith('Preload game data:')))
                assert first_metrics['completed'] == first_metrics['requests'] == 3, first_metrics
                assert first_metrics['decodedBytes'] == 32768+BLOCK*2, first_metrics
                saved = dict(counts)
                second = await prepare()
                assert second['movies'] == 0 and counts == saved, (counts,saved,second)
                repeat_metrics = json.loads(next(m.split(': ',1)[1] for m in second['messages'] if m.startswith('Preload game data:')))
                assert repeat_metrics['requests'] == 0 and repeat_metrics['cacheSkippedBytes'] == first_metrics['decodedBytes'], repeat_metrics
                assert any('"cache":"validated"' in m for m in second['messages']), second
                print('PASS: real OPFS first preload and immediate repeat use persisted blocks; second run downloads no assets/WASM.',flush=True)
                cinematic = await prepare(False)
                assert cinematic['movies'] == 1
                print('PASS: normal startup omits cinematic; explicit cinematic diagnostic still works.',flush=True)
                await page.evaluate("()=>{window.job=client.preloadGameData({language:'cancel'});window.result=job.done}")
                await asyncio.wait_for(stalled.wait(),5)
                began = time.monotonic()
                result = await page.evaluate('async()=>{job.cancel();return await result}')
                assert result['type'] == 'cancelled' and time.monotonic()-began < 2, result
                print('PASS: cancelling manual preload aborts an in-flight response immediately.',flush=True)
                stalled.clear()
                await page.evaluate("()=>{window.job=client.prepareGame({wasmUrl:'/runtime/test.wasm',wasmSize:65544,language:'cancel'});window.result=job.done}")
                await asyncio.wait_for(stalled.wait(),5)
                result = await page.evaluate('async()=>{job.cancel();const r=await result;r.release();return {cancelled:r.cancelled}}')
                assert result['cancelled'], result
                print('PASS: cancelling startup preload resolves and releases its cache lock.',flush=True)
                result = await page.evaluate("""async()=>{
                  const worker=new Worker('/runtime/game-cache-worker.mjs?short-timeout=1',{type:'module'});
                  try{return await new Promise(resolve=>{
                    worker.onmessage=({data})=>{if(data.type==='error')resolve(data)};
                    worker.postMessage({type:'preload',entries:[{key:'fixture-timeout',size:262144,url:'/api/assets/stall',label:'timeout.bin'}]});
                  });}finally{worker.terminate()}
                }""")
                assert result['code'] == 'timeout' and result['metrics']['requests'] == 3 and result['metrics']['retries'] == 2, result
                print('PASS: a stalled response is asked again, then ends with a timeout and diagnostic timings, rather than hanging indefinitely.',flush=True)
                result = await page.evaluate("async()=>{const messages=[];const job=client.preloadGameData({language:'flaky',onStatus:m=>messages.push(m)});return {...await job.done,messages}}")
                assert result['type'] == 'done' and counts['flakyList'] == 2 and counts['flaky'] == 2, (result, counts)
                assert any('retrying in' in m for m in result['messages']), result
                assert not errors, errors
                print('PASS: manual download survives a failed list request and a failed block (503/502), as on a poor link.',flush=True)
            finally:
                for release in releases:
                    release.set()
                await browser.close()
    finally:
        for release in releases:
            release.set()
        await runner.cleanup()
        print('Temporary browser and preload server closed.',flush=True)


if __name__ == '__main__':
    asyncio.run(main())
