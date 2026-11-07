"""WGL keeps partial frames private across browser tasks and presents on swap."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page()
    page.route('http://swap.test/**', lambda route: route.fulfill(
        content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
        body=Path('web/runtime/graphics.mjs').read_text() if route.request.url.endswith('.mjs')
        else '<canvas id="canvas" width="32" height="32"></canvas>'))
    page.goto('http://swap.test/')
    result=page.evaluate('''async () => {
      const {FixedFunctionGL,GL}=await import('/graphics.mjs');
      const r=new FixedFunctionGL(document.getElementById('canvas')),gl=r.gl,pixels={};
      const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const sample=(name,expected,front=true)=>{
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,front?null:r.backbuffer);
        const p=new Uint8Array(4);gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,r.backbuffer);pixels[name]=[...p];
        if(p.some((v,i)=>v!==expected[i]))throw Error(`${name}: ${p} != ${expected}`);
      };
      r.clearColor(1,0,0,1);r.clear(GL.COLOR_BUFFER_BIT);await tick();
      sample('backRed',[255,0,0,255],false);sample('frontBeforeSwap',[0,0,0,255]);
      r.swapBuffers();await tick();sample('firstFrame',[255,0,0,255]);
      r.clearColor(0,1,0,1);r.clear(GL.COLOR_BUFFER_BIT);await tick();
      sample('frontDuringNextFrame',[255,0,0,255]);sample('backGreen',[0,255,0,255],false);
      r.enable(GL.SCISSOR_TEST);r.scissor(0,0,1,1);r.swapBuffers();await tick();
      sample('swapIgnoresScissor',[0,255,0,255]);if(!r.isEnabled(GL.SCISSOR_TEST))throw Error('Lost scissor state');
      r.disable(GL.SCISSOR_TEST);r.canvas.width=64;r.canvas.height=64;r.viewport(0,0,64,64);
      r.clearColor(0,0,1,1);r.clear(GL.COLOR_BUFFER_BIT);r.swapBuffers();await tick();sample('resized',[0,0,255,255]);
      r.fillRect(0,0,64,64,0x0000ff);sample('gdiFront',[255,0,0,255]);sample('gdiPreservesBack',[0,0,255,255],false);
      // SetDeviceGammaRamp applies to presented pixels only, like a display.
      const curve=value=>Math.round(Math.sqrt(value/255)*65535),ramp=Uint16Array.from({length:768},(_,i)=>curve(i&255));
      const shown=value=>Math.round(curve(value)/257);
      r.setGammaRamp(ramp);r.clearColor(64/255,128/255,1,1);r.clear(GL.COLOR_BUFFER_BIT);r.swapBuffers();await tick();
      sample('gammaFront',[shown(64),shown(128),255,255]);sample('gammaKeepsBack',[64,128,255,255],false);
      r.clearColor(1,0,0,1);r.clear(GL.COLOR_BUFFER_BIT);r.swapBuffers();await tick();sample('gammaNextFrame',[255,0,0,255]);
      r.setGammaRamp(Uint16Array.from({length:768},(_,i)=>(i&255)*257));r.clearColor(64/255,128/255,1,1);r.clear(GL.COLOR_BUFFER_BIT);r.swapBuffers();await tick();
      sample('identityRamp',[64,128,255,255]);
      // The gamma option's exponent runs before the display ramp (here doubling).
      const exponent=value=>Math.round(Math.pow(value/255,0.5)*255);
      r.setGammaExponent(0.5);r.swapBuffers();await tick();sample('gammaOption',[exponent(64),exponent(128),255,255]);
      r.setGammaRamp(Uint16Array.from({length:768},(_,i)=>Math.min(65535,(i&255)*2*257)));r.swapBuffers();await tick();
      sample('optionThenRamp',[Math.min(255,exponent(64)*2),Math.min(255,exponent(128)*2),255,255]);
      r.setGammaExponent(1);r.setGammaRamp(Uint16Array.from({length:768},(_,i)=>(i&255)*257));r.swapBuffers();await tick();sample('gammaOff',[64,128,255,255]);
      const stats=r.stats();r.destroy();return {pixels,stats};
    }''')
    print(json.dumps(result))
    browser.close()
