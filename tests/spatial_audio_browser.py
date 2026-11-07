"""Measure rendered PCM: direction, attenuation, listener movement and occlusion."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch()
    page=browser.new_page()
    page.route('http://spatial.test/**',lambda route:route.fulfill(
        content_type='text/javascript' if route.request.url.endswith('.mjs') else 'text/html',
        body=Path('web/runtime',route.request.url.rsplit('/',1)[-1]).read_text() if route.request.url.endswith('.mjs') else '<title>Spatial PCM fixture</title>'))
    page.goto('http://spatial.test/')
    result=page.evaluate('''async()=>{
      const {PCMPlayer}=await import('/audio.mjs'),results={};
      const render=async(name,spatial,listener,update,muted=false)=>{
        const context=new OfflineAudioContext(2,24000,48000),player=new PCMPlayer({context,muted});
        const wave=new Float32Array(24000);for(let i=0;i<wave.length;i++)wave[i]=.5*Math.sin(2*Math.PI*4000*i/48000);
        const id=player.createBuffer({data:new Uint8Array(wave.buffer),format:'f32le',channels:1,sampleRate:48000});
        player.setListener(listener||{position:[0,0,0],forward:[0,0,-1],up:[0,1,0]});
        const voice=player.play(id,{spatial:{refDistance:1,maxDistance:10,...spatial}});
        if(update)player.setSpatial(voice,{refDistance:1,maxDistance:10,...update});
        const buffer=await context.startRendering();
        if(muted&&context.currentTime<.49)throw Error('Muted playback clock did not advance');
        const rms=channel=>Math.sqrt(buffer.getChannelData(channel).slice(4000,20000).reduce((sum,v)=>sum+v*v,0)/16000);
        results[name]=[rms(0),rms(1)];await player.destroy();return results[name];
      };
      const left=await render('left',{position:[-2,0,0]}),right=await render('right',{position:[2,0,0]});
      if(!(left[0]>.25&&left[1]<1e-5&&right[1]>.25&&right[0]<1e-5))throw Error('Direction '+JSON.stringify(results));
      const far=await render('maxDistance',{position:[-10,0,0]});if(far.some(v=>v>1e-6))throw Error('Distance attenuation');
      const moved=await render('listenerMoved',{position:[2,0,0]},{position:[4,0,0],forward:[0,0,-1],up:[0,1,0]});
      if(moved[0]<.25||moved[1]>1e-5)throw Error('Listener movement');
      const obstructed=await render('obstruction',{position:[-2,0,0],obstruction:.5});
      if(Math.abs(obstructed[0]/left[0]-.5)>.01)throw Error('Obstruction gain');
      const distanceGain=await render('distanceGain',{position:[-2,0,0],distanceGain:.25});
      if(Math.abs(distanceGain[0]/left[0]-.25)>.01)throw Error('Software distance gain');
      const occluded=await render('occlusion',{position:[-2,0,0],occlusion:1});
      if(occluded[0]>left[0]*.1)throw Error('Occlusion low-pass');
      const updated=await render('updated',{position:[-2,0,0]},null,{position:[2,0,0]});
      if(updated[1]<.25||updated[0]>1e-5)throw Error('Spatial update');
      const away=await render('coneAway',{position:[-2,0,0],orientation:[-1,0,0],coneInner:30,coneOuter:60,coneGain:.1});
      const toward=await render('coneToward',{position:[-2,0,0],orientation:[1,0,0],coneInner:30,coneOuter:60,coneGain:.1});
      if(Math.abs(away[0]/toward[0]-.1)>.01)throw Error('Cone direction');
      const muted=await render('muted',{position:[0,0,-1],wet:1,decay:.5},null,null,true);
      if(muted.some(value=>value!==0))throw Error('Muted dry or reverb output leaked');
      const roomContext=new OfflineAudioContext(2,48000,48000),room=new PCMPlayer({context:roomContext});
      const impulse=new Float32Array(480);impulse[0]=1;
      const buffer=room.createBuffer({data:new Uint8Array(impulse.buffer),format:'f32le',channels:1,sampleRate:48000});
      room.play(buffer,{spatial:{position:[0,0,-1],wet:1,decay:.5}});
      const rendered=await roomContext.startRendering(),samples=rendered.getChannelData(0);
      const energy=(begin,end)=>samples.slice(begin,end).reduce((sum,v)=>sum+v*v,0);
      results.reverb={tail:energy(4800,12000),afterDecay:energy(30000,40000)};
      if(results.reverb.tail<1e-8||results.reverb.afterDecay>1e-10)throw Error('Reverb tail lifetime '+JSON.stringify(results.reverb));
      await room.destroy();
      return results;
    }''')
    print(json.dumps(result))
    browser.close()
