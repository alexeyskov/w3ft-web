// One block of a game file from the server. A dropped connection, a short or
// stalled answer, or a busy or restarting server is tried again with growing
// pauses, about half a minute in all: the game waits (a network match shows
// the other players its lag screen) instead of stopping. An answer like 404 is
// an error at once.
//
// rangeBlock reads synchronously and stops the worker meanwhile: for guest
// code that the worker itself runs. rangeBlockAsync is the same request with
// fetch: the worker serves other guest threads while one of them waits.
export const RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000];
const pause = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

// The block, or why there is none and whether to ask again.
function judge(status, response, error, start, end, label, attempt) {
  if (status === 206 && response?.byteLength === end - start) return {block: new Uint8Array(response)};
  const reason = error ? `${error.name}: ${error.message}` : status === 206 ? `short block (${response?.byteLength ?? 0} bytes)` : `HTTP ${status}`;
  const transient = !!error || status === 0 || status === 206 || status === 408 || status === 429 || status >= 500;
  if (!transient || attempt > RETRY_DELAYS.length) {
    throw new Error(`Range load failed${transient ? ` after ${attempt} attempts` : ''}: ${reason} ${label}`);
  }
  return {retry: `${label}: ${reason}; retrying in ${RETRY_DELAYS[attempt - 1] / 1000} s`, delay: RETRY_DELAYS[attempt - 1]};
}

export function rangeBlock(url, start, end, {label = url, onRetry = () => {}, request = () => new XMLHttpRequest(),
  wait = ms => pause && Atomics.wait(pause, 0, 0, ms), timeout = 30000} = {}) {
  for (let attempt = 1; ; attempt++) {
    let status = 0, response = null, error = null;
    try {
      const xhr = request();
      xhr.open('GET', url, false); xhr.responseType = 'arraybuffer'; xhr.timeout = timeout;
      xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`); xhr.send();
      status = xhr.status; response = xhr.response;
    } catch (caught) { error = caught; }
    const result = judge(status, response, error, start, end, label, attempt);
    if (result.block) return result.block;
    onRetry(result.retry);
    wait(result.delay);
  }
}

export async function rangeBlockAsync(url, start, end, {label = url, onRetry = () => {}, fetch: request = (...args) => fetch(...args),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 30000} = {}) {
  for (let attempt = 1; ; attempt++) {
    let status = 0, response = null, error = null;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
    try {
      const answer = await request(url, {headers: {Range: `bytes=${start}-${end - 1}`}, signal: abort.signal});
      status = answer.status; response = await answer.arrayBuffer();
    } catch (caught) { error = caught; }
    finally { clearTimeout(timer); }
    const result = judge(status, response, error, start, end, label, attempt);
    if (result.block) return result.block;
    onRetry(result.retry);
    await sleep(result.delay);
  }
}
