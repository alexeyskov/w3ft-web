"""Actual WebGL2 fog pixels; this is a renderer-component test, not Warcraft."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page()

    def route(request):
        if request.request.url.endswith('/graphics.mjs'):
            request.fulfill(content_type='text/javascript', body=Path('web/runtime/graphics.mjs').read_text())
        else:
            request.fulfill(content_type='text/html', body='<canvas id="canvas" width="64" height="64"></canvas>')

    page.route('http://fog.test/**', route)
    page.goto('http://fog.test/')
    result = page.evaluate('''async () => {
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');
      const canvas=document.getElementById('canvas');
      const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});
      const renderer=new FixedFunctionGL(canvas,{context:gl});
      renderer.viewport(0,0,64,64);renderer.clearColor(0,0,0,0);renderer.color(1,0,0,.25);
      const pixel=(x=32,y=32)=>{const bytes=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return [...bytes];};
      const near=(actual,expected,label)=>{if(actual.some((v,i)=>Math.abs(v-expected[i])>2))throw Error(`${label}: ${actual} != ${expected}`);};
      const expected=f=>[Math.round(f*255),0,Math.round((1-f)*255),64];
      const quad=(left,right=left,perspective=false)=>({positions:new Float32Array([
        -(perspective?left:1),-(perspective?left:1),-left,
        perspective?right:1,-(perspective?right:1),-right,
        -(perspective?left:1),perspective?left:1,-left,
        perspective?right:1,perspective?right:1,-right,
      ])});
      const draw=geometry=>{renderer.clear(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT);renderer.drawArrays(GL.TRIANGLE_STRIP,0,4,geometry);};
      renderer.matrixMode(GL.PROJECTION);renderer.ortho(-1,1,-1,1,0,10);renderer.matrixMode(GL.MODELVIEW);
      if(renderer.isEnabled(GL.FOG)||renderer.fog.mode!==GL.EXP||renderer.fog.density!==1)throw Error('incorrect default fog state');
      renderer.fogfv(GL.FOG_COLOR,[0,0,1,1]);renderer.fogf(GL.FOG_START,1);renderer.fogf(GL.FOG_END,5);renderer.fogf(GL.FOG_DENSITY,.5);renderer.enable(GL.FOG);
      const modes={};
      for(const [mode,factor] of [[GL.LINEAR,.5],[GL.EXP,Math.exp(-1.5)],[GL.EXP2,Math.exp(-2.25)]]){
        renderer.fogf(GL.FOG_MODE,mode);draw(quad(3));modes[mode]=pixel();near(modes[mode],expected(factor),'mode '+mode);
      }
      renderer.disable(GL.FOG);draw(quad(3));const disabled=pixel();near(disabled,[255,0,0,64],'disabled');
      renderer.enable(GL.FOG);renderer.fogf(GL.FOG_MODE,GL.LINEAR);
      draw(quad(.5));near(pixel(),expected(1),'before start');draw(quad(7));near(pixel(),expected(0),'after end');
      renderer.translate(0,0,-3);draw(quad(0));near(pixel(),expected(.5),'modelview eye depth');renderer.loadIdentity();
      draw(quad(1,5));const interpolated=[pixel(16),pixel(48)];
      [16,48].forEach((x,i)=>near(interpolated[i],expected(1-(x+.5)/64),'orthographic interpolation'));
      renderer.matrixMode(GL.PROJECTION);renderer.loadIdentity();renderer.frustum(-1,1,-1,1,1,10);renderer.matrixMode(GL.MODELVIEW);renderer.fogf(GL.FOG_END,7);
      draw(quad(2,6,true));const perspective=[pixel(16),pixel(48)];
      [16,48].forEach((x,i)=>{const t=(x+.5)/64,depth=1/((1-t)/2+t/6);near(perspective[i],expected((7-depth)/6),'perspective interpolation');});
      renderer.matrixMode(GL.PROJECTION);renderer.loadIdentity();renderer.ortho(-1,1,-1,1,0,10);renderer.matrixMode(GL.MODELVIEW);renderer.fogf(GL.FOG_END,5);
      renderer.enable(GL.ALPHA_TEST);renderer.alphaFunc(GL.GREATER,.5);draw(quad(3));near(pixel(),[0,0,0,0],'fog must preserve fragment alpha');renderer.disable(GL.ALPHA_TEST);
      const texture=renderer.genTexture();renderer.bindTexture(GL.TEXTURE_2D,texture);renderer.texImage2D(GL.TEXTURE_2D,0,GL.RGBA,1,1,0,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([0,255,0,255]));renderer.texParameteri(GL.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);renderer.enable(GL.TEXTURE_2D);renderer.texEnvi(GL.TEXTURE_ENV,GL.TEXTURE_ENV_MODE,GL.REPLACE);draw(quad(3));const textured=pixel();near(textured,[0,128,128,255],'fog after texture');renderer.disable(GL.TEXTURE_2D);
      const failures=[];
      for(const call of [()=>renderer.fogf(GL.FOG_MODE,123),()=>renderer.fogf(GL.FOG_DENSITY,-1),()=>renderer.fogf(0xffff,1),()=>renderer.fogfv(GL.FOG_COLOR,[1,0])]){
        try{call();throw Error('invalid fog call succeeded');}catch(error){if(error.name!=='GraphicsError')throw error;failures.push(error.message);}
      }
      if(renderer.fog.mode!==GL.LINEAR||renderer.fog.density!==.5)throw Error('invalid parameter changed valid state');
      renderer.fogf(GL.FOG_END,1);let undefinedRange=false;try{draw(quad(3));}catch(error){undefinedRange=/undefined/.test(error.message);}if(!undefinedRange)throw Error('undefined linear range was accepted');
      renderer.destroy();return {modes,disabled,interpolated,perspective,textured,invalidCalls:failures.length};
    }''')
    print(json.dumps(result))
    browser.close()
