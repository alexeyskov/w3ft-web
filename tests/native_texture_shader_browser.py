"""Pixel equivalence between full GL sampling and the native shader variant."""
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

        page.route('http://native-sampler.test/**', route)
        page.goto('http://native-sampler.test/')
        result = page.evaluate('''async () => {
          const {FixedFunctionGL,GL}=await import('/graphics.mjs');
          function run(nativeTextureShader){
            const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
            const r=new FixedFunctionGL(canvas,{nativeTextureShader}),g=r.gl;
            const textures=[];
            for(let unit=0;unit<2;unit++){
              r.activeTexture(g.TEXTURE0+unit);const id=r.genTexture();textures.push(id);r.bindTexture(GL.TEXTURE_2D,id);
              for(let level=0;level<3;level++){
                const size=4>>level,pixels=new Uint8Array(size*size*4);
                for(let i=0;i<size*size;i++)pixels.set([(i*53+level*71+unit*29)%256,(i*37+level*19)%256,(i*19+unit*103)%256,128+i%2*127],i*4);
                r.texImage2D(GL.TEXTURE_2D,level,g.RGBA8,size,size,0,GL.RGBA,GL.UNSIGNED_BYTE,pixels);
              }
              r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.LINEAR_MIPMAP_LINEAR);
              r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.LINEAR);
              r.enable(GL.TEXTURE_2D);
            }
            r.activeTexture(g.TEXTURE0);r.clearColor(.1,.2,.3,1);
            const quad={positions:new Float32Array([-1,-1,-.2,1,-1,-.2,-1,1,-.2,1,1,-.2]),
              texcoords:new Float32Array([-1,-.5,0,1,5,-.5,0,2,-1,4,0,1,5,4,0,2]),texcoordSize:4,
              texcoords1:new Float32Array([0,0,2,0,0,2,2,2]),
              colors:new Float32Array([1,.5,1,1,.5,1,1,1,1,1,.5,1,1,1,1,1])};
            const frames=[];
            const draw=(label,nativeExpected,attributes=quad)=>{
              r.clear(GL.COLOR_BUFFER_BIT);r.drawArrays(GL.TRIANGLE_STRIP,0,4,attributes);
              if(nativeTextureShader&&r.nativeProgramActive!==nativeExpected)throw Error(label+' selected wrong shader');
              const pixels=new Uint8Array(64*64*4);g.readPixels(0,0,64,64,g.RGBA,g.UNSIGNED_BYTE,pixels);frames.push({label,pixels});
            };
            for(const wrap of [GL.REPEAT,GL.MIRRORED_REPEAT,GL.CLAMP_TO_EDGE]){
              for(let unit=0;unit<2;unit++){r.activeTexture(g.TEXTURE0+unit);r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_S,wrap);r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_T,wrap);}
              r.activeTexture(g.TEXTURE0);draw('wrap-'+wrap,true);
            }
            // Native -> border -> native must refresh program-specific uniforms
            // and retain the VAO's attribute arrays and constant values.
            r.activeTexture(g.TEXTURE1);r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_S,GL.CLAMP_TO_BORDER);
            r.texParameterfv(GL.TEXTURE_2D,0x1004,[1,0,.5,.8]);draw('unit1-border',false);
            r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_S,GL.REPEAT);r.texEnvi(GL.TEXTURE_ENV,GL.TEXTURE_ENV_MODE,GL.ADD);
            r.activeTexture(g.TEXTURE0);r.color(.5,.75,.25,.8);draw('native-constant-color',true,{...quad,colors:undefined});
            r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_S,GL.CLAMP);draw('strict-clamp',false);
            r.legacyClampToEdge=true;draw('legacy-clamp',true);
            r.enable(GL.FOG);r.fogf(GL.FOG_MODE,GL.LINEAR);r.fogf(GL.FOG_START,0);r.fogf(GL.FOG_END,1);r.fogfv(GL.FOG_COLOR,[.1,.3,.7,1]);
            r.enable(GL.ALPHA_TEST);r.alphaFunc(GL.GREATER,.6);r.shadeModel(GL.FLAT);draw('fog-alpha-flat',true);
            r.activeTexture(g.TEXTURE1);r.texParameteri(GL.TEXTURE_2D,g.TEXTURE_WRAP_T,GL.CLAMP_TO_BORDER);r.disable(GL.TEXTURE_2D);
            draw('disabled-border-stage',true);
            r.activeTexture(g.TEXTURE0);r.disable(GL.TEXTURE_2D);draw('untextured',true,{positions:quad.positions});
            r.swapBuffers();const stats=r.stats();r.destroy();return{frames,stats};
          }
          const full=run(false),native=run(true);
          for(let i=0;i<full.frames.length;i++){
            const a=full.frames[i],b=native.frames[i];
            if(a.pixels.some((v,j)=>v!==b.pixels[j]))throw Error('native pixel difference: '+a.label);
          }
          if(!native.stats.nativeDraws||!native.stats.borderDraws||full.stats.nativeDraws)throw Error('shader counters incorrect');
          return{cases:native.frames.map(f=>f.label),nativeDraws:native.stats.nativeDraws,borderDraws:native.stats.borderDraws};
        }''')
        print(json.dumps(result))
    finally:
        browser.close()
