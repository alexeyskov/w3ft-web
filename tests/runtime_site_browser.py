#!/usr/bin/env python3
"""Boot the actual packaged Warcraft through the site's main launch button.

Records an original-menu screenshot and the real WASM report. This checks site
integration, not completion of a campaign or a multiplayer acceptance test.
"""
import argparse
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright


def main(url,output,resolution='1024x768',mute=False):
    output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        page=browser.new_page(viewport={'width':1440,'height':1100})
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
            wait("siteReport||[...document.querySelectorAll('video')].some(v=>v.currentTime>3)")
            assert not page.evaluate('siteReport'),'Runtime stopped during startup'
            assert page.evaluate("document.fullscreenElement?.id === 'game-view'"),'Play did not enter fullscreen'
            assert page.evaluate("[...document.querySelectorAll('video')].filter(v=>v.currentTime>3).every(v=>document.fullscreenElement.contains(v))"),'Cinematic is outside the fullscreen game'
            assert page.evaluate("[...document.querySelectorAll('video')].filter(v=>v.currentTime>3).every(v=>v.muted)") == mute,'Cinematic audio ignored the launch setting'
            # Fullscreen belongs to the game: no toolbar and no system cursor.
            assert page.evaluate("getComputedStyle(document.querySelector('.game-toolbar')).display")=='none','Toolbar is visible in fullscreen'
            assert page.evaluate("getComputedStyle(document.getElementById('game-stage')).cursor")=='none','System cursor is visible in fullscreen'
            # A held Escape leaves fullscreen in a real browser (Keyboard Lock
            # passes short presses to the game); headless has no browser UI.
            page.evaluate('document.exitFullscreen()')
            wait('document.fullscreenElement === null')
            page.locator('#diagnostic-canvas').press('Escape')
            wait("siteReport||!document.querySelector('video')")
            wait("siteReport||Number(document.getElementById('diagnostic-canvas').dataset.frames)>=10")
            assert not page.evaluate('siteReport'),'Runtime stopped before original menu'
            page.locator('#diagnostic-fullscreen').click()
            wait("document.fullscreenElement?.id === 'game-view'")
            page.locator('#diagnostic-canvas').screenshot(path=str(output/'menu.png'))
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
            assert report.get('wasmExecuted') is True and report.get('profileVerified') is True,report
            assert report.get('graphics',{}).get('frames',0)>=10,report
            width,height=map(int,resolution.split('x'))
            assert report['graphics']['width']==width and report['graphics']['height']==height,'Native renderer ignored the selected resolution'
            assert report.get('error',{}).get('message')=='Guest process stopped',report
            wait("!document.getElementById('launch').disabled")
            assert not errors,errors
            print(json.dumps({'wasmExecuted':report['wasmExecuted'],'frames':report['graphics']['frames'],'calls':sum(report['calls'].values()),'resolution':resolution,'mute':mute,'errors':errors}))
        finally:browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    parser.add_argument('--output',type=Path,default=Path('var/reports/site-launch'))
    parser.add_argument('--resolution',choices=['800x600','1024x768','1152x864','1280x960','1400x1050','1600x1200','1920x1440','2048x1536'],default='1024x768')
    parser.add_argument('--mute',action='store_true')
    args=parser.parse_args();main(args.url,args.output,args.resolution,args.mute)
