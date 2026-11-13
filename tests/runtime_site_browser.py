#!/usr/bin/env python3
"""Boot the actual packaged Warcraft through the site's main launch button.

Records an original-menu screenshot and the real WASM report. Print Screen in
the menu must give a PNG download of the frame, which stays out of the saves.
This checks site integration, not completion of a campaign or a multiplayer
acceptance test.
--browser firefox or webkit runs the same check in another engine.
--no-tail-calls makes the page see a browser without WebAssembly tail calls
(Safari before 18.2, Chrome before 112, Firefox before 121): the game must
run its compatible build, wc3-compat.wasm.
--autoplay-denied play/skip rejects cinematic autoplay like iPhone until a
trusted tap on the prompt; the original game must still reach its menu.
--video-load-stalled never provides video metadata, including from a cached
Blob. The real game must skip the cinematic and reach its working menu.
"""
import argparse
import json
import struct
import time
from pathlib import Path
from playwright.sync_api import Error as PlaywrightError, sync_playwright

# The page's tail-call probe fails, as in a browser without them; every other
# module validates as usual.
NO_TAIL_CALLS = """{
  const validate = WebAssembly.validate, probe = '0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,3,2,0,0,10,11,2,4,0,65,0,11,4,0,18,0,11';
  WebAssembly.validate = function (bytes, ...rest) {
    return ArrayBuffer.isView(bytes) && String(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)) === probe ? false : validate.call(this, bytes, ...rest);
  };
}"""


def main(url,output,resolution='1024x768',mute=False,engine='chromium',tail_calls=True,autoplay_denied=None,video_load_stalled=False):
    output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        # Each engine's way to allow sound and video without a user gesture.
        if engine=='chromium':browser=p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        elif engine=='firefox':browser=p.firefox.launch(firefox_user_prefs={'media.autoplay.default':0,'media.autoplay.blocking_policy':0})
        else:browser=p.webkit.launch()
        page=browser.new_page(viewport={'width':1440,'height':1100},accept_downloads=True,has_touch=bool(autoplay_denied))
        held_routes=[]
        if autoplay_denied or video_load_stalled:
            page.add_init_script('''{
              const OriginalWorker=Worker;
              window.Worker=class extends OriginalWorker {
                postMessage(message,...rest){
                  if(message?.type==='start'&&message.options)message.options.skipIntro=false;
                  return super.postMessage(message,...rest);
                }
              };
            }''')
        if not tail_calls:page.add_init_script(NO_TAIL_CALLS)
        if video_load_stalled:
            page.route('**/__qa/stalled-video',lambda route:held_routes.append(route))
            page.add_init_script("""{
              const source=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
              Object.defineProperty(HTMLMediaElement.prototype,'src',{...source,set(value){
                source.set.call(this,this.tagName==='VIDEO'?new URL('/__qa/stalled-video',location.href).href:value);
              }});
            }""")
        if autoplay_denied:
            page.add_init_script("""{
              const play=HTMLMediaElement.prototype.play,allowed=new WeakSet();
              window.cinematicDenials=0;window.cinematicInputs=[];window.cinematicCommands=[];window.cinematicFocus=[];
              const WorkerBase=window.Worker;
              window.Worker=class extends WorkerBase {
                constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.type==='video')cinematicCommands.push(e.data.method);});}
                postMessage(message,...args){if(message?.type==='input')cinematicInputs.push(message.input);return super.postMessage(message,...args);}
              };
              for(const kind of ['focusin','focusout'])document.addEventListener(kind,e=>cinematicFocus.push({type:kind,target:e.target.id||e.target.tagName,related:e.relatedTarget?.id||e.relatedTarget?.tagName}),true);
              document.addEventListener('click',event=>{
                if(event.isTrusted&&event.target.closest('.cinematic-prompt [data-action="play"]'))
                  for(const video of document.querySelectorAll('video'))allowed.add(video);
              },true);
              HTMLMediaElement.prototype.play=function(...args){
                if(this.tagName==='VIDEO'&&!allowed.has(this)){
                  ++window.cinematicDenials;return Promise.reject(new DOMException('User gesture required','NotAllowedError'));
                }
                return play.apply(this,args);
              };
            }""")
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_default_timeout(120000)
        def wait(expression):
            deadline=time.monotonic()+120
            while not page.evaluate(expression):
                if time.monotonic()>deadline:raise TimeoutError(expression)
                page.wait_for_timeout(200)
        try:
            page.goto(url)
            page.evaluate("window.siteReport=null;addEventListener('warcraft-report',event=>window.siteReport=event.detail)")
            wait("!document.getElementById('launch').disabled")
            page.locator('#tab-game').click()
            page.locator('#resolution').select_option(resolution)
            page.locator('#audio-enabled').set_checked(not mute)
            page.locator('#launch').click()
            if autoplay_denied:
                wait("siteReport||document.querySelector('.cinematic-prompt')")
                assert not page.evaluate('siteReport'),'Autoplay denial stopped the runtime'
                if autoplay_denied=='play':
                    # The guest video RPC times out in 20 s. User activation
                    # must be awaited by the page, without blocking that RPC.
                    page.wait_for_timeout(21000)
                    assert not page.evaluate('siteReport'),'Waiting for the user timed out the guest'
                assert page.locator('.cinematic-prompt').count(),'The game unexpectedly closed the cinematic prompt'
                page.locator('.cinematic-prompt').screenshot(path=str(output/'cinematic-prompt.png'))
                page.locator(f'.cinematic-prompt [data-action="{autoplay_denied}"]').tap()
                assert page.evaluate('cinematicDenials')>=1
                page.wait_for_timeout(1000)
                print(json.dumps({'cinematic':page.evaluate("({denials:cinematicDenials, inputs:cinematicInputs.slice(-16), commands:cinematicCommands.slice(-24), focus:cinematicFocus.slice(-12), prompt:!!document.querySelector('.cinematic-prompt'), videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,duration:v.duration,paused:v.paused,ready:v.readyState,error:v.error?.message})), log:(localStorage.getItem('wc3-last-log')||'').split('\\n').slice(-12)})")}),flush=True)
                if autoplay_denied=='play':assert page.locator('video').count(),'Playing the cinematic unexpectedly skipped it'
            if video_load_stalled:
                wait("siteReport||(localStorage.getItem('wc3-last-log')||'').includes('Cinematic skipped:')")
                assert 'Video load timed out' not in page.evaluate("JSON.stringify(siteReport||{})")
            elif autoplay_denied=='play':
                wait("siteReport||[...document.querySelectorAll('video')].some(v=>v.currentTime>3)")
            else:
                wait("siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>10")
            assert not page.evaluate('siteReport'),'Runtime stopped during startup'
            module='wc3.wasm' if tail_calls else 'wc3-compat.wasm'
            assert f'WASM {module} compiled' in page.evaluate("localStorage.getItem('wc3-last-log')||''"),f'{module} was not the module compiled'
            assert page.evaluate("document.fullscreenElement?.id === 'game-view'"),'Play did not enter fullscreen'
            assert page.evaluate("[...document.querySelectorAll('video')].filter(v=>v.currentTime>3).every(v=>document.fullscreenElement.contains(v))"),'Cinematic is outside the fullscreen game'
            if autoplay_denied=='play':
                assert page.evaluate("[...document.querySelectorAll('video')].filter(v=>v.currentTime>3).every(v=>v.muted)") == mute,'Cinematic audio ignored the launch setting'
            # Fullscreen belongs to the game: no toolbar and no system cursor.
            assert page.evaluate("getComputedStyle(document.querySelector('.game-toolbar')).display")=='none','Toolbar is visible in fullscreen'
            assert page.evaluate("getComputedStyle(document.getElementById('game-stage')).cursor")=='none','System cursor is visible in fullscreen'
            # A held Escape leaves fullscreen in a real browser (Keyboard Lock
            # passes short presses to the game); headless has no browser UI.
            page.evaluate('document.exitFullscreen()')
            wait('document.fullscreenElement === null')
            if autoplay_denied=='play':page.locator('#diagnostic-canvas').press('Escape')
            wait("siteReport||!document.querySelector('video')")
            wait("siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>=10")
            assert not page.evaluate('siteReport'),'Runtime stopped before original menu'
            page.locator('#diagnostic-fullscreen').click()
            wait("document.fullscreenElement?.id === 'game-view'")
            page.locator('#diagnostic-canvas').screenshot(path=str(output/'menu.png'))
            # Warcraft's own screenshot: a PNG of the frame in the downloads.
            width,height=map(int,resolution.split('x'))
            with page.expect_download(timeout=30000) as downloaded:
                page.locator('#diagnostic-canvas').press('PrintScreen')
            shot=downloaded.value;shot.save_as(output/'game-screenshot.png');data=(output/'game-screenshot.png').read_bytes()
            assert shot.suggested_filename.startswith('WC3ScrnShot_') and shot.suggested_filename.endswith('.png'),shot.suggested_filename
            assert data[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',data[16:24])==(width,height),'The screenshot is not a PNG of the frame'
            assert not page.evaluate('siteReport'),'Runtime stopped after Print Screen'
            canvas=page.locator('#diagnostic-canvas');canvas.scroll_into_view_if_needed();bounds=canvas.bounding_box()
            assert abs(bounds['width']/bounds['height']-4/3)<.002,'Wrong game aspect ratio'
            frame=page.evaluate("Number(document.getElementById('diagnostic-canvas').dataset.frames)")
            # Click the original One Player button through the actual page
            # layout, holding the button across guest polling frames.
            if page.evaluate("document.pointerLockElement?.id === 'diagnostic-canvas'"):
                # Pointer Lock moves the game cursor relatively and stops it at
                # the canvas edges: park it in the corner, then move by offset.
                page.mouse.move(-20000,-20000)
                page.mouse.move(-20000+bounds['width']*875/1024,-20000+bounds['height']*180/768)
            else:page.mouse.move(bounds['x']+bounds['width']*875/1024,bounds['y']+bounds['height']*180/768)
            wait(f"siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>={frame+2}")
            page.mouse.down()
            wait(f"siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>={frame+4}")
            page.mouse.up()
            wait(f"siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>={frame+20}")
            assert not page.evaluate('siteReport'),'Runtime stopped during menu input'
            canvas.screenshot(path=str(output/'one-player.png'))
            assert page.locator('#launch').is_disabled(),'A second runtime must not start'
            page.evaluate('document.exitFullscreen()')
            wait('document.fullscreenElement === null && document.pointerLockElement === null')
            page.locator('#stop-diagnostic').click()
            wait('!!siteReport')
            report=page.evaluate('siteReport')
            (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            (output/'game.log').write_text(page.evaluate("localStorage.getItem('wc3-last-log')||''"))
            assert report.get('wasmExecuted') is True and report.get('profileVerified') is True,report
            assert report.get('graphics',{}).get('frames',0)>=10,report
            assert report['graphics']['width']==width and report['graphics']['height']==height,'Native renderer ignored the selected resolution'
            assert ((report.get('error') or {}).get('message')=='Guest process stopped' or
                    report.get('stage')=='guest-exited' and report.get('exitCode')==0 and report.get('error') is None),report
            wait("!document.getElementById('launch').disabled")
            saved=page.evaluate("async()=>{const {SaveStore}=await import('/src/storage.mjs');return (await new SaveStore().list()).map(file=>file.path)}")
            assert not [path for path in saved if path.lower().startswith('screenshots/')],saved
            assert not errors,errors
            print(json.dumps({'wasm':module,'wasmExecuted':report['wasmExecuted'],'frames':report['graphics']['frames'],'calls':sum(report['calls'].values()),'resolution':resolution,'mute':mute,
                              'screenshot':shot.suggested_filename,'autoplayDenied':autoplay_denied,'videoLoadStalled':video_load_stalled,'errors':errors}))
        except Exception:
            (output/'failure.log').write_text(page.evaluate("localStorage.getItem('wc3-last-log')||''"))
            page.screenshot(path=str(output/'failure.png'))
            raise
        finally:
            for route in held_routes:
                try:route.abort()
                except PlaywrightError:pass
            browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--output',type=Path,default=Path('var/reports/site-launch'))
    parser.add_argument('--resolution',choices=['800x600','1024x768','1152x864','1280x960','1400x1050','1600x1200','1920x1440','2048x1536'],default='1024x768')
    parser.add_argument('--mute',action='store_true')
    parser.add_argument('--browser',choices=['chromium','firefox','webkit'],default='chromium')
    parser.add_argument('--no-tail-calls',action='store_true',help='a browser without WebAssembly tail calls: the compatible build')
    parser.add_argument('--autoplay-denied',choices=['play','skip'],help='simulate autoplay denial, then use the cinematic prompt')
    parser.add_argument('--video-load-stalled',action='store_true',help='simulate a cinematic that never loads metadata')
    args=parser.parse_args();main(args.url,args.output,args.resolution,args.mute,args.browser,not args.no_tail_calls,args.autoplay_denied,args.video_load_stalled)
