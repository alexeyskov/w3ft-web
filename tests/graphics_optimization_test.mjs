import test from 'node:test';
import assert from 'node:assert/strict';
import {FixedFunctionGL, GL, mat4Identity} from '../web/runtime/graphics.mjs';

function renderer() {
  const r=Object.create(FixedFunctionGL.prototype);
  r.mode=GL.MODELVIEW;r.matrices=new Map([[GL.MODELVIEW,[mat4Identity()]],[GL.PROJECTION,[mat4Identity()]],[GL.TEXTURE,[mat4Identity()]]]);
  r.lightingVersion=1;r.lighting={lights:[{ambient:[0,0,0,1],diffuse:[1,1,1,1],specular:[1,1,1,1],position:[0,0,1,0],direction:[0,0,-1],exponent:0,cutoff:180,attenuation:[1,0,0]}]};
  return r;
}

test('identical matrix loads preserve immutable identity without aliasing guest data',()=>{
  const r=renderer(),identity=r._matrix();
  r.loadIdentity();r.loadMatrix(new Float64Array(identity));assert.equal(r._matrix(),identity);
  const translated=mat4Identity();translated[12]=4;r.loadMatrix(translated);const current=r._matrix();
  translated[12]=8;assert.equal(current[12],4);assert.notEqual(current,identity);
  r.loadMatrix(new Float32Array(current));assert.equal(r._matrix(),current);
  r.pushMatrix();r.loadIdentity();r.popMatrix();assert.equal(r._matrix(),current);
  r.matrixMode(GL.PROJECTION);r.loadMatrix(translated);assert.equal(r._matrix(GL.MODELVIEW),current);
  assert.throws(()=>r.loadMatrix(new Float32Array(16).fill(NaN)),/finite/);
  assert.throws(()=>r.loadMatrix([1,2,3]),/16 components/);
});

test('light caches preserve captured modelview semantics and do not retain guest vectors',()=>{
  const r=renderer(),light=r.lighting.lights[0];
  r.lightfv(GL.LIGHT0,GL.DIFFUSE,[1,1,1,1]);assert.equal(r.lightingVersion,1);
  const diffuse=[.5,.4,.3,1];r.lightfv(GL.LIGHT0,GL.DIFFUSE,diffuse);assert.equal(r.lightingVersion,2);
  diffuse[0]=.2;assert.equal(light.diffuse[0],.5);
  r.lightfv(GL.LIGHT0,GL.DIFFUSE,[.5,.4,.3,1]);assert.equal(r.lightingVersion,2);
  r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,1]);const v=r.lightingVersion;
  r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,1]);assert.equal(r.lightingVersion,v);
  r.translate(3,4,5);r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,1]);assert.deepEqual(light.position,[3,4,6,1]);
  r.loadIdentity();assert.deepEqual(light.position,[3,4,6,1],'modelview changes do not move previously specified lights');
  r.lightfv(GL.LIGHT0,GL.POSITION,[0,0,1,1]);assert.deepEqual(light.position,[0,0,1,1]);
  r.lightfv(GL.LIGHT0,GL.SPOT_DIRECTION,[1,0,0]);r.rotate(90,0,0,1);r.lightfv(GL.LIGHT0,GL.SPOT_DIRECTION,[1,0,0]);
  assert.ok(Math.abs(light.direction[0])<1e-6);assert.ok(Math.abs(light.direction[1]-1)<1e-6);
  const after=r.lightingVersion;r.lightfv(GL.LIGHT0,GL.SPOT_DIRECTION,[1,0,0]);assert.equal(r.lightingVersion,after);
  assert.throws(()=>r.lightfv(GL.LIGHT0,GL.DIFFUSE,[1,NaN,1,1]),/finite/);
  assert.throws(()=>r.lightfv(GL.LIGHT0,GL.SPOT_EXPONENT,[]),/outside/);
});

test('stream uploads append with aligned offsets and orphan before wrap or growth',()=>{
  const r=renderer(),calls=[];r.streamingBuffers=true;
  r.gl={STREAM_DRAW:0x88e0,bufferData:(...a)=>calls.push(['allocate',...a]),bufferSubData:(...a)=>calls.push(['upload',...a])};
  const stream={capacity:0,offset:0,allocations:0},target=0x8892;
  assert.equal(r._streamUpload(target,stream,Uint8Array.of(1,2,3)),0);
  assert.equal(r._streamUpload(target,stream,Uint16Array.of(4,5,6)),4);
  assert.equal(stream.offset,12);assert.equal(stream.allocations,1);
  assert.equal(calls[2][2],4);assert.equal(calls[2][5],3,'source length is measured in Uint16 elements');
  stream.offset=stream.capacity-4;
  assert.equal(r._streamUpload(target,stream,Uint32Array.of(1,2)),0);assert.equal(stream.allocations,2);
  const large=new Uint8Array(1048577);assert.equal(r._streamUpload(target,stream,large),0);
  assert.equal(stream.capacity,2097152);assert.equal(stream.allocations,3);
  const count=calls.length;assert.equal(r._streamUpload(target,stream,new Uint8Array(0)),0);assert.equal(calls.length,count);
  assert.equal(r._streamUpload(target,stream,new Uint8Array(64),12),1048580);
  assert.equal(calls.at(-1)[5],12,'scratch capacity beyond the current draw is not uploaded');
});

test('3D scene evidence requires a nonempty perspective draw with depth testing',()=>{
  const r=renderer();r.draws=0;r.perspectiveDraws=0;r.nativeDraws=0;r.borderDraws=0;r.glCaps=new Map([[GL.DEPTH_TEST,true]]);
  r._recordDraw(3);assert.equal(r.perspectiveDraws,0,'orthographic loading UI');
  r.matrixMode(GL.PROJECTION);r.frustum(-1,1,-1,1,1,10);
  r._recordDraw(0);assert.equal(r.perspectiveDraws,0,'an empty draw is not a scene');
  r._recordDraw(3);assert.equal(r.perspectiveDraws,1);
  r.glCaps.set(GL.DEPTH_TEST,false);r._recordDraw(3);assert.equal(r.perspectiveDraws,1);
  r.glCaps.set(GL.DEPTH_TEST,true);r._recordDraw(6);assert.equal(r.perspectiveDraws,2);
});
