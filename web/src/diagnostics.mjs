// The original WASM game has a single lifecycle shared by Play and the toolbar.
// Diagnostics stay in the downloadable log instead of a second launch screen.
const $ = id => document.getElementById(id);
let session = null, logTimer = null;
let currentLog = '';
try { currentLog = localStorage.getItem('wc3-last-log') || ''; } catch {}
const persistLog = () => { logTimer = null; try { localStorage.setItem('wc3-last-log', currentLog); } catch {} };
export function appendLog(message) {
  currentLog = `${currentLog}${new Date().toISOString()} ${String(message)}\n`.slice(-200000);
  if (!logTimer) logTimer = setTimeout(persistLog, 1000);
}
export const gameLog = () => currentLog;
export const gameRunning = () => session !== null;
const changed = (phase, error = '') => window.dispatchEvent(new CustomEvent('warcraft-session-state', {detail: {phase, error}}));

async function enterFullscreen() {
  const item = session;
  const request = $('game-view').requestFullscreen({navigationUI:'hide'});
  item.fullscreenRequest = request;
  await request;
  // Like nfsu2-web, keep Escape and the game's function keys available where
  // Keyboard Lock is supported. Holding Escape still leaves fullscreen.
  if (session === item && !item.ending && !item.cancelled && document.fullscreenElement === $('game-view')) {
    navigator.keyboard?.lock?.().catch(() => {});
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
  $('game-view').hidden = true;
  $('app').inert = false;
  document.body.style.overflow = '';
  persistLog();
  changed(error ? 'error' : 'ready', error);
  $('launch').focus();
}

export async function openGame({runtime, saves, transport = null, resolution = {width:1024, height:768}, audioEnabled = true, fullscreen = true, graphicsSettings = undefined, language = undefined, maxFps = 0}) {
  if (session) return;
  const item = {cancelled:false, controller:null, resize:null};
  session = item;
  currentLog = '';
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
    item.controller = await module.runDiagnostics({
      canvas, wasmUrl:runtime.wasmUrl, saves, transport:network, resolution, audioEnabled, graphicsSettings, language, maxFps,
      // OK in the game's Video options also changes the launcher settings.
      onGraphicsSetting:(name, value) => {
        if (session !== item) return;
        appendLog(`Graphics setting from the game: ${name}=${value}`);
        window.dispatchEvent(new CustomEvent('warcraft-graphics-setting', {detail:{name, value}}));
      },
      timeout:0, dispatchBudget:0,
      onStatus:message => { if (session === item) appendLog(message); },
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
}
window.addEventListener('pagehide', persistLog);
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) unlockKeyboard(); });
