"""Real Chromium workers exercise shared-buffer HLE RPC, without game code."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKER = """
import {GuestCallProxy,serializeGuestError} from '/thread-rpc.mjs';
onmessage=event=>{
  const {memory,cpu}=event.data,proxy=new GuestCallProxy({timeout:5000}),results=[];
  for(const id of [1,2,3]){
    try{proxy.call(id,cpu);results.push({value:new DataView(memory).getUint32(cpu,true)});}
    catch(error){results.push({error:serializeGuestError(error)});}
  }
  postMessage({type:'result',results});
};
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        context = browser.new_context()

        def route(request):
            name = request.request.url.rsplit('/', 1)[-1]
            headers = {'Cross-Origin-Opener-Policy': 'same-origin',
                       'Cross-Origin-Embedder-Policy': 'require-corp',
                       'Cross-Origin-Resource-Policy': 'same-origin'}
            if name == 'thread-rpc.mjs':
                content, kind = (ROOT / 'web/runtime/thread-rpc.mjs').read_text(), 'text/javascript'
            elif name == 'fixture.mjs':
                content, kind = WORKER, 'text/javascript'
            else:
                content, kind = '<!doctype html><title>Guest RPC fixture</title>', 'text/html'
            request.fulfill(content_type=kind, headers=headers, body=content)

        context.route('http://localhost:6778/**', route)
        page = context.new_page()
        page.goto('http://localhost:6778/')
        result = page.evaluate("""async()=>{
          if(!crossOriginIsolated)throw Error('cross-origin isolation missing');
          const {serveGuestCall}=await import('/thread-rpc.mjs');
          const memory=new SharedArrayBuffer(128),workers=[];
          let entered=0,active=0,maximum=0,release;
          const together=new Promise(resolve=>release=resolve);
          try{
            const results=await Promise.all([16,32].map(cpu=>new Promise((resolve,reject)=>{
              const worker=new Worker('/fixture.mjs',{type:'module'});workers.push(worker);
              const timer=setTimeout(()=>reject(Error('browser RPC timed out')),10000);
              worker.onerror=e=>reject(Error(e.message));
              worker.onmessage=async e=>{
                if(e.data.type==='result'){clearTimeout(timer);resolve(e.data.results);return;}
                try{await serveGuestCall(e.data,async(id,pointer)=>{
                  maximum=Math.max(maximum,++active);
                  if(++entered===2)release();await together;
                  await new Promise(r=>setTimeout(r,1));active--;
                  if(id===2)throw Object.assign(new Error('Ошибка гостевого потока'),{name:'GuestThreadExit',code:72,details:{cpu:pointer}});
                  new DataView(memory).setUint32(pointer,100+id,true);
                });}catch(error){clearTimeout(timer);reject(error);}
              };
              worker.postMessage({cpu,memory});
            })));
            return {maximum,results};
          }finally{workers.forEach(worker=>worker.terminate());}
        }""")
        assert result['maximum'] == 2, result
        for cpu, calls in zip([16, 32], result['results']):
            assert calls[0]['value'] == 101 and calls[2]['value'] == 103, result
            assert calls[1]['error'] == {'name': 'GuestThreadExit', 'message': 'Ошибка гостевого потока',
                                         'code': 72, 'details': {'cpu': cpu}}, result
        print(json.dumps(result, ensure_ascii=False))
    finally:
        browser.close()
