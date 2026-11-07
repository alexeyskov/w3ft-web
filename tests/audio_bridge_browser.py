#!/usr/bin/env python3
"""Real dedicated-worker/WebAudio RPC check; does not execute Warcraft code."""
from pathlib import Path
import json
import subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKER = """
import {WorkerAudio} from '/audio-bridge.mjs';
onmessage=async()=>{
  try {
    const audio=new WorkerAudio({trace:()=>[{name:'PCM integration fixture'}]});
    const buffer=audio.createBuffer({data:new Uint8Array(800).fill(128),format:'u8',channels:1,sampleRate:8000});
    audio.setListener({position:[1,2,3],forward:[0,0,-1],up:[0,1,0]});
    const voice=audio.play(buffer,{loop:true,spatial:{position:[-2,0,0]}});
    audio.setSpatial(voice,{position:[2,0,0],obstruction:.5,occlusion:.25});
    await new Promise(resolve=>setTimeout(resolve,250));
    const loopPosition=audio.getPosition(voice),paused=audio.pause(voice),pauseState=audio.getState(voice);
    audio.resume(voice);const resumed=audio.getState(voice);audio.stop(voice);
    const stopped=audio.getState(voice),stopPosition=audio.getPosition(voice);
    audio.releaseVoice(voice);audio.deleteBuffer(buffer);
    const compressed=new Uint8Array(await (await fetch('/fixture.mp3')).arrayBuffer());
    const music=audio.createEncodedBuffer(compressed),duration=audio.bufferInfo(music,'duration');
    const channels=audio.bufferInfo(music,'numberOfChannels'),rate=audio.bufferInfo(music,'sampleRate');
    const musicVoice=audio.play(music,{loop:true,pan:-1,playbackRate:2});
    await new Promise(resolve=>setTimeout(resolve,150));
    const musicPosition=audio.getPosition(musicVoice);audio.setPan(musicVoice,1);audio.setPlaybackRate(musicVoice,.5);
    audio.releaseVoice(musicVoice);audio.deleteBuffer(music);
    let failure;
    try {audio.getState(voice);}catch(error){failure={message:error.message,details:error.details};}
    postMessage({type:'result',loopPosition,paused,pauseState,resumed,stopped,stopPosition,failure,duration,channels,rate,musicPosition});
  }catch(error){postMessage({type:'failure',message:error.stack});}
};
"""


def main():
    music=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',
                                   '-ar','22050','-ac','1','-c:a','libmp3lame','-b:a','64k','-f','mp3','pipe:1'])
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        try:
            context = browser.new_context()

            def route(request):
                name = request.request.url.rsplit('/', 1)[-1]
                headers = {'Cross-Origin-Opener-Policy': 'same-origin',
                           'Cross-Origin-Embedder-Policy': 'require-corp',
                           'Cross-Origin-Resource-Policy': 'same-origin'}
                if name=='fixture.mp3':
                    request.fulfill(content_type='audio/mpeg',headers=headers,body=music)
                elif name in ('audio.mjs', 'audio-bridge.mjs', 'audio-spatial.mjs'):
                    request.fulfill(content_type='text/javascript', headers=headers,
                                    body=(ROOT / 'web/runtime' / name).read_text())
                elif name == 'rpc-worker.mjs':
                    request.fulfill(content_type='text/javascript', headers=headers, body=WORKER)
                else:
                    request.fulfill(content_type='text/html', headers=headers, body='<!doctype html><title>PCM RPC fixture</title>')

            context.route('http://localhost:6777/**', route)
            page = context.new_page()
            page.goto('http://localhost:6777/')
            result = page.evaluate("""async () => {
              if(!crossOriginIsolated)throw Error('Cross-origin isolation required');
              const {PCMPlayer}=await import('/audio.mjs');
              const {AudioDispatcher}=await import('/audio-bridge.mjs');
              const player=new PCMPlayer();await player.unlock();
              const dispatcher=new AudioDispatcher(player),spatialUpdates=[];
              const update=player.setSpatial.bind(player);
              player.setSpatial=(id,value)=>{update(id,value);spatialUpdates.push(value);};
              const worker=new Worker('/rpc-worker.mjs',{type:'module'});
              try {
                return await new Promise((resolve,reject)=>{
                  const timer=setTimeout(()=>reject(Error('Audio worker fixture timed out')),10000);
                  worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};
                  worker.onmessage=e=>{
                    if(e.data.type==='audio')dispatcher.handle(e.data);
                    else {clearTimeout(timer);if(e.data.type==='failure')reject(Error(e.data.message));else resolve({...e.data,spatialUpdates,listenerZ:player.context.listener.positionZ.value,remainingVoices:dispatcher.voices.size,remainingBuffers:dispatcher.buffers.size});}
                  };
                  worker.postMessage({type:'start'});
                });
              }finally {worker.terminate();await dispatcher.destroy();}
            }""")
            assert 0 <= result['loopPosition'] < .1, result
            assert 0 <= result['paused'] < .1, result
            assert result['pauseState'] == 'paused' and result['resumed'] == 'playing', result
            assert result['stopped'] == 'stopped' and result['stopPosition'] == 0, result
            assert result['remainingVoices'] == result['remainingBuffers'] == 0, result
            assert result['listenerZ']==3 and result['spatialUpdates']==[{'position':[2,0,0],'obstruction':.5,'occlusion':.25}], result
            assert .9 < result['duration'] < 1.2 and result['channels']==1 and result['rate']>=22050, result
            assert .15 < result['musicPosition'] < .6, result
            assert result['failure'].get('details') and result['failure']['details']['operation'] == 'getState', result
            print(json.dumps(result))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
