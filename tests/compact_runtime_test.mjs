// The fixture is generated from synthetic PE bytes by test_build_runtime.py.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRuntime} from '../web/runtime/engine.mjs';

const root = process.argv[2];
if (root) for (const variant of ['standard', 'compat']) {
  const profile = JSON.parse(await readFile(`${root}/build/build${variant === 'compat' ? '-compat' : ''}.json`));
  const bytes = new Uint8Array(await readFile(`${root}/fixture.dll`));
  const wasm = await WebAssembly.compile(await readFile(`${root}/build/${profile.artifact}`));
  const logs = [];
  const engine = await createRuntime({wasm, profile, images:[{name:'fixture.dll', bytes}], log:line => logs.push(line)});
  assert.equal(engine.modules[0].base, 0x02000000);
  assert.equal(engine.host.u32(0x02002000), 0x02001010, 'HIGHLOW pointer loaded at the same address as the lifter');
  assert.equal(engine.run('fixture.dll'), 0x8900ac, 'Execute a relative call and return in relocated code');
  assert.equal(engine.host.capacity, 0x1fff0000);
  assert.ok(engine.host.memory.buffer.byteLength < 640 * 1048576, 'Never grow the old 2 GiB guest window');
  assert.ok(engine.host.commandPointer >= 0x04000000 && engine.host.commandPointer < 0x1fff0000);
  assert.throws(() => engine.host.u32(0x6f000000), /outside address space/);
  const cpu = engine.instance.exports.wc3_cpu_pointer();
  assert.ok(engine.host.view.getUint32(cpu + 16, true) < 0x02000000, 'Boot stack must not overlap the compact heap');
  assert.ok(logs.some(line => line.includes('Allocating guest address space (compact)')));
  console.log(variant, 'compact relocation passed', engine.host.memory.buffer.byteLength);
}
