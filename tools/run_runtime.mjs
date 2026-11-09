#!/usr/bin/env node
// Executes translated Warcraft code inside WASM, never the native EXE.
import {readFileSync, statSync, readdirSync, mkdirSync, writeFileSync,openSync,readSync,closeSync} from 'node:fs';
import {resolve, relative, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntime, GuestExit} from '../web/runtime/engine.mjs';
import {Worker} from 'node:worker_threads';
import {GuestThreadScheduler} from '../web/runtime/thread-scheduler.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const game=resolve(option('--game',join(root,'var/game')));
const wasm=resolve(option('--wasm',join(root,'var/runtime/wc3.wasm')));
const output=resolve(option('--report',join(root,'var/reports/runtime-boot.json')));
const paths=[];
function scan(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=join(dir,item.name);if(item.isDirectory())scan(p);else if(item.isFile())paths.push(relative(game,p).replaceAll('\\','/'));}}
scan(game);
const lookup=new Map(paths.map(p=>[p.toLowerCase(),p]));
function canonical(path){path=path.replaceAll('\\','/').replace(/^C:\/Warcraft III\/?/i,'').replace(/^\.\//,'');if(path.split('/').some(p=>p==='..'))throw Error('Unsafe guest path');const found=lookup.get(path.toLowerCase());if(!found)throw Error(`File not found: ${path}`);return join(game,found);}
const names=['war3.exe','Storm.dll','ijl15.dll','game.dll'];
let engine,scheduler,error=null;
try{
  engine=await createRuntime({wasm:readFileSync(wasm),profile:JSON.parse(readFileSync(join(dirname(wasm),'build.json'),'utf8')),images:names.map(name=>({name,bytes:readFileSync(canonical(name))})),
    readFile:(path,offset=0,length=undefined)=>{const file=canonical(path),size=statSync(file).size,n=Math.max(0,Math.min(length??size-offset,size-offset)),data=new Uint8Array(n),fd=openSync(file,'r');try{let done=0;while(done<n){const got=readSync(fd,data,done,n-done,offset+done);if(!got)break;done+=got;}return data.subarray(0,done);}finally{closeSync(fd);}},
    fileSize:path=>statSync(canonical(path)).size,listFiles:()=>paths,
    log:message=>process.stderr.write(String(message)+'\n')});
  engine.initialize();
  if(!args.includes('--single-thread')&&engine.instance.exports.wc3_call_context){
    scheduler=new GuestThreadScheduler(engine,{workerFactory:()=>new Worker(new URL('./guest-thread-node.mjs',import.meta.url)),
      budget:Number(option('--budget','10000000')),log:message=>process.stderr.write(String(message)+'\n')});
    await scheduler.runMain(option('--entry','war3.exe'));
  }else engine.run(option('--entry','war3.exe'),Number(option('--budget','10000000')));
}catch(caught){error=caught;process.stderr.write(`${caught.name}: ${caught.message}\n`);}
finally{scheduler?.stop();}
if(args.includes('--probe-storm')&&engine){
  // Read-only loader/MPQ diagnostics; never replace guest cryptographic state.
  const h=engine.host,storm=engine.modules.find(module=>module.name.toLowerCase()==='storm.dll');
  const crypt=h.u32(storm.base+0x4c2e4);
  console.log(JSON.stringify({crypt:crypt.toString(16),cryptHead:crypt?Array.from({length:8},(_,i)=>h.u32(crypt+i*4).toString(16)):[]}));
}
const report=engine?engine.report(error):{schemaVersion:1,wasmExecuted:false,gameplayVerified:false,error:{type:error?.name,message:error?.message,stack:error?.stack}};
if(scheduler)report.threads=scheduler.report();
mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({stage:report.stage,wasmExecuted:report.wasmExecuted,gameplayVerified:false,error:report.error?.message,report:output}));
process.exitCode=error&&!(error instanceof GuestExit)?1:0;
