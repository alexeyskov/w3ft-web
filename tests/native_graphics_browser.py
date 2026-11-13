"""Native STATE recording and JS draws produce identical real WebGL pixels."""
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
  const {FixedFunctionGL,GL}=await import('/runtime/graphics.mjs');
  const {GraphicsCommandQueue,GraphicsBatchRegistry,GRAPHICS_NATIVE_FLUSH}=await import('/runtime/graphics-batch.mjs');
  const canvas=document.querySelector('canvas'),graphics=new FixedFunctionGL(canvas,{debugChecks:true});
  const memory=new WebAssembly.Memory({initial:1024,maximum:65536,shared:true}),h=new WarcraftHost({memory,graphics});
  const imports=h.imports();let x,queue,registry,owner,calls=0,flushes=0;
  imports.wc3.wc3_host_call=(id,cpu)=>{
    if((id>>>0)===GRAPHICS_NATIVE_FLUSH){flushes++;queue.appendNative(x.wc3_graphics_pointer()>>>0,x.wc3_graphics_bytes());return;}
    calls++;if(!queue.enqueue(id,cpu)){const pending=queue.syncPoint();if(pending)registry.submit(owner,pending);registry.drain();h.invoke(id,cpu);}
  };
  const {instance}=await WebAssembly.instantiate(await(await fetch('/fixture.wasm')).arrayBuffer(),imports);
  x=instance.exports;h.instance=instance;h.exports=x;x._initialize();if(!x.wc3_init(0x7fff0000))throw Error('init');h.attach(instance);
  const cpu=x.wc3_cpu_pointer(),esp=h.view.getUint32(cpu+16,true);owner={cpu,id:1};
  registry=h.graphicsBatchRegistry=new GraphicsBatchRegistry(h);queue=new GraphicsCommandQueue(h,registry.buffer,{post:m=>registry.submit(owner,m)});
  const floats=values=>{const pointer=h.alloc(values.length*4);values.forEach((v,i)=>h.view.setFloat32(h.base+pointer+i*4,v,true));return pointer;};
  const bits=value=>new Uint32Array(Float32Array.of(value).buffer)[0];
  const call=(name,args)=>{const id=(h.resolve('opengl32.dll',name)-0xf1000000)/16;h.view.setUint32(cpu+16,esp,true);h.w32(esp,0x123abc);args.forEach((v,i)=>h.w32(esp+4+i*4,v));x.fixture_import(cpu,id);};
  const vertices=floats([-1,-1,0,1,-1,0,0,1,0]),pixels=[],counts=[];
  for(const native of [0,1]){
    if(!x.wc3_graphics_enable(native))throw Error('enable');const before=calls;
    call('glViewport',[0,0,32,32]);call('glClearColor',[0,0,0,bits(1)]);call('glClear',[GL.COLOR_BUFFER_BIT]);
    const matrix=floats([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    call('glLoadMatrixf',[matrix]);h.zero(matrix,64);
    for(let i=0;i<50;i++)call('glColor4f',[bits(.25),bits(.5),bits(.75),bits(1)]);
    call('glVertexPointer',[3,GL.FLOAT,0,vertices]);call('glEnableClientState',[0x8074]);call('glDrawArrays',[GL.TRIANGLES,0,3]);
    x.wc3_graphics_flush(cpu);queue.submit();registry.drain();
    const pixel=new Uint8Array(4);graphics.gl.readPixels(16,16,1,1,graphics.gl.RGBA,graphics.gl.UNSIGNED_BYTE,pixel);
    pixels.push([...pixel]);counts.push(calls-before);
  }
  if(pixels[0].some((v,i)=>Math.abs(v-[64,128,191,255][i])>1)||pixels[0].join()!==pixels[1].join())throw Error('native rendering '+JSON.stringify(pixels));
  if(counts[1]>=counts[0]/2)throw Error('native staging did not reduce crossings '+counts);
  graphics.destroy();registry.cancel();return{pixels,calls:counts,flushes};
}"""


async def main():
    with tempfile.TemporaryDirectory(prefix='wc3-native-graphics-') as directory:
        module=Path(directory)/'fixture.wasm';compile_fixture(module)
        @web.middleware
        async def isolated(request, handler):
            response=await handler(request)
            response.headers['Cross-Origin-Opener-Policy']='same-origin'
            response.headers['Cross-Origin-Embedder-Policy']='require-corp'
            return response
        app=web.Application(middlewares=[isolated])
        async def page(request): return web.Response(text='<canvas width="32" height="32"></canvas>',content_type='text/html')
        async def wasm(request): return web.FileResponse(module)
        app.router.add_get('/',page);app.router.add_get('/fixture.wasm',wasm);app.router.add_static('/runtime/',ROOT/'web/runtime')
        runner=web.AppRunner(app);await runner.setup()
        try:
            site=web.TCPSite(runner,'127.0.0.1',0);await site.start();url=f'http://127.0.0.1:{runner.addresses[0][1]}'
            results={}
            async with async_playwright() as playwright:
                for name in ['chromium','webkit']:
                    browser=await getattr(playwright,name).launch()
                    try:
                        tab=await browser.new_page();await tab.goto(url);results[name]=await tab.evaluate(SCRIPT)
                    finally: await browser.close()
            print(json.dumps(results))
        finally: await runner.cleanup()


if __name__=='__main__': asyncio.run(main())
