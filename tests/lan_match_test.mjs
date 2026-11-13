import test from 'node:test';
import assert from 'node:assert/strict';
import {VirtualWinsock} from '../web/runtime/winsock.mjs';
import {LANMatchReporter,matchStatusPacket} from '../web/runtime/lan-match.mjs';

function fixture(){
  const transport=new EventTarget(),sent=[];transport.peerId=1;transport.send=(destination,data)=>sent.push({destination,data});
  const network=new VirtualWinsock(transport),clock={now:0};
  const reporter=new LANMatchReporter(network,{clock:()=>clock.now});
  const udp=network.socket('udp');network.bind(udp,{port:6112});network.setsockopt(udp,'SO_BROADCAST',true);
  const listener=network.socket('tcp');network.bind(listener,{port:6112});network.listen(listener);
  const host={handles:new Map()},frame={perspectiveDraws:50};
  const packet=(id,length)=>{const data=new Uint8Array(length);data.set([0xf7,id,length,0]);return data;};
  const send=(id,length,counterOffset)=>{const data=packet(id,length);new DataView(data.buffer).setUint32(counterOffset,1,true);network.sendto(udp,data,{address:'255.255.255.255',port:6112});};
  return {network,reporter,clock,host,frame,listener,udp,sent,
    create:()=>send(0x31,16,12),load:()=>send(0x33,8,4),
    replay:()=>host.handles.set(1,{kind:'file',key:'tempreplay.w3g',writing:true}),
    render:()=>reporter.frame(host,frame),reports:()=>sent.filter(x=>x.destination===255),
    done:()=>{reporter.destroy();network.destroy();}};
}

test('solo LAN starts only after host lifecycle, an open replay and a later perspective scene',()=>{
  const f=fixture();
  f.render();f.create();f.render();assert.equal(f.reports().length,0,'lobby is not a match');
  f.load();f.render();assert.equal(f.reports().length,0,'withdrawn advertisement is not a match');
  f.replay();f.render();f.render();assert.equal(f.reports().length,0,'flat loading frames are not gameplay');
  f.frame.perspectiveDraws++;f.render();
  assert.equal(f.reports().length,1);assert.deepEqual(f.reports()[0].data,matchStatusPacket(6112,true));
  f.render();assert.equal(f.reports().length,1);
  f.clock.now=10001;f.render();assert.equal(f.reports().length,2,'paused map refreshes its lifetime');
  f.host.handles.clear();f.render();assert.deepEqual(f.reports().at(-1).data,matchStatusPacket(6112,false));f.done();
});

test('single player, old replay files and watching replays never count',()=>{
  const f=fixture();f.replay();f.render();f.frame.perspectiveDraws++;f.render();
  assert.equal(f.reports().length,0,'single-player has no LAN host advertisement');
  f.host.handles.get(1).writing=false;f.create();f.load();f.render();f.frame.perspectiveDraws++;f.render();
  assert.equal(f.reports().length,0,'read-only replay playback is not a live game');f.done();
});

test('socket close, cancelled host and a later game cannot reuse old phase',()=>{
  for(const end of ['close','search']){
    const f=fixture();f.create();f.load();f.replay();f.render();f.frame.perspectiveDraws++;f.render();
    if(end==='close')f.network.close(f.listener);
    else f.network.sendto(f.udp,Uint8Array.of(247,47,4,0),{address:'255.255.255.255',port:6112});
    assert.deepEqual(f.reports().at(-1).data,matchStatusPacket(6112,false));
    const count=f.reports().length;f.frame.perspectiveDraws++;f.render();assert.equal(f.reports().length,count);f.done();
  }
  const f=fixture();f.create();f.load();f.network.listen(f.listener);
  f.replay();f.render();f.frame.perspectiveDraws++;f.render();assert.equal(f.reports().length,0);f.done();
});

test('refreshing listen backlog during a recorded match does not end it',()=>{
  const f=fixture();f.create();f.load();f.replay();f.render();f.frame.perspectiveDraws++;f.render();
  f.network.listen(f.listener,32);f.render();assert.equal(f.reports().length,1);
  assert.equal(f.reporter.reportedPort,6112);
  f.host.handles.clear();f.render();assert.deepEqual(f.reports().at(-1).data,matchStatusPacket(6112,false));f.done();
});

test('telemetry failure does not stop gameplay; successful retry restores its heartbeat',()=>{
  const f=fixture();f.create();f.load();f.replay();f.render();f.frame.perspectiveDraws++;
  const send=f.network.transport.send;f.network.transport.send=()=>{throw Error('Disconnected');};
  assert.doesNotThrow(f.render);assert.equal(f.reports().length,0);
  f.network.transport.send=send;f.render();assert.equal(f.reports().length,1);f.done();
});
