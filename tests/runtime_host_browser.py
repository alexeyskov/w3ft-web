from playwright.sync_api import sync_playwright
from pathlib import Path
import json

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page()
    def route(r):
        path=r.request.url.split('/')[-1]
        if path in ('graphics.mjs','audio.mjs','audio-spatial.mjs'):
            r.fulfill(content_type='text/javascript',body=Path('web/runtime',path).read_text())
        else:
            r.fulfill(content_type='text/html',body='<canvas id="canvas" width="32" height="32"></canvas>')
    page.route('http://runtime.test/**',route)
    page.goto('http://runtime.test/')
    result=page.evaluate('''async () => {
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');
      const {PCMPlayer}=await import('/audio.mjs');
      const renderer=new FixedFunctionGL(document.getElementById('canvas'));
      const gl=renderer.gl, sample=()=>{const bytes=new Uint8Array(4);gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return [...bytes];};
      const geometry={positions:new Float32Array([-1,-1,0,1,-1,0,0,1,0]),texcoords:new Float32Array([0,0,1,0,.5,1])};
      renderer.viewport(0,0,32,32);renderer.clearColor(0,0,0,1);renderer.clear(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT);
      renderer.color(1,0,0,1);renderer.drawArrays(GL.TRIANGLES,0,3,geometry);const red=sample();
      if(red.join(',')!=='255,0,0,255')throw new Error('triangle pixel '+red);
      const texture=renderer.genTexture();renderer.bindTexture(GL.TEXTURE_2D,texture);
      renderer.texImage2D(GL.TEXTURE_2D,0,GL.RGBA,1,1,0,GL.BGRA,GL.UNSIGNED_BYTE,new Uint8Array([255,0,0,255]));
      renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      renderer.enable(GL.TEXTURE_2D);renderer.color(1,1,1,1);renderer.drawArrays(GL.TRIANGLES,0,3,geometry);const blue=sample();
      if(blue.join(',')!=='0,0,255,255')throw new Error('texture pixel '+blue);
      renderer.disable(GL.TEXTURE_2D);renderer.enable(GL.ALPHA_TEST);renderer.alphaFunc(GL.GREATER,.9);renderer.color(1,0,0,.5);renderer.clear(GL.COLOR_BUFFER_BIT);renderer.drawArrays(GL.TRIANGLES,0,3,geometry);const discarded=sample();
      if(discarded.join(',')!=='0,0,0,255')throw new Error('alpha test pixel '+discarded);
      if(renderer.errorChecks!==1)throw Error('ordinary draws/state changes must not synchronously poll GPU errors');
      renderer.swapBuffers();
      if(renderer.errorChecks!==2)throw Error('SwapBuffers must check deferred backend errors');
      // A real backend error is still reported, before presenting a good frame.
      gl.bindTexture(0xdead,null);renderer.viewport(0,0,32,32);
      let deferredError='';try{renderer.swapBuffers();}catch(error){deferredError=error.message;}
      if(!deferredError.includes('WebGL error 0x500')||!deferredError.includes('viewport'))throw Error('missing backend error '+deferredError);
      if(renderer.frames!==1)throw Error('failed presentation must not count as a successful frame');
      renderer.debugChecks=true;let immediateError='';
      try{renderer.cullFace(0xdead);}catch(error){immediateError=error.message;}
      if(!immediateError.includes('cullFace'))throw Error('debug checks must retain operation-level diagnostics');
      renderer.debugChecks=false;renderer.swapBuffers();
      const player=new PCMPlayer();await player.unlock();const voice=player.playPCM({data:new Uint8Array(8000).fill(128),format:'u8',channels:1,sampleRate:8000});player.pause(voice);player.resume(voice);player.stop(voice);await player.destroy();
      const version=gl.getParameter(gl.VERSION);renderer.destroy();return {red,blue,discarded,version,deferredError,immediateError,audio:'played/paused/resumed/stopped'};
    }''')
    print(json.dumps(result))
    browser.close()
