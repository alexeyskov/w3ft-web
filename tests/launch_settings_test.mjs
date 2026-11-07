import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {readFileSync} from 'node:fs';
import {gameResolution,gameGraphics,GAME_RESOLUTIONS} from '../web/runtime/launch-settings.mjs';

test('launch resolution is visible to Warcraft registry and Win32 display enumeration', () => {
  for (const resolution of GAME_RESOLUTIONS.map(([width, height]) => ({width, height}))) {
    const host = new WarcraftHost({memory: new WebAssembly.Memory({initial: 8}), resolution});
    let next = 0x10000; host.base = 0;
    host.exports = {wc3_guest_alloc: size => { const p = next; next += size; return p; }};
    const call = (dll, name, ...args) => host.handlers.get(dll + '!' + name).fn(args);
    const key = host.alloc(4), output = host.alloc(4), type = host.alloc(4), length = host.alloc(4);
    for (const root of [0x80000001, 0x80000002]) {
      assert.equal(call('advapi32.dll', 'RegOpenKeyExA', root, host.string('Software\\Blizzard Entertainment\\Warcraft III\\Video'), 0, 1, key), 0);
      for (const [name, expected] of [['reswidth', resolution.width], ['resheight', resolution.height], ['colordepth', 32]]) {
        host.w32(length, 4);
        assert.equal(call('advapi32.dll', 'RegQueryValueExA', host.u32(key), host.string(name), 0, type, output, length), 0);
        assert.equal(host.u32(type), 4); assert.equal(host.u32(output), expected);
      }
    }
    assert.equal(call('user32.dll', 'GetSystemMetrics', 0), resolution.width);
    assert.equal(call('user32.dll', 'GetSystemMetrics', 1), resolution.height);
    const mode = host.alloc(156); host.w16(mode + 36, 156);
    let found = false;
    for (let index = 0; call('user32.dll', 'EnumDisplaySettingsA', 0, index, mode); index++)
      if (host.u32(mode + 108) === resolution.width && host.u32(mode + 112) === resolution.height) found = true;
    assert.ok(found, 'Requested mode must be advertised to the game');
  }
  assert.deepEqual(gameResolution(), {width: 1024, height: 768});
  // The page offers exactly the runtime's resolutions, 1280×960 preselected.
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const select = page.match(/<select id="resolution">(.*?)<\/select>/s)[1];
  assert.deepEqual([...select.matchAll(/value="(\d+)x(\d+)"/g)].map(match => [Number(match[1]), Number(match[2])]), GAME_RESOLUTIONS.map(mode => [...mode]));
  assert.match(select, /value="1280x960" selected/);
  for (const [width, height] of GAME_RESOLUTIONS) assert.equal(width * 3, height * 4, `${width}×${height} is 4:3`);
  assert.throws(() => gameResolution({width: 16384, height: 16384}), /resolution/);
});

test('launcher graphics settings are Warcraft registry values; in-game changes are reported', () => {
  const graphicsSettings = {gamma: 45, modeldetail: 2, animquality: 2, texquality: 1, particles: 0, lights: 2, unitshadows: 0, occlusion: 1, spellfilter: 1};
  const host = new WarcraftHost({memory: new WebAssembly.Memory({initial: 8}), graphicsSettings});
  let next = 0x10000; host.base = 0;
  host.exports = {wc3_guest_alloc: size => { const p = next; next += size; return p; }};
  const call = (dll, name, ...args) => host.handlers.get(dll + '!' + name).fn(args);
  const key = host.alloc(4), output = host.alloc(4), type = host.alloc(4), length = host.alloc(4);
  assert.equal(call('advapi32.dll', 'RegOpenKeyExA', 0x80000001, host.string('Software\\Blizzard Entertainment\\Warcraft III\\Video'), 0, 1, key), 0);
  const read = name => { host.w32(length, 4); assert.equal(call('advapi32.dll', 'RegQueryValueExA', host.u32(key), host.string(name), 0, type, output, length), 0, name); assert.equal(host.u32(type), 4); return host.u32(output); };
  for (const [name, value] of Object.entries(graphicsSettings)) assert.equal(read(name), value, name);
  const writes = [];
  host.onRegistryWrite = (path, name, value) => writes.push([path, name, value.type, [...value.data]]);
  host.w32(output, 2);
  assert.equal(call('advapi32.dll', 'RegSetValueExA', host.u32(key), host.string('ModelDetail'), 0, 4, output, 4), 0);
  assert.deepEqual(writes, [['user\\software\\blizzard entertainment\\warcraft iii\\video', 'modeldetail', 4, [2, 0, 0, 0]]]);
  // Windowed Warcraft leaves gamma to the runtime: launcher value 45 and OK in
  // the game's Video options map to fullscreen game.dll's 1.2 − gamma/100.
  assert.ok(Math.abs(host.gammaExponent - 0.75) < 1e-9);
  host.w32(output, 100);
  assert.equal(call('advapi32.dll', 'RegSetValueExA', host.u32(key), host.string('gamma'), 0, 4, output, 4), 0);
  assert.ok(Math.abs(host.gammaExponent - 0.2) < 1e-9);
  // Unset values keep game.dll defaults: the launcher writes nothing for them.
  const plain = new WarcraftHost({memory: new WebAssembly.Memory({initial: 8})});
  assert.equal(plain.graphicsSettings, null); assert.equal(plain.gammaExponent, null);
  assert.deepEqual(gameGraphics({texquality: 2}), {texquality: 2});
  assert.throws(() => gameGraphics({texquality: 3}), /texquality/);
  assert.throws(() => gameGraphics({reswidth: 640}), /Unknown/);
  assert.throws(() => gameGraphics({gamma: 1.5}), /gamma/);
});

test('the display gamma ramp round-trips and reaches the renderer', () => {
  const ramps = [];
  const host = new WarcraftHost({memory: new WebAssembly.Memory({initial: 8}), graphics: {setGammaRamp: ramp => ramps.push(ramp)}});
  let next = 0x10000; host.base = 0;
  host.exports = {wc3_guest_alloc: size => { const p = next; next += size; return p; }};
  const call = (dll, name, ...args) => host.handlers.get(dll + '!' + name).fn(args);
  const dc = call('user32.dll', 'GetDC', 0), ramp = host.alloc(1536);
  assert.ok(dc);
  assert.equal(call('gdi32.dll', 'GetDeviceGammaRamp', dc, ramp), 1, 'Warcraft enables its gamma slider only after a successful read');
  for (const channel of [0, 256, 512]) for (const i of [0, 128, 255]) assert.equal(host.u16(ramp + (channel + i) * 2), i * 257);
  for (let i = 0; i < 768; i++) host.w16(ramp + i * 2, Math.round(Math.pow((i & 255) / 255, 0.5) * 65535));
  assert.equal(call('gdi32.dll', 'SetDeviceGammaRamp', dc, ramp), 1);
  assert.equal(ramps.length, 1); assert.equal(ramps[0][64], Math.round(Math.pow(64 / 255, 0.5) * 65535));
  const copy = host.alloc(1536);
  assert.equal(call('gdi32.dll', 'GetDeviceGammaRamp', dc, copy), 1);
  assert.deepEqual([...host.copyOut(copy, 1536)], [...host.copyOut(ramp, 1536)]);
  assert.equal(call('gdi32.dll', 'SetDeviceGammaRamp', 0x1234, ramp), 0, 'invalid DC');
  // Warcraft restores the original ramp while destroying its window, after
  // wglDeleteContext: the display keeps the ramp, no renderer receives it.
  host.graphics.destroyed = true;
  for (let i = 0; i < 768; i++) host.w16(ramp + i * 2, (i & 255) * 257);
  assert.equal(call('gdi32.dll', 'SetDeviceGammaRamp', dc, ramp), 1);
  assert.equal(ramps.length, 1); assert.equal(host.gammaRamp[64], 64 * 257);
});

test('a localization with its own font turns on Allow Local Files', () => {
  const query = allowLocalFiles => {
    const host = new WarcraftHost({memory: new WebAssembly.Memory({initial: 8}), allowLocalFiles});
    let next = 0x10000; host.base = 0;
    host.exports = {wc3_guest_alloc: size => { const p = next; next += size; return p; }};
    const call = (dll, name, ...args) => host.handlers.get(dll + '!' + name).fn(args);
    const key = host.alloc(4), output = host.alloc(4), type = host.alloc(4), length = host.alloc(4);
    assert.equal(call('advapi32.dll', 'RegOpenKeyExA', 0x80000001, host.string('Software\\Blizzard Entertainment\\Warcraft III'), 0, 1, key), 0);
    host.w32(length, 4);
    const result = call('advapi32.dll', 'RegQueryValueExA', host.u32(key), host.string('Allow Local Files'), 0, type, output, length);
    return result === 0 ? host.u32(output) : null;
  };
  assert.equal(query(true), 1);
  assert.equal(query(false), null, 'The base installation keeps reading only its archives');
});
