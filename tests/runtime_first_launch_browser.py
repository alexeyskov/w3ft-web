#!/usr/bin/env python3
"""Real first/repeat launch: no startup movie, automatic cache population.

Needs packaged runtime and recorded boot sets. Uses a clean persistent browser
profile and a local server; checks both startup and the in-session downloader.
"""
import argparse
import asyncio
import json
from pathlib import Path
import tempfile
import time
from playwright.async_api import async_playwright


async def launch(page,output,label,timeout,intros):
    requested=[]
    def record(request):requested.append(request.url)
    page.on('request',record)
    await page.evaluate('''()=>{
      window.loadingSeen=[];window.cacheSeen=[];window.finalReport=null;
      addEventListener('warcraft-session-progress',e=>loadingSeen.push({...e.detail,at:performance.now()}));
      addEventListener('warcraft-cache-progress',e=>cacheSeen.push({...e.detail,at:performance.now()}));
      addEventListener('warcraft-report',e=>window.finalReport=e.detail);
    }''')
    async def until(expression,seconds=timeout):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            assert await page.evaluate('document.body.dataset.phase')!='error',await page.locator('#launch-message').inner_text()
            if await page.evaluate(f'!!({expression})'):return
            await asyncio.sleep(.1)
        await page.screenshot(path=str(output/f'{label}-timeout.png'))
        raise TimeoutError(expression)
    began=time.monotonic()
    await page.locator('#launch').click()
    await until('+document.getElementById("diagnostic-canvas").dataset.frames>20')
    menu=time.monotonic()-began
    assert await page.locator('video').count()==0,'startup intro must not play'
    await until('cacheSeen.length>0')
    await until('cacheSeen.at(-1).cached>cacheSeen[0].cached || cacheSeen.at(-1).state==="complete"',60)
    before=await page.evaluate('cacheSeen[0]');after=await page.evaluate('cacheSeen.at(-1)')
    assert await page.locator('#background-download-toggle').count()==0,'no player controls for automatic downloads'
    await page.screenshot(path=str(output/f'{label}-menu.png'))
    assert not any(url.endswith(path) for url in requested for path in intros),'intro bytes downloaded'
    downloads=await page.evaluate('loadingSeen.filter(p=>p.phase==="download"&&p.total>0)')
    if downloads:assert downloads[-1]['done']==downloads[-1]['total'],downloads[-1]
    await page.locator('#stop-diagnostic').dispatch_event('click')
    await until('!document.getElementById("launch").disabled',60)
    assert await page.evaluate('''(finalReport.error?.message==='Guest process stopped') ||
      (finalReport.stage==='guest-exited' && finalReport.exitCode===0 && finalReport.error===null)''')
    (output/f'{label}.log').write_text(await page.evaluate('localStorage.getItem("wc3-last-log")'))
    page.remove_listener('request',record)
    return {'secondsToMenu':round(menu,2),'startupMB':round(downloads[-1]['total']/1048576,2) if downloads else 0,
            'backgroundAddedMB':round((after['cached']-before['cached'])/1048576,2),'backgroundPhase':after['phase']}


async def main(url,output,timeout,language):
    output.mkdir(parents=True,exist_ok=True)
    async with async_playwright() as p:
        with tempfile.TemporaryDirectory(prefix='wc3-launch-') as profile:
            context=await p.chromium.launch_persistent_context(profile,viewport={'width':1280,'height':900},
                args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
            try:
                page=context.pages[0];errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                await page.goto(url)
                await page.evaluate('''language=>{
                  localStorage.setItem('wc3-language',language);
                  localStorage.setItem('wc3-launch-settings',JSON.stringify({fullscreen:false}));
                }''',language)
                await page.reload();await page.wait_for_selector('#launch:not([disabled])',timeout=timeout*1000)
                intros=await page.evaluate(r'''async language=>(await (await fetch('/api/assets?language='+language)).json()).files
                  .filter(f=>/^(Movies\/|WebMedia\/(?:IntroX?|TutorialIn)\.)/i.test(f.path)).map(f=>f.downloadUrl)''',language)
                first=await launch(page,output,'first',timeout,intros)
                second=await launch(page,output,'second',timeout,intros)
                assert first['startupMB']>0,first
                assert second['startupMB']<1,second
                assert not errors,errors
                result={'language':language,'first':first,'second':second}
                (output/'report.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps(result),flush=True)
            finally:await context.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--output',type=Path,default=Path('var/reports/first-launch'))
    parser.add_argument('--timeout',type=int,default=300)
    parser.add_argument('--language',default='ru')
    args=parser.parse_args();asyncio.run(main(args.url,args.output,args.timeout,args.language))
