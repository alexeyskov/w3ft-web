"""Read real WebGL pixels for fixed-function lighting, independent of Warcraft."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page()
    page.route('http://lighting.test/**', lambda route: route.fulfill(
        content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
        body=Path('web/runtime/graphics.mjs').read_text() if route.request.url.endswith('.mjs')
        else '<canvas id="canvas" width="64" height="64"></canvas>'))
    page.goto('http://lighting.test/')
    result = page.evaluate('''async () => {
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');
      const canvas=document.getElementById('canvas'),gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});
      const r=new FixedFunctionGL(canvas,{context:gl}),pixels={};
      r.viewport(0,0,64,64);r.clearColor(0,0,0,0);
      const vertices=new Float32Array([-1,-1,0,1,-1,0,0,1,0]);
      const draw=(name,expected,positions=vertices)=>{
        r.clear(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT);r.drawArrays(GL.TRIANGLES,0,3,{positions});
        const pixel=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);pixels[name]=[...pixel];
        if(pixel.some((v,i)=>Math.abs(v-expected[i])>2))throw Error(`${name}: ${pixel} != ${expected}`);
      };
      r.color(0,1,0,.5);draw('unlit',[0,255,0,128]);
      r.enable(GL.LIGHTING);r.lightModelfv(GL.LIGHT_MODEL_AMBIENT,[0,0,0,1]);
      r.materialfv(GL.FRONT_AND_BACK,GL.DIFFUSE,[1,0,0,.5]);
      draw('noLights',[0,0,0,128]);r.enable(GL.LIGHT0);draw('directional',[255,0,0,128]);
      r.normal(0,0,-1);draw('away',[0,0,0,128]);r.normal(0,0,1);
      r.scale(1,1,2);draw('inverseTranspose',[128,0,0,128]);
      r.enable(GL.NORMALIZE);draw('normalize',[255,0,0,128]);r.disable(GL.NORMALIZE);r.loadIdentity();
      r.scale(2,2,2);r.enable(GL.RESCALE_NORMAL);draw('rescale',[255,0,0,128]);r.disable(GL.RESCALE_NORMAL);r.loadIdentity();
      r.colorMaterial(GL.FRONT_AND_BACK,GL.AMBIENT_AND_DIFFUSE);r.enable(GL.COLOR_MATERIAL);r.color(0,.5,1,.25);
      draw('colorMaterial',[0,128,255,64]);r.disable(GL.COLOR_MATERIAL);draw('retainedMaterial',[0,128,255,64]);
      r.lightModelfv(GL.LIGHT_MODEL_TWO_SIDE,[1]);r.materialfv(GL.BACK,GL.DIFFUSE,[0,1,0,1]);r.normal(0,0,-1);
      draw('backFace',[0,255,0,255],new Float32Array([-1,-1,0,0,1,0,1,-1,0]));
      r.normal(0,0,1);r.lightModelfv(GL.LIGHT_MODEL_TWO_SIDE,[0]);
      r.materialfv(GL.FRONT_AND_BACK,GL.DIFFUSE,[1,0,0,1]);
      r.lightfv(GL.LIGHT0,GL.SPOT_DIRECTION,[0,0,1]);r.lightfv(GL.LIGHT0,GL.SPOT_CUTOFF,[30]);
      draw('outsideSpot',[0,0,0,255]);r.lightfv(GL.LIGHT0,GL.SPOT_DIRECTION,[0,0,-1]);draw('insideSpot',[255,0,0,255]);
      r.lightfv(GL.LIGHT0,GL.SPOT_CUTOFF,[180]);r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,1]);r.lightfv(GL.LIGHT0,GL.CONSTANT_ATTENUATION,[2]);
      const attributes={positions:new Float32Array([0,0,0]),positionSize:3};
      const point=Array.from(r._litColors(attributes,1,0));if(Math.abs(point[0]-.5)>1e-6)throw Error('point attenuation '+point);
      r.loadIdentity();r.rotate(90,0,1,0);r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,0]);r.loadIdentity();
      draw('capturedLightTransform',[0,0,0,255]);
      r.destroy();return {pixels,point};
    }''')
    print(json.dumps(result))
    browser.close()
