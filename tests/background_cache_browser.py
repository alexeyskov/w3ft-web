#!/usr/bin/env python3
"""Exercise the shared OPFS cache in actual browser workers, no game assets."""
import asyncio
import tempfile
from pathlib import Path
from aiohttp import web
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
BLOCK = 256 * 1024
WORKER = """
import {GameDataCache} from '/runtime/game-cache.mjs';
import {DownloadScheduler} from '/runtime/download-scheduler.mjs';
let cache,scheduler;
onmessage=async({data})=>{
  if(data.type==='pause')return scheduler.pause();
  if(data.type==='resume')return scheduler.resume();
  if(data.type==='stop'){await scheduler?.stop();cache?.close();postMessage({type:'closed'});return;}
  if(data.type==='start'){
    cache=await GameDataCache.open(data.entries,{log:message=>postMessage({type:'log',message})});
    if(!cache){postMessage({type:'busy'});return;}
    scheduler=new DownloadScheduler(data.entries,cache,{gapMs:0,quietMs:0,
      onProgress:progress=>postMessage({type:'progress',...progress}),
      onFileReady:(entry,file)=>postMessage({type:'movie',file})});
    scheduler.start();
  }
};
"""


async def main():
    requests=[]
    names=['UI/Menu.fdf','UI/Multiplayer/Room.fdf','Maps/Custom.w3x','WebMedia/HumanOp.webm']
    entries=[{'key':f'a-{i}-v1','size':BLOCK*2+13,'url':f'/data/{i}','label':name,'version':'v1'} for i,name in enumerate(names)]
    async def headers(request,response):
        response.headers.update({'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    async def index(request):
        return web.Response(text='<html><body>Cache fixture</body></html>',content_type='text/html')
    async def worker(request):
        return web.Response(text=WORKER,content_type='text/javascript')
    async def source(request):
        return web.Response(text=(ROOT/'web/runtime'/request.match_info['name']).read_text(),content_type='text/javascript')
    async def data(request):
        i=int(request.match_info['i']);size=entries[i]['size']
        start,end=map(int,request.headers['Range'][6:].split('-'))
        requests.append((i,start,end))
        return web.Response(body=bytes([i+1])*(end-start+1),status=206,headers={'Content-Range':f'bytes {start}-{end}/{size}'})
    app=web.Application();app.on_response_prepare.append(headers)
    app.router.add_get('/',index);app.router.add_get('/worker.mjs',worker)
    app.router.add_get('/runtime/{name}',source);app.router.add_get('/data/{i}',data)
    runner=web.AppRunner(app);await runner.setup()
    try:
        await web.TCPSite(runner,'127.0.0.1',0).start()
        origin=f'http://127.0.0.1:{runner.addresses[0][1]}'
        async with async_playwright() as p:
            for engine in ['chromium','webkit']:
                profile=tempfile.TemporaryDirectory(prefix='wc3-cache-test-')
                browser=await getattr(p,engine).launch_persistent_context(profile.name)
                try:
                    page=await browser.new_page();errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    await page.goto(origin)
                    async def start(items):
                        await page.evaluate('''entries=>{
                          window.messages=[];window.movie=null;
                          window.worker=new Worker('/worker.mjs',{type:'module'});
                          worker.onmessage=({data})=>{if(data.type==='movie')movie=data.file;else messages.push(data);};
                          worker.onerror=e=>messages.push({type:'error',message:e.message});
                          worker.postMessage({type:'start',entries});
                        }''',items)
                        await page.wait_for_function("messages.some(m=>m.state==='complete'||m.state==='paused'||m.type==='busy'||m.type==='error')",timeout=15000)
                        assert await page.evaluate("messages.some(m=>m.state==='complete')"),await page.evaluate('messages')
                        await page.wait_for_function('!!window.movie',timeout=5000)
                    async def close():
                        await page.evaluate("worker.postMessage({type:'stop'})")
                        await page.wait_for_function("messages.some(m=>m.type==='closed')")
                        await page.evaluate('worker.terminate()')
                    requests.clear();await start(entries)
                    assert [r[0] for r in requests]==[0,1,2,3],requests
                    snapshot=await page.evaluate("async()=>({size:movie.size,first:new Uint8Array(await movie.arrayBuffer())[0]})")
                    assert snapshot=={'size':entries[-1]['size'],'first':4},snapshot
                    # A concurrent tab cannot acquire a second writer.
                    busy=await page.evaluate('''async entries=>{
                      const other=new Worker('/worker.mjs',{type:'module'});
                      try{return await new Promise(resolve=>{other.onmessage=({data})=>{if(data.type!=='log')resolve(data.type)};other.postMessage({type:'start',entries});});}
                      finally{other.terminate();}
                    }''',entries)
                    assert busy=='busy',busy
                    await close()
                    requests.clear();await start(entries);assert not requests,requests;await close()
                    # Same name and size, new version must replace only that file.
                    changed=[dict(e) for e in entries];changed[1].update(key='a-1-v2',version='v2')
                    requests.clear();await start(changed);assert [r[0] for r in requests]==[1],requests;await close()
                    assert not errors,errors
                    print(f'PASS {engine}: phased background downloads, disk-backed movie, single writer, persistent reuse, version replacement.',flush=True)
                finally:
                    await browser.close()
                    profile.cleanup()
    finally:
        await runner.cleanup()
        print('Browsers and local cache fixture server closed.',flush=True)


if __name__=='__main__':asyncio.run(main())
