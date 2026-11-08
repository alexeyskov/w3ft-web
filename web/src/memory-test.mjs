// How much memory this browser lets the game's page use, step by step as the
// game starts: compile the real module, let the compiler's temporary memory
// go, create the shared memory as the runtime does (64 MB) and grow it in
// 64 MB steps without writing to it (to 2112 MB like wc3_init: the runtime's
// 64 MB and the 2 GB guest window; up to 4 GB without the module), then fill it. A page closed while growing
// means the browser counts memory that was only reserved.
// iOS closes a page that outgrows its limit without any error, and the browser
// reloads it: every step is saved before it runs, so the reloaded page tells
// where the last test stopped.
const $ = id => document.getElementById(id);
const KEY = 'wc3-memory-test', STEP = 64, PAGE = 16384, GUEST_PAGES = (0x04000000 + 0x80000000) / 65536 + 1, MAX_PAGES = 65520, SETTLE_MS = 8000;
const english = (localStorage.getItem('wc3-language') || navigator.language || '').toLowerCase().startsWith('en');
const t = (ru, en) => english ? en : ru;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
let record = null, keep = [];

// Saved before the step it names, then a pause: the storage process has the
// write even if the page is closed during the step.
async function save(fields) {
  record = {...record, ...fields, at: new Date().toISOString()};
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch {}
  render(record, false);
  await sleep(200);
}

function summary(r) {
  if (!r) return '';
  return [`memory-test ${r.finished ? 'finished' : r.error ? 'error' : 'stopped'}: step=${r.step}`,
    r.compileSeconds !== undefined ? `compile=${r.compileSeconds} s` : '', `grown=${r.grownMB || 0} MB`, `filled=${r.filledMB || 0} MB`,
    r.error ? `error=${r.error}` : '', `mode=${r.mode}`, 'v2', r.ua].filter(Boolean).join('; ');
}
const steps = {
  compile: t('компиляция модуля игры', 'compiling the game module'), settle: t('ожидание после компиляции', 'waiting after compiling'),
  memory: t('создание общей памяти игры', 'creating the game\'s shared memory'), grow: t('рост памяти без записи', 'growing memory without writing'),
  fill: t('заполнение памяти', 'filling memory'), done: t('готово', 'done'),
};
function render(r, previous) {
  const lines = r ? [`${t('Шаг', 'Step')}: ${steps[r.step] || r.step}`,
    r.compileSeconds !== undefined ? `${t('Модуль скомпилирован за', 'Module compiled in')} ${r.compileSeconds} s` : '',
    `${t('Выделено без записи', 'Grown without writing')}: ${r.grownMB || 0} MB`,
    `${t('Заполнено', 'Filled')}: ${r.filledMB || 0} MB`, r.error ? `${t('Ошибка', 'Error')}: ${r.error}` : ''].filter(Boolean) : [];
  $('details').textContent = lines.join('\n') + (r ? `\n\n${summary(r)}` : '');
  $('copy').hidden = !r;
  if (previous && r && !r.finished && !r.error) {
    $('previous').hidden = false;
    $('previous').textContent = t(`Прошлая проверка не закончилась: браузер закрыл страницу на шаге «${steps[r.step] || r.step}», выделено ${r.grownMB || 0} МБ, заполнено ${r.filledMB || 0} МБ. Это и есть предел памяти для этого браузера.`,
      `The last test did not finish: the browser closed the page during "${steps[r.step] || r.step}" with ${r.grownMB || 0} MB grown and ${r.filledMB || 0} MB filled. That is this browser's memory limit.`);
  }
}

async function run(mode) {
  $('full').disabled = $('memory').disabled = true; $('previous').hidden = true;
  record = {mode, ua: navigator.userAgent, started: new Date().toISOString(), filledMB: 0};
  try {
    if (!crossOriginIsolated) throw new Error('crossOriginIsolated is false');
    if (mode === 'full') {
      await save({step: 'compile'});
      const status = await (await fetch('/api/status', {cache: 'no-store'})).json(), started = performance.now();
      const tailCalls = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,3,2,0,0,10,11,2,4,0,65,0,11,4,0,18,0,11]));
      const url = !tailCalls && status.runtime.compatWasmUrl || status.runtime.wasmUrl;
      keep.push(await WebAssembly.compileStreaming(fetch(url)));
      await save({compileSeconds: +((performance.now() - started) / 1000).toFixed(1), step: 'settle'});
      await sleep(SETTLE_MS);
    }
    await save({step: 'memory'});
    const memory = new WebAssembly.Memory({initial: 1024, maximum: 65536, shared: true});
    keep.push(memory);
    await save({step: 'grow', grownMB: 64});
    const pages = mode === 'full' ? GUEST_PAGES : MAX_PAGES;
    while (memory.buffer.byteLength / 65536 < pages) {
      memory.grow(Math.min(STEP * 16, pages - memory.buffer.byteLength / 65536));
      await save({grownMB: Math.round(memory.buffer.byteLength / 1048576)});
    }
    await save({step: 'fill'});
    const bytes = new Uint8Array(memory.buffer);
    for (let mb = 0; mb + STEP <= bytes.length / 1048576; mb += STEP) {
      for (let at = mb * 1048576; at < (mb + STEP) * 1048576; at += PAGE) bytes[at] = 1;
      await save({filledMB: mb + STEP});
    }
    await save({step: 'done', finished: true});
    $('status').textContent = mode === 'full' ? t('Браузер выдержал всё: модуль и 2,1 ГБ памяти.', 'The browser held everything: the module and 2.1 GB of memory.')
      : t('Браузер выдержал всё: 4 ГБ памяти.', 'The browser held everything: 4 GB of memory.');
  } catch (error) {
    await save({error: `${error.name}: ${error.message}`});
    $('status').textContent = t('Проверка остановилась с ошибкой.', 'The test stopped with an error.');
  } finally { $('full').disabled = $('memory').disabled = false; }
}

$('title').textContent = t('Проверка памяти', 'Memory test');
$('intro').textContent = t('Для iPhone и iPad: страница повторяет запуск игры, выделяет и заполняет память шагами по 64 МБ. Если браузер закроет и перезагрузит её, после перезагрузки здесь будет видно, сколько памяти он позволил. Пришлите эту строку разработчику.',
  'For iPhone and iPad: the page repeats the game\'s startup, then grows and fills memory in 64 MB steps. If the browser closes and reloads it, this page then shows how much memory it allowed. Send that line to the developer.');
$('full').textContent = t('Проверить с модулем игры', 'Test with the game module');
$('memory').textContent = t('Только память', 'Memory only');
$('copy').textContent = t('Скопировать результат', 'Copy the result');
$('full').onclick = () => run('full');
$('memory').onclick = () => run('memory');
$('copy').onclick = () => navigator.clipboard?.writeText(summary(record || read())).catch(() => {});
const previous = read();
if (previous) { record = previous; render(previous, true); }
$('status').textContent = previous?.finished ? t('Прошлая проверка закончилась целиком.', 'The last test finished completely.') : '';
