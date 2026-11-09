// How much memory this browser lets the game's page use, step by step as the
// game starts: compile the real module, let the compiler's temporary memory
// go, create the shared memory as the runtime does (64 MB) and grow it in
// 64 MB steps without writing to it (to the build profile's guest window;
// up to 4 GB without the module), then fill it. The last completed step is
// evidence about this run, not a measurement of a fixed browser RAM limit.
// iOS closes a page that outgrows its limit without any error, and the browser
// reloads it: every step is saved before it runs, so the reloaded page tells
// where the last test stopped.
const $ = id => document.getElementById(id);
const KEY = 'wc3-memory-test', STEP = 64, PAGE = 16384, MAX_PAGES = 65520, SETTLE_MS = 8000;
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
    r.targetMB ? `target=${r.targetMB} MB` : '', r.attemptMB ? `attempt=${r.attemptMB} MB` : '',
    r.error ? `error=${r.error}` : '', `mode=${r.mode}`, `v${r.version || 2}`, r.ua].filter(Boolean).join('; ');
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
    $('previous').textContent = t(`Прошлая проверка не закончилась на шаге «${steps[r.step] || r.step}»: выделено ${r.grownMB || 0} МБ, заполнено ${r.filledMB || 0} МБ. Это последний сохранённый результат; возможная причина перезагрузки — нехватка памяти, но точный предел браузера он не определяет.`,
      `The last test did not finish during "${steps[r.step] || r.step}" with ${r.grownMB || 0} MB grown and ${r.filledMB || 0} MB filled. This is the last saved result. Memory pressure may have caused the reload; it does not establish an exact browser memory limit.`);
  }
}

async function run(mode) {
  $('full').disabled = $('memory').disabled = true; $('previous').hidden = true;
  keep = [];
  record = {version:3, mode, ua: navigator.userAgent, started: new Date().toISOString(), filledMB: 0};
  try {
    if (!crossOriginIsolated) throw new Error('crossOriginIsolated is false');
    let initial = 1024, maximum = 65536, pages = MAX_PAGES;
    if (mode === 'full') {
      await save({step: 'compile'});
      const status = await (await fetch('/api/status', {cache: 'no-store'})).json(), started = performance.now();
      const profile = await (await fetch('/runtime/build.json', {cache:'no-store'})).json();
      initial = profile.memory?.initial_pages ?? initial;
      maximum = profile.memory?.maximum_pages ?? maximum;
      pages = Math.ceil(((profile.memory?.guest_base ?? 0x04000000) + (profile.memory?.guest_window ?? 0x80000000) + 16) / 65536);
      await save({targetMB:Math.round(pages / 16), layout:profile.memory?.layout || 'legacy'});
      const tailCalls = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,3,2,0,0,10,11,2,4,0,65,0,11,4,0,18,0,11]));
      const url = !tailCalls && status.runtime.compatWasmUrl || status.runtime.wasmUrl;
      keep.push(await WebAssembly.compileStreaming(fetch(url)));
      await save({compileSeconds: +((performance.now() - started) / 1000).toFixed(1), step: 'settle'});
      await sleep(SETTLE_MS);
    }
    await save({step: 'memory'});
    const memory = new WebAssembly.Memory({initial, maximum, shared: true});
    keep.push(memory);
    await save({step: 'grow', grownMB: 64});
    while (memory.buffer.byteLength / 65536 < pages) {
      const next = Math.min(memory.buffer.byteLength / 65536 + STEP * 16, pages);
      await save({attemptMB:Math.round(next / 16)});
      memory.grow(next - memory.buffer.byteLength / 65536);
      await save({grownMB: Math.round(memory.buffer.byteLength / 1048576), attemptMB:null});
    }
    await save({step: 'fill'});
    const bytes = new Uint8Array(memory.buffer);
    for (let mb = 0; mb + STEP <= bytes.length / 1048576; mb += STEP) {
      for (let at = mb * 1048576; at < (mb + STEP) * 1048576; at += PAGE) bytes[at] = 1;
      await save({filledMB: mb + STEP});
    }
    await save({step: 'done', finished: true});
    $('status').textContent = mode === 'full' ? t(`Проверка закончилась: модуль и ${record.grownMB} МБ памяти. Это ещё не проверка самой игры.`, `The test completed: the module and ${record.grownMB} MB of memory. This does not yet verify gameplay.`)
      : t('Браузер выдержал всё: 4 ГБ памяти.', 'The browser held everything: 4 GB of memory.');
  } catch (error) {
    await save({error: `${error.name}: ${error.message}`});
    $('status').textContent = t('Проверка остановилась с ошибкой.', 'The test stopped with an error.');
  } finally { $('full').disabled = $('memory').disabled = false; }
}

$('title').textContent = t('Проверка памяти', 'Memory test');
$('intro').textContent = t('Для iPhone и iPad: страница компилирует модуль игры, затем выделяет и заполняет память по профилю сборки шагами по 64 МБ. Если проверка прервётся, после перезагрузки здесь будет виден последний сохранённый шаг. Пришлите эту строку разработчику. Для повторной проверки сначала перезагрузите страницу.',
  'For iPhone and iPad: this page compiles the game module, then grows and fills memory in 64 MB steps using the build profile. If the test is interrupted, the last saved step appears after reloading. Send that line to the developer. Reload the page before repeating a test.');
$('full').textContent = t('Проверить с модулем игры', 'Test with the game module');
$('memory').textContent = t('Только память', 'Memory only');
$('copy').textContent = t('Скопировать результат', 'Copy the result');
$('full').onclick = () => run('full');
$('memory').onclick = () => run('memory');
$('copy').onclick = () => navigator.clipboard?.writeText(summary(record || read())).catch(() => {});
const previous = read();
if (previous) { record = previous; render(previous, true); }
$('status').textContent = previous?.finished ? t('Прошлая проверка закончилась целиком.', 'The last test finished completely.') : '';
