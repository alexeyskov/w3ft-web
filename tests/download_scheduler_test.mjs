import test from 'node:test';
import assert from 'node:assert/strict';
import {BLOCK,cacheEntries} from '../web/runtime/game-cache.mjs';
import {downloadTasks} from '../web/runtime/download-plan.mjs';
import {DownloadScheduler} from '../web/runtime/download-scheduler.mjs';
import {sourceFiles} from '../web/runtime/game-files.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<500;i++){if(check())return;await wait(2);}assert.fail('Scheduler did not settle');}
const entry=(label,size=BLOCK,key=label)=>({key,size,label,url:`/${key}`,version:'v1'});
class Disk {
  constructor(entries){this.entries=new Map(entries.map(e=>[e.key,e]));this.blocks=new Map();}
  has(key,i){return this.blocks.has(key+':'+i);}
  read(key,i){return this.blocks.get(key+':'+i)||null;}
  async prepare(){return true;}
  write(key,i,bytes){assert.equal(bytes.length,Math.min(BLOCK,this.entries.get(key).size-i*BLOCK));this.blocks.set(key+':'+i,bytes);return true;}
  cachedBytes(key){let size=0;for(const [block,bytes] of this.blocks)if(block.startsWith(key+':'))size+=bytes.length;return size;}
  flush(){}
}
function fixture(entries,options={}) {
  const disk=new Disk(entries),requests=[],progress=[];
  const fetcher=async(url,{headers})=>{
    const file=entries.find(e=>e.url===url),[start,end]=headers.Range.slice(6).split('-').map(Number);
    requests.push([file.label,start,end]);
    return new Response(new Uint8Array(end-start+1).fill(17),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${file.size}`}});
  };
  const scheduler=new DownloadScheduler(entries,disk,{fetcher,onProgress:p=>progress.push(p),gapMs:0,quietMs:0,estimate:()=>null,...options});
  return {disk,requests,progress,scheduler,fetcher};
}

test('plan binds offsets to file version, deduplicates overlapping blocks and covers unknown data',()=>{
  const file=entry('war3.mpq',BLOCK*5),plan={schemaVersion:1,blockSize:BLOCK,files:[{
    path:file.label,size:file.size,version:'v1',phases:{menu:[[2,2]],multiplayer:[[1,2]],match:[[0,1],[99,100]]}}]};
  assert.deepEqual(downloadTasks([file],plan).map(t=>[t.phase,t.first,t.last]),[
    ['menu',2,2],['multiplayer',1,1],['match',0,0],['campaign',3,4]]);
  file.version='replaced';
  assert.ok(downloadTasks([file],plan).every(t=>t.phase==='campaign'),'stale byte offsets rejected');
  const assets=['Movies/IntroX.mpq','WebMedia/IntroX.webm','WebMedia/TutorialIn.webm','WebMedia/HumanOp.webm','war3.mpq']
    .map((path,id)=>({id,path,version:'1',size:5,downloadUrl:'/x'}));
  assert.deepEqual(cacheEntries(assets).map(e=>e.label),['WebMedia/HumanOp.webm','war3.mpq']);
});

test('menus -> multiplayer -> matches -> campaign; completed cache is reused without a download',async()=>{
  const entries=['Campaigns/c.w3n','Maps/map.w3x','UI/Multiplayer/room.fdf','UI/Menu.fdf'].map(p=>entry(p));
  const f=fixture(entries);f.scheduler.start();
  await until(()=>f.scheduler.state==='complete');
  assert.deepEqual(f.requests.map(r=>r[0]),entries.map(e=>e.label).reverse());
  assert.equal(f.progress.at(-1).cached,4*BLOCK);await f.scheduler.stop();
  const repeat=new DownloadScheduler(entries,f.disk,{gapMs:0,fetcher:()=>assert.fail('must use stored blocks')});
  repeat.start();await until(()=>repeat.state==='complete');await repeat.stop();
});

test('urgent game read aborts background immediately; full blocks survive, incomplete block is retried',async()=>{
  const archive=entry('war3.mpq',BLOCK*3,'a-archive'),map=entry('Maps/custom.w3x',BLOCK,'m-map');
  const f=fixture([archive,map]);
  let stalled=false,aborted=false,releaseUrgent;
  f.scheduler.fetcher=async(url,options)=>{
    if(url!==archive.url||stalled)return f.fetcher(url,options);
    stalled=true;
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new Uint8Array(BLOCK+100).fill(9));
      options.signal.addEventListener('abort',()=>{aborted=true;controller.error(new DOMException('Aborted','AbortError'));},{once:true});
    }}),{status:206,headers:{'Content-Range':`bytes 0-${archive.size-1}/${archive.size}`}});
  };
  // Start the archive first to exercise interruption inside a response body.
  f.scheduler.background.reverse();f.scheduler.start();
  await until(()=>f.disk.has(archive.key,0));
  const files=sourceFiles([{path:map.label,downloadUrl:map.url,size:map.size,cacheKey:map.key}],f.disk,{
    downloads:f.scheduler,fetch:async()=>{await new Promise(resolve=>{releaseUrgent=resolve;});return f.fetcher(map.url,{headers:{Range:`bytes=0-${BLOCK-1}`}});}});
  const read=files.readFileLater(map.label,0,12);
  assert.ok(aborted,'AbortSignal fired before urgent request');
  assert.equal(f.disk.has(archive.key,1),false,'partial block not marked cached');
  await wait(15);assert.equal(f.requests.length,0,'background does not run beside urgent stream');
  releaseUrgent();assert.equal((await read)[0],17);
  await until(()=>f.scheduler.state==='complete');
  assert.equal(f.requests.filter(r=>r[0]===map.label).length,1,'foreground map never downloaded twice');
  assert.equal(f.requests.find(r=>r[0]===archive.label)[1],BLOCK,'completed block not redownloaded');
  await f.scheduler.stop();
});

test('chosen map and match assets move ahead of remaining menu work; concurrent demand holds all background',async()=>{
  const entries=['UI/Menu.fdf','UI/Extra.fdf','Maps/other.w3x','Maps/chosen.w3x','Campaigns/c.w3n'].map((p,i)=>entry(p,BLOCK,(p.startsWith('Maps')?'m-':'a-')+i));
  const f=fixture(entries),chosen=entries[3];
  const release1=f.scheduler.demand({path:chosen.label,cacheKey:chosen.key});
  const release2=f.scheduler.demand({path:chosen.label,cacheKey:chosen.key});
  f.scheduler.start();release1();await wait(10);assert.equal(f.requests.length,0);
  release2();await until(()=>f.scheduler.state==='complete');
  assert.deepEqual(f.requests.map(r=>r[0]),[chosen.label,entries[2].label,entries[0].label,entries[1].label,entries[4].label]);
  await f.scheduler.stop();
});

test('quota pauses optional work without downloading or throwing into the game; resume can retry',async()=>{
  const f=fixture([entry('UI/Menu.fdf')],{estimate:()=>({usage:950*1048576,quota:1000*1048576})});
  f.scheduler.start();await until(()=>f.scheduler.reason==='quota');assert.equal(f.requests.length,0);
  f.scheduler.estimate=()=>null;f.scheduler.resume();await until(()=>f.scheduler.state==='complete');await f.scheduler.stop();
});

test('cached map payload predicts match resources; catalog headers and unknown MPQ reads do not change the plan',async()=>{
  const entries=[entry('UI/Menu.fdf'),entry('Maps/cached.w3x'),entry('Maps/next.w3x'),entry('war3.mpq')];
  const f=fixture(entries),map=entries[1];
  f.disk.write(map.key,0,new Uint8Array(BLOCK));
  const files=sourceFiles([{path:map.label,downloadUrl:map.url,size:map.size,cacheKey:map.key,header:new Uint8Array(124)}],f.disk,{downloads:f.scheduler});
  files.readFile(map.label,0,124);assert.equal(f.scheduler.priority.length,0);
  f.scheduler.demand({path:'war3.mpq',cacheKey:entries[3].key})();
  assert.equal(f.scheduler.priority.length,0,'unclassified data must not prioritize all campaign files');
  assert.equal(files.readFileLater(map.label,124,100),null);
  assert.equal(f.scheduler.priority[0].entry.key,map.key);
  f.scheduler.start();await until(()=>f.scheduler.state==='complete');
  assert.deepEqual(f.requests.map(r=>r[0]),[entries[2].label,entries[0].label,entries[3].label]);
  await f.scheduler.stop();
});

test('a newly chosen campaign supersedes previously anticipated match resources',async()=>{
  const entries=[entry('Maps/a.w3x',BLOCK,'m-a'),entry('Maps/b.w3x',BLOCK,'m-b'),entry('Campaigns/c.w3n',BLOCK,'m-c')];
  const f=fixture(entries);
  for(const file of entries)f.scheduler.demand({path:file.label,cacheKey:file.key})();// a -> b -> campaign
  f.scheduler.start();await until(()=>f.scheduler.state==='complete');
  assert.deepEqual(f.requests.map(r=>r[0]),[entries[2].label,entries[1].label,entries[0].label]);
  await f.scheduler.stop();
});

test('pause cancels headers waiting; resume and stop release all work',async()=>{
  const f=fixture([entry('UI/Menu.fdf')]);let aborted=false;
  f.scheduler.fetcher=(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
    aborted=true;reject(new DOMException('Aborted','AbortError'));
  },{once:true}));
  f.scheduler.start();await until(()=>f.scheduler.metrics.requests===1);f.scheduler.pause();
  await until(()=>!f.scheduler.active);assert.ok(aborted);assert.equal(f.scheduler.reason,'user');
  f.scheduler.fetcher=f.fetcher;f.scheduler.resume();await until(()=>f.scheduler.state==='complete');await f.scheduler.stop();
});

test('a server ignoring Range is cancelled instead of streaming the entire archive',async()=>{
  let cancelled=false;
  const f=fixture([entry('war3.mpq')],{fetcher:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:200})});
  f.scheduler.start();await until(()=>cancelled);
  await until(()=>!f.scheduler.active);
  assert.equal(f.scheduler.metrics.retries,1);
  assert.equal(f.disk.cachedBytes('war3.mpq'),0);
  await f.scheduler.stop();
});

test('network cooldown retries automatically and stopping cancels the retry timer',async()=>{
  const f=fixture([entry('UI/Menu.fdf')],{retryMs:20});
  f.scheduler.pause('network');f.scheduler.start();
  await until(()=>f.scheduler.state==='complete');
  assert.equal(f.requests.length,1);await f.scheduler.stop();
  const stopped=fixture([entry('UI/Menu.fdf')],{retryMs:20});
  stopped.scheduler.pause('network');stopped.scheduler.start();await stopped.scheduler.stop();
  await wait(30);assert.equal(stopped.requests.length,0);
});
