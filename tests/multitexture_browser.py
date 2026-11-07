"""Two independent fixed-function texture units compose actual WebGL pixels."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page()
    page.route('http://multitexture.test/**',lambda route:route.fulfill(
        content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
        body=Path('web/runtime/graphics.mjs').read_text() if route.request.url.endswith('.mjs')
        else '<canvas id="canvas" width="32" height="32"></canvas>'))
    page.goto('http://multitexture.test/')
    result=page.evaluate('''async()=>{
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');const canvas=document.getElementById('canvas');
      const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false}),r=new FixedFunctionGL(canvas,{context:gl}),pixels={};
      const set=(unit,rgba)=>{r.activeTexture(gl.TEXTURE0+unit);r.bindTexture(GL.TEXTURE_2D,r.genTexture());r.texImage2D(GL.TEXTURE_2D,0,GL.RGBA,rgba.length/4,1,0,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array(rgba));r.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);r.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);r.enable(GL.TEXTURE_2D);};
      const attributes={positions:new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),texcoords:new Float32Array([.25,.5,.25,.5,.25,.5]),texcoords1:new Float32Array([.75,.5,.75,.5,.75,.5])};
      const draw=(name,expected)=>{r.clear(GL.COLOR_BUFFER_BIT);r.drawArrays(GL.TRIANGLES,0,3,attributes);const p=new Uint8Array(4);gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);pixels[name]=[...p];if(p.some((v,i)=>Math.abs(v-expected[i])>1))throw Error(`${name}: ${p} != ${expected}`);};
      set(0,[255,128,64,128]);set(1,[128,255,128,128]);draw('modulate',[128,128,32,64]);
      r.disable(GL.TEXTURE_2D);draw('independentEnable',[255,128,64,128]);r.enable(GL.TEXTURE_2D);
      r.texEnvi(GL.TEXTURE_ENV,GL.TEXTURE_ENV_MODE,GL.ADD);draw('add',[255,255,192,64]);
      r.texEnvi(GL.TEXTURE_ENV,GL.TEXTURE_ENV_MODE,GL.MODULATE);
      set(0,[255,0,0,255,0,0,255,255]);set(1,[0,255,0,255,255,255,0,255]);draw('independentCoordinates',[255,0,0,255]);
      r.matrixMode(GL.TEXTURE);r.translate(-.5,0,0);draw('secondMatrix',[0,0,0,255]);
      r.activeTexture(gl.TEXTURE0);r.disable(GL.TEXTURE_2D);draw('secondUnitAlone',[0,255,0,255]);
      if(r._matrix(GL.TEXTURE)[12]!==0)throw Error('Texture matrix state leaked across units');
      const bound=r.boundTexture;r.deleteTexture(bound);if(r.textureUnits[0].boundTexture!==0||!r.textureUnits[1].boundTexture)throw Error('Deletion unbound wrong unit');
      r.destroy();return pixels;
    }''')
    print(json.dumps(result))
    browser.close()
