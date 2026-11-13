import test from 'node:test';
import assert from 'node:assert/strict';
import {DownloadEstimate} from '../web/src/download-estimate.mjs';

function fixture() {
  let time=0;
  const estimate=new DownloadEstimate(()=>time);
  return {estimate,at(value,done,total=1000){time=value;estimate.update({done,total});},advance(value){time=value;}};
}

test('waits for measured progress and excludes an initial cached amount from speed',()=>{
  const f=fixture();
  assert.equal(f.estimate.seconds(),null);
  f.at(0,500);f.at(1000,600);
  assert.equal(f.estimate.seconds(),null);
  f.at(3000,800);
  assert.equal(f.estimate.seconds(),2);
});

test('recent average smooths bursts but adapts to a changed connection speed',()=>{
  const f=fixture();
  for(let second=0;second<=20;second++)f.at(second*1000,second*10,2000);
  assert.equal(f.estimate.seconds(),180);
  f.at(21000,300,2000);
  assert.ok(f.estimate.seconds()>80,'One burst must not imply the new steady speed');
  for(let second=22;second<=41;second++)f.at(second*1000,300+(second-21)*20,2000);
  assert.equal(f.estimate.seconds(),65);
});

test('includes brief idle time, hides a stale estimate and measures again on resume',()=>{
  const f=fixture();
  f.at(0,0);f.at(3000,300);
  assert.equal(f.estimate.seconds(),7);
  f.advance(6000);
  assert.equal(f.estimate.seconds(),14);
  f.advance(13000);
  assert.equal(f.estimate.seconds(),null);
  f.at(14000,400);
  assert.equal(f.estimate.seconds(),null);
  f.at(17000,700);
  assert.equal(f.estimate.seconds(),3);
});

test('changed totals and restarted progress reset old rates; completion is finite',()=>{
  const f=fixture();
  f.at(0,0);f.at(3000,300);
  f.at(4000,400,2000);
  assert.equal(f.estimate.seconds(),null);
  f.at(7000,700,2000);
  assert.equal(f.estimate.seconds(),13);
  f.at(8000,0,2000);
  assert.equal(f.estimate.seconds(),null);
  f.at(9000,2000,2000);
  assert.equal(f.estimate.seconds(),0);
  const empty=fixture();empty.at(0,0,0);
  assert.equal(empty.estimate.seconds(),null);
});
