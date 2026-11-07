#!/usr/bin/env python3
"""Run two original Warcraft clients through a public lobby and play Echo Isles.

The public lobby API/transport are real; game actions use the native Warcraft UI.
W3GS IDs are checked against GHost++'s original protocol implementation:
https://github.com/dcramer/ghostplusplus/blob/master/ghost/gameprotocol.h
This short regression does not establish long-session or all-map compatibility.
"""
import argparse
import asyncio
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from playwright.async_api import async_playwright

# Rows of Warcraft's map list in 1024×768 page coordinates: its folders
# (alphabetical, with the game's own download folder), then the maps in its root
# by number of players and name. Folders of extra maps move every row, so the
# rows come from the server's map catalog.
async def map_list_rows(request,url):
    maps=(await (await request.get(url+'/api/maps')).json())['maps']
    folders=sorted({m['path'].split('/')[0].lower() for m in maps if '/' in m['path']}|{'download'})
    players=lambda path:int(re.match(r'\((\d+)\)',path).group(1)) if re.match(r'\((\d+)\)',path) else 99
    root=sorted((m['path'] for m in maps if '/' not in m['path']),key=lambda path:(players(path),path.lower()))
    row=lambda index:210+round(index*25.65)
    return {**{f'{name}/':row(i) for i,name in enumerate(folders)},**{path.lower():row(len(folders)+i) for i,path in enumerate(root)}}

HOST_ACTIONS = [
    {'click':[875,332],'frames':8}, {'click':[230,138],'frames':2}, {'text':'WebHost','frames':2},
    # Initial map enumeration and native sliding panels finish first. The list
    # opens on Maps: download, frozenthrone, scenario, then the classic maps.
    {'click':[398,710],'frames':48},
    {'click':[158,'frozenthrone/'],'frames':8}, {'key':'Enter','frames':24},
    {'click':[144,314],'frames':15}, {'click':[876,649],'frames':24},
]

BOOT = r'''async ({room,resolution}) => {
  if (!crossOriginIsolated) throw Error('Missing cross-origin isolation');
  const status=await (await fetch('/api/status')).json();
  const module=await import(status.runtime.moduleUrl);
  const {SaveStore}=await import('/src/storage.mjs');
  const {FrameTransport}=await import('/src/transport.mjs');
  window.probeSaves=new SaveStore();
  const transport=window.probeTransport=await new FrameTransport(room,{publicLobby:true}).connect();
  window.probe={log:[],report:null,frame:null,network:{sent:{},received:{},recent:[],actionPayloads:[]}};
  const streams=new Map();
  const record=(direction,peer,packet)=>{
    const id=packet[1],key=id.toString(16).padStart(2,'0'),net=probe.network;
    net[direction][key]=(net[direction][key]||0)+1;
    const event={direction,peer,id:key,size:packet.length,time:performance.now(),head:Array.from(packet.subarray(0,48))};
    if(id===0x30||id===0x3d)event.text=new TextDecoder().decode(packet);
    net.recent.push(event);if(net.recent.length>500)net.recent.shift();
    if(id===0x26&&direction==='sent')net.actionPayloads.push(Array.from(packet.subarray(8)));
  };
  const inspect=(direction,peer,data)=>{
    if(data.length<16)return;
    const header=new DataView(data.buffer,data.byteOffset,data.byteLength);
    if(header.getUint32(0,true)!==0x31535743)return;
    const kind=data[4],connection=header.getUint32(12,true),payload=data.subarray(16);
    if(kind!==1&&kind!==5)return;
    const key=`${direction}:${peer}:${connection}`;
    let buffer=kind===1?new Uint8Array():streams.get(key)||new Uint8Array();
    const joined=new Uint8Array(buffer.length+payload.length);joined.set(buffer);joined.set(payload,buffer.length);buffer=joined;
    while(buffer.length>=4){
      if(buffer[0]!==0xf7){buffer=buffer.subarray(1);continue;}
      const size=buffer[2]|buffer[3]<<8;
      if(size<4){buffer=buffer.subarray(1);continue;}
      if(buffer.length<size)break;
      record(direction,peer,buffer.subarray(0,size));buffer=buffer.subarray(size);
    }
    if(kind===5)streams.set(key,buffer.slice());
  };
  const send=transport.send.bind(transport);
  transport.send=(peer,data)=>{send(peer,data);inspect('sent',peer,data);};
  transport.addEventListener('packet',event=>inspect('received',event.detail.source,event.detail.data));
  const canvas=document.createElement('canvas');canvas.id='game-probe';canvas.width=resolution.width;canvas.height=resolution.height;
  canvas.style='position:fixed;inset:0;width:1024px;height:768px;z-index:10;background:black';
  document.body.append(canvas);
  window.session=await module.runDiagnostics({canvas,wasmUrl:status.runtime.wasmUrl,saves:probeSaves,transport,resolution,
    audioEnabled:false,timeout:0,dispatchBudget:0,
    onStatus:message=>{probe.log.push(message);if(probe.log.length>100)probe.log.shift();},
    onReport:report=>probe.report=report,
    onFrame:frame=>probe.frame={...frame,rendererFrame:frame.frames,frames:(probe.frame?.frames||0)+1}});
}'''


class Peer:
    def __init__(self, name, browser, page, output, timeout, run_id):
        self.name, self.browser, self.page = name, browser, page
        self.output, self.timeout = output / name, timeout
        self.run_id, self.screenshots = run_id, []
        self.output.mkdir(parents=True, exist_ok=True)
        self.errors = []
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.step = 0

    async def wait(self, expression, allow_report=False):
        deadline=time.monotonic()+self.timeout
        next_progress=time.monotonic()+30
        while True:
            # DevTools evaluates expressions directly, without CSP-unsafe eval.
            report=await self.page.evaluate('probe.report')
            if report and not allow_report:
                error=report.get('error',{})
                raise AssertionError(f'{self.name} stopped: {error.get("type")}: {error.get("message")}')
            if await self.page.evaluate(expression): return
            if time.monotonic()>deadline: raise TimeoutError(f'{self.name}: {expression}')
            if time.monotonic()>next_progress:
                await self.capture('progress')
                print(json.dumps({'peer':self.name,'waiting':expression,'frame':await self.page.evaluate('probe.frame'),
                                  'network':await self.page.evaluate('({sent:probe.network.sent,received:probe.network.received})')}),flush=True)
                next_progress=time.monotonic()+30
            await asyncio.sleep(.15)

    async def frames(self, count):
        frame=await self.page.evaluate('probe.frame?.frames||0')
        await self.wait(f'probe.frame?.frames>={frame+count}')

    async def capture(self, label):
        await self.page.screenshot(path=str(self.output/f'{label}.png'))
        self.screenshots.append(f'{self.name}/{label}.png')
        live=await self.page.evaluate('probe');live.update(runId=self.run_id,stage=label)
        (self.output/'live.json').write_text(json.dumps(live,ensure_ascii=False,indent=2)+'\n')

    async def start(self, room, resolution):
        await self.page.evaluate(BOOT, {'room':room,'resolution':resolution})
        await self.wait('[...document.querySelectorAll("video")].some(v=>v.currentTime>3)')
        await self.page.locator('#game-probe').press('Escape')
        await self.wait('!document.querySelector("video") && probe.frame?.frames>=10')
        await self.capture('menu')
        print(json.dumps({'peer':self.name,'stage':'menu'}),flush=True)

    async def action(self, action, label=None):
        await self.page.bring_to_front()
        if 'click' in action:
            await self.page.mouse.move(*action['click']);await self.frames(2)
            await self.page.mouse.down(button=action.get('button','left'));await self.frames(2)
            await self.page.mouse.up(button=action.get('button','left'))
        if 'drag' in action:
            start,end=action['drag'];await self.page.mouse.move(*start);await self.frames(2)
            await self.page.mouse.down();await self.frames(2)
            await self.page.mouse.move(*end,steps=8);await self.frames(2)
            await self.page.mouse.up()
        if 'text' in action:await self.page.locator('#game-probe').press_sequentially(action['text'],delay=100)
        if 'key' in action:
            await self.page.locator('#game-probe').focus()
            await self.page.keyboard.down(action['key']);await self.frames(2)
            await self.page.keyboard.up(action['key'])
        transition=time.monotonic()
        await self.frames(action.get('frames',3))
        # Menus animate in wall-clock time. A faster renderer must not click
        # through the previous screen merely because enough frames elapsed.
        await asyncio.sleep(max(0,2-(time.monotonic()-transition)))
        self.step+=1
        await self.capture(label or f'step-{self.step:02}')
        print(json.dumps({'peer':self.name,'step':self.step,'action':action,'frames':await self.page.evaluate('probe.frame.frames')}),flush=True)

    async def stop(self):
        if not await self.page.evaluate('!!window.probe'):return
        if not await self.page.evaluate('!!window.session'):return
        await self.page.evaluate('session.finish()')
        await self.wait('!!probe.report',allow_report=True)
        result=await self.page.evaluate('probe')
        result['runId']=self.run_id
        result['errors']=self.errors
        result['savedFiles']=await self.page.evaluate('''async()=>Promise.all((await probeSaves.list()).map(async f=>({path:f.path,size:f.data.byteLength,
          sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',f.data)),b=>b.toString(16).padStart(2,'0')).join('')})))''')
        (self.output/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        await self.page.evaluate('probeTransport.close()')
        return result


async def main(url,output,timeout,resolution):
    output.mkdir(parents=True,exist_ok=True)
    width,height=map(int,resolution.split('x'))
    run_id=datetime.now(timezone.utc).isoformat()
    peers=[];results=[];evidence={'runId':run_id,'passed':False,'status':'running'}
    summary=output/'summary.json'
    # Clear the previous result immediately; old screenshots cannot masquerade
    # as a successful current run while new game instances are still starting.
    summary.write_text(json.dumps(evidence,indent=2)+'\n')
    async with async_playwright() as playwright:
        try:
            # Separate browser processes: each owns its actual WASM workers and
            # original game state. No synthetic Warcraft/network responses.
            for name in ['host','guest']:
                browser=await playwright.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader',
                    '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
                page=await browser.new_page(viewport={'width':1024,'height':768})
                page.set_default_timeout(timeout*1000)
                peer=Peer(name,browser,page,output,timeout,run_id);peers.append(peer)
                await page.goto(url)
            host,guest=peers
            response=await host.page.request.post(url+'/api/lobbies',data={'name':'Original Warcraft LAN regression'})
            assert response.status==201,await response.text()
            lobby=await response.json();evidence['lobby']=lobby
            await asyncio.gather(*(peer.start(lobby['id'],{'width':width,'height':height}) for peer in peers))
            listing=await (await host.page.request.get(url+'/api/lobbies')).json()
            assert next(item for item in listing['lobbies'] if item['id']==lobby['id'])['players']==2
            await guest.action({'click':[875,332],'frames':8})
            await guest.action({'click':[230,138],'frames':2})
            await guest.action({'text':'WebGuest','frames':2})
            rows=await map_list_rows(host.page.request,url)
            for action in HOST_ACTIONS:await host.action({**action,'click':[action['click'][0],rows[action['click'][1]]]} if isinstance(action.get('click',[0,0])[1],str) else action)
            await guest.wait('(probe.network.received["30"]||0)>0')
            await guest.action({'click':[185,235],'frames':5},'discovered')
            assert await guest.page.evaluate('probe.network.recent.some(p=>p.id==="30"&&p.text?.includes("WebHost"))'),'Original host was not advertised'
            await guest.action({'click':[875,650],'frames':12},'joined')
            await guest.wait('(probe.network.received["04"]||0)>0')
            await host.wait('(probe.network.received["1e"]||0)>0')
            await guest.wait('probe.network.recent.some(p=>p.id==="3d"&&p.text?.toLowerCase().includes("echoisles"))')
            await host.capture('two-players')
            await host.action({'click':[878,633],'frames':10},'starting')
            await guest.wait('(probe.network.sent["23"]||0)>0 && (probe.network.received["0c"]||0)>=5')
            await host.wait('(probe.network.received["23"]||0)>0')
            await asyncio.gather(*(peer.frames(15) for peer in peers))
            await asyncio.gather(*(peer.capture('gameplay') for peer in peers))
            baseline=await guest.page.evaluate('({actions:probe.network.sent["26"]||0,steps:probe.network.received["0c"]||0})')
            # F8 selects an idle worker for any of the randomly assigned races,
            # without depending on its exact starting world coordinates.
            await guest.action({'key':'F8','frames':8},'units-selected')
            baseline['actions']=await guest.page.evaluate('probe.network.sent["26"]||0')
            host_actions_before=await host.page.evaluate('probe.network.received["26"]||0')
            await guest.action({'click':[730,430],'button':'right','frames':12},'unit-command')
            await guest.wait(f'(probe.network.sent["26"]||0)>{baseline["actions"]}')
            await host.wait(f'(probe.network.received["26"]||0)>{host_actions_before}')
            await guest.wait(f'(probe.network.received["0c"]||0)>={baseline["steps"]+20}')
            await asyncio.gather(*(peer.capture('after-command') for peer in peers))
            evidence['network']={peer.name:await peer.page.evaluate('probe.network') for peer in peers}
            for peer in peers:
                assert not peer.errors,peer.errors
                assert not await peer.page.evaluate('probe.report')
            # Check the observed live match, before intentional shutdown sends
            # leave/FIN messages. Native ticking and action echo continue.
            guest_packets=evidence['network']['guest']['received']
            assert guest_packets.get('07',0)==0 and guest_packets.get('1c',0)==0,'Player left or was kicked during the observed match'
            assert evidence['network']['guest']['sent'].get('21',0)==0,'Guest left the match before shutdown'
            evidence['checks']={'publicLobbyTwoPeers':True,'originalDiscovery':True,'originalJoin':True,
                'bothLoadedEchoIsles':True,'guestCommandSentAndReceived':True,'continuedLockstepFrames':True,'runtimeFaults':False}
            print(json.dumps({'stage':'match-verified','checks':evidence['checks']}),flush=True)
        except BaseException as error:
            evidence['failure']=repr(error)
            raise
        finally:
            for peer in peers:
                try:
                    if await peer.page.evaluate('!!window.probe'):await peer.capture('final')
                except Exception:pass
            if peers:
                stopped=await asyncio.gather(*(asyncio.wait_for(peer.stop(),20) for peer in peers),return_exceptions=True)
                for peer,result in zip(peers,stopped):
                    if isinstance(result,BaseException):evidence.setdefault('cleanupErrors',{})[peer.name]=str(result)
                    elif result:results.append(result)
            for peer in peers:
                try:await peer.browser.close()
                except Exception:pass
            evidence['screenshots']={peer.name:sorted(set(peer.screenshots)) for peer in peers}
            evidence['status']='failed' if evidence.get('failure') or evidence.get('cleanupErrors') else 'validating'
            summary.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    assert len(results)==2 and not evidence.get('cleanupErrors'),evidence.get('cleanupErrors')
    for result in results:
        report=result['report']
        assert report.get('wasmExecuted') and report.get('profileVerified'),report
        assert report.get('error',{}).get('message')=='Guest process stopped',report.get('error')
    evidence.update(passed=True,status='passed',completedAt=datetime.now(timezone.utc).isoformat())
    evidence['reports']={peer.name:f'{peer.name}/report.json' for peer in peers}
    summary.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':True,'checks':evidence['checks'],'reports':[str(output/name/'report.json') for name in ['host','guest']]}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--output',type=Path,default=Path('var/reports/public-lan-final'))
    parser.add_argument('--timeout',type=int,default=240,help='Maximum seconds for each progress condition')
    parser.add_argument('--resolution',choices=['800x600','1024x768','1280x960'],default='800x600')
    args=parser.parse_args();asyncio.run(main(args.url,args.output,args.timeout,args.resolution))
