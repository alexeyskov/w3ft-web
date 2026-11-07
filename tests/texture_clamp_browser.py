"""Compare real WebGL pixels to legacy texture-border and mip-filter semantics."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page()
    page.route('http://textures.test/**', lambda route: route.fulfill(
        content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
        body=Path('web/runtime/graphics.mjs').read_text() if route.request.url.endswith('.mjs')
        else '<canvas id="canvas" width="64" height="64"></canvas>'))
    page.goto('http://textures.test/')
    result = page.evaluate('''async () => {
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');
      const canvas=document.getElementById('canvas'),gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});
      const r=new FixedFunctionGL(canvas,{context:gl}),pixels={};
      r.bindTexture(GL.TEXTURE_2D,r.genTexture());r.enable(GL.TEXTURE_2D);
      const parameter=(name,value)=>r.texParameteri(GL.TEXTURE_2D,gl[name],value);
      const upload=(level,size,rgba)=>r.texImage2D(GL.TEXTURE_2D,level,GL.RGBA,size,size,0,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array(Array.from({length:size*size},()=>rgba).flat()));
      upload(0,4,[255,0,0,255]);
      parameter('TEXTURE_MIN_FILTER',GL.LINEAR);parameter('TEXTURE_MAG_FILTER',GL.LINEAR);
      parameter('TEXTURE_WRAP_S',GL.CLAMP);parameter('TEXTURE_WRAP_T',GL.CLAMP);
      const positions=new Float32Array([-1,-1,0,3,-1,0,-1,3,0]);
      const draw=(name,expected,s,t,lod=-20)=>{
        const gradient=16*Math.pow(2,lod),left=s-gradient*32.5/64;
        const texcoords=new Float32Array([left,t,left+2*gradient,t,left,t]);
        r.clear(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT);r.drawArrays(GL.TRIANGLES,0,3,{positions,texcoords});
        const pixel=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);pixels[name]=[...pixel];
        if(pixel.some((v,i)=>Math.abs(v-expected[i])>2))throw Error(`${name}: ${pixel} != ${expected}`);
      };
      draw('interior',[255,0,0,255],.5,.5);
      draw('leftEdge',[128,0,0,128],0,.5);draw('rightEdge',[128,0,0,128],1,.5);
      draw('outsideLeft',[128,0,0,128],-3,.5);draw('outsideRight',[128,0,0,128],3,.5);
      draw('corner',[64,0,0,64],0,0);
      parameter('TEXTURE_MAG_FILTER',GL.NEAREST);draw('nearestEdge',[255,0,0,255],1,.5);
      parameter('TEXTURE_MAG_FILTER',GL.LINEAR);parameter('TEXTURE_MIN_FILTER',GL.NEAREST);
      draw('nearestMinification',[255,0,0,255],0,.5,1);
      parameter('TEXTURE_MIN_FILTER',GL.LINEAR);parameter('TEXTURE_WRAP_T',GL.REPEAT);
      draw('repeatOtherAxis',[128,0,0,128],0,-4.5);
      r.texParameterfv(GL.TEXTURE_2D,0x1004,[0,1,0,1]);draw('customBorder',[128,128,0,255],0,.5);
      parameter('TEXTURE_WRAP_S',GL.CLAMP_TO_BORDER);draw('fullBorder',[0,255,0,255],-1,.5);
      parameter('TEXTURE_WRAP_S',GL.CLAMP_TO_EDGE);draw('edgeMode',[255,0,0,255],-1,.5);
      parameter('TEXTURE_WRAP_S',GL.CLAMP);r.texParameterfv(GL.TEXTURE_2D,0x1004,[0,0,0,0]);
      upload(1,2,[0,255,0,255]);upload(2,1,[0,0,255,255]);
      parameter('TEXTURE_MIN_FILTER',gl.LINEAR_MIPMAP_LINEAR);
      draw('firstMipBlend',[64,64,0,128],0,.5,.5);
      draw('secondMip',[0,128,0,128],0,.5,1);
      draw('lastMipBlend',[0,64,64,128],0,.5,1.5);
      parameter('TEXTURE_MIN_FILTER',gl.NEAREST_MIPMAP_NEAREST);
      draw('magnificationTransition',[128,0,0,128],0,.5,.25);
      draw('nearestMip',[0,255,0,255],0,.5,.75);
      parameter('TEXTURE_MIN_FILTER',gl.LINEAR_MIPMAP_NEAREST);
      draw('linearMip',[0,128,0,128],0,.5,.75);
      upload(1,1,[0,255,0,255]);draw('incompleteDisablesTexture',[255,255,255,255],0,.5,1);
      parameter('TEXTURE_MIN_FILTER',GL.NEAREST);parameter('TEXTURE_MAG_FILTER',GL.NEAREST);
      r.texImage2D(GL.TEXTURE_2D,0,0x8057,1,1,0,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([128,64,32,200]));
      draw('rgb5a1',[132,66,33,255],.5,.5);
      r.texSubImage2D(GL.TEXTURE_2D,0,0,0,1,1,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([128,64,32,50]));
      draw('rgb5a1Subimage',[132,66,33,0],.5,.5);
      r.texImage2D(GL.TEXTURE_2D,0,0x8050,1,1,0,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([128,64,32,0]));
      draw('rgb5',[132,65,33,255],.5,.5);
      r.texSubImage2D(GL.TEXTURE_2D,0,0,0,1,1,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([0,0,255,0]));
      draw('rgb5Subimage',[0,0,255,255],.5,.5);
      r.destroy();return pixels;
    }''')
    print(json.dumps(result))
    browser.close()
