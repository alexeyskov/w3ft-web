import test from 'node:test';
import assert from 'node:assert/strict';
import {setListener, spatialNodes} from '../web/runtime/audio-spatial.mjs';

// Browsers differ: Chrome and Safari give AudioListener and PannerNode
// AudioParams (positionX…); Firefox's AudioListener has only setPosition and
// setOrientation, which every browser keeps.
const param = calls => ({setValueAtTime:(value, time) => calls.push([value, time]), value:0});
function target(withParameters, prefixes) {
  const calls = {params:{}, setPosition:[], setOrientation:[]};
  const node = {setPosition:(...values) => calls.setPosition.push(values), setOrientation:(...values) => calls.setOrientation.push(values), calls};
  if (withParameters) for (const prefix of prefixes) for (const axis of 'XYZ') node[prefix + axis] = param(calls.params[prefix + axis] = []);
  return node;
}
function context(withParameters) {
  const node = () => ({connect() {}, disconnect() {}});
  return {
    currentTime:2, sampleRate:48000, destination:node(),
    listener:target(withParameters, ['position', 'forward', 'up']),
    panners:[],
    createPanner() { const panner = Object.assign(target(withParameters, ['position', 'orientation']), node()); this.panners.push(panner); return panner; },
    createBiquadFilter:() => ({...node(), Q:{value:0}, frequency:param([])}),
    createGain:() => ({...node(), gain:param([])}),
    createConvolver:() => node(),
  };
}

test('the listener moves through AudioParams where the browser has them', () => {
  const audio = context(true);
  setListener(audio, {position:[1, 2, 3], forward:[0, 0, -1], up:[0, 1, 0]});
  const {calls} = audio.listener;
  assert.deepEqual(['positionX', 'positionY', 'positionZ'].map(name => calls.params[name][0]), [[1, 2], [2, 2], [3, 2]]);
  assert.deepEqual(calls.params.upY, [[1, 2]]);
  assert.equal(calls.setPosition.length + calls.setOrientation.length, 0, 'no legacy setters where AudioParams exist');
});

test('without AudioParams (Firefox) the listener and sources use setPosition and setOrientation', () => {
  const audio = context(false);
  setListener(audio, {position:[1, 2, 3], forward:[0, 0, -1], up:[0, 1, 0]});
  assert.deepEqual(audio.listener.calls.setPosition, [[1, 2, 3]]);
  assert.deepEqual(audio.listener.calls.setOrientation, [[0, 0, -1, 0, 1, 0]]);
  const nodes = spatialNodes(audio, {connect() {}}, {position:[4, 5, 6], orientation:[1, 0, 0]});
  assert.deepEqual(audio.panners[0].calls.setPosition, [[4, 5, 6]]);
  assert.deepEqual(audio.panners[0].calls.setOrientation, [[1, 0, 0]]);
  nodes.update({position:[7, 8, 9]});
  assert.deepEqual(audio.panners[0].calls.setPosition.at(-1), [7, 8, 9]);
  assert.throws(() => setListener(audio, {forward:[0, 0, 0]}), /nonzero/);
});
