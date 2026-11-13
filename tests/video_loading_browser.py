"""Video load budgets, cached-file fallback and cancellation through a real worker."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import Error as PlaywrightError, sync_playwright
from video_autoplay_browser import fixture_server

BRIDGE = """async ({cached=false,abandon=false}={}) => {
  const {VideoDispatcher}=await import('/video-bridge.mjs');
  window.messages=[];const sources=new Map();
  const blob=cached?URL.createObjectURL(new Blob(['unreadable cached movie'],{type:'video/webm'})):null;
  if(blob)sources.set('/api/assets/fixture.webm',blob);
  const dispatcher=window.dispatcher=new VideoDispatcher({canvas:document.querySelector('canvas'),sources,
    loadTimeout:abandon?2000:600,metadataTimeout:abandon?2000:200,retryDelay:10,log:message=>messages.push(message)});
  const module=new URL('/video-bridge.mjs',location.href).href;
  const workerURL=URL.createObjectURL(new Blob([`
    import {WorkerVideo} from ${JSON.stringify(module)};
    const video=new WorkerVideo({timeout:${abandon?100:2000},movies:new Map([
      ['movies/introx.mpq',{downloadUrl:'/api/assets/fixture.webm',frameRate:'24/1'}]
    ])});
    const id=video.create(()=>{});let result;
    try{result={metadata:video.load(id,'Movies/IntroX.mpq')};}
    catch(error){result={error:error.message,details:error.details};}
    video.release(id);postMessage({type:'result',...result});
  `],{type:'text/javascript'}));
  const worker=new Worker(workerURL,{type:'module'}),start=performance.now();
  try{
    const result=await new Promise((resolve,reject)=>{
      worker.onerror=event=>reject(Error(event.message));
      worker.onmessage=({data})=>{
        if(data.type==='video'){
          if(abandon)delete data.deadline; // Simulate an old/late dispatcher while the worker times out.
          void dispatcher.handle(data).catch(reject);
        }else if(data.type==='result')resolve(data);
      };
    });
    await new Promise(resolve=>setTimeout(resolve,50));
    return {...result,elapsed:performance.now()-start,players:dispatcher.players.size,elements:document.querySelectorAll('video').length,messages};
  }finally{worker.terminate();dispatcher.destroy();URL.revokeObjectURL(workerURL);if(blob)URL.revokeObjectURL(blob);}
}"""


def main():
    with tempfile.TemporaryDirectory() as temp:
        fixture = Path(temp) / 'fixture.webm'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:size=64x48:rate=24:duration=1',
                        '-an', '-c:v', 'libvpx', str(fixture)], check=True)
        clip = fixture.read_bytes()
    with fixture_server(clip, setup='async()=>({ready:true})') as url, sync_playwright() as playwright:
        for engine in ('chromium', 'webkit'):
            browser = getattr(playwright, engine).launch()
            try:
                for case in ('normal', 'cached', 'stalled', 'abandoned', 'cancel-retry'):
                    context = browser.new_context()
                    held_routes = []
                    try:
                        page = context.new_page()
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        requests = []
                        page.on('request', lambda request: requests.append(request.url) if '/api/assets/' in request.url else None)
                        if case in ('stalled', 'abandoned'):
                            page.route('**/api/assets/fixture.webm', lambda route: held_routes.append(route))
                        page.goto(url)
                        if case == 'cancel-retry':
                            page.evaluate("""async()=>{
                              const {VideoDispatcher}=await import('/video-bridge.mjs');
                              window.messages=[];
                              window.badBlob=URL.createObjectURL(new Blob(['broken'],{type:'video/webm'}));
                              window.dispatcher=new VideoDispatcher({sources:new Map([['/api/assets/fixture.webm',badBlob]]),retryDelay:250,log:m=>messages.push(m)});
                              window.loadResult=dispatcher.execute({id:1,method:'load',url:'/api/assets/fixture.webm'}).catch(e=>({cancelled:e.cancelled}));
                            }""")
                            page.wait_for_function('messages.length > 0')
                            result = page.evaluate('async()=>{dispatcher.destroy();URL.revokeObjectURL(badBlob);return await loadResult;}')
                            assert result == {'cancelled': True}, result
                            assert requests == [], requests
                            assert page.locator('video').count() == 0
                        else:
                            result = page.evaluate(BRIDGE, {'cached': case == 'cached', 'abandon': case == 'abandoned'})
                            assert result['players'] == result['elements'] == 0, result
                            if case in ('normal', 'cached'):
                                assert result['metadata']['width'] == 64, result
                                if case == 'cached':
                                    assert any('device cache' in message for message in result['messages']), result
                                    assert requests, 'Failed cached Blob was not retried from the server'
                            else:
                                assert result['details']['reason'] == ('timeout' if case == 'abandoned' else 'media'), result
                                assert result['elapsed'] < 1800, 'Retries exceeded the worker RPC budget'
                        assert not errors, errors
                        print(json.dumps({'browser': engine, 'case': case, 'passed': True}), flush=True)
                    finally:
                        for route in held_routes:
                            try:
                                route.abort()
                            except PlaywrightError:
                                pass  # The simulated stalled request was already cancelled by the player.
                        context.close()
            finally:
                browser.close()


if __name__ == '__main__':
    main()
