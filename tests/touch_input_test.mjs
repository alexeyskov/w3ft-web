import test from 'node:test';
import assert from 'node:assert/strict';
import {TouchGestures, TOUCH_TIMING} from '../web/runtime/touch-input.mjs';
import {attachTouchKeyboard, textChange, virtualKey} from '../web/src/touch-keyboard.mjs';

// A deterministic clock: timers run when the test advances time.
function harness() {
  let time = 1000, nextId = 1;
  const timers = new Map(), sent = [];
  const gestures = new TouchGestures({
    send:message => sent.push({...message, at:time}),
    now:() => time,
    setTimer:(fn, delay) => { const id = nextId++; timers.set(id, {fn, at:time + Math.max(0, delay)}); return id; },
    clearTimer:id => timers.delete(id),
    vibrate:() => sent.push({type:'vibrate', at:time}),
  });
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); time = due[1].at; due[1].fn();
    }
    time = end;
  };
  const kinds = () => sent.map(m => m.type === 'pointerdown' || m.type === 'pointerup' ? `${m.type}:${m.button}` : m.type === 'keydown' || m.type === 'keyup' ? `${m.type}:${m.keyCode}` : m.type === 'wheel' ? `wheel:${m.delta}` : m.type);
  return {gestures, sent, advance, kinds, timers};
}

test('a tap moves the cursor first, then clicks once the game has seen it there', () => {
  const {gestures, sent, advance, kinds} = harness();
  gestures.down(1, 100, 50);
  assert.deepEqual(kinds(), ['pointermove']);
  advance(30); gestures.up(1, 101, 50);
  advance(500);
  assert.deepEqual(kinds(), ['pointermove', 'pointerdown:0', 'pointerup:0']);
  const [move, down, up] = sent;
  assert.ok(down.at - move.at >= TOUCH_TIMING.hoverDelay, 'press comes after the hover delay');
  assert.ok(up.at - down.at >= TOUCH_TIMING.pressGap, 'release comes after the press gap');
  assert.deepEqual([down.x, down.y, up.x, up.y], [100, 50, 100, 50], 'the click lands where the finger went down');
  assert.equal(gestures.mode, 'idle');
});

test('a long press is a right click and the lift adds nothing', () => {
  const {gestures, advance, kinds} = harness();
  gestures.down(1, 10, 10);
  advance(TOUCH_TIMING.longPress + 200);
  gestures.up(1, 10, 10); advance(300);
  assert.deepEqual(kinds(), ['pointermove', 'vibrate', 'pointerdown:2', 'pointerup:2']);
});

test('a drag is a left drag: press at the start, moves, release at the end', () => {
  const {gestures, sent, advance, kinds} = harness();
  gestures.down(1, 10, 10);
  gestures.move(1, 14, 12); // within the slop: still a tap
  gestures.move(1, 40, 30); gestures.move(1, 80, 60);
  advance(200);
  gestures.up(1, 90, 70); advance(200);
  assert.deepEqual(kinds(), ['pointermove', 'pointerdown:0', 'pointermove', 'pointermove', 'pointerup:0']);
  assert.deepEqual([sent[1].x, sent[1].y], [10, 10]);
  assert.deepEqual([sent.at(-1).x, sent.at(-1).y], [90, 70]);
  // Moves never overtake the delayed press.
  assert.ok(sent.every((m, i) => i === 0 || m.at >= sent[i - 1].at));
  // No long press fired during the drag.
  advance(2000); assert.equal(sent.length, 5);
});

test('two fingers scroll the camera with held arrow keys and pinch zooms with the wheel', () => {
  const {gestures, advance, kinds} = harness();
  gestures.down(1, 100, 100); gestures.down(2, 200, 100);
  // Both fingers to the right: the map follows them, the view goes left.
  gestures.move(1, 140, 100); gestures.move(2, 240, 100);
  advance(10);
  assert.deepEqual(kinds(), ['pointermove', 'keydown:37']);
  // Back near the start: the key is released (hysteresis below half the threshold).
  gestures.move(1, 105, 100); gestures.move(2, 205, 100); advance(10);
  assert.deepEqual(kinds().slice(-1), ['keyup:37']);
  // Fingers apart: wheel forward (zoom in); together again: wheel back.
  gestures.move(1, 70, 100); gestures.move(2, 235, 100); advance(10);
  assert.ok(kinds().includes('wheel:120'));
  gestures.move(1, 105, 100); gestures.move(2, 205, 100); advance(10);
  assert.ok(kinds().includes('wheel:-120'));
  gestures.up(1); gestures.up(2); advance(300);
  assert.ok(!kinds().some(kind => kind.startsWith('pointerdown')), 'no click after a scroll or pinch');
  assert.equal(gestures.mode, 'idle');
});

test('a fast two-finger pan never zooms, and a wobbling pinch does not zoom back and forth', () => {
  const {gestures, advance, kinds} = harness();
  gestures.down(1, 100, 300); gestures.down(2, 250, 300);
  // Each frame both fingers move 30 px, in two separate events.
  for (let y = 270; y >= 60; y -= 30) { gestures.move(1, 100, y); gestures.move(2, 250, y); advance(16); }
  assert.ok(!kinds().some(kind => kind.startsWith('wheel')), 'one finger ahead of the other is not a pinch');
  assert.ok(kinds().includes('keydown:40'), 'fingers up: the view scrolls down');
  gestures.up(1); gestures.up(2); advance(200);
  const pinch = harness();
  pinch.gestures.down(1, 100, 100); pinch.gestures.down(2, 300, 100);
  for (const right of [340, 332, 341, 330, 342]) { pinch.gestures.move(2, right, 100); pinch.advance(16); }
  assert.deepEqual(pinch.kinds().filter(kind => kind.startsWith('wheel')), ['wheel:120'], 'one step in, no step back while wobbling');
});

test('two fingers tapping together right-click at the first finger', () => {
  const {gestures, sent, advance, kinds} = harness();
  gestures.down(1, 50, 60); advance(20); gestures.down(2, 120, 60);
  advance(80); gestures.up(2); gestures.up(1);
  advance(300);
  assert.deepEqual(kinds(), ['pointermove', 'pointerdown:2', 'pointerup:2']);
  assert.deepEqual([sent[1].x, sent[1].y], [50, 60]);
});

test('a system gesture or the end of the session releases what is held', () => {
  const {gestures, advance, kinds} = harness();
  gestures.down(1, 10, 10); gestures.move(1, 60, 10); advance(100);
  gestures.cancel(1); advance(200);
  assert.deepEqual(kinds(), ['pointermove', 'pointerdown:0', 'pointermove', 'pointerup:0']);
  const second = harness();
  second.gestures.down(1, 100, 100); second.gestures.down(2, 200, 100);
  second.gestures.move(1, 100, 160); second.gestures.move(2, 200, 160);
  second.advance(10); // both fingers judged together: the up arrow is held
  second.gestures.reset();
  assert.deepEqual(second.kinds(), ['pointermove', 'keydown:38', 'keyup:38']);
  assert.equal(second.timers.size, 0, 'no timer survives the session');
});

test('the device keyboard reaches the game as typed characters and Backspace', () => {
  assert.deepEqual(textChange('  ', '  hi'), {removed:0, added:['h', 'i']});
  assert.deepEqual(textChange('  helo', '  hello'), {removed:1, added:['l', 'o']});
  assert.deepEqual(textChange('  ', ' '), {removed:1, added:[]});
  assert.deepEqual(textChange('  ', '  привет 😀'), {removed:0, added:[...'привет 😀']});
  assert.equal(virtualKey('a'), 65); assert.equal(virtualKey('Z'), 90); assert.equal(virtualKey('7'), 55); assert.equal(virtualKey(' '), 32);
  assert.equal(virtualKey('ж'), 0xe7); assert.equal(virtualKey('!'), 0xe7); assert.equal(virtualKey('ß'), 0xe7);

  const field = new EventTarget(); field.value = ''; field.setSelectionRange = () => {};
  const keys = [];
  attachTouchKeyboard(field, (type, keyCode, text) => keys.push(`${type}:${keyCode}:${text}`));
  field.dispatchEvent(new Event('focus'));
  assert.equal(field.value, '  ');
  const type = value => { field.value = value; const event = new Event('input'); event.isComposing = false; field.dispatchEvent(event); };
  type('  Hi'); type('  H'); type(' ');
  assert.deepEqual(keys, ['keydown:72:H', 'keyup:72:', 'keydown:73:i', 'keyup:73:', 'keydown:8:\b', 'keyup:8:',
    'keydown:8:\b', 'keyup:8:', 'keydown:8:\b', 'keyup:8:']);
  assert.equal(field.value, '  ', 'Backspace can always delete once more');
  keys.length = 0;
  const enter = new Event('keydown', {cancelable:true}); enter.key = 'Enter'; enter.isComposing = false;
  field.dispatchEvent(enter);
  assert.deepEqual(keys, ['keydown:13:\r', 'keyup:13:']); assert.ok(enter.defaultPrevented);
  keys.length = 0;
  const letter = new Event('keydown', {cancelable:true}); letter.key = 'a'; letter.isComposing = false;
  field.dispatchEvent(letter);
  assert.deepEqual(keys, [], 'letters arrive through the field text, never twice');
});

test('the default timers work where they must not be called as methods (browsers)', async () => {
  const original = {set:globalThis.setTimeout, clear:globalThis.clearTimeout};
  // Browsers throw "Illegal invocation" when timers run with another `this`.
  globalThis.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return original.set(fn, ms); };
  globalThis.clearTimeout = function (id) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return original.clear(id); };
  try {
    const sent = [];
    const gestures = new TouchGestures({send:message => sent.push(message.type)});
    gestures.down(1, 5, 5); gestures.up(1, 5, 5);
    await new Promise(resolve => original.set(resolve, TOUCH_TIMING.hoverDelay + TOUCH_TIMING.pressGap + 80));
    assert.deepEqual(sent, ['pointermove', 'pointerdown', 'pointerup']);
  } finally {
    globalThis.setTimeout = original.set; globalThis.clearTimeout = original.clear;
  }
});
