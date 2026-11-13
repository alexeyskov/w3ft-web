"""Verify bit-identical native CRT results in Chromium and WebKit.

Uses synthetic CPU state only, with no Warcraft files or network service.
"""
import asyncio
import json
from pathlib import Path
import tempfile

from aiohttp import web
from playwright.async_api import async_playwright
from tests.test_native_runtime import compile_fixture

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = """async()=>{
  const {WarcraftHost}=await import('/runtime/host.mjs');
  const memory=new WebAssembly.Memory({initial:1024,maximum:65536,shared:true}),h=new WarcraftHost({memory});
  const {instance}=await WebAssembly.instantiate(await (await fetch('/fixture.wasm')).arrayBuffer(),h.imports());
  const x=instance.exports;h.instance=instance;h.exports=x;x._initialize();
  if(!x.wc3_init(0x7fff0000))throw Error('init');h.attach(instance);
  const cpu=x.wc3_cpu_pointer(),esp=h.view.getUint32(cpu+16,true),st=x.wc3_cpu_st_offset(),top=x.wc3_cpu_top_offset();
  const results={};
  const bits=(value)=>Number.isNaN(value)?'NaN':(()=>{const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,value);return v.getBigUint64(0).toString(16).padStart(16,'0');})();
  const samples=[-Infinity,-1e20,-Math.PI,-1,-0,0,Number.MIN_VALUE,1e-10,0.1,0.5,1,Math.PI,1e20,Infinity,NaN];
  for(const name of ['_CIsqrt','_CIlog10','_CIexp','_CIatan','_CItan','_CIacos','_CIasin','_CIsin','_CIcos','_CIpow','_CIatan2','_CIfmod']){
    const id=(h.resolve('MSVCR80.dll',name)-0xf1000000)/16;
    results[name]=samples.map(value=>{
      h.view.setUint32(cpu+16,esp,true);h.w32(esp,0x123abc);h.view.setInt32(cpu+top,0,true);
      h.view.setFloat64(cpu+st,value,true);h.view.setFloat64(cpu+st+8,0.25,true);x.fixture_import(cpu,id);
      return bits(h.view.getFloat64(cpu+st+8*h.view.getInt32(cpu+top,true),true));
    });
  }
  return results;
}"""


async def main():
    with tempfile.TemporaryDirectory(prefix='wc3-native-math-') as directory:
        module=Path(directory)/'fixture.wasm'
        compile_fixture(module)

        @web.middleware
        async def isolated(request, handler):
            response=await handler(request)
            response.headers['Cross-Origin-Opener-Policy']='same-origin'
            response.headers['Cross-Origin-Embedder-Policy']='require-corp'
            return response

        app=web.Application(middlewares=[isolated])
        async def page(request): return web.Response(text='<!doctype html><title>Native CRT test</title>',content_type='text/html')
        async def wasm(request): return web.FileResponse(module)
        app.router.add_get('/',page);app.router.add_get('/fixture.wasm',wasm)
        app.router.add_static('/runtime/',ROOT/'web/runtime')
        runner=web.AppRunner(app);await runner.setup()
        try:
            site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
            url=f'http://127.0.0.1:{runner.addresses[0][1]}'
            results={}
            async with async_playwright() as playwright:
                for name in ['chromium','webkit']:
                    browser=await getattr(playwright,name).launch()
                    try:
                        page=await browser.new_page();await page.goto(url)
                        results[name]=await page.evaluate(SCRIPT)
                    finally: await browser.close()
            assert results['chromium']==results['webkit'],json.dumps(results)
            print('Bit-identical Chromium/WebKit native CRT: 12 functions × 15 inputs (NaN payloads normalized).')
        finally: await runner.cleanup()


if __name__=='__main__': asyncio.run(main())
