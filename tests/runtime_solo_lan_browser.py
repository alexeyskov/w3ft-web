#!/usr/bin/env python3
"""Original Warcraft LAN game with one human and an AI: loading, play, exit.

Run against a local server with a packaged runtime. The private test room has
no remote guests, so only the host's observed game lifecycle can count it.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path

from playwright.async_api import async_playwright
from runtime_lan_browser import Peer, HOST_ACTIONS, map_list_rows


async def main(url, output, timeout=180, source_runtime=None):
    output.mkdir(parents=True, exist_ok=True)
    result = {'passed': False, 'runId': datetime.now(timezone.utc).isoformat()}
    (output/'summary.json').write_text(json.dumps(result, indent=2)+'\n')
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
        try:
            page = await browser.new_page(viewport={'width':1024, 'height':768})
            console=[]
            page.on('console',lambda message:console.append(message.text))
            page.on('pageerror',lambda error:console.append(str(error)))
            page.set_default_timeout(timeout*1000)
            if source_runtime is not None:
                # Development harness only: test current JS with the already
                # compiled local module, without repackaging another agent's build.
                async def route(route):
                    source = source_runtime / route.request.url.split('/')[-1].split('?')[0]
                    if source.is_file() and source.name != 'runtime-build.mjs':
                        await route.fulfill(status=200, content_type='text/javascript', body=source.read_text(),
                            headers={'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'})
                    else:
                        await route.continue_()
                await page.context.route('**/runtime/*.mjs*', route)
            await page.goto(url)
            peer = Peer('host', browser, page, output, timeout, result['runId'])
            response = await page.request.post(url+'/api/lobbies', data={'name':'Solo LAN counter regression'})
            assert response.status == 201
            lobby = await response.json()
            await peer.start(lobby['id'], {'width':800, 'height':600})
            async def count():
                return (await (await page.request.get(url+'/api/status')).json())['presence']['lanGames']
            assert await count() == 0
            rows = await map_list_rows(page.request, url)
            for action in HOST_ACTIONS:
                await peer.action({**action,'click':[action['click'][0],rows[action['click'][1]]]} if isinstance(action.get('click',[0,0])[1],str) else action)
            await peer.frames(15)
            await peer.action({'click':[214,91],'frames':4}, 'choose-ai')
            await peer.action({'click':[117,182],'frames':4}, 'ai-lobby')
            assert await count() == 0, 'A waiting host with bots is not playing yet'
            await peer.action({'click':[878,633],'frames':15}, 'countdown')
            await peer.wait('(probe.network.sent["33"]||0)>0')
            assert await count() == 0, 'A withdrawn LAN advertisement is only loading/cancellation'
            await peer.capture('loading')
            await peer.wait('document.getElementById("online-lan").textContent === "1"')
            assert await count() == 1
            await peer.frames(15);await peer.capture('solo-gameplay')
            assert await page.evaluate('probe.frame.perspectiveDraws > 0')
            result['singleHumanWithAI'] = True
            await peer.action({'key':'F8','frames':4}, 'worker-selected')
            await peer.action({'click':[700,430],'button':'right','frames':8}, 'worker-command')
            assert await count() == 1
            await peer.action({'key':'F10','frames':4}, 'game-menu')
            await peer.action({'key':'E','frames':4}, 'leave-menu')
            await peer.action({'key':'Q','frames':4}, 'leave-match')
            await peer.wait('document.getElementById("online-lan").textContent === "0"')
            assert await count() == 0
            await peer.capture('ended')
            result['clearedOnExit'] = True
            report = await peer.stop()
            assert not report['errors']
            stopped=report['report']
            result['memory']=stopped.get('memory')
            result['graphics']=stopped.get('graphics')
            assert ((stopped.get('error') or {}).get('message')=='Guest process stopped' or
                    stopped.get('stage')=='guest-exited' and stopped.get('exitCode')==0 and stopped.get('error') is None),stopped.get('error')
            result['passed'] = True
        except Exception as error:
            result['error'] = str(error)
            if 'page' in locals():
                result['console'] = console
                result['probe'] = await page.evaluate('window.probe || null')
                await page.screenshot(path=str(output/'failure.png'))
            raise
        finally:
            (output/'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
            await browser.close()
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--output',type=Path,default=Path('var/qa/solo-lan/real-game'))
    parser.add_argument('--timeout',type=int,default=180)
    args=parser.parse_args()
    asyncio.run(main(args.url.rstrip('/'),args.output,args.timeout))
