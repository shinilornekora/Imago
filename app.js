/**
 * Imago Studio — оболочка AI-first редактора макетов.
 * Человек формулирует задачу, агент строит; ручные инструменты рядом, но необязательны.
 */
import {
  createDoc, applyOps, invertOps, solve, validate, Stage, ops as OPS,
  nodeById, ancestors, isArtboard, artboards, subtreeIds, hashGeometry,
  placeholderName, displayName,
} from './src/core.js';
import * as CORE from './src/core.js';
import { makeProvider, runCommand, runVariants } from './src/brain.js';

/* --------------------------------- состояние --------------------------------- */

const state = {
  doc: null,
  geo: null,
  selection: [],
  history: [],        // {id, ops, inverse, label, who, at, undone}
  cursor: 0,          // сколько транзакций применено
  provider: null,
  providerKind: null,
  running: null,      // AbortController текущей команды
  variants: null,
  variantsBase: null,   // отпечаток документа, по которому считались варианты
  dirty: false,
  chat: [],             // лента реплик агента: {role, text, at, followups}
  pairs: [],            // последние пары «команда — итог» для контекста агента
  busy: false,
  railFocus: null,      // строка рельса, попадающая в табуляцию
  issues: new Map(),    // замечания раскладки из validate: id узла → список (п.5)
  stageGoal: '',
  stageSteps: [],       // что агент собирается сделать: показываем в строке состояния (п.17)
  variantSeen: [],
  collapsed: null,      // свёрнутые ветки рельса (Set)
  sheetTab: 'edits',
  introOpen: false,
  storageWarned: false,
  lastUtterance: '',
  fitAll: false,         // «Вписать» показывает всё (иначе — активный артборд)
  runSeq: 0,             // номер текущего прогона агента: опоздавшие стадии не в счёт
  pendingRun: null,      // команда, ожидающая решения «доделать или заменить»
  queue: [],             // команды, ждущие очереди: голосом их набегает несколько (п.8)
  docRev: 0,             // номер правки: по нему видно, устарела ли запись в хранилище (п.1)
  variantFocus: 0,       // вариант под клавиатурой и под «возьми этот»
  variantPicks: [],      // как взять вариант по номеру
  inspQuiet: false,      // выделил агент: на узком экране лист инспектора не поднимаем
  inspByRail: false,     // инспектор свёрнут ради рельса: закроется рельс — вернётся (п.1)
  inspBySheet: false,    // то же ради шторки: закроется шторка — вернётся (п.1, п.9)
  selectionBy: 'human',  // кто выделил: человек или сам агент после правки (п.19)
  saveBlocked: null,     // {payload, why} — сохранять нельзя, пока человек не решил судьбу копии
  awaitingClarify: null, // переспрос агента: к нему дописывается следующая реплика
  sheetOpen: null,       // какая шторка открыта — её надо обновлять при отмене извне
  lastFit: null,         // чем вписывали вид последний раз: {ids, opts}
  freeBox: null,         // свободная часть холста на момент вписывания
  viewAnchor: null,      // экранная точка и мир под ней: от них считаем пересчёт вида
  userView: false,       // человек сам менял масштаб — без нужды вид не трогаем
  freeArea: 0,           // свободная часть холста на момент последнего вписывания
};

const el = (id) => document.getElementById(id);
const dom = {};
let stage = null;
let db = null;
let downloads = null;
let saveTimer = null;

const SETTINGS_KEY = 'imago.settings.v1';
const LOCAL_DOC_KEY = 'imago.doc.v1';
const BROKEN_DOC_KEY = 'imago.doc.broken.v1';   // копия документа, который не открылся
const BROKEN_DB_PATH = 'docs/broken';           // то же для хранилища артефакта
const SAVE_DELAY = 1200;                        // пауза между правкой и записью
const HISTORY_SAVE_LIMIT = 60;                  // сколько транзакций переживает перезагрузку
const HISTORY_SAVE_BYTES = 900 * 1024;          // и сколько места им отдано

const settings = loadSettings();

/* --------------------------------- загрузка ---------------------------------- */
/* boot() вызывается в самом низу файла: ему нужны константы, объявленные ниже. */

/* Сцена сообщает о сбое объектом {where, error}; бывает и голая ошибка, и строка. */
const STAGE_WHERE = {
  render: 'Не удалось перерисовать холст',
  'screenshot:size': 'Артборд слишком велик для PNG',
  'screenshot:external': 'В PNG не попадают внешние картинки',
  'screenshot:image': 'Не удалось собрать картинку артборда',
  'screenshot:timeout': 'Снимок артборда не успел собраться',
  'screenshot:fonts': 'Шрифты в PNG не встроились',
  'screenshot:toBlob': 'Браузер не отдал картинку артборда',
  'screenshot:blob': 'Картинка артборда не сохранилась',
  toSVG: 'Не удалось собрать SVG артборда',
  undo: 'Отмена с холста не сработала',
};

function stageErrorTitle(e) {
  const where = e && typeof e === 'object' ? e.where : '';
  return (where && STAGE_WHERE[where]) || 'Холст не справился с правкой';
}

function stageErrorNote(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const inner = typeof e === 'object' && 'error' in e ? e.error : e;
  if (!inner) return '';
  if (typeof inner === 'string') return inner;
  return String(inner.message || inner.code || inner);
}

async function boot() {
  cacheDom();
  applyTheme(settings.theme);
  applyRail();
  syncPanelModes();

  state.doc = createDoc();
  state.geo = solve(state.doc);

  stage = new Stage(dom.canvas, {
    onSelect: (ids) => setSelection(ids),
    onCommit: ({ ops, label }) => commit(ops, label || 'Правка', 'human'),
    onUndo: () => undo(),
    onRedo: () => redo(),
    onView: (view) => {
      // масштаб поменял человек, а не мы: дальше его выбор уважаем (п.12)
      if (!viewLock) state.userView = true;
      updateZoomLabel(view);
      // на кнопке видно, вписано сейчас или масштаб ручной (п.18)
      updateFitButton();
      if (dom['empty-state'] && !dom['empty-state'].hidden) renderEmptyState();
    },
    // жест снят из-за правки агента под рукой: раньше узел просто не ехал, и молча (п.28)
    onDragCancel: ({ reason, mode } = {}) => {
      const what = mode === 'resize' ? 'Изменение размера прервано' : 'Перетаскивание прервано';
      const why = /исчез|пропал|удал/i.test(String(reason || ''))
        ? 'узел пропал из документа'
        : 'документ изменился под рукой';
      toast(`${what}: ${why}.`, 'plain', 5000);
    },
    // сообщение о сбое живёт там же, где остальные: в доке, а не тостом сверху (п.15).
    // Сцена отдаёт {where, error}, поэтому разбираем обе формы — иначе в note уезжал [object Object].
    onError: (e) => {
      const where = e && typeof e === 'object' ? e.where : '';
      /* Невстроенные начертания — не авария: снимок сделан, просто текст в нём посчитан
         системным шрифтом и файл может разойтись с экраном (круг 11, п.18). */
      if (where === 'screenshot:fonts') {
        showMsg('warn', 'PNG может разойтись с экраном', { note: stageErrorNote(e), ms: 11000 });
        return;
      }
      /* Круг 16, п.10. PNG отклоняется целиком из-за одной внешней картинки. Сообщение
         честное, но человек остаётся без файла, а выход («сохраните SVG») лежит текстом
         в приписке. Отдать PNG БЕЗ этой картинки оболочка не может: снимок собирает
         Stage, и пропуск недоступной картинки — его решение (в отчёте это записано как
         просьба к ядру). Что оболочка может — не оставлять тупик: рядом с объяснением
         встаёт кнопка, которая делает ровно то, что советует текст. */
      const actions = where === 'screenshot:external'
        ? [{ label: 'Сохранить SVG', primary: true, onClick: () => exportSvg() }]
        : [];
      showMsg('error', stageErrorTitle(e), { note: stageErrorNote(e), actions });
    },
  });

  // холст меняет размер от инспектора, рельса и поворота окна — вид надо пересчитать (п.12)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => scheduleViewRecheck());
    ro.observe(dom.canvas);
    // док растёт от сообщения и ленты стадий, а инспектор на узком экране его поднимает:
    // от этого зависит потолок шторки (п.5)
    const rg = new ResizeObserver(() => syncDockGap());
    for (const n of [dom.dock, dom.inspector, dom.variants]) if (n) rg.observe(n);
  }
  globalThis.addEventListener('resize', () => { syncPanelModes(); syncDockGap(); });
  syncPanelModes();
  syncDockGap();

  hydrateIcons(document);
  bindUi();
  initLiveSize();
  initToastAnchor();
  applyCompact();
  renderAll();
  fitSmart();

  // способности артефакта подключаются асинхронно и могут не прийти вовсе
  initCapabilities();
  initVoice();
  renderHints();

  // первая раскладка считается системным шрифтом; после загрузки гарнитур hug-текст меняет
  // размер, и вся геометрия первого визита неверна на 10–22% (п.32)
  if (typeof CORE.onMeasureEpoch === 'function') {
    // ядро само сбрасывает кеш измерений по document.fonts.ready и зовёт подписчиков
    CORE.onMeasureEpoch(() => scheduleRemeasure({ cacheCleared: true }));
  } else if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => scheduleRemeasure()).catch(() => { /* шрифты не пришли — считаем тем, что есть */ });
  }
}

let measureTimer = null;

/**
 * Гарнитуры приезжают по одной, и на каждую приходит своё событие: без склейки это
 * несколько полных пересчётов и вписываний подряд на старте (п.21). Заодно ждём, пока
 * человек отпустит холст: иначе поздний шрифт дёргает вид под рукой.
 */
function scheduleRemeasure(opts = {}) {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    if (pointerOnCanvas || state.busy) { scheduleRemeasure(opts); return; }
    remeasure(opts);
  }, 120);
}

/** Пересчитать раскладку заново: измерения текста изменились. */
function remeasure(opts = {}) {
  if (!state.doc) return;
  if (!opts.cacheCleared) resetTextMeasure();
  let was = '';
  try { was = hashGeometry(state.geo); } catch { was = ''; }
  const geo = solve(state.doc);
  state.geo = geo;
  // измерения не изменились — ни перерисовки, ни пересчёта вида: на старте таких
  // событий приходит несколько, и каждое стоило полного круга (п.21)
  try { if (was && hashGeometry(geo) === was) return; } catch { /* посчитаем как обычно */ }
  renderAll();
  // если человек к этому моменту сам выбрал масштаб — вид не трогаем
  if (!state.userView) fitSmart();
}

/**
 * Сбросить кеш измерений текста в core: без него solve после загрузки шрифтов отдаёт те же
 * числа. Ядро зовёт сброс само, но если оболочка пересчитывает по своей причине — зовём мы.
 * Имя функции у ядра может отличаться — берём первое подходящее из его экспорта.
 */
const MEASURE_RESETS = [
  'resetMeasureCache', 'clearMeasureCache', 'invalidateMeasureCache', 'resetTextMeasure',
  'clearTextMeasureCache', 'invalidateTextMetrics', 'resetMeasurers', 'resetMeasurer',
  'dropMeasureCache', 'forgetTextMetrics',
];

function resetTextMeasure() {
  for (const name of MEASURE_RESETS) {
    const fn = CORE && CORE[name];
    if (typeof fn !== 'function') continue;
    try { fn(); return true; } catch { /* попробуем следующее имя */ }
  }
  return false;
}

/* ---------------------------------- иконки ----------------------------------- */

/** Один набор: 16×16, штрих 1.5, без заливки — чтобы линии читались как родня. */
const ICONS = {
  layers: '<path d="M8 2 2 5.5 8 9l6-3.5L8 2Z"/><path d="M2 10.5 8 14l6-3.5"/>',
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  export: '<path d="M8 2.5v7"/><path d="M5 7l3 3 3-3"/><path d="M2.75 11.5v1.25h10.5V11.5"/>',
  // сплошной полукруг выбивался из набора, где всё остальное — линии одной толщины (п.16)
  theme: '<circle cx="8" cy="8" r="6"/><path d="M8 2.1v11.8"/><path d="M10.1 5.6h2.3"/><path d="M10.7 8h2.5"/><path d="M10.1 10.4h2.3"/>',
  settings: '<path d="M2.5 4.5h11"/><path d="M2.5 11.5h11"/><circle cx="6" cy="4.5" r="1.9"/><circle cx="10.5" cy="11.5" r="1.9"/>',
  close: '<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>',
  plus: '<path d="M8 3.5v9"/><path d="M3.5 8h9"/>',
  'artboard-add': '<rect x="2" y="2.75" width="8.5" height="10.5" rx="1.5"/><path d="M13 8.5v4.75"/><path d="M10.6 10.9h4.8"/>',
  mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.75 7.5A4.25 4.25 0 0 0 12.25 7.5"/><path d="M8 11.75V14"/>',
  'chevron-left': '<path d="M9.75 3.5 5.25 8l4.5 4.5"/>',
  'chevron-right': '<path d="M6.25 3.5 10.75 8l-4.5 4.5"/>',
  'chevron-down': '<path d="M3.5 6.25 8 10.75l4.5-4.5"/>',
  'arrow-down': '<path d="M8 2.5v11"/><path d="M3.5 9 8 13.5 12.5 9"/>',
  check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
  undo: '<path d="M6 3.5 2.5 7 6 10.5"/><path d="M2.5 7h6.75A3.75 3.75 0 0 1 13 10.75V13"/>',
  refresh: '<path d="M13 7A5 5 0 1 0 12 11"/><path d="M13 3.5V7h-3.5"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  alert: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><path d="M8 10.8v.2"/>',
  ask: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3A1.8 1.8 0 0 1 9.7 7c0 1.2-1.7 1.4-1.7 2.6"/><path d="M8 11.6v.2"/>',
  spark: '<path d="M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8l4.1-1.4L8 2.5Z"/>',
  node: '<rect x="3" y="3" width="10" height="10" rx="2"/>',
};

function iconMarkup(name) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Подставить SVG во все <span class="i" data-icon="..."> внутри корня. */
function hydrateIcons(root) {
  for (const holder of root.querySelectorAll('span.i[data-icon]')) {
    if (holder.firstChild) continue;
    holder.innerHTML = iconMarkup(holder.dataset.icon);
  }
}

/** Иконка отдельным элементом — для того, что собирается в коде. */
function iconEl(name) {
  const s = document.createElement('span');
  s.className = 'i';
  s.dataset.icon = name;
  s.innerHTML = iconMarkup(name);
  return s;
}

function cacheDom() {
  for (const id of [
    'app', 'canvas', 'layers', 'rail', 'inspector', 'insp-body', 'insp-title',
    'commandbar', 'command', 'btn-run', 'btn-variants', 'btn-mic', 'mic-live', 'stagebar',
    'stage-label', 'stage-detail', 'stage-steps', 'btn-stage-stop', 'variants', 'hints', 'toasts',
    'artboard-tabs', 'docname', 'sheet', 'sheet-body', 'sheet-title', 'sheet-tabs',
    'btn-zoom', 'btn-zoom-in', 'btn-zoom-out', 'btn-fit', 'btn-rail', 'btn-rail-close', 'scrim',
    'btn-history', 'btn-export', 'btn-theme', 'btn-settings', 'btn-add-artboard',
    'btn-insp-close', 'btn-sheet-close', 'btn-new-artboard', 'btn-empty-artboard',
    'dockmsg', 'dockmsg-text', 'dockmsg-note', 'dockmsg-issue', 'dockmsg-chips', 'dockmsg-actions', 'btn-msg-close',
    'empty-state', 'empty-title', 'empty-sub', 'empty-examples', 'dock', 'viewbar',
    'peekbar', 'peekbar-text', 'agent-dot',
  ]) dom[id] = el(id);
  dom.dockmsg.setAttribute('role', 'status');
  dom.dockmsg.setAttribute('aria-live', 'polite');
  dom.stagebar.setAttribute('role', 'status');
  dom.stagebar.setAttribute('aria-live', 'polite');
}

/* ------------------------------- способности --------------------------------- */

async function initCapabilities() {
  const use = globalThis.claude && typeof globalThis.claude.use === 'function'
    ? globalThis.claude.use.bind(globalThis.claude) : null;

  if (use) {
    try {
      const sample = await use('sample');
      if (sample) {
        // держим провайдера Claude отдельно: если человек уйдёт на LM Studio, вернуться
        // должно быть чем — иначе единственным выходом остаётся перезагрузка (п.3)
        claudeProvider = makeProvider({ kind: 'claude', sample });
        state.provider = claudeProvider;
        state.providerKind = 'claude';
        setRunnable(true);
      }
    } catch { /* способность недоступна — остаёмся на локальном провайдере */ }
    try { db = await use('db'); } catch { db = null; }
    try { downloads = await use('downloads'); } catch { downloads = null; }
  }

  if (!state.provider && settings.lmstudio.enabled) useLmStudio();
  if (!state.provider) setRunnable(false);

  const restored = db ? await restoreFromDb() : await restoreFromLocal();
  maybeShowIntro(restored);
}

/**
 * Первый запуск: ни сохранённого документа, ни отметки в настройках.
 * Одно сообщение в доке — тезис продукта и два примера; больше оно не появится (п.12).
 */
function maybeShowIntro(restored) {
  // разговор о непрочитанном документе важнее знакомства — и перекрывать его нельзя (п.2)
  if (restored || settings.introSeen || state.saveBlocked) return;
  settings.introSeen = true;
  saveSettings();
  const voice = dom['btn-mic'] && !dom['btn-mic'].disabled;
  state.introOpen = true;
  showMsg('answer', 'Скажите, что построить, — агент соберёт макет и покажет, что сделал.', {
    intro: true,
    note: voice
      ? 'Голосом: кнопка с микрофоном или клавиша V. Любую правку агента можно отменить одной кнопкой.'
      : 'Любую правку агента можно отменить одной кнопкой.',
    chips: EMPTY_EXAMPLES.slice(0, isNarrow() ? 2 : 3).map((ex) => ({
      text: ex,
      onClick: () => { dom.command.value = ex; dom.command.focus(); },
    })),
  });
  // карточка знакомства высокая: без пересчёта она накрывала низ артборда на ~48 px (п.15)
  fitSmart();
  renderHints();
}

/** Провайдер Claude этой страницы: к нему возвращает кнопка «Вернуться к Claude» (п.3). */
let claudeProvider = null;

function lmStudioProvider() {
  return makeProvider({
    kind: 'lmstudio',
    baseUrl: settings.lmstudio.baseUrl,
    model: settings.lmstudio.model,
  });
}

function useLmStudio() {
  state.provider = lmStudioProvider();
  state.providerKind = 'lmstudio';
  setRunnable(true);
}

/** Вернуть агента на Claude: способность у страницы есть, и путь назад должен быть виден. */
function useClaude() {
  if (!claudeProvider) return false;
  state.provider = claudeProvider;
  state.providerKind = 'claude';
  settings.lmstudio.enabled = false;
  saveSettings();
  setRunnable(true);
  return true;
}

/** Знак слева от слова «Imago»: подключён агент или нет и работает ли он сейчас (п.14). */
const AGENT_KIND_WORDS = { claude: 'Claude', lmstudio: 'LM Studio' };

function updateAgentDot() {
  const dot = dom['agent-dot'];
  if (!dot) return;
  const kind = AGENT_KIND_WORDS[state.providerKind] || 'модель';
  const st = !state.provider ? 'off' : (state.busy ? 'busy' : 'ready');
  const words = {
    off: 'Агент не подключён — откройте настройки',
    ready: `Агент подключён: ${kind}`,
    busy: `Агент работает: ${kind}`,
  }[st];
  dot.dataset.state = st;
  dot.title = words;
  dot.setAttribute('aria-label', words);
}

function setRunnable(ok) {
  dom['btn-run'].disabled = !ok && !state.busy;
  paintRunButton();
  dom['btn-variants'].disabled = !ok || state.busy;
  updateAgentDot();
  // длинный пример обрезался на полуслове — примеры живут в чипах-подсказках
  dom.command.placeholder = ok
    ? (isNarrow() ? 'Что построить?' : 'Что построить или изменить?')
    : 'Агент не подключён — откройте настройки';
}

/** Текст ошибки применения: по новому контракту core отдаёт {code, message}, раньше — строку. */
function opError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.code || 'причина не названа';
}

/* --------------------------------- история ----------------------------------- */

/** Применить операции как одну транзакцию. */
function commit(opsList, label, who = 'human', extra = {}) {
  // на холсте мог стоять предпросмотр варианта: правка ложится в документ, и холст
  // обязан показывать документ (п.1)
  unpeekVariant();
  if (!opsList || !opsList.length) return { ok: true, empty: true };
  const prevDoc = state.doc;
  const inverse = invertOps(state.doc, opsList);
  const res = applyOps(state.doc, opsList);
  if (res.error) {
    showMsg('error', `Не удалось применить правку: ${opError(res.error)}`);
    return { ok: false, error: res.error };
  }
  const prevGeo = state.geo;
  state.doc = res.doc;
  state.geo = solve(state.doc);

  state.history.length = state.cursor;
  const tx = {
    id: txId(), kind: 'ops',
    ops: opsList, inverse, label, who, at: Date.now(), undone: false,
    human: describeOps(opsList, prevDoc), ...extra,
  };
  state.history.push(tx);
  state.cursor = state.history.length;
  // ручная правка не снимает предложение отменить работу агента (п.11):
  // человек правит параллельно и всё равно вправе откатить агента — вопросом «было ещё N правок»
  if (who === 'agent') dropUndoOffer();

  const diff = diffOf(opsList, prevGeo);
  const hadIssues = state.issues;
  renderAll({ diff, prevGeo });
  // о сломанной раскладке говорим, только когда её сломали руками: итог команды агенту
  // и так подписан, и второй голос поверх него — шум (п.5)
  if (who === 'human') announceIssues(freshIssues(hadIssues, state.issues));
  if (who === 'human' && !extra.quiet) announceHuman(tx, diff);
  scheduleSave();
  refreshSheet();
  return { ok: true, tx, diff };
}

/** С какого числа затронутых узлов ручная правка считается крупной. */
const LOUD_NODES = 4;

/**
 * Ручная правка вслух. Поток мелких правок сообщениями не сопровождаем: человек тянул
 * узел или крутил число — результат у него перед глазами, а отмена лежит на Ctrl+Z.
 * Но удаление видно плохо (узел просто исчез), а стоит дорого; крупная перестройка —
 * тоже. О них говорим фактом правки и даём «Отменить» (п.5).
 */
function announceHuman(tx, diff) {
  const removed = ((diff && diff.removed) || []).length;
  const touched = removed
    + ((diff && diff.created) || []).length
    + ((diff && diff.changed) || []).length;
  if (!removed && touched < LOUD_NODES) return;
  showMsg('plain', tx.human || tx.label || 'Правка', {
    note: removed
      ? `${removed === 1 ? 'Узел удалён' : 'Узлы удалены'} — вернуть можно здесь или по Ctrl+Z.`
      : 'Вернуть можно здесь или по Ctrl+Z.',
    actions: [{ label: 'Отменить', onClick: () => undoTx(tx.id) }],
    undoTx: tx.id,
    ms: 9000,
  });
}

function txId() {
  return `tx_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/**
 * Заменить документ целиком — и всё равно как транзакция: с шагом в истории и «Отменить».
 * Импорт раньше стирал документ и историю без возврата, а предупреждал серой строкой (п.1).
 */
function commitDoc(nextDoc, nextGeo, label, humanText, who = 'human') {
  const before = state.doc;
  // версия приходит из файла и бывает любой — вплоть до меньшей, чем текущая. Проверка
  // «документ изменился, пока агент работал» опирается на неё, поэтому версию выдаём
  // сами и только вверх; заодно у документа меняется id — сверяем и его (п.4)
  const doc = { ...nextDoc, version: Math.max(Number(nextDoc.version) || 0, (Number(before && before.version) || 0) + 1) };
  state.doc = doc;
  state.geo = nextGeo || solve(doc);
  state.history.length = state.cursor;
  const tx = {
    id: txId(), kind: 'doc', ops: [], inverse: [],
    docBefore: before, docAfter: doc,
    label, who, at: Date.now(), undone: false, human: humanText || label,
  };
  state.history.push(tx);
  state.cursor = state.history.length;
  const hadIssues = state.issues;
  renderAll();
  if (who === 'human') announceIssues(freshIssues(hadIssues, state.issues));
  scheduleSave();
  refreshSheet();
  return { ok: true, tx };
}

/**
 * Один шаг истории. quiet — для перемотки: там не нужны ни двадцать перерисовок,
 * ни двадцать сообщений подряд (п.19).
 */
/**
 * Отпечаток документа: версия сама по себе не годится — импорт подставляет её из файла,
 * и после него номер может оказаться прежним или меньше (п.4).
 */
function docStamp(doc) {
  return `${(doc && doc.id) || '?'}:${Number(doc && doc.version) || 0}`;
}

function stepHistory(back, { quiet = false } = {}) {
  if (back ? state.cursor === 0 : state.cursor >= state.history.length) return false;
  const tx = back ? state.history[state.cursor - 1] : state.history[state.cursor];
  const what = back ? 'Отмена' : 'Повтор';
  if (tx.kind === 'doc') {
    const wanted = back ? tx.docBefore : tx.docAfter;
    let taken = null;
    try { taken = adoptDoc(wanted); } catch (e) { taken = null; }
    if (!taken) { showMsg('error', `${what} не удался: сохранённый документ не открывается.`); return false; }
    state.doc = taken.doc; state.geo = taken.geo;
    state.selection = [];
    state.collapsed = null;
  } else {
    const res = applyOps(state.doc, back ? tx.inverse : tx.ops);
    if (res.error) { showMsg('error', `${what} не удался: ${opError(res.error)}`); return false; }
    state.doc = res.doc; state.geo = solve(state.doc);
  }
  tx.undone = back;
  state.cursor += back ? -1 : 1;
  dropUndoOffer();
  if (!quiet) { renderAll(); scheduleSave(); refreshSheet(); }
  return true;
}

function undo() {
  const tx = state.history[state.cursor - 1];
  if (!stepHistory(true)) return false;
  // «Отменено: Заглушка: edit» — двойное двоеточие; факт правки точнее имени намерения (п.13)
  showMsg('plain', `Отменено — ${tx.human || tx.label}`, {
    transient: true,
    actions: [{ label: 'Вернуть', onClick: () => redo() }],
  });
  return true;
}

/**
 * Возврат отвечает тем же, чем отмена. Раньше «Вернуть» молчал, а в доке продолжало
 * висеть «Отменено — …» с живой кнопкой: правка уже применена, а подпись уверяет в
 * обратном (круг 13, п.3). Сообщение помечено transient — следующий шаг истории снимает
 * его сам, через dropUndoOffer.
 */
function redo() {
  const tx = state.history[state.cursor];
  if (!stepHistory(false)) return false;
  const what = tx && (tx.human || tx.label);
  showMsg('plain', what ? `Вернул — ${what}` : 'Вернул правку', {
    transient: true,
    actions: [{ label: 'Отменить', onClick: () => undo() }],
  });
  return true;
}

/** Отмена конкретной транзакции — той, о которой человеку сказали, а не вершины стека. */
function undoTx(txId) {
  const i = state.history.findIndex((t) => t.id === txId);
  if (i < 0 || i >= state.cursor) { hideMsg(); return; }
  const above = state.cursor - i - 1;
  if (above > 0) {
    const more = above === 1
      ? 'После этой правки была ещё одна правка.'
      : `После этой правки было ещё ${above} ${plural(above, 'правка', 'правки', 'правок')}.`;
    showMsg('question', more, {
      note: 'Отменить можно только вместе с ними.',
      actions: [
        { label: `Откатить ${above + 1}`, primary: true, onClick: () => { gotoHistory(i); } },
        { label: 'Оставить', onClick: hideMsg },
      ],
    });
    return;
  }
  undo();
}

/**
 * Что изменилось — для подсветки и анимации.
 * Рамкой отмечаем ровно то, что названо в операциях: при смене зазора съезжает половина
 * макета, и обводить эту половину — значит соврать про объём правки (п.2).
 * Уехавшие соседи уходят отдельным списком `moved`: сцена вправе их переставить плавно,
 * но рамки им не положено.
 */
function diffOf(opsList, prevGeo) {
  const born = new Map();
  const created = [], changed = [], removed = [], moved = [];
  for (const op of opsList) if (op.op === 'create' && op.node) born.set(op.node.id, op.node.parent);
  for (const op of opsList) {
    // из созданного поддерева рамку получает только его вершина: пять вложенных рамок
    // вокруг одной добавленной карточки — это не «что изменилось», а шум
    if (op.op === 'create' && op.node) { if (!born.has(op.node.parent)) created.push(op.node.id); }
    else if (op.op === 'remove' && op.id) removed.push(op.id);
    else if ((op.op === 'set' || op.op === 'move') && op.id) changed.push(op.id);
  }
  const named = new Set([...born.keys(), ...changed, ...removed]);
  if (prevGeo && state.geo && state.geo.rects) {
    for (const id of Object.keys(state.geo.rects)) {
      if (named.has(id)) continue;
      const a = prevGeo.rects[id], b = state.geo.rects[id];
      if (a && b && (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)) moved.push(id);
    }
  }
  return {
    created: [...new Set(created)],
    changed: [...new Set(changed)].filter((id) => !created.includes(id)),
    removed: [...new Set(removed)],
    moved,
  };
}

/* --------------------------- человеческие описания --------------------------- */

/** Путь свойства → слово, которым его зовут в интерфейсе. */
const PROP_NAMES = {
  'layout.gap': 'Зазор', 'layout.padding': 'Отступ', 'layout.mode': 'Поток',
  'layout.align': 'Выравнивание', 'layout.justify': 'Распределение', 'layout.wrap': 'Перенос',
  'style.token': 'Стиль текста', 'style.fontSize': 'Кегль', 'style.fontWeight': 'Жирность',
  'size.w': 'Ширина', 'size.h': 'Высота',
  characters: 'Текст', name: 'Имя', align: 'Выключка', fill: 'Заливка', color: 'Цвет текста',
  radius: 'Скругление', opacity: 'Прозрачность', visible: 'Видимость', locked: 'Замок',
  override: 'Положение', pos: 'Положение', style: 'Стиль текста', layout: 'Раскладка', size: 'Размер',
  /* Круг 16, п.5. Из 13 полей, которые brain вообще разрешает модели (ALLOWED_PATH_HEADS),
     трёх в словаре не было вовсе — и propName() отдавал путь как есть, а describeOps ставил
     его первым словом с большой буквы: «Stroke акцент в «Аватар»», «Clip да в «Карточка»»,
     «Поля «src» у эллипса «Аватар» нет». Теперь закрыты все 13 и их вложенные пути. */
  stroke: 'Обводка', clip: 'Обрезка', src: 'Источник',
  'stroke.color': 'Цвет обводки', 'stroke.width': 'Толщина обводки',
  'style.lineHeight': 'Интерлиньяж', 'style.letterSpacing': 'Трекинг', 'style.font': 'Гарнитура',
  letterSpacing: 'Трекинг', lineHeight: 'Интерлиньяж', font: 'Гарнитура',
  width: 'Толщина',
  // те же вещи без приставки: в предупреждениях агента путь приходит и коротким —
  // «padding.t», «gap». Без этих ключей человек читал «padding.t 10» (п.9)
  gap: 'Зазор', padding: 'Отступ', mode: 'Поток', justify: 'Распределение', wrap: 'Перенос',
  fontSize: 'Кегль', fontWeight: 'Жирность', token: 'Стиль текста', w: 'Ширина', h: 'Высота',
};

/** Сторона отступа словами: «padding.t» — это «отступ сверху», а не «padding.t». */
const SIDE_WORDS = { t: 'сверху', r: 'справа', b: 'снизу', l: 'слева' };

/* Русские подписи значений. Таблицы ОДНИ И ТЕ ЖЕ для инспектора и для строки агента:
   пока их было две, «Распред.» в панели стояло «в начало», а в отчёте агента то же
   значение читалось «по началу», и жирность панель называла «полужирная», а отчёт —
   «600» (круг 16, хвост, п.2). Держим их здесь, рядом со словарём имён свойств, чтобы
   расхождение было видно глазами. */
const MODE_LABELS = { column: 'столбец', row: 'строка', none: 'свободно' };
const TEXT_ALIGN_LABELS = { left: 'левая', center: 'по центру', right: 'правая' };
const ALIGN_LABELS = { start: 'по началу', center: 'по центру', end: 'по концу', stretch: 'растянуть' };
const JUSTIFY_LABELS = { start: 'в начало', center: 'по центру', end: 'в конец', between: 'с промежутками' };
const WEIGHT_LABELS = { 400: 'обычная', 500: 'средняя', 600: 'полужирная', 700: 'жирная' };
const TYPE_LABELS = {
  display: 'крупный', title: 'заголовок', heading: 'подзаголовок', body: 'текст',
  caption: 'подпись', mono: 'моноширинный', monoLg: 'моноширинный крупный',
};

/* Режим размера зависит от ОСИ: «занять остаток» не говорит, что именно займёт, а мозг
   в своих предупреждениях давно пишет «во всю ширину» / «во всю высоту». Сходимся на
   его словах (круг 16, хвост, п.1). SIZE_LABELS остаётся только как запасной вариант
   для мест, где ось неизвестна, — в отчёте и в инспекторе она известна всегда. */
const SIZE_LABELS_W = { fixed: 'фикс.', hug: 'по содержимому', fill: 'во всю ширину' };
const SIZE_LABELS_H = { fixed: 'фикс.', hug: 'по содержимому', fill: 'во всю высоту' };
const SIZE_LABELS = { fixed: 'фикс.', hug: 'по содержимому', fill: 'занять остаток' };
const sizeLabels = (axis) => (axis === 'h' ? SIZE_LABELS_H : axis === 'w' ? SIZE_LABELS_W : SIZE_LABELS);

/** Путь свойства → таблица его значений. Ею печатают и поле панели, и строку агента. */
const VALUE_TABLES = {
  align: TEXT_ALIGN_LABELS,
  'layout.mode': MODE_LABELS,
  'layout.align': ALIGN_LABELS,
  'layout.justify': JUSTIFY_LABELS,
  'style.fontWeight': WEIGHT_LABELS,
  fontWeight: WEIGHT_LABELS,
  'size.w': SIZE_LABELS_W,
  'size.h': SIZE_LABELS_H,
};

/** Значения, у которых в интерфейсе есть русское имя (когда путь неизвестен). */
const VALUE_WORDS = {
  ...MODE_LABELS, ...ALIGN_LABELS, ...TEXT_ALIGN_LABELS, ...SIZE_LABELS,
};

function propName(path) {
  const p = String(path || '');
  if (PROP_NAMES[p]) return PROP_NAMES[p];
  const head = p.split('.').slice(0, 2).join('.');
  if (PROP_NAMES[head]) return PROP_NAMES[head];
  const parts = p.split('.');
  if (PROP_NAMES[parts[0]]) return PROP_NAMES[parts[0]];
  // «style.lineHeight» и прочее незнакомое: последний сегмент всё же может быть знакомым
  if (PROP_NAMES[parts[parts.length - 1]]) return PROP_NAMES[parts[parts.length - 1]];
  return p || 'Свойство';
}

/**
 * Технический путь свойства → слово, которым его зовёт инспектор: «layout.gap» → «Зазор»,
 * «padding.t» → «Отступ сверху». Одни и те же вещи в разных местах должны звучать
 * одинаково, иначе человек не связывает предупреждение агента с полем инспектора (п.9).
 */
function humanPath(path) {
  const p = String(path || '').trim().replace(/^\.+|\.+$/g, '');
  if (!p) return '';
  const parts = p.split('.');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && SIDE_WORDS[last]) {
    return `${propName(parts.slice(0, -1).join('.'))} ${SIDE_WORDS[last]}`;
  }
  return propName(p);
}

/* Пути, которые встречаются в словах агента. Длинные раньше коротких: «layout.padding.t»
   должен победить «padding». */
const TECH_PATHS = [
  'layout.padding.t', 'layout.padding.r', 'layout.padding.b', 'layout.padding.l',
  'layout.gap', 'layout.mode', 'layout.align', 'layout.justify', 'layout.wrap', 'layout.padding',
  'style.fontSize', 'style.fontWeight', 'style.token', 'style.lineHeight',
  'style.letterSpacing', 'style.font',
  'stroke.color', 'stroke.width',
  'size.w', 'size.h', 'padding.t', 'padding.r', 'padding.b', 'padding.l',
  'padding', 'gap', 'radius', 'opacity', 'fontSize', 'fontWeight', 'characters',
  /* Круг 16, п.5: остальные разрешённые поля и их короткие формы. Раньше человек читал
     ««Шапка»: «fill» и так нет», ««Дата»: «color» уже «muted»», «свои «жирность»,
     letterSpacing». Слева граница слова: «textstyle» не должен превращаться
     в «text«стиль текста»». */
  'stroke', 'clip', 'src', 'fill', 'color', 'align', 'style', 'name',
  'letterSpacing', 'lineHeight', 'visible', 'locked', 'layout', 'size',
];
const TECH_PATH_RE = new RegExp(`(?<![\\w.])(?:${TECH_PATHS.map((p) => p.replace(/\./g, '\\.')).join('|')})(?![\\w.])`, 'g');

/** Пути в человеческой реплике — словами инспектора. Внутри «…» и без них (п.9). */
function humanizePaths(text) {
  let s = String(text == null ? '' : text);
  if (!/[a-z]/.test(s)) return s;
  /* Круг 16, п.5. Сначала пара «путь» + значение: ««Дата»: «color» уже «muted»» —
     чинить только путь мало, рядом остаётся внутренний код значения. */
  s = s.replace(/«([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*)»(\s+(?:уже|и так|стоит)\s+)«([^»]{1,40})»/g,
    (all, p, mid, val) => {
      const word = humanPath(p);
      if (!word || word === p) return all;
      const own = VALUE_TABLES[p];
      const v = (own && own[val]) || SWATCH_NAMES[val] || TYPE_LABELS[val] || VALUE_WORDS[val] || val;
      return `«${word.toLowerCase()}»${mid}«${v}»`;
    });
  // путь в кавычках — и с точкой, и коротким: «layout.gap» и «fill» одинаково
  s = s.replace(/«([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*)»/g, (all, p) => {
    const word = humanPath(p);
    return word && word !== p ? `«${word.toLowerCase()}»` : all;
  });
  s = s.replace(TECH_PATH_RE, (p) => {
    const word = humanPath(p);
    return word && word !== p ? `«${word.toLowerCase()}»` : p;
  });
  return s;
}

function nodeTitle(node, doc) {
  return node ? String(displayName(doc || state.doc, node) || 'узел') : '';
}
function nodeTitleById(doc, id) {
  const n = id && doc && doc.nodes ? doc.nodes[id] : null;
  return n ? nodeTitle(n, doc) : '';
}

/**
 * Значение свойства словами: числа как есть, режимы и токены — по-русски.
 * @param {*} value
 * @param {'w'|'h'} [axis] ось размера: от неё зависит, «во всю ширину» или «во всю высоту».
 */
function humanValue(value, axis) {
  if (value === undefined || value === null) return 'не задано';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'string') {
    return (axis && sizeLabels(axis)[value]) || VALUE_WORDS[value] || SWATCH_NAMES[value]
      || TYPE_LABELS[value] || (value.length > 36 ? `${value.slice(0, 34)}…` : value);
  }
  if (Array.isArray(value)) return value.map((v) => humanValue(v, axis)).join(', ');
  if (typeof value === 'object') {
    if (typeof value.t === 'number') {
      const { t, r, b, l } = value;
      return (t === r && r === b && b === l) ? String(t) : `${t}/${r}/${b}/${l}`;
    }
    /* Круг 16, п.4. Токен приходит и строкой («display»), и объектом ({token:'display'}) —
       ядро приводит одно к другому. Слово человеку обязано быть одним и тем же, иначе
       describeSet печатает «display → крупный» как разницу там, где разницы нет. */
    if (value.token) return SWATCH_NAMES[value.token] || TYPE_LABELS[value.token] || String(value.token);
    /* Обводка: «line» и {color:'line', width:1} — одна и та же обводка. Толщину называем
       только тогда, когда она не единичная, иначе формы опять разойдутся словами. */
    if (value.color !== undefined) {
      const c = humanValue(value.color);
      const w = Number(value.width);
      return Number.isFinite(w) && w !== 1 ? `${c}, ${w} px` : c;
    }
    if (value.mode) {
      return value.mode === 'fixed'
        ? String(Math.round(Number(value.value) || 0))
        : (sizeLabels(axis)[value.mode] || value.mode);
    }
    if (typeof value.fontSize === 'number') return String(value.fontSize);
    // положение: без этой ветки первая правка pos печаталась без значения вовсе (п.31)
    if (typeof value.x === 'number' || typeof value.y === 'number') {
      return `${Math.round(Number(value.x) || 0)}, ${Math.round(Number(value.y) || 0)}`;
    }
  }
  return '';
}

function sameValue(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/* Круг 16, п.5. Род названия свойства: без него выходит «Обводка не задано» и
   «Обрезка да». Значение по умолчанию — средний род, как было раньше. */
const PROP_GENDER = {
  Обводка: 'f', Обрезка: 'f', Заливка: 'f', Ширина: 'f', Высота: 'f', Прозрачность: 'f',
  Видимость: 'f', Жирность: 'f', Гарнитура: 'f', Выключка: 'f', Раскладка: 'f',
  'Толщина обводки': 'f',
  Отступ: 'm', Зазор: 'm', Поток: 'm', Замок: 'm', 'Цвет текста': 'm', 'Цвет обводки': 'm',
  'Стиль текста': 'm', Источник: 'm', Кегль: 'm', Трекинг: 'm', Интерлиньяж: 'm',
  Размер: 'm', Перенос: 'm', Текст: 'm',
};
const notSetWord = (label) => ({ f: 'не задана', m: 'не задан' }[PROP_GENDER[label]] || 'не задано');
const boolWord = (label, on) => {
  if (label === 'Замок') return on ? 'поставлен' : 'снят';
  const g = PROP_GENDER[label];
  return on
    ? ({ f: 'включена', m: 'включён' }[g] || 'включено')
    : ({ f: 'выключена', m: 'выключен' }[g] || 'выключено');
};

/** «Зазор 16 → 24»: внутри объекта находим тот ключ, который действительно поменялся. */
function describeSet(op, doc, born) {
  // узла, созданного этой же транзакцией, в документе ДО неё нет: берём его из операции,
  // иначе правка печаталась без имени — «Зазор 24» вместо «Зазор 24 в «Карточка»» (п.18)
  const node = nodeById(doc, op.id) || (born && born.get(op.id)) || null;
  let path = String(op.path || '');
  let before = readPath(node, path);
  let after = op.value;
  if (before && after && typeof before === 'object' && typeof after === 'object'
      && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => !sameValue(before[k], after[k]));
    if (keys.length === 1) { path = `${path}.${keys[0]}`; before = before[keys[0]]; after = after[keys[0]]; }
  }
  const label = propName(path);
  /* Круг 16, хвост, п.1–2. Значение печатаем ТОЙ ЖЕ таблицей, которой подписано поле
     панели (VALUE_TABLES), и с оглядкой на ось размера: «занять остаток» не говорило,
     что именно займёт, а мозг в своих строках пишет «во всю ширину» / «во всю высоту». */
  /* Путь к этому месту мог сузиться до изменившегося ключа («size.w» → «size.w.mode»),
     поэтому и ось, и таблицу ищем так же, как propName ищет имя: по началу пути. */
  const axisM = /(^|\.)size\.(w|h)(\.|$)/.exec(path);
  const axis = axisM ? axisM[2] : '';
  const head = path.split('.').slice(0, 2).join('.');
  const table = VALUE_TABLES[path] || VALUE_TABLES[head] || null;
  const word = (v) => {
    if (v === undefined || v === null) return notSetWord(label);
    if (table && table[v] !== undefined) return table[v];
    return humanValue(v, axis);
  };
  const to = word(after);
  // у узла в потоке положения не было: «было → стало» без первой половины непонятно (п.31)
  const wasFree = before === undefined && /^(pos|override)$/.test(path);
  const from = wasFree ? 'по потоку' : (before === undefined ? '' : word(before));
  let value = from && from !== to ? `${from} → ${to}` : to;
  /* Круг 16, п.5: «Обрезка да» — не по-русски, и «было → стало» для переключателя лишнее:
     человеку важно, ВКЛЮЧЕНО ли оно теперь. */
  if (typeof after === 'boolean') value = boolWord(label, after);
  return { key: `${label}|${value}`, label, value, node: nodeTitle(node) };
}

/* Свойства типографического токена словами инспектора. «fontWeight» звалось тут
   «насыщенность», а в PROP_NAMES и у мозга — «жирность»: одно свойство, два разных
   корня (круг 16, хвост, п.2). Остальные пары этих двух таблиц совпадают по корню
   и различаются только регистром — это нормально, регистр от места в фразе. */
const TYPE_PROP_WORDS = {
  fontSize: 'кегль', fontWeight: 'жирность', lineHeight: 'интерлиньяж',
  letterSpacing: 'трекинг', font: 'гарнитура',
};

/** Что изменилось внутри одного типографического токена: [{word, val}]. */
function typeTokenBits(op, doc) {
  const name = String(op.path || '').split('.')[1] || '';
  const label = TYPE_LABELS[name] || name || 'стиль';
  const prev = (doc && doc.tokens && doc.tokens.type && doc.tokens.type[name]) || {};
  const next = op.value && typeof op.value === 'object' ? op.value : {};
  const bits = [];
  for (const k of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'font']) {
    if (next[k] === undefined || sameValue(prev[k], next[k])) continue;
    const to = humanValue(next[k]);
    const from = prev[k] === undefined ? '' : humanValue(prev[k]);
    bits.push({ word: TYPE_PROP_WORDS[k] || k, val: from && from !== to ? `${from} → ${to}` : to });
  }
  return { label, bits };
}

/** «Шкала отступов 0…64 → 0…72»: у шкал говорит их размах, а не перечень чисел. */
function scaleTokenPhrase(word, op, prev) {
  const next = Array.isArray(op.value) ? op.value : [];
  const was = Array.isArray(prev) ? prev : [];
  if (!next.length) return word;
  const span = (a) => (a.length ? `${a[0]}…${a[a.length - 1]}` : '');
  const a = span(was);
  const b = span(next);
  if (a && a !== b) return `${word} ${a} → ${b}`;
  return `${word}: ${next.length} ${plural(next.length, 'шаг', 'шага', 'шагов')}`;
}

/**
 * Правки оформления словами. Раньше ЛЮБОЙ setToken печатался как «палитра: …», а имя
 * бралось из SWATCH_NAMES — списка цветов. Команда «сделай шрифт во всём документе
 * крупнее» отчитывалась «Палитра: 3 цвета», хотя ни одного цвета не менялось
 * (круг 11, п.2). Теперь у каждой группы токенов своя фраза.
 */
function describeTokenOps(list, doc) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return [];
  const bag = { colors: [], type: [], spacing: [], radii: [], other: [] };
  for (const op of items) {
    const head = String(op.path || '').split('.')[0];
    (bag[head] || bag.other).push(op);
  }
  const out = [];

  if (bag.colors.length) {
    const named = bag.colors.map((o) => {
      const k = String(o.path || '').split('.').pop();
      const name = SWATCH_NAMES[k] || k;
      const value = typeof o.value === 'string' ? o.value : humanValue(o.value);
      return value ? `${name} ${value}` : name;
    });
    out.push(bag.colors.length <= 2
      ? `палитра: ${named.join(', ')}`
      : `палитра: ${bag.colors.length} ${plural(bag.colors.length, 'цвет', 'цвета', 'цветов')}`);
  }

  if (bag.type.length) {
    const parts = bag.type.map((o) => typeTokenBits(o, doc)).filter((p) => p.bits.length);
    const one = parts.length && parts.every((p) => p.bits.length === 1 && p.bits[0].word === parts[0].bits[0].word);
    if (!parts.length) {
      out.push(`типографика: ${bag.type.length} ${plural(bag.type.length, 'стиль', 'стиля', 'стилей')}`);
    } else if (parts.length === 1 && parts[0].bits.length === 1) {
      out.push(`${parts[0].bits[0].word} «${parts[0].label}» ${parts[0].bits[0].val}`);
    } else if (one && parts.length <= 3) {
      out.push(`${parts[0].bits[0].word}: ${parts.map((p) => `«${p.label}» ${p.bits[0].val}`).join(', ')}`);
    } else if (parts.length === 1) {
      out.push(`типографика «${parts[0].label}»: ${parts[0].bits.map((b) => `${b.word} ${b.val}`).join(', ')}`);
    } else {
      out.push(`типографика: ${parts.length} ${plural(parts.length, 'стиль', 'стиля', 'стилей')}`);
    }
  }

  const tokensOf = (doc && doc.tokens) || {};
  if (bag.spacing.length) out.push(scaleTokenPhrase('шкала отступов', bag.spacing[0], tokensOf.spacing));
  if (bag.radii.length) out.push(scaleTokenPhrase('шкала скруглений', bag.radii[0], tokensOf.radii));
  if (bag.other.length) {
    const n = bag.other.length;
    out.push(`оформление: ${n} ${plural(n, 'правка', 'правки', 'правок')}`);
  }
  return out;
}

/**
 * Короткое человеческое описание транзакции: что изменилось, у кого и с чего на что.
 * Один и тот же текст идёт в сообщение агента и в строку истории — «Заглушка: theme»
 * и «1 правка» человеку не говорят ничего (п.2, п.4).
 */
function describeOps(opsList, doc) {
  const list = Array.isArray(opsList) ? opsList : [];
  if (!list.length || !doc) return '';
  const creates = list.filter((o) => o.op === 'create' && o.node);
  const removes = list.filter((o) => o.op === 'remove' && o.id);
  const moves = list.filter((o) => o.op === 'move' && o.id);
  const sets = list.filter((o) => o.op === 'set' && o.id);
  const tokens = list.filter((o) => o.op === 'setToken');
  const phrases = [];
  // созданное этой же транзакцией: имена таких узлов в прежнем документе не найти (п.18)
  const born = new Map(creates.map((o) => [o.node.id, o.node]));
  const titleOf = (id) => nodeTitleById(doc, id) || (born.has(id) ? nodeTitle(born.get(id)) : '');
  /* МЕСТО правки, а не просто узел: страница-контейнер зовётся «Черновик», но в
     интерфейсе её нет нигде — ни во вкладках, ни в рельсе. «Добавил «Карточку» в
     «Черновик»» отправляло человека искать то, чего он никогда не видел (круг 15, п.11). */
  const placeOf = (id) => {
    const n = id && doc && doc.nodes ? doc.nodes[id] : null;
    if (!n || n.type === 'page' || id === doc.root) return '';
    return titleOf(id);
  };

  if (creates.length) {
    const tops = creates.filter((o) => !born.has(o.node.parent));
    const where = placeOf((tops[0] && tops[0].node.parent) || '');
    const tail = where ? ` в «${where}»` : '';
    if (tops.length === 1) phrases.push(`добавил «${nodeTitle(tops[0].node)}»${tail}`);
    else if (tops.length) phrases.push(`добавил ${tops.length} ${plural(tops.length, 'узел', 'узла', 'узлов')}${tail}`);
  }
  if (removes.length === 1) phrases.push(`удалил «${titleOf(removes[0].id)}»`);
  else if (removes.length) phrases.push(`удалил ${removes.length} ${plural(removes.length, 'узел', 'узла', 'узлов')}`);
  if (moves.length === 1) {
    const to = placeOf(moves[0].parent);
    phrases.push(`перенёс «${titleOf(moves[0].id)}»${to ? ` в «${to}»` : ''}`);
  } else if (moves.length) {
    phrases.push(`перенёс ${moves.length} ${plural(moves.length, 'узел', 'узла', 'узлов')}`);
  }

  // одинаковую правку у нескольких узлов сводим в одну строку
  const groups = new Map();
  for (const op of sets) {
    const d = describeSet(op, doc, born);
    const g = groups.get(d.key) || { label: d.label, value: d.value, nodes: [] };
    if (d.node) g.nodes.push(d.node);
    groups.set(d.key, g);
  }
  for (const g of groups.values()) {
    const uniq = [...new Set(g.nodes)];
    if (uniq.length === 1) phrases.push(`${g.label} ${g.value} в «${uniq[0]}»`);
    else if (uniq.length > 1) phrases.push(`${g.label} ${g.value} у ${uniq.length} узлов`);
    else phrases.push(`${g.label} ${g.value}`);
  }
  for (const p of describeTokenOps(tokens, doc)) phrases.push(p);

  if (!phrases.length) return '';
  const rest = phrases.length - 2;
  const text = rest > 0
    ? `${phrases.slice(0, 2).join('; ')} и ещё ${rest} ${plural(rest, 'правка', 'правки', 'правок')}`
    : phrases.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------- вид холста ---------------------------------- */

const VIEW_MIN_ZOOM = 0.1;
const VIEW_MAX_ZOOM = 6;

/**
 * Накладки оболочки поверх холста: док снизу, панель вида сверху.
 * Высоту меряем по факту — док растёт от сообщения агента, подсказок и вариантов,
 * поэтому константа тут врала бы (п.1).
 */
function stageInsets(opts = {}) {
  const out = { top: 0, right: 0, bottom: 0, left: 0, bottomWanted: 0 };
  const host = (stage && stage.el) || dom.canvas;
  if (!host || typeof host.getBoundingClientRect !== 'function') return out;
  const base = host.getBoundingClientRect();
  if (!base.width || !base.height) return out;
  // накладки съедают почти весь холст на узком экране. Для размещения подсказок оставляем
  // хоть полоску, а для вписывания — не меньше 45% высоты: макет размером с марку не нужен (п.12)
  const capV = base.height * (opts.forFit ? 0.55 : 0.82);
  const capH = base.width * 0.5;
  const eat = (node, side, gap) => {
    if (!node || node.hidden || typeof node.getBoundingClientRect !== 'function') return;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // панель считается накладкой только если правда лежит на холсте: на широком экране
    // рельс и инспектор — колонки сетки, и холст уже посчитан без них
    if (Math.min(r.right, base.right) - Math.max(r.left, base.left) <= 1) return;
    if (Math.min(r.bottom, base.bottom) - Math.max(r.top, base.top) <= 1) return;
    if (side === 'bottom') {
      const want = base.bottom - r.top + gap;
      // сколько накладка съедает НА САМОМ ДЕЛЕ: capV ниже её обрежет, и тогда часть
      // артборда окажется под доком, а кнопка вида продолжит обещать «Вписано» (п.7)
      out.bottomWanted = Math.max(out.bottomWanted, want);
      out.bottom = Math.max(out.bottom, Math.min(capV, want));
    }
    else if (side === 'top') out.top = Math.max(out.top, Math.min(base.height * 0.4, r.bottom - base.top + gap));
    else if (side === 'left') out.left = Math.max(out.left, Math.min(capH, r.right - base.left + gap));
    else out.right = Math.max(out.right, Math.min(capH, base.right - r.left + gap));
  };
  eat(dom.dock, 'bottom', 12);
  eat(dom.viewbar, 'top', 10);
  // боковые панели: инспектор справа (на узком — нижним листом). Без них макет уезжал
  // вправо ровно на половину ширины инспектора, а соседний артборд оказывался подрезан (п.13).
  // Рельс на широком экране — колонка сетки (холст уже посчитан без неё), а на узком —
  // шторка со скримом: она временная, и вид под неё не пересчитываем.
  if (!railIsDrawer()) eat(dom.rail, 'left', 8);
  eat(dom.inspector, inspIsSheet() ? 'bottom' : 'right', 8);
  // варианты: на широком экране это колонка сетки (холст уже посчитан без неё),
  // на узком — нижний лист поверх холста (п.17)
  eat(dom.variants, isNarrow() ? 'bottom' : 'right', 8);
  /* Камера смотрит на постоянную разметку, а недолгое сообщение агента её не двигает —
     и на вписывание не влияет: раньше одно и то же «вписано» считалось то с карточкой,
     то без неё, и макет прыгал 55% → 67% на постороннем действии (круг 9, п.5).
     Приветствие — исключение: оно часть первого экрана и живёт до первого действия,
     поэтому его высота в мере участвует, и его закрытие вид пересчитывает. */
  if (opts.noMsg && !state.introOpen && dom.dockmsg && !dom.dockmsg.hidden
      && typeof dom.dockmsg.getBoundingClientRect === 'function') {
    const r = dom.dockmsg.getBoundingClientRect();
    if (r.height) {
      out.bottom = Math.max(0, out.bottom - r.height - 8);
      out.bottomWanted = Math.max(0, out.bottomWanted - r.height - 8);
    }
  }
  return out;
}

/**
 * Видимая область холста. Сцена отдаёт viewportRect() в координатах окна, а накладки
 * оболочки лежат внутри холста, поэтому начало координат здесь всегда 0,0 — как у toScreen().
 */
function stageViewport() {
  if (stage && typeof stage.viewportRect === 'function') {
    try {
      const r = stage.viewportRect();
      if (r && r.w > 0 && r.h > 0) return { x: 0, y: 0, w: r.w, h: r.h };
    } catch { /* сцена ещё не умеет — считаем сами */ }
  }
  const host = (stage && stage.el) || dom.canvas;
  const b = host && host.getBoundingClientRect ? host.getBoundingClientRect() : null;
  return b ? { x: 0, y: 0, w: b.width, h: b.height } : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Одна мера для всей камеры: и вписывание, и проверка «место изменилось» считают
 * один и тот же прямоугольник. Разные основания и давали непредсказуемый скачок (п.5).
 */
const FIT_BASIS = { forFit: true, noMsg: true };

/** Прямоугольник, в котором накладкам оболочки можно жить: холст минус док и панель вида. */
function overlayBox(opts = {}) {
  const v = stageViewport();
  const i = stageInsets(opts);
  const x = v.x + (i.left || 0);
  const y = v.y + (i.top || 0);
  return {
    x, y,
    w: Math.max(40, v.w - (i.left || 0) - (i.right || 0)),
    h: Math.max(40, v.h - (i.top || 0) - (i.bottom || 0)),
  };
}

/**
 * Прямоугольник, с которым вообще можно считать вид. Нечисловая геометрия приходит
 * из битого документа, а дальше NaN проходит сквозь Math.min/max и залипает в зуме,
 * откуда из интерфейса уже не выбраться (п.2).
 */
function finiteRect(r) {
  return !!r && Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.w) && Number.isFinite(r.h);
}

/** Первый узел с нечисловой геометрией — или null, если считается всё. */
function firstBrokenRect(geo) {
  const rects = (geo && geo.rects) || {};
  for (const id of Object.keys(rects)) if (!finiteRect(rects[id])) return id;
  return null;
}

/** Охватывающий прямоугольник узлов в координатах документа. */
function boundsOf(ids) {
  const rects = (state.geo && state.geo.rects) || {};
  const list = (ids || []).map((id) => rects[id]).filter(finiteRect);
  if (!list.length) return null;
  const x0 = Math.min(...list.map((r) => r.x));
  const y0 = Math.min(...list.map((r) => r.y));
  const x1 = Math.max(...list.map((r) => r.x + r.w));
  const y1 = Math.max(...list.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Каким должен быть вид, чтобы прямоугольник целиком попал в свободную часть холста. */
function computeView(box, { padding = 48, inset = null, maxZoom = VIEW_MAX_ZOOM } = {}) {
  if (!stage || !finiteRect(box) || !(box.w > 0) || !(box.h > 0)) return null;
  // ни одно нечисловое значение не должно дойти до зума: оттуда его не вернуть
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const side = (v) => Math.max(0, num(v, 0));
  const pad = Math.max(0, num(padding, 48));
  const vw = Math.max(1, num(stage.vw, 1));
  const vh = Math.max(1, num(stage.vh, 1));
  const i = inset || {};
  const left = side(i.left), right = side(i.right), top = side(i.top), bottom = side(i.bottom);
  const availW = Math.max(40, vw - left - right - pad * 2);
  const availH = Math.max(40, vh - top - bottom - pad * 2);
  let zoom = Math.min(availW / box.w, availH / box.h);
  if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;
  zoom = Math.min(zoom, Math.max(VIEW_MIN_ZOOM, num(maxZoom, VIEW_MAX_ZOOM)));
  zoom = Math.max(VIEW_MIN_ZOOM, Math.min(VIEW_MAX_ZOOM, zoom));
  const cx = left + (vw - left - right) / 2;
  const cy = top + (vh - top - bottom) / 2;
  const view = { zoom, pan: { x: cx - (box.x + box.w / 2) * zoom, y: cy - (box.y + box.h / 2) * zoom } };
  return Number.isFinite(view.pan.x) && Number.isFinite(view.pan.y) ? view : null;
}

/** Вид, с которым можно работать: конечный зум и конечная панорама. */
function viewIsSane(v) {
  return !!v && Number.isFinite(v.zoom) && v.zoom > 0
    && !!v.pan && Number.isFinite(v.pan.x) && Number.isFinite(v.pan.y);
}

function viewIsClose(view) {
  if (!view || !stage || !stage.view) return false;
  const z = stage.view.zoom;
  if (!z || Math.abs(z - view.zoom) > Math.max(0.005, view.zoom * 0.02)) return false;
  return Math.abs(stage.view.pan.x - view.pan.x) < 6 && Math.abs(stage.view.pan.y - view.pan.y) < 6;
}

/**
 * Поставить вид ровно. Сцена меняет зум и панораму вместе только в zoomAt, поэтому
 * решаем обратную задачу: подбираем точку, относительно которой зум даёт нужную панораму.
 * Полной перерисовки нет — подсветка правок остаётся на месте.
 */
function applyView(view) {
  if (!stage || !stage.view) return;
  // без этой проверки NaN-вид качал зум «нуджем» и оставлял холст в мёртвом состоянии (п.2)
  if (!viewIsSane(view) || !viewIsSane(stage.view)) return;
  const host = stage.el || dom.canvas;
  const b = host && host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
  const step = () => {
    const z0 = stage.view.zoom;
    const f = view.zoom / z0;
    if (!Number.isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-4) return false;
    const sx = (view.pan.x - stage.view.pan.x * f) / (1 - f);
    const sy = (view.pan.y - stage.view.pan.y * f) / (1 - f);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
    stage.zoomAt(b.left + sx, b.top + sy, f);
    return true;
  };
  if (!step()) {
    // зум уже такой, какой нужен: качнём его, чтобы получить право переставить панораму
    const nudge = stage.view.zoom * 0.9 > VIEW_MIN_ZOOM ? 0.9 : 1.1;
    stage.zoomAt(b.left, b.top, nudge);
    step();
  }
}

/**
 * Вписать узлы в свободную часть холста. Новый контракт сцены (inset, maxZoom) используем,
 * если он уже есть; если нет — доводим вид сами, чтобы результат не уезжал под док.
 */
function fitView(ids, opts = {}) {
  if (!stage || !state.doc) return;
  const rects = (state.geo && state.geo.rects) || {};
  const wanted = ids && ids.length ? ids : artboards(state.doc).map((a) => a.id);
  const list = wanted.filter((id) => finiteRect(rects[id]));
  // узлов, по которым вписывали, больше нет (отмена, удаление) — и пересчитывать вид по ним
  // тоже нечего: иначе каждая проверка вида будет упираться в тот же пустой список
  if (!list.length) { if (ids && ids.length) state.lastFit = null; return; }
  const padding = opts.padding == null ? 48 : opts.padding;
  const maxZoom = opts.maxZoom == null ? 2 : opts.maxZoom;
  const inset = stageInsets(FIT_BASIS);
  const anchor = opts.anchor && stage.view && viewIsSane(stage.view) ? opts.anchor : null;
  withView(() => {
    const box = boundsOf(list);
    let want = computeView(box, { padding, inset, maxZoom });
    if (want && anchor) want = keepAnchor(want, anchor, box, inset, padding);
    if (!want) {
      try { stage.fitTo(list, { padding, inset, maxZoom }); }
      catch { try { stage.fitTo(list); } catch { /* сцена не готова */ } }
      return;
    }
    // сцена центрирует по остатку холста, и при вписывании с якорем это как раз лишнее
    if (!anchor) { try { stage.fitTo(list, { padding, inset, maxZoom }); } catch { /* доведём сами */ } }
    if (!viewIsClose(want)) applyView(want);
  });
  // чем вписывали — помним: когда холст вырастет (закрыли инспектор, скрыли сообщение),
  // вид надо пересчитать, иначе останется 22% и полторы тысячи пикселей пустоты (п.12)
  const memo = { ...opts };
  delete memo.anchor;   // якорь относится к одному пересчёту, а не к способу вписывания
  state.lastFit = { ids: ids && ids.length ? ids.slice() : null, opts: memo };
  rememberView();
  state.userView = false;
  updateZoomLabel(stage.view);
  updateFitButton();
  renderEmptyState();
}

/**
 * Что сейчас ПРАВДА целиком видно в той же свободной части холста, по которой считает
 * «Вписать»: 'all' — все артборды, 'one' — активный, null — ни то ни другое.
 * Раньше на этот вопрос отвечали флаги state.fitAll и state.lastFit, то есть память
 * о прошлом вписывании: после программного fitView или панорамы кнопка уверяла
 * «Вписано: все», пока половина макета стояла за краем экрана (круг 11, п.1).
 */
function fitScopeNow() {
  if (!stage || !state.doc || !viewIsSane(stage.view) || typeof stage.toScreen !== 'function') return null;
  const free = overlayBox(FIT_BASIS);
  const inset = stageInsets(FIT_BASIS);
  /* Вписывание нарочно не отдаёт доку больше 55 % высоты — иначе на узком экране макет
     становится размером с марку. Но «Вписано: все» при таком упоре начинало врать: низ
     артборда уходил под док на ~19 px, а кнопка обещала, что видно всё. Компромисс
     оставляем, а слово — нет: проверяем попадание по НАСТОЯЩЕМУ свободному полю
     (круг 13, п.7). */
  const hidden = Math.max(0, (inset.bottomWanted || 0) - (inset.bottom || 0));
  const seen = { x: free.x, y: free.y, w: free.w, h: Math.max(40, free.h - hidden) };
  const whole = (ids) => {
    const box = boundsOf(ids);
    if (!box) return false;
    let a = null; let b = null;
    try { a = stage.toScreen(box.x, box.y); b = stage.toScreen(box.x + box.w, box.y + box.h); }
    catch { return false; }
    const slack = 2;
    const inside = a.x >= seen.x - slack && a.y >= seen.y - slack
      && b.x <= seen.x + seen.w + slack && b.y <= seen.y + seen.h + slack;
    if (!inside) return false;
    // «вписано» — это ещё и «крупнее уже некуда»: отдалённый вид, где всё видно,
    // вписыванием не является, иначе слово ничего не значит
    const want = computeView(box, { padding: 48, inset, maxZoom: 2 });
    return !want || stage.view.zoom >= want.zoom * 0.88;
  };
  const abs = artboards(state.doc).map((a) => a.id);
  if (abs.length && whole(abs)) return 'all';
  const act = activeArtboardId();
  if (act && whole([act])) return 'one';
  return null;
}

/**
 * Кнопка вида. Она была наполовину статусом («Вписано: все»), и человек не знал, что даст
 * клик (круг 11, п.16), а статус к тому же врал. Теперь надпись — всегда действие, а то,
 * вписан ли вид сейчас, показывают заливка кнопки и подсказка; состояние считается по
 * настоящей геометрии, а не по памяти о прошлом вписывании.
 */
function updateFitButton() {
  const btn = dom['btn-fit'];
  if (!btn || !state.doc) return;
  const act = activeArtboardId();
  const many = artboards(state.doc).length > 1 && !!act;
  const scope = fitScopeNow();
  // «всё» и «экран» переключаются от того, что видно сейчас, а не от памяти о прошлом клике
  if (scope) state.fitAll = scope === 'all';
  const short = isNarrow() || (dom.canvas && dom.canvas.clientWidth < 520);
  let label = 'Вписать';
  if (many && scope === 'all' && !short) label = 'Вписать артборд';
  else if (many && scope === 'one' && !short) label = 'Вписать всё';
  if (btn.textContent !== label) btn.textContent = label;
  btn.dataset.fit = scope ? (many ? scope : 'plain') : 'off';
  const name = act ? nodeTitleById(state.doc, act) : '';
  const now = scope === 'all'
    ? 'Сейчас в кадре все артборды целиком.'
    : scope === 'one'
      ? `Сейчас в кадре${name ? ` «${name}»` : ' активный артборд'} целиком.`
      : 'Сейчас в кадр помещается не всё.';
  const next = !many
    ? 'Нажмите, чтобы вписать макет в свободную часть холста.'
    : scope === 'all'
      ? `Нажмите, чтобы вписать${name ? ` «${name}»` : ' активный артборд'}.`
      : scope === 'one'
        ? 'Нажмите, чтобы показать все артборды.'
        : 'Нажмите, чтобы вписать макет.';
  btn.title = `${now} ${next}`;
  btn.setAttribute('aria-label', btn.title);
}

let viewLock = 0;
let recheckTimer = null;
let pointerOnCanvas = false;

/** Наша смена вида, а не человеческая: ручной зум мы потом не затираем. */
function withView(fn) {
  viewLock += 1;
  try { return fn(); } finally { viewLock -= 1; }
}

function freeAreaNow() {
  // ровно тот прямоугольник, в который вписывает fitView: иначе «место изменилось»
  // и «вписать» говорят о разных вещах, и вид прыгает без причины (п.5)
  const b = overlayBox(FIT_BASIS);
  return Math.max(0, b.w) * Math.max(0, b.h);
}

/**
 * Высота, которую док занимает снизу окна. Шторка (история, настройки, экспорт) —
 * position: fixed от верха, и на узком экране её низ уходил под док: док поднят
 * инспектором и лежит выше (z-index 25 против 20), а тело шторки не прокручивалось —
 * объяснение режимов микрофона было не достать ничем (круг 13, п.5).
 * Отдаём высоту в CSS, и шторка кончается над доком; всё, что не влезло, прокручивается.
 */
function syncDockGap() {
  const root = dom.app || document.documentElement;
  if (!root || !dom.dock || typeof dom.dock.getBoundingClientRect !== 'function') return;
  let gap = 0;
  const r = dom.dock.getBoundingClientRect();
  const vh = globalThis.innerHeight || 0;
  if (r.height && vh) gap = Math.max(0, Math.round(vh - r.top) + 8);
  // на широком экране шторка и док не встречаются — переменную держим нулевой;
  // но если инспектор стал нижним листом, док поднят и здесь (круг 16, п.1)
  if (!isNarrow() && !inspIsSheet()) gap = 0;
  const now = root.style.getPropertyValue('--dock-gap');
  const next = `${gap}px`;
  if (now !== next) root.style.setProperty('--dock-gap', next);
}

/** Экранное положение холста: рельс — колонка сетки, и левый край холста переезжает. */
function canvasFrame() {
  const host = (stage && stage.el) || dom.canvas;
  const r = host && host.getBoundingClientRect ? host.getBoundingClientRect() : null;
  return { left: r ? r.left : 0, top: r ? r.top : 0 };
}

/**
 * От какой точки считать следующий пересчёт вида: центр свободной части холста
 * в координатах окна и мировая точка, которая там сейчас стоит. Экранные координаты
 * нужны потому, что холст не только меняет размер, но и переезжает (свернулся рельс).
 */
function fitAnchor() {
  if (!stage || !viewIsSane(stage.view)) return null;
  const b = overlayBox(FIT_BASIS);
  const f = canvasFrame();
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const wx = (cx - stage.view.pan.x) / stage.view.zoom;
  const wy = (cy - stage.view.pan.y) / stage.view.zoom;
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  return { sx: f.left + cx, sy: f.top + cy, wx, wy };
}

/** Тот же якорь в координатах холста, каким он стал сейчас. */
function anchorNow() {
  const a = state.viewAnchor;
  if (!a) return null;
  const f = canvasFrame();
  return { x: a.sx - f.left, y: a.sy - f.top, wx: a.wx, wy: a.wy };
}

/** Запомнить, от чего считать следующий пересчёт вида. */
function rememberView() {
  state.freeArea = freeAreaNow();
  state.freeBox = overlayBox(FIT_BASIS);
  state.viewAnchor = fitAnchor();
}

/**
 * Панорама p, при которой отрезок [from, to] лежит в свободной полосе [lo, hi].
 * Если отрезок шире полосы, держим полосу внутри него: край не уезжает дальше нужного.
 */
function holdSpan(p, from, to, lo, hi) {
  const a = lo - from;
  const b = hi - to;
  return a <= b ? Math.min(Math.max(p, a), b) : Math.min(Math.max(p, b), a);
}

/**
 * Вид, вписывающий прямоугольник, но без бокового переезда: мировая точка якоря
 * остаётся в той же точке экрана. Центрирование по остатку холста уносило узел
 * из-под курсора ровно на половину открывшейся панели (п.7).
 */
function keepAnchor(view, anchor, box, inset, padding) {
  if (!viewIsSane(view) || !anchor || !stage || !finiteRect(box)) return view;
  const z = view.zoom;
  let px = anchor.x - anchor.wx * z;
  let py = anchor.y - anchor.wy * z;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return view;
  const v = stageViewport();
  const i = inset || {};
  const side = (s) => Math.max(0, Number(s) || 0);
  const pad = Math.max(0, Math.min(Number(padding) || 0, 24));
  px = holdSpan(px, box.x * z, (box.x + box.w) * z, side(i.left) + pad, Math.max(side(i.left) + pad, v.w - side(i.right) - pad));
  py = holdSpan(py, box.y * z, (box.y + box.h) * z, side(i.top) + pad, Math.max(side(i.top) + pad, v.h - side(i.bottom) - pad));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return view;
  return { zoom: z, pan: { x: px, y: py } };
}

/**
 * Довести панораму, не меняя масштаб: прямоугольник должен лежать в свободной части
 * холста. Масштаб тут неприкосновенен — человек только что кликнул по узлу (п.7).
 * @returns {boolean} двигали ли вид
 */
function panIntoView(box, { pad = 24, anchor = null } = {}) {
  if (!stage || !viewIsSane(stage.view)) return false;
  const z = stage.view.zoom;
  const v = stageViewport();
  const i = stageInsets();
  const side = (s) => Math.max(0, Number(s) || 0);
  let px = stage.view.pan.x;
  let py = stage.view.pan.y;
  // холст мог переехать (свернулся рельс): сперва возвращаем мир на прежнее место экрана
  if (anchor) {
    const ax = anchor.x - anchor.wx * z;
    const ay = anchor.y - anchor.wy * z;
    if (Number.isFinite(ax) && Number.isFinite(ay)) { px = ax; py = ay; }
  }
  if (finiteRect(box)) {
    px = holdSpan(px, box.x * z, (box.x + box.w) * z, side(i.left) + pad, Math.max(side(i.left) + pad, v.w - side(i.right) - pad));
    py = holdSpan(py, box.y * z, (box.y + box.h) * z, side(i.top) + pad, Math.max(side(i.top) + pad, v.h - side(i.bottom) - pad));
  }
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  const moved = Math.abs(px - stage.view.pan.x) >= 1 || Math.abs(py - stage.view.pan.y) >= 1;
  if (moved) withView(() => applyView({ zoom: z, pan: { x: px, y: py } }));
  rememberView();
  // панорама — тоже смена вида: после неё «вписано» может стать неправдой (п.1)
  updateFitButton();
  return moved;
}

let layoutFitTimer = null;

/**
 * Вписать сейчас — и ещё раз, когда доедет сетка. Колонки холста переезжают с переходом
 * .18s, поэтому сразу после setSelection холст ещё широкий: «вписанный» артборд уходил
 * правым краем под инспектор на полсотни пикселей, а кнопка уверяла «Вписано: экран»
 * (круг 11, п.1). Второй проход стоит один пересчёт и снимает расхождение совсем.
 */
function fitAfterLayout(ids, opts = {}) {
  fitView(ids, opts);
  clearTimeout(layoutFitTimer);
  layoutFitTimer = setTimeout(() => {
    // человек уже взялся за холст или сам выбрал масштаб — не мешаем
    if (pointerOnCanvas || state.userView || !state.doc) return;
    fitView(ids, opts);
  }, 280);
}

function scheduleViewRecheck(delay = 160) {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(recheckView, delay);
}

/**
 * Область холста изменилась: открылся или закрылся инспектор, свернулся рельс, ушло
 * сообщение. Пока масштаб выбирали не руками — вписываем заново тем же способом (п.12, п.13).
 */
function recheckView() {
  syncDockGap();
  if (!stage || !state.doc || !state.lastFit || state.userView) return;
  // под рукой человека вид не двигаем: он тянет узел или ведёт холст
  if (pointerOnCanvas) { scheduleViewRecheck(320); return; }
  // и пока агент работает: док в это время меняет высоту трижды, а камера — не метроном (п.13)
  if (state.busy) { scheduleViewRecheck(400); return; }
  const area = freeAreaNow();
  if (!area) return;
  const was = state.freeArea || 0;
  if (was && Math.abs(area - was) / Math.max(was, area) < 0.08) return;
  const anchor = anchorNow();
  if (was && area < was) {
    /* Холста стало меньше: открылся инспектор, поднялся нижний лист. Масштаб меняем
       только по необходимости — макет вписан плотно, и лишний пересчёт уносит узел
       из-под курсора ровно на половину панели (п.7). Но если то, ПО ЧЕМУ вписывали,
       под панель уже не помещается, одной панорамы мало: инспектор шириной 288 px
       срезал соседний артборд, и компенсации не было никакой (круг 15, п.11). */
    if (!fitTargetVisible()) {
      const shrunk = state.lastFit;
      fitView(shrunk.ids, { ...shrunk.opts });
      updateFitButton();
      return;
    }
    const sel = state.selection.filter((id) => (state.geo.rects || {})[id]);
    panIntoView(sel.length ? boundsOf(sel) : null, { pad: 16, anchor });
    return;
  }
  /* Холста стало больше: закрылась панель, свернулся рельс. Раньше вид пересчитывался
     от якоря, и макет оставался прижатым к тому краю, где его застала панель, — свернуть
     рельс и не увидеть перецентровки (круг 11, п.12). Якорь нужен был против рывка под
     рукой, а рука тут ни при чём: место освободилось, и макет возвращается в середину. */
  const fit = state.lastFit;
  fitView(fit.ids, { ...fit.opts });
  updateFitButton();
}

/**
 * Помещается ли целиком то, по чему в последний раз вписывали. Мера та же, что у
 * fitScopeNow: настоящее свободное поле холста, без куска под доком.
 */
function fitTargetVisible() {
  const fit = state.lastFit;
  if (!fit || !stage || !state.doc || !viewIsSane(stage.view) || typeof stage.toScreen !== 'function') return true;
  const rects = (state.geo && state.geo.rects) || {};
  const ids = (fit.ids && fit.ids.length ? fit.ids : artboards(state.doc).map((a) => a.id))
    .filter((id) => finiteRect(rects[id]));
  if (!ids.length) return true;
  const box = boundsOf(ids);
  if (!box) return true;
  const free = overlayBox(FIT_BASIS);
  const inset = stageInsets(FIT_BASIS);
  const hidden = Math.max(0, (inset.bottomWanted || 0) - (inset.bottom || 0));
  const seen = { x: free.x, y: free.y, w: free.w, h: Math.max(40, free.h - hidden) };
  let a = null; let b = null;
  try { a = stage.toScreen(box.x, box.y); b = stage.toScreen(box.x + box.w, box.y + box.h); }
  catch { return true; }
  const slack = 2;
  return a.x >= seen.x - slack && a.y >= seen.y - slack
    && b.x <= seen.x + seen.w + slack && b.y <= seen.y + seen.h + slack;
}

/**
 * Вписать по-доброму. Вписать все артборды на узком экране — это 21% и нечитаемый
 * макет; человеку нужен тот экран, с которым он работает. Все — по второму нажатию (п.13).
 */
function fitSmart(opts = {}) {
  const abs = artboards(state.doc).map((a) => a.id);
  const act = activeArtboardId();
  if (abs.length > 1 && act && (state.geo.rects || {})[act]) {
    const all = computeView(boundsOf(abs), {
      padding: opts.padding == null ? 48 : opts.padding,
      inset: stageInsets(FIT_BASIS),
      maxZoom: 2,
    });
    if (!all || all.zoom < 0.34) { state.fitAll = false; fitView([act], opts); return; }
  }
  state.fitAll = true;
  fitView(null, opts);
}

/**
 * Показать то, что сделал агент: охватывающий прямоугольник изменённого поддерева,
 * а не весь артборд. maxZoom держит один маленький узел от раздувания на весь экран (п.1).
 */
function revealChange(diff) {
  const rects = (state.geo && state.geo.rects) || {};
  const ids = [...new Set([...(diff && diff.created || []), ...(diff && diff.changed || [])])]
    .filter((id) => state.doc.nodes[id] && rects[id]);
  if (!ids.length) { fitView(); return; }   // правка в токенах: показываем документ целиком
  const box = boundsOf(ids);
  if (box && changeIsVisible(box)) { renderEmptyState(); return; }   // уже видно — камеру не дёргаем
  // мелкая правка приближала камеру до 150% и срезала родителя: держимся текущего масштаба
  // и берём в кадр родителя изменённого узла (п.14)
  const withParents = new Set(ids);
  for (const id of ids) {
    const parent = (state.doc.nodes[id] || {}).parent;
    if (parent && parent !== state.doc.root && rects[parent]) withParents.add(parent);
  }
  const z = stage && stage.view && Number.isFinite(stage.view.zoom) ? stage.view.zoom : 1;
  const ids2 = [...withParents];
  fitView(ids2, { maxZoom: Math.min(1.5, Math.max(z, 0.3)) });
  // вписываем по постоянной разметке (п.5), поэтому правка может остаться под карточкой
  // сообщения: доводим панораму, не трогая масштаб — скачка от этого не бывает
  const shown = boundsOf(ids2);
  if (shown && !changeIsVisible(shown)) panIntoView(shown, { pad: 16 });
}

/** Изменённое уже в кадре и различимо — вид переставлять незачем. */
function changeIsVisible(box) {
  if (!stage || typeof stage.toScreen !== 'function') return false;
  try {
    const a = stage.toScreen(box.x, box.y);
    const b = stage.toScreen(box.x + box.w, box.y + box.h);
    const free = overlayBox();
    const w = Math.max(0, Math.min(b.x, free.x + free.w) - Math.max(a.x, free.x));
    const h = Math.max(0, Math.min(b.y, free.y + free.h) - Math.max(a.y, free.y));
    const area = Math.max(1, (b.x - a.x) * (b.y - a.y));
    if ((w * h) / area < 0.9) return false;
    return Math.min(b.x - a.x, b.y - a.y) >= 48;
  } catch { return false; }
}

/* --------------------------------- отрисовка --------------------------------- */

/**
 * Замечания раскладки, о которых человеку стоит знать: текст не помещается, узел вышел
 * за родителя, нулевой размер. Всё прочее (перекрытия, вне шкалы, пустой фрейм) —
 * придирки, и тревожить ими правку руками не за чем.
 */
const LOUD_ISSUES = new Set(['overflow', 'out-of-parent', 'zero-size']);

/**
 * Движок умеет проверять раскладку, а оболочка его ни разу не звала: ручная правка,
 * ломающая макет (переполнение, выход за родителя, нулевой размер), проходила молча, и
 * замечание всплывало только как побочный продукт команды агенту (круг 15, п.5).
 */
function layoutIssues(doc, geo) {
  const map = new Map();
  let list = [];
  try { list = validate(doc, geo) || []; } catch { return map; }
  for (const note of list) {
    if (!LOUD_ISSUES.has(note.code) || !note.nodeId) continue;
    const arr = map.get(note.nodeId);
    if (arr) arr.push(note); else map.set(note.nodeId, [note]);
  }
  return map;
}

/** Что сломала ИМЕННО эта правка: о старых замечаниях молчим, иначе это нытьё. */
function freshIssues(before, after) {
  const out = [];
  for (const [id, list] of after) {
    const had = new Set((before.get(id) || []).map((n) => `${n.code}|${n.message}`));
    for (const note of list) if (!had.has(`${note.code}|${note.message}`)) out.push(note);
  }
  return out;
}

/** Один тост на правку, а не на каждое замечание: остальное видно значком в рельсе. */
function announceIssues(fresh) {
  if (!fresh.length) return;
  const first = fresh[0];
  const more = fresh.length > 1 ? ` · и ещё ${fresh.length - 1}` : '';
  toast(`Раскладка: ${clip(first.message, 84)}${more}`, 'warn', 8000);
}

function renderAll(opts = {}) {
  state.issues = layoutIssues(state.doc, state.geo);
  /* На холсте мог стоять предпросмотр варианта. Любая перерисовка документа (отмена,
     правка руками, возврат истории) снимает его — иначе холст показывает документ,
     а плашка сверху уверяет «Вариант 1 — предпросмотр», и «Взять этот» упирается
     в «документ изменился» (круг 11, п.4). */
  unpeekVariant();
  stage.render(state.doc, state.geo, {
    selection: state.selection,
    diff: opts.diff || null,
  });
  if (opts.diff && opts.prevGeo) flipMoved(opts.diff, opts.prevGeo);
  renderLayers();
  renderTabs();
  renderInspector();
  renderEmptyState();
  // подсказки зависят от документа: после импорта пустого документа внизу оставались
  // чипы прежнего макета, хотя те же примеры уже стояли на холсте
  renderHints();
  updateZoomLabel(stage.view);
  updateFitButton();
  setDocNameText(state.doc.meta && state.doc.meta.name || 'Без названия');
}

/**
 * Имя документа в шапке. contenteditable запоминает горизонтальную прокрутку каретки:
 * после правки длинного имени элемент оставался прокрученным (scrollLeft 53…277) и
 * показывал середину имени или вовсе пустую плашку — человек читал это как «не
 * сохранилось». Ставим текст и всегда возвращаем прокрутку в начало: обрезку доделает
 * text-overflow: ellipsis (круг 13, п.1).
 */
function setDocNameText(name) {
  const el = dom.docname;
  if (!el) return;
  // пока имя правят, перерисовка в него не лезет: иначе правка агента посреди
  // переименования стирала недопечатанное имя и уводила каретку
  if (document.activeElement === el) return;
  if (el.textContent !== name) el.textContent = name;
  /* В покое имя обрезано многоточием, и прочитать его целиком было негде: title не
     было вовсе. Теперь полное имя всегда под курсором и у экранного диктора (п.6). */
  el.title = name;
  el.setAttribute('aria-label', `Имя документа: ${name}`);
  resetDocNameScroll();
}

function resetDocNameScroll() {
  const el = dom.docname;
  if (!el) return;
  if (el.scrollLeft) el.scrollLeft = 0;
  // Chrome возвращает прокрутку на следующем кадре, если каретка ещё в конце строки
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { if (el.scrollLeft) el.scrollLeft = 0; });
  }
}

/**
 * Плавный переезд узлов, которые просто сдвинулись. Подсветку им не даём (п.2),
 * но движение остаётся: без него правка зазора выглядит как рывок половины макета.
 * Если сцена сама переставила узел (её FLIP), не трогаем.
 */
function flipMoved(diff, prevGeo) {
  const list = (diff && diff.moved) || [];
  if (!list.length || typeof requestAnimationFrame !== 'function') return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rects = (state.geo && state.geo.rects) || {};
  const moved = [];
  for (const id of list.slice(0, 120)) {
    const a = prevGeo.rects[id], b = rects[id];
    if (!a || !b) continue;
    const dx = Math.round((a.x - b.x) * 100) / 100;
    const dy = Math.round((a.y - b.y) * 100) / 100;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const g = dom.canvas.querySelector(`.imago-svg g[data-id="${CSS.escape(id)}"]`);
    if (!g || g.getAttribute('transform')) continue;
    g.style.transition = 'none';
    g.setAttribute('transform', `translate(${dx} ${dy})`);
    moved.push(g);
  }
  if (!moved.length) return;
  const run = () => {
    for (const g of moved) {
      g.style.transition = 'transform 220ms cubic-bezier(.2,.7,.2,1)';
      g.setAttribute('transform', 'translate(0 0)');
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(() => {
    for (const g of moved) { g.style.transition = ''; g.removeAttribute('transform'); }
  }, 300);
}

function setSelection(ids, opts = {}) {
  state.selection = Array.isArray(ids) ? ids.slice() : [];
  /* Кто выделил: агент после своей же правки (selectTouched) или человек. brain по этому
     полю решает, говорить ли «правка ушла туда» — на каждой второй команде это звучало
     как претензия к человеку, который ничего не выделял (круг 9, п.19). */
  state.selectionBy = opts.agent === true ? 'agent' : 'human';
  // выделение от агента на узком экране не должно поднимать нижний лист: он съедает 45%
  // высоты, и результат правки становится нечитаем (п.12). Лист откроется по касанию узла.
  state.inspQuiet = opts.agent === true && inspIsSheet();
  state.inspByRail = false;
  state.inspBySheet = false;
  // сцена умеет перерисовать только слой интерфейса — это дешевле полной отрисовки
  if (typeof stage.setSelection === 'function') stage.setSelection(state.selection);
  else stage.render(state.doc, state.geo, { selection: state.selection });
  // рельс переписываем целиком только если поменялся состав строк (круг 16, п.13)
  if (!updateLayerSelection()) renderLayers();
  renderTabs();
  renderInspector();
  renderHints();
  renderEmptyState();
  revealLayerRow();
  // при выделении по итогу правки вид доводит revealChange — дёргать его дважды незачем
  if (!opts.quiet) ensureVisible(state.selection);
}

/**
 * Если выделенное оказалось за пределами свободной части холста (нижний лист инспектора
 * на узком экране, выбор строки в рельсе) — подводим вид к нему, не меняя масштаб.
 */
function ensureVisible(ids) {
  if (!stage || !ids || ids.length !== 1 || typeof stage.toScreen !== 'function') return;
  const box = boundsOf(ids);
  if (!box) return;
  const a = stage.toScreen(box.x, box.y);
  const b = stage.toScreen(box.x + box.w, box.y + box.h);
  const free = overlayBox();
  const w = Math.max(0, Math.min(b.x, free.x + free.w) - Math.max(a.x, free.x));
  const h = Math.max(0, Math.min(b.y, free.y + free.h) - Math.max(a.y, free.y));
  const area = Math.max(1, (b.x - a.x) * (b.y - a.y));
  if ((w * h) / area >= 0.5) return;   // видно больше половины — не дёргаем вид
  const z = stage.view.zoom;
  // узел на текущем масштабе в свободную часть не влезает — тогда вписываем
  if (box.w * z > free.w || box.h * z > free.h) { fitView(ids, { padding: 24, maxZoom: z }); return; }
  panIntoView(box, { pad: 24 });
  updateFitButton();
}

/* ------------------------------ пустое состояние ----------------------------- */

const EMPTY_EXAMPLES = [
  'экран оплаты с полем карты и итогом',
  'дашборд из четырёх плиток с цифрами',
  'карточка товара с фото и кнопкой',
];
const ARTBOARD_EXAMPLES = [
  'добавь шапку с заголовком и датой',
  'список из трёх карточек',
  'нижняя панель с двумя кнопками',
];

function docIsEmpty() { return artboards(state.doc).length === 0; }

function activeArtboardIsEmpty() {
  const id = activeArtboardId();
  const n = id ? nodeById(state.doc, id) : null;
  return !!(n && (!n.children || n.children.length === 0));
}

function renderEmptyState() {
  const host = dom['empty-state'];
  if (!host) return;
  const empty = docIsEmpty();
  const blank = !empty && activeArtboardIsEmpty();
  host.hidden = !(empty || blank);
  host.dataset.kind = empty ? 'doc' : 'artboard';
  // карточка на холсте и приветствие в доке — один и тот же текст с одними чипами,
  // и стрелка «командная строка внизу» указывала на копию самой себя: носитель
  // остаётся один, и это карточка на холсте (п.6)
  if (!host.hidden && state.introOpen) hideMsg();
  if (host.hidden) return;

  dom['empty-title'].textContent = empty ? 'Скажите, что построить' : 'Артборд пуст';
  dom['empty-sub'].textContent = empty
    ? 'Агент соберёт макет и покажет, что сделал.'
    : 'Скажите, что должно быть на нём.';
  const list = empty ? EMPTY_EXAMPLES : ARTBOARD_EXAMPLES;
  const box = dom['empty-examples'];
  box.textContent = '';
  for (const ex of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'empty-example';
    b.textContent = ex;
    b.addEventListener('click', () => { dom.command.value = ex; dom.command.focus(); });
    box.appendChild(b);
  }
  dom['btn-empty-artboard'].hidden = !empty;
  if (blank) { if (!placeOverArtboard(activeArtboardId())) host.hidden = true; }
  else {
    host.removeAttribute('style');
    host.dataset.compact = 'false';
    // подсказка не должна нырять под док: отступ считаем по его настоящей высоте
    const inset = stageInsets();
    host.style.paddingBottom = `${Math.round((inset.bottom || 0) + 16)}px`;
  }
}

/**
 * Подсказку про пустой артборд держим над самим артбордом и обрезаем по видимой части
 * холста: иначе она вылезает на инспектор и на док (п.5).
 */
function placeOverArtboard(id) {
  const host = dom['empty-state'];
  const r = id && state.geo && state.geo.rects && state.geo.rects[id];
  if (!r || !stage || typeof stage.toScreen !== 'function') { host.removeAttribute('style'); return true; }
  try {
    const a = stage.toScreen(r.x, r.y);
    const b = stage.toScreen(r.x + r.w, r.y + r.h);
    const box = overlayBox();
    const span = (from, to, lo, hi, wish) => {
      const min = Math.min(wish, hi - lo);
      const start = Math.max(lo, Math.min(from, hi - min));
      const end = Math.min(hi, Math.max(to, start + min));
      return { start, size: Math.max(min, end - start) };
    };
    // мелкий артборд подсказку не вмещает: текст вылезал на соседей и на док
    if (b.x - a.x < 150 || b.y - a.y < 120) { host.removeAttribute('style'); return false; }
    const h = span(a.x, b.x, box.x, box.x + box.w, 150);
    const v = span(a.y, b.y, box.y, box.y + box.h, 110);
    host.dataset.compact = String(h.size < 260 || v.size < 210);
    host.style.left = `${Math.round(h.start)}px`;
    host.style.top = `${Math.round(v.start)}px`;
    host.style.width = `${Math.round(h.size)}px`;
    host.style.height = `${Math.round(v.size)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.padding = '16px';
    return true;
  } catch { host.removeAttribute('style'); return true; }
}

const MAX_TABS = 7;

function renderTabs() {
  const host = dom['artboard-tabs'];
  host.textContent = '';
  const list = artboards(state.doc);
  const activeId = activeArtboardId();
  host.dataset.mode = isNarrow() ? 'pick' : 'tabs';
  if (!list.length) return;

  // на узком экране ряд вкладок не помещается — но переключать экраны всё равно надо (п.6)
  if (isNarrow()) {
    const active = list.find((a) => a.id === activeId) || list[0];
    const b = document.createElement('button');
    b.className = 'tab pick';
    b.title = 'Выбрать артборд';
    b.setAttribute('aria-haspopup', 'dialog');
    const name = document.createElement('span');
    name.className = 'pick-name';
    name.textContent = active.name || 'Артборд';
    b.appendChild(name);
    if (list.length > 1) {
      const count = document.createElement('span');
      count.className = 'pick-count';
      count.textContent = String(list.length);
      b.appendChild(count);
    }
    b.appendChild(iconEl('chevron-down'));
    b.addEventListener('click', () => openArtboardList(list));
    host.appendChild(b);
    return;
  }

  let shown = list;
  let rest = [];
  if (list.length > MAX_TABS) {
    /* Окно вкладок — непрерывный кусок списка вокруг активного. Раньше показывались
       первые семь, а активный просто приписывался в конец: при 16 артбордах ряд шёл
       «3 4 5 6» и вдруг «18», и пропуск читался как пропажа экранов (круг 15, п.11). */
    const at = Math.max(0, list.findIndex((a) => a.id === activeId));
    const from = Math.max(0, Math.min(at - Math.floor((MAX_TABS - 1) / 2), list.length - MAX_TABS));
    shown = list.slice(from, from + MAX_TABS);
    rest = list.filter((a) => !shown.includes(a));
  }

  for (const ab of shown) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = ab.name || 'Артборд';
    b.title = ab.name || 'Артборд';
    b.setAttribute('aria-current', String(ab.id === activeId));
    b.addEventListener('click', () => { setSelection([ab.id]); fitView([ab.id]); });
    host.appendChild(b);
  }
  if (rest.length) {
    const more = document.createElement('button');
    more.className = 'tab more';
    more.textContent = `ещё ${rest.length}`;
    more.title = 'Показать остальные артборды';
    more.addEventListener('click', () => openArtboardList(rest));
    host.appendChild(more);
  }
}

/** Список артбордов: и для не поместившихся вкладок, и для узкого экрана. */
function openArtboardList(list) {
  const activeId = activeArtboardId();
  openSheet('Артборды', (body) => {
    for (const ab of list) {
      const b = document.createElement('button');
      b.className = 'btn subtle wide ablist';
      b.style.justifyContent = 'flex-start';
      b.setAttribute('aria-current', String(ab.id === activeId));
      b.textContent = ab.name || 'Артборд';
      if (ab.id === activeId) {
        const now = document.createElement('span');
        now.className = 'ablist-now';
        now.textContent = 'открыт';
        b.appendChild(now);
      }
      b.addEventListener('click', () => { closeSheet(); setSelection([ab.id]); fitView([ab.id]); });
      body.appendChild(b);
    }
  }, { size: 'auto', key: 'artboards' });
}

function activeArtboardId() {
  const first = state.selection[0];
  if (first) {
    let n = nodeById(state.doc, first);
    while (n && n.parent && n.parent !== state.doc.root) n = nodeById(state.doc, n.parent);
    if (n) return n.id;
  }
  const list = artboards(state.doc);
  return list.length ? list[0].id : null;
}

/* ------------------------------- рельс слоёв --------------------------------- */

/** Свёрнутые ветки: по умолчанию открыт только активный артборд. */
function collapsedSet() {
  if (!state.collapsed) {
    {
      // по умолчанию видно артборды и содержимое активного — не 77 строк
      const act = activeArtboardId();
      const set = new Set();
      for (const [id, n] of Object.entries(state.doc.nodes)) {
        if (!n || n.type === 'page' || id === act) continue;
        if ((n.children || []).length) set.add(id);
      }
      state.collapsed = set;
    }
  }
  return state.collapsed;
}
/** Свёрнутые ветки — свойство документа: у другого документа это чужие id (п.20). */
function saveCollapsed() {
  scheduleSave();
}
function setBranch(id, open) {
  const set = collapsedSet();
  if (open) set.delete(id); else set.add(id);
  saveCollapsed();
  renderLayers();
}

function renderLayers() {
  const host = dom.layers;
  const set = collapsedSet();
  // ветки над выделением всегда раскрыты — иначе строку не увидеть
  for (const id of state.selection) {
    for (const a of ancestors(state.doc, id)) set.delete(a.id);
    if (isArtboard(state.doc, id)) set.delete(id);   // выбрали артборд — показываем, что внутри
  }
  host.textContent = '';

  const rows = [];
  const walk = (id, depth) => {
    const n = nodeById(state.doc, id);
    if (!n) return;
    const isPage = n.type === 'page';
    if (!isPage) rows.push({ id, depth, node: n });
    const kids = n.children || [];
    if (!isPage && set.has(id)) return;
    for (const c of kids) walk(c, isPage ? 0 : depth + 1);
  };
  walk(state.doc.root, 0);

  if (!rows.length) {
    const note = document.createElement('div');
    note.className = 'layers-empty';
    note.textContent = 'Слоёв пока нет.';
    host.appendChild(note);
    host.removeAttribute('aria-activedescendant');
    return;
  }

  // roving tabindex: в табуляцию попадает ровно одна строка
  if (!rows.some((r) => r.id === state.railFocus)) {
    const sel = rows.find((r) => state.selection.includes(r.id));
    state.railFocus = sel ? sel.id : rows[0].id;
  }

  for (const r of rows) {
    const n = r.node;
    const row = document.createElement('div');
    row.className = 'layer';
    row.dataset.id = r.id;
    row.style.paddingLeft = `${6 + r.depth * 12}px`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(r.depth + 1));
    row.setAttribute('aria-selected', String(state.selection.includes(r.id)));
    row.tabIndex = r.id === state.railFocus ? 0 : -1;

    const kids = (n.children || []).length;
    const tw = document.createElement('button');
    tw.type = 'button';
    tw.className = 'twisty';
    tw.tabIndex = -1;
    if (kids) {
      const open = !set.has(r.id);
      row.setAttribute('aria-expanded', String(open));
      tw.setAttribute('aria-label', open ? 'Свернуть ветку' : 'Раскрыть ветку');
      tw.appendChild(iconEl(open ? 'chevron-down' : 'chevron-right'));
      tw.addEventListener('click', (e) => { e.stopPropagation(); setBranch(r.id, !open); });
    } else {
      tw.disabled = true;
      tw.setAttribute('aria-hidden', 'true');
    }

    const g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = glyphFor(n);
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = n.name || defaultName(n);
    nm.title = n.name || defaultName(n);
    row.append(tw, g, nm);
    if (n.override) {
      const t = document.createElement('span');
      t.className = 'tagpill'; t.textContent = 'вручную';
      row.appendChild(t);
    }
    // замечание раскладки держится, пока держится причина: тост уходит, значок — нет (п.5)
    const bad = state.issues.get(r.id);
    if (bad && bad.length) {
      const words = bad.map((x) => x.message).join(' · ');
      const t = document.createElement('span');
      t.className = 'tagpill warn';
      t.textContent = '!';
      t.title = words;
      t.setAttribute('role', 'img');
      t.setAttribute('aria-label', `Замечание раскладки: ${words}`);
      row.appendChild(t);
    }
    row.addEventListener('click', (e) => {
      state.railFocus = r.id;
      if (e.shiftKey) setSelection([...state.selection, r.id]);
      else setSelection([r.id]);
      /* Дерево перерисовалось, и строка под курсором — уже другой элемент: без этого
         фокус падал на <body> (круг 11, п.11). Фокус остаётся ЗДЕСЬ — и после мыши тоже.
         Круг 13 уводил его на холст ради Delete и сдвига стрелками, но тогда ArrowDown
         сразу после клика по слою — «следующий слой» для любого, кто смотрит на список —
         молча отцеплял узел от потока и ставил override (круг 15, п.7). Delete в рельсе
         обрабатывает onLayerKey своим обработчиком, так что удаление не потерялось. */
      focusLayerRow(r.id);
    });
    row.addEventListener('dblclick', () => fitView([r.id], { maxZoom: 1.5 }));
    row.addEventListener('keydown', (e) => onLayerKey(e, rows, r));
    host.appendChild(row);
  }
}

/**
 * Круг 16, п.13. Выделение перестраивало ВЕСЬ рельс: на 12 000 узлов это 12 000 строк
 * DOM со своими слушателями — отсюда 989 мс между кликом и следующим кадром. Само
 * выделение меняет в строке ровно два атрибута (aria-selected и roving tabindex), и
 * пока состав строк не меняется, столько и надо сделать. Полную перестройку оставляем
 * там, где состав меняется: рельсу надо раскрыть свёрнутую ветку над выделением, или
 * выделенной строки в списке нет вовсе.
 * @returns {boolean} удалось ли обойтись быстрым путём
 */
function updateLayerSelection() {
  const host = dom.layers;
  if (!host || !host.firstElementChild) return false;
  if (!state.doc || !state.doc.nodes) return false;
  const set = collapsedSet();
  for (const id of state.selection) {
    if (!nodeById(state.doc, id)) return false;
    for (const a of ancestors(state.doc, id)) if (set.has(a.id)) return false;
    if (isArtboard(state.doc, id) && set.has(id)) return false;
  }
  const rows = host.querySelectorAll('.layer');
  if (!rows.length) return false;
  const want = new Set(state.selection);
  let seen = 0;
  let hasFocus = false;
  for (const row of rows) {
    if (want.has(row.dataset.id)) seen += 1;
    if (row.dataset.id === state.railFocus) hasFocus = true;
  }
  if (seen !== want.size) return false;   // строка выделенного узла до списка не дошла
  if (!hasFocus) state.railFocus = state.selection[0] || rows[0].dataset.id;
  for (const row of rows) {
    const on = want.has(row.dataset.id);
    if ((row.getAttribute('aria-selected') === 'true') !== on) {
      row.setAttribute('aria-selected', String(on));
    }
    const focus = row.dataset.id === state.railFocus;
    if ((row.tabIndex === 0) !== focus) row.tabIndex = focus ? 0 : -1;
  }
  return true;
}

/**
 * Удалить узлы одной транзакцией. Общая дорога для инспектора и рельса: Delete в рельсе
 * не делал ничего и молчал об этом — удаление жило только на холсте (круг 11, п.13).
 */
function deleteNodes(ids) {
  const list = [...new Set((ids || []).filter((id) => nodeById(state.doc, id)))];
  if (!list.length) return false;
  // предок вместе с потомком: удаляем только корни, иначе операция повторяется впустую
  const roots = list.filter((id) => !ancestors(state.doc, id).some((a) => list.includes(a.id)));
  if (!roots.length) return false;
  const label = roots.length === 1
    ? `Удалить «${nodeTitleById(state.doc, roots[0])}»`
    : `Удалить ${roots.length} ${plural(roots.length, 'узел', 'узла', 'узлов')}`;
  // quiet: сообщение говорим тут сами — иначе их будет два, и разными словами (п.10)
  const r = commit(roots.map((id) => OPS.remove(id)), label, 'human', { quiet: true });
  if (!r.ok) return false;
  setSelection([]);
  /* Описание берём у движка — то же самое, что на холсте: было «Удалил «Шапка»» с
     холста и «Удалить «Строка статуса»» из рельса, будто это разные события (п.10). */
  const said = (r.tx && r.tx.human) || label;
  showMsg('plain', said, {
    note: 'Вернуть можно здесь или по Ctrl+Z.',
    ms: 9000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
  return true;
}

/** Клавиатура в дереве слоёв: стрелки ходят, Enter выделяет, Delete удаляет. */
function onLayerKey(e, rows, cur) {
  const idx = rows.findIndex((r) => r.id === cur.id);
  const focusRow = (i) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    state.railFocus = r.id;
    for (const el2 of dom.layers.querySelectorAll('.layer')) el2.tabIndex = el2.dataset.id === r.id ? 0 : -1;
    const el2 = dom.layers.querySelector(`.layer[data-id="${CSS.escape(r.id)}"]`);
    if (el2) { el2.focus(); el2.scrollIntoView({ block: 'nearest' }); }
  };
  const set = collapsedSet();
  const kids = (cur.node.children || []).length;

  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(idx + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(idx - 1); }
  else if (e.key === 'Home') { e.preventDefault(); focusRow(0); }
  else if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1); }
  else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (kids && set.has(cur.id)) { setBranch(cur.id, true); focusRow(idx); }
    else if (kids) focusRow(idx + 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (kids && !set.has(cur.id)) { setBranch(cur.id, false); focusRow(idx); }
    else {
      const parent = cur.node.parent;
      const pi = rows.findIndex((r) => r.id === parent);
      if (pi >= 0) focusRow(pi);
    }
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setSelection([cur.id]);
    focusRow(idx);   // дерево перерисовалось — без этого фокус падал на <body> (п.9)
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // то же, что Delete на холсте: удаляем выделенное, а если строка не выделена — её саму (п.13)
    e.preventDefault();
    const sel = state.selection.includes(cur.id) && state.selection.length ? state.selection : [cur.id];
    const near = (rows[idx + 1] || rows[idx - 1] || {}).id;
    if (!deleteNodes(sel)) return;
    if (near && nodeById(state.doc, near)) focusLayerRow(near);
    else if (dom['btn-rail']) dom['btn-rail'].focus();
  }
}

/** Поставить фокус на строку рельса: в табуляцию попадает ровно она. */
function focusLayerRow(id) {
  if (!dom.layers || !id) return;
  const el2 = dom.layers.querySelector(`.layer[data-id="${CSS.escape(id)}"]`);
  if (!el2) return;
  for (const other of dom.layers.querySelectorAll('.layer')) other.tabIndex = other === el2 ? 0 : -1;
  try { el2.focus({ preventScroll: true }); } catch { el2.focus(); }
}

/** Подвести рельс к выделенной строке. */
function revealLayerRow() {
  const id = state.selection[0];
  if (!id || !dom.layers) return;
  const row = dom.layers.querySelector(`.layer[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function glyphFor(n) {
  if (isArtboard(state.doc, n.id)) return '▣';
  return ({ frame: '▤', text: 'T', rect: '▭', ellipse: '◯', image: '⬚' })[n.type] || '•';
}
/**
 * Имя-заглушка берём у движка: у оболочки был свой список, и безымянный артборд
 * назывался на холсте «Артборд», а в имени файла и в рельсе — «Группа». Имя у одного
 * узла теперь одно (круг 13, п.11).
 */
function defaultName(n) {
  return placeholderName(state.doc, n);
}

/* -------------------------------- инспектор ---------------------------------- */

/**
 * Инспектор пересобирается целиком на каждую правку, и поле, которое человек только что
 * менял, пересоздаётся вместе с ним. Запоминаем, где был фокус и каретка, и возвращаем
 * их на то же поле: обработчик на change это терпит, а вот человек — нет (п.20).
 */
function inspFieldKey(el) {
  const grp = el.closest('.group');
  const head = grp && grp.querySelector('h4') ? grp.querySelector('h4').textContent : '';
  const rowEl = el.closest('.row');
  const lab = rowEl && rowEl.querySelector('label') ? rowEl.querySelector('label').textContent : '';
  return `${head}|${lab}|${el.tagName}|${el.type || ''}`;
}

function tagInspFields(body) {
  const seen = new Map();
  for (const f of body.querySelectorAll('input, textarea, select')) {
    const base = inspFieldKey(f);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    f.dataset.fkey = `${base}#${n}`;
  }
}

function grabInspFocus() {
  const body = dom['insp-body'];
  const a = document.activeElement;
  if (!body || !a || !body.contains(a) || !a.dataset || !a.dataset.fkey) return null;
  const memo = { key: a.dataset.fkey, start: null, end: null };
  try { memo.start = a.selectionStart; memo.end = a.selectionEnd; } catch { /* number не даёт каретку */ }
  return memo;
}

function restoreInspFocus(memo) {
  const body = dom['insp-body'];
  if (!memo || !body) return;
  const f = body.querySelector(`[data-fkey="${CSS.escape(memo.key)}"]`);
  if (!f) return;
  try { f.focus({ preventScroll: true }); } catch { f.focus(); }
  if (memo.start == null) return;
  try { f.setSelectionRange(memo.start, memo.end); } catch { /* тип поля не поддерживает каретку */ }
}

function renderInspector() {
  const body = dom['insp-body'];
  const keepFocus = grabInspFocus();
  const id = state.selection.length === 1 && !state.inspQuiet ? state.selection[0] : null;
  const node = id ? nodeById(state.doc, id) : null;
  if (dom.app.dataset.insp !== (node ? 'on' : 'off')) scheduleViewRecheck(240);
  dom.app.dataset.insp = node ? 'on' : 'off';
  syncPanelModes();   // инспектор занял или отдал колонку — пересчитать бюджет (круг 16, п.1)
  if (node && railIsDrawer() && dom.app.dataset.rail === 'on') setRail('off');
  // на узком экране лист инспектора и док вместе не оставляют холста: знакомство уступает
  if (node && isNarrow() && state.introOpen) hideMsg();
  dom.inspector.hidden = !node;
  if (!node) return;

  body.textContent = '';

  /* Одиночный клик по холсту выделяет самый глубокий узел — это поведение сцены, и мы
     его не меняем. Но выйти наружу человеку нужно: крошки ведут к кнопке, карточке,
     артборду за один щелчок (п.13). */
  const chain = ancestors(state.doc, node.id).filter((n) => n.type !== 'page').reverse();
  // шапка дублировала последнюю крошку, причём крошка обрезала имя (п.25): когда путь есть,
  // шапка называет род узла, а имя целиком живёт в крошке
  const kindWord = defaultName(node);
  const fullName = node.name || kindWord;
  dom['insp-title'].textContent = chain.length ? kindWord : fullName;
  dom['insp-title'].title = fullName;
  if (chain.length) {
    const crumbs = document.createElement('nav');
    crumbs.className = 'crumbs';
    crumbs.setAttribute('aria-label', 'Путь до узла');
    for (const a of chain) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb';
      b.textContent = a.name || defaultName(a);
      b.title = `Выделить «${a.name || defaultName(a)}» — узел снаружи`;
      b.addEventListener('click', () => setSelection([a.id]));
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      sep.setAttribute('aria-hidden', 'true');
      crumbs.append(b, sep);
    }
    const self = document.createElement('span');
    self.className = 'crumb now';
    self.textContent = fullName;
    self.title = fullName;
    crumbs.appendChild(self);
    body.appendChild(crumbs);
  }

  // что с этим узлом не так — там же, где его правят (п.5)
  const issues = state.issues.get(node.id);
  if (issues && issues.length) {
    const warn = document.createElement('p');
    warn.className = 'insp-issue';
    warn.setAttribute('role', 'status');
    warn.textContent = issues.map((x) => x.message).join(' · ');
    body.appendChild(warn);
  }

  body.appendChild(group('Имя', [
    field('input', node.name || '', (v) => setProp(node.id, 'name', v), 'Имя узла'),
  ]));

  if (node.type === 'text') {
    body.appendChild(group('Текст', [
      field('textarea', node.characters || '', (v) => setProp(node.id, 'characters', v), 'Текст узла'),
    ]));
    const st = typeof node.style === 'string' ? { token: node.style } : (node.style || {});
    body.appendChild(group('Типографика', [
      row('Стиль', selectField(Object.keys(state.doc.tokens.type), st.token || 'body',
        (v) => setProp(node.id, 'style', { ...st, token: v }), TYPE_LABELS)),
      row('Кегль', numberField(st.fontSize ?? tokenType(st.token).fontSize,
        (v) => setProp(node.id, 'style', { ...st, fontSize: v }))),
      row('Жирность', selectField(['400', '500', '600', '700'],
        String(st.fontWeight ?? tokenType(st.token).fontWeight),
        (v) => setProp(node.id, 'style', { ...st, fontWeight: Number(v) }), WEIGHT_LABELS)),
      row('Выключка', segField(['left', 'center', 'right'], node.align || 'left',
        (v) => setProp(node.id, 'align', v),
        ['left', 'center', 'right'].map((v) => TEXT_ALIGN_LABELS[v]))),
    ]));
  }

  if (node.type === 'frame') {
    const L = node.layout || {};
    body.appendChild(group('Раскладка', [
      row('Поток', segField(['column', 'row', 'none'], L.mode || 'column',
        (v) => setProp(node.id, 'layout.mode', v),
        ['column', 'row', 'none'].map((v) => MODE_LABELS[v]))),
      row('Зазор', numberField(L.gap ?? 0, (v) => setProp(node.id, 'layout.gap', v), { label: 'Зазор' })),
      row('Отступ', numberField(L.padding ? L.padding.t : 0, (v) => {
        setProp(node.id, 'layout.padding', { t: v, r: v, b: v, l: v });
      }, { label: 'Отступ' })),
      row('Выравн.', selectField(['start', 'center', 'end', 'stretch'], L.align || 'start',
        (v) => setProp(node.id, 'layout.align', v), ALIGN_LABELS)),
      row('Распред.', selectField(['start', 'center', 'end', 'between'], L.justify || 'start',
        (v) => setProp(node.id, 'layout.justify', v), JUSTIFY_LABELS)),
    ]));
  }

  if (node.size) {
    body.appendChild(group('Размер', [
      row('Ширина', sizeField(node, 'w')),
      row('Высота', sizeField(node, 'h')),
    ]));
  }

  if ('fill' in node || node.type === 'frame' || node.type === 'rect' || node.type === 'ellipse') {
    body.appendChild(group('Заливка', [swatches(node, 'fill', 'Заливка')]));
  }
  if (node.type === 'text') {
    body.appendChild(group('Цвет текста', [swatches(node, 'color', 'Цвет текста')]));
  }
  if ('radius' in node) {
    body.appendChild(group('Скругление', [
      numberField(node.radius ?? 0, (v) => setProp(node.id, 'radius', v), { label: 'Скругление' }),
    ]));
  }

  if (node.override) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Узел отсоединён: положение задано вручную и переживает правки агента.';
    const btn = document.createElement('button');
    btn.className = 'btn subtle small';
    btn.textContent = 'Вернуть в поток';
    btn.addEventListener('click', () => commit([OPS.set(node.id, 'override', undefined)], 'Вернуть в поток'));
    body.appendChild(group('Положение', [note, btn]));
  }

  const del = document.createElement('button');
  del.className = 'btn danger small';
  del.textContent = 'Удалить узел';
  del.addEventListener('click', () => deleteNodes([node.id]));
  body.appendChild(del);

  // поля получили устойчивые имена — и фокус с кареткой вернулись на своё место (п.20)
  tagInspFields(body);
  restoreInspFocus(keepFocus);
}

function tokenType(token) {
  return (state.doc.tokens.type && state.doc.tokens.type[token]) || { fontSize: 16, fontWeight: 400 };
}

function setProp(id, path, value) {
  commit([OPS.set(id, path, value)], 'Свойство');
}

function group(title, children) {
  const g = document.createElement('div');
  g.className = 'group';
  if (title) { const h = document.createElement('h4'); h.textContent = title; g.appendChild(h); }
  for (const c of children) g.appendChild(c);
  return g;
}
let fieldUid = 0;

/**
 * Дать контролу доступное имя. Поля инспектора шли без id, без label[for] и без
 * aria-label: для экранного диктора вся поверхность ручной правки звучала как
 * «поле ввода, пусто», хотя остальное приложение размечено (п.10).
 */
function nameControl(node, label, labelEl) {
  const name = String(label || '').trim();
  if (!node || !name) return;
  const tag = String(node.tagName || '');
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (labelEl) {
      if (!node.id) node.id = `insp-f${++fieldUid}`;
      labelEl.htmlFor = node.id;
    } else if (!node.getAttribute('aria-label')) {
      node.setAttribute('aria-label', name);
    }
    return;
  }
  // составной контрол (переключатель, размер, палитра) — группа со своим именем,
  // а поля внутри получают имя с приставкой: «Ширина: режим», «Ширина: значение»
  if (!node.getAttribute('role')) node.setAttribute('role', 'group');
  if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', name);
  for (const inner of node.querySelectorAll('input, select, textarea')) {
    if (inner.getAttribute('aria-label') || inner.id) continue;
    inner.setAttribute('aria-label', `${name}: ${inner.tagName === 'SELECT' ? 'режим' : 'значение'}`);
  }
}

function row(label, control) {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  nameControl(control, label, l);
  r.append(l, control);
  return r;
}
function field(kind, value, onChange, label) {
  const inp = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
  inp.className = 'field';
  inp.value = value;
  if (label) inp.setAttribute('aria-label', label);
  inp.addEventListener('change', () => onChange(inp.value));
  return inp;
}
/** Число в поле: без «1e-7» и без молчаливого нуля из «1e999» или пустоты (п.26). */
function numText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return String(Math.abs(r) < 0.01 ? 0 : r);
}

function numberField(value, onChange, opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : 0;
  const max = Number.isFinite(opts.max) ? opts.max : 100000;
  const inp = document.createElement('input');
  inp.className = 'field'; inp.type = 'number';
  inp.min = String(min); inp.max = String(max);
  inp.value = numText(value);
  if (opts.label) inp.setAttribute('aria-label', opts.label);
  inp.addEventListener('change', () => {
    const raw = inp.value.trim();
    const n = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      inp.value = numText(value);
      toast('Тут нужно число — оставил прежнее значение.', 'plain', 5000);
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== n) {
      toast(`Допустимо от ${numText(min)} до ${numText(max)} — поставил ${numText(clamped)}.`, 'plain', 6000);
    }
    inp.value = numText(clamped);
    onChange(clamped);
  });
  return inp;
}
function selectField(values, current, onChange, labels) {
  const s = document.createElement('select');
  s.className = 'field';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = (labels && labels[v]) || v;
    if (v === current) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function segField(values, current, onChange, labels) {
  const w = document.createElement('div');
  w.className = 'seg';
  values.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (labels && labels[i]) || v;
    b.setAttribute('aria-pressed', String(v === current));
    b.addEventListener('click', () => onChange(v));
    w.appendChild(b);
  });
  return w;
}
function sizeField(node, axis) {
  const spec = (node.size && node.size[axis]) || { mode: 'hug' };
  const wrap = document.createElement('div');
  wrap.className = 'row';   // ширина и сжатие — в styles.css: .row .row (п.10)
  const sel = selectField(['fixed', 'hug', 'fill'], spec.mode, (mode) => {  // подписи ниже
    const cur = state.geo.rects[node.id];
    const value = mode === 'fixed' ? Math.round(cur ? (axis === 'w' ? cur.w : cur.h) : 100) : undefined;
    setProp(node.id, `size.${axis}`, mode === 'fixed' ? { mode, value } : { mode });
  }, sizeLabels(axis));   // «во всю ширину» / «во всю высоту» — по оси (круг 16, хвост, п.1)
  wrap.appendChild(sel);
  if (spec.mode === 'fixed') {
    const num = numberField(spec.value ?? 0, (v) => setProp(node.id, `size.${axis}`, { mode: 'fixed', value: v }));
    // помечаем ось: пока тянут ручку, поле показывает то же, что живой бейдж (п.10)
    const inp = num.tagName === 'INPUT' ? num : num.querySelector('input');
    if (inp) { inp.dataset.sizeAxis = axis; inp.dataset.sizeNode = node.id; }
    wrap.appendChild(num);
  }
  return wrap;
}
/* ----------------------- живой размер при ресайзе ----------------------- */

/**
 * Пока тянут ручку, сцена рисует бейдж «335 × 210», а поля «Ширина» и «Высота» в
 * инспекторе продолжали показывать число от прошлой правки — два разных размера одного
 * узла на экране одновременно (круг 13, п.10). Слушаем жест сами: ручки сцены — это
 * элементы с data-handle, а бейдж лежит в разметке сцены. Числа только показываем;
 * документ по-прежнему меняет коммит сцены.
 */
let liveSize = false;

function initLiveSize() {
  if (!stage || !stage.el) return;
  const host = stage.el;
  /* Панорама колесом идёт мимо opts.onView сцены, и кнопка вида оставалась с прежним
     ответом: «Сейчас в кадре все артборды целиком», когда макет уже уехал под док
     (круг 13, п.7). Спрашиваем заново сами. */
  let viewTick = null;
  host.addEventListener('wheel', () => {
    clearTimeout(viewTick);
    viewTick = setTimeout(() => {
      if (!stage) return;
      updateZoomLabel(stage.view);
      updateFitButton();
    }, 90);
  }, { passive: true });
  host.addEventListener('pointerdown', (e) => {
    const h = e.target && e.target.dataset ? e.target.dataset.handle : null;
    if (h) liveSize = true;
  }, true);
  const stop = () => {
    if (!liveSize) return;
    liveSize = false;
    for (const inp of inspSizeInputs()) { inp.removeAttribute('data-live'); }
  };
  host.addEventListener('pointermove', () => { if (liveSize) paintLiveSize(); });
  globalThis.addEventListener('pointerup', stop, true);
  globalThis.addEventListener('pointercancel', stop, true);
}

function inspSizeInputs() {
  const body = dom['insp-body'];
  return body ? [...body.querySelectorAll('input[data-size-axis]')] : [];
}

function paintLiveSize() {
  const inputs = inspSizeInputs();
  if (!inputs.length || !stage || !stage.el) return;
  let size = null;
  for (const b of stage.el.querySelectorAll('.imago-badge')) {
    const m = /^(\d+)\s*×\s*(\d+)$/.exec((b.textContent || '').trim());
    if (m) { size = { w: m[1], h: m[2] }; break; }
  }
  if (!size) return;
  for (const inp of inputs) {
    if (inp === document.activeElement) continue;
    const v = inp.dataset.sizeAxis === 'w' ? size.w : size.h;
    if (inp.value !== v) inp.value = v;
    inp.dataset.live = 'on';
  }
}

/** Заливка приходит и строкой-токеном, и объектом {token} — читаем оба вида. */
function colorToken(value) {
  if (typeof value === 'string') return value;
  return (value && value.token) || null;
}

const SWATCH_NAMES = {
  canvas: 'холст', surface: 'карточка', surfaceAlt: 'подложка', line: 'линия',
  text: 'текст', muted: 'приглушённый', onAccent: 'на акценте',
  accent: 'акцент', accentSoft: 'акцент мягкий', accentInk: 'акцент тёмный',
  agent: 'агент', good: 'успех', warn: 'внимание',
};
const SWATCH_GROUPS = [
  ['Фоны', ['canvas', 'surface', 'surfaceAlt', 'line']],
  ['Текст', ['text', 'muted', 'onAccent']],
  ['Акценты', ['accent', 'accentSoft', 'accentInk', 'agent', 'good', 'warn']],
];

/**
 * Холст, карточка, подложка и линия в светлой палитре все белые — кружок не нёс никакой
 * информации, и выбор приходилось делать вслепую (круг 13, п.10). Поэтому у каждого
 * образца стоит его значение; круг 16, п.14 сделал это правилом без исключений.
 */
function swatches(node, prop, label) {
  const w = document.createElement('div');
  w.className = 'swatch-groups';
  w.setAttribute('role', 'group');
  w.setAttribute('aria-label', label || 'Цвет');
  const colors = state.doc.tokens.colors || {};
  const cur = colorToken(node[prop]);
  const used = new Set();

  const chip = (name) => {
    const hex = colors[name];
    if (!hex) return null;
    used.add(name);
    const b = document.createElement('button');
    b.className = 'swatch'; b.type = 'button';
    b.title = `${SWATCH_NAMES[name] || name} · ${hex}`;
    b.setAttribute('aria-pressed', String(name === cur));
    b.setAttribute('aria-label', `${SWATCH_NAMES[name] || name}, ${hex}`);
    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.style.background = hex;
    const cap = document.createElement('span');
    cap.className = 'swatch-name';
    cap.textContent = SWATCH_NAMES[name] || name;
    b.append(dot, cap);
    /* Значение стоит у КАЖДОГО свотча всегда. Круг 15 дописывал его всей группе, где
       нашлись близнецы (расстояние < 42), — и код то появлялся, то исчезал от самой
       палитры: после «сделай тёмную тему» «Текст» коды терял, а «Фоны» сохраняли, хотя
       человек ничего про коды не просил. Код — единственная точная примета цвета, и
       показывать его по настроению палитры значит делать интерфейс непредсказуемым
       (круг 16, п.14). */
    const val = document.createElement('span');
    val.className = 'swatch-val';
    val.textContent = String(hex).toUpperCase().replace(/^#/, '');
    b.appendChild(val);
    b.addEventListener('click', () => setProp(node.id, prop, { token: name }));
    return b;
  };

  for (const [title, names] of SWATCH_GROUPS) {
    const list = names.map(chip).filter(Boolean);
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'swatch-group';
    const h = document.createElement('span');
    h.className = 'swatch-group-title';
    h.textContent = title;
    g.appendChild(h);
    const rowEl = document.createElement('div');
    rowEl.className = 'swatches';
    for (const b of list) rowEl.appendChild(b);
    g.appendChild(rowEl);
    w.appendChild(g);
  }

  const restNames = Object.keys(colors).filter((n) => !used.has(n));
  if (restNames.length) {
    const g = document.createElement('div');
    g.className = 'swatch-group';
    const h = document.createElement('span');
    h.className = 'swatch-group-title';
    h.textContent = 'Прочее';
    const rowEl = document.createElement('div');
    rowEl.className = 'swatches';
    for (const n of restNames) { const b = chip(n); if (b) rowEl.appendChild(b); }
    g.append(h, rowEl);
    w.appendChild(g);
  }

  /* «Без заливки» была текстом по центру и на кнопку не походила вовсе (круг 11, п.16).
     Теперь это такой же выбор, как остальные: пилюля с перечёркнутым кружком, и по ней
     видно, что она сейчас выбрана. */
  const g = document.createElement('div');
  g.className = 'swatch-group';
  const rowEl = document.createElement('div');
  rowEl.className = 'swatches';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'swatch';
  none.setAttribute('aria-pressed', String(!cur));
  const dot = document.createElement('span');
  dot.className = 'swatch-dot none';
  const cap = document.createElement('span');
  cap.className = 'swatch-name';
  cap.textContent = prop === 'color' ? 'Без цвета' : 'Без заливки';
  none.append(dot, cap);
  none.title = cap.textContent;
  none.addEventListener('click', () => setProp(node.id, prop, undefined));
  rowEl.appendChild(none);
  g.appendChild(rowEl);
  w.appendChild(g);
  return w;
}

/* ------------------------------- команды агента ------------------------------- */

/**
 * Отправка команды: Enter в строке или нажатие «Выполнить». Остановить агента — задача
 * кнопки «Стоп»: Enter во время работы означал отмену и выбрасывал набранное (п.8).
 */
function submitCommand(opts = {}) {
  const text = dom.command.value.trim();
  if (text && !opts.variants && !opts.toModel) {
    /* Ответ на вопрос «агент занят» — не команда макету: «в очередь», «потом»,
       «заменить» раньше строили карточку, если вопрос успел закрыться сам (п.8). */
    if (answerBusyByWords(text)) { dom.command.value = ''; return; }
    /* Инструменты оболочки живут ВЫШЕ проверки занятости: «стоп» ради того и сказан,
       что агент работает, а раньше слово упиралось в вопрос «агент ещё занят» и после
       «Заменить» отвечало «Агент сейчас ничего не делает» (круг 15, п.3). */
    const shell = shellIntent(text);
    if (shell && (!state.running || SHELL_WHILE_BUSY.has(shell.kind))
        && applyShellIntent(shell, text)) {
      if (dom.command.value.trim() === text) dom.command.value = '';
      return;
    }
  }
  if (state.running) {
    if (text) askBusy(text, opts);
    else showMsg('plain', 'Агент ещё занят предыдущей командой.', {
      note: 'Остановить его можно кнопкой «Стоп».', ms: 6000,
    });
    return;
  }
  runUtterance(text, opts);
}

/**
 * Что оболочка делает сразу, даже пока агент занят: остановить, убрать варианты,
 * подвинуть вид, открыть шторку. Документ и область работы агента при этом не трогаем —
 * «отмени» и «покажи второй экран» по-прежнему спрашивают, доделать или заменить.
 */
const SHELL_WHILE_BUSY = new Set(['stop', 'variants-close', 'fit', 'zoom', 'sheet', 'rail', 'theme', 'export']);

/** Вернуть текст в строку — но только если человек не набрал туда своё (п.8). */
function restoreCommand(text, { focus = false } = {}) {
  const t = String(text || '').trim();
  if (!t || dom.command.value.trim()) return;
  dom.command.value = t;
  if (!focus) return;
  dom.command.focus();
  try { dom.command.setSelectionRange(t.length, t.length); } catch { /* поле не поддерживает */ }
}

function stopAgent() {
  if (!state.running) return;
  const lost = [...state.queue, state.pendingRun, chainRun].filter((r) => r && r.text);
  state.queue = [];
  state.pendingRun = null;
  chainRun = null;
  closeBusyChoice();
  state.running.abort();
  // очередь уходит вместе с текущей командой — молчать об этом нельзя (п.8)
  if (!lost.length) return;
  const names = lost.map((r) => `«${clip(r.text, 40)}»`).join(', ');
  const said = lost.length === 1
    ? `Команда ${names} не выполнена: остановил работу.`
    : `Не выполнены ${lost.length} ${plural(lost.length, 'команда', 'команды', 'команд')}: ${names}.`;
  addChat('agent', said);
  toast(said, 'plain', 9000);
}

/** Сколько команд ждут своей очереди: больше — значит вытесняем, и вслух. */
const QUEUE_MAX = 5;

/** Очередь словами — для второй строки сообщения. */
function queueLine() {
  const n = state.queue.length;
  if (!n) return '';
  if (n === 1) return `В очереди: «${clip(state.queue[0].text, 46)}»`;
  return `В очереди ${n} ${plural(n, 'команда', 'команды', 'команд')}: `
    + state.queue.map((q) => `«${clip(q.text, 24)}»`).join(', ');
}

/**
 * Поставить команду в очередь. Раньше очередь была одним слотом, и третья реплика
 * подряд затирала вторую молча (п.8). Вытеснение — только вслух.
 */
function enqueueRun(run, { silent = false } = {}) {
  if (!run || !run.text) return;
  state.queue.push({ text: run.text, variants: !!run.variants });
  while (state.queue.length > QUEUE_MAX) {
    const lost = state.queue.shift();
    const said = `Команда «${clip(lost.text, 60)}» не выполнена: в очереди уже ${QUEUE_MAX}.`;
    addChat('agent', said);
    toast(said, 'plain', 9000);
  }
  if (silent) return;
  showMsg('plain', 'Поставил в очередь — начну, как закончу текущую.', { note: queueLine(), ms: 7000 });
}

function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  const cut = `${t.slice(0, n - 1)}…`;
  // обрезка могла съесть закрывающую кавычку — дальше по строке всё съезжало в лапки
  const open = (cut.match(/«/g) || []).length;
  const close = (cut.match(/»/g) || []).length;
  return open > close ? `${cut}${'»'.repeat(open - close)}` : cut;
}

/** Текущий прогон прерван ради новой команды, а не кнопкой «Стоп». */
let replacingRun = false;

/** Ответы на вопрос «агент занят»: живут, пока вопрос на экране — и для голоса тоже (п.8). */
let busyChoice = null;
/**
 * Когда вопрос «агент занят» сошёл с экрана. Он закрывается и сам — агент успевает
 * доделать, пока человек договаривает, — и тогда «в очередь», «потом», «заменить»
 * становились обычной командой макету и строили карточку (круг 15, п.8). Несколько
 * секунд после закрытия такие слова получают ответ, а не отправляются в модель.
 */
let busyClosedAt = 0;
const BUSY_ECHO_MS = 4000;

/** Вопрос ушёл с экрана: ответы на него ещё недолго считаются ответами, а не командой. */
function closeBusyChoice() {
  if (busyChoice) busyClosedAt = Date.now();
  busyChoice = null;
}

/**
 * «В очередь», «потом», «заменить», набранные или сказанные. true — слово разобрано как
 * ответ, и командой макету оно не станет.
 */
function answerBusyByWords(text) {
  const how = busyFromWords(normSaid(text));
  if (!how) return false;
  if (how === 'closed' || !busyChoice || typeof busyChoice[how] !== 'function') {
    showMsg('plain', 'Вопрос уже закрыт — скажите команду заново.', {
      note: 'Агент освободился, пока вы отвечали.', ms: 6000,
    });
    return true;
  }
  busyChoice[how]();
  return true;
}

/**
 * Команда, которую нужно начать сразу, как отпустит текущий прогон. Раньше тут стоял
 * waitFree: он через 2,4 с звал команду независимо от того, освободился ли агент, и она
 * упиралась в тот же вопрос «агент занят» (круг 9, п.16). Теперь команду принимает сам
 * прогон в finally — очередь при этом не трогается и ждёт своего порядка (круг 9, п.17).
 */
let chainRun = null;

function chainAfterRun(text, { variants = false, note = '' } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!state.running) {
    if (note) toast(note, 'plain', 5000);
    runUtterance(t, { variants });
    return true;
  }
  chainRun = { text: t, variants: !!variants, note };
  if (note) toast(note, 'plain', 5000);
  return true;
}

/** Что запустить следующим, когда прогон отпустил агента: сначала сцепленное, потом очередь. */
function startNextRun() {
  const chained = chainRun;
  chainRun = null;
  if (chained && chained.text) {
    setTimeout(() => runUtterance(chained.text, { variants: chained.variants }), 60);
    return;
  }
  const next = state.queue.shift();
  if (!next || !next.text) return;
  const rest = state.queue.length;
  toast(`Агент освободился — начинаю: «${clip(next.text, 60)}»`
    + (rest ? ` · в очереди ещё ${rest}` : ''), 'plain', 6000);
  setTimeout(() => runUtterance(next.text, { variants: next.variants }), 60);
}

/**
 * Новая команда пришла, пока агент работает — голосом это случается постоянно.
 * Раньше она молча отменяла начатое; теперь решает человек (п.7).
 */
function askBusy(utterance, opts = {}) {
  // вопрос уже висел, а человек сказал ещё одну команду: прежнюю не затираем — она
  // уходит в очередь в том порядке, в котором её сказали (п.8)
  const held = state.pendingRun;
  const run = { text: utterance, variants: !!opts.variants };
  state.pendingRun = run;
  if (held && held.text) enqueueRun(held, { silent: true });
  restoreCommand(utterance);
  const mine = () => state.pendingRun === run;
  busyChoice = {
    replace: () => {
      if (!mine()) return;
      state.pendingRun = null;
      closeBusyChoice();
      hideMsg();
      // человек сам заменил команду: «Команда остановлена» мелькнуть не должно
      replacingRun = true;
      // новую команду принимает сам прерванный прогон, когда отпустит агента (п.16)
      chainAfterRun(run.text, { variants: run.variants });
      if (state.running) state.running.abort();
    },
    queue: () => {
      if (!mine()) return;
      state.pendingRun = null;
      closeBusyChoice();
      // пока человек думал, агент мог и закончить — тогда очередь ни к чему
      if (!state.running) { hideMsg(); runUtterance(run.text, { variants: run.variants }); return; }
      enqueueRun(run);
    },
    drop: () => {
      if (!mine()) return;
      state.pendingRun = null;
      closeBusyChoice();
      const said = `Команда «${clip(run.text, 60)}» не выполнена.`;
      addChat('agent', said);
      restoreCommand(run.text);
      showMsg('plain', said, { note: 'Текст остался в строке — отправьте, когда понадобится.', ms: 8000 });
    },
  };
  showMsg('question', 'Агент ещё занят предыдущей командой', {
    role: 'busy',
    note: [`Новая команда: «${clip(utterance, 70)}»`, queueLine()].filter(Boolean).join(' · '),
    actions: [
      { label: 'Заменить', primary: true, onClick: () => busyChoice && busyChoice.replace() },
      { label: 'В очередь', onClick: () => busyChoice && busyChoice.queue() },
      { label: 'Отменить новую', onClick: () => busyChoice && busyChoice.drop() },
    ],
  });
}

/**
 * Отмена и повтор как команда — голосом или от модели (res.action).
 * Транзакции не создаём: это перемотка истории, а не новая правка.
 */
function applyHistoryAction(action, utterance) {
  const back = action !== 'redo';
  const tx = back ? state.history[state.cursor - 1] : state.history[state.cursor];
  const what = tx ? (tx.human || tx.label) : '';
  const ok = back ? undo() : redo();
  if (utterance) addChat('you', utterance);
  if (ok) {
    const said = back
      ? (what ? `Отменил: ${what}` : 'Отменил последнюю правку')
      : (what ? `Вернул: ${what}` : 'Вернул правку');
    addChat('agent', said);
    if (utterance) rememberPair(utterance, said);
  } else {
    const why = back ? 'Отменять нечего — это самое начало.' : 'Возвращать нечего: впереди правок нет.';
    showMsg('plain', why, { ms: 7000 });
    addChat('agent', why);
  }
  return ok;
}

async function runUtterance(text, { variants = false, toModel = false } = {}) {
  const utterance = String(text || '').trim();
  if (!utterance) {
    /* Сюда приходит только пустая СТРОКА: нераспознанную речь голосовой путь до сюда
       не доводит. «Я не расслышал команду» в ответ на клик по «Выполнить» — неправда,
       а в артефакте микрофона нет вовсе (круг 11, п.5). */
    const examples = (docIsEmpty() ? EMPTY_EXAMPLES : ARTBOARD_EXAMPLES).slice(0, 2);
    const voice = dom['btn-mic'] && !dom['btn-mic'].disabled;
    showMsg('question', 'Напишите, что построить или изменить', {
      note: voice
        ? 'Строка внизу пуста. Можно и голосом — кнопка с микрофоном слева от строки.'
        : 'Строка внизу пуста — одна фраза, одна команда.',
      chips: examples.map((ex) => ({ text: ex, onClick: () => { dom.command.value = ex; dom.command.focus(); } })),
      ms: 9000,
    });
    dom.command.focus();
    return;
  }
  /* Инструменты оболочки — до модели и до проверки занятости: «покажи сводку недели»
     переключает артборд, а не отправляет задачу агенту. Работает и без подключённой
     модели: вписать, выделить, экспортировать можно всегда (круг 9, п.6). */
  if (!variants && !toModel) {
    const shell = shellIntent(utterance);
    if (shell && applyShellIntent(shell, utterance)) {
      if (dom.command.value.trim() === utterance) dom.command.value = '';
      return;
    }
  }

  if (!state.provider) {
    // раньше оболочка просто открывала настройки, и команда пропадала без слов (п.11)
    showMsg('warn', 'Агент не подключён — команда не отправлена', {
      note: 'Текст остался в строке. Выберите модель в настройках: Claude на этой странице '
        + 'или локальная LM Studio.',
      actions: [{ label: 'Настройки', primary: true, onClick: () => openSettings() }],
    });
    return;
  }
  // занятого агента молча не прерываем: спрашиваем, доделать или заменить (п.7)
  if (state.running) { askBusy(utterance, { variants }); return; }

  // «второй, но заголовок крупнее»: вариант принимаем и дорабатываем, а не выбрасываем (п.11)
  const pick = parseVariantPick(utterance);
  if (pick && takeVariantAndRefine(pick)) return;

  // строку очищаем в начале: пока агент работает, человек набирает следующую команду (п.8)
  if (dom.command.value.trim() === utterance) dom.command.value = '';

  const ctrl = new AbortController();
  const runId = ++state.runSeq;
  replacingRun = false;
  state.running = ctrl;
  state.awaitingClarify = null;   // переспрос закрыт: дальше отвечает уже этот прогон
  state.lastUtterance = utterance;
  state.stageGoal = '';
  state.stageSteps = [];
  state.variantSeen = [];
  hideMsg();
  if (!variants) hideVariants();
  setBusy(true);
  showStage({ stage: 'classify', label: 'Разбираю запрос', detail: utterance });

  // снимок, по которому агент считает: если человек правит руками, операции лягут не туда
  const baseStamp = docStamp(state.doc);

  try {
    if (variants) {
      const list = await runVariants({
        doc: state.doc, selection: state.selection, utterance,
        provider: state.provider, n: 3, signal: ctrl.signal,
        onStage: (rec) => onAgentStage(rec, 3, runId),
        history: state.pairs.slice(), geo: state.geo, activeArtboardId: activeArtboardId(),
        selectionBy: state.selectionBy,
      });
      hideStage();
      const all = (list || []).filter(Boolean);

      // отмена, ответ и переспрос приходят и сюда — раньше их выбрасывал фильтр по ops (п.11)
      const act = all.find((v) => v.action === 'undo' || v.action === 'redo');
      if (act) { applyHistoryAction(act.action, utterance); return; }
      const asked = all.find((v) => v.clarify);
      if (asked) { showClarify(asked, utterance); return; }
      const said = all.find((v) => v.answer && (!v.ops || !v.ops.length));
      if (said) { showAnswer(said, utterance); return; }
      // «так в этой модели документа нельзя» — ответ агента, а не сбой прогона (п.19)
      const no = all.find((v) => v.cannot && (!v.ops || !v.ops.length));
      if (no) { showCannot(no, utterance); return; }

      const ok = all.filter((v) => v.ops && v.ops.length && !v.error);
      if (!ok.length) {
        const bad = all.find((v) => v.error);
        if (bad && isCancelled(bad.error)) {
          if (replacingRun) { replacingRun = false; return; }
          restoreCommand(utterance);
          cancelledMsg(utterance);
          return;
        }
        restoreCommand(utterance);
        showMsg(bad ? 'error' : 'warn', bad ? humanError(bad.error) : 'Варианты ничего не меняют', {
          note: warnLine(bad ? bad.warnings : (all[0] && all[0].warnings))
            || 'Попробуйте сказать конкретнее — что именно поменять.',
          details: techDetails(bad ? bad.warnings : null, bad && bad.error, bad && bad.serviceNotes),
          actions: retryActions(bad && bad.error, utterance),
        });
        return;
      }
      if (docStamp(state.doc) !== baseStamp) { staleMsg(utterance); return; }
      // прогон могли остановить, пока считались раскладки вариантов: панель от снятой
      // команды на экране быть не должна — в одиночной ветке проверка есть, тут не было
      if (state.runSeq !== runId || ctrl.signal.aborted) return;
      showVariants(ok, utterance, baseStamp);
      return;
    }

    const res = await runCommand({
      doc: state.doc, selection: state.selection, utterance,
      provider: state.provider, signal: ctrl.signal,
      onStage: (rec) => onAgentStage(rec, 0, runId),
      history: state.pairs.slice(), geo: state.geo, activeArtboardId: activeArtboardId(),
      selectionBy: state.selectionBy,
    });
    hideStage();

    // brain распознал «отмени»/«верни как было» сам и просит выполнить это оболочке
    if (res.action === 'undo' || res.action === 'redo') {
      applyHistoryAction(res.action, utterance);
      return;
    }

    // «а можно иначе?» — модель просит показать варианты к прежней команде (п.11)
    if (res.action === 'variants') {
      addChat('you', utterance);
      askVariants(res, utterance);
      return;
    }

    if (res.error) {
      // остановил человек — это не авария, и красного блока тут быть не должно (п.6)
      if (isCancelled(res.error)) {
        if (replacingRun) { replacingRun = false; return; }
        restoreCommand(utterance);
        cancelledMsg(utterance);
        return;
      }
      // причину отказа приложение знает — и раньше молчало о ней (п.6)
      restoreCommand(utterance);
      showMsg('error', humanError(res.error), {
        note: warnLine(res.warnings),
        details: techDetails(res.warnings, res.error, res.serviceNotes),
        actions: retryActions(res.error, utterance),
      });
      return;
    }

    // агент не понял команду и переспрашивает — это вопрос, а не правка
    if (res.clarify) { showClarify(res, utterance); return; }

    // просьбу нельзя выполнить в этой модели документа: это ответ агента, и кнопке
    // «Повторить» тут не место — повтор ничего не изменит (п.19)
    if (res.cannot && (!res.ops || !res.ops.length)) { showCannot(res, utterance); return; }

    const followups = (res.followups || (res.plan && res.plan.followups) || []).slice(0, 3);

    if (res.answer && (!res.ops || !res.ops.length)) { showAnswer(res, utterance); return; }

    if (!res.ops || !res.ops.length) {
      restoreCommand(utterance);
      showMsg('warn', 'Агент не нашёл, что изменить', {
        note: warnLine(res.warnings) || 'Выделите узел или скажите, что именно поправить.',
        details: techDetails(res.warnings, null, res.serviceNotes),
        actions: [retryAction(utterance)],
      });
      return;
    }

    if (docStamp(state.doc) !== baseStamp) { staleMsg(utterance); return; }
    // прогон могли остановить, пока считалась раскладка: коммитить его уже нельзя (п.29)
    if (state.runSeq !== runId || ctrl.signal.aborted) return;

    // правка, которая ничего не изменила, — не «Готово»: ни подсветки, ни шага в истории (п.5)
    if (changesNothing(res)) {
      restoreCommand(utterance, { focus: true });
      // Круг 16: brain различает два случая. nothingToChange — «всё названное в макете уже так»:
      // повтор той же команды заведомо даст то же самое, поэтому «Повторить» тут не предлагаем,
      // а подсказываем переформулировать. Без этого поля правка просто легла не туда — повтор уместен.
      const already = res.nothingToChange === true;
      const why = warnLine(res.warnings)
        || (already
          ? 'Всё названное в макете уже так — скажите, что должно стать другим.'
          : 'Значения совпали с текущими — скажите точнее, что и где поправить.');
      addChat('you', utterance);
      addChat('agent', 'Ничего не изменилось', followups, why);
      rememberPair(utterance, already
        ? 'ничего не изменилось: в макете уже так'
        : 'ничего не изменилось: значения совпали с текущими');
      showMsg('warn', 'Ничего не изменилось', {
        note: why,
        details: techDetails(res.warnings, null, res.serviceNotes),
        chips: followups.map((f) => ({ text: String(f), onClick: () => { dom.command.value = String(f); dom.command.focus(); } })),
        actions: already ? [] : [retryAction(utterance)],
      });
      return;
    }

    const summary = (res.plan && (res.plan.summary || res.plan.title)) || 'Готово';
    const r = commit(res.ops, (res.plan && res.plan.title) || utterance, 'agent',
      { plan: res.plan, invisible: invisibleEdits(res) });
    if (!r.ok) return;

    // главная строка — что именно изменилось; слова агента уходят во вторую строку (п.2)
    const headline = r.tx.human || summary;
    const aside = summary && summary !== headline ? summary : '';
    // в память разговора кладём факт, а не намерение: иначе «верни как было» не на что опереть (п.12)
    rememberPair(utterance, headline);
    addChat('you', utterance);
    addChat('agent', headline, followups, aside);
    state.awaitingClarify = null;

    // часть просьбы невыполнима — об этом говорим вместе с тем, что всё-таки сделано (п.19)
    const partly = typeof res.cannot === 'string' ? res.cannot.trim() : '';
    if (partly) addChat('agent', partly);
    /* Круг 16, п.2. Тип сообщения определяет не «легла ли правка», а каким получился
       результат: правка легла, а документ стал белым по белому — это не успех.
       Жалобы валидатора поднимают сообщение в «внимание» и выносятся отдельной
       строкой, чтобы их нельзя было не дочитать. */
    const issue = issueLine(res.warnings);
    const note = [partly, aside, warnLine(res.warnings, { skipLayout: true })].filter(Boolean).join(' · ');
    if (issue) addChat('agent', issue);   // в «Историю → Диалог» тоже: раньше её там не было
    showMsg(issue ? 'warn' : 'result', headline, {
      issue,
      note,
      steps: planSteps(res.plan),
      details: techDetails(res.warnings, null, res.serviceNotes),
      chips: followups.map((f) => ({ text: String(f), onClick: () => { dom.command.value = String(f); dom.command.focus(); } })),
      actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
      undoTx: r.tx.id,
    });

    // выделяем то, что агент сделал: «а теперь синее» сможет опереться на выделение (п.11)
    selectTouched(r.diff);

    // вид доводим после сообщения: высота дока к этому моменту уже окончательная
    revealChange(r.diff);
  } catch (e) {
    hideStage();
    if (isCancelled(e)) {
      if (replacingRun) { replacingRun = false; return; }
      restoreCommand(utterance);
      cancelledMsg(utterance);
    } else {
      restoreCommand(utterance);
      showMsg('error', humanError(e), {
        note: '', details: techDetails(null, e), actions: [retryAction(utterance)],
      });
    }
  } finally {
    // прогон мог быть уже заменён другим: тогда состояние принадлежит новому (п.5)
    if (state.runSeq === runId) {
      state.running = null;
      setBusy(false);
      hideStage();
      // вопрос «доделать или заменить» человек мог не успеть закрыть: команда не должна
      // пропасть вместе с вопросом — агент свободен, начинаем её сами (п.9)
      const waiting = state.pendingRun;
      state.pendingRun = null;
      closeBusyChoice();
      if (waiting && waiting.text) {
        enqueueRun(waiting, { silent: true });
        if (dom.dockmsg && dom.dockmsg.dataset.role === 'busy') hideMsg();
      }
      startNextRun();
    }
  }
}

/**
 * Варианты попросили словами. Предмет просьбы brain отдаёт полем variantsSubject
 * («покажи три варианта ШАПКИ» → «Шапка»), и оболочка обязана его читать: раньше она
 * подставляла последнюю реплику человека, и «варианты шапки» считались к «сделай
 * заголовок экрана крупнее» (круг 9, п.2).
 */
function askVariants(res, utterance) {
  const subject = String((res && res.variantsSubject) || '').trim();
  const src = String((res && res.variantsOf) || '').trim();
  if (src) {
    chainAfterRun(src, { variants: true, note: `Считаю варианты к «${clip(src, 60)}»` });
    return;
  }
  if (subject) {
    // предмет назван, а что с ним делать — нет. Молча подставлять прошлую команду нельзя:
    // спрашиваем про сам предмет и подставляем готовые варианты команды
    const node = findNodeByName(subject);
    if (node) setSelection([node.id], { quiet: true });
    /* Фразу строим ВОКРУГ имени, а не склоняем имя: «оформи «Шапка» иначе» — это
       четыре несогласованных фразы подряд (круг 11, п.7). Человеку видно действие,
       а имя стоит в именительном рядом со словом «блок». */
    const chips = [
      { text: 'оформить иначе', cmd: `оформи иначе блок «${subject}»` },
      { text: 'сделать компактнее', cmd: `сделай компактнее блок «${subject}»` },
      { text: 'поменять раскладку', cmd: `поменяй раскладку в блоке «${subject}»` },
    ];
    showMsg('question', `Что сделать с блоком «${subject}»?`, {
      note: 'Скажите или выберите — посчитаю три решения по этой команде.',
      chips: chips.map((c) => ({ text: c.text, onClick: () => chainAfterRun(c.cmd, { variants: true }) })),
    });
    restoreCommand(`варианты для блока «${subject}»: `, { focus: true });
    return;
  }
  const prev = lastHumanUtterance(utterance);
  if (prev) {
    chainAfterRun(prev, { variants: true, note: `Считаю варианты к «${clip(prev, 60)}»` });
    return;
  }
  showMsg('question', 'К какой команде показать варианты?', {
    note: 'Скажите или напишите команду — покажу три решения.',
  });
  dom.command.focus();
}

/** Отмена: у неё много обличий — AbortError, kind/code «cancelled». */
function isCancelled(e) {
  if (!e) return false;
  if (typeof e === 'string') return false;
  return e.name === 'AbortError' || e.kind === 'cancelled' || e.code === 'cancelled';
}

/** Ответ агента на вопрос — и в одиночном прогоне, и среди вариантов (п.11). */
function showAnswer(res, utterance) {
  const followups = (res.followups || (res.plan && res.plan.followups) || []).slice(0, 3);
  addChat('you', utterance);
  addChat('agent', res.answer, followups);
  // ответ — тоже часть разговора: без него следующая реплика висит в воздухе (п.10)
  rememberPair(utterance, res.answer);
  state.awaitingClarify = null;
  showMsg('answer', res.answer, {
    chips: followups.map((f) => ({ text: String(f), onClick: () => { dom.command.value = String(f); dom.command.focus(); } })),
    actions: [{ label: 'Диалог', onClick: () => openHistory('chat') }],
  });
}

/**
 * «Так в этой модели документа нельзя» — поворот, тень, градиент, анимация. Это ответ,
 * а не авария: без красного блока, без «Повторить» (повтор ничего не изменит) и без
 * возврата текста в строку (круг 9, п.19).
 */
function showCannot(res, utterance) {
  const text = String((res && res.cannot) || '').trim() || 'Так в этом редакторе нельзя.';
  const followups = (res.followups || (res.plan && res.plan.followups) || []).slice(0, 3);
  addChat('you', utterance);
  addChat('agent', text, followups);
  rememberPair(utterance, text);
  state.awaitingClarify = null;
  showMsg('answer', text, {
    note: 'Повтор той же командой ничего не изменит — скажите, что сделать вместо этого.',
    chips: followups.map((f) => ({ text: String(f), onClick: () => { dom.command.value = String(f); dom.command.focus(); } })),
    actions: [{ label: 'Диалог', onClick: () => openHistory('chat') }],
  });
}

/** Переспрос агента: вопрос попадает и в память разговора, и в ожидание ответа (п.10). */
function showClarify(res, utterance) {
  const q = typeof res.clarify === 'string'
    ? res.clarify
    : (res.clarify.question || res.clarify.message || 'Уточните, что нужно сделать.');
  const options = (res.clarify && Array.isArray(res.clarify.options)) ? res.clarify.options : [];
  addChat('you', utterance);
  addChat('agent', q);
  // пара «вопрос агента → ответ человека» нужна модели: иначе ответ «сводку» ей не к чему привязать
  rememberPair(utterance, `переспросил: ${q}`);
  state.awaitingClarify = { question: q, base: utterance };
  renderHints();
  restoreCommand(utterance, { focus: true });   // текст возвращаем — человеку есть что дописать
  showMsg('question', q, {
    role: 'clarify',
    note: 'Допишите команду в строке внизу или скажите ответ голосом — я добавлю его к команде.',
    chips: options.map((o) => ({ text: String(o), onClick: () => appendCommand(String(o)) })),
  });
}

/**
 * Правки, легшие в документ, но ничего не изменившие на экране: brain отдаёт их списком
 * (geometryUnchanged). Человеку об этом уже сказано предупреждением, а оболочка помечает
 * ими строку истории — чтобы не выдавать такое за сделанную работу.
 */
function invisibleEdits(res) {
  const list = Array.isArray(res && res.geometryUnchanged) ? res.geometryUnchanged : [];
  return list.filter((x) => x && x.path).map((x) => ({ id: x.id, path: String(x.path) }));
}

/** Шаги плана модели — их и показываем: «видно, что агент собирается сделать» (п.17). */
function planSteps(plan) {
  const list = plan && Array.isArray(plan.steps) ? plan.steps : [];
  return list.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
}

/** Последняя реплика человека — к ней относятся «варианты» и «сделай иначе». */
function lastHumanUtterance(exclude) {
  const skip = String(exclude || '').trim();
  for (let i = state.chat.length - 1; i >= 0; i--) {
    const turn = state.chat[i];
    if (turn.role !== 'you') continue;
    if (skip && turn.text.trim() === skip) continue;
    return turn.text;
  }
  const p = state.pairs[state.pairs.length - 1];
  if (p && p.utterance && p.utterance.trim() !== skip) return p.utterance;
  return state.lastUtterance && state.lastUtterance.trim() !== skip ? state.lastUtterance : '';
}

/**
 * Правка применилась «в пустоту». brain говорит это фактом (nothingChanged), но проверяем
 * и сами: считать успехом то, чего не видно, нельзя (п.5).
 */
function changesNothing(res) {
  if (!res) return false;
  if (res.nothingChanged === true || res.changed === false) return true;
  const pv = res.preview;
  if (!pv || !pv.doc || !pv.geo || !state.geo) return false;
  try {
    if (hashGeometry(pv.geo) !== hashGeometry(state.geo)) return false;
  } catch { return false; }
  return docFingerprint(pv.doc) === docFingerprint(state.doc);
}

/** Отпечаток видимой части документа: узлы и токены, без служебной версии. */
/** Стабильная запись значения: ключи по алфавиту, undefined → null. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function docFingerprint(doc) {
  if (!doc || !doc.nodes) return '';
  const ids = Object.keys(doc.nodes).sort();
  const parts = ids.map((id) => `${id}=${stableJson(doc.nodes[id])}`);
  parts.push(`root=${doc.root}`, `tokens=${stableJson(doc.tokens || null)}`);
  return parts.join('|');
}

/** «второй, но заголовок крупнее» → номер варианта и то, что надо доделать. */
function parseVariantPick(text) {
  if (!state.variants || !dom.variants || dom.variants.hidden) return null;
  const low = String(text || '').toLowerCase().replace(/[«»"']/g, ' ').replace(/\s+/g, ' ').trim();
  // \w в JS — только латиница, поэтому кириллические окончания перечисляем сами
  const m = /^(?:вариант\s*)?(перв[а-яё]*|втор[а-яё]*|трет[а-яё]*|[1-9])(?![а-яёa-z0-9])[\s,.:;—-]*(.*)$/.exec(low);
  if (!m) return null;
  const word = m[1];
  const index = /^\d$/.test(word) ? Number(word) - 1
    : /^перв/.test(word) ? 0 : /^втор/.test(word) ? 1 : 2;
  const picks = state.variantPicks || [];
  if (index < 0 || index >= picks.length) return null;
  const rest = String(m[2] || '').replace(/^(?:но|а|и|только|плюс)\s+/, '').trim();
  return { index, rest, raw: String(text || '').trim() };
}

/** Принять вариант и, если сказано «но…», тут же доработать его поверх принятого (п.11). */
function takeVariantAndRefine({ index, rest }) {
  const pick = (state.variantPicks || [])[index];
  if (!pick) return false;
  const ok = pick.take();
  if (!ok) return true;   // вариант устарел — об этом уже сказано
  if (dom.command.value.trim() === rest) dom.command.value = '';
  if (rest) {
    toast(`Взял «${pick.label}» — дорабатываю: ${clip(rest, 50)}`, 'plain', 5000);
    setTimeout(() => runUtterance(rest), 90);
  }
  return true;
}

/**
 * Круг 16, п.11. След остановленного прогона. Строка в доке жила ровно 6 секунд и
 * исчезала сама, а в «Историю → Диалог» не попадала вовсе: через минуту после «Стоп»
 * от прогона не оставалось ничего — ни в доке, ни в разговоре. Теперь итог остановки
 * держится в доке наравне с любым другим итогом команды (закрывается крестиком и Esc)
 * и тем же фактом ложится в разговор, а сама команда возвращается в строку.
 */
function cancelledMsg(utterance) {
  const said = utterance ? `Команда «${clip(utterance, 60)}» остановлена` : 'Команда остановлена';
  addChat('agent', said);
  showMsg('plain', said);
}

function retryAction(utterance) {
  return { label: 'Повторить', primary: true, onClick: () => runUtterance(utterance) };
}

/**
 * Круг 16, п.9. «Повторить» там, где повтор заведомо даст то же самое, — обещание впустую:
 * «отмени скидку» → «Слой «Скидка» не найден», и повтор его не создаст. brain помечает
 * такие отказы полем error.retryable === false (см. toErrorInfo). Команда при этом
 * возвращается в строку — путь вперёд в том, чтобы её поправить, а не повторить.
 * nothingToChange эту кнопку убирает своей веткой (круг 16, ранее в этом же круге).
 */
function retryActions(err, utterance) {
  return err && err.retryable === false ? [] : [retryAction(utterance)];
}

/**
 * Причины отказа человеку — одной строкой, не больше двух. Порядок берём как есть:
 * brain упорядочил предупреждения по важности, наше дело — показать первые (п.7).
 */
/* Предупреждения, которые меняют понимание результата, и потому идут первыми: правка
   оформления легла на ВЕСЬ документ; шрифты в файл не встроились (круг 11, п.18). */
const LEAD_WARN = [
  /^Оформление документа общее/i,
  /начертани\S*\s.*не встро/i,
  /в PNG не встроились/i,
];

/* Круг 16, п.2. Замечания валидатора о КАЧЕСТВЕ результата brain помечает префиксом
   «Проверка макета:» (ранг 3 в WARN_RANKS) — это его контракт, и по нему мы отделяем
   «что получилось плохо» от «что агент сделал и чего не смог». Первое идёт своей
   строкой под заголовком и задаёт ТИП сообщения, второе остаётся припиской. */
const LAYOUT_WARN = /^\s*Проверка макета:/i;
const isLayoutWarn = (w) => LAYOUT_WARN.test(String(w || ''));

/** Жалобы на результат — человеческим языком, без служебного префикса. */
function issueLine(list) {
  const all = (Array.isArray(list) ? list : []).filter(isLayoutWarn).map(cleanWarn).filter(Boolean);
  return all.slice(0, 3).join(' · ');
}

/** Всё остальное: рассказ о правке, адресация, подстановки. */
function warnLine(list, opts = {}) {
  const src = opts.skipLayout
    ? (Array.isArray(list) ? list : []).filter((w) => !isLayoutWarn(w))
    : list;
  const all2 = (Array.isArray(src) ? src : []).map(cleanWarn).filter(Boolean);
  const lead = all2.filter((s2) => LEAD_WARN.some((re) => re.test(s2)));
  const rest = all2.filter((s2) => !lead.includes(s2));
  return [...lead, ...rest].slice(0, 2).join(' · ');
}

/** Служебные пометки агента: человеку они ничего не говорят, их место — «Подробности». */
const INTERNAL_WARN = [
  /^Починка не помогла/i,
  /^Починка не удалась/i,
  /^Первый ответ модели пришлось чинить/i,
  /^Правка ни на что не повлияла/i,   // это теперь заголовок сообщения, а не приписка
  /^Операции применились, но документ не изменился/i,
];

function cleanWarn(w) {
  let s = String(w || '').trim();
  if (!s) return '';
  if (INTERNAL_WARN.some((re) => re.test(s))) return '';
  s = s.replace(/^Проверка макета:\s*/i, '');
  // «выходит за «Шапка» на 22×0» — размер словами: «22×0» человеку не читается (п.7)
  s = s.replace(/на\s+(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/g,
    (all, w2, h2) => sizeWords(Number(String(w2).replace(',', '.')), Number(String(h2).replace(',', '.'))));
  return human(s);
}

function sizeWords(w, h) {
  const px = (v) => `${Math.round(v)} px`;
  const bits = [];
  if (w >= 0.5) bits.push(`${px(w)} по ширине`);
  if (h >= 0.5) bits.push(`${px(h)} по высоте`);
  return bits.length ? `на ${bits.join(' и ')}` : 'на доли пикселя';
}

/**
 * Внутренняя кухня: коды, сырой ответ модели, пометки о починке — под «Подробности» (п.7).
 * Круг 16: служебную бухгалтерию агента («Первый ответ модели пришлось чинить» и прочее)
 * brain отдаёт отдельным полем res.serviceNotes — в warnings её больше нет, и вылавливать
 * её регуляркой не нужно. INTERNAL_WARN остаётся для тех строк, что в warnings ещё живут.
 */
function techDetails(warnings, err, notes) {
  const bits = [];
  for (const n of (Array.isArray(notes) ? notes : [])) {
    const s = String(n || '').trim();
    if (s) bits.push(s);
  }
  for (const w of (Array.isArray(warnings) ? warnings : [])) {
    const s = String(w || '').trim();
    if (s && INTERNAL_WARN.some((re) => re.test(s)) && !bits.includes(s)) bits.push(s);
  }
  if (err && typeof err !== 'string') {
    if (err.code) bits.push(`код: ${err.code}`);
    if (err.kind && err.kind !== err.code) bits.push(`вид: ${err.kind}`);
    for (const line of providerDetails(err)) bits.push(line);
  }
  return bits.join('\n');
}

/* Где провайдеры прячут собственное объяснение отказа. Для наладки локальной LM Studio
   раскрывашка «код: upstream_error / вид: network» бесполезна: весь смысл — в этом
   тексте, а он проглатывался общей фразой «Сбой связи с моделью» (круг 9, п.10). */
const ERR_TEXT_KEYS = ['text', 'detail', 'details', 'body', 'response', 'raw', 'statusText', 'reason'];

function providerDetails(err) {
  const out = [];
  const seen = new Set([String(err.message || '').trim()]);
  const add = (label, value) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || seen.has(v) || out.length >= 4) return;
    seen.add(v);
    out.push(`${label}: ${v.length > 600 ? `${v.slice(0, 598)}…` : v}`);
  };
  if (Number.isFinite(err.status)) add('ответ сервера', `HTTP ${err.status}`);
  for (const k of ERR_TEXT_KEYS) if (err[k]) add('сообщение провайдера', String(err[k]));
  // BrainError оборачивает чужую ошибку: её текст лежит на cause/error/data
  for (const k of ['cause', 'error', 'data']) {
    const inner = err[k];
    if (!inner) continue;
    if (typeof inner === 'string') { add('сообщение провайдера', inner); continue; }
    if (typeof inner !== 'object') continue;
    add('сообщение провайдера', String(inner.message || ''));
    for (const k2 of ERR_TEXT_KEYS) if (inner[k2]) add('сообщение провайдера', String(inner[k2]));
  }
  return out;
}

/** Выделить созданное и изменённое: рельс, инспектор и голос начинают говорить об этом. */
function selectTouched(diff) {
  const ids = [...new Set([...(diff && diff.created || []), ...(diff && diff.changed || [])])]
    .filter((id) => state.doc.nodes[id]);
  if (!ids.length) return;
  setSelection(ids.slice(0, 40), { quiet: true, agent: true });
}

/** Документ изменился, пока агент считал: операции легли бы поверх другого макета. */
function staleMsg(utterance) {
  showMsg('error', 'Документ изменился, пока агент работал', {
    note: 'Правки считались по прежнему макету, поэтому я их не применил.',
    actions: [{ label: 'Пересчитать по новому макету', primary: true, onClick: () => runUtterance(utterance) }],
  });
}

function appendCommand(extra) {
  const base = dom.command.value.trim();
  dom.command.value = base ? `${base} ${extra}` : extra;
  dom.command.focus();
}

function rememberPair(utterance, summary) {
  state.pairs.push({ utterance, summary: summary || '' });
  while (state.pairs.length > 5) state.pairs.shift();
}

function addChat(role, text, followups, note) {
  const t = human(String(text || '').trim());
  if (!t) return;
  state.chat.push({
    role, text: t, at: Date.now(),
    note: human(String(note || '').trim()),
    followups: (followups || []).slice(0, 3),
  });
  while (state.chat.length > 100) state.chat.shift();
  scheduleSave();   // разговор хранится рядом с документом (п.12)
}

/**
 * Узкий экран: «3 варианта» не исчезает, а ужимается до значка с цифрой,
 * и то же самое доступно долгим нажатием на «Выполнить» (п.6).
 */
function applyCompact() {
  const v = dom['btn-variants'];
  if (!v) return;
  const narrow = isNarrow();
  v.textContent = '';
  v.classList.toggle('compact', narrow);
  if (narrow) {
    v.appendChild(iconEl('spark'));
    const n = document.createElement('span');
    n.textContent = '3';
    v.appendChild(n);
  } else {
    v.textContent = '3 варианта';
  }
  v.title = 'Три варианта одной командой (или удержите «Выполнить»)';
  v.setAttribute('aria-label', 'Три варианта одной командой');
}

let runHoldTimer = null;
let runHoldFired = false;

/** Удержание «Выполнить» — три варианта: на узком экране это второй путь к ним. */
function bindRunHold() {
  const run = dom['btn-run'];
  if (!run) return;
  const cancel = () => { clearTimeout(runHoldTimer); runHoldTimer = null; };
  run.addEventListener('pointerdown', () => {
    if (state.busy || run.disabled) return;
    runHoldFired = false;
    cancel();
    runHoldTimer = setTimeout(() => {
      runHoldFired = true;
      runUtterance(dom.command.value.trim(), { variants: true });
    }, 600);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) run.addEventListener(ev, cancel);
}

/**
 * Главная кнопка. Пока строка пуста, занятый агент делает её «Стоп»; как только человек
 * набрал новую команду, кнопка снова «Выполнить» и ведёт в тот же вопрос, что и Enter:
 * «Заменить / В очередь / Отменить новую». Раньше клик в этот момент отменял чужую
 * работу и не запускал набранное (круг 11, п.6). Остановить агента можно кнопкой
 * «Стоп» в строке состояния — она видна ровно пока агент работает.
 */
function paintRunButton() {
  const run = dom['btn-run'];
  if (!run) return;
  const typed = !!(dom.command && dom.command.value.trim());
  const stopping = state.busy && !typed;
  run.textContent = stopping ? 'Стоп' : 'Выполнить';
  run.classList.toggle('stop', stopping);
  run.title = stopping
    ? 'Остановить агента'
    : (state.busy ? 'Агент занят — спрошу, заменить команду или поставить в очередь' : 'Выполнить команду');
  run.disabled = state.busy ? false : !state.provider;
  // двух «Стоп» на экране быть не должно: кнопка в строке состояния нужна ровно тогда,
  // когда главная занята отправкой набранного (п.6)
  const stageStop = dom['btn-stage-stop'];
  if (stageStop) stageStop.hidden = !state.busy || stopping;
}

function setBusy(on) {
  state.busy = on;
  dom.app.dataset.busy = on ? 'on' : 'off';
  updateAgentDot();
  if (!on) runHoldFired = false;
  paintRunButton();
  dom['btn-variants'].disabled = on || !state.provider;
  renderHints();
}

/**
 * Отказ провайдера словами. Разные причины — разные тексты и разные действия:
 * «оборвалась связь» на превышенный лимит или не выданный доступ — это неправда (п.10).
 */
const ERROR_HINTS = {
  rate_limited: 'Подождите несколько секунд и повторите.',
  session_expired: 'Войдите в Claude заново и повторите команду.',
  not_declared: 'Перезагрузите страницу: способность модели пропала.',
  prompt_too_large: 'Выделите узел поменьше или скажите короче.',
  refused: 'Переформулируйте команду.',
  empty_completion: 'Попробуйте сказать то же самое короче.',
  schema: 'Попробуйте сформулировать короче и конкретнее.',
  network: 'Проверьте связь и повторите.',
  model: 'Попробуйте ещё раз или скажите иначе.',
};

/** Куда идти, если модель отказала не по-своему: это добавка к её собственным словам. */
const ERROR_WAYOUT = {
  not_granted: 'Можно работать и через локальную модель: настройки → LM Studio.',
  sampling_disabled: 'Можно работать через локальную модель: настройки → LM Studio.',
};

function humanError(e) {
  if (!e) return 'Что-то пошло не так';
  if (typeof e === 'string') return e;
  const code = typeof e.code === 'string' ? e.code : '';
  const kind = typeof e.kind === 'string' ? e.kind : '';
  if (kind === 'cancelled' || code === 'cancelled' || e.name === 'AbortError') return 'Команда остановлена';

  // собственное сообщение ошибки точнее любого общего: оно и есть первая строка
  const own = String(e.message || '').trim();
  let hint = '';
  if (!state.provider) {
    hint = 'Агент не подключён: откройте настройки и укажите модель.';
  } else if (state.providerKind === 'lmstudio' && (kind === 'network' || code === 'upstream_error')) {
    hint = `Проверьте, что LM Studio запущена на ${settings.lmstudio.baseUrl}.`;
  } else if (ERROR_WAYOUT[code]) {
    hint = ERROR_WAYOUT[code];
  } else if (!/попробуйте|проверьте|повторите|откройте|выделите|переформулируйте|войдите|подождите|перезагруз/i.test(own)) {
    /* Раньше совет добавлялся только к сообщениям короче 28 знаков, и «Ошибка модели:
       Failed to fetch» (29) оставалась без единого слова о том, что делать (круг 13,
       п.10). Теперь мера другая и честная: совет не нужен только там, где модель уже
       сама сказала, куда идти. */
    hint = ERROR_HINTS[code] || ERROR_HINTS[kind] || '';
  }

  const head = own || ERROR_HINTS[code] || ERROR_HINTS[kind] || 'Модель не ответила';
  // «Сеть недоступна: 503 Попробуйте ещё раз» — две разные мысли, слитые пробелом (п.8)
  return hint && hint !== head ? `${head.replace(/\s*[.:;]\s*$/, '')} · ${hint}` : head;
}

/* ------------------------- лента стадий и сообщения --------------------------- */

/** Стадия агента: держим цель из плана и показываем её вместе с текущим шагом. */
function onAgentStage(rec, variantsTotal = 0, runId = 0) {
  if (!rec) return;
  // опоздавшая стадия отменённого прогона снова показывала ленту, и она висела вечно (п.5)
  if (runId && runId !== state.runSeq) return;
  if (!state.running || state.running.signal.aborted) return;
  const plan = rec.plan || null;
  // план модели содержит шаги — и до сих пор оболочка их нигде не показывала (круг 11, п.17)
  const steps = (plan && Array.isArray(plan.steps) ? plan.steps : (Array.isArray(rec.steps) ? rec.steps : null));
  if (steps) state.stageSteps = steps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5);
  if (plan && (plan.title || plan.summary)) state.stageGoal = plan.title || plan.summary;
  else if (rec.stage === 'plan') state.stageGoal = rec.title || rec.detail || rec.label || state.stageGoal;
  if (rec.variant && !state.variantSeen.includes(rec.variant)) state.variantSeen.push(rec.variant);
  showStage(rec, variantsTotal);
}

/**
 * Внутренние имена намерений. Раньше по ним строилась строка «похоже на правку»;
 * теперь список нужен ровно затем, чтобы такую догадку в ленте НЕ показывать
 * (круг 13, п.10) — и чтобы служебное «edit» не проступало вместо неё.
 */
const INTENT_WORDS = {
  create: 'создание', edit: 'правку', theme: 'оформление', ask: 'вопрос',
  clarify: 'уточнение', undo: 'отмену', redo: 'возврат', variants: 'варианты',
};

function cleanStage(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // «edit — глагол изменения»: слева служебное имя, справа служебная причина
  /* Догадку о намерении оболочка больше не произносит: «Разбираю запрос — похоже на
     правку» на команде, которая через секунду оказывается созданием, — это лишний
     повод не поверить агенту. Само действие скажет за себя (круг 13, п.10). */
  const m = /^([a-z_]{2,12})\s+—\s+/i.exec(t);
  if (m && INTENT_WORDS[m[1].toLowerCase()]) return '';
  if (INTENT_WORDS[t.toLowerCase()]) return '';
  const parts = t.split(/\s+—\s+/).filter((p) => p && !/^[a-z_]{2,20}$/i.test(p.trim()));
  return human(parts.join(' — '));
}

function showStage(rec, variantsTotal = 0) {
  dom.stagebar.hidden = false;
  dom['stage-label'].textContent = human(state.stageGoal || 'Агент работает');
  const parts = [];
  if (variantsTotal && state.variantSeen.length) {
    parts.push(`вариант ${Math.min(state.variantSeen.length, variantsTotal)} из ${variantsTotal}`);
  }
  const goal = state.stageGoal || '';
  const step = [cleanStage(rec && rec.label), cleanStage(rec && rec.detail)]
    .filter(Boolean)
    .filter((s, i, all) => all.indexOf(s) === i && (!goal || !String(s).includes(goal)))
    .join(' — ');
  if (step) parts.push(step);
  dom['stage-detail'].textContent = parts.join(' · ');
  renderStageSteps();
}

/** Шаги плана: человек видит, что агент собирается сделать, пока он это делает (п.17). */
function renderStageSteps() {
  const host = dom['stage-steps'];
  if (!host) return;
  const list = (state.stageSteps || []).slice(0, 5);
  const sig = list.join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.textContent = '';
  if (!list.length) { host.hidden = true; return; }
  for (const st of list) {
    const li = document.createElement('li');
    li.textContent = human(st);
    li.title = st;
    host.appendChild(li);
  }
  host.hidden = false;
}

function hideStage() {
  dom.stagebar.hidden = true;
  if (dom['stage-steps']) { dom['stage-steps'].hidden = true; dom['stage-steps'].dataset.sig = ''; }
}

const MSG_ICON = {
  result: 'check', error: 'alert', answer: 'spark', question: 'ask', plain: 'spark', warn: 'alert',
};
let msgUndoTx = null;
/* Сообщение, которое живёт ровно до следующего шага истории: предложение отменить и
   отклик отмены/возврата. */
let msgTransient = false;
let msgTimer = null;

/**
 * Сообщение агента — там же, где человек печатал: под командной строкой, её шириной.
 * kind: result | error | answer | question | plain
 */
/** Слова без регистра и знаков — чтобы сравнить две фразы по сути. */
function gistKey(x) {
  return String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Одно и то же, сказанное дважды: подпись повторяет заголовок целиком или входит в него. */
function sameGist(a, b) {
  const x = gistKey(a);
  const y = gistKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length > 12 && y.includes(x)) || (y.length > 12 && x.includes(y));
}

function showMsg(kind, text, opts = {}) {
  if (!dom.dockmsg) { toast(text, kind === 'error' ? 'error' : 'plain'); return; }
  clearTimeout(msgTimer);
  /* Приветствие уступает место обычному сообщению. Его высоту камера, в отличие от
     прочих сообщений, СЧИТАЕТ (круг 13: оно часть первого экрана, и его закрытие —
     повод вписать заново). Но исчезает оно и вот так — попутно, от постороннего
     действия: Ctrl+Z ставит своё «Отменено — …», приветствие в 134 px сменяется
     строкой в 51 px, свободное поле вырастает на 18 %, и recheckView вписывает
     макет заново — масштаб прыгает 59 % → 72 % под человеком, который вида не трогал
     (круг 16, хвост, п.3). Поэтому здесь же переносим точку отсчёта камеры: место
     «изменилось» не потому, что что-то открылось или закрылось в раскладке.
     Закрытие приветствия РУКАМИ (крестик, Esc) идёт через hideMsg и по-прежнему
     вписывает заново — решение круга 13 в силе. */
  const swallowedIntro = state.introOpen && !opts.intro;
  if (swallowedIntro) { state.introOpen = false; renderHints(); }
  const host = dom.dockmsg;
  // вопрос «агент занят» сменился другим сообщением — отвечать на него уже нечем (п.8)
  if (host.dataset.role === 'busy' && opts.role !== 'busy') closeBusyChoice();
  host.dataset.role = opts.role || '';
  host.hidden = false;
  host.dataset.kind = kind;

  // ошибку экранный диктор читает сразу, остальное — в свою очередь
  host.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

  const mark = host.querySelector('.dockmsg-mark');
  mark.textContent = '';
  mark.appendChild(iconEl(MSG_ICON[kind] || 'spark'));

  const headText = human(text);
  dom['dockmsg-text'].textContent = headText;

  /* Круг 16, п.2. Что получилось плохо — своей строкой сразу под заголовком: в общей
     приписке эта фраза стояла третьей из трёх и уходила за многоточие, а единственным
     способом её дочитать был нативный title, недостижимый на тач-экране. */
  const issue = dom['dockmsg-issue'];
  const issueText = human(opts.issue || '');
  issue.textContent = issueText;
  issue.hidden = !issueText;

  const note = dom['dockmsg-note'];
  // заголовок ошибки и подпись часто приходят из разных мест одними и теми же словами:
  // второй раз читать то же самое незачем (круг 13, п.10)
  const noteText = sameGist(human(opts.note || ''), headText) ? '' : human(opts.note || '');
  note.textContent = noteText;
  note.title = noteText;   // подсказка остаётся для мыши, но дочитать можно и без неё
  note.hidden = !noteText;
  host.dataset.full = '';

  /* Шаги плана: модель их присылает, и до сих пор оболочка их нигде не показывала
     (круг 11, п.17). В ленте стадий их нет — brain не кладёт steps в запись стадии, —
     поэтому план виден там, где он точно нужен: рядом с итогом правки. */
  const bodyBox = host.querySelector('.dockmsg-body');
  const oldSteps = bodyBox.querySelector('.msg-steps');
  if (oldSteps) oldSteps.remove();
  const stepList = (opts.steps || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
  if (stepList.length) {
    const ol = document.createElement('ol');
    ol.className = 'msg-steps';
    ol.setAttribute('aria-label', 'План агента');
    for (const st of stepList) {
      const li = document.createElement('li');
      li.textContent = human(st);
      ol.appendChild(li);
    }
    bodyBox.insertBefore(ol, dom['dockmsg-chips']);
  }

  // коды, сырой ответ модели и пометки о починке — под «Подробности», а не в тексте (п.7)
  const oldDetails = bodyBox.querySelector('.dockmsg-details');
  if (oldDetails) oldDetails.remove();
  if (opts.details) {
    const d = document.createElement('details');
    d.className = 'dockmsg-details';
    const sum = document.createElement('summary');
    sum.textContent = 'Подробности';
    const pre = document.createElement('p');
    pre.textContent = String(opts.details);
    d.append(sum, pre);
    bodyBox.appendChild(d);
  }

  const chips = dom['dockmsg-chips'];
  chips.textContent = '';
  const chipList = (opts.chips || []).filter((c) => c && c.text);
  chips.hidden = !chipList.length;
  for (const c of chipList) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'msg-chip'; b.textContent = human(c.text);
    b.addEventListener('click', c.onClick);
    chips.appendChild(b);
  }

  const acts = dom['dockmsg-actions'];
  acts.textContent = '';
  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = a.primary ? 'btn accent small' : 'btn subtle small';
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    acts.appendChild(b);
  }

  syncMsgMore();
  // новая высота дока — новая точка отсчёта: приветствие ушло не по воле человека
  if (swallowedIntro) rememberView();

  msgUndoTx = opts.undoTx || null;
  msgTransient = !!opts.transient;
  if (opts.ms) msgTimer = setTimeout(hideMsg, opts.ms);
  // сообщение подняло док: свободная часть холста стала меньше — вид пересчитаем (п.12)
  scheduleViewRecheck();
}

/**
 * Круг 16, п.2. Обрезку тремя строками не снимаем — на 400 px длинная приписка
 * распухала бы на 226 px и выдавливала макет. Вместо этого рядом появляется
 * «Показать целиком»: ровно тогда, когда текст действительно обрезан. Раскрытый
 * текст ограничен 40vh и прокручивается — док не превращается в полотно.
 */
function syncMsgMore() {
  const host = dom.dockmsg;
  if (!host || host.hidden) return;
  const body = host.querySelector('.dockmsg-body');
  const old = body.querySelector('.dockmsg-more');
  if (old) old.remove();
  const clipped = () => ['dockmsg-issue', 'dockmsg-note']
    .map((k) => dom[k])
    .some((el) => el && !el.hidden && el.scrollHeight - el.clientHeight > 2);
  if (host.dataset.full !== 'on' && !clipped()) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dockmsg-more';
  const label = () => { b.textContent = host.dataset.full === 'on' ? 'Свернуть' : 'Показать целиком'; };
  label();
  b.addEventListener('click', () => {
    host.dataset.full = host.dataset.full === 'on' ? '' : 'on';
    label();
    scheduleViewRecheck();
  });
  // сразу под обрезанным текстом, а не в конце карточки: иначе кнопку ищут глазами
  const after = dom['dockmsg-note'] && !dom['dockmsg-note'].hidden ? dom['dockmsg-note'] : dom['dockmsg-issue'];
  if (after && after.parentNode === body) after.after(b); else body.appendChild(b);
}

function hideMsg() {
  clearTimeout(msgTimer);
  msgUndoTx = null;
  msgTransient = false;
  if (dom.dockmsg) {
    if (dom.dockmsg.dataset.role === 'busy') closeBusyChoice();
    // вопрос закрыли крестиком — отвечать уже не на что, и подсказки снизу возвращаются
    if (dom.dockmsg.dataset.role === 'clarify') state.awaitingClarify = null;
    dom.dockmsg.dataset.role = '';
    dom.dockmsg.hidden = true;
  }
  if (state.introOpen) state.introOpen = false;
  renderHints();
  // сообщение ушло — холста стало больше (п.12)
  scheduleViewRecheck();
}

/** Предложение отменить живёт ровно до следующего изменения истории. */
function dropUndoOffer() { if (msgUndoTx || msgTransient) hideMsg(); }

function showVariants(list, utterance, baseStamp) {
  const host = dom.variants;
  host.textContent = '';
  host.hidden = false;
  state.variants = list;
  state.variantsBase = baseStamp;
  state.variantPicks = [];
  state.variantFocus = 0;

  // честность: одинаковые варианты не выдаём за разные
  const groups = [];
  for (const v of list) {
    const sig = variantSignature(v);
    const same = groups.find((g) => g.sig === sig);
    if (same) same.dupes.push(v);
    else groups.push({ sig, v, dupes: [] });
  }

  host.dataset.count = String(groups.length);
  // колонка рядом с холстом, а не полотно поперёк него: макет остаётся виден целиком,
  // и вариант есть с чем сравнить (п.17)
  dom.app.dataset.variants = 'on';
  syncPanelModes();   // колонка вариантов забрала 352 px — пересчитать бюджет холста (круг 16, п.1)

  const head = document.createElement('div');
  head.className = 'variants-head';
  const ht = document.createElement('span');
  ht.className = 'variants-title';
  // «Получился один вариант» в узкой панели переносился на две строки и разваливал шапку (п.16)
  ht.textContent = groups.length === 1 ? 'Один вариант' : `Выберите вариант — их ${groups.length}`;
  // подсказка про клавиши занимала полшапки и обрезала заголовок: номер теперь стоит
  // на самой карточке, а строка о клавишах ушла в подсказку панели (п.16)
  host.title = groups.length === 1
    ? 'Взять вариант: клавиша 1 или Enter. Наведите — вариант встанет на холст целиком'
    : `Взять вариант: клавиши 1…${groups.length}, стрелки и Enter. Наведите — вариант встанет на холст целиком`;
  const close = document.createElement('button');
  close.className = 'btn ghost small';
  close.textContent = 'Закрыть';
  close.addEventListener('click', hideVariants);
  head.append(ht, close);
  host.appendChild(head);

  // превью кадрируем на изменённое: целый артборд в колонке ужимался до трети, и текст
  // 13 px превращался в 4 px — сравнить было нечего (круг 9, п.1)
  const maxTall = groups.length === 1 ? 1.7 : 1.25;
  /* Кадр у всех карточек общий — объединение того, что меняет каждый вариант. Разные
     кадры у соседних карточек не сравнить: глаз считает разницу кадра разницей решений. */
  const firstAb = groups.length ? variantArtboard(groups[0].v) : null;
  let sharedBox = null;
  if (firstAb && groups.every((g) => variantArtboard(g.v) === firstAb)) {
    for (const g of groups) {
      const b = variantDiffBox(g.v);
      if (!b) { sharedBox = null; break; }
      if (!sharedBox) { sharedBox = { ...b }; continue; }
      const x1 = Math.max(sharedBox.x + sharedBox.w, b.x + b.w);
      const y1 = Math.max(sharedBox.y + sharedBox.h, b.y + b.h);
      sharedBox.x = Math.min(sharedBox.x, b.x);
      sharedBox.y = Math.min(sharedBox.y, b.y);
      sharedBox.w = x1 - sharedBox.x;
      sharedBox.h = y1 - sharedBox.y;
    }
  }

  groups.forEach((g, i) => {
    const v = g.v;
    const take = () => acceptVariant(v, utterance);
    const card = document.createElement('div');
    card.className = 'variant';
    // выбор варианта работает и с клавиатуры: цифры, стрелки, Enter (п.7)
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.vindex = String(i);
    card.setAttribute('aria-label', `Вариант ${i + 1}: ${v.label || 'без названия'}`);
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;   // Enter на кнопке внутри уже сработал
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take(); }
    });
    state.variantPicks.push({ label: v.label || `Вариант ${i + 1}`, take });
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    try {
      const target = variantArtboard(v);
      const svg = target ? stage.toSVG(target, v.preview.doc, v.preview.geo) : '';
      const crop = target ? variantCrop(v, target, maxTall, target === firstAb ? sharedBox : null) : null;
      if (svg) {
        const node = svgToElement(svg);
        // без кадра (геометрия артборда не посчиталась) плашка осталась бы нулевой высоты
        if (!crop) {
          const r = (v.preview && v.preview.geo && v.preview.geo.rects || {})[target];
          if (r && r.w > 0 && r.h > 0) thumb.style.aspectRatio = `${px1(r.w)} / ${px1(r.h)}`;
        }
        if (crop) {
          // кадр по изменённому участку: артборд целиком в колонке нечитаем (п.1)
          node.setAttribute('viewBox', `${px1(crop.x)} ${px1(crop.y)} ${px1(crop.w)} ${px1(crop.h)}`);
          // превью занимает всю ширину карточки, высота — по форме кадра: раньше
          // 208 из 327 px ширины уходили в пустоту (п.1)
          thumb.style.aspectRatio = `${px1(crop.w)} / ${px1(crop.h)}`;
          if (crop.part) {
            // кадр обрывается посреди макета: край гасим, чтобы обрез читался как
            // «дальше продолжается», а не как сбой отрисовки (круг 11, п.9)
            thumb.dataset.part = '1';
            const tag = document.createElement('span');
            tag.className = 'thumb-part';
            tag.textContent = 'фрагмент';
            tag.title = `Показан изменённый участок «${nodeTitleById(v.preview.doc, target)}». Целиком — на холсте: наведите на карточку`;
            thumb.appendChild(tag);
          }
        }
        thumb.appendChild(node);
      }
    } catch { /* превью необязательно */ }
    const label = document.createElement('div');
    label.className = 'vlabel';
    const num = document.createElement('span');
    num.className = 'vnum';
    num.textContent = String(i + 1);
    num.title = `Клавиша ${i + 1}`;
    label.append(num, document.createTextNode(human(v.label || `Вариант ${i + 1}`)));
    const desc = document.createElement('div');
    desc.className = 'vdesc'; desc.textContent = human(describeVariant(v));
    // по превью выбрать нельзя было вовсе — теперь у карточки есть явная кнопка (п.3).
    // Яркой она становится только на карточке под курсором или под фокусом: двух главных
    // действий на экране быть не должно (круг 9, п.12) — остальное делает styles.css
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small take';
    btn.textContent = 'Взять этот';
    btn.setAttribute('aria-label', `Взять вариант «${v.label || `Вариант ${i + 1}`}»`);
    btn.addEventListener('click', (e) => { e.stopPropagation(); take(); });
    card.append(thumb, label, desc, btn);
    card.addEventListener('click', take);
    // наведение и фокус ставят вариант на основной холст целиком: выбирать по превью
    // размером с марку было нельзя (круг 9, п.1)
    card.addEventListener('pointerenter', () => peekVariant(v, i));
    card.addEventListener('pointerleave', unpeekVariant);
    card.addEventListener('focus', () => { state.variantFocus = i; if (!quietFocus) peekVariant(v, i); });
    card.addEventListener('blur', unpeekVariant);
    host.appendChild(card);
  });

  /* Фокус первой карточке нужен для клавиатуры, но предпросмотр он поднимать не должен:
     панель открывалась — и холст сразу показывал вариант, так что сравнить «было/стало»
     было не с чем (круг 11, п.10). Предпросмотр включает только сам человек. */
  const firstCard = host.querySelector('.variant');
  if (firstCard) {
    quietFocus = true;
    try { firstCard.focus({ preventScroll: true }); } catch { firstCard.focus(); }
    quietFocus = false;
  }

  // макет остаётся на виду: колонка отнимает ширину, и вид пересчитываем заново —
  // но после того, как сетка доедет, иначе считали бы по прежней ширине (п.17)
  const refit = state.lastFit;
  /* На узком экране вписывать нечего: лист вариантов забирает почти всю высоту, и целый
     макет в остатке — это 23% и нечитаемые буквы. Там честнее оставить прежний масштаб:
     виден верх макета, а выделенное подводит пересчёт вида (п.17).
     На широком — подводим холст к тому артборду, которого варианты касаются: при наведении
     на карточку он покажет вариант целиком, и сравнивать будет с чем (круг 9, п.1). */
  const focusAb = groups.length ? variantArtboard(groups[0].v) : null;
  if (!isNarrow() && focusAb && (state.geo.rects || {})[focusAb]) {
    setTimeout(() => { if (!dom.variants.hidden) fitView([focusAb], { padding: 40 }); }, 240);
  } else if (refit && !state.userView && !isNarrow()) {
    setTimeout(() => { if (!dom.variants.hidden) fitView(refit.ids, refit.opts); }, 240);
  } else scheduleViewRecheck();

  const dupes = groups.reduce((acc, g, i) => acc.concat(g.dupes.map(() => i + 1)), []);
  if (dupes.length) {
    const note = document.createElement('div');
    note.className = 'variants-note';
    // сноска говорит о скрытом и не спорит с числом в заголовке (круг 9, п.3)
    note.textContent = dupes.length === 1
      ? 'Ещё одно решение совпало с показанным — повтор скрыл.'
      : `Ещё ${dupes.length} ${plural(dupes.length, 'решение', 'решения', 'решений')} совпали с показанными — повторы скрыл.`;
    host.appendChild(note);
  }
}

/** Взять вариант по номеру — голосом или с клавиатуры. */
function takeVariant(i) {
  const pick = (state.variantPicks || [])[i];
  if (!pick || !dom.variants || dom.variants.hidden) return false;
  pick.take();
  return true;
}

/** Точка входа для голоса: «варианты» к последней команде или к названному предмету. */
function runVariantsForLast(from, subject = '') {
  const src = String(from || '').trim() || dom.command.value.trim();
  if (src) { runUtterance(src, { variants: true }); return; }
  askVariants({ variantsSubject: subject }, '');
}

function focusVariant(i) {
  const n = (state.variantPicks || []).length;
  if (!n) return;
  const idx = Math.max(0, Math.min(n - 1, i));
  state.variantFocus = idx;
  const card = dom.variants.querySelector(`.variant[data-vindex="${idx}"]`);
  if (card) card.focus();
}

function acceptVariant(v, utterance) {
  if (!state.variants) return false;   // вариант уже приняли — второй раз не применяем
  if (state.variantsBase != null && docStamp(state.doc) !== state.variantsBase) {
    hideVariants();
    staleMsg(utterance);
    return false;
  }
  hideVariants();
  const r = commit(v.ops, `${utterance} · ${v.label || 'вариант'}`, 'agent', { invisible: invisibleEdits(v) });
  if (!r.ok) return false;
  if (dom.command.value.trim() === String(utterance || '').trim()) dom.command.value = '';
  const fact = r.tx.human || describeVariant(v);
  rememberPair(utterance, fact);
  addChat('you', utterance);
  addChat('agent', `Принят вариант «${v.label || 'без названия'}»`, [], fact);
  showMsg('result', `Принят вариант «${v.label || 'без названия'}»`, {
    note: fact,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
  selectTouched(r.diff);
  revealChange(r.diff);
  return true;
}

/** Один знак после запятой: viewBox не место для «119.99999999». */
function px1(v) { return Math.round((Number(v) || 0) * 10) / 10; }

/**
 * Границы того, что вариант меняет, в мировых координатах. Берём геометрию варианта,
 * а для удалённого — прежнюю: иначе удаление нечего показывать.
 */
function variantDiffBox(v) {
  const after = (v.preview && v.preview.geo && v.preview.geo.rects) || {};
  const before = (state.geo && state.geo.rects) || {};
  const ids = new Set();
  for (const op of v.ops || []) {
    const id = op.op === 'create' ? (op.node && op.node.id) : op.id;
    if (id) ids.add(id);
    if (op.parent) ids.add(op.parent);
  }
  const list = [];
  for (const id of ids) {
    const r = finiteRect(after[id]) ? after[id] : before[id];
    if (finiteRect(r) && r.w > 0 && r.h > 0) list.push(r);
  }
  if (!list.length) return null;
  const x0 = Math.min(...list.map((r) => r.x));
  const y0 = Math.min(...list.map((r) => r.y));
  const x1 = Math.max(...list.map((r) => r.x + r.w));
  const y1 = Math.max(...list.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * Кадр превью в координатах артборда: изменённая область с полями, не уже трети артборда
 * и не выше maxTall ширин. Если изменилось почти всё — берём артборд целиком.
 * Возвращает {x, y, w, h, part}, где part — признак «это фрагмент, а не весь артборд» (п.1).
 */
function variantCrop(v, artboardId, maxTall = 1.4, shared = null) {
  const rects = (v.preview && v.preview.geo && v.preview.geo.rects) || {};
  const ab = rects[artboardId];
  if (!finiteRect(ab) || !(ab.w > 0) || !(ab.h > 0)) return null;
  const whole = { x: 0, y: 0, w: ab.w, h: ab.h, part: false };
  // один кадр на все карточки: разные кадры сравнивать нельзя, а панель для того и нужна
  const box = shared || variantDiffBox(v);
  const fitTall = (c) => {
    // слишком высокий кадр снова даёт нечитаемую мелочь: держим кадр вокруг центра правки
    const limit = c.w * maxTall;
    if (c.h <= limit) return c;
    const cy = c.y + c.h / 2;
    const h = limit;
    const y = Math.max(0, Math.min(Math.max(0, ab.h - h), cy - h / 2));
    return { ...c, y, h, part: true };
  };
  if (!box) return fitTall(whole);
  const pad = Math.max(16, Math.min(56, Math.min(ab.w, ab.h) * 0.06));
  let x = box.x - ab.x - pad;
  let y = box.y - ab.y - pad;
  let w = box.w + pad * 2;
  let h = box.h + pad * 2;
  // одно слово, раздутое на всю карточку, из макета вырвано: кадр не меньше трети артборда
  const minW = Math.min(ab.w, Math.max(200, ab.w / 3));
  const minH = Math.min(ab.h, Math.max(130, ab.h / 5));
  if (w < minW) { x -= (minW - w) / 2; w = minW; }
  if (h < minH) { y -= (minH - h) / 2; h = minH; }
  /* Кадр держим внутри артборда: то, что вылезло за его край, артборд обрезает сам —
     за краем рисовать нечего, и кадр там дал бы белое поле вместо макета. */
  w = Math.min(w, ab.w); h = Math.min(h, ab.h);
  x = Math.max(0, Math.min(x, ab.w - w));
  y = Math.max(0, Math.min(y, ab.h - h));
  // изменилось почти всё — честнее показать артборд, а не обрезок с непонятной рамкой
  if (w * h >= ab.w * ab.h * 0.78) return fitTall(whole);
  return fitTall(snapCropEdges({ x, y, w, h, part: true }, v, artboardId, ab, box));
}

/**
 * Край кадра не должен рассекать соседний узел тонкой полоской: 4–5 px низа чужой кнопки
 * по верхней кромке читаются как сбой отрисовки, а не как контекст (круг 11, п.9).
 * Полоску убираем совсем, если обрезано почти всё от узла, и показываем узел целиком,
 * если от него в кадр попало больше половины.
 */
const CROP_SLIVER = 12;

function snapCropEdges(crop, v, artboardId, ab, must) {
  const doc = (v.preview && v.preview.doc) || null;
  const rects = (v.preview && v.preview.geo && v.preview.geo.rects) || {};
  if (!doc) return crop;
  let ids = [];
  try { ids = subtreeIds(doc, artboardId) || []; } catch { return crop; }
  const boxes = [];
  for (const id of ids) {
    if (id === artboardId) continue;
    const r = rects[id];
    if (finiteRect(r) && r.w > 0 && r.h > 0) {
      boxes.push({ x0: r.x - ab.x, x1: r.x - ab.x + r.w, y0: r.y - ab.y, y1: r.y - ab.y + r.h });
    }
  }
  if (!boxes.length) return crop;
  const keep = must
    ? { x0: must.x - ab.x, x1: must.x - ab.x + must.w, y0: must.y - ab.y, y1: must.y - ab.y + must.h }
    : { x0: crop.x, x1: crop.x + crop.w, y0: crop.y, y1: crop.y + crop.h };

  /* Кромку двигаем только ВНУТРЬ кадра и не дальше изменённого участка: полоску прячем,
     а вот «впустить узел целиком» нельзя — кадр от этого растёт, и превью снова мельчает. */
  const cutLo = (val, axis, limit) => {
    let out = val;
    for (const b of boxes) {
      const a = b[`${axis}0`];
      const z = b[`${axis}1`];
      if (!(a < val && z > val)) continue;          // край рассекает узел
      if (z - val > CROP_SLIVER) continue;          // видно достаточно — это контекст
      out = Math.max(out, Math.min(z, limit));
    }
    return out;
  };
  const cutHi = (val, axis, limit) => {
    let out = val;
    for (const b of boxes) {
      const a = b[`${axis}0`];
      const z = b[`${axis}1`];
      if (!(a < val && z > val)) continue;
      if (val - a > CROP_SLIVER) continue;
      out = Math.min(out, Math.max(a, limit));
    }
    return out;
  };
  const y0 = Math.max(0, Math.min(cutLo(crop.y, 'y', keep.y0), keep.y0));
  const y1 = Math.min(ab.h, Math.max(cutHi(crop.y + crop.h, 'y', keep.y1), keep.y1));
  const x0 = Math.max(0, Math.min(cutLo(crop.x, 'x', keep.x0), keep.x0));
  const x1 = Math.min(ab.w, Math.max(cutHi(crop.x + crop.w, 'x', keep.x1), keep.x1));
  if (!(x1 - x0 > 8) || !(y1 - y0 > 8)) return crop;
  return { ...crop, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Вариант, который сейчас стоит на холсте вместо документа. */
let peekIndex = -1;

/** Фокус ставим мы сами (открытие панели) — предпросмотр при этом не поднимаем (п.10). */
let quietFocus = false;

/**
 * Показать вариант на основном холсте в полный размер. Выбирать по превью 119 px нельзя,
 * а холст всё время показывал исходный макет (круг 9, п.1). Документ при этом не меняется:
 * это только отрисовка, и жесты по холсту на время предпросмотра выключены.
 */
function peekVariant(v, i) {
  if (!v || !state.variants || !stage) return;
  const pv = v.preview;
  if (!pv || !pv.doc || !pv.geo || !pv.geo.rects) return;
  if (peekIndex === i) return;
  peekIndex = i;
  try { stage.render(pv.doc, pv.geo, { selection: [] }); }
  catch { peekIndex = -1; return; }
  dom.app.dataset.peek = 'on';
  if (dom.peekbar) {
    dom.peekbar.hidden = false;
    dom['peekbar-text'].textContent = `Вариант ${i + 1}${v.label ? ` · ${human(v.label)}` : ''} — предпросмотр`;
  }
}

/** Вернуть на холст настоящий документ. */
function unpeekVariant() {
  if (peekIndex < 0) return;
  peekIndex = -1;
  dom.app.dataset.peek = 'off';
  if (dom.peekbar) dom.peekbar.hidden = true;
  try { stage.render(state.doc, state.geo, { selection: state.selection }); }
  catch { /* холст перерисует следующая правка */ }
}

/** Подпись варианта числами: что именно в нём другое. */
const NUM_LABELS = { gap: 'зазор', t: 'отступ', radius: 'скругление', fontSize: 'кегль', value: 'размер' };

function describeVariant(v) {
  const list = v.ops || [];
  const created = list.filter((o) => o.op === 'create').length;
  const removed = list.filter((o) => o.op === 'remove').length;
  const changed = new Set(list.filter((o) => o.op === 'set' || o.op === 'move').map((o) => o.id)).size;

  const nums = new Map();
  for (const o of list) {
    if (o.op !== 'set') continue;
    const value = typeof o.value === 'number' ? o.value : (o.value && typeof o.value.t === 'number' ? o.value.t : null);
    if (value == null) continue;
    const key = String(o.path || '').split('.').pop();
    const label = NUM_LABELS[key];
    if (!label || nums.has(label)) continue;
    const before = readPath(nodeById(state.doc, o.id), o.path);
    const beforeNum = typeof before === 'number' ? before : (before && typeof before.t === 'number' ? before.t : null);
    nums.set(label, beforeNum != null && beforeNum !== value ? `${beforeNum} → ${value}` : String(value));
  }

  const bits = [...nums].slice(0, 2).map(([k, val]) => `${k} ${val}`);
  if (created) bits.push(`+${created} ${plural(created, 'узел', 'узла', 'узлов')}`);
  /* Круг 16, п.8: «1 узел правлено» — род не согласован. Ставим глагол впереди, тогда
     согласуются все три формы: «изменён 1 узел», «изменены 2 узла», «изменено 5 узлов». */
  if (changed) {
    bits.push(`${plural(changed, 'изменён', 'изменены', 'изменено')} ${changed} `
      + plural(changed, 'узел', 'узла', 'узлов'));
  }
  if (removed) bits.push(`−${removed} ${plural(removed, 'узел', 'узла', 'узлов')}`);
  return bits.length ? bits.join(' · ') : 'без изменений';
}

function readPath(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Подпись-отпечаток варианта: сперва геометрия результата, если её посчитали. */
/** Узлы, которых коснулись операции варианта (созданное поддерево — целиком). */
function touchedIds(list) {
  const ids = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.id) ids.add(n.id);
    for (const c of n.children || []) { if (typeof c === 'string') ids.add(c); else walk(c); }
  };
  for (const op of Array.isArray(list) ? list : []) {
    if (op.id) ids.add(op.id);
    if (op.parent) ids.add(op.parent);
    if (op.node) walk(op.node);
  }
  return [...ids].sort();
}

/**
 * Круг 16, п.3. Подпись варианта: по ней оболочка решает, что два варианта — повтор.
 * Раньше это был ОДИН хэш геометрии, и всё, что геометрию не двигает — скругление,
 * заливка, обводка, прозрачность, отступ вокруг центрированного ребёнка, — давало
 * одинаковую подпись. Три честно разных решения («скругление 4 / 12 / 28», ровно те оси,
 * по которым brain разводит характеры вариантов) схлопывались в одну карточку, и человек
 * читал «Ещё 2 решения совпали с показанными» — заявление ложное, а двух настоящих
 * альтернатив он лишался.
 *
 * Теперь подпись собрана из того, чем варианты и отличаются:
 *   g: геометрия — структурные различия (созданные, удалённые, переставленные узлы);
 *   n: состояние узлов, которых вариант коснулся, — цвет, скругление, обводка, отступы;
 *   t: токены документа — характеры меняют defaults.radius и акцентный цвет.
 * Буквальный повтор совпадает по всем трём частям и по-прежнему схлопывается.
 */
function variantSignature(v) {
  const parts = [];
  try {
    if (v.preview && v.preview.geo) parts.push('g:' + hashGeometry(v.preview.geo));
  } catch { /* геометрия не обязательна */ }
  const doc = v.preview && v.preview.doc;
  if (doc && doc.nodes) {
    try {
      const ids = touchedIds(v.ops);
      parts.push('n:' + ids.map((id) => `${id}=${doc.nodes[id] ? stableJson(doc.nodes[id]) : '-'}`).join('|'));
      parts.push('t:' + stableJson(doc.tokens || null));
    } catch { /* опустимся до операций */ }
  }
  if (parts.length) return parts.join('||');
  try { return 'o:' + JSON.stringify(v.ops); } catch { return 'r:' + Math.random(); }
}

/** Какой артборд показывать в превью варианта: тот, где вариант что-то поменял. */
function variantArtboard(v) {
  const doc = v.preview && v.preview.doc;
  if (!doc) return null;
  const touched = [];
  for (const op of v.ops || []) {
    const id = op.op === 'create' ? (op.node && op.node.id) : op.id || op.parent;
    if (id && doc.nodes[id]) touched.push(id);
  }
  for (const id of touched) {
    if (isArtboard(doc, id)) return id;
    const ab = ancestors(doc, id).find((n) => n.parent === doc.root);
    if (ab) return ab.id;
  }
  const abs = artboards(doc);
  const active = stage.activeArtboard && doc.nodes[stage.activeArtboard] ? stage.activeArtboard : null;
  return active || (abs.length ? abs[0].id : null);
}

function hideVariants() {
  unpeekVariant();
  const was = !dom.variants.hidden;
  dom.variants.hidden = true;
  dom.app.dataset.variants = 'off';
  syncPanelModes();   // место освободилось — инспектор и рельс возвращают колонки (круг 16, п.1)
  if (was) scheduleViewRecheck();
  state.variants = null;
  state.variantsBase = null;
  state.variantPicks = [];
  state.variantFocus = 0;
}

function svgToElement(markup) {
  const parser = new DOMParser();
  const d = parser.parseFromString(markup, 'image/svg+xml');
  const node = d.documentElement;
  node.removeAttribute('width'); node.removeAttribute('height');
  node.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return node;
}

/* ---------------------- инструменты оболочки словами ------------------------- */
/**
 * Человек наблюдает за макетом и говорит. Но переключить видимый артборд, вписать,
 * приблизить, выделить слой, экспортировать, открыть историю голосом было нельзя — всё
 * уходило в модель правкой макета, а «отмени два раза» вообще считалось созданием
 * (круг 9, п.6). Это дешёвые правила рядом с BUSY_WORDS и VARIANT_WORDS, и они же
 * работают для набранной команды: активный артборд задаёт область работы агента,
 * и выбирать её надо словами.
 */

/** Реплика в один вид: без знаков, в нижнем регистре, одиночные пробелы. */
function normSaid(text) {
  return String(text || '').toLowerCase()
    .replace(/[.,!?;:…"«»()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Слово без окончания: «сводку» и «Сводка» должны сойтись. */
function stemWord(w) {
  const s = String(w || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
  return s.length > 4 ? s.slice(0, s.length - 2) : s;
}

/* Слова, которые в имени слоя ничего не различают: по ним нельзя опознать предмет. */
const SAID_STOP = new Set([
  'на', 'в', 'к', 'по', 'для', 'и', 'а', 'с', 'со', 'у', 'из', 'от', 'до', 'же', 'мне',
  'это', 'этот', 'эта', 'эту', 'том', 'тот', 'пожалуйста', 'давай', 'теперь',
  'артборд', 'артборде', 'артборда', 'экран', 'экране', 'экрана', 'экраном',
  'макет', 'макете', 'макета', 'страницу', 'страница', 'странице', 'вкладку', 'вкладка',
  'слой', 'слоя', 'слое', 'узел', 'узла', 'элемент', 'элемента',
]);

function saidWords(s, drop = true) {
  const list = String(s || '').toLowerCase().replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return drop ? list.filter((w) => !SAID_STOP.has(w)) : list;
}

/**
 * Насколько сказанное похоже на имя слоя: 0 — не похоже. Все значимые слова фразы
 * должны найтись в имени; чем меньше в имени лишнего, тем выше оценка.
 */
function nameMatches(name, phrase) {
  const want = saidWords(phrase).map(stemWord).filter((w) => w.length >= 3);
  if (!want.length) return 0;
  const have = saidWords(name, false).map(stemWord).filter(Boolean);
  if (!have.length) return 0;
  let hits = 0;
  for (const w of want) {
    if (have.some((h) => h === w || h.startsWith(w) || w.startsWith(h))) hits += 1;
  }
  if (hits < want.length) return 0;
  return hits / Math.max(want.length, have.length);
}

/** Артборды, чьё имя похоже на сказанное — лучшие первыми. */
function artboardsByName(phrase) {
  return artboards(state.doc)
    .map((a) => ({ node: a, score: nameMatches(a.name || '', phrase) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.node);
}

/** Узлы, чьё имя похоже на сказанное. Внутри активного артборда — дороже. */
function nodesByName(phrase, { artboardsToo = true } = {}) {
  const act = activeArtboardId();
  const inside = act ? new Set(subtreeIds(state.doc, act)) : new Set();
  const out = [];
  for (const [id, n] of Object.entries(state.doc.nodes)) {
    if (!n || n.type === 'page') continue;
    if (!artboardsToo && isArtboard(state.doc, id)) continue;
    const score = nameMatches(n.name || defaultName(n), phrase);
    if (!score) continue;
    out.push({ id, node: n, score: score + (inside.has(id) ? 0.5 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Один узел по имени — для предмета просьбы о вариантах (п.2). */
function findNodeByName(phrase) {
  const hits = nodesByName(phrase);
  return hits.length ? hits[0].node : null;
}

const ORD_STEMS = {
  перв: 1, втор: 2, трет: 3, четверт: 4, пят: 5, шест: 6, седьм: 7, восьм: 8, девят: 9, десят: 10,
};
/* Окончания порядковых. Без них основа сопоставлялась по startsWith, и под «второй»
   попадал «вторник», под «пятый» — «пятница», «пятно» и «пятёрка», под «четвёртый» —
   «четверть». Команда «открой вторник» открывала артборд №2 (круг 15, п.4). */
const ORD_END = /^(ый|ой|ий|ая|яя|ья|ое|ее|ье|ую|юю|ью|ые|ие|ьи|ого|его|ьего|ому|ему|ьему|ым|им|ьим|ом|ем|ьем|ых|их|ьих|ыми|ими|ьими|ей|ой|ю)$/;
const ORD_RE = new RegExp(`^(${Object.keys(ORD_STEMS).join('|')})(.*)$`);
const NUM_SAID = {
  один: 1, одну: 1, одна: 1, одно: 1, два: 2, две: 2, дважды: 2, три: 3, трижды: 3,
  четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
};

/** Число словом или цифрой: «два», «второй», «2». */
function numSaid(word) {
  const w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (/^\d{1,3}$/.test(w)) return Number(w);
  if (NUM_SAID[w] != null) return NUM_SAID[w];
  const m = ORD_RE.exec(w);
  if (m && ORD_END.test(m[2])) return ORD_STEMS[m[1]];
  return null;
}

const RE_UNDO_BARE = /^(отмена|отмени|отменить|отмени это|отмени правку|отмени последнее|верни как было|верни как раньше|верни назад|назад|не так)$/;
const RE_REDO_BARE = /^(верни обратно|повтори правку|вперёд|вперед)$/;
const RE_VARIANTS_BARE = /^(варианты|три варианта|дай варианты|покажи варианты|другие варианты|ещё варианты|еще варианты|сделай иначе|а можно иначе)$/;
/* \b и \w в JS считают словом только латиницу: после «отмени» границы слова нет, и
   правило молча не срабатывало. Поэтому окончания и границы — явными кириллическими
   классами. */
const RUS_END = '[а-яё]*';
const N_WORDS = '\\d{1,2}|один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять';
/* «Отмени два раза» — перемотка истории. «Повтори шапку три раза» — работа для модели:
   человек просит размножить блок. Раньше оболочка смотрела только начало реплики, а
   число искала где угодно в строке, поэтому шесть таких команд молча перематывали
   историю и до агента не доходили вовсе. Теперь обе ветки привязаны к ЦЕЛОЙ реплике:
   глагол + необязательное «последние/предыдущие/прошлые» + число + необязательная
   единица счёта + конец строки. Всё, что не совпало целиком, уходит в модель
   (круг 13, п.2). Та же дисциплина, что в brain.js RE_UNDO_CMD. */
const TAIL_N = `(?:\\s+(?:последн${RUS_END}|предыдущ${RUS_END}|прошл${RUS_END}))?(?:\\s+на)?`
  + `\\s+(${N_WORDS})`
  + `(?:\\s*(?:раз${RUS_END}|шаг${RUS_END}|правк${RUS_END}|изменени${RUS_END}))?`
  + `(?:\\s+назад)?$`;
const RE_UNDO_N = new RegExp(`^(?:отмени|отмена|отменить|откати|откатить|верни|вернуть)${TAIL_N}`);
const RE_REDO_N = new RegExp(`^(?:верни обратно|повтори|повторить|вперёд|вперед)${TAIL_N}`);
const RE_STOP_BARE = /^(стоп|стой|хватит|прекрати|прекратить|остановись|остановить|остановите|отставить|отмени работу)$/;
const RE_VARIANTS_CLOSE = /^(закрой варианты|закрыть варианты|убери варианты|уберите варианты|спрячь варианты|скрой варианты|скрыть варианты|не надо вариантов|хватит вариантов|ни один не подходит|ни один вариант не подходит)$/;
/* Тема. SPEC §2.3 называет «сделай тёмную тему» примером правки ДОКУМЕНТА, и это
   совпадает с жизнью: человек смотрит на макет и говорит про макет. Оболочка берёт себе
   только те формы, где интерфейс назван словом, — «тема интерфейса», «тёмная тема
   приложения», «светлый интерфейс». Всё остальное уходит агенту: у темы интерфейса есть
   кнопка в шапке, а перекрасить макет больше нечем, и молча сделать не то — хуже, чем
   попросить лишнее слово (круг 15, п.2). */
const UI_WORD = '(?:интерфейс[а-яё]*|оболочк[а-яё]*|приложени[а-яё]*|студи[а-яё]*|редактор[а-яё]*)';
const TH_WORD = '(?:тем[ауые])';
const TH_LEAD = '(?:сделай |сделать |включи |включить |поставь |хочу |переключи на |смени на |переключи |переключить |смени |сменить |поменяй |поменять )?';
const RE_THEME_DARK = new RegExp(`^${TH_LEAD}(?:т[её]мн[а-яё]+ (?:${TH_WORD} |режим |оформление )?${UI_WORD}`
  + `|${UI_WORD} т[её]мн[а-яё]+|${TH_WORD} ${UI_WORD} т[её]мн[а-яё]+)$`);
const RE_THEME_LIGHT = new RegExp(`^${TH_LEAD}(?:светл[а-яё]+ (?:${TH_WORD} |режим |оформление )?${UI_WORD}`
  + `|${UI_WORD} светл[а-яё]+|${TH_WORD} ${UI_WORD} светл[а-яё]+)$`);
const RE_THEME_AUTO = new RegExp(`^${TH_WORD}(?: ${UI_WORD})? как в системе$|^системная тема$|^как в системе$`);
const RE_THEME_UI = new RegExp(`^(?:переключи |переключить |смени |сменить |поменяй |поменять |покажи |открой )?${TH_WORD} ${UI_WORD}$|^${UI_WORD} ${TH_WORD}$`);
/* «Переключи тему» — ни макета, ни интерфейса в реплике нет: спрашиваем, а не решаем. */
const RE_THEME_ASK = /^(переключи тему|переключить тему|смени тему|сменить тему|поменяй тему|поменять тему|другая тема|другую тему|тема|тему)$/;
const RE_SHOW = /^(?:покажи|покажите|показать|открой|открыть|перейди|перейти|переключись|переключить|переключи|включи|выведи|вернись|давай)\s+(?:мне\s+)?(?:на\s+|в\s+|к\s+)?(.+)$/;
/** Слово-род артборда: «второй ЭКРАН», «следующую СТРАНИЦУ» — оно ничего не различает. */
const AB_KIND = '(?:артборд[а-яё]*|экран[а-яё]*|макет[а-яё]*|страниц[а-яё]*|вкладк[а-яё]*|лист[а-яё]*)';
const RE_PICK = /^(?:выдели|выделить|выделите|выбери|выбрать|укажи|отметь)\s+(?:слой\s+|узел\s+|элемент\s+)?(.+)$/;

/**
 * Намерение, которое выполняет сама оболочка. null — значит это команда агенту.
 * Правила узкие нарочно: «покажи сводку недели» — переключение (артборд с таким именем
 * есть), «добавь сводку недели» — работа для модели.
 */
function shellIntent(said) {
  const t = normSaid(said);
  if (!t || t.length > 140) return null;

  /* «Стоп», набранное в строке, уходило в модель — и агент начинал СТРОИТЬ макет по
     слову «стоп». Голосом эта ветка была, печатной строке не досталось (круг 13, п.8).
     Форма только целиковая: «добавь стоп-кран» сюда не попадает. */
  if (RE_STOP_BARE.test(t)) return { kind: 'stop' };

  // «закрой варианты» — до общего запрета на слово «вариант» ниже
  if (RE_VARIANTS_CLOSE.test(t)) return { kind: 'variants-close' };

  // варианты — дело brain: он один умеет отличить «два варианта шапки» от команды (п.2)
  if (/вариант/.test(t) && !RE_VARIANTS_BARE.test(t)) return null;

  /* Тема. «Переключи тему» перекрашивало документ, хотя человек почти всегда имеет в
     виду оболочку. Однозначные формы выполняем, спорную — переспрашиваем, а не решаем
     за человека (круг 13, п.8). */
  if (RE_THEME_DARK.test(t)) return { kind: 'theme', mode: 'dark' };
  if (RE_THEME_LIGHT.test(t)) return { kind: 'theme', mode: 'light' };
  if (RE_THEME_AUTO.test(t)) return { kind: 'theme', mode: 'auto' };
  if (RE_THEME_UI.test(t)) return { kind: 'theme', mode: 'cycle' };
  if (RE_THEME_ASK.test(t)) return { kind: 'theme', mode: 'ask' };

  /* — отмена и возврат, в том числе «отмени два раза» — */
  if (RE_UNDO_BARE.test(t)) return { kind: 'undo', times: 1 };
  if (RE_REDO_BARE.test(t)) return { kind: 'redo', times: 1 };
  const mRedo = RE_REDO_N.exec(t);
  if (mRedo) {
    const n = numSaid(mRedo[1]);
    if (n) return { kind: 'redo', times: Math.max(1, Math.min(20, n)) };
  }
  const mUndo = RE_UNDO_N.exec(t);
  if (mUndo) {
    const n = numSaid(mUndo[1]);
    if (n) return { kind: 'undo', times: Math.max(1, Math.min(20, n)) };
  }

  /* — вид: вписать и масштаб — */
  if (/^(вписать|впиши|вмести|вместить|вписать в окно|вписать на экран)$/.test(t)) return { kind: 'fit' };
  if (/^(вписать всё|вписать все|впиши всё|впиши все|покажи всё|покажи все|покажи весь макет|покажи целиком|целиком|общий вид|обзор)$/.test(t)) {
    return { kind: 'fit', all: true };
  }
  if (/^(вписать экран|впиши экран|вписать артборд|впиши артборд|покажи этот экран|покажи активный экран)$/.test(t)) {
    return { kind: 'fit', all: false };
  }
  if (/^(приблизь|приблизить|ближе|увеличь масштаб|увеличить масштаб|крупнее масштаб)$/.test(t)) return { kind: 'zoom', by: 1.25 };
  if (/^(отдали|отдалить|дальше|уменьши масштаб|уменьшить масштаб|мельче масштаб)$/.test(t)) return { kind: 'zoom', by: 1 / 1.25 };
  if (/^(?:масштаб\s+)?(сто процентов|100 процентов|100%|сбрось масштаб|сбросить масштаб|реальный размер|настоящий размер|один к одному)$/.test(t)) {
    return { kind: 'zoom', to: 1 };
  }
  const zm = /^(?:масштаб|зум)\s+(\d{2,3})\s*(?:процент[а-яё]*|%)?$/.exec(t);
  if (zm) return { kind: 'zoom', to: Math.max(0.1, Math.min(6, Number(zm[1]) / 100)) };

  /* — шторки: история, диалог, экспорт, настройки, слои — */
  if (/^(история|историю|история правок|покажи историю|покажи историю правок|открой историю|открой историю правок|что менялось|что изменилось)$/.test(t)) {
    return { kind: 'sheet', what: 'history', tab: 'edits' };
  }
  if (/^(диалог|покажи диалог|открой диалог|переписка|покажи переписку|разговор|покажи разговор|что ты сказал)$/.test(t)) {
    return { kind: 'sheet', what: 'history', tab: 'chat' };
  }
  if (/^(настройки|открой настройки|покажи настройки|настройки агента)$/.test(t)) return { kind: 'sheet', what: 'settings' };
  if (/^(слои|покажи слои|открой слои|панель слоёв|панель слоев|покажи панель слоёв)$/.test(t)) return { kind: 'rail', on: true };
  if (/^(спрячь слои|скрой слои|убери слои|закрой слои|сверни слои)$/.test(t)) return { kind: 'rail', on: false };

  /* — экспорт — */
  // длинные слова раньше коротких: «экспорт» съедал начало «экспортируй», и остаток
  // «ируй png» не опознавался — команда уходила в модель
  const ex = /^(?:экспортировать|экспортируй|экспорт|сохранить|сохрани|скачать|скачай)(?![а-яё])\s*(?:(?:в|как)\s+)?(.*)$/.exec(t);
  if (ex) {
    const what = String(ex[1] || '').trim();
    if (!what || /^(файл|документ на диск|это)$/.test(what)) return { kind: 'export', what: '' };
    if (/^(png|пнг|картинк[а-яё]*|изображение|снимок|скриншот)$/.test(what)) return { kind: 'export', what: 'png' };
    if (/^(svg|свг|вектор[а-яё]*)$/.test(what)) return { kind: 'export', what: 'svg' };
    if (/^(json|джейсон|документ)$/.test(what)) return { kind: 'export', what: 'json' };
  }

  /* — выделение по имени — */
  if (/^(сними выделение|снять выделение|убери выделение|ничего не выделяй)$/.test(t)) return { kind: 'select', ids: [] };
  const pick = RE_PICK.exec(t);
  if (pick) {
    const hits = nodesByName(pick[1]);
    if (hits.length) {
      const best = hits[0].score;
      const same = hits.filter((h) => h.score >= best - 0.01).slice(0, 12);
      return { kind: 'select', ids: same.map((h) => h.id), name: same[0].node.name || defaultName(same[0].node) };
    }
  }

  /* — видимый артборд: он же область работы агента —
     Ветка нарочно узкая. Раньше «следующий» и «предыдущий» проверялись как ПРЕФИКС
     хвоста, а номер брался из первого слова при длине хвоста до двух слов, — и оболочка
     забирала себе живые реплики: «покажи вторую кнопку» переключало артборд, «покажи
     следующий шаг» — тоже, «открой вторник» открывал артборд №2. Теперь совпадать
     должен ВЕСЬ хвост, а имя существующего артборда идёт первым: настоящая «Пятница»
     важнее угаданного номера 5 (круг 15, п.4). */
  const show = RE_SHOW.exec(t);
  if (show) {
    // «второй экран», «следующую страницу»: слово-род убираем и спереди, и с конца
    const tail = String(show[1] || '')
      .replace(new RegExp(`^${AB_KIND}\\s+`), '')
      .replace(new RegExp(`\\s+${AB_KIND}$`), '')
      .trim();
    if (!tail) return null;
    const words = tail.split(' ');
    // номером считаем только хвост ЦЕЛИКОМ из одного числительного: «покажи второй»
    const n = words.length === 1 ? numSaid(words[0]) : null;
    /* Имя артборда — раньше номера и раньше «следующего»: настоящая «Пятница» важнее
       угаданного номера 5, а артборд «Следующий шаг» — важнее перелистывания. Исключение
       одно: если сказано ЧИСТОЕ числительное, это номер и есть — иначе «покажи пятый»
       уходил бы в «Пятницу» по общей основе «пят». */
    if (!n) {
      const hits = artboardsByName(tail);
      if (hits.length === 1) return { kind: 'artboard', id: hits[0].id };
      if (hits.length > 1) return { kind: 'artboard', list: hits.map((a) => a.id) };
    }
    if (/^(следующий|следующую|следующее|следующая|дальше)$/.test(tail)) return { kind: 'artboard', step: 1 };
    if (/^(предыдущий|предыдущую|предыдущее|предыдущая|прошлый|прошлую|прошлое|прошлая|назад)$/.test(tail)) {
      return { kind: 'artboard', step: -1 };
    }
    if (n) return { kind: 'artboard', index: n - 1 };
  }
  return null;
}

/** Отмена или возврат сразу на несколько шагов: рисуем один раз, говорим одной строкой. */
function stepHistoryTimes(back, times) {
  const done = [];
  for (let i = 0; i < times; i++) {
    const tx = back ? state.history[state.cursor - 1] : state.history[state.cursor];
    if (!tx) break;
    if (!stepHistory(back, { quiet: true })) break;
    done.push(tx.human || tx.label);
  }
  if (done.length) { renderAll(); scheduleSave(); refreshSheet(); }
  return done;
}

/** Переключить видимый артборд — и сказать, что агент теперь работает здесь. */
function openArtboard(id, { say = true } = {}) {
  const node = nodeById(state.doc, id);
  if (!node) return false;
  setSelection([id]);
  state.fitAll = false;
  fitAfterLayout([id]);
  if (say) {
    showMsg('plain', `Активный артборд: «${nodeTitle(node)}»`, {
      note: 'Команды без выделения агент выполняет здесь.', ms: 5000,
    });
  }
  return true;
}

/**
 * Выполнить намерение оболочки. false — не смогли, и тогда реплика уйдёт агенту.
 */
function applyShellIntent(intent, said) {
  if (!intent) return false;
  switch (intent.kind) {
    case 'stop': {
      if (state.running) stopAgent();
      else showMsg('plain', 'Агент сейчас ничего не делает.', { ms: 5000 });
      return true;
    }
    case 'variants-close': {
      if (dom.variants && !dom.variants.hidden) {
        hideVariants();
        showMsg('plain', 'Варианты закрыл — макет остался прежним.', { ms: 5000 });
      } else {
        showMsg('plain', 'Вариантов сейчас на экране нет.', { ms: 5000 });
      }
      return true;
    }
    case 'theme': {
      if (intent.mode === 'ask') {
        showMsg('question', 'Сменить тему интерфейса или перекрасить макет?', {
          note: 'Тема интерфейса — оболочка вокруг холста. Макет перекрашивает агент.',
          chips: [
            { text: 'Тему интерфейса', onClick: () => { hideMsg(); cycleTheme(); } },
            { text: 'Макет', onClick: () => { hideMsg(); runUtterance(said, { toModel: true }); } },
          ],
        });
        return true;
      }
      if (intent.mode === 'cycle') { cycleTheme(); return true; }
      setTheme(intent.mode);
      return true;
    }
    case 'undo':
    case 'redo': {
      const times = Math.max(1, Math.min(20, intent.times || 1));
      const back = intent.kind === 'undo';
      if (times === 1) { applyHistoryAction(intent.kind, said); return true; }
      const done = stepHistoryTimes(back, times);
      if (said) addChat('you', said);
      if (!done.length) {
        const why = back ? 'Отменять нечего — это самое начало.' : 'Возвращать нечего: впереди правок нет.';
        showMsg('plain', why, { ms: 7000 });
        addChat('agent', why);
        return true;
      }
      const word = back ? 'Отменил' : 'Вернул';
      const head = `${word} ${done.length} ${plural(done.length, 'правку', 'правки', 'правок')}`
        + (done.length < times ? ` — больше в истории не было` : '');
      // сами описания правок уже с кавычками: своих сверху не добавляем
      const note = done.slice(0, 3).map((d) => clip(d, 44)).join(' · ')
        + (done.length > 3 ? ` · и ещё ${done.length - 3}` : '');
      addChat('agent', head, [], note);
      if (said) rememberPair(said, head);
      showMsg('plain', head, {
        note,
        transient: true,
        actions: [{
          label: back ? 'Вернуть обратно' : 'Отменить снова',
          onClick: () => { stepHistoryTimes(!back, done.length); hideMsg(); },
        }],
      });
      return true;
    }
    case 'fit': {
      const act = activeArtboardId();
      // «вписать» без уточнения — по-умному (как кнопка при первом нажатии),
      // «вписать всё» и «вписать экран» — ровно то, что сказано
      if (intent.all == null) fitSmart();
      else {
        state.fitAll = !!intent.all;
        fitView(intent.all || !act ? null : [act]);
      }
      updateFitButton();
      toast(state.fitAll ? 'Вписаны все артборды' : 'Вписан активный артборд', 'plain', 3500);
      return true;
    }
    case 'zoom': {
      if (!stage) return false;
      if (intent.to) stage.setZoom(intent.to);
      else stage.zoomBy(intent.by || 1.25);
      state.userView = true;
      updateFitButton();
      return true;
    }
    case 'sheet': {
      if (intent.what === 'settings') openSettings();
      else openHistory(intent.tab || 'edits');
      return true;
    }
    case 'rail': {
      setRail(intent.on ? 'on' : 'off', true);
      return true;
    }
    case 'export': {
      if (intent.what === 'png') { exportPng(); return true; }
      if (intent.what === 'svg') { exportSvg(); return true; }
      if (intent.what === 'json') { exportJson(); return true; }
      openExport();
      return true;
    }
    case 'select': {
      const ids = (intent.ids || []).filter((id) => state.doc.nodes[id]);
      setSelection(ids);
      if (!ids.length) { toast('Выделение снято', 'plain', 3000); return true; }
      const many = ids.length > 1 ? ` и ещё ${ids.length - 1}` : '';
      toast(`Выделено «${intent.name || nodeTitleById(state.doc, ids[0])}»${many}`, 'plain', 4000);
      return true;
    }
    case 'artboard': {
      const abs = artboards(state.doc);
      if (!abs.length) { showMsg('plain', 'В документе нет артбордов.', { ms: 5000 }); return true; }
      if (intent.id) return openArtboard(intent.id);
      if (Array.isArray(intent.list) && intent.list.length) {
        // имя подошло сразу нескольким: спрашиваем, а не выбираем за человека
        openArtboardList(abs.filter((a) => intent.list.includes(a.id)));
        return true;
      }
      if (Number.isFinite(intent.index)) {
        const ab = abs[intent.index];
        if (!ab) {
          showMsg('plain', `Артборда под номером ${intent.index + 1} нет — их ${abs.length}.`, { ms: 6000 });
          return true;
        }
        return openArtboard(ab.id);
      }
      if (intent.step) {
        const act = activeArtboardId();
        const i = Math.max(0, abs.findIndex((a) => a.id === act));
        const next = abs[(i + intent.step + abs.length) % abs.length];
        return next ? openArtboard(next.id) : false;
      }
      return false;
    }
    default: return false;
  }
}

/* ---------------------------------- голос ------------------------------------ */

/**
 * Ошибки распознавания — по-русски: код «no-speech» или «not-allowed» человеку
 * не говорит ничего (п.13).
 */
const VOICE_ERRORS = {
  'no-speech': 'Я ничего не услышал — скажите ещё раз.',
  'audio-capture': 'Микрофон не найден: проверьте, что он подключён и выбран в системе.',
  'not-allowed': 'Браузер не дал доступ к микрофону — разрешите его для этой страницы.',
  'service-not-allowed': 'Распознавание речи заблокировано настройками браузера.',
  network: 'Распознавание речи не дошло до сервиса браузера — проверьте связь.',
  'bad-grammar': 'Речь не разобрать — скажите короче.',
  'language-not-supported': 'Браузер не распознаёт русскую речь. Наберите команду текстом.',
};

/** Пауза, после которой сказанное считается законченной командой. */
const VOICE_PAUSE_MS = 1200;

/** Тишина, после которой микрофон выключается сам: реплика коллеге — не команда (п.9). */
const VOICE_IDLE_MS = 10000;

const VARIANT_WORDS = [
  [/^(перв(ый|ая|ое)|вариант один|вариант 1|один|1)$/, 0],
  [/^(втор(ой|ая|ое)|вариант два|вариант 2|два|2)$/, 1],
  [/^(трет(ий|ья|ье)|вариант три|вариант 3|три|3)$/, 2],
];

/**
 * Ответы на вопрос «агент занят»: их ждём ровно пока вопрос на экране. Без них слова
 * «заменить» и «в очередь» уходили в модель и применялись правкой макета (п.8).
 */
const BUSY_WORDS = [
  [/^(замени|заменить|замени команду|заменить команду|давай новую|новая важнее|переключись)$/, 'replace'],
  [/^(в очередь|поставь в очередь|очередь|потом|позже|после текущей|после этой)$/, 'queue'],
  [/^(доделай|доделать|доделай текущую|доделать текущую|продолжай|продолжи|текущую|не надо|отбой|забудь)$/, 'drop'],
];

function busyFromWords(t) {
  const live = !!busyChoice;
  // вопрос мог закрыться сам, пока человек договаривал: ветка «вопрос уже закрыт» была
  // недостижима, и ответ уходил в модель обычной командой (п.8)
  if (!live && Date.now() - busyClosedAt > BUSY_ECHO_MS) return null;
  for (const [re, how] of BUSY_WORDS) if (re.test(t)) return live ? how : 'closed';
  return null;
}

/** «первый», «второй», «возьми этот» — только когда варианты и правда на экране. */
function variantFromWords(t) {
  if (!state.variants || !dom.variants || dom.variants.hidden) return null;
  for (const [re, i] of VARIANT_WORDS) if (re.test(t)) return i;
  if (/^(возьми этот|бери этот|беру этот|этот|давай этот|вот этот|подходит|годится|берём|берем)$/.test(t)) {
    const n = (state.variantPicks || []).length;
    return n ? Math.max(0, Math.min(n - 1, state.variantFocus || 0)) : null;
  }
  return null;
}

/**
 * Локальные голосовые команды: их выполняет оболочка, до обращения к модели.
 * Отмену brain тоже распознаёт и возвращает action — оба пути ведут в applyHistoryAction,
 * и отмена от этого не задваивается: локальная реплика до модели просто не доходит.
 */
function localVoiceIntent(text) {
  const t = normSaid(text);
  if (!t) return null;
  // вопрос «агент занят» на экране: ответ на него — не команда макету (п.8)
  const busy = busyFromWords(t);
  if (busy) return { kind: 'busy', how: busy };
  if (/^(стоп|стой|хватит|прекрати|остановись|отставить)$/.test(t)) return { kind: 'stop' };
  // выбор варианта — раньше остального: панель вариантов на экране важнее всего (п.7)
  const pick = variantFromWords(t);
  if (pick !== null) return { kind: 'variant', index: pick };
  // варианты голосом были недоступны вовсе — а это главный способ сравнить решения (п.11)
  if (RE_VARIANTS_BARE.test(t)) return { kind: 'variants' };
  // инструменты оболочки: артборд, масштаб, выделение, экспорт, история, «отмени N раз» (п.6)
  return shellIntent(t);
}

/** Реплика из микрофона: сначала свои команды, и только потом модель. */
function handleVoiceUtterance(text) {
  const said = String(text || '').trim();
  if (!said) return;
  const intent = localVoiceIntent(said);
  if (!intent) {
    // после переспроса реплика ДОПИСЫВАЕТСЯ к возвращённому тексту, а не заменяет его (п.10)
    const base = state.awaitingClarify ? String(state.awaitingClarify.base || '').trim() : '';
    const full = base && !said.toLowerCase().includes(base.toLowerCase()) ? `${base} ${said}` : said;
    dom.command.value = full;
    runUtterance(full);
    return;
  }
  dom.command.value = '';
  if (intent.kind === 'busy') {
    const act = busyChoice;
    // вопрос мог закрыться сам, пока человек договаривал (п.8)
    if (intent.how !== 'closed' && act && typeof act[intent.how] === 'function') act[intent.how]();
    else {
      showMsg('plain', 'Вопрос уже закрыт — скажите команду заново.', {
        note: 'Агент освободился, пока вы отвечали.', ms: 6000,
      });
    }
    return;
  }
  if (intent.kind === 'stop') {
    if (state.running) stopAgent();
    else showMsg('plain', 'Агент сейчас ничего не делает.', { ms: 5000 });
    return;
  }
  if (intent.kind === 'variants') { runVariantsForLast(state.lastUtterance); return; }
  // выбор варианта панель не закрывает: раньше любая реплика сносила её до выбора (п.7)
  if (intent.kind === 'variant') {
    if (!takeVariant(intent.index)) showMsg('plain', `Варианта под номером ${intent.index + 1} нет.`, { ms: 6000 });
    return;
  }
  // отмена, артборд, масштаб, выделение, экспорт, история — всё это делает оболочка (п.6)
  applyShellIntent(intent, said);
}

/** Включить и выключить микрофон снаружи: кнопка и клавиша V. */
let toggleVoice = null;

function initVoice() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const btn = dom['btn-mic'];
  if (!SR) {
    btn.disabled = true;
    btn.title = 'Голос доступен в локальной сборке (Chrome). В артефакте микрофон заблокирован платформой.';
    return;
  }

  let rec = null;
  let wanted = false;     // микрофон включён человеком
  let settled = '';       // распознанное окончательно, но ещё не отправленное
  let pauseTimer = null;
  let idleTimer = null;
  let startedAt = 0;
  let silence = 0;        // подряд идущие «ничего не услышал»
  let toldOnce = false;   // про «одна команда за нажатие» говорим один раз за сеанс работы

  const paint = () => {
    const always = !!settings.voiceAlways;
    btn.dataset.state = wanted ? 'on' : 'off';
    btn.dataset.mode = always ? 'always' : 'once';
    btn.setAttribute('aria-pressed', String(wanted));
    /* Открытый микрофон виден словом и обводкой строки: раньше состояние «слушаю»
       держалось на еле заметной подсветке рамки кнопки (круг 15, п.11). */
    if (dom.commandbar) dom.commandbar.dataset.voice = wanted ? 'on' : '';
    if (dom['mic-live']) {
      dom['mic-live'].hidden = !wanted;
      dom['mic-live'].textContent = always ? 'Слушаю' : 'Слушаю команду';
    }
    if (wanted) dom.command.placeholder = 'Говорите — я слушаю';
    else setRunnable(!!state.provider);
    btn.title = wanted
      ? (always
        ? 'Слушаю постоянно — нажмите, чтобы выключить (или клавиша V)'
        : 'Слушаю одну команду — нажмите, чтобы выключить (или клавиша V)')
      : (always
        ? 'Голос: включён режим «слушать постоянно» (нажмите или клавиша V)'
        : 'Голосовая команда: одна команда за нажатие (нажмите или клавиша V)');
  };
  const clearPause = () => { clearTimeout(pauseTimer); pauseTimer = null; };
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = null; };

  /**
   * Пауза в речи — конец команды. Раньше сеанс закрывался на первом же isFinal:
   * фраза с паузой посередине превращалась в две команды, и вторая отменяла первую (п.7).
   * Команда сказана — микрофон выключаем: непрерывное слушание человек включает сам (п.9).
   */
  const flush = ({ auto = true } = {}) => {
    clearPause();
    const said = settled.trim();
    settled = '';
    if (!said) return;
    handleVoiceUtterance(said);
    if (!auto || !wanted || settings.voiceAlways) return;
    stop({ send: false });
    if (toldOnce) return;
    toldOnce = true;
    toast('Микрофон выключен: слушаю по одной команде за нажатие. Постоянное слушание — в настройках.', 'plain', 8000);
  };
  const armPause = () => { clearPause(); pauseTimer = setTimeout(flush, VOICE_PAUSE_MS); };

  /** Тишина: включённый микрофон не должен слушать комнату вечно (п.9). */
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (!wanted) return;
      stop();
      toast('Выключил микрофон: десять секунд тишины.', 'plain', 5000);
    }, VOICE_IDLE_MS);
  };

  const build = () => {
    const r = new SR();
    r.lang = 'ru-RU';
    r.interimResults = true;
    r.continuous = true;    // один сеанс на всю работу: команду отделяет пауза, а не сеанс
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const said = String((res[0] && res[0].transcript) || '').trim();
        if (!said) continue;
        if (res.isFinal) settled = settled ? `${settled} ${said}` : said;
        else interim = interim ? `${interim} ${said}` : said;
      }
      // переспрос: к возвращённому тексту дописываем, а не затираем его (п.10)
      const base = state.awaitingClarify ? String(state.awaitingClarify.base || '').trim() : '';
      dom.command.value = [base, settled, interim].filter(Boolean).join(' ');
      silence = 0;
      armPause();
      armIdle();
    };
    r.onerror = (ev) => {
      const code = ev && ev.error;
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        // сеанс молчания Chrome закрывает сам и снова, и снова: тост — только первый раз,
        // а после третьей тишины подряд выключаем микрофон, чтобы не мигать без конца
        silence += 1;
        if (silence === 1) toast(VOICE_ERRORS['no-speech'], 'plain', 4000);
        if (silence >= 3) {
          wanted = false;
          clearPause();
          paint();
          toast('Выключил микрофон — я ничего не слышу.', 'plain', 5000);
        }
        return;
      }
      wanted = false;
      clearPause();
      clearIdle();
      paint();
      // отказ микрофона требует действий человека — это место сообщений, а не тостов (п.15)
      showMsg('error', VOICE_ERRORS[code] || 'Распознавание речи не удалось', {
        note: 'Команду можно набрать текстом в строке внизу.',
      });
    };
    r.onend = () => {
      // сеанс, который уже сменили, поднимать нельзя: два распознавания сразу слышат эхо
      if (!wanted || rec !== r) { paint(); return; }
      // Chrome закрывает сеанс сам; пока микрофон включён — поднимаем снова,
      // но если сеанс не держится дольше мгновения, цикл не крутим
      if (Date.now() - startedAt < 400) { wanted = false; paint(); return; }
      startedAt = Date.now();
      try { r.start(); } catch { wanted = false; paint(); }
    };
    return r;
  };

  const start = () => {
    if (wanted) return;
    rec = build();
    wanted = true;
    silence = 0;
    startedAt = Date.now();
    try { rec.start(); } catch { wanted = false; }
    armIdle();
    paint();
  };
  const stop = ({ send = true } = {}) => {
    wanted = false;
    clearIdle();
    paint();
    try { rec && rec.stop(); } catch { /* уже остановлен */ }
    if (send) flush({ auto: false }); else clearPause();
  };
  toggleVoice = () => { if (wanted) stop(); else start(); };
  paint();

  // с клавиатуры кнопка работает удержанием (SPEC §1.7), мышью — переключением
  let keyHold = false;
  const isHoldKey = (e) => e.code === 'Space' || e.key === ' ' || e.key === 'Enter';
  btn.addEventListener('keydown', (e) => {
    if (!isHoldKey(e) || e.repeat) return;
    e.preventDefault();          // иначе браузер добавит свой click и выйдет двойной пуск
    if (keyHold || wanted) return;
    keyHold = true;
    start();
  });
  btn.addEventListener('keyup', (e) => {
    if (!keyHold || !isHoldKey(e)) return;
    e.preventDefault();
    keyHold = false;
    stop();
  });
  btn.addEventListener('click', () => { if (!keyHold) toggleVoice(); });
}

/* -------------------------------- интерфейс ---------------------------------- */

let submitGuard = 0;

/** Один путь отправки на все источники: Enter в строке, кнопка, форма. */
function submitOnce(opts) {
  const now = Date.now();
  if (now - submitGuard < 250) return;
  submitGuard = now;
  submitCommand(opts);
}

function bindUi() {
  // уход со страницы: последнюю правку дописываем сразу, а не через 1,2 с (п.2)
  globalThis.addEventListener('pagehide', saveOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnExit();
  });

  // пока идёт жест по холсту, вид пересчитывать нельзя — узел уедет из-под пальца
  dom.canvas.addEventListener('pointerdown', () => { pointerOnCanvas = true; });
  for (const ev of ['pointerup', 'pointercancel']) {
    globalThis.addEventListener(ev, () => { pointerOnCanvas = false; });
  }

  // Enter в строке — отправка, и только она: неявная отправка формы нажимала «Стоп»
  // и обрывала первую команду вместе с набранным текстом (п.8)
  dom.command.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    submitOnce();
  });
  dom.commandbar.addEventListener('submit', (e) => {
    e.preventDefault();
    if (runHoldFired) { runHoldFired = false; return; }   // долгое нажатие уже запустило варианты
    /* Круг 16, п.14. Enter в пустой строке, пока агент работает, снимал прогон: формально
       главная кнопка в этот момент «Стоп», но Enter человек жмёт по привычке «отправить»,
       а не «остановить», — и повторное нажатие стоило всей работы. Останавливает теперь
       только явное нажатие кнопки; Enter без текста об этом говорит и ничего не снимает. */
    if (state.running && !dom.command.value.trim()) {
      toast('Агент ещё работает. Остановить — кнопкой «Стоп».', 'plain', 5000);
      return;
    }
    submitOnce();
  });
  // кнопка «Стоп» переехала в строку состояния: главная кнопка отправляет команду,
  // даже когда агент занят, — и спрашивает то же, что Enter (п.6)
  dom['btn-run'].addEventListener('click', () => {
    if (runHoldFired) { runHoldFired = false; return; }
    if (state.running && !dom.command.value.trim()) { stopAgent(); return; }
    submitOnce();
  });
  dom['btn-stage-stop'].addEventListener('click', () => stopAgent());
  // надпись на главной кнопке зависит от того, есть ли в строке текст
  dom.command.addEventListener('input', () => { if (state.busy) paintRunButton(); });
  dom['btn-variants'].addEventListener('click', () => submitCommand({ variants: true }));
  bindRunHold();
  dom['btn-msg-close'].addEventListener('click', hideMsg);
  dom['btn-new-artboard'].addEventListener('click', addArtboard);
  dom['btn-empty-artboard'].addEventListener('click', addArtboard);

  dom['btn-zoom-in'].addEventListener('click', () => stage.zoomBy(1.2));
  dom['btn-zoom-out'].addEventListener('click', () => stage.zoomBy(1 / 1.2));
  dom['btn-zoom'].addEventListener('click', () => stage.setZoom(1));
  dom['btn-fit'].addEventListener('click', () => {
    // что делать дальше, решает настоящее состояние вида, а не память о прошлом клике (п.1)
    const abs = artboards(state.doc);
    const act = activeArtboardId();
    const canSplit = abs.length > 1 && !!act;
    const scope = fitScopeNow();
    if (!canSplit) { state.fitAll = true; fitView(null); }
    else if (!scope) fitSmart();          // вид сбит: сперва возвращаем разумный
    else {
      state.fitAll = scope !== 'all';
      fitView(state.fitAll ? null : [act]);
    }
    updateFitButton();
  });

  dom['btn-rail-close'].addEventListener('click', () => setRail('off', true));
  dom['btn-rail'].addEventListener('click', () => setRail(dom.app.dataset.rail === 'off' ? 'on' : 'off', true));
  dom.scrim.addEventListener('click', () => {
    if (dom.scrim.dataset.for === 'sheet') closeSheet();
    else setRail('off');
  });
  if (typeof matchMedia === 'function') {
    matchMedia('(max-width: 900px)').addEventListener('change', (e) => {
      const narrow = !!(e && e.matches);
      syncPanelModes();
      state.inspQuiet = false;   // на широком экране инспектор снова уместен
      /* Раскладка сменилась под рукой: закреплённый в широком окне рельс на узком
         превращается в шторку поверх инспектора — и человек попадает в разрезанный
         экран, не нажав ничего. Складываем рельс: выделение важнее списка слоёв.
         Обратно — возвращаем рельс к настройке, а не к тому, что осталось (п.1). */
      if (narrow) setRail(dom.app.dataset.insp === 'on' ? 'off' : dom.app.dataset.rail);
      else applyRail();
      setRunnable(!!state.provider);
      applyCompact();
      renderTabs();
      renderInspector();
    });
  }
  dom['btn-insp-close'].addEventListener('click', () => setSelection([]));
  dom['btn-sheet-close'].addEventListener('click', closeSheet);
  dom.sheet.addEventListener('keydown', trapSheetFocus);
  dom['btn-history'].addEventListener('click', () => openHistory());
  dom['btn-export'].addEventListener('click', openExport);
  dom['btn-settings'].addEventListener('click', openSettings);
  // три состояния темы: тёмная, светлая и «как в системе» (п.13)
  dom['btn-theme'].addEventListener('click', () => cycleTheme());
  dom['btn-add-artboard'].addEventListener('click', addArtboard);

  dom.docname.addEventListener('blur', () => {
    const name = dom.docname.textContent.trim() || 'Без названия';
    setDocNameText(name);
    state.doc = { ...state.doc, meta: { ...state.doc.meta, name } };
    scheduleSave();
  });
  dom.docname.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dom.docname.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDocNameText(state.doc.meta && state.doc.meta.name || 'Без названия');
      dom.docname.blur();
    }
  });
  // имя документа — строка, а не разметка: вставляем ровно текст (п.15)
  const plainInsert = (e, text) => {
    e.preventDefault();
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t) return;
    let done = false;
    try { done = document.execCommand('insertText', false, t); } catch { done = false; }
    if (!done) dom.docname.textContent = `${dom.docname.textContent}${t}`.slice(0, 120);
    if (!done) resetDocNameScroll();
  };
  dom.docname.addEventListener('paste', (e) => plainInsert(e, e.clipboardData && e.clipboardData.getData('text/plain')));
  dom.docname.addEventListener('drop', (e) => plainInsert(e, e.dataTransfer && e.dataTransfer.getData('text/plain')));

  globalThis.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    // одиночная буква — только когда фокус не на органе управления: иначе «l» и «h»
    // срабатывали с любой кнопки, по которой человек только что щёлкнул (круг 9, п.15)
    const bare = !typing && bareKeyOk();
    if (e.key === '/' && !typing) { e.preventDefault(); dom.command.focus(); }
    if (e.key === 'Escape' && !dom.sheet.hidden) { e.preventDefault(); closeSheet(); return; }
    // шторка слоёв закрывалась только кликом по затемнению (п.17)
    if (e.key === 'Escape' && railIsDrawer() && dom.app.dataset.rail === 'on') {
      e.preventDefault();
      setRail('off', true);
      dom['btn-rail'].focus();
      return;
    }
    // Escape закрывает по одному: сперва варианты (они лежат поверх), потом сообщение (п.19)
    if (e.key === 'Escape' && !dom.variants.hidden) { e.preventDefault(); hideVariants(); return; }
    if (e.key === 'Escape' && !dom.dockmsg.hidden) { e.preventDefault(); hideMsg(); return; }
    // варианты выбираются с клавиатуры: цифра — сразу, стрелки — переход, Enter — на карточке
    if (!dom.variants.hidden && !typing) {
      if (/^[1-9]$/.test(e.key)) { e.preventDefault(); takeVariant(Number(e.key) - 1); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusVariant((state.variantFocus || 0) + 1); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusVariant((state.variantFocus || 0) - 1); return; }
    }
    // диктовка по клавише: пробел занят панорамой холста, поэтому голос — на V (п.8)
    if (e.key.toLowerCase() === 'v' && bare && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (toggleVoice) { e.preventDefault(); toggleVoice(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dom.command.focus(); }
    /* Ctrl+A вне холста выделял весь текст страницы, хотя после «выделить всё» человек
       ждёт узлы (круг 11, п.14). Сцена ловит своё событие раньше и ставит defaultPrevented —
       значит сюда доходит только случай «фокус не на холсте». */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing && !e.defaultPrevented) {
      e.preventDefault();
      const all = allSelectableIds();
      if (all.length) setSelection(all);
    }
    // отмена работает из любого места оболочки; сцена ловит своё событие раньше (capture) и ставит defaultPrevented
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing && !e.defaultPrevented) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
    if (e.key.toLowerCase() === 'h' && bare) { e.preventDefault(); openHistory(); }
    if (e.key.toLowerCase() === 'l' && bare && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setRail(dom.app.dataset.rail === 'off' ? 'on' : 'off', true);
    }
  });
}

/**
 * «Выделить всё» теми же правилами, что и рамка на холсте: верхние узлы каждого артборда,
 * без скрытых и запертых. Если внутри пусто — сами артборды.
 */
function allSelectableIds() {
  const doc = state.doc;
  if (!doc) return [];
  const rects = (state.geo && state.geo.rects) || {};
  const out = [];
  for (const ab of artboards(doc)) {
    for (const cid of (ab.children || [])) {
      const n = nodeById(doc, cid);
      if (!n || n.visible === false || n.locked) continue;
      if (rects[cid]) out.push(cid);
    }
  }
  return out.length ? out : artboards(doc).map((a) => a.id);
}

/**
 * Можно ли выполнить одиночную буквенную клавишу. Фокус на кнопке, ссылке или в панели —
 * значит человек работает руками с этим органом, и «v» там означает букву, а не микрофон.
 */
function bareKeyOk() {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return true;
  if (dom.canvas && (a === dom.canvas || dom.canvas.contains(a))) return true;
  return false;
}

let zoomRepairing = false;

/** Подпись зума — и последняя страховка: нечисловой вид тут же возвращаем к 100%. */
function updateZoomLabel(view) {
  if (!view) return;
  const z = Number(view.zoom);
  if (!Number.isFinite(z) || z <= 0) {
    dom['btn-zoom'].textContent = '100%';
    if (zoomRepairing) return;
    zoomRepairing = true;
    try { if (stage && stage.view) { stage.view.zoom = 1; stage.view.pan = { x: 0, y: 0 }; stage.setZoom(1); } }
    catch { /* сцена не готова — подпись уже честная */ }
    finally { zoomRepairing = false; }
    return;
  }
  dom['btn-zoom'].textContent = `${Math.round(z * 100)}%`;
}

/**
 * Куда положить следующий артборд. В одну строку они вырождаются в полоску огрызков
 * на 10% зума, поэтому раскладываем сеткой с переносом (п.5).
 */
const ARTBOARD_COLS = 6;
const ARTBOARD_GAP_X = 64;
const ARTBOARD_GAP_Y = 96;
const ARTBOARD_W = 390;
const ARTBOARD_H = 720;

function nextArtboardPos(list) {
  const rects = list.map((a) => state.geo.rects[a.id]).filter(Boolean);
  if (!rects.length) return { x: 0, y: 0 };
  const x0 = Math.round(Math.min(...rects.map((r) => r.x)));
  const inRow = list.length % ARTBOARD_COLS;
  if (inRow === 0) {
    // новая строка — под самым нижним краем всего, что уже стоит
    const bottom = Math.round(Math.max(...rects.map((r) => r.y + r.h)));
    return { x: x0, y: bottom + ARTBOARD_GAP_Y };
  }
  const last = rects[rects.length - 1];
  return { x: Math.round(last.x + last.w + ARTBOARD_GAP_X), y: Math.round(last.y) };
}

function addArtboard() {
  const abs = artboards(state.doc);
  const at = nextArtboardPos(abs);
  const id = `ab_${Date.now().toString(36)}`;
  const node = {
    id, type: 'frame', name: `Артборд ${abs.length + 1}`, parent: state.doc.root, children: [],
    pos: { x: at.x, y: at.y },
    size: { w: { mode: 'fixed', value: ARTBOARD_W }, h: { mode: 'fixed', value: ARTBOARD_H } },
    layout: { mode: 'column', gap: 16, padding: { t: 24, r: 20, b: 24, l: 20 }, align: 'stretch', justify: 'start', wrap: false },
    fill: { token: 'surface' }, radius: 16,
  };
  const r = commit([OPS.create(node)], 'Новый артборд');
  if (r.ok) { setSelection([id]); fitAfterLayout([id]); }
  return r;
}

/* ---------------------------------- шторки ----------------------------------- */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let sheetReturnFocus = null;
/** Шторки, ради которых документ гасить нельзя: они про сам документ (п.9). */
const QUIET_SHEETS = new Set(['history', 'export', 'artboards']);

/** Шторка — модальный диалог: фокус внутрь, Esc и клик по затемнению закрывают. */
function openSheet(title, fill, opts = {}) {
  const wasOpen = !dom.sheet.hidden;
  /* На узком экране шторка — третья накладка на том же месте. Рельс и инспектор
     уступают ей место: иначе от документа остаётся полоска в пару сантиметров, а
     история и экспорт — это как раз разговор о документе (п.1, п.9). Оба вернутся,
     когда шторка закроется. */
  if (isNarrow()) {
    if (dom.app.dataset.rail === 'on') setRail('off');
    if (dom.app.dataset.insp === 'on') {
      state.inspQuiet = true;
      state.inspBySheet = true;
      renderInspector();
    }
  }
  if (!wasOpen) sheetReturnFocus = document.activeElement;
  state.sheetOpen = opts.key || null;
  dom['sheet-title'].textContent = title;
  dom.sheet.dataset.size = opts.size === 'auto' ? 'auto' : 'tall';
  dom.sheet.hidden = false;
  dom.scrim.dataset.for = 'sheet';
  /* Перемотка истории и выбор формата экспорта — разговор о документе, и документ при
     этом должен быть виден. Затемнение остаётся ловушкой кликов, но не красит (п.9). */
  dom.scrim.dataset.quiet = QUIET_SHEETS.has(opts.key) ? 'on' : '';
  dom.scrim.hidden = false;

  const tabs = dom['sheet-tabs'];
  tabs.textContent = '';
  const list = opts.tabs || [];
  tabs.hidden = !list.length;
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.key === opts.active));
    b.textContent = t.label;
    b.addEventListener('click', t.onClick);
    tabs.appendChild(b);
  }

  const body = dom['sheet-body'];
  body.textContent = '';
  fill(body);
  hydrateIcons(dom.sheet);

  // шторка ростом с содержимое — её потолок зависит от того, где сейчас стоит док
  syncDockGap();

  if (!wasOpen) {
    const first = dom.sheet.querySelector(FOCUSABLE);
    (first || dom['btn-sheet-close']).focus();
  }
}

function closeSheet() {
  if (dom.sheet.hidden) return;
  state.sheetOpen = null;
  dom.sheet.hidden = true;
  dom.scrim.dataset.for = '';
  dom.scrim.dataset.quiet = '';
  dom.scrim.hidden = !(railIsDrawer() && dom.app.dataset.rail === 'on');
  // инспектор уступал шторке место — возвращаем его вместе с выделением (п.1)
  if (state.inspBySheet) {
    state.inspBySheet = false;
    if (state.inspQuiet && state.selection.length === 1) {
      state.inspQuiet = false;
      renderInspector();
    }
  }
  const back = sheetReturnFocus;
  sheetReturnFocus = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
}

/** Tab не должен уводить фокус из диалога. */
function trapSheetFocus(e) {
  if (e.key !== 'Tab' || dom.sheet.hidden) return;
  const items = [...dom.sheet.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openHistory(tab) {
  if (tab) state.sheetTab = tab;
  const active = state.sheetTab === 'chat' ? 'chat' : 'edits';
  openSheet('История', (body) => {
    if (active === 'chat') fillChat(body);
    else fillEdits(body);
  }, {
    key: 'history',
    active,
    tabs: [
      { key: 'edits', label: 'Правки', onClick: () => openHistory('edits') },
      { key: 'chat', label: 'Диалог', onClick: () => openHistory('chat') },
    ],
  });
}

function fillEdits(body) {
  if (!state.history.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = 'Пока ничего не менялось.';
    body.appendChild(p);
    return;
  }
  [...state.history].reverse().forEach((tx, idx) => {
    const i = state.history.length - 1 - idx;
    const undone = i >= state.cursor;
    const current = i + 1 === state.cursor;
    const item = document.createElement('div');
    item.className = 'hitem';
    item.dataset.undone = String(undone);
    item.dataset.who = tx.who;
    item.dataset.current = String(current);

    const head = document.createElement('div');
    head.className = 'hhead';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(tx.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    // строка истории — это описание правки, а не сырое имя намерения (п.4)
    const text = human(tx.human || tx.label);
    const what = document.createElement('span');
    what.className = 'what'; what.textContent = text;
    what.title = tx.label && tx.label !== text ? `${text} · команда: ${human(tx.label)}` : text;
    const who = document.createElement('span');
    who.className = 'who'; who.textContent = tx.who === 'agent' ? 'агент' : 'вы';
    head.append(when, what, who);

    const foot = document.createElement('div');
    foot.className = 'hfoot';
    // правки, которых не видно на экране, работой не считаются — так и помечаем (п.18)
    const idle = Array.isArray(tx.invisible) ? tx.invisible : [];
    if (idle.length) {
      const n = idle.length;
      const tag = document.createElement('span');
      tag.className = 'tagpill';
      tag.textContent = `${n} ${plural(n, 'правка', 'правки', 'правок')} без следа на экране`;
      const what2 = [...new Set(idle.map((x) => humanPath(x.path)).filter(Boolean))].slice(0, 4);
      tag.title = what2.length
        ? `Значение записано, но раскладка его не использует: ${what2.join(', ').toLowerCase()}`
        : 'Значение записано, но раскладка его не использует.';
      foot.appendChild(tag);
    }
    if (current) {
      const now = document.createElement('span');
      now.className = 'hnow';
      now.textContent = 'документ сейчас здесь';
      foot.appendChild(now);
    } else {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn subtle small';
      back.textContent = undone ? 'Вернуть эту правку' : 'Вернуться сюда';
      back.title = undone
        ? 'Повторить эту и все правки до неё'
        : 'Откатить документ к состоянию сразу после этой правки';
      back.addEventListener('click', () => { gotoHistory(i + 1); openHistory('edits'); });
      foot.appendChild(back);
    }
    item.append(head, foot);
    body.appendChild(item);
  });
}

function fillChat(body) {
  if (!state.chat.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = 'Разговора пока не было.';
    body.appendChild(p);
    return;
  }
  for (const turn of state.chat) {
    const item = document.createElement('div');
    item.className = 'citem';
    item.dataset.role = turn.role;
    const who = document.createElement('span');
    who.className = 'cwho';
    who.textContent = turn.role === 'agent' ? 'агент' : 'вы';
    const what = document.createElement('p');
    what.className = 'cwhat';
    what.textContent = turn.text;
    item.append(who, what);
    if (turn.note) {
      const sub = document.createElement('p');
      sub.className = 'cnote';
      sub.textContent = turn.note;
      item.appendChild(sub);
    }
    if (turn.followups && turn.followups.length) {
      const chips = document.createElement('div');
      chips.className = 'cchips';
      for (const f of turn.followups) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'msg-chip'; b.textContent = String(f);
        b.addEventListener('click', () => {
          closeSheet();
          dom.command.value = String(f);
          dom.command.focus();
        });
        chips.appendChild(b);
      }
      item.appendChild(chips);
    }
    body.appendChild(item);
  }
  body.scrollTop = body.scrollHeight;
}

function gotoHistory(target) {
  const want = Math.max(0, Math.min(state.history.length, Math.trunc(target) || 0));
  const from = state.cursor;
  let guard = state.history.length + 2;
  while (state.cursor > want && guard-- > 0) { if (!stepHistory(true, { quiet: true })) break; }
  guard = state.history.length + 2;
  while (state.cursor < want && guard-- > 0) { if (!stepHistory(false, { quiet: true })) break; }
  renderAll();
  scheduleSave();
  refreshSheet();
  const moved = Math.abs(state.cursor - from);
  if (state.cursor !== want) {
    showMsg('error', 'Перемотка истории остановилась: дальше правка не откатывается.');
    return;
  }
  if (!moved) return;
  const back = state.cursor < from;
  const word = plural(moved, 'правку', 'правки', 'правок');
  showMsg('plain', back ? `Откатил ${moved} ${word}` : `Вернул ${moved} ${word}`, {
    actions: [{ label: back ? 'Вернуть обратно' : 'Откатить снова', onClick: () => gotoHistory(from) }],
  });
}

/** Открытая шторка «История» устаревает при отмене извне — перерисуем её (п.18). */
function refreshSheet() {
  if (dom.sheet.hidden || state.sheetOpen !== 'history') return;
  openHistory();
}

function openExport() {
  openSheet('Экспорт и импорт', (body) => fillExport(body), { size: 'auto', key: 'export' });
}

/**
 * Имя файла: документ и артборд вместе. Кнопка обещала «PNG · Маршрут дня», а сохраняла
 * «Рабочая-неделя.png» — и второй артборд затирал первый (круг 9, п.7).
 */
function exportName(ext, abId) {
  const doc = safeName(state.doc.meta && state.doc.meta.name);
  const ab = abId ? safeName(nodeTitleById(state.doc, abId)) : '';
  return ab && ab !== doc ? `${doc}-${ab}.${ext}` : `${doc}.${ext}`;
}

/** Активный артборд и его прямоугольник — то, с чего снимают картинку и вектор. */
function exportTarget() {
  const id = activeArtboardId();
  const rect = id ? (state.geo.rects || {})[id] : null;
  const ok = !!(id && finiteRect(rect) && rect.w >= 1 && rect.h >= 1);
  return { id, rect, ok };
}

const PNG_SCALE = 2;

/** Картинка активного артборда. Возвращает true, если файл предложен человеку. */
async function exportPng() {
  const { id, rect, ok } = exportTarget();
  if (!ok) { toast('Картинку снимают с артборда, а его в документе нет.', 'error', 8000); return false; }
  const huge = rect.w * PNG_SCALE > 16384 || rect.h * PNG_SCALE > 16384
    || rect.w * rect.h * PNG_SCALE * PNG_SCALE > 1e8;
  try {
    const blob = await stage.screenshot({ artboardId: id, scale: PNG_SCALE });
    if (dataIsEmpty(blob)) {
      // сцена уже сказала точную причину (внешние картинки, размер полотна) — своё
      // объяснение поверх неё было неправдой (круг 9, п.8)
      const shot = stage.lastShot;
      if (shot && shot.blocked) return false;
      toast(huge
        ? `Артборд ${Math.round(rect.w)}×${Math.round(rect.h)} px в картинку не помещается — сохраните SVG.`
        : 'Картинка не получилась: холст не отдал изображение. Попробуйте SVG.', 'error', 9000);
      return false;
    }
    const saved = await offerFile(exportName('png', id), blob);
    const shot = stage.lastShot;
    if (saved && shot && Number.isFinite(shot.scale) && shot.scale < PNG_SCALE) {
      toast(`Масштаб пришлось понизить до ${Math.round(shot.scale * 100) / 100}× — полотно ${shot.w}×${shot.h} px.`, 'plain', 8000);
    }
    // о шрифтах говорим ровно один раз: сцена сообщает о провале встраивания сама (п.18)
    const fw = saved && shot && shot.fonts !== 'missing' ? fontWarning(shot.fonts, shot.fontsMissing, 'PNG') : '';
    if (fw) showMsg('warn', 'PNG может разойтись с экраном', { note: fw, ms: 11000 });
    return saved;
  } catch (e) {
    toast(`Картинка не получилась: ${humanError(e)}`, 'error', 9000);
    return false;
  }
}

/** Вектор активного артборда. */
async function exportSvg() {
  const { id, ok } = exportTarget();
  if (!ok) { toast('Вектор снимают с артборда, а его в документе нет.', 'error', 8000); return false; }
  /* `toSVG` синхронный и берёт начертания только из кеша, а наполняет его отложенный
     `_warmFonts` (300 мс плюс сеть). Нажатие «Экспорт → SVG» через секунду после
     открытия отдавало файл без единого @font-face: строки в нём считаны системным
     шрифтом и расходятся с экраном до +21 % по ширине. Ждём начертания так же, как это
     делает `screenshot` (круг 13, п.4). */
  let waitShown = false;
  const waitTimer = setTimeout(() => {
    waitShown = true;
    showMsg('plain', 'Готовлю вектор — дотягиваю начертания.', { ms: 15000 });
  }, 350);
  try { await stage.prepareFonts(id); }
  catch { /* не вышло — соберём с тем, что есть, и предупредим ниже */ }
  finally { clearTimeout(waitTimer); }
  if (waitShown) hideMsg();

  let markup = '';
  try { markup = stage.toSVG(id) || ''; }
  catch (e) { toast(`Вектор не получился: ${humanError(e)}`, 'error', 9000); return false; }
  if (dataIsEmpty(markup)) {
    toast('Вектор не получился: сцена не отдала разметку артборда.', 'error', 9000);
    return false;
  }
  // предупреждение — ДО того, как файл отдан: после него оно уже бесполезно
  const meta = stage.lastSVG;
  const fw = meta ? fontWarning(meta.fonts, meta.missing, 'SVG') : '';
  if (fw) showMsg('warn', 'SVG может разойтись с экраном', { note: fw, ms: 11000 });
  return offerFile(exportName('svg', id), markup);
}

/**
 * Шрифты в файл не встроились — он разойдётся с экраном: у IBM Plex Sans системная
 * подмена даёт до +21% к ширине строки. Ядро сообщает это состоянием встраивания
 * (`embedded` | `partial` | `missing` | `none` | `off`) и списком начертаний (круг 11, п.18).
 */
function fontWarning(fonts, missing, what) {
  if (fonts !== 'partial' && fonts !== 'missing') return '';
  const list = (Array.isArray(missing) ? missing : []).filter(Boolean).slice(0, 3).join(', ');
  const head = fonts === 'missing'
    ? `Начертания в ${what} не встроились`
    : `Часть начертаний в ${what} не встроилась`;
  return `${head}${list ? ` (${list})` : ''}: текст посчитан системным шрифтом, и файл может разойтись с тем, что на экране.`;
}

/** Весь документ в JSON — артборд тут ни при чём, имя без него. */
async function exportJson() {
  return offerFile(exportName('json', null), JSON.stringify(state.doc, null, 2));
}

function fillExport(body) {
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = downloads
    ? 'Файл будет предложен к сохранению — подтвердите в диалоге.'
    : 'Сохранение файлов доступно, когда страница запущена локально или получила разрешение.';
  body.appendChild(note);

  const { id: abId, rect, ok: hasBoard } = exportTarget();
  const abName = nodeTitleById(state.doc, abId);
  const wantScale = PNG_SCALE;
  // полотно браузера не безразмерно: на артборде в 48 000 px PNG выходил нулевым файлом,
  // и приложение рапортовало «Сохранено» (п.4). Масштаб подбирает сцена, наше дело —
  // предупредить заранее и честно сказать, что получилось
  const huge = hasBoard && (rect.w * wantScale > 16384 || rect.h * wantScale > 16384
    || rect.w * rect.h * wantScale * wantScale > 1e8);

  // главное действие крупнее, остальные тише (п.4)
  const png = document.createElement('button');
  png.className = hasBoard ? 'btn accent wide lg' : 'btn subtle wide lg';
  if (!hasBoard) {
    png.textContent = 'PNG — нет артборда';
    png.disabled = true;
    png.title = 'Картинку снимают с артборда, а его в документе нет';
  } else {
    png.textContent = abName ? `PNG · ${abName}` : 'PNG активного артборда';
    // на кнопке — имя файла, которое получится: раньше обещание и файл расходились (п.7)
    png.title = `Сохранить как ${exportName('png', abId)}`;
    png.addEventListener('click', async () => {
      png.disabled = true;
      try { await exportPng(); } finally { png.disabled = false; }
    });
  }
  body.appendChild(png);

  const rest = document.createElement('div');
  rest.className = 'btn-row';
  const mk = (label, title, fn, off) => {
    const b = document.createElement('button');
    b.className = 'btn subtle'; b.textContent = label; b.title = off || title;
    if (off) b.disabled = true; else b.addEventListener('click', fn);
    rest.appendChild(b);
  };
  mk(hasBoard ? 'SVG' : 'SVG — нет артборда',
    hasBoard ? `Вектор активного артборда — ${exportName('svg', abId)}` : '',
    () => exportSvg(),
    hasBoard ? '' : 'Вектор снимают с артборда, а его в документе нет');
  mk('JSON', `Весь документ — ${exportName('json', null)}, его можно вернуть импортом`, () => exportJson());
  body.appendChild(rest);

  const hint = document.createElement('div');
  hint.className = 'note';
  hint.textContent = hasBoard
    ? (huge
      ? `Артборд ${Math.round(rect.w)}×${Math.round(rect.h)} px крупный: PNG выйдет в уменьшенном масштабе или не выйдет вовсе — вектор надёжнее.`
      : `PNG — картинка ${Math.round(rect.w * wantScale)}×${Math.round(rect.h * wantScale)} px, SVG — вектор, JSON — весь документ целиком.`)
    : 'Картинка и вектор снимаются с артборда. Пока его нет, можно сохранить только JSON документа.';
  body.appendChild(hint);

  // импорт жил в «Настройках агента», а искать его человек идёт туда, где экспорт (п.21)
  const imp = document.createElement('button');
  imp.className = 'btn subtle wide';
  imp.textContent = 'Импортировать JSON документа';
  imp.addEventListener('click', importJson);
  const impNote = document.createElement('div');
  impNote.className = 'note';
  impNote.textContent = 'Файл станет открытым документом. Прежний вернётся кнопкой «Отменить» или Ctrl+Z.';
  body.appendChild(group('Импорт', [imp, impNote]));
}

/** Пустые данные: null, пустая строка, Blob нулевого размера. */
function dataIsEmpty(data) {
  if (data == null) return true;
  if (typeof data === 'string') return !data.trim();
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size === 0;
  if (typeof data.size === 'number') return data.size === 0;
  if (typeof data.byteLength === 'number') return data.byteLength === 0;
  return false;
}

async function offerFile(filename, data) {
  // пустой файл — это не «Сохранено»: SVG на 0 байт три раза рапортовал успехом (п.4)
  if (dataIsEmpty(data)) {
    toast(`Файл «${filename}» вышел бы пустым — я его не сохранил.`, 'error', 9000);
    return false;
  }
  if (downloads) {
    try {
      await downloads.save({ filename, data });
      toast(`Сохранено: ${filename}`, 'plain');
      return true;
    } catch (e) {
      if (e && e.code === 'declined') return false;
      toast(`Не удалось сохранить: ${(e && e.message) || e}`, 'error');
      return false;
    }
  }
  // локальная сборка: обычная ссылка
  const blob = data instanceof Blob ? data : new Blob([data], { type: guessType(filename) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
function guessType(name) {
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.png')) return 'image/png';
  return 'text/plain';
}
function safeName(s) {
  return (s || 'imago').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/\s+/g, '-') || 'imago';
}

function openSettings() {
  openSheet('Агент', (body) => fillSettings(body), { size: 'auto', key: 'settings' });
}

function fillSettings(body) {
  const status = document.createElement('div');
  status.className = 'note';
  status.textContent = state.providerKind === 'claude'
    ? 'Агент работает через Claude на этой странице.'
    : state.providerKind === 'lmstudio'
      ? `Агент работает через LM Studio: ${settings.lmstudio.baseUrl}`
      : 'Агент не подключён.';
  body.appendChild(status);

  const connect = document.createElement('button');
  connect.className = 'btn subtle wide';
  connect.textContent = 'Подключить LM Studio';
  /* Провайдера меняем ТОЛЬКО после успешной проверки. Раньше замена шла до неё: сервера
     нет — агент всё равно объявлялся «LM Studio», точка у логотипа горела «подключён»,
     любая команда падала «нет связи», и вернуться было нечем (круг 11, п.3). */
  connect.addEventListener('click', async () => {
    const was = connect.textContent;
    connect.disabled = true;
    connect.textContent = 'Проверяю связь…';
    const probe = lmStudioProvider();
    let ok = false;
    try { ok = await probe.ready(); } catch { ok = false; }
    connect.disabled = false;
    connect.textContent = was;
    if (ok) {
      state.provider = probe;
      state.providerKind = 'lmstudio';
      settings.lmstudio.enabled = true;
      saveSettings();
      setRunnable(true);
      toast('LM Studio отвечает — агент работает через неё.', 'plain', 5000);
    } else {
      // прежний агент остаётся на месте, и в настройках это написано словами
      toast(`LM Studio не отвечает на ${settings.lmstudio.baseUrl}. Агент остался прежним: `
        + (state.providerKind === 'claude' ? 'Claude.' : state.provider ? 'прежняя модель.' : 'ни одной модели не подключено.'),
      'error', 9000);
    }
    openSettings();  // перерисовать статус
  });

  const lmRows = [
    row('Адрес', field('input', settings.lmstudio.baseUrl, (v) => { settings.lmstudio.baseUrl = v.trim(); saveSettings(); }, 'Адрес LM Studio')),
    row('Модель', field('input', settings.lmstudio.model, (v) => { settings.lmstudio.model = v.trim(); saveSettings(); }, 'Имя модели')),
    connect,
  ];
  // путь назад виден, пока есть куда возвращаться (п.3)
  if (state.providerKind === 'lmstudio' && claudeProvider) {
    const back = document.createElement('button');
    back.className = 'btn subtle wide';
    back.textContent = 'Вернуться к Claude';
    back.addEventListener('click', () => {
      if (!useClaude()) return;
      toast('Агент снова работает через Claude.', 'plain', 5000);
      openSettings();
    });
    lmRows.push(back);
  }
  body.appendChild(group('Локальная модель (LM Studio)', lmRows));

  // микрофон-переключатель раньше слушал комнату без конца, хотя об этом нигде не сказано (п.9)
  const micOff = dom['btn-mic'] && dom['btn-mic'].disabled;
  /* Нативный чекбокс был единственным на всё приложение, где выбор живёт в пилюлях
     и сегментах (круг 11, п.16). Тот же выбор — тем же органом управления. */
  const always = row('Микрофон', segField(
    ['once', 'always'],
    settings.voiceAlways ? 'always' : 'once',
    (v) => {
      if (micOff) return;
      settings.voiceAlways = v === 'always';
      saveSettings();
      toast(settings.voiceAlways
        ? 'Микрофон будет слушать, пока его не выключить.'
        : 'Микрофон выключается сам после каждой команды.', 'plain', 6000);
      openSettings();
    },
    ['Одна команда', 'Слушать постоянно'],
  ));
  if (micOff) {
    for (const b of always.querySelectorAll('button')) b.disabled = true;
    always.dataset.off = 'on';
  }
  const voiceNote = document.createElement('div');
  voiceNote.className = 'note';
  voiceNote.textContent = micOff
    ? 'Микрофон в артефакте заблокирован платформой — голос работает в локальной сборке.'
    : '«Одна команда»: микрофон выключается сам — после отправки и после десяти секунд тишины. '
      + '«Слушать постоянно»: слышит всё, что говорят рядом, пока его не выключить.';
  body.appendChild(group('Голос', [always, voiceNote]));
}

/**
 * Обход дерева от корня. Цикл или пропавший ребёнок рисуются на холсте, но рельс слоёв
 * от такого документа остаётся пустым, а история правок врёт (п.3).
 */
function treeProblem(doc) {
  const seen = new Set();
  const stack = [doc.root];
  let guard = Object.keys(doc.nodes).length + 8;
  while (stack.length) {
    if (guard-- <= 0) return 'связи узлов замкнуты в кольцо';
    const id = stack.pop();
    if (seen.has(id)) return 'один узел стоит в дереве дважды';
    seen.add(id);
    const n = doc.nodes[id];
    if (!n) return `узел «${id}» назван ребёнком, но не описан`;
    for (const c of (n.children || [])) stack.push(c);
  }
  return null;
}

/**
 * Принять чужой документ — из файла или из хранилища. Проверка одна и та же: чиним копию,
 * сверяем корень и связи, считаем раскладку и требуем от неё числа.
 * Пропущенный битый документ ломает холст навсегда: solve даёт NaN, зум залипает,
 * а scheduleSave() тут же пишет поломку в хранилище — и следующая загрузка мертва (п.2, п.3).
 * @returns {{doc:object, geo:object}} либо бросает ошибку с человеческой причиной
 */
function adoptDoc(raw) {
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object' || !raw.root) {
    throw new Error('не похоже на документ Imago');
  }
  // корень обязан быть среди узлов: иначе createDoc молча отдаст свой демо-документ,
  // и работа человека будет подменена чужим макетом (п.8)
  if (!raw.nodes[raw.root]) throw new Error(`корневой узел «${raw.root}» не описан`);
  // сначала чиним копию и считаем геометрию — состояние трогаем, только если всё сошлось
  const next = createDoc(raw);
  if (!next || !next.nodes || !next.root || !next.nodes[next.root]) {
    throw new Error('в документе нет корневого узла');
  }
  // и ещё раз сверяемся с тем, что пришло: у подменённого документа и корень, и узлы чужие.
  // Разобранных узлов может стать меньше (битые рёбра отбрасываются), но не больше.
  const alien = Object.keys(next.nodes).filter((id) => !raw.nodes[id]);
  if (next.root !== raw.root || alien.length) throw new Error('не разобрался как документ Imago');
  const tree = treeProblem(next);
  if (tree) throw new Error(tree);
  const geo = solve(next);
  if (!geo || !geo.rects) throw new Error('раскладка не считается');
  // createDoc чинит узлы не по схеме, но починка бывает и неполной: размер без числа
  // доходит до solve и возвращается как NaN. Такой документ до состояния не допускаем.
  const broken = firstBrokenRect(geo);
  if (broken) {
    const name = nodeTitleById(next, broken) || broken;
    throw new Error(`размеры узла «${name}» — не числа, раскладка не считается`);
  }
  if (!geo.rects[next.root] && artboards(next).length) throw new Error('раскладка не считается');
  // createDoc отбрасывает узлы, которые не починить, и пишет об этом только в консоль:
  // человеку надо сказать, сколько из его файла не прочиталось (п.30). Узел, который
  // пришлось переродить в корневую страницу, с холста тоже исчез — он тоже потерян,
  // иначе импорт рапортует «узлов: 1» на пустом холсте (п.20)
  let lost = 0;
  /* Круг 16, п.12. Считать только пропавшие УЗЛЫ мало: на документе с вложением по кругу
     все три узла на месте, а одно ребро createDoc выкидывает — и импорт рапортовал
     «узлов: 3» так, будто прочитал файл целиком. Считаем и рёбра: ребёнок уцелел, но
     перестал быть ребёнком этого родителя — значит, связь не сохранилась. */
  let lostEdges = 0;
  for (const id of Object.keys(raw.nodes)) {
    const was = raw.nodes[id];
    const now = next.nodes[id];
    if (!now) { lost += 1; continue; }
    const wasPage = !!was && typeof was === 'object' && was.type === 'page';
    if (!wasPage && now.type === 'page') lost += 1;
    const wasKids = was && typeof was === 'object' && Array.isArray(was.children) ? was.children : [];
    const nowKids = new Set(Array.isArray(now.children) ? now.children : []);
    for (const kid of wasKids) {
      if (typeof kid === 'string' && next.nodes[kid] && !nowKids.has(kid)) lostEdges += 1;
    }
  }
  return { doc: next, geo, lost, lostEdges };
}

/* Круг 16, п.13. Порог «большого документа». Замеры круга: 3 077 узлов — validate 18…30 мс,
   12 077 — validate 74…77 мс, solve 178 мс. Выше этого порога перерисовка перестаёт
   укладываться в кадр, и человеку об этом говорят словами. */
const BIG_DOC = 5000;

/**
 * Импорт — обычная транзакция: шаг в истории, «Отменить» в доке, Ctrl+Z работает.
 * Раньше он стирал документ и историю без возврата, предупреждая серой строкой (п.1).
 */
/**
 * Разбор файла. Сообщение парсера — английское и про позицию в потоке: в русском
 * интерфейсе ему не место (п.14).
 */
function parseJsonFile(text) {
  try { return JSON.parse(text); }
  catch (e) {
    const at = /position\s+(\d+)/i.exec(String((e && e.message) || ''));
    throw new Error(at
      ? `файл не читается как JSON — разбор оборвался на символе ${Number(at[1]) + 1}`
      : 'файл не читается как JSON');
  }
}

function importJson() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      /* Круг 16, п.13(б). Разбор и раскладка большого документа держат поток несколько
         секунд, и всё это время экран не отвечает ничем. Нарисовать что-нибудь ВО ВРЕМЯ
         работы нельзя — кадр просто не выйдет, и «крутилка», поставленная перед
         синхронным куском, так и не покажется. Зато перед ним есть настоящая точка
         ожидания: ставим строку и отдаём браузеру два кадра, чтобы она успела встать. */
      showMsg('plain', `Открываю «${clip(f.name, 40)}»…`);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const taken = adoptDoc(parseJsonFile(text));
      const wasName = docName(state.doc);
      const nowName = docName(taken.doc);
      // свёрнутые ветки старого документа к новому не относятся; пустой список означал бы
      // «ничего не свёрнуто» — и рельс открывался на 76 строк вместо активного артборда
      state.selection = [];
      state.collapsed = null;
      const count = Object.keys(taken.doc.nodes).length;
      // импорт — осознанное решение: если сохранение было заморожено непрочитанным
      // документом, дальше пишем как обычно (копия прежнего осталась на месте)
      const wasBlocked = !!state.saveBlocked;
      state.saveBlocked = null;
      const r = commitDoc(taken.doc, taken.geo, `Импорт «${nowName}»`,
        `Загрузил «${nowName}» вместо «${wasName}»`);
      closeSheet();
      state.userView = false;
      fitSmart();
      const blank = artboards(taken.doc).length === 0;
      const bits = [`узлов: ${count}`];
      if (taken.lost) {
        bits.push(`не прочитал ${taken.lost} ${plural(taken.lost, 'узел', 'узла', 'узлов')}`);
      }
      // круг 16, п.12: узлы целы, а вложение пришлось выпрямить — молчать об этом нельзя
      if (taken.lostEdges) {
        bits.push(`не сохранил ${taken.lostEdges} `
          + `${plural(taken.lostEdges, 'связь', 'связи', 'связей')} между узлами — вложение выпрямлено`);
      }
      if (blank) bits.push('артбордов в файле не оказалось — холст пуст');
      /* Круг 16, п.13(б). На таком документе правка и отмена занимают заметное время, и
         честнее сказать об этом заранее, чем оставлять человека гадать, не завис ли
         редактор: во время самой правки поток занят и нарисовать предупреждение нечем. */
      if (count >= BIG_DOC) bits.push('документ большой — правка и отмена будут заметно медленнее');
      bits.push(`прежний документ «${wasName}» вернётся по «Отменить»`);
      if (wasBlocked) bits.push('сохранение снова включено, копия непрочитанного документа осталась');
      addChat('agent', `Загрузил документ «${nowName}» вместо «${wasName}»`, [], bits.join(' · '));
      showMsg(taken.lost || taken.lostEdges || blank ? 'warn' : 'result', `Загружен документ «${nowName}»`, {
        note: bits.join(' · '),
        actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
        undoTx: r.tx.id,
      });
    } catch (e) {
      // ошибки импорта жили тостом сверху, а всё остальное — сообщением снизу: место
      // для разговора о документе одно, и оно в доке (п.15)
      closeSheet();
      showMsg('error', 'Файл не открылся — документ остался прежним', {
        note: `Причина: ${(e && e.message) || e}.`,
        actions: [{ label: 'Выбрать другой файл', primary: true, onClick: () => importJson() }],
      });
    }
  });
  inp.click();
}

function docName(doc) {
  return (doc && doc.meta && doc.meta.name) || 'Без названия';
}

/* --------------------------------- подсказки --------------------------------- */

function renderHints() {
  // пока агент работает или висит знакомство, чипы убираем:
  // они спорят с лентой стадий и повторяют примеры из сообщения
  // и пока на экране переспрос: чипы ответа лежат в самом вопросе, а нижние подсказки
  // тихо затирали подставленный префикс, оставляя вопрос висеть (круг 13, п.10)
  if (state.busy || state.introOpen || state.awaitingClarify) { dom.hints.textContent = ''; return; }
  const sel = state.selection.filter((id) => state.doc.nodes[id]);
  const node = sel.length === 1 ? state.doc.nodes[sel[0]] : null;
  let list;
  if (node && node.type === 'text') {
    list = ['сделай крупнее и добавь подзаголовок', 'перепиши короче и строже', 'выровняй по центру'];
  } else if (node && isArtboard(state.doc, node.id)) {
    list = ['добавь нижнюю панель с тремя кнопками', 'сделай тёмную тему', 'добавь шапку с аватаром и датой'];
  } else if (node) {
    list = ['добавь сюда кнопку «Оплатить»', 'увеличь отступы и скругления', 'разложи в строку с равными долями'];
  } else {
    list = ['экран оплаты с полем карты и итогом', 'добавь блок отзывов из трёх карточек', 'собери дашборд из четырёх плиток'];
  }
  dom.hints.textContent = '';
  // на пустом документе и пустом артборде примеры уже показаны на холсте
  if (docIsEmpty() || activeArtboardIsEmpty()) return;
  for (const ex of list.slice(0, 3)) {
    const b = document.createElement('button');
    b.className = 'hint'; b.type = 'button'; b.textContent = ex;
    b.title = 'Подставить в командную строку';
    b.addEventListener('click', () => { dom.command.value = ex; dom.command.focus(); });
    dom.hints.appendChild(b);
  }
}

/* ---------------------------------- тосты ------------------------------------ */

/**
 * Вложенные кавычки: «Кнопка «Добавить пункт»» читается как опечатка.
 * Внутренний уровень — лапки „…“ (п.23).
 */
function human(text) {
  let depth = 0;
  let out = '';
  // технические пути → слова инспектора: «layout.gap» человеку ничего не говорит (п.9)
  for (const ch of humanizePaths(text)) {
    if (ch === '«') { out += depth ? '„' : '«'; depth += 1; }
    else if (ch === '»') { depth = Math.max(0, depth - 1); out += depth ? '“' : '»'; }
    else out += ch;
  }
  return out;
}

/* Где человек действовал в последний раз: по этому месту тост и встаёт. */
let lastActionHost = null;

function initToastAnchor() {
  const mark = (e) => { lastActionHost = e.target || null; };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('focusin', mark, true);
}

/**
 * Тост всегда всплывал сверху по центру — над холстом, а вызывала его панель настроек
 * справа вверху или поле инспектора справа внизу: сообщение и его причина оказывались
 * в разных углах экрана (круг 13, п.10). Ставим тост у той панели, в которой человек
 * действовал; если такой нет — прежнее место сверху по центру.
 */
function placeToasts() {
  const box = dom.toasts;
  if (!box) return;
  const a = lastActionHost;
  let host = null;
  const hosts = [dom.sheet, dom.variants, dom.inspector, dom.rail, dom.dock, document.querySelector('.topbar')];
  if (a && a.nodeType === 1) {
    for (const h of hosts) {
      if (h && !h.hidden && h.contains(a) && h.getBoundingClientRect().height > 0) { host = h; break; }
    }
  }
  if (!host) {
    box.style.left = ''; box.style.top = ''; box.style.transform = ''; box.style.maxWidth = '';
    return;
  }
  const r = host.getBoundingClientRect();
  const vw = globalThis.innerWidth || 0;
  const vh = globalThis.innerHeight || 0;
  // тост не шире своей панели: над инспектором он иначе вылезал за край окна
  const w = Math.min(560, Math.max(240, r.width - 12), vw - 24);
  const half = w / 2;
  const cx = Math.max(half + 12, Math.min(vw - half - 12, r.left + r.width / 2));
  box.style.maxWidth = `${Math.round(w)}px`;
  box.style.left = `${Math.round(cx)}px`;
  if (r.bottom + 96 < vh) {                 // место под панелью — встаём под ней
    box.style.top = `${Math.round(r.bottom + 10)}px`;
    box.style.transform = 'translateX(-50%)';
  } else if (r.top - 96 > 0) {              // место над панелью — встаём над ней
    box.style.top = `${Math.round(r.top - 10)}px`;
    box.style.transform = 'translate(-50%, -100%)';
  } else {                                  // панель во всю высоту (рельс, инспектор) — у её верха
    box.style.top = `${Math.round(Math.max(12, r.top) + 12)}px`;
    box.style.transform = 'translateX(-50%)';
  }
}

function toast(text, kind = 'plain', ms = 5000) {
  placeToasts();
  const t = document.createElement('div');
  t.className = 'toast'; t.dataset.kind = kind;
  const span = document.createElement('span');
  span.textContent = human(text);
  t.appendChild(span);
  dom.toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* -------------------------------- сохранение --------------------------------- */

function scheduleSave() {
  state.dirty = true;
  state.docRev += 1;   // номер правки: по нему видно, устарела ли запись в полёте (п.1)
  rearmSave();
}

/** Перенести запись на потом, не объявляя новой правки. */
function rearmSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

/** Одна транзакция в виде записи для хранилища — вместе с её объёмом. */
function packTx(tx) {
  if (!tx) return null;
  const rec = {
    id: tx.id, kind: tx.kind === 'doc' ? 'doc' : 'ops',
    label: String(tx.label || ''), human: String(tx.human || ''),
    who: tx.who === 'agent' ? 'agent' : 'human',
    at: Number.isFinite(tx.at) ? tx.at : Date.now(), undone: !!tx.undone,
  };
  if (rec.kind === 'doc') { rec.docBefore = tx.docBefore; rec.docAfter = tx.docAfter; }
  else { rec.ops = tx.ops || []; rec.inverse = tx.inverse || []; }
  let size = 0;
  try { size = JSON.stringify(rec).length; } catch { return null; }
  return { rec, size };
}

/**
 * История правок рядом с документом: иначе после перезагрузки правку, которая на экране,
 * отменить нечем (п.4). Длину ограничиваем и числом шагов, и объёмом.
 * Резать спереди можно только то, что уже применено: как только срез уходит ниже курсора,
 * сохранённому документу перестаёт соответствовать первая запись, и «Повтор» после
 * перезагрузки бьёт по узлам, которых нет (п.3). Не поместилось — лучше отдать пустую
 * историю: «отменять нечего» честнее, чем промах повтора.
 */
function packHistory() {
  const total = state.history.length;
  const cursor = Math.max(0, Math.min(total, state.cursor));
  const keep = Math.min(total, HISTORY_SAVE_LIMIT);
  const from = Math.max(0, Math.min(cursor, total - keep));
  const to = Math.min(total, from + keep);
  const win = [];
  for (let i = from; i < to; i++) {
    const packed = packTx(state.history[i]);
    if (!packed) {
      // запись не сериализуется: цепочку рвать нельзя. Что было до курсора — отбрасываем
      // целиком, что после — дальше не сохраняем
      if (i < cursor) { win.length = 0; continue; }
      break;
    }
    win.push({ i, rec: packed.rec, size: packed.size });
  }
  let bytes = win.reduce((sum, w) => sum + w.size, 0);
  while (bytes > HISTORY_SAVE_BYTES && win.length && win[0].i < cursor) bytes -= win.shift().size;
  while (bytes > HISTORY_SAVE_BYTES && win.length) bytes -= win.pop().size;
  const first = win.length ? win[0].i : cursor;
  return { list: win.map((w) => w.rec), cursor: Math.max(0, cursor - first) };
}

/** Снимок для хранилища: документ, разговор и история — одним объектом. */
function savePayload() {
  const past = packHistory();
  // историю разговора храним рядом с документом: она переживает перезагрузку (п.12)
  return {
    doc: state.doc,
    chat: state.chat.slice(-60),
    pairs: state.pairs.slice(-5),
    history: past.list,
    cursor: past.cursor,
    collapsed: state.collapsed ? [...state.collapsed].slice(0, 400) : null,
    savedAt: Date.now(),
  };
}

/** Копия в памяти браузера. Что удалось записать: 'full', 'short' или '' — ничего. */
function writeLocal(payload) {
  try { localStorage.setItem(LOCAL_DOC_KEY, JSON.stringify(payload)); return 'full'; }
  catch { /* не влезло — пробуем без истории: документ важнее её */ }
  try {
    localStorage.setItem(LOCAL_DOC_KEY, JSON.stringify({
      doc: payload.doc, chat: (payload.chat || []).slice(-10), pairs: payload.pairs,
      collapsed: payload.collapsed, savedAt: payload.savedAt,
    }));
    return 'short';
  } catch { return ''; }
}

/** Идёт ли запись прямо сейчас: параллельные записи обгоняют друг друга. */
let saveFlight = false;

async function saveNow() {
  if (!state.dirty) return;
  // пока человек не решил судьбу непрочитанного документа, писать поверх него нельзя (п.2)
  if (state.saveBlocked) return;
  // запись уже в полёте: вторую рядом не начинаем, а переносим на после неё
  if (saveFlight) { rearmSave(); return; }
  const rev = state.docRev;
  const payload = savePayload();
  /**
   * Правка, сделанная пока запись летела, сохранённой не считается: её номер больше того,
   * что мы записали, и флаг остаётся поднятым, а запись — назначенной заново (п.1).
   */
  const done = () => {
    if (state.docRev === rev) { state.dirty = false; return; }
    rearmSave();   // правка новее записанной: флаг не снимаем, запись назначаем заново
  };
  if (db) {
    saveFlight = true;
    try {
      await db.doc('docs/current').set(payload);
      done();
      return;
    } catch { /* упадём в локальное хранилище */ }
    finally { saveFlight = false; }
  }
  const wrote = writeLocal(payload);
  if (wrote) {
    done();
    if (wrote === 'short' && !state.storageWarned) {
      state.storageWarned = true;
      toast('История правок не поместилась в память браузера — документ сохранён без неё.', 'plain', 9000);
    }
    return;
  }
  // место кончилось или приватный режим: документ остаётся несохранённым, и об этом надо сказать
  state.dirty = true;
  if (!state.storageWarned) {
    state.storageWarned = true;
    showMsg('error', 'Документ не сохраняется', {
      note: 'Память браузера переполнена или закрыта для этой страницы. Сохраните документ файлом — он не пропадёт.',
      actions: [{ label: 'Экспорт', primary: true, onClick: openExport }],
    });
  }
}

/**
 * Уход со страницы. Между правкой и записью всегда до 1,2 с, и закрытие вкладки в это
 * окно забирало последнюю правку с собой (п.2). Копию в памяти браузера пишем синхронно —
 * она успевает; запись в хранилище артефакта отправляем вдогонку, не дожидаясь ответа.
 */
function saveOnExit() {
  if (!state.dirty || state.saveBlocked) return;
  clearTimeout(saveTimer);
  const payload = savePayload();
  writeLocal(payload);
  if (!db) return;
  try {
    const p = db.doc('docs/current').set(payload);
    if (p && typeof p.catch === 'function') p.catch(() => { /* не успели — осталась копия рядом */ });
  } catch { /* хранилище не ответило — осталась копия в памяти браузера */ }
}

/** Копия из памяти браузера: сырой текст (для копии непрочитанного) и разобранные данные. */
function readLocal() {
  let raw = null;
  try { raw = localStorage.getItem(LOCAL_DOC_KEY); } catch { return null; }
  if (!raw) return null;
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  return { raw, data: data && typeof data === 'object' ? data : null };
}

async function restoreFromDb() {
  let saved = null;
  try {
    const snap = await db.doc('docs/current').get();
    // data бывает и функцией (снимок в духе Firestore), и просто полем: раньше поле
    // вызывалось как функция, восстановление падало в catch и молча не происходило
    const data = snap && (typeof snap.data === 'function' ? snap.data() : snap.data);
    saved = data || null;
  } catch { saved = null; /* документа ещё нет */ }
  // при уходе со страницы копия в памяти браузера пишется синхронно, а запись в хранилище
  // успевает не всегда: если копия новее — восстанавливаем из неё (п.2)
  const near = readLocal();
  const fresher = near && near.data && near.data.doc
    && Number(near.data.savedAt || 0) > Number((saved && saved.savedAt) || 0) + 500;
  if (fresher) return adoptSaved(near.data, 'local', near.raw);
  if (!saved) return false;
  if (!saved.doc) {
    // в записи есть что-то, но не документ: молчать нельзя — иначе ближайшее сохранение
    // затрёт единственный экземпляр работы (п.3)
    await keepBrokenDb(saved, 'в сохранённой записи нет документа');
    blockSaving(saved, 'в сохранённой записи нет документа', 'db');
    return false;
  }
  return adoptSaved(saved, 'db');
}

async function restoreFromLocal() {
  const near = readLocal();
  if (!near) return false;
  const saved = near.data;
  if (!saved || !saved.doc) {
    // раньше эта ветка молчала: открывался демо-документ, и он же уезжал в хранилище (п.3)
    keepBroken(near.raw);
    blockSaving(near.raw, saved ? 'в сохранённых данных нет документа' : 'сохранённые данные не читаются как JSON', 'local');
    return false;
  }
  return adoptSaved(saved, 'local', near.raw);
}

/**
 * Хранилище проходит ту же проверку, что и файл: раньше восстановление смотрело только
 * на наличие nodes, поэтому документ с чужим корнем открывался пустым холстом с тостом
 * «Документ восстановлен», а документ с циклом — пустым рельсом слоёв (п.3).
 */
async function adoptSaved(saved, from, raw) {
  let taken = null;
  try { taken = adoptDoc(saved.doc); }
  catch (e) {
    const why = (e && e.message) || e;
    // копию кладём ДО первого сохранения: в хранилище артефакта это единственный экземпляр (п.2)
    if (from === 'local') keepBroken(raw != null ? raw : JSON.stringify(saved));
    else await keepBrokenDb(saved, why);
    blockSaving(raw != null ? raw : saved, why, from);
    return false;
  }
  state.doc = taken.doc;
  state.geo = taken.geo;
  // разговор живёт рядом с документом: без него «верни как было» не на что опереться (п.12)
  state.chat = sanitizeChat(saved.chat);
  state.pairs = sanitizePairs(saved.pairs);
  const past = sanitizeHistory(saved.history, saved.cursor);
  state.history = past.list;
  state.cursor = past.cursor;
  state.collapsed = Array.isArray(saved.collapsed) && saved.collapsed.length
    ? new Set(saved.collapsed.filter((id) => typeof id === 'string'))
    : null;
  renderAll();
  fitSmart();
  // потеря узлов — разговор о документе: ему место в доке рядом с командной строкой (п.15)
  if (taken.lost) {
    showMsg('warn', 'Документ восстановлен не полностью', {
      note: `${taken.lost} ${plural(taken.lost, 'узел', 'узла', 'узлов')} из сохранённой копии прочитать не удалось.`,
    });
  } else {
    toast('Документ восстановлен', 'plain', 3000);
  }
  return true;
}

/** Битую копию не выбрасываем: иначе первое же сохранение затрёт единственный след работы. */
function keepBroken(raw) {
  try { localStorage.setItem(BROKEN_DOC_KEY, String(raw).slice(0, 4 * 1024 * 1024)); }
  catch { /* места нет — тогда и копии не будет */ }
}

/** То же для хранилища артефакта: там запись под docs/current — единственный экземпляр (п.2). */
async function keepBrokenDb(payload, why) {
  if (!db) return false;
  try {
    await db.doc(BROKEN_DB_PATH).set({ payload, why: String(why || ''), savedAt: Date.now() });
    return true;
  } catch { return false; }
}

/**
 * Документ не открылся. До решения человека не сохраняем ничего: одно нажатие «Новый артборд»
 * раньше через 1,2 с затирало работу демо-документом (п.2).
 */
function blockSaving(payload, why, from) {
  state.saveBlocked = { payload, why };
  const where = from === 'local'
    ? 'копия осталась в памяти браузера'
    : 'копия отложена в хранилище рядом с документом';
  showMsg('error', 'Сохранённый документ не открылся', {
    note: `Причина: ${why}. Пока вы не решите, я ничего не сохраняю — ${where}.`,
    actions: [
      { label: 'Скачать копию', primary: true, onClick: () => downloadBroken() },
      {
        label: 'Начать заново',
        onClick: () => {
          state.saveBlocked = null;
          hideMsg();
          scheduleSave();
          toast('Дальше сохраняю как обычно. Копия прежнего документа осталась на месте.', 'plain', 7000);
        },
      },
    ],
  });
}

async function downloadBroken() {
  const held = state.saveBlocked;
  const payload = held ? held.payload : null;
  if (payload == null) { toast('Копии нет — сохранять нечего.', 'error'); return; }
  let text = '';
  try { text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2); }
  catch { text = String(payload); }
  await offerFile('imago-не-открылся.json', text);
}

/** Одна запись истории из хранилища — или null, если применить её обратно нельзя. */
function takeTx(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const kind = rec.kind === 'doc' ? 'doc' : 'ops';
  const head = {
    id: String(rec.id || txId()), kind,
    label: String(rec.label || (kind === 'doc' ? 'Документ' : 'Правка')),
    human: String(rec.human || ''),
    who: rec.who === 'agent' ? 'agent' : 'human',
    at: Number.isFinite(rec.at) ? rec.at : Date.now(), undone: !!rec.undone,
  };
  if (kind === 'doc') {
    if (!rec.docBefore || !rec.docAfter) return null;
    return { ...head, ops: [], inverse: [], docBefore: rec.docBefore, docAfter: rec.docAfter };
  }
  if (!Array.isArray(rec.ops) || !Array.isArray(rec.inverse) || !rec.ops.length) return null;
  return { ...head, ops: rec.ops, inverse: rec.inverse };
}

/**
 * История из хранилища: принимаем только то, что можно применить обратно, и только
 * цельной цепочкой. Пропуск записи в середине сдвигает курсор, и отмена с повтором
 * начинают бить мимо узлов (п.3): запись до курсора отбрасывает всё прежнее,
 * запись после курсора обрывает чтение.
 */
function sanitizeHistory(list, cursor) {
  if (!Array.isArray(list) || !list.length) return { list: [], cursor: 0 };
  const cut = Math.max(0, list.length - HISTORY_SAVE_LIMIT);
  const src = list.slice(cut);
  const raw = Number.isFinite(cursor) ? Math.trunc(cursor) : list.length;
  // срез спереди уносит применённые записи: если документ стоял до них, цепочке
  // соответствовать нечему — честнее отдать пустую историю
  if (raw < cut) return { list: [], cursor: 0 };
  const want = Math.max(0, Math.min(src.length, raw - cut));
  const out = [];
  let dropped = 0;
  for (let i = 0; i < src.length; i++) {
    const tx = takeTx(src[i]);
    if (!tx) {
      if (i < want) { dropped = i + 1; out.length = 0; continue; }
      break;
    }
    out.push(tx);
  }
  return { list: out, cursor: Math.max(0, Math.min(out.length, want - dropped)) };
}

function sanitizeChat(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-100)
    .map((t) => ({
      role: t.role === 'agent' ? 'agent' : 'you',
      text: String(t.text).slice(0, 2000),
      note: typeof t.note === 'string' ? t.note.slice(0, 500) : '',
      at: Number.isFinite(t.at) ? t.at : Date.now(),
      followups: Array.isArray(t.followups) ? t.followups.slice(0, 3).map(String) : [],
    }));
}

function sanitizePairs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.utterance === 'string' && p.utterance.trim())
    .slice(-5)
    .map((p) => ({ utterance: String(p.utterance).slice(0, 500), summary: String(p.summary || '').slice(0, 500) }));
}

/* -------------------------------- настройки ---------------------------------- */

function loadSettings() {
  // локальная сборка кладёт свои значения по умолчанию в window.IMAGO_DEFAULTS
  const dflt = (typeof globalThis !== 'undefined' && globalThis.IMAGO_DEFAULTS) || {};
  const base = {
    // «как в системе» по умолчанию: человек со светлой системой получал тёмное
    // приложение при первом запуске (круг 9, п.13)
    theme: 'auto',
    rail: 'auto',
    introSeen: false,
    voiceAlways: false,   // «слушать постоянно» — по выбору человека, не по умолчанию (п.9)
    ...dflt,
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234/v1', model: 'local-model', ...(dflt.lmstudio || {}) },
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    const merged = { ...base, ...parsed, lmstudio: { ...base.lmstudio, ...(parsed.lmstudio || {}) } };
    delete merged.collapsed;   // свёрнутые ветки переехали к документу (п.20)
    return merged;
  } catch { return base; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ок */ }
}
/** Рельс слоёв: на узком экране по умолчанию свёрнут. */
function isNarrow() { return typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches; }

/* ---- режим боковых панелей: колонка сетки или накладка (круг 16, п.1) ----------
   Рельс 208 + инспектор 252…288 + варианты 352: трём колонкам нужно ≥ 1268 px окна.
   Ниже холсту оставалось 89…432 px, и командная строка разрушалась — поле сжималось
   до 8 px, «Выполнить» уезжала за строку поверх инспектора, панель вида ложилась на
   рельс и накрывала «Свернуть», то есть способ вернуть место становился некликабельным.
   Командная строка — главный элемент приложения, поэтому колонке холста гарантирован
   минимум, а панели уступают её по очереди и остаются доступны:
     инспектор → нижний лист в пределах холста (виден целиком, док встаёт над ним),
     рельс     → выдвижная шторка со затемнением, как на узком экране.
   Уступка — не настройка: settings.rail не трогаем, колонки возвращаются сами, как
   только окно шире или варианты закрыты. Порядок уступки — от того, что нужно здесь и
   сейчас: инспектор открывается сам по выделению (и ту же уступку уже делает ветка
   ≤900 при открытых вариантах), а рельс человек включал руками. */
const CANVAS_MIN = 420;
let panelSyncBusy = false;

function railIsDrawer() { return (dom.app && dom.app.dataset.railMode) === 'drawer'; }
function inspIsSheet() { return (dom.app && dom.app.dataset.inspMode) === 'sheet'; }

function syncPanelModes() {
  const app = dom.app;
  if (!app || panelSyncBusy) return;
  let inspMode = 'col';
  let railMode = 'col';
  if (isNarrow()) {
    inspMode = 'sheet';
    railMode = 'drawer';
  } else {
    const cs = getComputedStyle(app);
    const px = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
    const w = globalThis.innerWidth || 0;
    /* Считаем по объявленным ширинам, а не по замеру холста: замер уже учитывает
       уступку, и режим начал бы дребезжать. Рельс считаем открытым, пока человек сам
       его не закрыл, — иначе, свернув его за него, мы бы тут же вернули ему колонку
       и зациклились. */
    const railW = settings.rail === 'off' ? 0 : px('--rail-w');
    const inspW = app.dataset.insp === 'on' ? px('--insp-w') : 0;
    const varsW = app.dataset.variants === 'on' ? px('--vars-w') : 0;
    let side = railW + inspW + varsW;
    if (w - side < CANVAS_MIN && inspW) { inspMode = 'sheet'; side -= inspW; }
    if (w - side < CANVAS_MIN && railW) { railMode = 'drawer'; side -= railW; }
  }
  const wasRail = app.dataset.railMode || 'col';
  if ((app.dataset.inspMode || 'col') !== inspMode) {
    app.dataset.inspMode = inspMode;
    scheduleViewRecheck(240);
  }
  if (wasRail === railMode) return;
  app.dataset.railMode = railMode;
  panelSyncBusy = true;
  try {
    /* Шторка модальная — сама открыться она не должна: складываем рельс, не трогая
       настройку. Вернулась колонка — возвращаем рельс к настройке. */
    if (railMode === 'drawer') { if (app.dataset.rail === 'on') setRail('off'); }
    else applyRail();
  } finally { panelSyncBusy = false; }
  scheduleViewRecheck(240);
}

function applyRail() {
  const value = settings.rail === 'on' || settings.rail === 'off' ? settings.rail : (isNarrow() ? 'off' : 'on');
  setRail(value);
}

function setRail(value, remember = false) {
  const was = dom.app.dataset.rail;
  dom.app.dataset.rail = value;
  if (was !== value) scheduleViewRecheck(240);   // рельс уезжает с анимацией (п.13)
  dom['btn-rail'].setAttribute('aria-expanded', String(value === 'on'));
  if (remember) { settings.rail = value; saveSettings(); }
  /* Узкий экран: рельс — не колонка, а шторка на том же месте, что нижний лист
     инспектора. Вместе они дают кашу: рельс ложится поверх инспектора, и тот торчит
     из-под него обрывками — одинокий «×», правые края полей, стрелки селектов
     (круг 15, п.1). Держим открытой ровно одну шторку. */
  if (value === 'on' && railIsDrawer() && dom.app.dataset.insp === 'on') {
    state.inspQuiet = true;
    state.inspByRail = true;   // свернём рельс — вернём инспектор: выделение никуда не делось
    renderInspector();
  } else if (value === 'off' && state.inspByRail) {
    state.inspByRail = false;
    if (state.inspQuiet && state.selection.length === 1) {
      state.inspQuiet = false;
      renderInspector();
    }
  }
  if (dom.scrim.dataset.for !== 'sheet') dom.scrim.hidden = !(railIsDrawer() && value === 'on');
  // рельс освободил или занял колонку — бюджет холста изменился (круг 16, п.1)
  syncPanelModes();
}
const THEME_WORDS = { dark: 'Тема: тёмная', light: 'Тема: светлая', auto: 'Тема: как в системе' };

/** Тема интерфейса по кругу: как в системе → светлая → тёмная. */
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const i = order.indexOf(THEME_WORDS[settings.theme] ? settings.theme : 'auto');
  setTheme(order[(i + 1) % order.length]);
}

function setTheme(theme) {
  settings.theme = THEME_WORDS[theme] ? theme : 'auto';
  applyTheme(settings.theme);
  saveSettings();
  toast(THEME_WORDS[settings.theme], 'plain', 3000);
}

function applyTheme(theme) {
  // «как в системе» — это отсутствие атрибута: тогда и работает @media (prefers-color-scheme)
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  if (dom['btn-theme']) {
    const now = THEME_WORDS[theme] || THEME_WORDS.auto;
    dom['btn-theme'].title = `${now}. Нажмите, чтобы сменить`;
    dom['btn-theme'].setAttribute('aria-label', dom['btn-theme'].title);
  }
}

/* Запуск — последней строкой: к этому моменту объявлены все константы модуля. */
boot();
