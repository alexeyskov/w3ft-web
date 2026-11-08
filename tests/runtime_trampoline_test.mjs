// Run tests/runtime_trampoline_fixture.c built with WebAssembly tail calls
// (standard) and without them (compat): the guest must see the same thing.
// Compiled by tests/test_runtime_trampoline.py.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const SENTINEL_RETURN = 0x00400ff0;

async function load(path) {
  const memory = new WebAssembly.Memory({initial: 128, maximum: 4096, shared: true});
  const string = pointer => {
    const bytes = new Uint8Array(memory.buffer); let end = pointer;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.slice(pointer, end));
  };
  let x = null;
  const registers = cpu => new Uint32Array(memory.buffer, cpu, 9);
  const imports = {env: {memory}, wc3: {
    // Host thunk 2 is a stdcall API without arguments: eax=41, then ret.
    wc3_host_call: (index, cpu) => {
      assert.equal(index, 2, 'Only the fixture thunk is called');
      const r = registers(cpu); r[0] = 41; r[4] += 4;
    },
    wc3_host_resolve: () => 0, wc3_host_log: () => {}, wc3_host_now: () => performance.now(),
    wc3_host_fault: (address, message) => { throw Error(string(message)); }},
    wasi_snapshot_preview1: {sched_yield: () => 0, proc_exit: code => { throw Error('WASI exit ' + code); },
      fd_close: () => 0, fd_seek: () => 8, fd_write: () => 8,
      clock_time_get: (_id, _precision, output) => { new DataView(memory.buffer).setBigUint64(output, BigInt(Date.now()) * 1000000n, true); return 0; }}};
  x = (await WebAssembly.instantiate(readFileSync(path), imports)).instance.exports;
  x._initialize(); assert.equal(x.wc3_init(0x4000000), 1);
  const cpu = x.wc3_cpu_pointer(); x.wc3_set_budget(0);
  return {x, cpu, registers: () => registers(cpu)};
}

// The fixture's loop in JavaScript.
function expected(passes) {
  let eax = 0, ecx = passes, edx = 1, dispatches = 1;
  while (ecx) {
    ecx--; dispatches += 2;
    if (ecx & 1) { eax = (eax ^ ecx) >>> 0; edx = (Math.imul(edx ^ ecx, 5) + 1) >>> 0; eax = (eax + edx) >>> 0; dispatches++; }
    else eax = (eax + 3) >>> 0;
  }
  return {eax, ebx: (eax + 7) >>> 0, edx, dispatches};
}

function run({x, cpu, registers}, passes) {
  const r = registers(), esp = r[4], stack = x.__stack_pointer.value, before = x.wc3_context_trace_count(cpu);
  r[0] = 0; r[1] = passes; r[2] = 1; r[3] = 0; r[6] = 0x00401400;
  const started = performance.now();
  x.fixture_call(cpu, 0x00402000);
  const ms = performance.now() - started, after = registers();
  assert.equal(after[4], esp, 'The guest stack is balanced');
  assert.equal(after[8], SENTINEL_RETURN, 'The last return pops the caller\'s address');
  assert.equal(x.__stack_pointer.value, stack, 'The native stack is balanced');
  return {eax: after[0], ebx: after[3], edx: after[2], dispatches: x.wc3_context_trace_count(cpu) - before, ms};
}

function scenarios(module) {
  const {x, cpu, registers} = module, results = {};
  for (const passes of [0, 1, 2, 7, 1000]) {
    const {ms, ...result} = run(module, passes);
    assert.deepEqual(result, expected(passes), `${passes} passes`);
  }
  // Millions of jumps around one switch: each must leave its frame.
  const deep = run(module, 3000000);
  assert.deepEqual({eax: deep.eax, ebx: deep.ebx, edx: deep.edx, dispatches: deep.dispatches}, expected(3000000));
  results.deepMs = Math.round(deep.ms);
  // A thunk's jump into the host, which returns to the caller.
  let before = x.wc3_context_trace_count(cpu);
  x.fixture_call(cpu, 0x00405000);
  assert.equal(registers()[0], 42); assert.equal(x.wc3_context_trace_count(cpu) - before, 2);
  // A jump to the return address of a host callback: the sentinel.
  before = x.wc3_context_trace_count(cpu);
  assert.equal(x.wc3_call_context(cpu, 0x00403000, 0, 0), 0x1234);
  assert.equal(x.wc3_context_trace_count(cpu) - before, 2);
  // A jump to nowhere faults once, and the next call starts clean.
  const stack = x.__stack_pointer.value, esp = registers()[4];
  assert.throws(() => x.fixture_call(cpu, 0x00404000), /No lifted function for guest tail target \(address=0x00999990/);
  x.__stack_pointer.value = stack; registers()[4] = esp;
  const {ms, ...again} = run(module, 7);
  assert.deepEqual(again, expected(7));
  results.tlsBytes = Number(x.__tls_size.value);
  return results;
}

if (process.argv[2]) {
  const directory = process.argv[2], report = {};
  for (const name of ['standard', 'compat']) report[name] = scenarios(await load(join(directory, `${name}.wasm`)));
  console.log(JSON.stringify(report));
} else {
  test('tail-jump trampoline WASM fixture', {skip: 'Run tests/test_runtime_trampoline.py to compile both builds'}, () => {});
}
