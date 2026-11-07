import {SaveStore} from './storage.mjs';
import {FrameTransport} from './transport.mjs';
import {PresenceCounter} from './presence.mjs';
import {openGame, gameRunning, stopGame, toggleFullscreen, gameLog, appendLog, interruptedLaunch} from './diagnostics.mjs';

const $ = id => document.getElementById(id);
$('help-discord').href = $('discord').href;
const store = new SaveStore();
const english = {
  fan:'Fan project. Not affiliated with Blizzard Entertainment.', changelog:'Changelog', play:'Play', downloadLog:'Download log', creditsLicenses:'Credits & licenses',
  about:'About', credits:'Credits',
  aboutLead:'The original Warcraft III: The Frozen Throne in your browser. The game code is recompiled to WebAssembly, with graphics through WebGL 2 and sound through Web Audio.',
  aboutPlay:'Choose campaigns, battles and maps inside the game. Saves stay in your browser, and LAN lobbies let you play with friends.',
  aboutEditions:'The Russian and English editions of Warcraft are supported. The game follows the selected site language.',
  aboutHelp:'Questions and bug reports:', aboutHelpOr:'or',
  creditsSource:'Source code on', creditsAdapted:'The launcher layout, static recompilation tools and CPU helpers are adapted from', creditsBased:'which builds on', creditsAuthor:'by Talha Müderrisoğlu',
  creditsPinned:'The imported files come from the pinned', creditsMitVersion:'MIT-licensed version', creditsMpq:'MPQ format reference:', creditsGeo:'IP Geolocation by',
  creditsLicense:'MIT license', creditsNotices:'Third-party credits and notices',
  creditsWarcraft:'Warcraft III: The Frozen Throne and Blizzard Entertainment are trademarks of Blizzard Entertainment, Inc. Game content remains the property of its respective rights holders.',
  logHint:"After reloading, your last game's log is still available.", inGame:'In the game', menuHint:'Campaigns, battles and maps are selected in Warcraft itself.', mapHint:'Server maps appear directly in the game\'s map list.',
  saves:'Saves', online:'Online', game:'Game', controls:'Controls', profiles:'Profiles and saves', backup:'Download backup', restore:'Restore',
  saveHint:'Saves stay in this browser. Download a backup to move them to another device.', lobbies:'LAN lobbies', refresh:'Refresh',
  lanHint:'Play without a chosen lobby puts you in the first public lobby of your language with a free seat (up to 200 players). You can join any lobby, players with different game languages play together, or create your own. In Warcraft, open Local Area Network: one player hosts a match, the others join.',
  gameLanguage:'Game language', gameLanguageHint:'The same as the page language.', frameRate:'Frame rate', frameRateHint:'Auto matches the display. 30 is steadier on slow devices and saves battery.', fpsAuto:'Auto',
  leave:'Leave', lobbyName:'Lobby name', create:'Create', privateRoom:'Join by code', roomCode:'Lobby code', join:'Join',
  settingsHint:'Settings apply on the next launch.', resolution:'Resolution', resolutionHint:'Higher is sharper; lower is easier on the graphics card.', sound:'Sound', fullscreen:'Fullscreen', fullscreenHint:'Enter fullscreen when starting the game.',
  graphics:'Graphics', graphicsHint:'The same settings as Options → Video in the game. Changes made in the game are saved here too.', gamma:'Gamma', darker:'Darker', brighter:'Brighter',
  modelDetail:'Model detail', animQuality:'Animation quality', texQuality:'Texture quality', particles:'Particles', lights:'Lights', shadows:'Shadows', occlusion:'Occlusion', spellDetail:'Spell detail',
  lowF:'Low', mediumF:'Medium', highF:'High', lowN:'Low', mediumN:'Medium', highN:'High', minimum:'Low', normal:'Medium', maximum:'High',
  gameData:'Game data on this device', deleteGameData:'Delete game data', resetSettings:'Reset all settings',
  playingNow:'Playing now', onlinePlaying:'in game', onlineLan:'over LAN', onlineSite:'on the site',
  startKey:'Start the game from this page', lmb:'LMB', rmb:'RMB', selectKey:'Select a unit or building', orderKey:'Move, attack or issue an order', menuKey:'Game menu and saving', escapeKey:'Cancel / skip cinematic',
  touchHint:'On a touch screen: tap to click, long press or two-finger tap for the right mouse button, move two fingers to scroll the map, pinch to zoom. The keyboard button opens the on-screen keyboard; its Enter key opens chat in the game.', rotateHint:'Turn the device to landscape',
  controlsHint:'Keyboard and mouse work inside the game window. Other controls are the standard Warcraft III commands. To exit fullscreen, hold Escape.', stop:'Close game', starting:'Starting Warcraft…', close:'Close',
  changeInitialRelease:'Initial public release.',
};
const russian = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(node => [node.dataset.i18n, node.textContent]));
const messages = {
  ready:['Готово','Ready'], readyHint:['Нажмите «Играть», чтобы начать. Запуск может занять несколько минут.','Press Play to start. Startup may take a few minutes.'], loading:['Загрузка','Loading'], checking:['Проверяем файлы игры.','Checking game files.'],
  running:['Игра запущена','Playing'], runningHint:['Warcraft открыт в окне игры.','Warcraft is open in the game window.'], stopping:['Сохранение…','Saving…'], stoppingHint:['Сохраняем профиль перед выходом.','Saving your profile before closing.'],
  error:['Не удалось запустить','Unable to start'], errorHint:['Подробности доступны в журнале.','Details are available in the log.'], unavailable:['Игра недоступна','Game unavailable'],
  filesMissing:['Файлы игры ещё не подготовлены на сервере.','Game files have not been prepared on the server.'], runtimeMissing:['Файлы движка ещё не подготовлены.','The game runtime has not been prepared.'],
  browserUnsupported:['Нужен браузер с WebGL 2 и общей памятью, открытый через HTTPS или localhost.','Use a browser with WebGL 2 and shared memory over HTTPS or localhost.'],
  emptySaves:['Сохранений пока нет. Создайте профиль в игре.','No saves yet. Create a profile in the game.'], emptyLobbies:['Открытых лобби пока нет. Создайте первое.','No open lobbies yet. Create the first one.'],
  loadingLobbies:['Загружаем лобби…','Loading lobbies…'], players:['игроков','players'], joined:['Вы в лобби','Joined'], full:['Заполнено','Full'],
  disconnected:['Соединение с лобби потеряно. Войдите заново перед сетевой игрой.','Lobby connection lost. Rejoin before playing online.'],
  networkUnavailable:['Сетевые лобби сейчас недоступны.','Online lobbies are currently unavailable.'], saved:['Копия сохранений скачана.','Save backup downloaded.'], restored:['Сохранения восстановлены.','Saves restored.'],
  archiveTooLarge:['Архив превышает 180 МБ.','The backup exceeds 180 MB.'], sharedLobby:['Общее лобби','Public lobby'], customLobbies:['Свои лобби','Custom lobbies'],
  gameDataSummary:['На этом устройстве {cached} из {total} (без роликов). Загрузите остальное заранее, чтобы запуск не ждал сеть.','{cached} of {total} is on this device (movies not included). Preload the rest so loading never waits on the network.'],
  gameDataComplete:['Все данные игры ({total}) уже на этом устройстве (без роликов).','All game data ({total}) is on this device (movies not included).'],
  gameDataUnsupported:['Этот браузер не может хранить данные игры: они загружаются при каждом запуске.','This browser cannot keep game data; it is downloaded on each launch.'],
  gameDataPreloading:['Загрузка: {done} из {total}…','Downloading: {done} of {total}…'], gameDataCounting:['Считаем…','Counting…'],
  preloadRest:['Загрузить остальное ({size})','Preload the rest ({size})'], stopPreload:['Остановить','Stop'], gameDataDeleted:['Данные игры удалены.','Game data deleted.'],
  gameDataBusy:['Данные игры сейчас использует игра в другой вкладке.','Game data is in use by a game in another tab.'], gameDataQuota:['Недостаточно места на устройстве.','Not enough storage space on this device.'],
  gameDataFailed:['Загрузка прервалась: {message}','Download failed: {message}'], settingsReset:['Настройки сброшены.','Settings reset.'],
  bytesMB:['МБ','MB'], bytesGB:['ГБ','GB'],
  gameLanguageMissing:['Английские файлы игры на сервере не установлены, игра запустится на русском.','English game files are not installed on this server; the game starts in Russian.'],
  appleUnsupported:['На iPhone и iPad игра пока не запускается: все браузеры там работают на движке Safari, и он перезагружает страницу, когда игре не хватает памяти. Играйте на компьютере или на Android.','Warcraft does not run on iPhone and iPad yet: every browser there uses Safari\'s engine, which reloads the page when the game runs out of memory. Play on a computer or Android.'],
  interrupted:['Прошлый запуск прервался: браузер перезагрузил страницу во время игры. Обычно так бывает, когда устройству не хватает памяти.','The last launch was cut short: the browser reloaded the page during the game. This usually means the device ran out of memory.'],
  autoLobbyFailed:['Не удалось войти в общее лобби — игра запущена без сети.','Could not join a public lobby; the game started without network.'], exitFullscreen:['Выйти из полного экрана','Exit fullscreen'], downloadingGame:['Загрузка файлов игры','Downloading game files'], downloadAmount:['{done} из {total} МБ · {percent}%','{done} of {total} MB · {percent}%'], touchKeyboard:['Клавиатура','Keyboard'],
};
// Warcraft's own Video options: [minimum, maximum, launcher default]. game.dll
// would default to low model detail and medium textures; any current
// computer runs the high settings comfortably. Gamma 30 is the game's default.
const GRAPHICS = {gamma:[0,100,30], modeldetail:[0,2,2], animquality:[0,2,2], texquality:[0,2,2], particles:[0,2,2], lights:[0,2,2], unitshadows:[0,1,1], occlusion:[0,1,1], spellfilter:[0,2,2]};
const validGraphics = (name, value) => Object.hasOwn(GRAPHICS, name) && Number.isInteger(value) && value >= GRAPHICS[name][0] && value <= GRAPHICS[name][1];
const FRAME_RATES = [0, 30, 60, 120]; // 0: every display refresh
// Resolutions are the options of the page's list (4:3, as Warcraft draws them).
const RESOLUTIONS = [...$('resolution').options].map(option => option.value);
const defaultSettings = () => ({version:2, resolution:'1280x960', audioEnabled:true, fullscreen:true, fps:0, graphics:Object.fromEntries(Object.entries(GRAPHICS).map(([name, [,, value]]) => [name, value]))});
// Page language: the visitor's choice; without one, by country (Russian for
// the CIS, English elsewhere; server/geoip.py), else the browser's language.
let language = 'ru', chosenLanguage = null, settings = defaultSettings();
async function suggestedLanguage() {
  const browser = /^ru\b/i.test(navigator.languages?.[0] || navigator.language || '') ? 'ru' : 'en';
  try {
    const response = await fetch('/api/locale', {cache:'no-store', signal:AbortSignal.timeout(1500)});
    const {language:suggested} = response.ok ? await response.json() : {};
    return ['ru','en'].includes(suggested) ? suggested : browser;
  } catch { return browser; }
}
try {
  chosenLanguage = ['ru','en'].find(code => code === localStorage.getItem('wc3-language')) ?? null;
  const saved = JSON.parse(localStorage.getItem('wc3-launch-settings') || '{}');
  // Settings saved before version 2 recorded 1024×768, the default then, even
  // when it was never chosen; they start at the new default once.
  if (RESOLUTIONS.includes(saved.resolution) && !(saved.version !== 2 && saved.resolution === '1024x768')) settings.resolution = saved.resolution;
  if (typeof saved.audioEnabled === 'boolean') settings.audioEnabled = saved.audioEnabled;
  if (typeof saved.fullscreen === 'boolean') settings.fullscreen = saved.fullscreen;
  if (FRAME_RATES.includes(saved.fps)) settings.fps = saved.fps;
  for (const [name, value] of Object.entries(saved.graphics || {})) if (validGraphics(name, value)) settings.graphics[name] = value;
} catch {}
const languageSuggestion = chosenLanguage ? null : suggestedLanguage();
const t = key => messages[key]?.[language === 'en' ? 1 : 0] ?? (language === 'en' ? english[key] : russian[key]) ?? key;
let server = null, phase = 'loading', startupError = '', activeTab = 'saves';
let room = null, pendingRoom = null, lobbyBusy = false, lobbies = [], lobbiesLoaded = false, lobbyRequest = 0;
let lobbyCreation = null;
let saving = false, saveFiles = [], webgl = false;
const presence = new PresenceCounter();
// "By LAN" counts a running game that uses a site lobby.
const reportPresence = () => presence.update({playing:gameRunning(), lan:!!room});
const shared = isSecureContext && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
try {
  const canvas = document.createElement('canvas'), context = canvas.getContext('webgl2');
  webgl = !!context; context?.getExtension('WEBGL_lose_context')?.loseContext();
} catch {}

function element(tag, value, className = '') {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
function notice(id, value = '', success = false) {
  $(id).textContent = value; $(id).hidden = !value; $(id).classList.toggle('success', success);
}
async function json(url, options = {}) {
  const response = await fetch(url, {cache:'no-store', ...options});
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function available() { return !!(server?.game.prepared && server?.runtime.installed && server?.runtime.diagnostics && shared && webgl); }
function updateState() {
  const active = gameRunning();
  document.body.dataset.phase = phase;
  $('launch').disabled = !available() || active || lobbyBusy || saving || gameDataBusy;
  $('status').textContent = t(phase);
  $('status-sub').textContent = t(phase === 'ready' ? 'readyHint' : phase === 'loading' ? active ? 'starting' : 'checking' : `${phase}Hint`);
  if (!active && server && !available()) {
    $('status').textContent = t('unavailable');
    $('status-sub').textContent = t(!server.game.prepared ? 'filesMissing' : !server.runtime.installed || !server.runtime.diagnostics ? 'runtimeMissing' : 'browserUnsupported');
  }
  if (startupError) notice('launch-message', startupError);
  for (const id of ['resolution','audio-enabled','fullscreen-enabled']) $(id).disabled = active;
  for (const name of Object.keys(GRAPHICS)) graphicsInput(name).disabled = active;
  for (const input of document.querySelectorAll('input[name=fps]')) input.disabled = active;
  $('reset-settings').disabled = active;
  renderGameData();
  $('fullscreen-enabled').disabled ||= !document.fullscreenEnabled;
  $('export-saves').disabled = active || saving;
  $('import-saves').disabled = active || saving;
  $('import-saves').parentElement.setAttribute('aria-disabled', String(active || saving));
  for (const id of ['create-lobby','lobby-name','join-code','room-code','leave-lobby']) $(id).disabled = active || lobbyBusy || !server?.transport.available;
  for (const button of $('lobby-list').querySelectorAll('button')) button.disabled = active || lobbyBusy || button.dataset.unavailable === 'true';
  updateFullscreen();
}
function renderPresence() {
  const counts = presence.counts;
  for (const [id, key] of [['online-playing','playing'], ['online-lan','lan'], ['online-site','online']]) {
    $(id).textContent = counts ? counts[key].toLocaleString(language === 'en' ? 'en-US' : 'ru-RU') : '—';
  }
}
function renderGameLanguage() {
  $('game-language-value').textContent = LANGUAGES[gameLanguage()];
  const missing = !!server && gameLanguage() !== language;
  $('game-language-missing').hidden = !missing; if (missing) $('game-language-missing').textContent = t('gameLanguageMissing');
}
// iPhone and iPad, also iPadOS asking for desktop pages: every browser there is
// WebKit, which closes the page when the game outgrows its memory
// (docs/port-status.md). A launch cut short elsewhere is reported after reload.
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let interruptedNotice = false;
function renderNotices() {
  $('device-warning').hidden = !appleMobile; if (appleMobile) $('device-warning').textContent = t('appleUnsupported');
  if (interruptedNotice && !startupError) notice('launch-message', t('interrupted'));
}
function updateFullscreen() {
  $('diagnostic-fullscreen').disabled = !document.fullscreenEnabled;
  $('diagnostic-fullscreen').textContent = t(document.fullscreenElement === $('game-view') ? 'exitFullscreen' : 'fullscreen');
}
function translate() {
  document.documentElement.lang = language; $('language').value = language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-info-label]')) node.setAttribute('aria-label', t('about'));
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  $('lobby-name').placeholder = t('lobbyName'); $('room-code').placeholder = t('roomCode');
  $('import-saves').setAttribute('aria-label', t('restore'));
  $('language').setAttribute('aria-label', language === 'en' ? 'Page language' : 'Язык страницы');
  renderSaves(); renderLobbies(); renderRoom(); renderPresence(); renderGameLanguage(); renderLoading(); renderNotices(); updateState();
}
// Loading screen of a launch (diagnostics.mjs): the download with progress, then the start.
let loading = {phase:'starting'};
function renderLoading() {
  const download = loading.phase === 'download' && loading.total > 0, fraction = download ? Math.min(1, loading.done / loading.total) : 0;
  const megabytes = value => (value / 1048576).toLocaleString(language === 'en' ? 'en-US' : 'ru-RU', {maximumFractionDigits:value < 10 * 1048576 ? 1 : 0});
  $('game-loading-title').textContent = t(loading.phase === 'download' ? 'downloadingGame' : 'starting');
  $('game-loading-bar').hidden = !download;
  $('game-loading-bar').setAttribute('aria-valuenow', String(Math.floor(fraction * 100)));
  $('game-loading-fill').style.width = `${(fraction * 100).toFixed(1)}%`;
  $('game-loading-detail').textContent = download ? t('downloadAmount').replace('{done}', megabytes(loading.done)).replace('{total}', megabytes(loading.total)).replace('{percent}', String(Math.floor(fraction * 100))) : '';
}
window.addEventListener('warcraft-session-progress', event => { loading = event.detail; renderLoading(); });
function showTab(name, focus = false) {
  activeTab = name;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(`pane-${tab.dataset.tab}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (name === 'online') void refreshLobbies();
  if (name === 'saves') void updateSaves();
}
function renderSaves() {
  $('save-count').textContent = String(saveFiles.length);
  const list = $('save-list'); list.replaceChildren();
  if (!saveFiles.length) { list.append(element('p', t('emptySaves'), 'empty')); return; }
  for (const file of saveFiles) {
    const row = element('div', '', 'file-row'), info = element('div', '');
    info.append(element('strong', file.path.split('/').at(-1)), element('small', file.path));
    const modified = new Date(file.modified), validDate = Number.isFinite(modified.getTime());
    const date = element('time', validDate ? new Intl.DateTimeFormat(language, {dateStyle:'medium'}).format(modified) : '—');
    if (validDate) date.dateTime = modified.toISOString();
    row.append(info, date); list.append(row);
  }
}
async function updateSaves() {
  try { saveFiles = (await store.list()).sort((a,b) => b.modified - a.modified); renderSaves(); }
  catch (error) { notice('save-status', error.message); }
}
function lobbyTitle(lobby) { return lobby?.shared ? `${t('sharedLobby')} ${lobby.shared}` : lobby?.name; }
// Round flag of a shared lobby group's game language (static markup).
const LANGUAGES = {ru:'Русский', en:'English'};
const FLAGS = {
  ru:'<svg viewBox="0 0 30 30" aria-hidden="true"><path fill="#fff" d="M0 0h30v10H0z"/><path fill="#0039a6" d="M0 10h30v10H0z"/><path fill="#d52b1e" d="M0 20h30v10H0z"/></svg>',
  en:'<svg viewBox="15 0 30 30" aria-hidden="true"><path fill="#012169" d="M0 0h60v30H0z"/><path stroke="#fff" stroke-width="6" d="M0 0l60 30M60 0L0 30"/><path stroke="#c8102e" stroke-width="2" d="M0 0l60 30M60 0L0 30"/><path stroke="#fff" stroke-width="10" d="M30 0v30M0 15h60"/><path stroke="#c8102e" stroke-width="6" d="M30 0v30M0 15h60"/></svg>',
};
function flag(code) {
  const node = document.createElement('span'); node.className = 'flag'; node.innerHTML = FLAGS[code] || '';
  node.setAttribute('role', 'img'); node.setAttribute('aria-label', LANGUAGES[code] || code); return node;
}
// The game runs in the page language when the server has that localization.
function gameLanguage() { return server?.game.languages?.includes(language) ? language : server?.game.languages?.[0] || 'ru'; }
function renderRoom() {
  $('joined-lobby').hidden = !room;
  if (!room) return;
  $('joined-name').replaceChildren(...(room.lobby?.shared ? [flag(room.lobby.language)] : []), document.createTextNode(lobbyTitle(room.lobby) || room.room));
  $('joined-players').textContent = `${room.peerIds.length} / ${room.lobby?.maxPlayers ?? 200} ${t('players')}`;
}
function renderLobbies() {
  const list = $('lobby-list'); list.replaceChildren();
  if (!lobbies.length) { list.append(element('p', t(lobbiesLoaded ? 'emptyLobbies' : 'loadingLobbies'), 'empty')); return; }
  // Shared lobbies grouped by game language, then lobbies created by players,
  // which have no language. Groups: Latin-script names A–Z, then Cyrillic А–Я.
  const script = name => /^[A-Za-z]/.test(name) ? 0 : /^[А-яЁё]/.test(name) ? 1 : 2;
  const codes = Object.keys(LANGUAGES).sort((a, b) => script(LANGUAGES[a]) - script(LANGUAGES[b]) || LANGUAGES[a].localeCompare(LANGUAGES[b], script(LANGUAGES[a]) ? 'ru' : 'en'));
  const groups = [...codes.map(code => ({code, title:LANGUAGES[code], lobbies:lobbies.filter(l => l.shared && l.language === code)})),
    {code:null, title:t('customLobbies'), lobbies:lobbies.filter(l => !l.shared)}];
  for (const group of groups) {
    if (!group.lobbies.length) continue;
    const heading = element('h3', '', 'lobby-group');
    if (group.code) heading.append(flag(group.code));
    heading.append(document.createTextNode(group.title)); list.append(heading);
    for (const lobby of group.lobbies) list.append(lobbyRow(lobby));
  }
}
function lobbyRow(lobby) {
  const row = element('div', '', 'lobby-row'), info = element('div', '');
  info.append(element('strong', lobbyTitle(lobby)), element('small', `${lobby.players} / ${lobby.maxPlayers} ${t('players')}`));
  const joined = room?.room === lobby.id, full = lobby.players >= lobby.maxPlayers;
  const button = element('button', t(joined ? 'joined' : full ? 'full' : 'join'), 'btn');
  button.dataset.unavailable = String(joined || full);
  button.disabled = joined || full || lobbyBusy || gameRunning();
  button.onclick = () => void joinLobby(lobby.id, true);
  row.append(info, button); return row;
}
async function refreshLobbies() {
  if (!server?.transport.available) return;
  const request = ++lobbyRequest;
  $('refresh-lobbies').disabled = true;
  try {
    const result = await json('/api/lobbies');
    if (request !== lobbyRequest) return;
    lobbies = result.lobbies; lobbiesLoaded = true; renderLobbies();
  } catch (error) { if (request === lobbyRequest) notice('lobby-status', `${t('networkUnavailable')} (${error.message})`); }
  finally { if (request === lobbyRequest) $('refresh-lobbies').disabled = false; }
}
function setRoom(transport) {
  const old = room; room = transport; old?.close();
  if (transport) {
    transport.addEventListener('peers', () => { if (room === transport) renderRoom(); });
    transport.addEventListener('disconnect', () => {
      if (room !== transport) return;
      room = null; renderRoom(); renderLobbies();
      notice('lobby-status', t('disconnected')); appendLog('LAN lobby disconnected.');
    });
  }
  renderRoom(); renderLobbies(); reportPresence();
}
async function connectLobby(id, publicLobby) {
  const transport = new FrameTransport(id, {publicLobby});
  pendingRoom = transport;
  try { await transport.connect(); setRoom(transport); }
  catch (error) { transport.close(); throw error; }
  finally { if (pendingRoom === transport) pendingRoom = null; }
}
// Play outside a lobby: the server seats the player in shared lobby 1, 2, 3, 4
// in order, or in a new one when all are full. Without it the game runs offline.
async function joinSharedLobby() {
  const transport = new FrameTransport('auto', {language});
  pendingRoom = transport; lobbyBusy = true; updateState();
  try {
    await transport.connect(); setRoom(transport);
    appendLog(`Joined ${transport.lobby?.name || transport.room} (${transport.peerIds.length}/${transport.lobby?.maxPlayers}).`);
    return transport;
  } catch (error) {
    transport.close(); notice('lobby-status', `${t('autoLobbyFailed')} (${error.message})`);
    appendLog(`Shared lobby unavailable: ${error.message}`); return null;
  } finally {
    if (pendingRoom === transport) pendingRoom = null;
    lobbyBusy = false; updateState(); void refreshLobbies();
  }
}
async function joinLobby(id, publicLobby) {
  if (lobbyBusy || gameRunning()) return;
  lobbyBusy = true; notice('lobby-status'); updateState();
  try { await connectLobby(id, publicLobby); await refreshLobbies(); }
  catch (error) { notice('lobby-status', error.message); }
  finally { lobbyBusy = false; updateState(); }
}

$('language').onchange = () => { language = $('language').value; try { localStorage.setItem('wc3-language', language); } catch {} translate(); void refreshGameData(); };
$('changelog-open').onclick = () => $('changelog').showModal();
$('changelog-close').onclick = () => $('changelog').close();
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.onclick = () => showTab(tab.dataset.tab);
  tab.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    showTab(tabs[next].dataset.tab, true);
  };
}
// This card is its own tab group; it must not change the game/settings pane.
const infoTabs = [...document.querySelectorAll('[data-info-tab]')];
function showInfoTab(name, focus = false) {
  for (const tab of infoTabs) {
    const selected = tab.dataset.infoTab === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}
for (const tab of infoTabs) {
  tab.onclick = () => showInfoTab(tab.dataset.infoTab);
  tab.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index = infoTabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? infoTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + infoTabs.length) % infoTabs.length;
    showInfoTab(infoTabs[next].dataset.infoTab, true);
  };
}
function saveSettings() { try { localStorage.setItem('wc3-launch-settings', JSON.stringify(settings)); } catch {} }
function graphicsInput(name) { return $(`video-${name}`); }
function showFrameRate() { for (const input of document.querySelectorAll('input[name=fps]')) input.checked = Number(input.value) === settings.fps; }
function showGraphics() {
  for (const [name, value] of Object.entries(settings.graphics)) {
    const input = graphicsInput(name);
    if (input.type === 'checkbox') input.checked = value === 1; else input.value = String(value);
  }
}
$('resolution').value = settings.resolution;
$('audio-enabled').checked = settings.audioEnabled;
$('fullscreen-enabled').checked = settings.fullscreen;
showGraphics(); showFrameRate();
for (const id of ['resolution','audio-enabled','fullscreen-enabled']) $(id).onchange = () => {
  settings = {...settings, resolution:$('resolution').value, audioEnabled:$('audio-enabled').checked, fullscreen:$('fullscreen-enabled').checked};
  saveSettings();
};
for (const input of document.querySelectorAll('input[name=fps]')) input.onchange = () => {
  if (input.checked && FRAME_RATES.includes(Number(input.value))) { settings = {...settings, fps:Number(input.value)}; saveSettings(); }
};
for (const name of Object.keys(GRAPHICS)) graphicsInput(name).onchange = () => {
  const input = graphicsInput(name), value = input.type === 'checkbox' ? Number(input.checked) : Number(input.value);
  if (validGraphics(name, value)) { settings.graphics = {...settings.graphics, [name]:value}; saveSettings(); }
};
// OK in the game's Video options: the next launch starts with the same values.
window.addEventListener('warcraft-graphics-setting', event => {
  const {name, value} = event.detail;
  if (!validGraphics(name, value) || settings.graphics[name] === value) return;
  settings.graphics = {...settings.graphics, [name]:value}; saveSettings(); showGraphics();
});
// Game data on this device: what the runtime has stored, preload, delete.
let runtimeModule = null, gameData = null, preload = null, gameDataBusy = false, gameDataRequest = 0;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
function bytes(value) {
  const locale = language === 'en' ? 'en-US' : 'ru-RU';
  return value >= 1e9 ? `${(value / 1e9).toLocaleString(locale, {maximumFractionDigits:1})} ${t('bytesGB')}`
    : `${Math.round(value / 1e6).toLocaleString(locale)} ${t('bytesMB')}`;
}
async function runtime() { return runtimeModule ??= await import(server.runtime.moduleUrl); }
async function refreshGameData() {
  if (!available()) return;
  const request = ++gameDataRequest;
  try {
    const status = await (await runtime()).gameDataStatus?.({language:gameLanguage()});
    if (request === gameDataRequest) { gameData = status || {supported:false, total:0, cached:0}; renderGameData(); }
  } catch { if (request === gameDataRequest) { gameData = null; renderGameData(); } }
}
function renderGameData() {
  const summary = $('game-data-summary'), load = $('preload-game-data'), remove = $('delete-game-data');
  if (preload) {
    summary.textContent = fill(t('gameDataPreloading'), {done:bytes(preload.done), total:bytes(preload.total)});
    load.hidden = false; load.textContent = t('stopPreload'); remove.hidden = true; return;
  }
  if (!gameData) { summary.textContent = server && available() ? t('gameDataCounting') : ''; load.hidden = remove.hidden = true; return; }
  if (!gameData.supported) { summary.textContent = t('gameDataUnsupported'); load.hidden = remove.hidden = true; return; }
  const rest = Math.max(0, gameData.total - gameData.cached);
  summary.textContent = fill(t(rest ? 'gameDataSummary' : 'gameDataComplete'), {cached:bytes(gameData.cached), total:bytes(gameData.total)});
  load.hidden = !rest; load.textContent = fill(t('preloadRest'), {size:bytes(rest)});
  remove.hidden = !gameData.cached;
  const active = gameRunning() || gameDataBusy;
  load.disabled = remove.disabled = active;
}
$('preload-game-data').onclick = async () => {
  if (preload) { preload.cancel(); return; }
  if (gameRunning() || gameDataBusy) return;
  notice('game-data-status');
  try {
    const job = (await runtime()).preloadGameData({language:gameLanguage(), onProgress:progress => { if (preload) { preload.done = progress.done; preload.total = progress.total; renderGameData(); } }});
    preload = {...job, done:0, total:0}; gameDataBusy = true; renderGameData(); updateState();
    await job.done;
  } catch (error) {
    notice('game-data-status', error.code === 'busy' ? t('gameDataBusy') : error.code === 'quota' ? t('gameDataQuota') : fill(t('gameDataFailed'), {message:error.message}));
  } finally { preload = null; gameDataBusy = false; updateState(); await refreshGameData(); }
};
$('delete-game-data').onclick = async () => {
  if (gameRunning() || gameDataBusy || preload) return;
  gameDataBusy = true; notice('game-data-status'); renderGameData();
  try { await (await runtime()).deleteGameData(); notice('game-data-status', t('gameDataDeleted'), true); }
  catch (error) { notice('game-data-status', error.message === 'busy' ? t('gameDataBusy') : error.message); }
  finally { gameDataBusy = false; await refreshGameData(); }
};
$('reset-settings').onclick = () => {
  if (gameRunning()) return;
  settings = defaultSettings(); saveSettings();
  $('resolution').value = settings.resolution; $('audio-enabled').checked = settings.audioEnabled; $('fullscreen-enabled').checked = settings.fullscreen;
  showGraphics(); showFrameRate(); notice('game-data-status', t('settingsReset'), true);
};
$('launch').onclick = () => {
  if ($('launch').disabled) return;
  startupError = ''; interruptedNotice = false; notice('launch-message');
  const [width,height] = settings.resolution.split('x').map(Number);
  const transport = room ?? (server.transport.available ? joinSharedLobby() : null);
  void openGame({runtime:server.runtime, saves:store, transport, language:gameLanguage(), resolution:{width,height}, audioEnabled:settings.audioEnabled, fullscreen:settings.fullscreen, graphicsSettings:{...settings.graphics}, maxFps:settings.fps});
};
$('stop-diagnostic').onclick = stopGame;
$('diagnostic-fullscreen').onclick = () => toggleFullscreen().catch(error => appendLog(`Fullscreen: ${error.message}`));
window.addEventListener('fullscreenchange', updateFullscreen);
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Enter' || event.repeat || gameRunning() || $('changelog').open || event.target.closest('input,select,textarea,button,a,summary,canvas')) return;
  event.preventDefault(); $('launch').click();
});
window.addEventListener('warcraft-session-state', event => {
  phase = event.detail.phase; startupError = event.detail.error || ''; updateState();
  reportPresence();
  if (!gameRunning()) { void updateSaves(); void refreshLobbies(); void refreshGameData(); }
});
$('download-log').onclick = () => download(gameLog() || `Warcraft III\n${JSON.stringify(server, null, 2)}\n`, 'warcraft-last-game.log', 'text/plain');
$('export-saves').onclick = async () => {
  if (saving || gameRunning()) return;
  saving = true; updateState();
  try { download(await store.export(), `warcraft-saves-${new Date().toISOString().slice(0,10)}.json`, 'application/json'); notice('save-status', t('saved'), true); }
  catch (error) { notice('save-status', error.message); }
  finally { saving = false; updateState(); }
};
$('import-saves').onchange = async event => {
  const file = event.target.files[0];
  if (!file || saving || gameRunning()) return;
  saving = true; updateState();
  try {
    if (file.size > 180 * 1024 * 1024) throw Error(t('archiveTooLarge'));
    await store.import(await file.text()); await updateSaves(); notice('save-status', t('restored'), true);
  } catch (error) { notice('save-status', error.message); }
  finally { event.target.value = ''; saving = false; updateState(); }
};
$('create-lobby-form').onsubmit = async event => {
  event.preventDefault(); if (lobbyBusy || gameRunning()) return;
  lobbyBusy = true; notice('lobby-status'); updateState();
  const controller = lobbyCreation = new AbortController();
  try {
    const created = await json('/api/lobbies', {method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:$('lobby-name').value.trim()})});
    if (controller.signal.aborted) return;
    await connectLobby(created.id, true); await refreshLobbies();
  } catch (error) { if (!controller.signal.aborted) notice('lobby-status', error.message); }
  finally { if (lobbyCreation === controller) lobbyCreation = null; lobbyBusy = false; updateState(); }
};
$('join-code-form').onsubmit = event => { event.preventDefault(); void joinLobby($('room-code').value.trim(), false); };
$('leave-lobby').onclick = () => { if (gameRunning()) return; setRoom(null); notice('lobby-status'); void refreshLobbies(); };
$('refresh-lobbies').onclick = () => { notice('lobby-status'); void refreshLobbies(); };
setInterval(() => { if (activeTab === 'online' && !document.hidden && !gameRunning()) void refreshLobbies(); }, 15000);
// Closing the page leaves the lobby and the "Playing now" counts at once.
window.addEventListener('pagehide', () => { lobbyCreation?.abort(); pendingRoom?.close(); room?.close(); presence.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { presence.start(); void refreshLobbies(); } });

presence.addEventListener('change', renderPresence);
presence.start();
language = chosenLanguage ?? await languageSuggestion;
translate();
document.documentElement.removeAttribute('data-pending-language');
void interruptedLaunch.then(value => { interruptedNotice = value && !appleMobile && !gameRunning(); renderNotices(); });
void updateSaves();
try {
  server = await json('/api/status'); phase = 'ready'; renderGameLanguage(); updateState(); void refreshGameData();
  if (activeTab === 'online') void refreshLobbies();
} catch (error) {
  phase = 'error'; startupError = error.message; appendLog(error.message); updateState();
}
