#!/usr/bin/env python3
"""Frame-rate benchmark of the real Warcraft runtime; optional Chromium CPU trace.

Uses the hardware GPU by default (Chromium new headless, ANGLE Metal/D3D/GL);
--software selects SwiftShader as in the older reports. The menu is measured
after the intro; the optional save scene imports a save archive into the page's
IndexedDB, loads it through the normal game menu and measures in game.

Warcraft paces its own main loop (WaitForSingleObject with 1-3 ms timeouts),
so on a fast machine FPS saturates. --trace records Chrome's V8 CPU profiler
and reports the main guest thread's busy time per frame, which still compares
builds when FPS is capped.

The page normally presents at most one frame per display refresh (vsync). The
benchmark measures throughput, so it passes vsync:false; headless Chromium runs
requestAnimationFrame at 60 Hz. Use --options '{"vsync":true}' for paced output.
"""
import argparse
import collections
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SAVES = ROOT / 'var/reports/fog-final-verified/runtime-saves.json'
# Single player -> Load game -> first save -> Load, then the minimap point
# used by the Echo Isles fog checks. Positions are canvas pixels at 1024x768.
SAVE_ACTIONS = [{'click': [875, 180], 'delay': 2}, {'click': [875, 295], 'delay': 2},
                {'click': [144, 110], 'delay': 1}, {'click': [880, 647], 'frames': 150, 'delay': 3},
                {'click': [100, 700], 'delay': 2}]


def summarize_trace(path, frames):
    """Per-thread V8 CPU profile categories from a Chrome trace."""
    data = json.loads(Path(path).read_text())
    events = data['traceEvents'] if isinstance(data, dict) else data
    profiles = {}
    for event in events:
        if event.get('ph') != 'P':
            continue
        profile = profiles.setdefault((event['pid'], event.get('id')), {'tid': event['tid'], 'nodes': {}, 'samples': [], 'deltas': []})
        if event['name'] == 'ProfileChunk':
            chunk = event['args']['data']
            for node in chunk.get('cpuProfile', {}).get('nodes', []):
                profile['nodes'][node['id']] = node
            profile['samples'] += chunk.get('cpuProfile', {}).get('samples', [])
            profile['deltas'] += chunk.get('timeDeltas', [])
    threads = []
    for profile in profiles.values():
        if not profile['samples']:
            continue
        weights = profile['deltas'][1:] + [0]
        categories, functions = collections.Counter(), collections.Counter()
        for sample, weight in zip(profile['samples'], weights):
            node = profile['nodes'].get(sample)
            if not node:
                continue
            frame = node['callFrame']
            name, url = frame.get('functionName', ''), frame.get('url', '')
            if name in ('(idle)', '(program)', '(garbage collector)', '(root)'):
                category = name.strip('()')
            elif 'wasm' in url:
                category = 'wasm'
            elif name in ('_call', '_waitWhile'):
                category = 'wait'
            else:
                category = 'js'
            categories[category] += weight
            functions[f"{name} [{url.rsplit('/', 1)[-1]}]"] += weight
        total = sum(weights)
        if not total or categories['wait'] > 0.98 * total:
            continue  # idle guest threads blocked in a Win32 wait
        busy = categories['wasm'] + categories['js'] + categories['garbage collector']
        threads.append({'tid': profile['tid'], 'sampledMs': round(total / 1000),
                        'categoriesMs': {k: round(v / 1000) for k, v in categories.most_common()},
                        'busyMsPerFrame': round(busy / 1000 / frames, 3) if frames else None,
                        'top': [[name, round(v / 1000, 1)] for name, v in functions.most_common(12)]})
    threads.sort(key=lambda thread: -thread['categoriesMs'].get('wasm', 0))
    if threads:
        threads[0]['role'] = 'main guest thread'
    for thread in threads[1:]:
        if thread['categoriesMs'].get('idle', 0) > 0:
            thread['role'] = 'broker (WebGL, Win32)'
            break
    return threads


def main(args):
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    options = {'captureGraphics': False, 'vsync': False, **json.loads(args.options)}
    if args.profile_rpc:
        options['profileRpc'] = True
    saves = args.saves.read_text() if args.saves and args.saves.is_file() else None
    result = {'url': args.url, 'options': options, 'measurements': []}
    engine = getattr(args, 'browser', 'chromium')
    if engine != 'chromium' and (args.software or args.trace):
        raise ValueError('--software and --trace require Chromium')
    launch = {}
    if engine == 'chromium':
        launch['args'] = ['--autoplay-policy=no-user-gesture-required']
        if args.software:
            launch['args'] += ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        else:
            launch['channel'] = 'chromium'  # new headless keeps hardware acceleration
    elif engine == 'firefox':
        launch['firefox_user_prefs'] = {'media.autoplay.default':0, 'media.autoplay.blocking_policy':0}
    with sync_playwright() as p:
        browser = getattr(p, engine).launch(**launch)
        page = browser.new_page(viewport={'width': 1024, 'height': 768})
        try:
            page.set_default_timeout(args.timeout * 1000)
            page.goto(args.url)
            result['renderer'] = page.evaluate('''()=>{const gl=document.createElement('canvas').getContext('webgl2'),
              e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e?e.UNMASKED_RENDERER_WEBGL:gl.RENDERER);}''')
            print(json.dumps({'renderer': result['renderer']}), flush=True)
            page.evaluate('''async ({saves,options})=>{
              if(!crossOriginIsolated)throw Error('Missing cross-origin isolation');
              const status=await (await fetch('/api/status')).json(),module=await import(status.runtime.moduleUrl);
              const {SaveStore}=await import('/src/storage.mjs');window.probeSaves=new SaveStore();
              if(saves)await probeSaves.import(saves);
              const canvas=document.createElement('canvas');canvas.id='game-probe';canvas.width=1024;canvas.height=768;
              canvas.style='position:fixed;inset:0;width:1024px;height:768px;z-index:10;background:black';document.body.append(canvas);
              window.probe={log:[],report:null,frame:null,times:[]};
              window.session=await module.runDiagnostics({canvas,wasmUrl:status.runtime.wasmUrl,saves:probeSaves,audioEnabled:true,
                timeout:0,dispatchBudget:0,...options,onStatus:m=>probe.log.push(m),onReport:r=>probe.report=r,
                onFrame:f=>{probe.frame={...f,frames:(probe.frame?.frames||0)+1};probe.times.push(performance.now());if(probe.times.length>20000)probe.times.splice(0,10000);}});
              probe.started=performance.now();
            }''', {'saves': saves, 'options': options})

            def wait(expression, timeout=None):
                deadline = time.monotonic() + (timeout or args.timeout)
                while not page.evaluate(expression):
                    if page.evaluate('!!probe.report'):
                        raise RuntimeError('Runtime ended: ' + json.dumps(page.evaluate('probe.report.error')))
                    if time.monotonic() > deadline:
                        raise TimeoutError(expression)
                    page.wait_for_timeout(100)
            frames = lambda: page.evaluate('probe.frame?.frames||0')
            wait('[...document.querySelectorAll("video")].some(v=>v.currentTime>2)||(probe.frame?.frames||0)>30')
            page.locator('#game-probe').press('Escape')
            wait('probe.frame?.frames>=10')
            result['firstFrameSeconds'] = page.evaluate('probe.times.length?(probe.times[0]-probe.started)/1000:null')
            # Menu buttons slide in over real time, independent of the frame rate.
            # No focus change here: the guest window must activate on its own.
            page.wait_for_timeout(4000)

            def act(action):
                if 'click' in action:
                    start = frames()
                    page.mouse.move(*action['click'])
                    wait(f'probe.frame.frames>={start + 2}')
                    page.mouse.down()
                    wait(f'probe.frame.frames>={start + 4}')
                    page.mouse.up()
                start = frames()
                wait(f'probe.frame.frames>={start + action.get("frames", 3)}')
                page.wait_for_timeout(action.get('delay', 0) * 1000)

            def in_game():
                # The game scene draws far more than the main menu (~140 draws).
                start = page.evaluate('probe.frame')
                page.wait_for_timeout(1500)
                end = page.evaluate('probe.frame')
                return (end['draws'] - start['draws']) / max(1, end['frames'] - start['frames']) > 200

            def measure(label):
                start = page.evaluate('({time:performance.now(),frame:probe.frame})')
                page.wait_for_timeout(args.seconds * 1000)
                m = page.evaluate('''([start,label])=>{
                  const elapsed=(performance.now()-start.time)/1000,f=probe.frame,n=f.frames-start.frame.frames;
                  const times=probe.times.filter(t=>t>=start.time),d=times.slice(1).map((t,i)=>t-times[i]).sort((a,b)=>a-b);
                  const q=p=>d.length?+d[Math.min(d.length-1,Math.floor(p*d.length))].toFixed(2):null,x=f.execution||{},s=start.frame.execution||{};
                  const r={label,seconds:+elapsed.toFixed(3),frames:n,fps:+(n/elapsed).toFixed(2),frameMs:{p50:q(.5),p90:q(.9),max:q(1)},
                    drawsPerFrame:+((f.draws-start.frame.draws)/n).toFixed(1),rpcPerFrame:+((x.rpcCalls-(s.rpcCalls||0))/n).toFixed(1)};
                  if(x.rpcByName)r.rpcByName=Object.fromEntries(Object.entries(x.rpcByName).map(([k,v])=>[k,+((v-(s.rpcByName?.[k]||0))/n).toFixed(3)]).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]));
                  return r;}''', [start, label])
                print(json.dumps({'measurement': m}), flush=True)
                result['measurements'].append(m)

            def trace(name):
                if not args.trace:
                    return
                start = frames()
                browser.start_tracing(page=page, path=str(output / name), categories=['disabled-by-default-v8.cpu_profiler', 'v8.execute', 'toplevel'])
                page.wait_for_timeout(args.trace * 1000)
                browser.stop_tracing()
                summary = summarize_trace(output / name, frames() - start)
                result.setdefault('cpu', {})[name] = summary
                for thread in summary[:2]:
                    print(json.dumps({'trace': name, 'role': thread.get('role'), 'busyMsPerFrame': thread['busyMsPerFrame'],
                                      'categoriesMs': thread['categoriesMs']}), flush=True)

            if args.scene in ('menu', 'both'):
                for _ in range(args.repeats):
                    measure('menu')
                trace('trace-menu.json')
                page.screenshot(path=str(output / 'menu.png'))
            if args.scene in ('save', 'both'):
                if not saves:
                    raise SystemExit('--saves is required for the save scene')
                # Submenus become clickable after a variable delay; a missed
                # click ends on Cancel in the main menu, so verify and retry.
                for attempt in range(4):
                    for action in SAVE_ACTIONS:
                        act({**action, 'delay': action.get('delay', 0) * (1 + attempt)})
                    if in_game():
                        break
                    print(json.dumps({'retry': attempt + 1}), flush=True)
                else:
                    raise RuntimeError('The save did not load through the menu')
                page.screenshot(path=str(output / 'save-scene.png'))
                for _ in range(args.repeats):
                    measure('save')
                trace('trace-save.json')
                page.screenshot(path=str(output / 'save-scene-after.png'))
            page.evaluate('session.finish()')
            wait('!!probe.report', 60)
            report = page.evaluate('probe.report')
            result['error'] = report.get('error')
            result['graphics'] = report.get('graphics')
            result['memory'] = report.get('memory')
            result['heap'] = report.get('heap')
        except Exception as error:
            result['failure'] = str(error)
            page.screenshot(path=str(output / 'failure.png'))
            result['log'] = page.evaluate('window.probe?.log?.slice(-20)')
            raise
        finally:
            (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n')
            browser.close()
    print(json.dumps({'summary': [[m['label'], m['fps'], m['frameMs']['p50']] for m in result['measurements']]}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--browser', choices=('chromium', 'webkit', 'firefox'), default='chromium')
    parser.add_argument('--output', type=Path, default=ROOT / 'var/reports/benchmark')
    parser.add_argument('--scene', choices=('menu', 'save', 'both'), default='both')
    parser.add_argument('--seconds', type=float, default=10)
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--saves', type=Path, default=DEFAULT_SAVES, help='wc3-web-saves-v1 export with the save to load')
    parser.add_argument('--software', action='store_true', help='SwiftShader instead of the hardware GPU')
    parser.add_argument('--trace', type=float, default=0, help='Seconds of V8 CPU profile after each scene')
    parser.add_argument('--profile-rpc', action='store_true', help='Synchronous broker calls per frame by import name')
    parser.add_argument('--options', default='{}', help='JSON options for runDiagnostics, e.g. {"batchGraphics":false}')
    parser.add_argument('--timeout', type=float, default=600)
    main(parser.parse_args())
