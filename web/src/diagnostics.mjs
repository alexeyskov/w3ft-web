// The original WASM game has a single lifecycle shared by Play and the toolbar.
// Diagnostics stay in the downloadable log instead of a second launch screen.
import {attachTouchKeyboard} from './touch-keyboard.mjs';

const $ = id => document.getElementById(id);
let session = null, logTimer = null, logWritten = 0;
let currentLog = '';
try { currentLog = localStorage.getItem('wc3-last-log') || ''; } catch {}
const persistLog = () => { clearTimeout(logTimer); logTimer = null; logWritten = Date.now(); try { localStorage.setItem('wc3-last-log', currentLog); } catch {} };
// Written at once, at most every 250 ms: when the browser kills the page (out
// of memory) the saved log still ends with the stage the launch reached.
export function appendLog(message) {
  currentLog = `${currentLog}${new Date().toISOString()} ${String(message)}\n`.slice(-200000);
  if (logTimer) return;
  const wait = logWritten + 250 - Date.now();
  if (wait <= 0) persistLog(); else logTimer = setTimeout(persistLog, wait);
}
export const gameLog = () => currentLog;
export const gameRunning = () => session !== null;
const changed = (phase, error = '') => window.dispatchEvent(new CustomEvent('warcraft-session-state', {detail: {phase, error}}));
// A launch the browser cut short: the page went away while the game ran and
// without pagehide, as when a phone's browser reloads a page that ran out of
// memory (iPhone, iPad). The mark stays in storage; a game in another tab
// holds the lock, which a page that is gone no longer does. Reported once.
const RUNNING = 'wc3-game-running';
export const interruptedLaunch = (async () => {
  try { if (localStorage.getItem(RUNNING) === null) return false; } catch { return false; }
  try { if ((await navigator.locks?.query())?.held?.some(lock => lock.name === RUNNING)) return false; } catch {}
  try { localStorage.removeItem(RUNNING); } catch {}
  appendLog('The page was reloaded while the game ran: the browser closed it, usually for lack of memory.');
  return true;
})();
function running(item, value) {
  try { if (value) localStorage.setItem(RUNNING, new Date().toISOString()); else localStorage.removeItem(RUNNING); } catch {}
  if (value) navigator.locks?.request(RUNNING, {ifAvailable:true}, lock => lock && !item.ended && new Promise(resolve => { item.unlock = resolve; })).catch(() => {});
  else { item.ended = true; item.unlock?.(); }
}
// Warcraft's screenshots (Print Screen) go to the browser's downloads.
function offer({name, blob}) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Loading screen: {phase:'download', done, total} bytes, then {phase:'starting'}.
const progress = detail => window.dispatchEvent(new CustomEvent('warcraft-session-progress', {detail}));

async function enterFullscreen() {
  const item = session;
  const request = $('game-view').requestFullscreen({navigationUI:'hide'});
  item.fullscreenRequest = request;
  await request;
  // Like nfsu2-web, keep Escape and the game's function keys available where
  // Keyboard Lock is supported. Holding Escape still leaves fullscreen.
  if (session === item && !item.ending && !item.cancelled && document.fullscreenElement === $('game-view')) {
    navigator.keyboard?.lock?.().catch(() => {});
    // Phones and tablets: Warcraft is a landscape game. Chrome on Android locks
    // the orientation only in fullscreen; browsers without it keep rotating.
    if (matchMedia('(pointer: coarse)').matches) { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {} }
  }
}
function unlockKeyboard() { try { navigator.keyboard?.unlock?.(); } catch {} }
export async function toggleFullscreen() {
  if (!session || session.ending || !document.fullscreenEnabled) return;
  const item = session;
  if (document.fullscreenElement === $('game-view')) { unlockKeyboard(); await document.exitFullscreen(); }
  else await enterFullscreen();
  if (session === item && !item.ending) $('diagnostic-canvas').focus();
}

async function release(item, error = '') {
  item.resize?.disconnect();
  if (session !== item) return;
  item.ending = true;
  // A report arrives after the saves, just before worker/audio cleanup finishes.
  // Wait for that cleanup before making Play available again.
  if (item.controller) {
    try { await item.controller.stop(); } catch (stopError) { appendLog(stopError.message); }
  }
  item.prepared?.release();
  try { await item.audioContext?.close(); } catch {}
  // A very quick cancellation can beat the browser's asynchronous fullscreen
  // transition. Wait for it before hiding the stage, or it could reopen empty.
  try { await item.fullscreenRequest; } catch {}
  if (session !== item) return;
  unlockKeyboard();
  if (document.fullscreenElement === $('game-view')) {
    try { await document.exitFullscreen(); } catch {}
  }
  if (session !== item) return;
  session = null;
  running(item, false);
  $('touch-keyboard').blur();
  $('game-view').hidden = true;
  $('app').inert = false;
  document.body.style.overflow = '';
  persistLog();
  changed(error ? 'error' : 'ready', error);
  $('launch').focus();
}

export async function openGame({runtime, saves, transport = null, resolution = {width:1024, height:768}, audioEnabled = true, fullscreen = true, graphicsSettings = undefined, language = undefined, maxFps = 0}) {
  if (session) return;
  const item = {cancelled:false, controller:null, resize:null, preparing:null, prepared:null, audioContext:null};
  session = item;
  currentLog = '';
  running(item, true);
  appendLog(`Warcraft III; ${navigator.userAgent}`);
  appendLog(JSON.stringify({language, resolution, maxFps, audioEnabled, fullscreen, graphicsSettings}));
  $('game-view').hidden = false;
  $('game-loading').hidden = false;
  $('app').inert = true;
  $('stop-diagnostic').disabled = false;
  document.body.style.overflow = 'hidden';
  changed('loading');
  // Request during the Play click, before awaiting imports or downloads: browsers
  // require the user activation. Fullscreen failure must not prevent game launch.
  if (fullscreen && document.fullscreenEnabled) {
    enterFullscreen().catch(error => appendLog(`Fullscreen: ${error.message}`));
  }
  // Sound, also during the click: the game may start after long downloads,
  // when some browsers no longer count the click as activation.
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    item.audioContext = Context ? new Context() : null;
    item.audioContext?.resume().catch(() => {});
  } catch { item.audioContext = null; }
  progress({phase:'starting'});
  const previous = $('diagnostic-canvas'), canvas = previous.cloneNode();
  canvas.width = resolution.width; canvas.height = resolution.height;
  canvas.dataset.frames = '0'; previous.replaceWith(canvas);
  let width = resolution.width, height = resolution.height;
  const fit = () => {
    const stage = $('game-stage'), scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    // Letterboxing belongs outside the canvas. Runtime input uses its bounds;
    // object-fit:contain would put black bars INSIDE those bounds and offset clicks.
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
  };
  item.resize = new ResizeObserver(fit); item.resize.observe($('game-stage')); fit();
  canvas.focus();
  try {
    // The LAN lobby may still be connecting (Play joins a shared lobby); it
    // resolves to a transport or null while the runtime module loads.
    const [module, network] = await Promise.all([import(runtime.moduleUrl), transport]);
    appendLog(`LAN lobby: ${network ? network.lobby?.name || network.room : 'none'}`);
    if (item.cancelled) { await release(item); return; }
    // First what the game reads up to its main menu, with progress: after
    // the intro cinematic the menu opens without waiting for the network.
    if (typeof module.prepareGame === 'function') {
      progress({phase:'download', done:0, total:0});
      item.preparing = module.prepareGame({wasmUrl:runtime.wasmUrl, wasmSize:runtime.wasmSize, language,
        onProgress:({done, total}) => { if (session === item) progress({phase:'download', done, total}); },
        onStatus:message => { if (session === item) appendLog(message); }});
      item.prepared = await item.preparing.done;
      item.preparing = null;
      if (item.cancelled) { await release(item); return; }
      progress({phase:'starting'});
    }
    item.controller = await module.runDiagnostics({
      canvas, audioContext:item.audioContext || undefined, media:item.prepared?.media, wasmUrl:runtime.wasmUrl, saves, transport:network, resolution, audioEnabled, graphicsSettings, language, maxFps,
      // OK in the game's Video options also changes the launcher settings.
      onGraphicsSetting:(name, value) => {
        if (session !== item) return;
        appendLog(`Graphics setting from the game: ${name}=${value}`);
        window.dispatchEvent(new CustomEvent('warcraft-graphics-setting', {detail:{name, value}}));
      },
      timeout:0, dispatchBudget:0,
      onStatus:message => { if (session === item) appendLog(message); },
      onScreenshot:file => { if (session !== item) return; offer(file); appendLog(`Screenshot: ${file.name}`); },
      onFrame:frame => {
        if (session !== item) return;
        canvas.dataset.frames = String(frame.frames);
        if (frame.width > 0 && frame.height > 0 && (width !== frame.width || height !== frame.height)) {
          width = frame.width; height = frame.height; fit();
        }
        if (frame.frames > 0) $('game-loading').hidden = true;
      },
      onReport:report => {
        if (session !== item) return;
        appendLog(JSON.stringify(report, null, 2));
        window.dispatchEvent(new CustomEvent('warcraft-report', {detail:report}));
        const error = !item.cancelled && report.error?.message !== 'Guest process stopped' ? report.error?.message || '' : '';
        void release(item, error);
      },
    });
    if (item.cancelled || item.ending || session !== item) {
      await item.controller.stop(); await release(item); return;
    }
    changed('running'); canvas.focus();
  } catch (error) {
    appendLog(error.stack || error.message);
    await release(item, item.cancelled ? '' : error.message);
  }
}

export function stopGame() {
  if (!session || session.cancelled) return;
  session.cancelled = true;
  $('stop-diagnostic').disabled = true;
  changed('stopping');
  appendLog('Stopping and saving the game profile.');
  if (session.controller) session.controller.finish();
  else session.preparing?.cancel();
}
// Closing or reloading the page is the player's own doing, not an interruption.
window.addEventListener('pagehide', () => { persistLog(); if (session) running(session, false); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) unlockKeyboard(); });

// Touch screens (main.css shows these controls only where touch is the primary
// input): Escape, which the device lacks, its own keyboard (touch-keyboard.mjs)
// and a way out of fullscreen, where the toolbar with "Close game" is hidden.
const sendKey = (type, keyCode, text = '', extended = false) => { try { session?.controller?.key?.(type, {keyCode, text, extended}); } catch (error) { appendLog(`Touch key: ${error.message}`); } };
attachTouchKeyboard($('touch-keyboard'), sendKey);
$('touch-escape').addEventListener('click', () => { sendKey('keydown', 27, '\x1b'); sendKey('keyup', 27); });
// The keyboard button keeps the field focused while pressed, then toggles it.
$('touch-keyboard-button').addEventListener('pointerdown', event => event.preventDefault());
$('touch-keyboard-button').addEventListener('click', () => {
  const field = $('touch-keyboard');
  if (document.activeElement === field) { field.blur(); $('diagnostic-canvas').focus(); } else field.focus();
});
$('touch-exit').addEventListener('click', () => { toggleFullscreen().catch(error => appendLog(`Fullscreen: ${error.message}`)); });
