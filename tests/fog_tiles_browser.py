"""Regression for the actual Warcraft fog-tile UVs and Windows clamp profile.

The game draws RGBA8 fog tiles with constant (0,0,0,230) texels and UVs
0.0390625..0.9765625. Strict GL_CLAMP samples the transparent border at the
far edge. The game's compatibility profile must retain opaque fog there.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    try:
        page = browser.new_page()

        def route(request):
            if request.request.url.endswith('/graphics.mjs'):
                request.fulfill(content_type='text/javascript', body=Path('web/runtime/graphics.mjs').read_text())
            else:
                request.fulfill(content_type='text/html', body='<body></body>')

        page.route('http://fog-tiles.test/**', route)
        page.goto('http://fog-tiles.test/')
        result = page.evaluate('''async () => {
          const {FixedFunctionGL,GL}=await import('/graphics.mjs');
          const results={};
          for(const legacyClampToEdge of [false,true]){
            const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;
            const renderer=new FixedFunctionGL(canvas,{legacyClampToEdge}),gl=renderer.gl;
            renderer.clearColor(180/255,96/255,24/255,1);
            const texture=renderer.genTexture();renderer.bindTexture(GL.TEXTURE_2D,texture);
            const fog=new Uint8Array(16*16*4);for(let i=3;i<fog.length;i+=4)fog[i]=230;
            renderer.texImage2D(GL.TEXTURE_2D,0,gl.RGBA8,16,16,0,GL.RGBA,GL.UNSIGNED_BYTE,fog);
            renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,GL.LINEAR);
            renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,GL.LINEAR);
            renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_WRAP_S,GL.CLAMP);
            renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_WRAP_T,GL.CLAMP);
            renderer.enable(GL.TEXTURE_2D);renderer.enable(GL.BLEND);renderer.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
            renderer.clear(GL.COLOR_BUFFER_BIT);
            for(const left of [-1,0])renderer.drawArrays(GL.TRIANGLE_STRIP,0,4,{
              positions:new Float32Array([left,-1,0,left+1,-1,0,left,1,0,left+1,1,0]),
              texcoords:new Float32Array([.0390625,.0390625,.9765625,.0390625,.0390625,.9765625,.9765625,.9765625]),
            });
            const row=new Uint8Array(256*4);gl.readPixels(0,32,256,1,gl.RGBA,gl.UNSIGNED_BYTE,row);
            const pixel=x=>Array.from(row.slice(x*4,x*4+3));
            const interior=pixel(64),seam=pixel(127);
            if(legacyClampToEdge){
              for(let x=0;x<256;x++)if(pixel(x).some((v,i)=>Math.abs(v-interior[i])>1))throw Error(`fog seam at ${x}: ${pixel(x)} vs ${interior}`);
              if(renderer.textures.get(texture).wrapS!==GL.CLAMP)throw Error('compatibility changed guest texture state');
              // Explicit border requests must still sample the border, including
              // applications setting a non-default opaque border color.
              renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_WRAP_S,GL.CLAMP_TO_BORDER);
              renderer.texParameterfv(GL.TEXTURE_2D,0x1004,[0,0,1,1]);
              renderer.clear(GL.COLOR_BUFFER_BIT);
              renderer.drawArrays(GL.TRIANGLE_STRIP,0,4,{
                positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
                texcoords:new Float32Array([2,.5,2,.5,2,.5,2,.5]),
              });
              const border=new Uint8Array(4);gl.readPixels(128,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,border);
              if(border[0]||border[1]||border[2]!==255)throw Error(`explicit border changed: ${border}`);
            }else if(seam[0]<interior[0]+8)throw Error(`strict GL_CLAMP no longer samples border: ${seam} vs ${interior}`);
            renderer.swapBuffers();results[legacyClampToEdge?'warcraft':'strict']={interior,seam};renderer.destroy();
          }
          return results;
        }''')
        print(json.dumps(result))
    finally:
        browser.close()
