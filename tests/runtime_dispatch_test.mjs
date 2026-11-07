import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import test from 'node:test';

function imports(memory) {
  const string = pointer => {
    const bytes = new Uint8Array(memory.buffer); let end = pointer;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.slice(pointer, end));
  };
  return {env: {memory}, wc3: {wc3_host_call: () => assert.fail('Unexpected host thunk'), wc3_host_resolve: () => 0,
    wc3_host_log: () => {}, wc3_host_now: () => performance.now(), wc3_host_fault: (address, message) => { throw Error(string(message)); }},
    wasi_snapshot_preview1: {sched_yield: () => 0, proc_exit: code => { throw Error('WASI exit ' + code); },
      fd_close: () => 0, fd_seek: () => 8, fd_write: () => 8,
      clock_time_get: (_id, _precision, output) => { new DataView(memory.buffer).setBigUint64(output, BigInt(Date.now()) * 1000000n, true); return 0; }}};
}

function fault(x, cpu, target, tail, expression) {
  const stack = x.__stack_pointer.value, before = x.wc3_context_trace_count(cpu);
  assert.throws(() => x.fixture_dispatch(cpu, target, tail), expression);
  x.__stack_pointer.value = stack;
  assert.equal(x.wc3_context_trace_count(cpu), before + 1, 'Invalid targets are recorded exactly once');
}

if (!isMainThread) {
  try {
    const {module, memory, cpu, tls, stack, address, expected, iterations} = workerData;
    const {exports: x} = await WebAssembly.instantiate(module, imports(memory));
    x.__stack_pointer.value = stack; x.__wasm_init_tls(tls);
    x.wc3_context_set_budget(cpu, 0);
    assert.equal(x.fixture_dispatch(cpu, address, 1), expected, 'New worker TLS starts with valid lookup state');
    assert.equal(x.fixture_dispatch_loop(cpu, address, iterations) >>> 0, Math.imul(expected, iterations) >>> 0);
    assert.equal(x.wc3_context_trace_count(cpu), iterations + 1);
    parentPort.postMessage({ok: true});
  } catch (error) { parentPort.postMessage({error: error.stack}); }
} else if (process.argv[2]) {
  const directory = process.argv[2], targets = JSON.parse(readFileSync(join(directory, 'targets.json'))), results = {};
  let collisionChecks = 0, workers = 0;
  for (const name of ['uncached', 'cached']) {
    const module = await WebAssembly.compile(readFileSync(join(directory, name + '.wasm')));
    const memory = new WebAssembly.Memory({initial: 128, maximum: 4096, shared: true});
    const {exports: x} = await WebAssembly.instantiate(module, imports(memory));
    x._initialize(); assert.equal(x.wc3_init(0x4000000), 1); assert.equal(x.wc3_function_count(), 86000);
    const cpu = x.wc3_cpu_pointer(); x.wc3_set_budget(0);
    fault(x, cpu, 0, 0, /No lifted function for guest target/);
    assert.equal(x.fixture_dispatch(cpu, targets.first, 0), 0x1112);
    fault(x, cpu, targets.missing, 0, /No lifted function for guest target/);
    fault(x, cpu, targets.missing, 1, /No lifted function for guest tail target/);
    const before = x.wc3_trace_count();
    for (let i = 0; i < 10000; i++) {
      assert.equal(x.fixture_dispatch(cpu, targets.first, i & 1), 0x1112);
      assert.equal(x.fixture_dispatch(cpu, targets.second, i & 1), 0x2223);
    }
    assert.equal(x.wc3_trace_count() - before, 20000, 'Both cached and colliding dispatches consume trace slots');
    const trace = new Uint32Array(memory.buffer, x.wc3_trace_pointer(), 128), index = x.wc3_trace_count();
    assert.equal(trace[(index - 2) % 128], targets.first); assert.equal(trace[(index - 1) % 128], targets.second);
    collisionChecks = 20000;
    x.wc3_set_budget(1);
    assert.equal(x.fixture_dispatch(cpu, targets.first, 0), 0x1112);
    fault(x, cpu, targets.first, 1, /Guest dispatch budget exhausted/);
    x.wc3_set_budget(0);
    assert.equal(x.wc3_call_context(cpu, targets.second, 0, 0), 0x2223);
    assert.equal(x.wc3_init(0x4000000), 0, 'The immutable table cannot be reinitialized');
    assert.equal(x.fixture_dispatch(cpu, targets.first, 1), 0x1112);

    const mainTrace = x.wc3_trace_count(), running = [];
    for (let i = 0; i < 2; i++) {
      const stack = x.malloc(1024 * 1024) >>> 0, rawTls = x.malloc(x.__tls_size.value + x.__tls_align.value) >>> 0;
      const tls = Math.ceil(rawTls / x.__tls_align.value) * x.__tls_align.value;
      const tid = 20 + i, child = x.wc3_context_create(tid, 0x1000000 + i * 0x200000, 0x100000, 0x200000 + i * 0x2000) >>> 0;
      assert.ok(child);
      const worker = new Worker(new URL(import.meta.url), {workerData: {module, memory, cpu: child, tls, stack: stack + 1024 * 1024,
        address: i ? targets.second : targets.first, expected: (i ? 0x2222 : 0x1111) + tid, iterations: 1000000}});
      running.push({worker, child, stack, rawTls});
    }
    try {
      await Promise.all(running.map(({worker}) => new Promise((resolve, reject) => {
        worker.on('message', message => message.error ? reject(Error(message.error)) : resolve(message));
        worker.on('error', reject);
      })));
      workers += running.length;
      assert.equal(x.wc3_trace_count(), mainTrace, 'Independent worker caches must preserve the main trace');
      assert.equal(x.fixture_dispatch(cpu, targets.first, 0), 0x1112);
    } finally {
      for (const item of running) {
        await item.worker.terminate(); assert.equal(x.wc3_context_destroy(item.child), 1); x.free(item.stack); x.free(item.rawTls);
      }
    }
    const iterations = 3000000, times = [];
    x.fixture_dispatch_loop(cpu, targets.first, 10000);
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      assert.equal(x.fixture_dispatch_loop(cpu, targets.first, iterations) >>> 0, Math.imul(0x1112, iterations) >>> 0);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    results[name] = {iterations, medianMs: times[2], nativeTlsBytes: x.__tls_size.value};
  }
  console.log(JSON.stringify({functionCount: 86000, collisionChecks, workers, results,
    dispatchSpeedup: results.uncached.medianMs / results.cached.medianMs}));
} else {
  test('dispatch cache WASM fixture', {skip: 'Run tests/test_runtime_dispatch.py to compile both fixtures'}, () => {});
}
