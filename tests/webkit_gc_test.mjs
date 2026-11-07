import test from 'node:test';
import assert from 'node:assert/strict';
import {webkitCollectorNudge} from '../web/runtime/webkit-gc.mjs';

const memory = {buffer: {byteLength: 0}};
const agents = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-G780F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1',
};

test('the collector nudge runs only on JavaScriptCore', () => {
  for (const name of ['chrome', 'edge', 'android', 'firefox']) assert.equal(webkitCollectorNudge(memory, {userAgent: agents[name]}), null, name);
  for (const name of ['safari', 'iphoneChrome']) assert.equal(typeof webkitCollectorNudge(memory, {userAgent: agents[name]}), 'function', name);
});

test('the nudge stops for good when an engine writes the zeros', () => {
  const times = [0, 1, 10, 20];
  const nudge = webkitCollectorNudge(memory, {userAgent: agents.safari, now: () => times.shift() ?? 0});
  assert.equal(nudge(), true, 'a lazily zeroed buffer: about no time');
  assert.equal(nudge(), false, 'ten milliseconds: the engine filled it');
  assert.equal(nudge(), false, 'and it stays off');
});
