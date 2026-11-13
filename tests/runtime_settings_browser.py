#!/usr/bin/env python3
"""Real Warcraft LAN name across stop, reload and backup/restore; local only."""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile

from aiohttp import web
from playwright.async_api import async_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server.app import ROOT,create_app

REGISTRY='__w3ft__/registry.json'
NAME='WebPlayer'


async def name_mask(page,png):
    return await page.evaluate('''async url=>{
      const picture=new Image();picture.src=url;await picture.decode();
      const left=Math.round(picture.width*50/1024),top=Math.round(picture.height*125/768);
      const canvas=document.createElement('canvas');canvas.width=Math.round(picture.width*480/1024)-left;canvas.height=Math.round(picture.height*150/768)-top;
      const ctx=canvas.getContext('2d');ctx.drawImage(picture,-left,-top);
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data,result=[];
      for(let i=0;i<data.length;i+=4)result.push(Math.min(data[i],data[i+1],data[i+2])>160);
      return result;
    }''','data:image/png;base64,'+base64.b64encode(png).decode())


async def main(language):
    output=ROOT/'var/qa/lan-settings'/language;output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary)
        runner=web.AppRunner(create_app(report_path=root/'report.json',activity_dir=root/'activity',
                                       issues_dir=root/'issues',admin_password_hash=''))
        await runner.setup()
        try:
            await web.TCPSite(runner,'127.0.0.1',0).start()
            url=f'http://127.0.0.1:{runner.addresses[0][1]}'
            async with async_playwright() as p:
                browser=await p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
                try:
                    async def prepare():
                        context=await browser.new_context(locale='en-US',viewport={'width':1280,'height':1000},accept_downloads=True)
                        page=await context.new_page();page.set_default_timeout(90000)
                        # This check is about profile persistence, not fetching
                        # the whole installed game as background traffic.
                        await page.add_init_script('''{
                          window.settingsReport=null;addEventListener('warcraft-report',event=>window.settingsReport=event.detail);
                          const Base=Worker;
                          window.Worker=class extends Base{
                            postMessage(message,...args){if(message?.type==='start'&&message.options)message.options.backgroundCache=false;return super.postMessage(message,...args);}
                          };
                        }''')
                        await page.goto(url)
                        return context,page
                    async def until(page,expression,arg=None):
                        async with asyncio.timeout(90):
                            while not await page.evaluate(expression,arg):
                                if await page.evaluate('document.body.dataset.phase === "error"'):
                                    raise AssertionError(await page.locator('#launch-message').inner_text())
                                await asyncio.sleep(.1)
                    async def ready(page):
                        await until(page,'!document.getElementById("launch").disabled')
                        await page.locator('#language').select_option(language)
                        await page.locator('#tab-game').click()
                        await page.locator('#fullscreen-enabled').uncheck()
                        await page.locator('#audio-enabled').uncheck()
                        await page.locator('#resolution').select_option('1024x768')
                    async def frames(page,n=3):
                        at=int(await page.locator('#diagnostic-canvas').get_attribute('data-frames') or 0)
                        await until(page,'at=>Number(document.getElementById("diagnostic-canvas").dataset.frames)>at',at+n)
                    async def click(page,x,y):
                        box=await page.locator('#diagnostic-canvas').bounding_box()
                        await page.mouse.move(box['x']+box['width']*x/1024,box['y']+box['height']*y/768)
                        await frames(page,2);await page.mouse.down();await frames(page,2);await page.mouse.up();await frames(page,8)
                    async def lan(page):
                        await page.locator('#launch').click()
                        await until(page,'Number(document.getElementById("diagnostic-canvas").dataset.frames)>30')
                        await asyncio.sleep(2)
                        await click(page,875,332);await asyncio.sleep(2)
                    async def stop(page,label):
                        await page.locator('#stop-diagnostic').click()
                        await until(page,'!document.getElementById("launch").disabled')
                        log=await page.evaluate('localStorage.getItem("wc3-last-log")||""')
                        (output/(label+'.log')).write_text(log)
                        assert 'Игра не ответила на остановку' not in log
                        report=await page.evaluate('settingsReport')
                        assert report and (report.get('error') is None or (report.get('error') or {}).get('message')=='Guest process stopped'),report
                    async def saved_name(page):
                        return await page.evaluate('''async path=>{
                          const {SaveStore}=await import('/src/storage.mjs');
                          const data=await new SaveStore().read(path);
                          if(!data)return null;
                          const state=JSON.parse(new TextDecoder().decode(data));
                          return state.keys.find(([key])=>key==='user\\\\software\\\\blizzard entertainment\\\\warcraft iii\\\\string')?.[1].find(([name])=>name==='userlocal')?.[1].string;
                        }''',REGISTRY)
                    context,page=await prepare()
                    await ready(page);await lan(page);await click(page,230,138)
                    await page.locator('#diagnostic-canvas').press_sequentially(NAME,delay=40)
                    await frames(page,10)
                    reference=await page.locator('#diagnostic-canvas').screenshot(path=str(output/'typed.png'))
                    await stop(page,'first-stop')
                    actual=await saved_name(page)
                    assert actual==NAME, f'LAN name was not saved: {actual!r}'
                    await page.reload();await ready(page);await lan(page)
                    restored=await page.locator('#diagnostic-canvas').screenshot(path=str(output/'reloaded.png'))
                    masks=[await name_mask(page,reference),await name_mask(page,restored)]
                    total=sum(a or b for a,b in zip(*masks));difference=sum(a!=b for a,b in zip(*masks))
                    assert total>100 and difference/total<.2, f'Restored name is not rendered: {difference}/{total}'
                    await stop(page,'second-stop')
                    await page.locator('#tab-saves').click()
                    async with page.expect_download() as downloaded:
                        await page.locator('#export-saves').click()
                    backup=Path(await (await downloaded.value).path()).read_bytes()
                    assert any(f['path']==REGISTRY for f in json.loads(backup)['files'])
                    assert REGISTRY not in await page.locator('#save-list').inner_text()
                    await context.close()
                    context,page=await prepare();await ready(page)
                    await page.locator('#tab-saves').click()
                    await page.locator('#import-saves').set_input_files({'name':'saves.json','mimeType':'application/json','buffer':backup})
                    await until(page,'document.getElementById("save-status").textContent.length > 0')
                    assert await saved_name(page)==NAME
                    await lan(page)
                    restored=await page.locator('#diagnostic-canvas').screenshot(path=str(output/'imported.png'))
                    mask=await name_mask(page,restored);total=sum(a or b for a,b in zip(masks[0],mask));difference=sum(a!=b for a,b in zip(masks[0],mask))
                    assert total>100 and difference/total<.2,f'Imported name is not rendered: {difference}/{total}'
                    await stop(page,'imported-stop')
                    await context.close()
                    print(f'{language}: original LAN name survived site stop, page reload and backup restore into a new browser profile.',flush=True)
                finally:
                    await browser.close()
        finally:
            await runner.cleanup()
            print('Local settings-test server and browser stopped.',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language',choices=('ru','en'),default='en')
    asyncio.run(main(parser.parse_args().language))
