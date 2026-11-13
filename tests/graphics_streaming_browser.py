"""Real pixels for ring uploads, including wrap, mixed attributes and indices."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    try:
        page = browser.new_page()
        page.route('http://stream.test/**', lambda route: route.fulfill(
            content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
            body=Path('web/runtime/graphics.mjs').read_text() if route.request.url.endswith('.mjs')
            else '<canvas id="canvas" width="64" height="64"></canvas>'))
        page.goto('http://stream.test/')
        result = page.evaluate('''async () => {
          const {FixedFunctionGL,GL}=await import('/graphics.mjs');
          const r=new FixedFunctionGL(document.getElementById('canvas'),{debugChecks:true,streamingBuffers:true}),gl=r.gl;
          r.clearColor(0,0,0,1);r.clear(GL.COLOR_BUFFER_BIT);
          const vertices=new Float32Array([-1,-1,0,1,-1,0,0,1,0]),colors=[[1,0,0,1],[0,1,0,1],[0,0,1,1],[1,1,0,1]];
          const pixels=[];
          for(let i=0;i<4;i++){
            r.viewport((i&1)*32,(i>>1)*32,32,32);r.color(...colors[i]);
            // Force orphaning with an earlier draw still submitted. The GPU
            // must keep that draw's vertex and index storage until consumed.
            if(i===2){r.vertexStream.offset=r.vertexStream.capacity-4;r.indexStream.offset=r.indexStream.capacity-4;}
            const attributes=i===1?{positions:vertices,colors:new Float32Array(Array(3).fill(colors[i]).flat())}:{positions:vertices};
            const indices=i===0?new Uint8Array([0,1,2]):i===1?new Uint16Array([0,1,2]):new Uint32Array([0,1,2]);
            r.drawElements(GL.TRIANGLES,indices,attributes);
          }
          for(let i=0;i<4;i++){
            const pixel=new Uint8Array(4);gl.readPixels((i&1)*32+16,(i>>1)*32+16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
            const expected=colors[i].map(x=>x*255);if(pixel.some((v,j)=>v!==expected[j]))throw Error(`${i}: ${pixel} != ${expected}`);pixels.push([...pixel]);
          }
          if(r.vertexStream.allocations!==2||r.indexStream.allocations!==2)throw Error('missing ring reuse/wrap');
          // Raw interleaved bytes at a nonzero streaming offset.
          r.viewport(0,0,64,64);r.clear(GL.COLOR_BUFFER_BIT);
          const data=new Uint8Array(3*16),view=new DataView(data.buffer);
          for(let v=0;v<3;v++){for(let c=0;c<3;c++)view.setFloat32(v*16+c*4,vertices[v*3+c],true);data.set([255,0,255,255],v*16+12);}
          r.drawArrays(GL.TRIANGLES,0,3,{raw:{position:{bytes:data,size:3,type:GL.FLOAT,stride:16,offset:0},color:{bytes:data,size:4,type:GL.UNSIGNED_BYTE,stride:16,offset:12}}});
          const rawPixel=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rawPixel);
          if([...rawPixel].join(',')!=='255,0,255,255')throw Error('interleaved '+rawPixel);
          r.drawElements(GL.TRIANGLES,new Uint16Array(0),{positions:new Float32Array(0)});
          const counts={vertex:r.vertexStream.allocations,index:r.indexStream.allocations};r.destroy();return{pixels,rawPixel:[...rawPixel],allocations:counts};
        }''')
        print(json.dumps(result))
    finally:
        browser.close()
