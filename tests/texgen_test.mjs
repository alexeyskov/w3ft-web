import test from 'node:test';
import assert from 'node:assert/strict';
import {FixedFunctionGL,GL,mat4Identity,mat4Multiply,mat4Inverse,normalMatrix} from '../web/runtime/graphics.mjs';

function renderer(){
  const r=Object.create(FixedFunctionGL.prototype);
  r.gl={isContextLost:()=>false};r.mode=GL.MODELVIEW;r.matrices=new Map([[GL.MODELVIEW,[mat4Identity()]]]);
  r.currentNormal=[0,0,1];r.currentTexcoord=[0,0,0,1];
  r.texgen=Array.from({length:4},(_,i)=>({enabled:false,mode:GL.EYE_LINEAR,objectPlane:[0,1,2,3].map(j=>j===i?1:0),eyePlane:[0,1,2,3].map(j=>j===i?1:0)}));
  return r;
}
const near=(actual,expected)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-5,`${actual} != ${expected}`));
test('normal transform is inverse-transpose and inverse handles translated rotated nonuniform scales',()=>{
  const r=renderer();r.translate(3,-2,7);r.rotate(35,1,2,3);r.scale(2,3,4);
  near(mat4Multiply(r._matrix(),mat4Inverse(r._matrix())),mat4Identity());
  r.loadIdentity();r.scale(2,3,4);near(normalMatrix(r._matrix()),[.5,0,0,0,1/3,0,0,0,.25]);
});
test('a singular modelview uses the identity inverse, as Mesa does, instead of failing the draw',()=>{
  // A 20-minute LAN match stopped on a model scaled to zero on one axis.
  const r=renderer();r.translate(3,-2,7);r.scale(0,1,1);
  assert.deepEqual(Array.from(normalMatrix(r._matrix())),[1,0,0,0,1,0,0,0,1]);
  r.loadIdentity();r.scale(1e-200,1e-200,1e-200); // zero in float: also singular
  assert.deepEqual(Array.from(normalMatrix(r._matrix())),[1,0,0,0,1,0,0,0,1]);
  r.loadIdentity();r.scale(1e-20,2,4); // tiny but invertible: the true inverse
  const tiny=normalMatrix(r._matrix());
  assert.ok(Math.abs(tiny[0]/1e20-1)<1e-5);near([tiny[4],tiny[8]],[.5,.25]);
  r.loadIdentity();r.scale(0,0,0);r.texGenfv(GL.T,GL.EYE_PLANE,[0,1,0,0]);
  assert.deepEqual(r.texgen[1].eyePlane,[0,1,0,0]);
});
test('object and eye planes capture their coordinate systems independently',()=>{
  const r=renderer(),a={positions:new Float32Array([2,3,4])};
  r.enable(GL.TEXTURE_GEN_S);r.enable(GL.TEXTURE_GEN_T);
  r.texGenfv(GL.S,GL.TEXTURE_GEN_MODE,[GL.OBJECT_LINEAR]);r.texGenfv(GL.S,GL.OBJECT_PLANE,[2,0,0,1]);
  r.translate(0,5,0);r.texGenfv(GL.T,GL.EYE_PLANE,[0,1,0,0]);
  near(r._generatedTexcoords(a,1),[5,3,0,1]);
  r.loadIdentity();near(r._generatedTexcoords(a,1),[5,-2,0,1]);
});
test('sphere, normal, reflection generation preserve disabled coordinates and homogeneous q',()=>{
  const r=renderer(),a={positions:new Float32Array([0,0,-2]),texcoords:new Float32Array([.1,.2,.3,2]),texcoordSize:4};
  r.enable(GL.TEXTURE_GEN_S);r.enable(GL.TEXTURE_GEN_T);
  for(const c of [GL.S,GL.T])r.texGenfv(c,GL.TEXTURE_GEN_MODE,[GL.SPHERE_MAP]);
  near(r._generatedTexcoords(a,1),[.5,.5,.3,2]);
  r.enable(GL.TEXTURE_GEN_R);
  for(const c of [GL.S,GL.T,GL.R])r.texGenfv(c,GL.TEXTURE_GEN_MODE,[GL.REFLECTION_MAP]);
  near(r._generatedTexcoords(a,1),[0,0,1,2]);
  r.normal(0,1,0);for(const c of [GL.S,GL.T,GL.R])r.texGenfv(c,GL.TEXTURE_GEN_MODE,[GL.NORMAL_MAP]);
  near(r._generatedTexcoords(a,1),[0,1,0,2]);
  assert.throws(()=>r.texGenfv(GL.Q,GL.TEXTURE_GEN_MODE,[GL.SPHERE_MAP]),/invalid coordinate/);
});
