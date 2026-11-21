import test from 'node:test';
import assert from 'node:assert/strict';
import {frameHeader,mpegAudioInfo,MILES_MPEG_TYPE} from '../web/runtime/mpeg-audio.mjs';

// Synthetic MPEG audio: real frame headers, silent (zero) payloads.
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
function frame([b1,b2,b3],length,pad=0){const f=new Uint8Array(length+pad);f.set([0xff,b1,b2|pad<<1,b3]);return f;}
// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, stereo: 417 bytes, +1 with padding.
const mp3=(count,{padding=()=>0}={})=>concat(Array.from({length:count},(_,i)=>frame([0xfb,0x90,0x00],417,padding(i))));
const id3v2=size=>{const t=new Uint8Array(10+size);t.set([0x49,0x44,0x33,3,0,0,(size>>21)&127,(size>>14)&127,(size>>7)&127,size&127]);return t;};
const id3v1=()=>{const t=new Uint8Array(128);t.set([0x54,0x41,0x47]);return t;};

test('frame headers give layer, rate, channels and byte length',()=>{
  assert.deepEqual(frameHeader(new Uint8Array([0xff,0xfb,0x90,0x00]),0),{version:1,layer:3,bitrate:128000,rate:44100,samples:1152,length:417,channels:2});
  assert.equal(frameHeader(new Uint8Array([0xff,0xfb,0x92,0x00]),0).length,418,'padding byte');
  // MPEG-2 Layer III 64 kbit/s 22.05 kHz mono: 576 samples, 208 bytes.
  assert.deepEqual(frameHeader(new Uint8Array([0xff,0xf3,0x80,0xc0]),0),{version:2,layer:3,bitrate:64000,rate:22050,samples:576,length:208,channels:1});
  // MPEG-1 Layer II 192 kbit/s 48 kHz: 1152 samples, 576 bytes.
  assert.equal(frameHeader(new Uint8Array([0xff,0xfd,0xa4,0x00]),0).length,576);
  for(const bad of [[0xff,0xfb,0x00,0],[0xff,0xfb,0xf0,0],[0xff,0xfb,0x9c,0],[0xff,0xe9,0x90,0],[0xff,0xf9,0x90,0],[0xfe,0xfb,0x90,0]])
    assert.equal(frameHeader(new Uint8Array(bad),0),null,bad.join(','));
});

test('duration counts complete frames after ID3v2 and before ID3v1, padding included',()=>{
  const info=mpegAudioInfo(concat([id3v2(300),mp3(100,{padding:i=>i%3===0?1:0}),id3v1()]));
  assert.equal(info.firstFrame,310);assert.equal(info.frames,100);assert.equal(info.samples,115200);
  assert.ok(Math.abs(info.seconds-100*1152/44100)<1e-9);assert.equal(info.channels,2);assert.equal(info.rate,44100);
  assert.equal(MILES_MPEG_TYPE[info.layer],13);
  // A truncated last frame is not counted; junk between frames is skipped.
  const cut=mp3(10).subarray(0,417*10-100);assert.equal(mpegAudioInfo(cut).frames,9);
  const gap=concat([mp3(5),new Uint8Array(37),mp3(5)]);assert.equal(mpegAudioInfo(gap).frames,10);
});

test('a Xing or VBRI header frame is metadata, not audio',()=>{
  const stream=mp3(20);stream.set([0x58,0x69,0x6e,0x67],4+32);
  assert.equal(mpegAudioInfo(stream).frames,19);
  const vbri=mp3(20);vbri.set([0x56,0x42,0x52,0x49],36);assert.equal(mpegAudioInfo(vbri).frames,19);
});

test('only a confirmed frame sequence is audio: WAV, text and lone sync bytes are not',()=>{
  const wav=new Uint8Array(64);wav.set(new TextEncoder().encode('RIFF....WAVEfmt '));
  assert.equal(mpegAudioInfo(wav),null);
  assert.equal(mpegAudioInfo(new TextEncoder().encode('Sound\\Music\\mp3Music\\Doom.mp3')),null);
  const lone=new Uint8Array(4096);lone.set([0xff,0xfb,0x90,0x00],100);assert.equal(mpegAudioInfo(lone),null);
  assert.equal(mpegAudioInfo(new Uint8Array(0)),null);
  // Identification alone does not walk the stream.
  const quick=mpegAudioInfo(mp3(50),{countFrames:false});assert.equal(quick.layer,3);assert.equal(quick.frames,0);
});
