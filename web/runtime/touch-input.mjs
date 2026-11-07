// Touch screens (phones, tablets) have no hover, right mouse button or
// keyboard. TouchGestures turns finger input into the mouse and arrow-key
// input Warcraft III reads; mouse and pen input never come here.
//
//   tap                           left click
//   drag                          left drag (selection box, sliders, scroll bars)
//   long press, two-finger tap    right click (move, attack, cancel an order)
//   two-finger drag               camera scroll: arrow keys, held while displaced
//   pinch                         mouse wheel (camera zoom)
//
// Warcraft finds the control under the cursor from WM_MOUSEMOVE and presses it
// only if the button goes down over it, while a finger presses with no movement
// before. Every press therefore comes `hoverDelay` after the cursor moved there
// and is released `pressGap` later: two frames at 30 FPS each.
export const TOUCH_TIMING = Object.freeze({hoverDelay:70, pressGap:70, longPress:500, twoFingerTap:300});
// CSS pixels: movement that makes a drag, camera scroll start, pinch step.
export const TOUCH_DISTANCE = Object.freeze({slop:10, pan:28, pinchStep:0.15});

const ARROWS = Object.freeze({left:37, up:38, right:39, down:40});
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class TouchGestures {
  // send(message): {type:'pointermove'|'pointerdown'|'pointerup'|'wheel', x, y, button, delta}
  // with client coordinates, or {type:'keydown'|'keyup', keyCode, extended:true}.
  // Browser timers must not be called as methods of another object (Illegal
  // invocation), hence the wrappers.
  constructor({send, now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), vibrate = () => {}} = {}) {
    if (typeof send !== 'function') throw new TypeError('TouchGestures needs a send callback');
    this.send = send; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.vibrate = vibrate;
    this.touches = new Map(); this.mode = 'idle'; this.primary = null; this.two = null;
    this.queue = []; this.timeline = -Infinity; this.timer = null; this.longTimer = null; this.twoTimer = null;
    this.keys = new Set(); this.leftDown = false;
  }

  // Messages leave in order, each at least `delay` ms after the previous one.
  emit(message, delay = 0) {
    const at = Math.max(this.timeline + delay, this.now());
    this.timeline = at; this.queue.push({at, message}); this.pump();
  }
  pump() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const now = this.now();
    while (this.queue.length && this.queue[0].at <= now) this.send(this.queue.shift().message);
    if (this.queue.length) this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, this.queue[0].at - now);
  }
  pointer(type, point, extra = {}) { return {type, x:point.x, y:point.y, button:0, delta:0, ...extra}; }
  click(point, button) {
    this.emit(this.pointer('pointerdown', point, {button}), TOUCH_TIMING.hoverDelay);
    this.emit(this.pointer('pointerup', point, {button}), TOUCH_TIMING.pressGap);
  }
  pair() { return [...this.touches.values()].slice(0, 2); }
  centroid() { const [a, b] = this.pair(); return {x:(a.at.x + b.at.x) / 2, y:(a.at.y + b.at.y) / 2}; }
  spread() { const [a, b] = this.pair(); return Math.max(1, distance(a.at, b.at)); }

  down(id, x, y) {
    const point = {x, y}, touch = {start:point, at:point, time:this.now()};
    if (this.mode === 'idle') {
      this.touches.set(id, touch); this.mode = 'pending'; this.primary = id;
      this.emit(this.pointer('pointermove', point));
      this.longTimer = this.setTimer(() => this.longPressed(), TOUCH_TIMING.longPress);
      return;
    }
    if (this.touches.has(id)) return;
    this.touches.set(id, touch);
    if (this.mode === 'pending' && this.touches.size === 2) {
      this.cancelLongPress(); this.mode = 'two';
      this.two = {start:this.centroid(), spread:this.spread(), time:this.now(), moved:false, zoom:0};
    }
  }
  move(id, x, y) {
    const touch = this.touches.get(id);
    if (!touch) return;
    touch.at = {x, y};
    if (this.mode === 'pending' && id === this.primary && distance(touch.start, touch.at) > TOUCH_DISTANCE.slop) {
      this.cancelLongPress(); this.mode = 'drag'; this.leftDown = true;
      this.emit(this.pointer('pointerdown', touch.start), TOUCH_TIMING.hoverDelay);
      this.emit(this.pointer('pointermove', touch.at));
    } else if (this.mode === 'drag' && id === this.primary) {
      this.emit(this.pointer('pointermove', touch.at));
    } else if (this.mode === 'two' && this.pair().includes(touch)) {
      // Each finger moves in its own event: judge both once they have moved,
      // or the distance between them jumps between the two events.
      if (this.twoTimer === null) this.twoTimer = this.setTimer(() => { this.twoTimer = null; if (this.mode === 'two') this.twoFingers(); }, 0);
    }
  }
  up(id, x, y) {
    const touch = this.touches.get(id);
    if (!touch) return;
    if (Number.isFinite(x) && Number.isFinite(y)) touch.at = {x, y};
    this.flushTwoFingers();
    if (this.mode === 'pending' && id === this.primary) {
      this.cancelLongPress(); this.mode = 'done';
      this.click(touch.start, 0);
    } else if (this.mode === 'drag' && id === this.primary) {
      this.mode = 'done'; this.leftDown = false;
      this.emit(this.pointer('pointerup', touch.at), TOUCH_TIMING.pressGap);
    } else if (this.mode === 'two' && this.pair().includes(touch)) {
      this.releaseKeys(); this.mode = 'done';
      // Two fingers that tap together right-click where the first one is.
      if (!this.two.moved && this.now() - this.two.time <= TOUCH_TIMING.twoFingerTap) this.click(this.touches.get(this.primary).start, 2);
    }
    this.touches.delete(id);
    if (!this.touches.size) this.finish();
  }
  // The browser took the touch (a system gesture): release what is held.
  cancel(id) {
    const touch = this.touches.get(id);
    if (!touch) return;
    if (this.mode === 'drag' && id === this.primary) { this.leftDown = false; this.emit(this.pointer('pointerup', touch.at), TOUCH_TIMING.pressGap); }
    this.flushTwoFingers();
    if (this.mode === 'two') this.releaseKeys();
    this.cancelLongPress();
    this.mode = 'done'; this.touches.delete(id);
    if (!this.touches.size) this.finish();
  }
  // End of the session: send what is queued and release held keys and buttons.
  reset() {
    this.cancelLongPress();
    if (this.twoTimer !== null) { this.clearTimer(this.twoTimer); this.twoTimer = null; }
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    for (const {message} of this.queue.splice(0)) this.send(message);
    if (this.leftDown) { this.leftDown = false; const touch = this.touches.get(this.primary); if (touch) this.send(this.pointer('pointerup', touch.at)); }
    for (const direction of this.keys) this.send({type:'keyup', keyCode:ARROWS[direction], extended:true});
    this.keys.clear(); this.touches.clear(); this.finish();
  }

  finish() { this.mode = 'idle'; this.primary = null; this.two = null; }
  cancelLongPress() { if (this.longTimer !== null) { this.clearTimer(this.longTimer); this.longTimer = null; } }
  flushTwoFingers() {
    if (this.twoTimer === null) return;
    this.clearTimer(this.twoTimer); this.twoTimer = null;
    if (this.mode === 'two') this.twoFingers();
  }
  longPressed() {
    this.longTimer = null;
    if (this.mode !== 'pending') return;
    this.mode = 'done';
    try { this.vibrate(); } catch {}
    this.click(this.touches.get(this.primary).start, 2);
  }
  twoFingers() {
    const center = this.centroid(), dx = center.x - this.two.start.x, dy = center.y - this.two.start.y;
    if (Math.hypot(dx, dy) > TOUCH_DISTANCE.slop) this.two.moved = true;
    // The map follows the fingers: moving them right shows what is to the left.
    // A key is pressed past `pan` and released below half of it.
    const pan = TOUCH_DISTANCE.pan;
    this.hold('left', dx > pan, dx > pan / 2); this.hold('right', dx < -pan, dx < -pan / 2);
    this.hold('up', dy > pan, dy > pan / 2); this.hold('down', dy < -pan, dy < -pan / 2);
    // One wheel step per `pinchStep` of spread; turning back takes a whole
    // step past the current one, so small wobbles do not zoom in and out.
    const level = Math.log(this.spread() / this.two.spread) / Math.log(1 + TOUCH_DISTANCE.pinchStep);
    while (level >= this.two.zoom + 1 || level <= this.two.zoom - 1) {
      const step = level > this.two.zoom ? 1 : -1;
      this.two.zoom += step; this.two.moved = true;
      // Fingers apart zoom in, like the wheel turned forward.
      this.emit(this.pointer('wheel', center, {delta:120 * step}));
    }
  }
  hold(direction, press, keep) {
    const held = this.keys.has(direction);
    if (!held && press) { this.keys.add(direction); this.emit({type:'keydown', keyCode:ARROWS[direction], extended:true}); }
    else if (held && !keep) { this.keys.delete(direction); this.emit({type:'keyup', keyCode:ARROWS[direction], extended:true}); }
  }
  releaseKeys() { for (const direction of [...this.keys]) this.hold(direction, false, false); }
}
