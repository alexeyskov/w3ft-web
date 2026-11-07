"""Real video Stop/seek/completion check, independent of the game executable."""
import json
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as temp:
    # A seekable file includes duration and cues, unlike streaming WebM on
    # stdout whose seek range may still be empty after loadedmetadata.
    fixture=Path(temp)/'fixture.webm'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=red:size=64x48:rate=24:duration=1',
                    '-an','-c:v','libvpx',str(fixture)],check=True)
    clip=fixture.read_bytes()
with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page()
    def route(request):
        path=request.request.url.rsplit('/',1)[-1]
        if path=='fixture.webm':
            start,end=0,len(clip)-1
            byte_range=request.request.headers.get('range')
            if byte_range:
                first,last=byte_range.removeprefix('bytes=').split('-')
                start=int(first or 0);end=min(int(last),end) if last else end
            headers={'Accept-Ranges':'bytes'}
            if byte_range:headers['Content-Range']=f'bytes {start}-{end}/{len(clip)}'
            request.fulfill(status=206 if byte_range else 200,content_type='video/webm',headers=headers,body=clip[start:end+1])
        elif path.endswith('.mjs'):request.fulfill(content_type='text/javascript',body=Path('web/runtime',path).read_text())
        else:request.fulfill(content_type='text/html',body='<section id="stage"><canvas width="320" height="240"></canvas></section>')
    page.route('http://localhost:6779/**',route)
    page.goto('http://localhost:6779/')
    result=page.evaluate('''async()=>{
      const {VideoDispatcher}=await import('/video-bridge.mjs'),events=[];
      const canvas=document.querySelector('canvas');
      const video=new VideoDispatcher({canvas,muted:true,onEvent:event=>events.push(event)});
      try{
        const metadata=await video.execute({id:1,method:'load',url:'/api/assets/fixture.webm'});
        const element=video.players.get(1).video;
        if(element.parentElement!==canvas.parentElement||!element.muted)throw Error('Video must be muted inside the fullscreen stage');
        canvas.style.width='640px';canvas.style.height='480px';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(parseFloat(element.style.width)!==640||parseFloat(element.style.height)!==480)throw Error('Video layout did not follow canvas resize');
        await video.execute({id:1,method:'seek',position:.5});
        await new Promise(resolve=>element.seeking?element.addEventListener('seeked',resolve,{once:true}):resolve());
        const stopped=await video.execute({id:1,method:'stop'});
        if(Math.abs(stopped.position-.5)>.05||!stopped.paused)throw Error('Stop must preserve position: '+JSON.stringify(stopped));
        await video.execute({id:1,method:'play'});
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('Natural video completion timed out')),5000);
          element.addEventListener('ended',()=>{clearTimeout(timer);resolve();},{once:true});
        });
        const final=await video.execute({id:1,method:'status'});
        if(!final.ended||events.filter(e=>e.event==='ended').length!==1)throw Error('Completion event');
        return {metadata,stopped:stopped.position,ended:final.position,events};
      }finally{video.destroy();if(document.querySelector('video'))throw Error('Video element leaked');}
    }''')
    print(json.dumps(result))
    browser.close()
