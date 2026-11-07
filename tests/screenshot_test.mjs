import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeTGA, screenshotName, screenshotFile} from '../web/runtime/screenshot.mjs';
import {FileOverlay, saveSnapshot, takeScreenshots} from '../web/runtime/persistence.mjs';

// TGA header: no ID, no colour map, type, origin 0,0, size, depth, descriptor.
function tga(type, width, height, depth, descriptor, body) {
  const header = new Uint8Array(18), view = new DataView(header.buffer);
  header[2] = type; view.setUint16(12, width, true); view.setUint16(14, height, true); header[16] = depth; header[17] = descriptor;
  return Uint8Array.from([...header, ...body]);
}
const rgba = image => Array.from(image.pixels);

test('Warcraft\'s 32-bit top-down BGRA screenshot decodes to opaque RGBA', () => {
  // 1.26 writes descriptor 0x28: eight alpha bits, first row on top.
  const image = decodeTGA(tga(2, 2, 2, 32, 0x28, [1, 2, 3, 0, 4, 5, 6, 9, 7, 8, 9, 0, 10, 11, 12, 0]));
  assert.deepEqual([image.width, image.height], [2, 2]);
  assert.deepEqual(rgba(image), [3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]);
});

test('bottom-up 24-bit and run-length TGA images keep their orientation', () => {
  const bottomUp = decodeTGA(tga(2, 2, 2, 24, 0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]));
  assert.deepEqual(rgba(bottomUp), [3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255]);
  // A run of three blue pixels, then one raw red pixel.
  const rle = decodeTGA(tga(10, 2, 2, 24, 0x20, [0x82, 255, 0, 0, 0x00, 0, 0, 255]));
  assert.deepEqual(rgba(rle), [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
});

test('broken or unsupported TGA images are refused', () => {
  assert.throws(() => decodeTGA(new Uint8Array(10)), /Not a TGA/);
  assert.throws(() => decodeTGA(tga(3, 1, 1, 8, 0, [0])), /Unsupported TGA image \(type 3, 8 bits\)/);
  assert.throws(() => decodeTGA(tga(2, 2, 2, 32, 0x28, [1, 2, 3])), /truncated/);
  assert.throws(() => decodeTGA(tga(10, 1, 1, 24, 0, [0x81, 1, 2, 3])), /run exceeds/);
});

test('screenshots keep Warcraft\'s name; other formats keep their own type', async () => {
  assert.equal(screenshotName('screenshots/wc3scrnshot_110726_165125_01.tga'), 'WC3ScrnShot_110726_165125_01');
  const jpeg = await screenshotFile({path: 'screenshots/wc3scrnshot_110726_165125_02.jpg', data: new Uint8Array([0xff, 0xd8])});
  assert.equal(jpeg.name, 'WC3ScrnShot_110726_165125_02.jpg');
  assert.equal(jpeg.blob.type, 'image/jpeg');
  assert.equal(jpeg.blob.size, 2);
});

test('a finished screenshot leaves the guest files once and never reaches the saves', () => {
  const host = {handles: new Map(), virtualFiles: new FileOverlay()}, shot = 'screenshots/wc3scrnshot_110726_165125_01.tga';
  host.virtualFiles.set('save/profile.w3z', new Uint8Array([1]));
  host.virtualFiles.set(shot, new Uint8Array([2, 3]));
  // Still being written: neither handed over nor saved.
  host.handles.set(1, {kind: 'file', writing: true, key: shot});
  assert.deepEqual(takeScreenshots(host), []);
  assert.deepEqual(saveSnapshot(host, {full: true}).deferred, [], 'an open screenshot does not hold back the saves');
  host.handles.clear();
  const taken = takeScreenshots(host);
  assert.deepEqual(taken.map(file => [file.path, [...file.data]]), [[shot, [2, 3]]]);
  assert.deepEqual(takeScreenshots(host), [], 'handed over once');
  assert.equal(host.virtualFiles.has(shot), false);
  const changes = saveSnapshot(host);
  assert.deepEqual(changes.files.map(file => file.path), ['save/profile.w3z']);
  assert.deepEqual(changes.deleted, [], 'the saves never had it: nothing to delete');
  // A screenshot taken just before the game ends is not saved either.
  host.virtualFiles.set('screenshots/wc3scrnshot_110726_165126_01.tga', new Uint8Array([4]));
  const full = saveSnapshot(host, {full: true});
  assert.deepEqual(full.files.map(file => file.path), ['save/profile.w3z']);
  assert.deepEqual(saveSnapshot(host).files, []);
});
