#!/usr/bin/env python3
"""A player dropping out of an original Warcraft LAN match must not stall the rest.

Three Chromium clients join one site lobby; the host creates a three-player
match (Forestwalk). One player drops out while all wait in Warcraft's game
lobby, while they load the map (at a random moment with --random), or once
they play:

  crash   its game stops with a runtime fault; its page and lobby stay
  close   its page is closed
  freeze  its whole browser stops answering, as with a lost connection
  network its lobby connection breaks while its browser keeps running; it must
          be told so instead of watching a frozen match

The others must not wait for it. A remaining guest has to receive game steps
(W3GS 0x0C) and the host's notice that the player left (W3GS 0x07). With
--who host the host drops out; no guest may be left waiting for it. Warcraft
moves the host to a remaining player when it can: the match goes on, the new
host sending the game steps. Otherwise it ends a match that has not begun with
the score screen and a running one with its "connection lost" dialog; a host
leaving its game lobby sends the guests back to the game list.
"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import time

from playwright.async_api import async_playwright

import runtime_lan_browser
from runtime_lan_browser import Peer

# English game data: map lists are sorted by localized name, and in English the
# root of the list holds Forestwalk (three players) at this row.
BOOT = runtime_lan_browser.BOOT.replace('resolution,\n    audioEnabled:false', "resolution,language:'en',\n    audioEnabled:false")
assert BOOT != runtime_lan_browser.BOOT
# Its row comes from the map catalog (runtime_lan_browser.map_list_rows); the
# guests confirm the map from the host's map check (W3GS 0x3D).
FORESTWALK = '(3)forestwalk.w3m'
# Mean colour of a page area: the score screen's parchment is beige.
COLOUR = '''async data => {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
  const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data, sum = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
  return sum.map(value => Math.round(value / (pixels.length / 4)));
}'''
# Share of a picture that changed (pixels of 96×48 whose luminance moved by more than 24).
CHANGED = '''async ([first, second]) => {
  const reduce = async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const canvas = new OffscreenCanvas(96, 48), context = canvas.getContext('2d');
    context.drawImage(await createImageBitmap(new Blob([bytes], {type: 'image/png'})), 0, 0, 96, 48);
    return context.getImageData(0, 0, 96, 48).data;
  };
  const [a, b] = [await reduce(first), await reduce(second)];
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs((a[i] + a[i + 1] + a[i + 2]) - (b[i] + b[i + 1] + b[i + 2])) / 3 > 24) changed++;
  return changed / (a.length / 4);
}'''
DIALOG = {'x': 300, 'y': 260, 'width': 424, 'height': 140}  # Warcraft's centred dialogs
CRASH = '''() => postMessage({type:'finished', savedFiles:[], deletedFiles:[],
  report:{schemaVersion:1, stage:'guest-entrypoint', error:{type:'GuestFault', message:'Simulated runtime fault'}}})'''


def browser_processes():
    rows = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout.splitlines()
    return {int(row.split(None, 1)[0]) for row in rows if 'ms-playwright/chromium' in row}


async def score_screen(peer):
    png = await peer.page.screenshot(clip={'x': 60, 'y': 320, 'width': 340, 'height': 260})
    red, green, blue = await peer.page.evaluate(COLOUR, base64.b64encode(png).decode())
    return red > 150 and red > green > blue and red - blue > 40


async def received(peer, kind):
    return await peer.page.evaluate(f'probe.network.received["{kind}"] || 0')


async def drop_out(peer, how, processes):
    if how == 'crash':
        # The page's view of a runtime fault: the game worker reports it and is
        # terminated without closing its sockets.
        worker = next(w for w in peer.page.workers if w.url.endswith('/runtime/worker.mjs'))
        await worker.evaluate(CRASH)
    elif how == 'close':
        await peer.page.close()
    elif how == 'network':
        await peer.page.evaluate('probeTransport.socket.close()')
    else:
        for pid in processes:
            os.kill(pid, signal.SIGSTOP)


async def main(url, output, how, who, stage, timeout, randomly=False):
    output.mkdir(parents=True, exist_ok=True)
    result = {'how': how, 'who': who, 'stage': stage, 'passed': False}
    peers, processes, frozen = [], {}, set()
    async with async_playwright() as playwright:
        try:
            for name in ['host', 'guest1', 'guest2']:
                before = browser_processes()
                browser = await playwright.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
                page = await browser.new_page(viewport={'width': 1024, 'height': 768})
                page.set_default_timeout(timeout * 1000)
                peers.append(Peer(name, browser, page, output, timeout, f'dropout-{how}'))
                await page.goto(url)
                processes[name] = browser_processes() - before
            host, guest1, guest2 = peers
            lobby = await (await host.page.request.post(url + '/api/lobbies', data={'name': f'Dropout {how}'})).json()
            runtime_lan_browser.BOOT = BOOT  # Peer.start uses the module's BOOT
            await asyncio.gather(*(peer.start(lobby['id'], {'width': 800, 'height': 600}) for peer in peers))
            # The host opens a three-player match; both guests join it.
            rows = await runtime_lan_browser.map_list_rows(host.page.request, url)
            for action in [{'click': [875, 332], 'frames': 8}, {'click': [230, 138], 'frames': 2}, {'text': 'Host', 'frames': 2},
                           {'click': [398, 710], 'frames': 48}, {'click': [175, rows[FORESTWALK]], 'frames': 8}, {'click': [876, 649], 'frames': 24}]:
                await host.action(action)
            for guest in (guest1, guest2):
                for action in [{'click': [875, 332], 'frames': 8}, {'click': [230, 138], 'frames': 2}, {'text': guest.name.title(), 'frames': 2}]:
                    await guest.action(action)
                await guest.wait('(probe.network.received["30"]||0)>0')
                await guest.action({'click': [185, 235], 'frames': 5})
                await guest.action({'click': [875, 650], 'frames': 12}, 'joined')
                await guest.wait('probe.network.recent.some(p=>p.id==="3d")')
                assert await guest.page.evaluate('probe.network.recent.some(p=>p.id==="3d"&&p.text?.toLowerCase().includes("forestwalk"))'), \
                    'The host did not open Forestwalk: compare map_list_rows with the map list (host/step-05.png)'
            await host.wait('(probe.network.received["1e"]||0)>=2')
            await host.capture('three-players')
            if stage != 'lobby':
                await host.action({'click': [878, 633], 'frames': 10}, 'starting')
            victim = host if who == 'host' else guest2
            survivors = [peer for peer in peers if peer is not victim]
            witness = guest1  # a guest that stays: what it receives shows whether the match goes on
            if stage == 'lobby':
                result['delay'] = 0
            elif stage == 'loading':
                await guest1.wait('(probe.network.received["0b"]||0)>0')  # countdown over: loading
                result['delay'] = round(random.uniform(0.5, 12), 1) if randomly else 3
                await asyncio.sleep(result['delay'])
                assert not await guest1.page.evaluate('(probe.network.received["0c"]||0)>0'), 'Loading already finished: the drop-out would not hit it'
            else:
                await guest1.wait('(probe.network.received["0c"]||0)>=20')  # playing
                if randomly:
                    result['delay'] = round(random.uniform(0, 20), 1)
                    await asyncio.sleep(result['delay'])
            steps = await received(witness, '0c')
            centre = {peer.name: base64.b64encode(await peer.page.screenshot(clip=DIALOG)).decode() for peer in survivors}
            own = base64.b64encode(await victim.page.screenshot(clip=DIALOG)).decode()
            dropped = time.monotonic()

            async def victim_told():
                # A player whose own connection broke sees Warcraft's dialog, its
                # score screen or the game list instead of a frozen match.
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    now = base64.b64encode(await victim.page.screenshot(clip=DIALOG)).decode()
                    if await score_screen(victim) or await victim.page.evaluate(CHANGED, [own, now]) > 0.3:
                        result['secondsUntilVictimTold'] = round(time.monotonic() - dropped, 1)
                        break
                    await asyncio.sleep(1)
                await victim.capture(f'{how}-{stage}-victim')
                assert 'secondsUntilVictimTold' in result, 'The disconnected player is not told'

            if how == 'freeze':
                frozen = processes[victim.name]
            await drop_out(victim, how, processes[victim.name])
            result['victim'] = victim.name
            if who == 'host':
                # Each guest either plays on (a new host sends the steps, the others
                # receive them) or sees the match end. A dialog in the middle of the
                # screen ("waiting for host", "connection lost") is where it may wait
                # for the server to notice a silent host; the outcome is what follows.
                ended = {}
                played = lambda peer: peer.page.evaluate("(probe.network.received['0c']||0)+(probe.network.sent['0c']||0)")
                start = {peer.name: await played(peer) for peer in survivors}
                final = lambda: len(ended) == len(survivors) and all(outcome != 'dialog' for outcome, _ in ended.values())
                while not final() and time.monotonic() - dropped < timeout:
                    for peer in survivors:
                        if ended.get(peer.name, ('',))[0] in ('plays on', 'match over'):
                            continue
                        elapsed = round(time.monotonic() - dropped, 1)
                        if await played(peer) >= start[peer.name] + 20:
                            ended[peer.name] = ('plays on', elapsed)
                        elif await score_screen(peer):
                            ended[peer.name] = ('match over', elapsed)
                        elif peer.name not in ended and stage != 'loading':
                            now = base64.b64encode(await peer.page.screenshot(clip=DIALOG)).decode()
                            if await peer.page.evaluate(CHANGED, [centre[peer.name], now]) > 0.3:
                                # In Warcraft's game lobby the guests are sent back to the game list.
                                ended[peer.name] = ('dialog' if stage == 'game' else 'lobby closed', elapsed)
                    if os.environ.get('DROPOUT_DEBUG'):
                        elapsed = round(time.monotonic() - dropped)
                        for peer in survivors:
                            state = await peer.page.evaluate("() => ({steps: probe.network.received['0c']||0, left: probe.network.received['07']||0, peers: probeTransport.peerIds, frames: probe.frame?.frames})")
                            print(json.dumps({'t': elapsed, 'peer': peer.name, **state}), flush=True)
                            if elapsed in (3, 10, 30, 60): await peer.capture(f'debug-{elapsed}s')
                    await asyncio.sleep(1)
                for peer in survivors:
                    await peer.capture(f'{how}-{stage}-after-host')
                    assert not await peer.page.evaluate('probe.report'), f'{peer.name} stopped'
                result['guests'] = ended
                assert len(ended) == len(survivors), f'A guest still waits for the host: {ended}'
                if how == 'network':
                    await victim_told()
                result['passed'] = True
            else:
                if stage == 'lobby':
                    # The slot frees at once; the host starts the match with the rest.
                    await witness.wait('(probe.network.received["07"]||0)>0')
                    result['secondsUntilPlayerLeft'] = round(time.monotonic() - dropped, 1)
                    await host.action({'click': [878, 633], 'frames': 10}, 'starting')
                    await witness.wait('(probe.network.received["0c"]||0)>=20')
                    result['secondsUntilPlay'] = round(time.monotonic() - dropped, 1)
                    for peer in survivors:
                        assert not await peer.page.evaluate('probe.report'), f'{peer.name} stopped'
                    if how == 'network':
                        await victim_told()
                    result['passed'] = True
                    print(json.dumps(result), flush=True)
                    return
                # When the host announced the departure, and when play went on.
                await witness.wait('(probe.network.received["07"]||0)>0')
                result['secondsUntilPlayerLeft'] = round(time.monotonic() - dropped, 1)
                await witness.wait(f'(probe.network.received["0c"]||0)>={steps + 20}')
                result['secondsUntilPlayContinues'] = round(time.monotonic() - dropped, 1)
                result['witness'] = {'steps': await received(witness, '0c'), 'playerLeft': await received(witness, '07')}
                if how == 'network':
                    await victim_told()
                for peer in survivors:
                    assert not await peer.page.evaluate('probe.report'), f'{peer.name} stopped'
                    await peer.capture(f'{how}-{stage}-after')
                result['passed'] = True
            print(json.dumps(result), flush=True)
        except BaseException as error:
            result['failure'] = repr(error)
            for peer in peers:
                try:
                    if not peer.page.is_closed():
                        await peer.capture('failure')
                except Exception:
                    pass
            print(json.dumps(result), flush=True)
            raise
        finally:
            for pid in frozen:
                try:
                    os.kill(pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
            for peer in peers:
                try:
                    await asyncio.wait_for(peer.browser.close(), 20)
                except Exception:
                    for pid in processes.get(peer.name, ()):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--output', type=Path, default=Path('var/reports/dropout'))
    parser.add_argument('--how', choices=['crash', 'close', 'freeze', 'network'], default='crash')
    parser.add_argument('--who', choices=['guest', 'host'], default='guest')
    parser.add_argument('--stage', choices=['lobby', 'loading', 'game'], default='loading')
    parser.add_argument('--random', action='store_true', help='drop out at a random moment of the stage')
    parser.add_argument('--timeout', type=int, default=240, help='seconds for each step; the match must go on within it')
    args = parser.parse_args()
    asyncio.run(main(args.url, args.output, args.how, args.who, args.stage, args.timeout, args.random))
