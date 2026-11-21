import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFile,mapChanges,saveSnapshot,isUserMap} from '../web/runtime/persistence.mjs';
import {WarcraftHost} from '../web/runtime/host.mjs';

// A map's first bytes: HM3W, an unused word, the title, flags and player count.
function hm3w(title,players=4,size=512){
  const bytes=new Uint8Array(size),name=new TextEncoder().encode(title);
  bytes.set(new TextEncoder().encode('HM3W'));bytes.set(name,8);
  new DataView(bytes.buffer).setUint32(8+name.length+5,players,true);
  return bytes;
}

function fixture(){
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:16}),listFiles:()=>[]});
  h.base=0;let next=0x10000;h.exports={wc3_guest_alloc:n=>{const p=next;next+=n;return p;}};
  const call=(name,...args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
  return {h,call};
}

// Node has no FileReaderSync: each slice of this Blob carries its bytes.
function storedFile(bytes,reads=[]){
  const blob=new Blob([bytes]),slice=blob.slice.bind(blob);
  blob.slice=(start,end)=>Object.assign(slice(start,end),{bytes:bytes.slice(start,end).buffer});
  return new StoredFile(blob,{read:part=>{reads.push(part.size);return part.bytes;}});
}

test('a stored map reads from its Blob in blocks, as Warcraft reads the file',()=>{
  const bytes=new Uint8Array(600*1024).map((_,i)=>i%251),reads=[],file=storedFile(bytes,reads);
  assert.equal(file.length,bytes.length);
  assert.deepEqual(file.slice(10,20),bytes.slice(10,20));
  assert.deepEqual(file.slice(256*1024-5,256*1024+5),bytes.slice(256*1024-5,256*1024+5),'a read across blocks');
  assert.deepEqual(file.slice(590*1024),bytes.slice(590*1024));
  assert.deepEqual(file.slice(-1,2),bytes.slice(0,2));assert.equal(file.slice(700*1024,800*1024).length,0);
  assert.deepEqual(reads,[256*1024,256*1024,88*1024],'each block is read once');
});

test('Maps/Download goes to the map store, not the saves, and stored maps open, read and delete like files',()=>{
  const {h,call}=fixture(),bytes=hm3w('Hosted',2,3000);
  h.virtualFiles.set('maps/download/hosted.w3x',storedFile(bytes));h.virtualFiles.set('save/profile/a.w3z',Uint8Array.of(1));h.virtualFiles.checkpoint();
  // Opened and read by the game.
  const file=call('CreateFileA',h.string('Maps\\Download\\Hosted.w3x'),0x80000000,1,0,3,0,0),output=h.alloc(64),count=h.alloc(4);
  assert.notEqual(file,0xffffffff);
  assert.equal(call('GetFileSize',file,0),3000);
  assert.equal(call('ReadFile',file,output,16,count,0),1);assert.deepEqual(h.copyOut(output,4),Uint8Array.of(0x48,0x4d,0x33,0x57));
  call('CloseHandle',file);
  const find=h.alloc(320);assert.notEqual(call('FindFirstFileA',h.string('Maps\\Download\\*.w3x'),find),0xffffffff);
  assert.equal(h.cstr(find+44),'hosted.w3x');
  assert.deepEqual(mapChanges(h),{files:[],deleted:[]},'reading changes nothing');
  // A LAN download: written in parts, kept only once the game closes it.
  const download=call('CreateFileA',h.string('Maps\\Download\\Other.w3x'),0x40000000,0,0,2,0,0),data=h.alloc(3000);
  h.copyIn(data,bytes);call('WriteFile',download,data,1000,count,0);
  assert.deepEqual(mapChanges(h),{files:[],deleted:[]},'an unfinished download is not stored');
  call('WriteFile',download,data+1000,2000,count,0);
  assert.deepEqual(saveSnapshot(h,{separateMaps:true}),{files:[],deleted:[]});
  call('CloseHandle',download);
  const saves=saveSnapshot(h,{separateMaps:true});assert.deepEqual(saves,{files:[],deleted:[]},'maps are not saves');
  const maps=mapChanges(h);assert.deepEqual(maps.files.map(f=>[f.path,f.data.length]),[['maps/download/other.w3x',3000]]);
  assert.deepEqual(maps.files[0].data,bytes);
  // The game may delete a stored map, as it may any file in its folder.
  assert.equal(call('DeleteFileA',h.string('Maps\\Download\\Hosted.w3x')),1);
  assert.deepEqual(mapChanges(h),{files:[],deleted:['maps/download/hosted.w3x']});
  // At the end of a session the saves never carry the maps.
  const full=saveSnapshot(h,{full:true,separateMaps:true});
  assert.deepEqual(full.files.map(f=>f.path),['save/profile/a.w3z']);assert.deepEqual(full.deleted,[]);
  // A launcher without a map store keeps them with the saves, as before.
  assert.deepEqual(saveSnapshot(h,{full:true}).files.map(f=>f.path).sort(),['maps/download/other.w3x','save/profile/a.w3z']);
  assert.ok(isUserMap('maps/download/x.w3m')&&!isUserMap('maps/download/sub/x.w3x')&&!isUserMap('maps/custom/x.w3x')&&!isUserMap('maps/download/x.txt'));
});

// W3GS_MAPCHECK as a LAN host sends it: path, size, map info, CRC and SHA-1.
function mapCheck(path,size){
  const name=new TextEncoder().encode(path),packet=new Uint8Array(8+name.length+1+4+4+4+20),view=new DataView(packet.buffer);
  packet.set([0xf7,0x3d]);view.setUint16(2,packet.length,true);view.setUint32(4,1,true);packet.set(name,8);
  view.setUint32(8+name.length+1,size,true);return packet;
}

test('the size a LAN host announces decides whether a downloaded map is complete',async()=>{
  const {VirtualWinsock}=await import('../web/runtime/winsock.mjs');
  const {MapOffers}=await import('../web/runtime/map-offers.mjs');
  const tick=()=>new Promise(resolve=>setImmediate(resolve)),transports=[];
  for(const peerId of [1,2]){
    const transport=new EventTarget();transport.peerId=peerId;
    transport.send=(destination,data)=>{for(const other of transports)if(other!==transport&&(!destination||destination===other.peerId))setImmediate(()=>other.dispatchEvent(new CustomEvent('packet',{detail:{source:peerId,data:data.slice()}})));};
    transports.push(transport);
  }
  const [hostNet,guestNet]=transports.map(transport=>new VirtualWinsock(transport)),offers=new MapOffers(guestNet);
  const listener=hostNet.socket('tcp');hostNet.bind(listener,{port:6112});hostNet.listen(listener);
  const client=guestNet.socket('tcp');try{guestNet.connect(client,{address:hostNet.address,port:6112});}catch{}
  for(let i=0;i<4;i++)await tick();
  const server=hostNet.accept(listener).socket;
  // Another packet first, the map check split over two reads, and a peek.
  const stream=new Uint8Array([0xf7,0x01,8,0,1,2,3,4,...mapCheck('Maps\\Download\\(2)EchoIslesUser.w3x',117071)]);
  hostNet.send(server,stream);for(let i=0;i<4;i++)await tick();
  guestNet.recv(client,20,2);assert.equal(offers.sizes.size,0,'a peek is not a read');
  guestNet.recv(client,20);guestNet.recv(client,4096);
  assert.deepEqual([...offers.sizes],[['maps/download/(2)echoislesuser.w3x',117071]]);
  // The guest's game writes the download; a short file is not kept.
  const {h,call}=fixture(),bytes=hm3w('Echo',2,4000),data=h.alloc(4000),count=h.alloc(4);h.copyIn(data,bytes);
  const sizes=new Map([['maps/download/a.w3x',4000],['maps/download/b.w3x',4000]]);
  for(const [name,length] of [['A',4000],['B',2500]]){
    const file=call('CreateFileA',h.string(`Maps\\Download\\${name}.w3x`),0x40000000,0,0,2,0,0);
    call('WriteFile',file,data,length,count,0);call('CloseHandle',file);
  }
  const taken=mapChanges(h,sizes);assert.deepEqual(taken.files.map(f=>[f.path,f.data.length]),[['maps/download/a.w3x',4000]]);
  assert.ok(h.virtualFiles.dirty.has('maps/download/b.w3x'),'the short file waits: it may still be completed');
  offers.destroy();assert.equal(guestNet.streamObservers.size,0);
});
