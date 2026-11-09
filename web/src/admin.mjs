const $ = id => document.getElementById(id);
const messages = {
  title:['Управление сессиями','Session management'], site:['На сайт','Back to game'], logout:['Выйти','Sign out'],
  loginTitle:['Вход администратора','Administrator sign in'], password:['Пароль','Password'], login:['Войти','Sign in'],
  playingOnly:['Только в игре','In game only'], refresh:['Обновить','Refresh'],
  explanation:['«В игре» включает загрузку и меню. Отключение закрывает соединение на сервере; обновлённая вкладка также останавливает игру. После обновления страницы посетитель сможет войти снова.',
    'In game includes loading and menus. Disconnect closes the server connection; an up-to-date launcher also stops its game. The visitor can join again after reloading.'],
  confirmTitle:['Завершить сессию?','End this session?'], confirmHint:['Игра остановится, а подключение к лобби закроется. Текущий матч прервётся.',
    'The game will stop and its lobby connection will close. The current match will be interrupted.'],
  cancel:['Отмена','Cancel'], kick:['Отключить','Disconnect'], kicked:['Команда отключения отправлена.','Disconnect command sent.'],
  legacyDisconnected:['Соединение закрыто. Автоподключения старых вкладок этого браузера отклоняются. Уже загруженная одиночная игра может продолжаться.',
    'Connection closed. Automatic reconnects from older tabs in this browser are rejected. An already loaded single-player game may keep running.'],
  confirmLegacy:['Соединение и связанное с ним подключение к лобби закроются. Автоподключения старых вкладок этого браузера будут отклоняться до обновления страницы. Уже загруженная одиночная игра может продолжаться.',
    'This connection and its linked lobby connection will close. Older tabs in this browser will be prevented from reconnecting until reloaded. An already loaded single-player game may keep running.'],
  page:['Вкладка','Page'], inGame:['в игре','in game'], onSite:['на сайте','on site'], lan:['по сети','over LAN'],
  ip:['IP-адрес','IP address'], proxy:['Прокси','Proxy peer'], browser:['Браузер','Browser'], connected:['Подключение','Connected'],
  playingSince:['Игра заявлена с','Game reported since'], lastReport:['Состояние обновлено','Last state report'],
  noSessions:['Нет подходящих подключений.','No matching connections.'], unknown:['Неизвестно','Unknown'],
  oldClient:['Старая вкладка: можно закрыть соединение на сервере, но остановить уже загруженную игру в браузере нельзя.',
    'Older launcher: its server connection can be closed, but an already loaded game cannot be stopped remotely.'],
  counts:['{playing} в игре / {lan} по сети / {online} на сайте','{playing} in game / {lan} over LAN / {online} on site'],
  expired:['Войдите, чтобы продолжить.','Sign in to continue.'], incorrect:['Неверный пароль.','Incorrect password.'],
  rateLimit:['Слишком много попыток входа. Попробуйте через минуту.','Too many login attempts. Try again in a minute.'],
  failed:['Не удалось выполнить запрос.','Request failed.'],
};
let language = /^ru\b/i.test(navigator.language) ? 'ru' : 'en';
try { const saved = localStorage.getItem('wc3-language'); if (['ru','en'].includes(saved)) language = saved; } catch {}
let csrf = null, authenticated = false, snapshot = null, selected = null, busy = false, loading = false, epoch = 0, timer;
let messageKey = null, messageSuccess = false;
const t = key => messages[key]?.[language === 'en' ? 1 : 0] || key;
const element = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
const date = value => value ? new Date(value * 1000).toLocaleString(language === 'en' ? 'en-GB' : 'ru-RU') : '—';
function notice(message = '', success = false) {
  messageKey = Object.keys(messages).find(key => messages[key].includes(message)) || null; messageSuccess = success;
  $('message').textContent = message; $('message').hidden = !message; $('message').classList.toggle('success', success);
}
function signedOut() {
  ++epoch; authenticated = false; csrf = null; snapshot = null; selected = null;
  $('sessions').replaceChildren(); $('counts').textContent = ''; $('kick-dialog').close();
  $('dashboard').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
}
async function request(path, body = undefined) {
  const headers = {'X-W3FT-Admin':'1'};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (csrf) headers['X-CSRF-Token'] = csrf; }
  const response = await fetch(`/api/admin/${path}`, {method:body === undefined ? 'GET' : 'POST', headers,
    credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(10000), ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') { signedOut(); throw new Error(t('expired')); }
    if (response.status === 401) throw new Error(t('incorrect'));
    if (response.status === 429) throw new Error(t('rateLimit'));
    throw new Error((await response.text()).slice(0, 512) || t('failed'));
  }
  return response.json();
}
function render() {
  if (!snapshot || !authenticated) return;
  $('counts').textContent = t('counts').replace(/\{(playing|lan|online)\}/g, (_, key) => snapshot.counts[key]);
  const rows = snapshot.sessions.filter(session => !$('playing-only').checked || session.playing);
  const cards = rows.map(session => {
    const card = element('article', '', 'panel session'), head = element('div', '', 'session-head');
    head.append(element('h2', `${t('page')} #${session.id}: ${t(session.playing ? 'inGame' : 'onSite')}${session.lan ? ` · ${t('lan')}` : ''}`));
    const button = element('button', t('kick'), 'btn danger'); button.type = 'button';
    button.addEventListener('click', () => {
      selected = {id:session.id, generation:snapshot.generation};
      $('kick-target').textContent = `${t('page')} #${session.id} · ${session.ip || t('unknown')}\n${session.userAgent}`;
      $('kick-hint').dataset.text = session.kickSupported ? 'confirmHint' : 'confirmLegacy';
      $('kick-hint').textContent = t($('kick-hint').dataset.text);
      $('kick-dialog').showModal();
    });
    head.append(button); card.append(head);
    const details = element('dl', '');
    for (const [label, value] of [['ip', session.ip], ['proxy', session.peerIp], ['browser', session.userAgent],
      ['connected', date(session.connectedAt)], ['playingSince', date(session.playingSince)], ['lastReport', date(session.lastReportAt)]]) {
      details.append(element('dt', t(label)), element('dd', value || t('unknown')));
    }
    card.append(details);
    if (!session.kickSupported) card.append(element('p', t('oldClient'), 'hint'));
    return card;
  });
  $('sessions').replaceChildren(...(cards.length ? cards : [element('p', t('noSessions'), 'panel hint')]));
}
async function refresh() {
  if (!authenticated || loading || $('kick-dialog').open) return;
  const current = epoch; loading = true; $('refresh').disabled = true;
  try {
    const result = await request('sessions');
    if (current !== epoch || !authenticated) return;
    snapshot = result; render();
  } catch (error) { if (current === epoch || !authenticated) notice(error.message); }
  finally { loading = false; $('refresh').disabled = false; }
}
function translate() {
  document.documentElement.lang = language; $('admin-language').value = language;
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  if (messageKey) notice(t(messageKey), messageSuccess);
  render();
}
$('admin-language').onchange = () => { language = $('admin-language').value; translate(); };
$('playing-only').onchange = render;
$('refresh').onclick = () => { notice(); void refresh(); };
$('login-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; $('login-submit').disabled = true; notice();
  try {
    const result = await request('login', {password:$('password').value});
    ++epoch; csrf = result.csrf; authenticated = true; $('login-panel').hidden = true;
    $('dashboard').hidden = false; $('logout').hidden = false; await refresh();
  } catch (error) { notice(error.message); }
  finally { $('password').value = ''; busy = false; $('login-submit').disabled = false; }
};
$('logout').onclick = async () => {
  if (busy) return; busy = true;
  try { await request('logout', {}); signedOut(); notice(); }
  catch (error) { notice(error.message); }
  finally { busy = false; }
};
$('kick-cancel').onclick = () => $('kick-dialog').close();
$('kick-confirm').onclick = async () => {
  if (busy || !selected) return; busy = true; $('kick-confirm').disabled = true;
  try { const result = await request('kick', selected); notice(t(result.stopRequested ? 'kicked' : 'legacyDisconnected'), true); }
  catch (error) { notice(error.message); }
  finally { $('kick-dialog').close(); selected = null; busy = false; $('kick-confirm').disabled = false; await refresh(); }
};
async function init() {
  try { const result = await request('session'); csrf = result.csrf; authenticated = true;
    $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; await refresh();
  } catch { signedOut(); }
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}
window.addEventListener('pagehide', () => { clearInterval(timer); signedOut(); });
window.addEventListener('pageshow', event => { if (event.persisted) void init(); });
translate(); void init();
