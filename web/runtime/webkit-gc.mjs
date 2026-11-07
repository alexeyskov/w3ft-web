// JavaScriptCore (Safari, and every browser on iPhone and iPad) counts the whole
// shared WebAssembly memory a worker has touched — about 2 GB here — as part of
// that worker's heap. Its next collection then waits for a similar amount of
// new garbage, so the game's few megabytes a second of short-lived objects
// pile up into gigabytes before they are freed (docs/port-status.md).
//
// A large ArrayBuffer that is never written takes no physical memory: the
// engine maps zero pages. It still counts as allocation, so creating one every
// so often brings the collection back to about once a second. V8 and
// SpiderMonkey collect young objects by their own size and never run this.
let kept = null; // the latest one, so the allocation cannot be optimized away

export function webkitCollectorNudge(memory, {userAgent = globalThis.navigator?.userAgent || '', now = () => performance.now()} = {}) {
  if (!/AppleWebKit\//.test(userAgent) || /Chrome\/|Chromium\/|Edg\//.test(userAgent)) return null;
  let enabled = true;
  return () => {
    if (!enabled) return false;
    const size = Math.min(1024, Math.max(64, Math.floor(memory.buffer.byteLength / 4 / 1048576))) * 1048576;
    const started = now();
    try { kept = null; kept = new ArrayBuffer(size); }
    catch { enabled = false; return false; }
    // An engine that writes the zeros spends tens of milliseconds here: stop.
    if (now() - started > 4) { kept = null; enabled = false; return false; }
    return true;
  };
}
