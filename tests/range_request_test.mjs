import test from 'node:test';
import assert from 'node:assert/strict';
import {rangeBlock, rangeBlockAsync, RETRY_DELAYS} from '../web/runtime/range-request.mjs';

// Scripted XMLHttpRequest stand-ins: each answer is {status, bytes} or {error}.
function server(answers) {
  const requests = [];
  const request = () => {
    const answer = answers.shift(), xhr = {headers: {}, open(method, url, async) { Object.assign(xhr, {method, url, async}); },
      setRequestHeader(name, value) { xhr.headers[name] = value; },
      send() { requests.push(xhr); if (answer.error) throw Object.assign(new Error(answer.error), {name: 'NetworkError'}); xhr.status = answer.status; xhr.response = answer.bytes ? new Uint8Array(answer.bytes).buffer : null; }};
    return xhr;
  };
  return {request, requests};
}

test('a block arrives at the first answer', () => {
  const {request, requests} = server([{status: 206, bytes: [1, 2, 3, 4]}]), waits = [];
  assert.deepEqual([...rangeBlock('/api/assets/a', 8, 12, {request, wait: ms => waits.push(ms)})], [1, 2, 3, 4]);
  assert.deepEqual([requests[0].method, requests[0].async, requests[0].headers.Range, requests[0].timeout], ['GET', false, 'bytes=8-11', 30000]);
  assert.deepEqual(waits, []);
});

test('a dropped connection, a short block and a restarting server are tried again', () => {
  const {request, requests} = server([{error: 'Failed to load'}, {status: 206, bytes: [1]}, {status: 502}, {status: 206, bytes: [5, 6]}]);
  const waits = [], notes = [];
  assert.deepEqual([...rangeBlock('/x', 0, 2, {label: 'war3.mpq', request, wait: ms => waits.push(ms), onRetry: note => notes.push(note)})], [5, 6]);
  assert.equal(requests.length, 4);
  assert.deepEqual(waits, RETRY_DELAYS.slice(0, 3));
  assert.match(notes[0], /^war3\.mpq: NetworkError: Failed to load; retrying in 0\.25 s$/);
  assert.match(notes[1], /short block \(1 bytes\)/);
  assert.match(notes[2], /HTTP 502/);
});

test('a missing file fails at once; a server that never recovers fails after the retries', () => {
  const waits = [];
  assert.throws(() => rangeBlock('/x', 0, 4, {label: 'war3.mpq', request: server([{status: 404}]).request, wait: ms => waits.push(ms)}),
    /^Error: Range load failed: HTTP 404 war3\.mpq$/);
  assert.deepEqual(waits, []);
  const {request, requests} = server(Array.from({length: RETRY_DELAYS.length + 1}, () => ({status: 503})));
  assert.throws(() => rangeBlock('/x', 0, 4, {label: 'war3.mpq', request, wait: ms => waits.push(ms)}),
    new RegExp(`after ${RETRY_DELAYS.length + 1} attempts: HTTP 503 war3\\.mpq$`));
  assert.equal(requests.length, RETRY_DELAYS.length + 1);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 27750, 'about half a minute of waiting');
});

// The same answers through fetch: each is {status, bytes}, {error} or {hang}.
function fetcher(answers) {
  const requests = [];
  const fetch = (url, init) => {
    requests.push({url, ...init});
    const answer = answers.shift();
    if (answer.error) return Promise.reject(Object.assign(new Error(answer.error), {name: 'TypeError'}));
    if (answer.hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));
    return Promise.resolve({status: answer.status, arrayBuffer: async () => answer.bytes ? new Uint8Array(answer.bytes).buffer : new ArrayBuffer(0)});
  };
  return {fetch, requests};
}

test('fetch: the same block, retries and errors without stopping the worker', async () => {
  const {fetch, requests} = fetcher([{error: 'Failed to fetch'}, {status: 206, bytes: [1]}, {status: 503}, {status: 206, bytes: [7, 8, 9, 10]}]);
  const waits = [], notes = [];
  const block = await rangeBlockAsync('/api/assets/a', 8, 12, {label: 'war3.mpq', fetch, sleep: async ms => { waits.push(ms); }, onRetry: note => notes.push(note)});
  assert.deepEqual([...block], [7, 8, 9, 10]);
  assert.deepEqual(requests.map(r => r.headers.Range), Array(4).fill('bytes=8-11'));
  assert.deepEqual(waits, RETRY_DELAYS.slice(0, 3));
  assert.match(notes[0], /^war3\.mpq: TypeError: Failed to fetch; retrying in 0\.25 s$/);
  await assert.rejects(rangeBlockAsync('/x', 0, 4, {label: 'war3.mpq', fetch: fetcher([{status: 404}]).fetch, sleep: async () => {}}),
    /^Error: Range load failed: HTTP 404 war3\.mpq$/);
});

test('fetch: a stalled answer is abandoned after the timeout and asked again', async () => {
  const {fetch, requests} = fetcher([{hang: true}, {status: 206, bytes: [5, 6]}]), notes = [];
  const block = await rangeBlockAsync('/x', 0, 2, {label: 'War3x.mpq', fetch, timeout: 20, sleep: async () => {}, onRetry: note => notes.push(note)});
  assert.deepEqual([...block], [5, 6]);
  assert.equal(requests.length, 2);
  assert.match(notes[0], /AbortError/);
});
