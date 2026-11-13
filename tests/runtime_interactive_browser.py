#!/usr/bin/env python3
"""Probe original game startup, play the intro, then skip via normal keyboard input.

Records the next runtime fault. This is not a campaign/multiplayer acceptance test.
"""
import argparse
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright


def main(url, timeout, actions=None, interactive=False, profile=None, room=None, output=Path('var/reports'), unlimited=False, graphics_debug_checks=False, batch_graphics=True, legacy_clamp_to_edge=True, native_texture_shader=True):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        launch_args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
        if profile:
            browser=p.chromium.launch_persistent_context(str(profile.resolve()),args=launch_args,viewport={'width':1024,'height':768})
            page=browser.pages[0] if browser.pages else browser.new_page()
        else:
            browser=p.chromium.launch(args=launch_args)
            page=browser.new_page(viewport={'width':1024,'height':768})
        try:
            page.set_default_timeout(timeout + 10000)
            def wait(expression):
                deadline=time.monotonic()+(timeout+10000)/1000
                next_progress=time.monotonic()+30
                while not page.evaluate(expression):
                    if time.monotonic()>deadline:
                        raise TimeoutError(expression)
                    if time.monotonic()>next_progress:
                        progress=page.evaluate('''()=>{const snapshot=probe.snapshots?.at(-1);return {frame:probe.frame,log:probe.log.slice(-3),
                          snapshot:snapshot?{time:snapshot.time,calls:snapshot.calls,heap:snapshot.heap,
                            main:snapshot.threads.find(t=>t.id===1),recent:snapshot.recent.slice(-3)}:null,
                          video:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,duration:v.duration,paused:v.paused,ended:v.ended}))};}''')
                        page.screenshot(path=str(output/'runtime-progress.png'))
                        print(json.dumps({'waiting':progress}),flush=True)
                        next_progress=time.monotonic()+30
                    page.wait_for_timeout(200)
            page.goto(url)
            page.evaluate('''async ({timeout,room,unlimited,graphicsDebugChecks,batchGraphics,legacyClampToEdge,nativeTextureShader}) => {
              if (!crossOriginIsolated) throw Error('Missing cross-origin isolation');
              const status = await (await fetch('/api/status')).json();
              const module = await import(status.runtime.moduleUrl);
              const {SaveStore}=await import('/src/storage.mjs');
              window.probeSaves=new SaveStore();
              if(room){const {FrameTransport}=await import('/src/transport.mjs');window.probeTransport=await new FrameTransport(room).connect();}
              const canvas = document.createElement('canvas');
              canvas.id='game-probe';canvas.width=1024;canvas.height=768;
              canvas.style='position:fixed;inset:0;width:1024px;height:768px;z-index:10;background:black';
              document.body.append(canvas);
              window.probe={log:[],report:null,intro:null,frame:null,snapshots:[],measurements:[]};
              window.session=await module.runDiagnostics({canvas,wasmUrl:status.runtime.wasmUrl,saves:probeSaves,transport:window.probeTransport,skipIntro:false,
                audioEnabled:true,captureGraphics:true,graphicsDebugChecks,batchGraphics,legacyClampToEdge,nativeTextureShader,timeout:unlimited?0:timeout,dispatchBudget:unlimited?0:1000000000,onStatus:message=>probe.log.push(message),onReport:report=>probe.report=report,
                onFrame:frame=>probe.frame={...frame,rendererFrame:frame.frames,frames:(probe.frame?.frames||0)+1},
                onSnapshot:snapshot=>{probe.snapshots.push(snapshot);if(probe.snapshots.length>8)probe.snapshots.shift();}});
            }''', {'timeout':timeout,'room':room,'unlimited':unlimited,'graphicsDebugChecks':graphics_debug_checks,'batchGraphics':batch_graphics,'legacyClampToEdge':legacy_clamp_to_edge,'nativeTextureShader':native_texture_shader})
            wait('probe.report || [...document.querySelectorAll("video")].some(v=>v.currentTime>5)')
            if not page.evaluate('!!probe.report'):
                intro = page.evaluate('''() => {
                  const v=[...document.querySelectorAll('video')].find(v=>v.currentTime>5);
                  return probe.intro={time:v.currentTime,duration:v.duration,width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,url:v.currentSrc};
                }''')
                page.screenshot(path=str(output / 'runtime-intro.png'))
                print(json.dumps({'intro': intro}), flush=True)
                page.locator('#game-probe').press('Escape')
            wait('probe.report || probe.frame?.frames>=10')
            if not page.evaluate('!!probe.report'):
                page.screenshot(path=str(output / 'runtime-live.png'))
                print(json.dumps({'frame':page.evaluate('probe.frame')}),flush=True)
            def execute(index,action):
                if page.evaluate('!!probe.report'):return
                if action.get('finish'):
                    page.evaluate('session.finish()');return
                frame=page.evaluate('probe.frame.frames')
                if 'click' in action:
                    # Let the game's polling loop see movement and both button
                    # transitions even when software rendering is below 60 Hz.
                    page.mouse.move(*action['click'])
                    wait(f'probe.report || probe.frame?.frames>={frame+2}')
                    page.mouse.down(button=action.get('button','left'))
                    wait(f'probe.report || probe.frame?.frames>={frame+4}')
                    page.mouse.up(button=action.get('button','left'))
                    frame=page.evaluate('probe.frame.frames')
                if 'drag' in action:
                    start,end=action['drag']
                    page.mouse.move(*start);wait(f'probe.report || probe.frame?.frames>={frame+2}')
                    page.mouse.down();wait(f'probe.report || probe.frame?.frames>={frame+4}')
                    page.mouse.move(*end,steps=8);wait(f'probe.report || probe.frame?.frames>={frame+6}')
                    page.mouse.up();frame=page.evaluate('probe.frame.frames')
                if 'key' in action:
                    page.locator('#game-probe').press(action['key'])
                if 'down' in action:
                    page.locator('#game-probe').focus();page.keyboard.down(action['down'])
                if 'up' in action:
                    page.keyboard.up(action['up'])
                if 'text' in action:
                    page.locator('#game-probe').press_sequentially(action['text'])
                if 'measure' in action:
                    seconds=float(action['measure'])
                    if not 0<seconds<=30:raise ValueError('Measurement duration must be 0–30 seconds')
                    start=page.evaluate('({time:performance.now(),frame:probe.frame})')
                    page.wait_for_timeout(seconds*1000)
                    measurement=page.evaluate('''start=>{
                      const elapsed=(performance.now()-start.time)/1000,frame=probe.frame;
                      const result={seconds:elapsed,frames:frame.frames-start.frame.frames,
                        fps:(frame.frames-start.frame.frames)/elapsed,draws:frame.draws-start.frame.draws,
                        execution:Object.fromEntries(Object.entries(frame.execution||{}).map(([key,value])=>[key,value-(start.frame.execution?.[key]||0)]))};
                      probe.measurements.push(result);return result;
                    }''',start)
                    print(json.dumps({'measurement':measurement}),flush=True)
                elif 'video' in action:
                    wait(f'probe.report || [...document.querySelectorAll("video")].some(v=>v.currentTime>={float(action["video"])})')
                else:
                    wait(f'probe.report || probe.frame?.frames>={frame+action.get("frames",3)}')
                if 'delay' in action:
                    delay=float(action['delay'])
                    if not 0<=delay<=30:raise ValueError('Action delay must be 0–30 seconds')
                    page.wait_for_timeout(delay*1000)
                page.screenshot(path=str(output / f'runtime-step-{index+1}.png'))
                print(json.dumps({'step':index+1,'frame':page.evaluate('probe.frame')}),flush=True)
            index=0
            for action in actions or []:
                execute(index,action);index+=1
            if interactive:
                print('Ready for JSON actions on stdin; {"finish":true} records the report and exits.',flush=True)
                while not page.evaluate('!!probe.report'):
                    try:action=json.loads(input())
                    except EOFError:action={'finish':True}
                    if action.get('finish'):
                        page.evaluate('session.finish()');break
                    execute(index,action);index+=1
            wait('!!probe.report')
            result = page.evaluate('probe')
            result['savedFiles']=page.evaluate('async()=>Promise.all((await probeSaves.list()).map(async f=>({path:f.path,size:f.data.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",f.data)),b=>b.toString(16).padStart(2,"0")).join("")})))')
            (output/'runtime-saves.json').write_text(page.evaluate('probeSaves.export()')+'\n')
            page.screenshot(path=str(output / 'runtime-after-intro.png'))
        finally:
            browser.close()
    (output / 'runtime-interactive.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    report = result['report']
    assert report.get('wasmExecuted') is True, report
    assert report.get('profileVerified') is True, report
    print(json.dumps({'stage':report['stage'],'calls':sum(report.get('calls',{}).values()),
                      'stop':(report.get('error') or {}).get('message'),'intro':result['intro']},ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--timeout',type=int,default=60000)
    parser.add_argument('--actions',type=Path,help='JSON list of normal mouse/keyboard actions after the menu appears')
    parser.add_argument('--interactive',action='store_true',help='Accept further JSON actions on stdin without rebooting the game')
    parser.add_argument('--profile',type=Path,help='Persist the browser profile to verify real saved games across restarts')
    parser.add_argument('--room',help='Connect the actual runtime to this server relay room for LAN checks')
    parser.add_argument('--output',type=Path,default=Path('var/reports'),help='Report/screenshot directory, separate for each concurrent peer')
    parser.add_argument('--unlimited',action='store_true',help='Disable runtime time/dispatch limits, retaining the probe wait deadline')
    parser.add_argument('--graphics-debug-checks',action='store_true',help='Synchronously check each WebGL operation for diagnostics or performance comparison')
    parser.add_argument('--no-graphics-batching',action='store_true',help='Use per-call graphics RPC for comparison')
    parser.add_argument('--strict-clamp',action='store_true',help='Use normative OpenGL border filtering instead of the Warcraft legacy driver profile')
    parser.add_argument('--generic-texture-shader',action='store_true',help='Keep manual-border code in every fragment shader for performance comparison')
    args=parser.parse_args()
    main(args.url,args.timeout,json.loads(args.actions.read_text()) if args.actions else None,args.interactive,args.profile,args.room,args.output,args.unlimited,args.graphics_debug_checks,not args.no_graphics_batching,not args.strict_clamp,not args.generic_texture_shader)
