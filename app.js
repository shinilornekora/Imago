/**
 * Imago Studio — оболочка AI-first редактора макетов.
 * Человек формулирует задачу, агент строит; ручные инструменты рядом, но необязательны.
 */
import {
  createDoc, applyOps, invertOps, solve, validate, Stage, ops as OPS,
  nodeById, ancestors, isArtboard, artboards, subtreeIds, hashGeometry,
  placeholderName, displayName,
  /* Круг 19 (SPEC §5): компоненты. Оболочка не заводит своих структур — всё, что она
     знает о библиотеке, она спрашивает у ядра, а правки берёт готовыми операциями. */
  isLibrary, libraryNode, ensureLibrary, components as libComponents,
  isMaster, masterOf, componentName, canMakeComponent, makeComponentOps, instanceOps,
  detachInstanceOps, instanceSummary, PROP_KINDS,
  /* Круг 20 (SPEC §6): шкалы как ссылки. Зазор, отступы и скругление в документе — строки
     'spacing.<i>' / 'radii.<i>'; числом их отдаёт ТОЛЬКО ядро (resolveLayout, resolveRadius,
     resolveScale), и оболочка читает эти поля исключительно через него (§6.3). */
  resolveScale, resolveLayout, resolveRadius, parseScaleRef, isScaleRef, scaleRef,
  scaleIndexOf, scaleSteps, SCALE_NAMES, ensureScaleRefs, scaleRefsIn, insertScaleStep,
  /* Круг 22 (SPEC §8–9): в серверном режиме миграции формата — не тихая правка снимка,
     а системная транзакция из тех же операций, что делает ensureLibrary/ensureScaleRefs. */
  ensureLibraryOps, ensureScaleRefsOps,
} from './src/core.js';
import * as CORE from './src/core.js';
import { makeProvider, runCommand, runVariants } from './src/brain.js';
/* Круг 53 (SPEC §20): цвета картинок документа для арт-директора — пиксели считает страница. */
import { paletteFromPixels, srcKey, SWATCH_LIMITS } from './src/swatches.js';
/* Круг 22 (SPEC §9.5): клиент-реплика. Документ в серверном режиме живёт в ней, а не в
   localStorage/db; оболочка получает view и шлёт транзакции. */
import { createSync, idbStorage, memoryStorage, droppedLine, statusLine, engineWords, LIMITS } from './src/sync.js';
/* Круг 23 (SPEC §10): агент на сервере. Команда уходит в Orchestrator, стадии приходят
   потоком SSE, транзакция агента — по сокету Hub, как любая чужая. Без сервера — brain здесь. */
import * as AGENT from './src/agent.js';
import {
  AGENT_MODE_WORDS, decideAgentMode, agentModeTitle, serverStageRec, retryLabel,
  shellIntentFromServer, agentErrorWords, isModelError, normalizeResult, variantsFromServer,
  tooLargeWords, stoppedWriteWords, historyForServer,
  // круг 25: режим агента по /agent/health, отказ сервера агента, dropped словами, строки по кодовым точкам
  agentHealthNotice, AGENT_DOWN_WORDS, detachedLostWords, droppedWords, presenceAgentWords, cutText, cleanText,
} from './src/shell.js';
import * as SHELL from './src/shell.js';
import { fontsInDoc, fontStylesheetUrl, catalogFont } from './src/fonts.js';

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
  agentPresence: null,  // круг 25: {busy}|{queued} — что агент делает для этого человека (присутствие)
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

/* Круг 22 (SPEC §8–9). Серверный режим: страница отдана сервером (nginx или Document
   service со STATIC_DIR), и `/api/health` отвечает {ok:true}. Тогда истина — журнал
   операций на сервере, документ — реплика (src/sync.js), а автосохранение в db/localStorage
   выключено. Пока `server` — null, всё работает прежним путём: артефакт на claude.ai
   к серверу подключиться не может (CSP) и остаётся демонстрацией без сервера. */
let server = null;   // {engine, project, sync, status, others, migrated, list}
let serverProbe = null;
/* Круг 39 (N6а): серверный режим ожидается (ссылка, отметка, серверная сборка), а `server`
   ещё не заведён — ждём /api/health. Холст пуст не потому, что строить нечего: приглашения
   «Скажите, что построить», имени «Пустая страница» и «Агент не подключён» здесь не место. */
let serverBooting = false;
const CLIENT_KEY = 'imago.client.v1';   // id вкладки-браузера: по нему свои транзакции узнаются в рассылке
/* Отметка «последний раз работали с сервером»: {projectId, name, at}. По ней (или по ?project=
   в ссылке) оболочка входит в серверный режим, даже когда /api/health молчит: документ и
   очередь правок лежат в журнале IndexedDB, показать их можно и без сервера (SPEC §9.5). */
const SERVER_MODE_KEY = 'imago.server.v1';

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
  'screenshot:size': 'Доска слишком велика для PNG',
  'screenshot:external': 'В PNG не попадают внешние картинки',
  'screenshot:image': 'Не удалось собрать картинку доски',
  'screenshot:timeout': 'Снимок доски не успел собраться',
  'screenshot:fonts': 'Шрифты в PNG не встроились',
  'screenshot:toBlob': 'Браузер не отдал картинку доски',
  'screenshot:blob': 'Картинка доски не сохранилась',
  toSVG: 'Не удалось собрать SVG доски',
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

/**
 * Круг 47 (SPEC §14.2): гарнитуры документа — на страницу. Холст рисует SVG прямо в странице, и
 * семейство, которого у страницы нет (Prata из решения арт-директора), выходило запасным
 * шрифтом, а ширины текста — мерились им же. Подключаем стили Google Fonts по семейству (только
 * из подобранного набора — чужое имя дало бы 400 всему запросу); когда файлы придут, ядро само
 * сбросит замеры (loadingdone) и холст переложится. Один и тот же документ дважды не обходим.
 */
const docFontsSeen = new Set();
let docFontsDoc = null;
/** семейство → промис «стили пришли» (load/error у <link>): до него FontFaceSet семейства не знает */
const docFontsReady = new Map();
function ensureDocFonts(doc) {
  if (!doc || doc === docFontsDoc || typeof document === 'undefined' || !document.head) return;
  // круг 50 (SPEC §17.3): шрифты из сети выключены — холст набирает шрифтами системы
  if (settings.webFonts === false) return;
  docFontsDoc = doc;
  try {
    for (const family of fontsInDoc(doc)) {
      const f = catalogFont(family);
      if (!f || docFontsSeen.has(f.family)) continue;
      docFontsSeen.add(f.family);
      const href = fontStylesheetUrl([f.family]);
      if (!href) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.font = f.family;
      // не пришло (нет сети) — забыть, чтобы следующий документ попробовал снова
      docFontsReady.set(f.family, new Promise((resolve) => {
        link.addEventListener('load', () => resolve(true), { once: true });
        link.addEventListener('error', () => { docFontsSeen.delete(f.family); docFontsDoc = null; docFontsReady.delete(f.family); link.remove(); resolve(false); }, { once: true });
      }));
      document.head.appendChild(link);
    }
  } catch { /* без шрифтов холст нарисует запасным */ }
}

/**
 * Круг 47 (SPEC §14.4): снимок черновика доски для критика агента в браузере — PNG той же
 * отрисовкой, что холст, с гарнитурами внутри. Не вышло — null, и критик смотрит выжимку.
 */
/**
 * Круг 53 (SPEC §20): цвета картинок документа для арт-директора. Картинка рисуется в квадрат
 * SWATCH_LIMITS.side на canvas; чужая картинка без CORS, битая, встроенная больше SWATCH_LIMITS.maxSrc
 * и не загрузившаяся за IMAGE_LOAD_MS — без цветов. Кеш — промисы по ключу адреса (длина и хэш, не
 * сами мегабайтные строки) на сеанс, не больше 64: параллельные варианты делят одну загрузку.
 */
const imageColorCache = new Map();
const IMAGE_LOAD_MS = 3000;
async function imageColorsInPage(sources, { signal } = {}) {
  const out = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (signal && signal.aborted) break;
    if (!s || typeof s.src !== 'string' || (s.src.startsWith('data:') && s.src.length > SWATCH_LIMITS.maxSrc)) continue;
    const key = srcKey(s.src);
    let colors = imageColorCache.get(key);
    if (!colors) {
      colors = pixelColors(s.src);
      imageColorCache.set(key, colors);
      while (imageColorCache.size > 64) imageColorCache.delete(imageColorCache.keys().next().value);
    }
    const got = await colors;
    if (got.length) out.push({ id: s.id, colors: got.map((c) => ({ ...c })) });
  }
  return out;
}

function pixelColors(src) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.onload = img.onerror = null; img.src = ''; resolve([]); }, IMAGE_LOAD_MS);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const side = SWATCH_LIMITS.side;
        const c = document.createElement('canvas');
        c.width = side; c.height = side;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, side, side);
        done(paletteFromPixels(g.getImageData(0, 0, side, side).data, side, side));
      } catch { done([]); }
    };
    img.onerror = () => done([]);
    img.src = src;
  });
}

async function renderForCritic({ doc, geo, artboardId }) {
  ensureDocFonts(doc);
  // раскладку черновика считали до прихода новых гарнитур: дождаться их и перемерить, иначе снимок
  // рисует настоящий шрифт в чужих переносах строк
  try {
    // круг 50: шрифты из сети выключены — ждать нечего, снимок системными
    if (settings.webFonts !== false && document.fonts && typeof document.fonts.load === 'function') {
      const fams = fontsInDoc(doc).map((f) => catalogFont(f)).filter(Boolean).map((f) => f.family);
      // пока стили не разобраны, check() для неизвестного семейства — true (по спецификации): сначала
      // ждём сами стили, потом начертания; уже готовые на странице — перемерять (весь документ) незачем
      const pending = fams.filter((f) => docFontsReady.has(f));
      const missing = fams.filter((f) => { try { return pending.includes(f) || !document.fonts.check(`16px "${f}"`, 'Аа0'); } catch { return true; } });
      if (missing.length) {
        await Promise.race([
          Promise.all(missing.map((f) => Promise.resolve(docFontsReady.get(f))
            .then(() => document.fonts.load(`16px "${f}"`, 'Аа0')).catch(() => null))),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
        for (const f of missing) if (document.fonts.check(`16px "${f}"`, 'Аа0')) docFontsReady.delete(f);
        await new Promise((r) => setTimeout(r, 0));
        geo = CORE.solve(doc);
      }
    }
  } catch { /* перемерить не вышло — снимок по прежней раскладке */ }
  return CORE.boardPNG(doc, artboardId, { geo, fonts: settings.webFonts !== false });
}

/**
 * Круг 29, п.9. Начертания, которые впервые появляются с инспектором (моноширинный для чисел,
 * полужирный заголовков), браузер грузит по первому требованию — и когда шрифт приходит,
 * весь документ раскладывается заново («Fonts changed»). На большом макете это лишние
 * треть секунды на первом выделении. Просим их сразу, пока холст пуст.
 */
function warmFonts() {
  try {
    if (!document.fonts || typeof document.fonts.load !== 'function') return;
    for (const f of ['400 12px "IBM Plex Sans"', '500 12px "IBM Plex Sans"', '600 12px "IBM Plex Sans"',
      '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"', 'italic 400 12px "Instrument Serif"', '400 12px "Instrument Serif"']) {
      document.fonts.load(f, 'Аа0').catch(() => { /* шрифта нет — останется запасной */ });
    }
  } catch { /* FontFaceSet нет — не страшно */ }
}

async function boot() {
  // есть ли сервер, выясняем параллельно с первой отрисовкой: ответ нужен только
  // к моменту восстановления документа (initCapabilities), а ждать его до первого кадра незачем
  serverProbe = serverAllowed() ? probeServer() : Promise.resolve(null);
  cacheDom();
  warmFonts();
  applyTheme(settings.theme);
  /* Порядок важен: applyRail решает, открыт рельс или нет, и только потом имеет смысл
     мерить его ширину. Наоборот — и шторка на узком экране открывалась сама
     (syncPanelModes успевал переключить режим до того, как рельс получил состояние,
     и ветка «сложить шторку» не срабатывала). */
  applyRail();
  applyRailWidth(settings.railW);   // ручная ширина рельса (круг 18, п.3)
  syncPanelModes();

  // серверный режим ожидается (ссылка или отметка) — демо-документу на холсте делать нечего:
  // документ придёт из журнала или от сервера, а до того холст пуст
  serverBooting = serverAnticipated();
  state.doc = serverBooting ? createDoc('empty') : createDoc();
  state.geo = solveKept(state.doc);

  /* Круг 39 (N3, N6в): Ctrl/⌘+A и Ctrl/⌘+D — команды таблицы оболочки («Выделить всё на доске»,
     «Дублировать»), откуда бы ни нажали: с холста, из списка слоёв, с кнопки. Ловим их на окне
     в фазе захвата раньше сцены (она вешает свой обработчик позже): у сцены своя «рамка во весь
     мир» и своё дублирование без слов — две истины одной команды. */
  globalThis.addEventListener('keydown', onModKeyCapture, true);
  // круг 55 (SPEC §21): картинка в макет — вставкой из буфера и перетаскиванием файла на холст
  globalThis.addEventListener('paste', onImagePaste);
  dom.canvas.addEventListener('dragover', onImageDragOver);
  dom.canvas.addEventListener('drop', onImageDrop);
  stage = new Stage(dom.canvas, {
    // круг 50: шрифты из сети выключены — и в экспорт начертания не встраиваются
    embedFonts: settings.webFonts !== false,
    onSelect: (ids) => setSelection(ids),
    // круг 39 (N3): ⌘/Ctrl+D сцены — та же команда таблицы со словами и «Отменить» (если перехват мимо)
    onDuplicate: () => applyShellIntent({ kind: 'duplicate' }, ''),
    // круг 37: сдвиг детали с Shift — по одной оси (stageOps)
    onCommit: ({ ops, label }) => commit(stageOps(ops), label || 'Правка', 'human'),
    onUndo: () => keyUndo(false),
    onRedo: () => keyUndo(true),
    onView: (view) => {
      // масштаб поменял человек, а не мы: дальше его выбор уважаем (п.12)
      if (!viewLock) state.userView = true;
      updateZoomLabel(view);
      scheduleViewChrome();
    },
    // жест снят из-за правки агента под рукой: раньше узел просто не ехал, и молча (п.28)
    onDragCancel: ({ reason, mode } = {}) => {
      const what = mode === 'resize' ? 'Изменение размера прервано' : 'Перетаскивание прервано';
      const why = /исчез|пропал|удал/i.test(String(reason || ''))
        ? 'слой пропал из документа'
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
    const ro = new ResizeObserver(() => { layoutMemo.clear(); scheduleViewRecheck(); });
    ro.observe(dom.canvas);
    // размер сцены для перерисовки по смене вида (scheduleViewChrome) — без замера (круг 27, п.8)
    const rs = new ResizeObserver((entries) => {
      const e = entries && entries[entries.length - 1];
      const box = e && e.borderBoxSize && e.borderBoxSize[0];
      viewChromeSize = box && box.inlineSize > 0 && box.blockSize > 0 ? { w: box.inlineSize, h: box.blockSize } : null;
      layoutMemo.clear();
    });
    rs.observe((stage && stage.el) || dom.canvas);
    // док растёт от сообщения и ленты стадий, а инспектор на узком экране его поднимает:
    // от этого зависит потолок шторки (п.5)
    const rg = new ResizeObserver(() => { layoutMemo.clear(); syncDockGap(); });
    for (const n of [dom.dock, dom.inspector, dom.variants]) if (n) rg.observe(n);
  }
  globalThis.addEventListener('resize', () => {
    layoutMemo.clear();
    // потолок ручной ширины рельса считается от окна: окно сузилось — рельс уступает (круг 18, п.3)
    if (settings.railW) applyRailWidth(settings.railW);
    syncPanelModes(); syncDockGap();
  });
  syncPanelModes();
  syncDockGap();

  hydrateIcons(document);
  bindUi();
  initRailGrip();
  initLiveSize();
  initDetailGestures();
  watchTabsRow();
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
  // круг 57: с памятью — после смены шрифтов следующая правка снова по месту
  const geo = solveKept(state.doc);
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
  // круг 20: линейка — шкала отступов и скруглений (кнопка «Шкалы» в шапке)
  scale: '<rect x="2" y="5.25" width="12" height="5.5" rx="1.25"/><path d="M5 5.25v2.25"/><path d="M8 5.25v3.25"/><path d="M11 5.25v2.25"/>',
  // круг 22: папка — проекты на сервере (кнопка рядом с именем документа)
  folder: '<path d="M2.25 4.25h4l1.5 1.75h6v7h-11.5z"/><path d="M2.25 7.5h11.5"/>',
  /* Круг 36 (SPEC §11.3): «Просмотр» — треугольник проигрывания; «состояния» у слоя —
     указатель с дугой движения (значок в «Слоях» и заголовок раздела инспектора). */
  play: '<path d="M5.25 3.25v9.5L12.75 8z"/>',
  motion: '<path d="M4.5 3.5 11 8.25l-2.9.6-1.35 2.7z"/><path d="M11.5 3.25a4.5 4.5 0 0 1 1.75 3.5"/>',
  /* Круг 37 (SPEC §12.3): вектор — кривая Безье с узлами; иллюстрация — картинка в рамке
     (значки в «Слоях» и на заголовке раздела «Контуры»). */
  vector: '<path d="M3 12.5C4.5 6 11.5 10 13 3.5"/><circle cx="3" cy="12.5" r="1.5"/><circle cx="13" cy="3.5" r="1.5"/>',
  illustration: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="6" cy="6.25" r="1.25"/><path d="M2.5 12 6.4 8.4 9 10.8l2-1.8 2.5 2.3"/>',
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
    'commandbar', 'command', 'btn-run', 'btn-variants', 'btn-mic', 'mic-live', 'worklog',
    'work-label', 'work-detail', 'work-steps', 'btn-work-stop', 'variants', 'hints', 'toasts',
    'artboard-tabs', 'docname', 'sheet', 'sheet-body', 'sheet-title', 'sheet-tabs',
    'btn-zoom', 'btn-zoom-in', 'btn-zoom-out', 'btn-fit', 'btn-preview', 'previewbar', 'btn-preview-exit', 'btn-rail', 'btn-rail-close', 'scrim',
    'btn-history', 'btn-export', 'btn-scales', 'btn-theme', 'btn-settings', 'rail-grip',
    'btn-insp-close', 'btn-sheet-close', 'btn-empty-artboard',
    'voicebar', 'voice-said', 'btn-voice-off',
    'dockmsg', 'dockmsg-text', 'dockmsg-note', 'dockmsg-issue', 'dockmsg-ask', 'dockmsg-chips', 'dockmsg-actions', 'btn-msg-close',
    'empty-state', 'empty-title', 'empty-sub', 'empty-examples', 'dock', 'viewbar',
    'peekbar', 'peekbar-text', 'agent-dot',
    // круг 22: серверный режим — проекты, состояние синхронизации, чужие выделения
    'btn-projects', 'sync-status', 'presence', 'net-pill',
    // круг 23: где работает агент — на сервере или в браузере
    'agent-status',
    // круг 25: соавторы в шапке — аватарки и «+N» вместо списка имён
    'people',
    // круг 38: палитра команд
    'palette', 'palette-list', 'btn-palette-help',
  ]) dom[id] = el(id);
  dom.dockmsg.setAttribute('role', 'status');
  dom.dockmsg.setAttribute('aria-live', 'polite');
  dom.worklog.setAttribute('role', 'status');
  dom.worklog.setAttribute('aria-live', 'polite');
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

  /* Круг 22. Сервер ответил на /api/health — документ живёт в реплике, а не в db/localStorage:
     дальше проект открывает initServer, и прежний путь восстановления не трогается вовсе.
     Агент (brain) при этом остаётся в браузере: его результат тоже уходит транзакцией. */
  const health = await serverProbe;
  // сервер молчит, но ссылка или отметка говорят, что проект серверный: открываем из журнала,
  // сокет переподключится сам — прежний режим тут был бы подменой документа демо-макетом
  if (health || serverAnticipated()) { await initServer(health); return; }

  // круг 46: без сервера проектов много — хранилище проектов (прежний документ станет первым)
  const restored = await initSoloProjects();
  maybeShowIntro(restored);
  // хранилище закрыто — важнее приветствия: плашка встаёт поверх него
  soloStorageNotice();
}

/* ------------------------------ серверный режим ------------------------------ */

/**
 * Есть ли за страницей Document service. Любой сбой — прежний режим: артефакт на claude.ai
 * до сервера не достучится (CSP), статический http.server ответит 404, а хост, который
 * на любой путь отдаёт свою страницу, не разберётся как JSON. Ждём не дольше трёх секунд:
 * восстановление документа не должно зависеть от медленной сети.
 */
async function probeServer() {
  if (typeof fetch !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 3000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) {
      /* Круг 30: сервер есть, а его хранилище лежит (J1: 503 unavailable, storage down) — это
         серверный режим со словами «сервер не может сохранить», а не локальный демо-макет. */
      if (res.status !== 503) return null;
      const err = await res.json().catch(() => null);
      // круг 31: 'schema' — база восстановлена из старой копии, экземпляр догоняет миграции
      return err && err.code === 'unavailable' && err.detail && (err.detail.storage === 'down' || err.detail.storage === 'schema')
        ? { ok: false, storage: 'down', engine: null, schema: err.detail.storage === 'schema' } : null;
    }
    const body = await res.json();
    return body && body.ok === true ? body : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** JSON к серверу. Имя автора в заголовке — процентно закодированное: кириллица в заголовок fetch не проходит. */
async function apiJson(path, init = {}) {
  const res = await fetch(path, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-author': encodeURIComponent(settings.author || ''), ...(init.headers || {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    // тело ошибки (SPEC §9.8): {error: true, code, message, retryable} — error уже не строка
    const said = body && (body.message || (typeof body.error === 'string' ? body.error : ''));
    // круг 25, п.7: «сервер ответил 503» человеку ничего не говорит — код уходит в поле status
    const e = new Error(said || (res.status === 404 ? 'не найдено на сервере'
      : res.status >= 500 ? 'сервер сейчас не отвечает как надо' : 'сервер отказал в запросе'));
    e.status = res.status;
    if (body && typeof body.code === 'string') e.code = body.code;
    if (body && typeof body.retryable === 'boolean') e.retryable = body.retryable;
    if (body && body.detail && typeof body.detail === 'object') e.detail = body.detail;
    /* Круг 31 (UX Д5): хранилище сервера лежит — и строка состояния говорит то же, что тост
       («Имя не сохранилось: хранилище недоступно» при «в сети · всё сохранено» — разнобой).
       Реплика держит «сервер не может сохранить», пока health или запись не скажут иное. */
    if (storageDownError(e) && server && server.sync && typeof server.sync.storageFailed === 'function') server.sync.storageFailed();
    // круг 39 (N1): 426 по HTTP (досылка пачками, импорт) — те же слова, что от сокета
    if (res.status === 426 && server) onSyncError({ code: 'engine', engine: e.detail && Number.isFinite(e.detail.engine) ? e.detail.engine : null });
    throw e;
  }
  return body;
}

/** id вкладки-браузера — один на браузер, переживает перезагрузку: свои транзакции узнаются в журнале. */
function clientIdOf() {
  let id = '';
  try { id = localStorage.getItem(CLIENT_KEY) || ''; } catch { id = ''; }
  if (!id) {
    id = CORE.uid('c');
    try { localStorage.setItem(CLIENT_KEY, id); } catch { /* приватный режим — id на одну сессию */ }
  }
  return id;
}

function projectIdFromUrl() {
  try { return new URL(location.href).searchParams.get('project') || ''; } catch { return ''; }
}

function setProjectUrl(id) {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('project') === id) return;
    u.searchParams.set('project', id);
    history.replaceState(null, '', u.toString());
  } catch { /* history недоступна — ссылку не меняем */ }
}

/** Отметка последнего серверного проекта — или null. */
function serverMark() {
  try {
    const raw = localStorage.getItem(SERVER_MODE_KEY);
    const m = raw ? JSON.parse(raw) : null;
    return m && typeof m === 'object' && typeof m.projectId === 'string' && m.projectId ? m : null;
  } catch { return null; }
}

function rememberServerMode(project) {
  try {
    localStorage.setItem(SERVER_MODE_KEY, JSON.stringify({ projectId: project.id, name: project.name || '', at: Date.now() }));
  } catch { /* памяти нет — в следующий раз решит ссылка или /api/health */ }
}

/** Ждать ли серверный режим ещё до ответа /api/health: ссылка с проектом или отметка. */
function serverAnticipated() {
  if (!serverAllowed()) return false;
  return !!(projectIdFromUrl() || serverMark() || serverBuild());
}

/**
 * Круг 31 (UX m3): серверная сборка (dist/web за NGINX) знает о себе, что за ней сервер:
 * IMAGO_DEFAULTS.server === true. Лежит Document service — это не повод молча стать
 * соло-редактором с демо-макетом: правки в нём никуда бы не сохранились.
 */
function serverBuild() {
  const d = typeof globalThis !== 'undefined' ? globalThis.IMAGO_DEFAULTS : null;
  return !!(d && typeof d === 'object' && d.server === true);
}

/**
 * Круг 23. Соло-сборка (dist/local, dev.html) знает о себе, что сервера за ней нет:
 * IMAGO_DEFAULTS.server === false. Тогда /api/health не спрашиваем вовсе — статический
 * сервер ответил бы 404, и это была бы ошибка в консоли на каждом открытии; и отметка
 * прошлого серверного проекта на том же адресе соло-режим не перехватывает.
 */
function serverAllowed() {
  const d = typeof globalThis !== 'undefined' ? globalThis.IMAGO_DEFAULTS : null;
  return !(d && typeof d === 'object' && d.server === false);
}

/** Последний по updated_at — тот, что откроется без ?project= в ссылке. */
function latestProject(list) {
  const items = (list || []).filter((p) => p && p.id);
  items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return items[0] || null;
}

async function createProject(name) {
  return apiJson('/api/projects', { method: 'POST', body: { name: name || 'Новый проект' } });
}

/* Круг 26: сервис отдаёт список проектов страницами (`?limit=&after=`, ответ `more` и
   `next`); шторка берёт первую, остальное — кнопкой «Показать ещё». Сервис прежней
   версии параметров не знает и отдаёт всё — `more` у него нет, кнопки тоже. */
const PROJECTS_PAGE = 50;

/** Страница списка проектов: {projects, next} (next — курсор следующей или null). */
async function fetchProjectsPage(after) {
  const q = `?limit=${PROJECTS_PAGE}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
  const got = await apiJson('/api/projects' + q);
  const projects = Array.isArray(got && got.projects) ? got.projects : [];
  return { projects, next: got && got.more === true && typeof got.next === 'string' ? got.next : null };
}

/** Сводка одного проекта (`?head=1` — без документа): null, если его нет (404). */
async function fetchProjectHead(id) {
  try {
    return await apiJson(`/api/projects/${encodeURIComponent(id)}?head=1`);
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
}

/**
 * Серверный режим: выбрать проект и открыть реплику. Проект — из ?project= в ссылке; без
 * него — последний по времени правки, а если проектов нет — новый «Новый проект» с
 * записью id в ссылку, чтобы перезагрузка вернула туда же.
 */
async function initServer(health) {
  /* Круг 25, п.1. Своя модель браузера в серверном режиме — только та, что человек включил
     сам (настройки → «Агент»). Прежняя серверная сборка включала LM Studio по умолчанию, и
     при упавшем Orchestrator команда уходила на localhost:1234 — «Failed to fetch» у
     человека, у которого никакой LM Studio нет. Отметка `chosen` ставится только руками. */
  if (state.providerKind === 'lmstudio' && !(settings.lmstudio && settings.lmstudio.chosen === true)) {
    state.provider = null;
    state.providerKind = null;
    setRunnable(false);
  }
  serverBooting = false;
  server = {
    engine: health ? health.engine : null, project: null, sync: null, others: [], migrated: false, list: [], listNext: null,
    status: {
      online: false, pending: 0, syncing: true, error: null, connecting: true,
      // круг 30: /api/health сказал «хранилище лежит» — так и говорим с первой отрисовки
      ...(health && health.storage === 'down' ? { storage: 'down', label: 'сервер не может сохранить' } : {}),
    },
    authorAsked: false, metaFresh: false, waiting: false,
  };
  if (dom['btn-projects']) dom['btn-projects'].hidden = false;
  if (dom['sync-status']) dom['sync-status'].hidden = false;
  renderSyncStatus();
  const wanted = projectIdFromUrl();
  const mark = serverMark();
  /* Сервер молчит, а проект известен — из ссылки или отметки: открываем его из журнала
     IndexedDB, не спрашивая список. Имя берём из отметки, свежее придёт с hello/списком. */
  const knownId = wanted || (mark && mark.projectId) || '';
  const knownName = mark && mark.projectId === knownId ? mark.name : '';
  // круг 31: режим агента — сразу, не дожидаясь проекта: «Агент не подключён — откройте
  // настройки» в серверной сборке неправда, агент здесь — сервер
  probeAgent({ force: true });
  if (!health && knownId) {
    openProject({ id: knownId, name: knownName });
    return;
  }
  let project = null;
  try {
    project = await chooseProject(wanted, knownName);
  } catch (e) {
    // health ответил, а список — нет (сервер упал между ними): известный проект открываем из журнала
    if (knownId) { openProject({ id: knownId, name: knownName }); return; }
    /* Круг 31 (UX m2/m3): открыть нечего — ни проекта из ссылки, ни отметки. Демо-макет здесь
       был бы подменой (правки в нём никуда не сохранялись), «перезагрузите» — работой
       человека. Пустой холст, карточка с причиной и повтор с нарастающей паузой: сервер
       вернулся — проект открывается сам. */
    startListWait(e);
    return;
  }
  if (project) openProject(project);
}

/**
 * Какой проект открыть: из ссылки (если есть на сервере или в журнале вкладки), иначе
 * последний по времени правки, а проектов нет — новый. Бросает, если список не пришёл.
 * @returns {Promise<object|null>}
 */
async function chooseProject(wanted, knownName) {
  const page = await fetchProjectsPage();
  server.list = page.projects;
  server.listNext = page.next;
  let project = null;
  if (wanted) {
    // проект из ссылки может быть и дальше первой страницы — спрашиваем его самого
    project = server.list.find((p) => p && p.id === wanted) || (await fetchProjectHead(wanted));
    if (!project) {
      /* Круг 29 (арх. Д1, UX Д3): проекта нет, а его работа лежит в журнале этой вкладки
         (базу восстановили из копии, где его ещё не было). «Открыл последний» уводил от
         неё молча — открываем локальную копию: реплика скажет not_found, и оболочка
         покажет карточку «Сохранить как новый проект». */
      const local = await localCopyOf(wanted);
      if (local) return { id: wanted, name: local.name || knownName };
      const was = knownName || '';
      toast(was ? `Проекта «${clip(was, 40)}» на сервере нет — открыл последний.` : 'Проекта из ссылки на сервере нет — открыл последний.', 'plain', 8000);
    }
  }
  if (!project) project = latestProject(server.list);
  if (!project) project = await createProject('Новый проект');
  server.metaFresh = true;
  return project;
}

/** 503 «хранилище недоступно» (J1/J4): база данных сервера лежит, сам сервер отвечает. */
function storageDownError(e) {
  const d = e && e.detail;
  return !!(e && e.status === 503 && (e.code === 'unavailable' || !e.code) && d
    && (d.storage === 'down' || d.storage === 'schema' || d.cause === 'storage' || d.cause === 'timeout' || d.cause === 'schema'));
}

/** 503 «схема базы догоняется» (DOC круг 31): базу восстановили из старой копии — обычно секунды. */
function schemaCatchUp(e) {
  const d = e && e.detail;
  return !!(d && (d.storage === 'schema' || d.cause === 'schema'));
}

/* Паузы повтора списка: нарастают, но не дольше 4 с — вернувшийся сервер открывает проект
   за ≤ 10 с, а не через минуту экспоненты. */
const LIST_WAIT_MS = [1000, 2000, 3000, 4000];

/** Список проектов не пришёл, открыть нечего: пустой холст, карточка, повтор. */
function startListWait(e) {
  if (!server) return;
  const storage = storageDownError(e);
  const w = server.listWait || { tries: 0, timer: null, storage, busy: false };
  w.storage = storage;
  w.schema = schemaCatchUp(e);
  server.listWait = w;
  server.status = storage
    ? { ...server.status, syncing: false, error: null, storage: 'down', label: 'сервер не может сохранить' }
    : { ...server.status, syncing: false, error: 'unreachable', storage: 'up', label: '' };
  // демо-макету здесь не место: правки в нём никуда бы не сохранились
  if (SHELL.userNodeCount(state.doc) > 0 || artboards(state.doc).length) {
    state.doc = createDoc('empty');
    state.geo = solveKept(state.doc);
    state.selection = [];
    state.history = [];
    state.cursor = 0;
  }
  // «Скажите, что построить» здесь звало бы в никуда — проекта нет (renderEmptyState прячет)
  if (w.tries === 0) { renderAll(); setDocNameText(docTitle()); }
  renderSyncStatus();
  showListWaitMsg();
  if (w.timer) clearTimeout(w.timer);
  const delay = LIST_WAIT_MS[Math.min(w.tries, LIST_WAIT_MS.length - 1)];
  w.tries += 1;
  w.timer = setTimeout(() => { w.timer = null; retryProjectList(); }, delay);
}

function showListWaitMsg() {
  const w = server && server.listWait;
  if (!w) return;
  // карточку о правке/команде, которой некуда лечь, не затираем — она про то же и с тем же «Попробовать снова»
  const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
  if (role === 'list-wait-edit' || role === 'list-wait-cmd') return;
  showMsg('error', w.schema ? 'Сервер обновляет базу данных' : w.storage ? 'База данных сервера недоступна' : 'Сервер недоступен', {
    note: w.schema
      ? 'Обычно это секунды. Пробую снова — проект откроется сам.'
      : w.storage
        ? 'Проекты не прочитать, пока она не вернётся. Пробую снова — проект откроется сам.'
        : 'Список проектов не пришёл. Пробую снова — проект откроется сам.',
    role: 'list-wait',
    actions: [{ label: 'Попробовать снова', primary: true, onClick: () => retryProjectList({ now: true }) }],
  });
}

/** Повтор списка проектов (по таймеру или кнопке): пришёл — проект открывается сам. */
async function retryProjectList({ now = false } = {}) {
  const w = server && server.listWait;
  if (!w || w.busy) return;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  if (now) w.tries = 0;
  w.busy = true;
  let project = null;
  try {
    project = await chooseProject('', '');
  } catch (e) {
    w.busy = false;
    if (server.listWait === w) startListWait(e);
    return;
  }
  w.busy = false;
  if (server.listWait !== w) return;
  server.listWait = null;
  const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
  if (role === 'list-wait' || role === 'list-wait-edit' || role === 'list-wait-cmd') hideMsg();
  if (state.sheetOpen === 'projects') redrawProjects();
  if (!project) return;
  openProject(project);
  const name = clip(project.name || 'Без названия', 50);
  if (role === 'list-wait-cmd' && dom.command && dom.command.value.trim()) {
    // команда, которой помешал сбой, осталась в строке — её можно выполнить уже в проекте
    showMsg('plain', `Сервер снова отвечает — открыл проект «${name}»`, {
      note: 'Команда осталась в строке — её можно выполнить.',
      actions: [{ label: 'Выполнить', primary: true, onClick: () => { hideMsg(); submitOnce(); } }],
      ms: 12000,
    });
  } else toast(`Сервер снова отвечает — открыл проект «${name}».`, 'plain', 6000);
}

/**
 * Круг 29: есть ли в журнале IndexedDB работа проекта — документ с пользовательскими узлами
 * или очередь неотправленных правок. Ключи журнала — как у реплики (`<id>` и `<id>#doc`).
 * @returns {Promise<{name: string, nodes: number, pending: number}|null>}
 */
async function localCopyOf(id) {
  if (!id) return null;
  let storage = null;
  try { storage = idbStorage(); } catch { return null; }
  try {
    const rec = await storage.get(id);
    if (!rec || typeof rec !== 'object') return null;
    const docRec = rec.doc && rec.doc.nodes ? rec : await storage.get(id + '#doc');
    const doc = docRec && docRec.doc && docRec.doc.nodes ? docRec.doc : null;
    const nodes = doc ? SHELL.userNodeCount(doc) : 0;
    const pending = Array.isArray(rec.pending) ? rec.pending.length : 0;
    if (!doc || (!nodes && !pending)) return null;
    const ex = rec.extra && typeof rec.extra === 'object' ? rec.extra : {};
    const name = ex.project && typeof ex.project.name === 'string' ? cutText(cleanText(ex.project.name), 120) : '';
    return { name, nodes, pending };
  } catch { return null; }
}

/**
 * Имя и прочее о проекте, открытом без сервера, — как только сервер ответил. Список
 * легче снимка, а больше ничего и не нужно.
 */
async function refreshProjectMeta() {
  if (!server || !server.project || server.metaFresh) return;
  server.metaFresh = true;
  const id = server.project.id;
  try {
    // круг 26: сводка самого проекта (`?head=1`), а не весь список — он теперь страницами
    const p = await fetchProjectHead(id);
    if (p && server.project && server.project.id === id) {
      server.project.name = p.name || server.project.name;
      server.project.kind = p.kind || server.project.kind;
      rememberServerMode(server.project);
      setDocNameText(docTitle());
    }
  } catch { server.metaFresh = false; /* попробуем при следующем выходе в сеть */ }
}

/**
 * Открыть проект в реплике. Прежняя реплика закрывается (журнал дописывается), состояние
 * оболочки — история, разговор, выделение — начинается заново: всё это принадлежит проекту.
 */
function openProject(project) {
  if (!server || !project || !project.id) return;
  if (server.sync) { server.sync.close(); server.sync = null; }
  server.project = { id: project.id, name: project.name || '', kind: project.kind || 'design', updated_at: project.updated_at || '' };
  server.migrated = false;
  server.goneShown = false;
  server.others = [];
  server.waiting = false;
  server.status = { online: false, pending: 0, syncing: true, error: null, connecting: true };
  setProjectUrl(project.id);
  rememberServerMode(server.project);
  state.selection = [];
  state.collapsed = null;
  state.history = [];
  state.cursor = 0;
  state.chat = [];
  state.pairs = [];
  state.saveBlocked = null;
  sessionJournal.length = 0;
  journalHuman.clear();
  clientNames.clear();
  removedInfo.clear();
  hideVariants();
  hideMsg();
  // до открытия холст пуст: документ придёт из журнала или от сервера, демо здесь не место
  state.doc = createDoc('empty');
  state.geo = solveKept(state.doc);
  renderAll();
  setDocNameText(docTitle());
  renderSyncStatus();
  renderPresence();
  let storage = null;
  try { storage = idbStorage(); } catch { storage = null; }
  if (!storage) storage = memoryStorage();
  const sync = createSync({
    core: CORE,
    baseUrl: '',
    projectId: project.id,
    clientId: clientIdOf(),
    author: settings.author || '',
    storage,
    onChange: onSyncChange,
    onStatus: onSyncStatus,
    onDropped: onSyncDropped,
    onPresence: onSyncPresence,
    // круг 27, I4: имя проекта живое — переименование у одного видят все участники
    onProject: onSyncProject,
    onGone: () => toast('Сервер прислал свежий снимок — свои правки переиграны поверх него.', 'plain', 6000),
    // круг 25, п.4: журнал реплики изменился — открытая «История» перерисуется
    onJournal: () => { if (state.sheetOpen === 'history' && state.sheetTab !== 'chat') refreshSheet(); },
    onError: onSyncError,
    extra: journalExtra,
  });
  server.sync = sync;
  serverAgent.awaiting.clear();
  serverAgent.arrived.clear();
  serverAgent.stopped.clear();
  serverAgent.current = null;
  endDetached();
  serverAgent.lost.clear();
  serverAgent.lastFailed = null;
  probeAgent({ force: true });
  sync.open().catch((e) => {
    showMsg('error', 'Проект не открылся', { note: humanError(e) });
  });
}

/** Что оболочка кладёт в локальный журнал рядом с документом: история, разговор, свёрнутые ветки. */
function journalExtra() {
  const past = packHistory();
  return {
    chat: state.chat.slice(-60),
    pairs: state.pairs.slice(-5),
    history: past.list,
    cursor: past.cursor,
    collapsed: state.collapsed ? [...state.collapsed].slice(0, 400) : null,
    // круг 29: имя проекта — пропавший с сервера проект узнаётся по имени, а не по UUID
    project: server && server.project ? { name: server.project.name || '' } : null,
    // круг 29, п.7: чьи вкладки (client → имя) — подпись «Агент · Аня», когда Ани уже нет
    clients: clientNamesList(),
  };
}

function adoptJournalExtra(extra) {
  const e = extra && typeof extra === 'object' ? extra : {};
  if (server && server.project && !server.project.name && e.project && typeof e.project.name === 'string' && e.project.name) {
    server.project.name = cutText(cleanText(e.project.name), 120);
    setDocNameText(docTitle());
  }
  adoptClientNames(e.clients);
  state.chat = sanitizeChat(e.chat);
  state.pairs = sanitizePairs(e.pairs);
  const past = sanitizeHistory(e.history, e.cursor);
  state.history = past.list;
  state.cursor = past.cursor;
  // что из истории ещё не подтверждено сервером — знает реплика (её очередь пережила перезагрузку)
  const waiting = new Set(server && server.sync ? server.sync.pending.map((t) => t.tx_id) : []);
  for (const t of state.history) t.pending = waiting.has(t.id);
  state.collapsed = Array.isArray(e.collapsed) && e.collapsed.length
    ? new Set(e.collapsed.filter((id) => typeof id === 'string'))
    : null;
}

/** Выделение переживает чужое удаление: узлов уже нет, а рамки и инспектор ссылались бы на них. */
function pruneSelection() {
  const keep = state.selection.filter((id) => state.doc && state.doc.nodes[id]);
  if (keep.length !== state.selection.length) state.selection = keep;
}

/**
 * Реплика изменилась не по своей правке: открытие, подтверждение своей транзакции, чужая
 * транзакция, снимок после `gone`. Чужие правки рисуются как правки агента — с рамками
 * по diffOf и плавным переездом соседей, — но без сообщений в доке: о чужой работе
 * говорит присутствие, а не карточка итога.
 */
function onSyncChange(view, info = {}) {
  if (!server || !view) return;
  const prevGeo = state.geo;
  switch (info.reason) {
    case 'open': {
      state.doc = view;
      state.geo = solveKept(view);
      adoptJournalExtra(info.extra);
      if (server.waiting) {
        server.waiting = false;
        /* Круг 31 (m14): прячем только «Проект недоступен». Карточку команды, которой помешал
           сбой («Сервер агента не видит документ» с «Повторить»), не трогаем — она сменится на
           «Документ снова доступен агенту», когда реплика и health это увидят. */
        const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
        if (role === 'server-wait') hideMsg();
      }
      renderAll();
      state.userView = false;
      fitSmart();
      refreshSheet();
      /* Миграция формата — только когда реплика догнала сервер (onSyncStatus): снимок при
         открытии приходит с первой страницей хвоста, остальное — по сокету. Большой документ,
         чья библиотека лежит дальше первой страницы (например, сохранённый пачками), иначе
         получал вторую библиотеку (круг 29). */
      askAuthorIfNeeded();
      notePreReloadCommands();
      return;
    }
    case 'confirmed': {
      settleHistory(info);
      const predicted = state.doc;
      state.doc = view;
      settleWrapWords(info);
      // сервер применил ровно то, что мы предсказали, — геометрия та же, рисовать нечего;
      // круг 57: память раскладки переходит к документу сервера — следующая правка снова по месту
      if (info.same) { state.geo = CORE.solveCarry ? CORE.solveCarry(prevGeo, predicted, view) : prevGeo; refreshSheet(); return; }
      state.geo = solveFrom(prevGeo, view);
      pruneSelection();
      renderAll();
      refreshSheet();
      return;
    }
    case 'remote': {
      const prevDoc = state.doc;
      // круг 31: имена — как на сервере до этой транзакции, а не как в своём неотправленном черновике
      const named = info.before && info.before.nodes ? info.before : prevDoc;
      /* Круг 33, п.3: догоняющая загрузка при открытии (seq не новее головы на момент
         открытия) — это история проекта, а не новости: тостов «Аня отменила правку» и
         «вместо вашей…» новичку не показываем; что было — в «Истории». */
      const backlog = info.backlog === true;
      if (!backlog) noteRemoved(info.tx, named);
      noteJournal(info.tx, named);
      const overwritten = !!(!backlog && info.tx && !info.mine && (info.tx.undo_of || info.tx.redo_of) && noteOverwritten(info.tx, named));
      state.doc = view;
      /* Круг 41 (UX): догон после разрыва — за этой транзакцией идут ещё (до головы hello):
         промежуточных кадров не рисуем, один кадр на последней (или через CATCHUP_MS). */
      if (info.more === true && !(info.tx && info.tx.author_kind === 'agent')) {
        pruneSelection();
        holdCatchup();
        // слова о чужих отменах — как без отложенного кадра (свод серии — у noteRemoteRewind)
        if (!backlog && info.tx && !info.mine && (info.tx.undo_of || info.tx.redo_of) && !overwritten) noteRemoteRewind(info.tx);
        return;
      }
      const caught = flushCatchupTimer();
      // чужое переименование геометрию не трогает — решатель не зовём (круг 27, п.8)
      state.geo = !caught && info.tx && Array.isArray(info.tx.ops) ? geoAfter(info.tx.ops, prevDoc, view, prevGeo) : solveFrom(prevGeo, view);
      pruneSelection();
      const diff = !caught && info.tx && Array.isArray(info.tx.ops) ? diffOf(info.tx.ops, prevGeo) : null;
      renderAll(diff ? { diff, prevGeo } : {});
      refreshSheet();
      // круг 23: транзакция агента с сервера — уже применена репликой; здесь только итог
      if (info.tx && info.tx.author_kind === 'agent') onAgentTx(info.tx, prevDoc, diff, !!info.mine);
      if (!backlog && info.tx && !info.mine && (info.tx.undo_of || info.tx.redo_of) && !overwritten) noteRemoteRewind(info.tx);
      return;
    }
    default: {
      state.doc = view;
      state.geo = solveKept(view);
      pruneSelection();
      renderAll();
      refreshSheet();
    }
  }
}

/* Круг 41: отложенный кадр догона — если последняя транзакция до головы не пришла за CATCHUP_MS
   (связь снова оборвалась), рисуем то, что есть. */
const CATCHUP_MS = 400;
let catchupTimer = null;
function holdCatchup() {
  if (catchupTimer) return;
  catchupTimer = setTimeout(() => {
    catchupTimer = null;
    if (!server || !state.doc) return;
    state.geo = solveFrom(state.geo, state.doc);
    pruneSelection();
    renderAll();
    refreshSheet();
  }, CATCHUP_MS);
}
/** Был ли отложенный кадр догона (тогда геометрию — решателем целиком, без рамок одной правки). */
function flushCatchupTimer() {
  if (!catchupTimer) return false;
  clearTimeout(catchupTimer);
  catchupTimer = null;
  return true;
}

/** Реплика видит сервер живым и сохраняющим (J4): в сети, без ошибки, хранилище не лежит. */
function syncHealthy() {
  const s = (server && server.status) || {};
  return !!s.online && !s.error && s.storage !== 'down';
}

/**
 * Круг 29 (J4, п.7): карточка про документ агента согласована со строкой состояния.
 * «Снова доступен» при упавшей связи или хранилище уступает место «не видит документ»;
 * «не видит документ» сменяется на «снова доступен», когда и реплика, и health это видят.
 */
function syncDocCard() {
  const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
  if (role === 'doc-back' && !syncHealthy()) {
    const again = serverAgent.docBack || null;
    serverAgent.lastFailed = again;
    const w = agentErrorWords(docDownWhy({ code: 'document_down' }));
    showMsg('error', w.title, {
      note: w.note,
      role: 'doc-down',
      actions: again ? [{ label: 'Повторить', primary: true, onClick: () => retryFailed(again) }] : [],
    });
    watchAgentHealth();
    return;
  }
  if (role === 'doc-down' && syncHealthy()) {
    const h = serverAgent.health;
    if (h && h.ok === true && h.document === 'up' && h.llm === 'up') onAgentHealthChanged({ ok: false }, h);
  }
}

/* Круг 29, п.7: соавтор перемотал историю («Вернуться сюда» — N отмен подряд). Каждая
   отмена — своя транзакция, и молча документ у остальных просто менялся на глазах. Отмены
   одного человека, пришедшие подряд, сводим в одну строку: «Аня откатила 3 правки». */
const rewinds = new Map();   // author → {undo, redo, timer, who}
function noteRemoteRewind(tx) {
  const key = `${tx.author_kind || 'human'}:${tx.author || ''}`;
  const r = rewinds.get(key) || { undo: 0, redo: 0, timer: null, who: { author: tx.author, author_kind: tx.author_kind }, title: '', seen: new Set() };
  // круг 31 (K1): части одной большой отмены несут общий undo_of — это одна отмена
  const of = tx.undo_of || tx.redo_of;
  if (r.seen.has(of)) return;
  r.seen.add(of);
  if (tx.undo_of) r.undo += 1; else r.redo += 1;
  r.title = cleanText(tx.title);
  if (r.timer) clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    rewinds.delete(key);
    const parts = [];
    const n = (k) => `${k} ${plural(k, 'правку', 'правки', 'правок')}`;
    if (r.undo) parts.push(r.undo === 1 ? `${SHELL.whoDid(r.who, 'отменил')} правку` : `${SHELL.whoDid(r.who, 'откатил')} ${n(r.undo)}`);
    if (r.redo) {
      const verb = SHELL.whoDid(r.who, 'вернул');
      // второй глагол — без имени: «Аня откатила 3 правки и вернула 1 правку»
      parts.push(`${parts.length ? verb.split(' ').pop() : verb} ${r.redo === 1 ? 'правку' : n(r.redo)}`);
    }
    if (!parts.length) return;
    const head = parts.join(' и ');
    const t1 = r.title ? ((SHELL.partBase(r.title) || {}).base || r.title) : '';
    // круг 33, п.7: глагол подписи — в роде автора («— загрузила «Б»»), подпись строчной после тире
    const what1 = t1 ? SHELL.agreeVerb(r.who, SHELL.txTitleWords(t1).replace(/^(?:Отменил|Вернул):\s*/, '')) : '';
    const one = r.undo + r.redo === 1 && what1 ? ` — ${clip(what1.charAt(0).toLowerCase() + what1.slice(1), 60)}` : '';
    toast(`${head.charAt(0).toUpperCase()}${head.slice(1)}${one}. Что изменилось — в «Истории».`, 'plain', 8000);
  }, 900);
  rewinds.set(key, r);
}

function onSyncStatus(s) {
  if (!server) return;
  const wasHealthy = syncHealthy();
  const prev = server.status || {};
  server.status = s;
  renderSyncStatus();
  // круг 39 (N6а): первое подключение кончилось — приглашение пустого холста (если оно к месту)
  if (!!prev.connecting !== !!s.connecting) { renderEmptyState(); setDocNameText(docTitle()); }
  /* Круг 41 (арх. Н1): сервер обновился — реплика сама отпустила очередь; карточка о версии
     больше не правда. */
  if (s.error === 'engine' && prev.error !== 'engine' && !(server.sync && server.sync.view)) renderLayers();
  if (prev.error === 'engine' && s.error !== 'engine') {
    if (dom.dockmsg && !dom.dockmsg.hidden && dom.dockmsg.dataset.role === 'engine') hideMsg();
    serverAgent.quietBackUntil = Date.now() + 15000;   // «сервер документа снова на связи» — то же событие
    toast(s.pending ? 'Сервер обновился — ждавшие правки отправляю.' : 'Сервер обновился — работаем дальше.', 'plain', 6000);
    if (!(server.sync && server.sync.view)) renderLayers();
  }
  /* Круг 39 (UX): связь с сервером пропала — Orchestrator за тем же NGINX, скорее всего, тоже
     недоступен: спросить его сразу, а не ждать плановой проверки (до 30 с «агент: сервер»). */
  if (prev.online && !s.online && !s.connecting) probeAgent({ force: true });
  /* Круг 33, п.4: реплика снова сохраняет — сразу спросить и Orchestrator. Иначе карточка
     «Сервер агента не видит документ» и знак агента ждали плановой проверки (до 30 с), хотя
     строка состояния уже говорила «всё сохранено». */
  const h = serverAgent.health;
  if (!wasHealthy && syncHealthy() && h && h.ok === true && h.document !== 'up') probeAgent({ force: true });
  // круг 43: документ слёг (по реплике) — спросить агента сразу и чаще, пока не встанет
  if (wasHealthy && !syncHealthy() && docTrouble()) probeAgent({ force: true });
  armDocProbe();
  syncDocCard();
  // круг 45: отложенное «…снова на связи» — теперь и строка состояния это видит
  if (serverAgent.backLater && syncHealthy()) {
    const later = serverAgent.backLater;
    serverAgent.backLater = null;
    const hb = serverAgent.health;
    if (hb && hb.ok === true && hb.document === 'up') sayHealth(later);
  }
  const opened = !!(server.sync && server.sync.view);
  /* Ни сервера, ни локальной копии: показать нечего, и говорим об этом честно. Реплика
     сама пробует снова по нарастающей паузе; кнопка будит её раньше срока. */
  if ((s.error === 'unreachable' || s.storage === 'down') && !opened && !server.waiting) {
    server.waiting = true;
    showMsg('error', 'Проект недоступен', {
      // круг 30: сервер отвечает, но его хранилище лежит — связь тут ни при чём
      note: s.storage === 'down'
        ? 'База данных сервера недоступна, а копии проекта в этом браузере нет. Пробую снова — проект откроется сам.'
        : 'Нет связи с сервером и нет копии проекта в этом браузере. Пробую снова — проект откроется сам.',
      role: 'server-wait',
      actions: [
        { label: 'Повторить сейчас', primary: true, onClick: () => { if (server && server.sync) server.sync.reconnect(); } },
        { label: 'Проекты', onClick: () => openProjects() },
      ],
    });
  }
  if (s.error === 'not_found' && opened) projectGoneMsg();
  if (s.online) refreshProjectMeta();
  // круг 23: сеть вернулась — спросить и Orchestrator; режим агента зависит от связи
  // круг 39: связь только что вернулась — спросить сразу, а не через паузу между проверками
  if (s.online && (!serverAgent.health || !serverAgent.health.ok)) probeAgent({ force: !prev.online });
  else agentModeChanged();
  // локальная копия могла отстать: миграцию шлём, когда реплика догнала сервер
  if (s.online && !s.syncing && !s.error) maybeMigrate();
}

/**
 * Круг 27, I4. Сводка проекта от сервера (`project` по сокету, `hello.project`): имя,
 * переименованное другим участником, — в шапке, заголовке вкладки и в шторке «Проекты».
 */
function onSyncProject(summary) {
  if (!server || !server.project || !summary || typeof summary !== 'object') return;
  if (summary.id && summary.id !== server.project.id) return;
  const name = typeof summary.name === 'string' ? cutText(cleanText(summary.name), 120) : '';
  if (name) server.project.name = name;
  if (typeof summary.kind === 'string' && summary.kind) server.project.kind = summary.kind;
  if (typeof summary.updated_at === 'string' && summary.updated_at) server.project.updated_at = summary.updated_at;
  rememberServerMode(server.project);
  setDocNameText(docTitle());
  const item = Array.isArray(server.list) ? server.list.find((p) => p && p.id === server.project.id) : null;
  if (item && name && item.name !== name) {
    item.name = name;
    if (state.sheetOpen === 'projects') redrawProjects();
  }
}

/**
 * Круг 27, I3. Проекта больше нет на сервере (базу восстановили из резервной копии, проект
 * удалили), а вид документа у вкладки есть: работа не пропала — её можно сохранить новым
 * проектом. Очередь реплики не снимается: правки целы в этой вкладке.
 */
function projectGoneMsg({ force = false } = {}) {
  if (!server || !server.project) return;
  if (server.goneShown && !force) return;
  if (server.rescue && server.rescue.running) return;   // идёт сохранение — его карточка главнее
  server.goneShown = true;
  const w = SHELL.PROJECT_GONE_WORDS;
  const left = server.rescue && server.rescue.failed ? server.rescue : null;
  // круг 31: попытка до перезагрузки — из sessionStorage
  let before = null;
  if (!left) {
    try { before = JSON.parse(sessionStorage.getItem(RESCUE_KEY) || 'null'); } catch { before = null; }
    // круг 33 (L1): запрос создания ушёл, ответа не дождались — у задания есть create_id, проекта ещё нет
    if (!before || before.from !== server.project.id || (!before.project && !before.create_id)) before = null;
  }
  // круг 33, п.5: документ уходил одним запросом (total 0) — «части 1 из 0» не говорим
  const leftTotal = left ? Number(left.total) || 0 : 0;
  const beforeTotal = before ? Number(before.total) || 0 : 0;
  showMsg('error', w.title, {
    note: left ? (leftTotal
      ? `${w.note} Прошлая попытка сохранить остановилась на части ${left.done + 1} из ${leftTotal} — «Сохранить» продолжит с неё.`
      : `${w.note} Прошлая попытка сохранить не завершилась — «Сохранить» повторит её в тот же новый проект.`)
      : before ? (beforeTotal
        ? `${w.note} Сохранение, начатое до перезагрузки, успело отправить ${Math.min(Number(before.done) || 0, beforeTotal)} из ${beforeTotal} частей — «Сохранить» продолжит его в тот же новый проект.`
        : `${w.note} Сохранение, начатое до перезагрузки, не завершилось — «Сохранить» повторит его.`) : w.note,
    role: 'project-gone',
    actions: [
      { label: w.action, primary: true, onClick: () => saveAsNewProject() },
      { label: 'Проекты', onClick: () => openProjects() },
    ],
  });
}

/** Команда агенту, пока проекта нет на сервере: не отправлена — почему и что делать. */
function projectGoneCommandMsg(utterance) {
  restoreCommand(utterance);
  const w = SHELL.PROJECT_GONE_WORDS;
  showMsg('error', 'Проекта больше нет на сервере — команда не отправлена', {
    note: 'Агент работает с проектом на сервере, а его там нет. Сохраните работу новым проектом — команда останется в строке, и её можно будет выполнить уже там.',
    role: 'project-gone',
    actions: [
      { label: w.action, primary: true, onClick: () => saveAsNewProject() },
      { label: 'Проекты', onClick: () => openProjects() },
    ],
  });
  server.goneShown = true;
}

/** Команда, пока ни один проект не открыт (список проектов не пришёл, круг 31). */
function noProjectCommandMsg(utterance) {
  restoreCommand(utterance);
  const w = server && server.listWait;
  showMsg('error', w && w.storage ? 'База данных сервера недоступна — команда не выполнена' : 'Сервер недоступен — команда не выполнена', {
    note: 'Проект ещё не открыт. Он откроется сам, когда сервер снова ответит, — текст команды остался в строке.',
    role: 'list-wait-cmd',
    actions: [{ label: 'Попробовать снова', primary: true, onClick: () => retryProjectList({ now: true }) }],
  });
}

/** Круг 41: реплика стоит из-за версии движка (сервер старее или страница старее). */
function engineHalted() {
  return !!(server && server.status && server.status.error === 'engine');
}

/** Команда агенту, пока версии разошлись: не отправлена — словами про версию, не «повторите». */
function engineCommandMsg(utterance) {
  restoreCommand(utterance);
  const s = server.status || {};
  const w = engineWords(s.engine, s.ownEngine || CORE.ENGINE_VERSION);
  showMsg(w.newer ? 'error' : 'warn', w.newer ? 'Вышла новая версия редактора — команда не отправлена' : 'Сервер ещё не обновился — команда не отправлена', {
    note: w.newer
      ? 'Обновите страницу: сервер принимает правки только от новой версии. Текст команды остался в строке.'
      : 'Агент работает с проектом на сервере, а сервер ещё на прежней версии редактора. Текст команды остался в строке — выполните её, когда сервер обновится; правки руками ждут во вкладке.',
    role: 'engine',
    actions: w.newer ? [{ label: 'Обновить страницу', primary: true, onClick: () => location.reload() }] : [],
  });
}

/** Пропал ли открытый проект с сервера, а работа его — во вкладке (круг 29). */
function projectGone() {
  return !!(server && server.status && server.status.error === 'not_found' && server.sync && server.sync.view);
}

/**
 * «Сохранить как новый проект» (I3; круг 29, арх. Д2). Небольшой документ — одним
 * `POST /api/projects {name, doc}`. Больше пачки (3,5 МБ) — тело упёрлось бы в предел 4 МБ
 * (413), поэтому проект создаётся с остовом документа (корень и шкалы), а узлы досылаются
 * транзакциями `create` по порядку родителей (`SHELL.rescuePlan`), с прогрессом в доке.
 * Сорвалось на середине — новый проект уже есть: повтор продолжит с той же пачки.
 */
async function saveAsNewProject() {
  const sync = server && server.sync;
  const view = sync && sync.view;
  if (!view) { toast('Сохранять нечего: документа в этой вкладке нет.', 'error', 8000); return; }
  if (server.rescue && server.rescue.running) return;
  const name = cutText(cleanText(server.project.name || docTitle()), 120) || 'Восстановленный проект';
  // прошлая попытка остановилась на середине — продолжаем её, а не создаём ещё один проект
  let job = server.rescue && server.rescue.failed && server.rescue.from === sync ? server.rescue : null;
  /* Круг 43 (UX Д8): документ мог измениться после неудачной попытки (правки без перезагрузки).
     Тело задания — прежнее: тот же create_id вернёт проект первой попытки (или создаст его), а
     то, что изменилось потом, досылается заменой документа (rescueCatchUp). Ни второго проекта,
     ни молча потерянных правок. */
  if (job && !job.catchUp && rescueChanged(job, view, name)) job.catchUp = true;
  /* Круг 31 (UX Д8): попытка этой вкладки до перезагрузки — в sessionStorage. Проект, в
     который она досылала, уже есть: продолжаем его, а не заводим второй. */
  if (!job) job = await resumeRescue(sync, view, name);
  if (!job) {
    let plan;
    try { plan = SHELL.rescuePlan(view, { name }); } catch (e) { toast(`Не сохранилось: ${SHELL.rescueFailWords(e)}.`, 'error', 9000); return; }
    if (plan.oversize.length) {
      showMsg('error', 'Работу не сохранить одним проектом', {
        note: `В документе есть ${plan.oversize.length === 1 ? 'слой' : 'слои'} больше 3,5 МБ — сервер не примет их ни в какой пачке. Экспортируйте документ в JSON (меню экспорта), чтобы не потерять работу.`,
        role: 'project-gone',
      });
      return;
    }
    job = { from: sync, plan, project: null, createId: newCreateId(), bodySig: rescueBodySig(plan), seq: 0, done: 0, total: plan.batches.length, running: false, failed: false, startedAt: Date.now() };
    server.rescue = job;
  }
  job.running = true;
  job.failed = false;
  renderSyncStatus();   // кнопка в строке состояния — «сохраняю…», второй раз не нажать
  const progress = () => {
    if (!job.total) return;
    showMsg('plain', 'Сохраняю работу новым проектом…', {
      note: `Документ большой — отправляю частями: ${job.done} из ${job.total}. Не закрывайте вкладку.`,
      role: 'project-saving',
    });
  };
  try {
    if (!job.project) {
      progress();
      /* Круг 33 (L1): create_id — один на задание и записан ДО запроса. Ответ потерялся
         (обрыв, перезагрузка) — повтор с тем же create_id вернёт тот же проект, а не второй. */
      if (!job.createId) job.createId = newCreateId();
      if (!job.bodySig) job.bodySig = rescueBodySig(job.plan);
      rememberRescue(job);
      let got;
      try {
        got = await apiJson('/api/projects', { method: 'POST', body: { ...job.plan.body, create_id: job.createId } });
      } catch (e) {
        /* Круг 41 (арх. Н2): 409 — этот create_id уже занят проектом с другим телом. Тот же ключ
           повторять бесполезно: новый ключ, один раз. Проект первой попытки точно есть — о нём
           скажем словами и пометим в «Проектах» (круг 43). */
        if (!(e && e.status === 409)) throw e;
        // круг 45: ключ первой попытки — им пустую сироту можно удалить из «Проектов»
        job.orphan = { name: cleanText(job.plan.body && job.plan.body.name) || name, since: job.startedAt || Date.now() - 3600 * 1000, certain: true, createId: job.createId };
        job.createId = newCreateId();
        rememberRescue(job);
        got = await apiJson('/api/projects', { method: 'POST', body: { ...job.plan.body, create_id: job.createId } });
      }
      if (!got || !got.id) throw new Error('сервер не вернул проект');
      job.project = got;
      job.seq = Number(got.head_seq) || 0;
      rememberRescue(job);
    }
    while (job.done < job.total) {
      progress();
      const ops = job.plan.batches[job.done];
      const r = await sendRescueBatch(job.project.id, ops, job.seq, `Восстановил работу: часть ${job.done + 1} из ${job.total}`);
      job.seq = Number(r && r.seq) || job.seq + 1;
      job.done += 1;
      rememberRescue(job);
    }
    // круг 43 (UX Д8): правки после неудачной попытки — заменой документа, тем же проектом
    if (job.catchUp) {
      await rescueCatchUp(job, sync.view || view);
      job.catchUp = false;
    }
    job.running = false;
    server.rescue = null;
    forgetRescue();
    hideMsg();
    const got = job.project;
    if (job.orphan) rememberOrphan({ ...job.orphan, keep: got.id });
    openProject(got);
    const saved = `Сохранил работу новым проектом «${clip(got.name || name, 60)}».`;
    if (job.orphan) {
      const w = SHELL.rescueOrphanWords(job.orphan);
      showMsg('plain', saved, { note: w, ms: 15000, role: 'rescue-orphan', actions: [{ label: 'Проекты', onClick: () => openProjects() }] });
    } else toast(saved, 'plain', 8000);
  } catch (e) {
    job.running = false;
    job.failed = true;
    server.goneShown = false;
    // круг 41 (арх. Н2): причина — словами оболочки, текст сервера человеку не показываем
    toast(job.total && job.project
      ? `Сохранено ${job.done} из ${job.total} частей: ${SHELL.rescueFailWords(e)}. «Сохранить» продолжит.`
      : `Не сохранилось: ${SHELL.rescueFailWords(e)}. «Сохранить» повторит.`, 'error', 9000);
    projectGoneMsg({ force: true });
  }
  renderSyncStatus();
}

/** Круг 43 (UX Д8): изменился ли документ вкладки с тех пор, как задание спасения составило план. */
function rescueChanged(job, view, name) {
  let now;
  try { now = SHELL.rescuePlan(view, { name }); } catch { return false; }
  return rescueBodySig(now) !== rescueBodySig(job.plan) || rescueSig(now) !== rescueSig(job.plan);
}

/**
 * Круг 43 (UX Д8): проект спасения уже есть, а документ вкладки с тех пор менялся — документ
 * проекта заменяется нынешним видом вкладки (как импорт: снять детей корня, создать узлы
 * заново, токены группами), частями по пределу транзакции.
 */
async function rescueCatchUp(job, viewNow) {
  const id = job.project.id;
  const got = await apiJson(`/api/projects/${encodeURIComponent(id)}`);
  if (!got || !got.snapshot || !got.snapshot.doc) throw new Error('сервер не вернул проект');
  let doc = got.snapshot.doc;
  for (const t of Array.isArray(got.tail) ? got.tail : []) {
    const r = CORE.applyOps(doc, Array.isArray(t.ops) ? t.ops : []);
    if (!r.error) doc = r.doc;
  }
  let seq = Number(got.head_seq) || job.seq;
  const parts = SHELL.splitOpsForServer(SHELL.replaceDocOps(doc, viewNow));
  for (let i = 0; i < parts.length; i++) {
    const r = await sendRescueBatch(id, parts[i], seq, parts.length > 1 ? `Восстановил работу: правки после первой попытки, часть ${i + 1} из ${parts.length}` : 'Восстановил работу: правки после первой попытки');
    seq = Number(r && r.seq) || seq + 1;
  }
  job.seq = seq;
}

/* Круг 31 (UX Д8): задание спасения переживает перезагрузку вкладки — sessionStorage:
   {from: id пропавшего проекта, project: {id, name}, done, total, sig}. sig — отпечаток пачек.
   Круг 43: и само тело создания, если оно невелико (body), — тогда после перезагрузки повтор
   идёт тем же create_id с тем же телом, а изменившееся досылается заменой документа. */
const RESCUE_KEY = 'imago.rescue.v1';

/** Отпечаток тела создания (имя и документ): тот же create_id — только с тем же телом (§9.17). */
function rescueBodySig(plan) {
  try { return plan && plan.body ? hash36(JSON.stringify(plan.body), 16) : ''; } catch { return ''; }
}

function rescueSig(plan) {
  return plan && Array.isArray(plan.batches) ? plan.batches.map((b) => b.length).join('.') + ':' + (plan.nodes || 0) : '';
}

/** create_id (L1): 8–64 символа [A-Za-z0-9_-] — сервер по нему узнаёт повтор создания. */
function newCreateId() {
  const raw = `cr_${CORE.uid('r')}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function rememberRescue(job) {
  if (!job || (!job.project && !job.createId) || !server || !server.project) return;
  // круг 45 (мутант RS2): что хранится — SHELL.rescueMemo, его проверяет поведенческий тест
  const memo = SHELL.rescueMemo(job, { from: server.project.id, sig: rescueSig(job.plan) });
  try { sessionStorage.setItem(RESCUE_KEY, memo.full); } catch {
    try { sessionStorage.setItem(RESCUE_KEY, memo.lean); } catch { /* приватный режим — продолжим только в этой загрузке */ }
  }
}

function forgetRescue() {
  try { sessionStorage.removeItem(RESCUE_KEY); } catch { /* нечего снимать */ }
}

/** Задание прошлой загрузки этой вкладки — продолжить в тот же проект, если он есть на сервере. */
async function resumeRescue(sync, view, name) {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(RESCUE_KEY) || 'null'); } catch { saved = null; }
  if (!saved || !server || !server.project || saved.from !== server.project.id) return null;
  const createId = typeof saved.create_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(saved.create_id) ? saved.create_id : '';
  const startedAt = Number(saved.started_at) || Number(saved.at) || Date.now();
  let plan;
  try { plan = SHELL.rescuePlan(view, { name }); } catch { return null; }
  if (plan.oversize.length) { forgetRescue(); return null; }
  const bodySig = rescueBodySig(plan);
  /* Круг 33 (L1): запрос создания ушёл, а ответа вкладка не дождалась (перезагрузили). Проект
     мог создаться — повтор с тем же create_id вернёт его, а не заведёт второй. */
  if ((!saved.project || typeof saved.project.id !== 'string') && createId) {
    const same = typeof saved.body_sig === 'string' && saved.body_sig && saved.body_sig === bodySig;
    if (same) {
      const job = { from: sync, plan, project: null, createId, bodySig, seq: 0, done: 0, total: plan.batches.length, running: false, failed: false, startedAt };
      server.rescue = job;
      return job;
    }
    /* Круг 43: документ с тех пор изменился. Тело первой попытки сохранено — повторяем ровно его
       тем же ключом (сервер вернёт проект первой попытки или создаст его), остальное досылаем
       заменой документа: проект один. */
    let old = null;
    try { old = typeof saved.body === 'string' ? JSON.parse(saved.body) : null; } catch { old = null; }
    if (old && old.doc && saved.body_sig === hash36(JSON.stringify(old), 16)) {
      const oldPlan = { whole: true, body: old, batches: [], nodes: Object.keys(old.doc.nodes || {}).length, oversize: [] };
      const job = { from: sync, plan: oldPlan, project: null, createId, bodySig: saved.body_sig, seq: 0, done: 0, total: 0, running: false, failed: false, catchUp: true, startedAt };
      server.rescue = job;
      return job;
    }
    /* Тела нет (большой документ) — тот же ключ с другим телом дал бы 409: новый ключ. Проект
       первой попытки мог создаться — скажем об этом и пометим его в «Проектах». */
    const job = {
      from: sync, plan, project: null, createId: newCreateId(), bodySig, seq: 0, done: 0, total: plan.batches.length, running: false, failed: false, startedAt,
      orphan: { name, since: startedAt, certain: false, ...(typeof createId === 'string' && createId ? { createId } : {}) },
    };
    server.rescue = job;
    return job;
  }
  if (!saved.project || typeof saved.project.id !== 'string') return null;
  let head = null;
  try { head = await fetchProjectHead(saved.project.id); } catch { head = null; }
  if (!head) { forgetRescue(); return null; }   // того проекта нет — начнём заново
  /* Проект уже есть. Документ тот же — продолжаем пачки с той, на которой остановились; другой —
     пачки не досылаем, документ проекта заменяется нынешним видом (круг 43). */
  const same = rescueSig(plan) === saved.sig && (!saved.body_sig || saved.body_sig === bodySig);
  const done = same ? Math.max(0, Math.min(plan.batches.length, Number(saved.done) || 0)) : plan.batches.length;
  const job = {
    from: sync, plan, project: { id: saved.project.id, name: head.name || saved.project.name || name },
    createId, bodySig, seq: Number(head.head_seq) || 0, done, total: plan.batches.length, running: false, failed: false,
    catchUp: !same, startedAt, ...(saved.orphan ? { orphan: saved.orphan } : {}),
  };
  server.rescue = job;
  return job;
}

/* Круг 43: проект первой попытки спасения, оставшийся отдельным (409 или тело не пережило
   перезагрузку), — помета в «Проектах»: имя, с какого времени и какой проект — спасённый. */
const ORPHAN_KEY = 'imago.rescue.orphans.v1';
function rememberOrphan(o) {
  try {
    const list = JSON.parse(localStorage.getItem(ORPHAN_KEY) || '[]');
    const next = (Array.isArray(list) ? list : []).filter((x) => x && x.keep !== o.keep).concat([{ name: o.name, since: o.since, keep: o.keep, certain: !!o.certain, at: Date.now(), ...(typeof o.createId === 'string' && o.createId ? { createId: o.createId } : {}) }]).slice(-20);
    localStorage.setItem(ORPHAN_KEY, JSON.stringify(next));
  } catch { /* памяти нет — скажем только словами */ }
}
/** Круг 45: сирота удалена (или её больше нет) — подсказку забываем. */
function forgetOrphan(createId) {
  try {
    const list = JSON.parse(localStorage.getItem(ORPHAN_KEY) || '[]');
    localStorage.setItem(ORPHAN_KEY, JSON.stringify((Array.isArray(list) ? list : []).filter((x) => x && x.createId !== createId)));
  } catch { /* памяти нет */ }
}
/** Круг 45 (UX r45c): сервер ответил «не этот create_id» — эта строка не наша сирота, пометку с неё снять. */
function notOrphan(createId, id) {
  try {
    const list = JSON.parse(localStorage.getItem(ORPHAN_KEY) || '[]');
    const next = (Array.isArray(list) ? list : []).map((x) => (x && x.createId === createId
      ? { ...x, not: [...(Array.isArray(x.not) ? x.not : []), id].slice(-20) } : x));
    localStorage.setItem(ORPHAN_KEY, JSON.stringify(next));
  } catch { /* памяти нет */ }
}
function orphanHints() {
  try {
    const list = JSON.parse(localStorage.getItem(ORPHAN_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.name === 'string' && Date.now() - (Number(x.at) || 0) < 7 * 86400 * 1000) : [];
  } catch { return []; }
}

/** Пачка досылки — HTTP-транзакцией; занято (503/429) — подождать и повторить. */
async function sendRescueBatch(projectId, ops, baseSeq, title) {
  const body = { tx_id: CORE.uid('tx'), base_seq: baseSeq, engine: CORE.ENGINE_VERSION, ops, title, author_kind: 'human' };
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await apiJson(`/api/projects/${encodeURIComponent(projectId)}/tx`, { method: 'POST', body });
      if (r && Array.isArray(r.dropped) && r.dropped.length) {
        // сервер не отказывает, а отбрасывает: документ упёрся в предел — дальше слать незачем
        const lim = r.dropped.find((d) => d && d.limit);
        if (lim) throw Object.assign(new Error(lim.limit === 'doc_nodes' ? 'документ упёрся в предел числа слоёв' : 'документ упёрся в предел размера'), { retryable: false });
      }
      return r;
    } catch (e) {
      const busy = e && (e.status === 503 || e.status === 429 || e.code === 'busy');
      if (!busy || attempt >= 4) throw e;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}

function onSyncPresence(list) {
  if (!server) return;
  server.others = Array.isArray(list) ? list : [];
  noteClientNames(server.others);
  renderSyncStatus();
  renderPresence();
}

function onSyncError(e) {
  if (!server || !e) return;
  if (e.code === 'engine') {
    // круг 39 (N1): 426 / hello с другой версией движка — слова у реплики (engineWords)
    const w = engineWords(e.engine, CORE.ENGINE_VERSION);
    // круг 41 (UX Д7): сервер старее — перезагрузка не поможет, кнопки «Обновить страницу» нет
    const noDoc = !(server.sync && server.sync.view);
    showMsg(w.newer ? 'error' : 'warn', !w.newer && noDoc ? 'Сервер ещё не обновился — проект откроется сам' : w.title, {
      note: !w.newer && noDoc
        ? 'Проект записан более новой версией редактора, а сервер документов ещё на прежней. Как только сервер обновят, проект откроется сам — перезагружать страницу не нужно.'
        : w.note,
      role: 'engine',
      actions: w.newer ? [{ label: 'Обновить страницу', primary: true, onClick: () => location.reload() }] : [],
    });
    agentModeChanged();
    return;
  }
  /* Коды сервера — snake_case (SPEC §9.8): not_found, too_large, bad_request… Прежнее
     'not-found' реплики принимаем тоже, пока она его шлёт. */
  if (e.code === 'not_found' || e.code === 'not-found') {
    // круг 27, I3: документ в вкладке есть — проект пропал уже после открытия
    if (server.sync && server.sync.view && SHELL.userNodeCount(server.sync.view) > 0) { projectGoneMsg(); return; }
    showMsg('error', 'Проект не найден', {
      note: 'Его могли удалить, или ссылка ведёт не туда.',
      actions: [
        { label: 'Открыть последний', primary: true, onClick: async () => {
          try {
            const got = await apiJson('/api/projects?limit=1');
            const p = latestProject(got && got.projects) || await createProject('Новый проект');
            hideMsg();
            openProject(p);
          } catch (err) { toast(`Не вышло: ${afterColon(humanError(err))}`, 'error', 8000); }
        } },
        { label: 'Проекты', onClick: () => { hideMsg(); openProjects(); } },
      ],
    });
    return;
  }
  /* Круг 25: реплика раз за разом не может записать правку и сняла её «не сохранено» —
     правка не пропадает молча: говорим какая и даём вернуть её в очередь. Код сервера
     человеку не нужен (п.7). */
  if (e.code === 'not_saved') {
    if (e.tx) forgetRejectedTx(e.tx.tx_id);
    const entryTitle = e.tx && (e.tx.title || '');
    const what = entryTitle ? `«${clip(cleanText(entryTitle), 60)}»` : '';
    const sync = server.sync;
    const canRetry = !!(e.tx && sync && typeof sync.retryUnsaved === 'function');
    showMsg('error', `Правка ${what ? `${what} ` : ''}не сохранена`, {
      note: 'Сервер раз за разом не может её записать — она снята с очереди, остальные правки сохраняются.',
      role: 'not-saved',
      actions: canRetry ? [{ label: 'Попробовать ещё раз', primary: true, onClick: () => { hideMsg(); sync.retryUnsaved(e.tx.tx_id); } }] : [],
    });
    return;
  }
  // после восстановления базы не всё своё удалось переиграть — словами реплики, без кодов
  if (e.code === 'replay_expired' || e.code === 'replay_incomplete') {
    const [head, ...rest] = String(e.message || '').split(': ');
    const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
    showMsg('warn', cap(cleanText(head)) || 'Часть правок из прошлой версии не восстановлена', {
      note: rest.length ? `${cap(cleanText(rest.join(': ')))}.` : '',
      role: 'replay',
    });
    return;
  }
  if (e.code === 'diverged') {
    toast('Транзакция сервера не применилась к реплике — обновите страницу, если холст разошёлся.', 'error', 9000);
    return;
  }
  // сервер отверг транзакцию целиком: её уже нет в очереди, документ откатился —
  // и в стеке отмены ей делать нечего
  if (e.tx) forgetRejectedTx(e.tx.tx_id);
  /* Слишком большая правка (SPEC §9.8, 413 too_large): её отверг сервер (тогда есть e.tx)
     или не завела сама реплика — commit отказал до отправки, и e.tx нет. В обоих случаях
     правки нет ни на холсте, ни в журнале — человек должен узнать это и что делать. */
  if (e.code === 'too_large') {
    const w = tooLargeWords(e, LIMITS);
    // поле инспектора всё ещё держит отвергнутое значение — вернуть ему то, что в документе
    renderInspector();
    showMsg('error', w.title, { note: w.note, role: 'too-large' });
    addChat('agent', `${w.title}. ${w.note}`);
    return;
  }
  if (e.tx) {
    const why = e.code === 'forbidden' ? 'сервер запретил запись в этот проект'
      : e.code === 'bad_request' ? 'правка негодной формы — обновите страницу, версия клиента могла устареть'
        : e.message ? shellWord(e.message) : '';
    showMsg('error', 'Сервер не принял правку', { note: why });
  }
}

/** Отвергнутая сервером транзакция — из стека отмены (её больше нет нигде). */
function forgetRejectedTx(txId) {
  // круг 31: часть большой правки — запись целиком не выбрасываем, остальные части легли
  if (state.history.some((t) => t.parts && t.parts.includes(txId) && t.parts.length > 1 && t.parts[0] !== txId)) return;
  const i = state.history.findIndex((t) => t.id === txId);
  if (i < 0) return;
  state.history.splice(i, 1);
  if (state.cursor > i) state.cursor -= 1;
  scheduleSave();
  refreshSheet();
}

/* ------------------- круг 25, п.5: кто удалил и как звался удалённый ------------------- */
/* Чужая транзакция удалила слои: запоминаем, как они звались и кто удалил, — когда своя
   правка этих слоёв не применится, человек узнает «Аня удалила этот слой», а не «узел уже
   удалён». Реплика умеет то же (`whoRemoved`) — её ответ главнее; здесь — имя слоя, которого
   в документе уже нет, и запасной путь, пока реплика этого не умеет. */
const REMOVED_KEEP = 400;
const removedInfo = new Map();   // id → {name, by: {author, author_kind, seq, title}}

function noteRemoved(tx, prevDoc) {
  if (!tx || !Array.isArray(tx.ops) || !prevDoc || !prevDoc.nodes) return;
  const by = { author: tx.author || '', author_kind: tx.author_kind || 'human', seq: tx.seq, title: tx.title || '' };
  for (const op of tx.ops) {
    if (!op || op.op !== 'remove' || !prevDoc.nodes[op.id]) continue;
    let ids = [op.id];
    try { ids = subtreeIds(prevDoc, op.id); } catch { ids = [op.id]; }
    for (const id of ids.slice(0, 200)) {
      const n = prevDoc.nodes[id];
      if (!n) continue;
      removedInfo.delete(id);
      removedInfo.set(id, { name: n.name || placeholderName(prevDoc, n) || '', by });
    }
  }
  while (removedInfo.size > REMOVED_KEEP) removedInfo.delete(removedInfo.keys().next().value);
}

/* ----------------- круг 25, п.4: чужие правки в «Истории» ----------------- */
/* Источник — журнал реплики (`sync.journal()`: подтверждённые транзакции, новые первыми).
   Пока реплика его не даёт — свой журнал этого сеанса из пришедших чужих транзакций. Описание
   словами (как у своих) считается здесь, по документу до транзакции, и живёт по tx_id. */
const JOURNAL_KEEP = 200;
const sessionJournal = [];            // новые первыми
const journalHuman = new Map();       // tx_id → описание словами

function noteJournal(tx, doc = state.doc) {
  if (!tx || !tx.tx_id || !doc) return;
  if (!journalHuman.has(tx.tx_id) && Array.isArray(tx.ops) && tx.ops.length) {
    /* круг 43: «обернуть» соавтора, у которой слияние вычеркнуло часть слоёв, — подпись по тому,
       что легло («Обернул «Список пунктов»…»), а не по записанному до слияния «Обернул 2 слоя» */
    const group = /^Обернул /.test(cleanText(tx.title)) ? tx.ops.find((o) => o && o.op === 'create' && o.node && Array.isArray(o.node.children) && o.node.children.length) : null;
    try { journalHuman.set(tx.tx_id, group ? SHELL.wrapWords(doc, group.node.children, group.node.name) : describeOps(tx.ops, doc)); } catch { /* опишем заголовком */ }
    while (journalHuman.size > JOURNAL_KEEP) journalHuman.delete(journalHuman.keys().next().value);
  }
  if (sessionJournal.some((t) => t.tx_id === tx.tx_id)) return;
  sessionJournal.unshift({
    seq: tx.seq, tx_id: tx.tx_id, author: tx.author || '', author_kind: tx.author_kind || 'human',
    title: tx.title || '', created_at: tx.created_at || new Date().toISOString(), client: tx.client || '',
    command_id: tx.command_id || null, command_author: typeof tx.command_author === 'string' ? tx.command_author : '',
    // круг 32: части большой правки сводятся по undo_part и общему undo_of/redo_of
    undo_of: typeof tx.undo_of === 'string' ? tx.undo_of : '', redo_of: typeof tx.redo_of === 'string' ? tx.redo_of : '',
    undo_part: SHELL.undoPartOf(tx),
    ops_count: Array.isArray(tx.ops) ? tx.ops.length : 0,
    dropped_count: Array.isArray(tx.dropped) ? tx.dropped.length : 0, empty: !Array.isArray(tx.ops) || !tx.ops.length,
    mine: !!(server && server.sync && tx.client && tx.client === server.sync.clientId),
  });
  if (sessionJournal.length > JOURNAL_KEEP) sessionJournal.length = JOURNAL_KEEP;
}

/* Круг 29, п.7: чья вкладка (client) — какое имя. Правка агента по чужой команде подписана
   «Агент · Аня», пока Аня в сети (присутствие); ушла — имя берём отсюда. Запоминается из
   присутствия и живёт в локальном журнале проекта (journalExtra.clients). */
const CLIENT_NAMES_KEEP = 100;
const clientNames = new Map();   // client → имя

function noteClientNames(list) {
  let changed = false;
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.client !== 'string' || !p.client) continue;
    const name = cutText(cleanText(p.author), 60);
    if (!name || clientNames.get(p.client) === name) continue;
    clientNames.delete(p.client);
    clientNames.set(p.client, name);
    changed = true;
  }
  while (clientNames.size > CLIENT_NAMES_KEEP) clientNames.delete(clientNames.keys().next().value);
  if (changed && server && server.sync && typeof server.sync.touch === 'function') server.sync.touch();
}

function clientNamesList() {
  return [...clientNames].slice(-CLIENT_NAMES_KEEP);
}

function adoptClientNames(list) {
  if (!Array.isArray(list)) return;
  for (const pair of list) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
    if (!clientNames.has(pair[0])) clientNames.set(pair[0], cutText(cleanText(pair[1]), 60));
  }
}

/** Имя автора команды, по которой работал агент: присутствие, потом память. */
function commandAuthorOf(t) {
  if (!t) return '';
  // круг 30: имя автора команды лежит в самой записи (command_author от Orchestrator)
  const own = typeof t.command_author === 'string' ? cleanText(t.command_author).trim() : '';
  if (own) return own;
  if (!t.client) return '';
  const live = server && Array.isArray(server.others) ? server.others.find((p) => p && p.client === t.client) : null;
  return (live && cleanText(live.author)) || clientNames.get(t.client) || '';
}

/** Подтверждённые транзакции проекта, новые первыми: журнал реплики или свой журнал сеанса. */
function journalList() {
  const sync = server && server.sync;
  if (sync && typeof sync.journal === 'function') {
    try {
      const got = sync.journal(JOURNAL_KEEP);
      if (Array.isArray(got)) return got;
    } catch { /* реплика не смогла — свой журнал */ }
  }
  return sessionJournal;
}

/** Имя слоя — из документа или из памяти об удалённых. */
function layerNameOf(id) {
  if (!id) return '';
  const n = state.doc && state.doc.nodes ? state.doc.nodes[id] : null;
  if (n) return n.name || placeholderName(state.doc, n) || '';
  const r = removedInfo.get(id);
  return r ? r.name : '';
}

/** Кто помешал отброшенной операции: `by` от сервера, `whoRemoved` реплики, своя память. */
function dropperOf(d) {
  if (!d) return null;
  if (d.by && typeof d.by === 'object') return d.by;
  const op = d.op || {};
  // круг 39: отброшенная пустая группа (create с детьми) — кто удалил её слои
  const kids = op.op === 'create' && op.node && Array.isArray(op.node.children) ? op.node.children : null;
  const id = d.reason === 'orphan' ? (op.node && op.node.parent) || op.parent
    : kids && kids.length ? kids[0] : op.id;
  if (!id) return null;
  const sync = server && server.sync;
  if (sync && typeof sync.whoRemoved === 'function') {
    try { const w = sync.whoRemoved(id); if (w) return w; } catch { /* реплика не знает — своя память */ }
  }
  const r = removedInfo.get(id);
  return r ? r.by : null;
}

/** dropped словами (shell.droppedWords) с именами слоёв и тем, кто помешал. */
function droppedMsgOf(dropped, { applied = 0, agent = false } = {}) {
  return droppedWords({ dropped, applied, agent, nameOf: layerNameOf, whoOf: dropperOf });
}

/**
 * Сервер отбросил часть своей транзакции (§9.5). Если то же самое предсказал локальный
 * rebase при commit — человеку уже сказано, второй раз не говорим. Круг 25, п.5: конкретно —
 * что не применилось, почему и кто помешал; «остальное применено» — только если было что;
 * карточка не исчезает сама — её закрывает человек.
 */
function onSyncDropped(committed) {
  if (!server || !committed || !Array.isArray(committed.dropped) || !committed.dropped.length) return;
  if (committed.author_kind === 'system') return;
  // правка агента: о ней скажет итог команды (presentServerResult), здесь второй раз не нужно
  if (committed.author_kind === 'agent') return;
  const entry = state.history.find((t) => t.id === committed.tx_id || (t.parts && t.parts.includes(committed.tx_id)));
  const predicted = entry && entry.predictedBy && Array.isArray(entry.predictedBy[committed.tx_id]) ? entry.predictedBy[committed.tx_id]
    : entry && entry.id === committed.tx_id && Array.isArray(entry.predicted) ? entry.predicted : [];
  /* Сверяем номера только у записей с index: выжимка журнала (SPEC §9.8) кончается
     записью {more: N} без номера. Она говорит лишь, сколько отброшено сверх перечня, —
     прогноз совпал, если перечень — его начало, а всего отброшено столько же. */
  const got = committed.dropped.filter((d) => d && Number.isInteger(d.index)).map((d) => d.index).sort((a, b) => a - b);
  const more = committed.dropped.reduce((n, d) => n + (d && !Number.isInteger(d.index) && Number.isFinite(d.more) ? d.more : 0), 0);
  const same = predicted.length === got.length + more && got.every((x, i) => predicted[i] === x);
  if (predicted.length && same) return;
  const w = droppedMsgOf(committed.dropped, { applied: Array.isArray(committed.ops) ? committed.ops.length : 0 });
  addChat('agent', w.title, [], w.note);
  showMsg('warn', w.title, { note: w.note, role: 'dropped' });
}

/**
 * Подтверждение своей транзакции: запись истории получает номер, применённую форму и
 * инверсию от подтверждённого состояния — она точнее оптимистичной, если сервер что-то
 * переложил. Транзакция отмены/повтора записи не имеет: её инверсия достаётся той записи,
 * которую она отменяла или возвращала (см. serverStep).
 */
function settleHistory(info) {
  const c = info && info.tx;
  if (!c) return;
  // сервер отбросил всё: транзакция ничего не сделала, и в стеке отмены ей нечего отменять
  const dead = Array.isArray(c.ops) && c.ops.length === 0;
  /* Круг 31 (K1): часть большой правки или её отмены. Запись одна; уточнять её ops/inverse
     по одной части нельзя (инверсия части — не инверсия правки): держим оптимистичные и
     снимаем «в пути», когда подтверждены все части. */
  const k = state.history.findIndex((t) => (t.partsLeft && t.parts && t.parts.includes(c.tx_id)) || (t.lastLeft && t.lastParts && t.lastParts.includes(c.tx_id)));
  if (k >= 0) {
    const entry = state.history[k];
    if (entry.partsLeft && entry.parts.includes(c.tx_id)) {
      entry.partsLeft.delete(c.tx_id);
      if (!entry.partsLeft.size) { entry.partsLeft = null; entry.pending = false; if (Number.isInteger(c.seq)) entry.seq = Math.max(c.seq, Number(entry.seq) || 0); }
    } else {
      entry.lastLeft.delete(c.tx_id);
      if (!entry.lastLeft.size) { entry.lastLeft = null; entry.pending = false; }
    }
    return;
  }
  const i = state.history.findIndex((t) => t.id === c.tx_id);
  if (i >= 0) {
    if (dead) { dropHistoryEntry(i); return; }
    const entry = state.history[i];
    entry.pending = false;
    entry.seq = c.seq;
    entry.ops = c.ops;
    // круг 43: не легло часть операций — «История» скажет это (SHELL.appliedLine)
    entry.dropped = Array.isArray(c.dropped) ? c.dropped.length : (Number(c.dropped) || 0);
    if (Array.isArray(info.inverse) && info.inverse.length) entry.inverse = info.inverse;
    return;
  }
  const j = state.history.findIndex((t) => t.lastTx === c.tx_id);
  if (j >= 0) {
    if (dead) { dropHistoryEntry(j); return; }
    const owner = state.history[j];
    if (Array.isArray(info.inverse) && info.inverse.length) {
      if (owner.undone) owner.ops = info.inverse; else owner.inverse = info.inverse;
    }
    owner.pending = false;
  }
}

/**
 * Круг 41 (UX): «Обернуть» легла не целиком — часть слоёв соавтор удалил раньше (слияние их
 * вычеркнуло). Подпись шага истории и карточки — по тому, что легло, и слово о пропавших.
 */
function settleWrapWords(info) {
  const c = info && info.tx;
  if (!c) return;
  const entry = state.history.find((t) => t.id === c.tx_id);
  if (!entry || !entry.wrapOf || !Array.isArray(entry.wrapKids)) return;
  const w = SHELL.wrapSettledWords(state.doc, c.ops, entry.wrapOf, entry.wrapKids);
  if (!w) return;
  entry.human = w.words;
  entry.wrapKids = null;
  refreshSheet();
  // круг 43: кто удалил — если один на всех пропавших и он известен (реплика или своя память)
  const whos = w.lostIds.map((id) => dropperOf({ reason: 'removed', op: { op: 'remove', id } }));
  const first = whos[0];
  const one = first && whos.every((x) => x && x.author === first.author && x.author_kind === first.author_kind) ? first : null;
  const note = SHELL.wrapLostWords(w.lost, one);
  if (msgUndoTx === entry.id) {
    showMsg('plain', w.words, {
      note, ms: 9000, transient: true,
      actions: [{ label: 'Отменить', onClick: () => undoTx(entry.id) }], undoTx: entry.id,
    });
  } else toast(`${w.words}. ${note}`, 'plain', 8000);
}

/** 12 знаков base36 от строки — детерминированный id, когда два клиента должны сойтись на одном. */
function hash36(str, len = 12) {
  let h = 0x811c9dc5, g = 0x01000193;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ c, 16777619) >>> 0;
    g = Math.imul(g ^ c, 2246822519) >>> 0;
  }
  return (h.toString(36) + g.toString(36) + h.toString(36)).slice(0, len);
}

/**
 * Миграции формата (SPEC §8.3): библиотека компонентов и ссылки на шкалы — те же операции,
 * что делают ensureLibrary/ensureScaleRefs в adoptDoc, но системной транзакцией в журнал,
 * один раз на открытие и только если есть что мигрировать. Id библиотеки выводится из id
 * проекта: два клиента, открывшие проект одновременно, заведут ОДНУ библиотеку — второй
 * create сервер отбросит как повтор (exists), а не положит вторую страницу.
 */
function maybeMigrate() {
  if (!server || server.migrated || !server.sync || !server.sync.view || !state.doc) return;
  server.migrated = true;
  const libOps = ensureLibraryOps(state.doc);
  for (const op of libOps) {
    if (op.op === 'create' && op.node) op.node.id = 'lib_' + hash36(server.project.id);
  }
  let next = state.doc;
  if (libOps.length) {
    const r = applyOps(state.doc, libOps);
    if (!r.error) next = r.doc;
  }
  const list = [...libOps, ...ensureScaleRefsOps(next)];
  if (!list.length) return;
  // круг 27, I7: в документе ничего своего — это не «прежняя версия», а пустой проект
  const fromOld = SHELL.userNodeCount(state.doc) > 0;
  const r = commit(list, 'Миграция формата', 'human', { system: true, quiet: true, noFrames: true, noHistory: true });
  if (r.ok && fromOld) {
    const done = [];
    if (libOps.length) done.push('завёл библиотеку компонентов');
    if (list.length > libOps.length) done.push('отступы и скругления перевёл на шкалы документа');
    toast(`Документ из прежней версии — ${done.join(', ')}.`, 'plain', 8000);
  }
}

/** Имя автора: видно другим участникам у рамки выделения и в истории. Спрашиваем один раз, в доке. */
function askAuthorIfNeeded() {
  if (!server || settings.author || server.authorAsked) return;
  server.authorAsked = true;
  showMsg('question', 'Как вас называть?', {
    note: 'Имя видно другим участникам проекта — у вашего выделения и в истории правок. Сменить можно в настройках.',
    role: 'author',
  });
  const host = dom['dockmsg-ask'];
  if (!host) return;
  host.textContent = '';
  host.hidden = false;
  const form = document.createElement('form');
  form.className = 'ask-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ask-input';
  input.spellcheck = false;
  input.maxLength = 40;
  input.placeholder = 'Ваше имя';
  input.setAttribute('aria-label', 'Ваше имя для других участников');
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'btn accent small';
  go.textContent = 'Готово';
  form.append(input, go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cutText(cleanText(input.value), 40);
    if (!name) { input.focus(); return; }
    setAuthor(name);
    hideMsg();
    toast(`Для других участников вы — ${name}.`, 'plain', 5000);
  });
  host.appendChild(form);
  input.focus();
}

function setAuthor(name) {
  settings.author = cutText(cleanText(name), 40);
  saveSettings();
  if (server && server.sync) server.sync.setAuthor(settings.author);
}

/** Имя документа в шапке: в серверном режиме это имя проекта — meta.name операциями не правится. */
function docTitle() {
  // круг 39: имя ещё не пришло (проект открывается по ссылке без отметки) — пусто, а не «Без названия»
  if (server && server.project) return server.project.name || (server.sync && server.sync.view && !projectConnecting() ? 'Без названия' : '');
  // круг 31: список проектов не пришёл — открыто ничего; «Пустая страница» была бы выдумкой
  if (server && server.listWait) return 'Проект не открыт';
  // круг 39 (N6а): проект выбирается или сервер ещё не ответил — имя из отметки, если она про него
  // имени ещё нет — пусто: «подключаюсь к проекту…» уже говорит строка состояния рядом
  if (server || serverBooting) return bootProjectName();
  return (state.doc && state.doc.meta && state.doc.meta.name) || 'Без названия';
}

/** Имя проекта, который откроется: из отметки, если ссылка ведёт туда же (или ссылки нет). */
function bootProjectName() {
  const m = serverMark();
  const id = projectIdFromUrl();
  return m && m.name && (!id || m.projectId === id) ? cutText(cleanText(m.name), 120) : '';
}

/**
 * Круг 39 (N6а): проект ещё подключается — до первого hello (или первой неудачи) одно
 * нейтральное состояние: без приглашения «Скажите, что построить» и без красных статусов.
 */
function projectConnecting() {
  if (!server) return serverBooting;
  if (server.listWait) return false;
  const s = server.status || {};
  if (s.error || s.storage === 'down') return false;
  if (!(server.sync && server.sync.view)) return true;
  return !s.online && !!s.connecting;
}

async function renameProject(name) {
  if (!server || !server.project) return;
  const next = cutText(cleanText(name), 120) || 'Без названия';
  if (next === server.project.name) return;
  const was = server.project.name;
  server.project.name = next;
  setDocNameText(next);
  try {
    const got = await apiJson(`/api/projects/${encodeURIComponent(server.project.id)}`, { method: 'PATCH', body: { name: next } });
    if (got && got.name) server.project.name = got.name;
  } catch (e) {
    server.project.name = was;
    setDocNameText(was);
    toast(`Имя не сохранилось: ${afterColon(humanError(e))}`, 'error', 8000);
  }
  setDocNameText(server.project.name);
}

/** Строка состояния в шапке (SPEC §9.5) и кто в сети. */
function renderSyncStatus() {
  const host = dom['sync-status'];
  if (!host || !server) return;
  const s = server.status || {};
  let text = '';
  let kind = 'off';
  const opened = !!(server.sync && server.sync.view);
  if (s.error === 'engine') { text = s.label || statusLine(s); kind = 'error'; }
  else if (s.error === 'not_found') { text = s.label || 'проект не найден на сервере'; kind = 'error'; }
  /* J4 (круг 29): сервер на связи, но его хранилище не пишет — правки ждут в очереди.
     Круг 30: раньше «сервер недоступен» и «открываю проект…» — вкладка, открытая при лежащей
     базе, говорит то же, что вкладка с отказом записи (слова — у реплики, `s.label`). */
  else if (s.storage === 'down') { text = s.label || (s.pending ? 'сервер не может сохранить — правки ждут' : 'сервер не может сохранить'); kind = 'error'; }
  else if (s.error === 'unreachable') { text = 'сервер недоступен'; kind = 'error'; }
  // круг 39 (N6а): до первого hello — одно нейтральное «подключаюсь к проекту…», не красное
  else if (!opened || (!s.online && s.connecting)) { text = s.connecting && s.label ? s.label : 'подключаюсь к проекту…'; kind = 'busy'; }
  else {
    /* Слова статуса — у реплики (statusLine, SPEC §9.5): одна формулировка на всех, кто
       показывает её состояние. Оболочка добавляет лишь то, чего реплика не знает: сокет
       закрыт, а браузер говорит, что сеть есть, — значит недоступен сервер, а не сеть.
       Правки в обоих случаях ждут в очереди. */
    text = s.label || statusLine(s);
    if (!s.online) {
      const noNet = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!noNet) text = text.replace(/^не в сети/, 'сервер недоступен');
      kind = noNet ? 'off' : 'error';
    } else kind = s.syncing ? 'busy' : 'on';
  }
  /* Круг 25, п.6. Имена соавторов больше не дописываются в строку статуса: на 1024 px с
     одним соавтором она съедала ряд досок до 28 px. Соавторы — аватарками справа (renderPeople). */
  const names = (server.others || []).map((p) => cleanText(p.author) || 'Без имени');
  host.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'sync-dot';
  dot.dataset.state = kind;
  const label = document.createElement('span');
  label.className = 'sync-text';
  label.textContent = text;
  host.append(dot, label);
  /* Круг 29 (UX Д3): проект пропал с сервера, а работа — во вкладке. Карточку спасения
     могли закрыть крестиком или сменить другими сообщениями; путь к ней остаётся здесь,
     в строке состояния, пока проекта нет. */
  const gone = s.error === 'not_found' && opened && SHELL.userNodeCount(server.sync.view) > 0;
  host.dataset.gone = gone ? 'on' : '';
  if (gone) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sync-act';
    const busy = !!(server.rescue && server.rescue.running);
    b.textContent = busy ? 'сохраняю…' : 'сохранить как новый';
    b.disabled = busy;
    b.title = 'Работа этой вкладки цела — сохранить её новым проектом';
    b.addEventListener('click', () => projectGoneMsg({ force: true }));
    host.append(b);
  }
  host.dataset.state = kind;
  renderNetPill(s, kind);
  const full = names.length ? `${text}. В сети: ${names.join(', ')}` : text;
  host.title = full;
  host.setAttribute('aria-label', `Состояние синхронизации: ${full}`);
  renderAgentStatus();
  renderPeople();
}

/**
 * Круг 31 (m11): на телефоне от строки состояния — точка у кнопки «Проекты». Нет сети или
 * сервер не сохраняет — это надо прочитать, а не угадать по цвету: короткая плашка словами
 * (CSS показывает её только на ≤ 560 px).
 */
function renderNetPill(s, kind) {
  const pill = dom['net-pill'];
  if (!pill) return;
  if (kind !== 'off' && kind !== 'error') { pill.hidden = true; return; }
  const n = Number(s.pending) || 0;
  const wait = n ? ` · ${n} ${plural(n, 'правка ждёт', 'правки ждут', 'правок ждут')}` : '';
  const noNet = typeof navigator !== 'undefined' && navigator.onLine === false;
  const text = s.error === 'engine' ? (engineWords(s.engine, s.ownEngine).newer ? 'обновите страницу' : `сервер обновляется${wait}`)
    : s.error === 'not_found' ? 'проекта нет на сервере'
      : s.storage === 'down' ? `не сохраняется${wait}`
        : noNet || kind === 'off' ? `нет сети${wait}` : `сервер недоступен${wait}`;
  pill.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'sync-dot';
  dot.dataset.state = kind;
  const label = document.createElement('span');
  label.textContent = text;
  pill.append(dot, label);
  pill.dataset.state = kind;
  pill.title = (dom['sync-status'] && dom['sync-status'].title) || text;
  pill.hidden = false;
}

/** Сколько аватарок соавторов помещается; остальные — «+N». */
const PEOPLE_SHOWN = 3;

/** Инициалы для аватарки: «Анастасия Ковалёва» → «АК», «Аня» → «А». */
function initialsOf(name) {
  const parts = cleanText(name).split(' ').filter(Boolean);
  if (!parts.length) return '?';
  const first = (w) => Array.from(w)[0] || '';
  return (first(parts[0]) + (parts[1] ? first(parts[1]) : '')).toUpperCase();
}

/**
 * Соавторы в шапке (круг 25, п.6 и п.8): кружки с инициалами цвета участника (тем же, что
 * рамка его выделения), сверх трёх — «+N». У того, над чьей командой работает агент или
 * чья команда ждёт очереди, кружок пульсирует, а подсказка говорит «Аня ждёт агента…».
 */
function renderPeople() {
  const host = dom.people;
  if (!host) return;
  const list = server ? (server.others || []) : [];
  host.textContent = '';
  if (!list.length) { host.hidden = true; return; }
  host.hidden = false;
  const lines = [];
  list.forEach((p, i) => {
    const name = cleanText(p.author) || 'Без имени';
    const doing = presenceAgentWords(p);
    lines.push(doing || name);
    if (i >= PEOPLE_SHOWN) return;
    const a = document.createElement('span');
    a.className = 'person';
    a.style.setProperty('--who', presenceColor(p.client));
    a.textContent = initialsOf(name);
    a.title = doing || name;
    if (doing) a.dataset.agent = 'on';
    host.appendChild(a);
  });
  if (list.length > PEOPLE_SHOWN) {
    const more = document.createElement('span');
    more.className = 'person more';
    more.textContent = `+${list.length - PEOPLE_SHOWN}`;
    more.title = lines.slice(PEOPLE_SHOWN).join('\n');
    host.appendChild(more);
  }
  const busy = list.map(presenceAgentWords).filter(Boolean);
  if (busy.length) {
    // словами — рядом с кружками (на узкой шапке остаётся только пульс и подсказка)
    const note = document.createElement('span');
    note.className = 'people-note';
    note.textContent = busy.length === 1 ? busy[0] : `${busy[0]} и ещё ${busy.length - 1}`;
    host.appendChild(note);
  }
  /* Круг 27, п.7. На телефоне кружков нет (им нет места) — и соавторов не было видно вовсе.
     Там остаётся один кружок с числом: «2» — в проекте ещё двое; имена — в подсказке. */
  const count = document.createElement('span');
  count.className = 'person count';
  count.textContent = String(list.length);
  count.title = `В сети: ${lines.join(', ')}`;
  if (busy.length) count.dataset.agent = 'on';
  host.appendChild(count);
  host.title = `В сети: ${lines.join(', ')}`;
  host.setAttribute('aria-label', `В сети ${list.length} ${plural(list.length, 'соавтор', 'соавтора', 'соавторов')}: ${list.map((p) => cleanText(p.author) || 'Без имени').join(', ')}${busy.length ? `. ${busy.join('. ')}` : ''}`);
}

/** Цвет участника — из его id: один и тот же у всех, кто его видит. */
function presenceColor(client) {
  let h = 0;
  const s = String(client || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 52%)`;
}

/**
 * Чужие выделения: цветная рамка с именем поверх холста. Слой свой, над сценой: сцена
 * рисует только своё выделение, а координаты мы получаем через её toScreen по тем же
 * прямоугольникам решателя, что и всё остальное.
 */
function renderPresence() {
  const host = dom.presence;
  if (!host) return;
  const list = server ? server.others : [];
  const rects = (state.geo && state.geo.rects) || {};
  host.textContent = '';
  if (!list.length || !stage || typeof stage.toScreen !== 'function') { host.hidden = true; return; }
  let drawn = 0;
  for (const p of list) {
    const ids = (p.selection || []).filter((id) => rects[id]);
    if (!ids.length) continue;
    const box = boundsOf(ids);
    if (!box) continue;
    const a = stage.toScreen(box.x, box.y);
    const b = stage.toScreen(box.x + box.w, box.y + box.h);
    const el = document.createElement('div');
    el.className = 'presence-box';
    el.style.left = `${Math.round(a.x)}px`;
    el.style.top = `${Math.round(a.y)}px`;
    el.style.width = `${Math.max(2, Math.round(b.x - a.x))}px`;
    el.style.height = `${Math.max(2, Math.round(b.y - a.y))}px`;
    el.style.setProperty('--who', presenceColor(p.client));
    const tag = document.createElement('span');
    tag.className = 'presence-name';
    // круг 25, п.8: «Аня ждёт агента…» прямо у её выделения
    tag.textContent = presenceAgentWords(p) || cleanText(p.author) || 'Без имени';
    el.appendChild(tag);
    host.appendChild(el);
    drawn += 1;
  }
  host.hidden = !drawn;
}

/** Своё выделение и доска — другим участникам; реплика сама режет частоту до 10/с. */
function sharePresence() {
  if (!server || !server.sync) return;
  /* Круг 25, п.8 (SPEC §9.9): агент работает над командой этого человека — busy, команда
     ждёт очереди проекта — queued (номер в очереди). Другие видят «Аня ждёт агента…». */
  const a = state.agentPresence || null;
  const p = { selection: state.selection, board: activeArtboardId() };
  p.busy = !!(a && a.busy);
  p.queued = a && a.queued ? a.queued : false;
  server.sync.presence(p);
}

/** Агент взялся за свою команду / встал в очередь / закончил — присутствие вслед. */
function setAgentPresence(next) {
  const was = JSON.stringify(state.agentPresence || null);
  state.agentPresence = next || null;
  if (JSON.stringify(state.agentPresence) !== was) sharePresence();
}

/* ------------------------------ агент на сервере ------------------------------ */
/*
 * Круг 23 (SPEC §10). Когда проект открыт через Document service и Orchestrator отвечает
 * на `/agent/health`, команда агента уходит на сервер: стадии приходят потоком в ту же
 * ленту, команды оболочки исполняются здесь же, варианты — в той же панели, а транзакция
 * агента приходит по сокету Hub как любая чужая — второй раз её не применяем. Без сервера
 * (артефакт, локальная сборка) и когда Orchestrator молчит — прежний путь: brain здесь.
 */
const agentClient = AGENT.createAgentClient({
  author: () => settings.author || '',
  // круг 33 (ORCH): stop и apply — от той же вкладки, что дала команду (client реплики)
  client: () => (server && server.sync ? server.sync.clientId : ''),
});
const AGENT_PROBE_MS = 30000;
const AGENT_PROBE_MIN_MS = 10000;   // чаще не спрашиваем: статус реплики меняется на каждой правке
const AGENT_RESTART_PROBE_MS = 1500;   // круг 33: пока сервер агента перезапускается
const serverAgent = {
  health: null,        // последний ответ /agent/health (или {ok:false})
  probing: null,
  timer: null,
  mode: 'browser',     // server | browser | off — что показано в строке состояния
  awaiting: new Map(), // tx_id → {label, human, select}: итог пришёл, транзакция ещё нет
  arrived: new Map(),  // tx_id → {tx, prevDoc, diff}: транзакция пришла раньше итога
  detached: null,      // {utterance, at}: поток оборвался, итог придёт по синхронизации
  current: null,       // {commandId, utterance, at}: команда, которая идёт на сервере сейчас
  stopped: new Map(),  // command_id → {utterance, at, txId}: «стоп» нажат — запись могла успеть
  lost: new Map(),     // command_id → {utterance, lostAt}: сказано «не выполнена» (круг 25, п.3)
  probedAt: 0,
  absent: false,       // /agent/ на этом сервере нет вовсе (Document service со STATIC_DIR)
  healthFailedAt: 0,   // когда /agent/health в последний раз не ответил (перезапуск — по смене instance, круг 26)
  lastFailed: null,    // {utterance, variants}: команда, которой помешал сбой агента или модели
  watch: null,         // таймер: пока висит карточка «модель/агент не отвечает», спрашиваем health
  queuedAhead: [],     // имена из присутствия, чьи команды впереди в очереди проекта
};
const AGENT_ARRIVED_MAX = 6;
/* Сколько ждём транзакцию остановленной команды: Orchestrator доводит уже начатую запись
   (повтор по tx_id), и она приходит по сокету позже «стопа». Дальше — не наша. */
const AGENT_STOPPED_MS = 3 * 60 * 1000;
const AGENT_STOPPED_MAX = 4;

/** Работает ли сейчас агент на сервере. */
function agentOnServer() {
  return agentMode() === 'server';
}

function agentMode() {
  /* Круг 25 (п.2, ревью Д5). Режим решает /agent/health: сокет Document service тут ни при
     чём — пока Hub переподключается или реплика открывает другой проект, Orchestrator жив и
     читает документ сам. Проект «открыт», как только выбран: переходное «открываю проект…»
     режим не меняет и ложного «сервер агента недоступен» не даёт. */
  return decideAgentMode({
    // круг 31: в серверном режиме агент — сервер и до того, как открылся проект (список не пришёл)
    inProject: !!server,
    health: serverAgent.health,
    hasProvider: !!state.provider,
  });
}

/** Можно ли отправить команду агенту — здесь или на сервере. */
function agentReady() {
  return !!state.provider || agentOnServer();
}

/**
 * Принимает ли строка команду. В серверном режиме — всегда: даже когда агент недоступен,
 * команда не пропадает молча, а получает ответ «сервер агента не отвечает» с «Повторить»
 * (круг 25, п.1), и перед этим Orchestrator спрашивается ещё раз.
 */
function commandReady() {
  // круг 39: серверный режим ожидается (ждём /api/health) — команда тоже получит честный ответ
  return agentReady() || !!server || serverBooting;
}

/**
 * Спросить Orchestrator, жив ли он. Только в серверном режиме: артефакт сюда не ходит.
 * Без force — не чаще раза в 10 с. Ответ 404 значит, что агента за этим сервером нет
 * совсем (Document service сам раздаёт клиент, без NGINX): больше не спрашиваем.
 */
function probeAgent({ force = false } = {}) {
  if (!server || serverAgent.absent) return Promise.resolve(null);
  if (serverAgent.probing) return serverAgent.probing;
  if (!force && Date.now() - serverAgent.probedAt < AGENT_PROBE_MIN_MS) return Promise.resolve(serverAgent.health);
  serverAgent.probedAt = Date.now();
  const prev = serverAgent.health;
  serverAgent.probing = agentClient.health().then((h) => {
    // круг 41: health не дошёл, а у браузера нет сети — причина «нет сети», не «сервер не отвечает»
    if (h && !h.ok && (h.reason === 'network' || h.reason === 'timeout') && browserOffline()) h = { ...h, reason: 'offline' };
    serverAgent.health = h;
    if (h && !h.ok && h.status === 404) {
      serverAgent.absent = true;
      if (serverAgent.timer) { clearInterval(serverAgent.timer); serverAgent.timer = null; }
    }
    if (h && !h.ok) serverAgent.healthFailedAt = Date.now();
    return h;
  }).catch(() => {
    // круг 41: нет сети у самого компьютера — другая причина и другие слова
    serverAgent.health = { ok: false, reason: browserOffline() ? 'offline' : 'network' };
    serverAgent.healthFailedAt = Date.now();
    return serverAgent.health;
  }).finally(() => {
    serverAgent.probing = null;
    agentModeChanged();
    onAgentHealthChanged(prev, serverAgent.health);
    armDocProbe();
  });
  if (!serverAgent.timer && !serverAgent.absent) {
    serverAgent.timer = setInterval(() => { if (server && !state.busy) probeAgent(); }, AGENT_PROBE_MS);
  }
  return serverAgent.probing;
}

/**
 * Orchestrator не принял команду из-за сбоя связи: до следующей проверки он «недоступен».
 * Тоста нет — о сбое уже говорит карточка команды; следующая проверка health скажет, когда
 * он вернётся.
 */
function browserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function markAgentDown() {
  serverAgent.health = { ok: false, reason: browserOffline() ? 'offline' : 'network' };
  serverAgent.healthFailedAt = Date.now();
  agentModeChanged();
}

/** Режим агента мог смениться: строка состояния, знак агента и кнопки — заново. Без слов. */
function agentModeChanged() {
  serverAgent.mode = agentMode();
  renderAgentStatus();
  if (dom['btn-run']) setRunnable(!!state.provider);
}

/**
 * Ответ /agent/health изменился (круг 25, п.2 и п.7). Говорим об этом только здесь — по
 * ответу health, с именем того сервиса, что лежит, — а не по переходам реплики (смена
 * проекта, переподключение Hub). Красная карточка «модель не отвечает» уходит сама, когда
 * модель вернулась: висящая ошибка о том, чего уже нет, — неправда.
 */
/* Круг 34: тост здоровья агента («Сервер агента не видит документ — …») держался свои 6 с
   и после того, как карточка сменилась на «Документ снова доступен агенту»: на экране разом
   «не видит» и «снова доступен». Тост здоровья один: новый снимает прежний, а возвращение
   сервиса (карточка «снова …») снимает и его. */
let healthToast = null;
function dropHealthToast() {
  if (healthToast) healthToast.remove();
  healthToast = null;
}

function onAgentHealthChanged(prev, next) {
  if (!server) return;
  const words = agentHealthNotice(prev, next, { hasProvider: !!state.provider, editsWait: !syncHealthy() });
  const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
  const back = next && next.ok === true && next.document === 'up' && next.llm === 'up';
  /* Круг 27, I6: перезапуск кончился, когда ответил уже другой процесс (instance сменился)
     или сервер агента пропадал и вернулся; прежний процесс, который ещё дописывает начатое,
     «снова на связи» не значит. */
  const failed = serverAgent.lastFailed;
  const restarted = role === 'agent-restart' && back
    && (!failed || !failed.instance || !next.instance || next.instance !== failed.instance
      // «недоступен» по своей отметке о перезапуске (круг 33) — не доказательство: ждём другой процесс
      || (prev && prev.ok !== true && prev.reason !== 'restarting'));
  /* Круг 29 (J4, п.7): «Документ снова доступен агенту» — только когда и наша реплика
     видит сервер живым: при недоступном хранилище или сервере такая карточка рядом со
     статусом «сервер не может сохранить» / «сервер недоступен» — неправда. Подождём:
     onSyncStatus покажет её, когда реплика снова сохраняет. */
  if (back && role === 'doc-down' && !syncHealthy()) return;
  if (back && (role === 'model-down' || role === 'agent-down' || role === 'doc-down' || restarted)) {
    retryHold = null;   // сервис вернулся раньше срока — повтор можно сразу
    dropHealthToast();  // «не видит документ» рядом с «снова доступен» — неправда (круг 34)
    const again = serverAgent.lastFailed;
    const rest = again && Array.isArray(again.rest) ? again.rest : [];
    const head = role === 'model-down' ? 'Модель на сервере снова отвечает'
      : role === 'doc-down' ? 'Документ снова доступен агенту' : 'Сервер агента снова на связи';
    showMsg('plain', head, {
      note: again ? (rest.length
        ? `Команда «${clip(again.utterance, 60)}» и ещё ${rest.length} из очереди не выполнялись — можно повторить.`
        : `Команда «${clip(again.utterance, 60)}» не выполнялась — её можно повторить.`) : '',
      actions: again ? [{ label: 'Повторить', primary: true, onClick: () => retryFailed(again) }] : [],
      ms: again ? 0 : 6000,
      role: role === 'doc-down' ? 'doc-back' : '',
    });
    if (role === 'doc-down') serverAgent.docBack = again;
    serverAgent.lastFailed = null;
    return;
  }
  if (role === 'agent-restart') return;
  if (!words) return;
  /* Круг 39 (UX): «…снова на связи» — только после того, как о пропаже было сказано. Первые
     ответы health при открытии проекта (сервис документа ещё подключался) человек не видел —
     «снова» ему ни о чём. */
  /* Круг 43: «не видит документ» — не сразу: сервис документа перезапускается (обновление)
     секунду-другую, и тост о пропаже, за которым тут же «Сервер обновился», — шум. Сказанное
     через HEALTH_SAY_MS, если пропажа ещё в силе; вернулось раньше — молчим и о возвращении. */
  if (!words.back && next && next.ok === true && next.document !== 'up') {
    if (serverAgent.sayLater) clearTimeout(serverAgent.sayLater);
    serverAgent.sayLater = setTimeout(() => {
      serverAgent.sayLater = null;
      const h = serverAgent.health;
      if (!h || h.ok !== true || h.document === 'up') return;
      serverAgent.downSaid = true;
      sayHealth(words);
    }, HEALTH_SAY_MS);
    return;
  }
  if (words.back && serverAgent.sayLater) { clearTimeout(serverAgent.sayLater); serverAgent.sayLater = null; return; }
  if (words.back && !serverAgent.downSaid) return;
  serverAgent.downSaid = !words.back;
  /* Круг 43: о том же возвращении уже сказано (карточка «Сеть вернулась», тост «Сервер
     обновился…») — второй голос о том же не нужен. */
  if (words.back && Date.now() < (serverAgent.quietBackUntil || 0)) return;
  /* Круг 45 (UX r44): «Сервер документа снова на связи» — только когда и строка состояния это
     видит; пока реплика ещё говорит «сервер не может сохранить — правки ждут», тост подождёт её
     (onSyncStatus скажет его, как только реплика снова сохраняет). */
  if (words.back && prev && prev.ok === true && prev.document !== 'up' && !syncHealthy()) { serverAgent.backLater = words; return; }
  // о возвращении тостом не говорим, если и о пропаже не говорили бы: смена проекта, первый ответ
  sayHealth(words);
}

const HEALTH_SAY_MS = 2500;
function sayHealth(words) {
  dropHealthToast();
  const t = toast(words.text, words.kind, 6000);
  healthToast = t;
  setTimeout(() => { if (healthToast === t) healthToast = null; }, 6000);
}

/** Ошибка «документ недоступен агенту» с причиной: база данных (K2) — из ошибки, health или реплики. */
function docDownWhy(e) {
  if (!e || (e.code !== 'document_down' && e.code !== 'document_failed') || SHELL.storageReason(e)) return e;
  const h = serverAgent.health;
  const storage = (h && SHELL.storageReason(h)) || !!(server && server.status && server.status.storage === 'down');
  if (!storage) return e;
  // круг 32: health Orchestrator говорит 'schema' — база догоняет схему: «Сервер обновляет базу данных»
  const why = h && SHELL.schemaReason(h) ? 'schema' : 'storage';
  return { code: e.code, message: e.message, retryable: e.retryable, retryAfterMs: e.retryAfterMs, detail: e.detail, document_reason: why };
}

/** «агент: сервер» / «агент: в браузере» / «агент недоступен» — рядом с синхронизацией. */
function renderAgentStatus() {
  const host = dom['agent-status'];
  if (!host) return;
  if (!server) { host.hidden = true; return; }
  /* Круг 39 (N6а): «агент недоступен» — только по ответу /agent/health. Пока его нет (первая
     проверка в пути), знака нет вовсе: про подключение уже говорит строка синхронизации. */
  if (!serverAgent.health && !state.provider) { host.hidden = true; return; }
  /* Круг 41 (UX Д7): версии разошлись — команды агента не выполняются (engineCommandMsg),
     зелёное «агент: сервер» было бы неправдой. */
  if (engineHalted()) {
    const s = server.status || {};
    const older = !engineWords(s.engine, s.ownEngine || CORE.ENGINE_VERSION).newer;
    host.hidden = false;
    host.dataset.state = 'off';
    host.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'sync-dot';
    dot.dataset.state = 'error';
    const label = document.createElement('span');
    label.className = 'sync-text';
    label.textContent = AGENT_MODE_WORDS.off;
    host.append(dot, label);
    const why = older ? 'Сервер документов ещё на прежней версии — команды агента подождут его обновления' : 'Вышла новая версия редактора — обновите страницу';
    host.title = why;
    host.setAttribute('aria-label', `${AGENT_MODE_WORDS.off}. ${why}`);
    return;
  }
  const mode = agentMode();
  // круг 45: сервер агента без документа или модели — жёлтый знак с причиной (SHELL.agentBadge)
  const badge = SHELL.agentBadge(mode, serverAgent.health);
  const words = badge.words;
  const title = agentModeTitle(mode, serverAgent.health, AGENT_KIND_WORDS[state.providerKind] || '');
  host.hidden = false;
  host.dataset.state = mode;
  host.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'sync-dot';
  dot.dataset.state = badge.dot;
  const label = document.createElement('span');
  label.className = 'sync-text';
  label.textContent = words;
  host.append(dot, label);
  host.title = title;
  host.setAttribute('aria-label', `${words}. ${title}`);
}

/** Свои правки — сначала на сервер: агент читает стейт у DSLR и должен видеть их. */
async function settleOwnEdits(ms, signal) {
  const sync = server && server.sync;
  if (!sync) return;
  const until = Date.now() + ms;
  while (sync.pending.length && sync.status && sync.status.online && Date.now() < until) {
    if (signal && signal.aborted) return;
    await new Promise((r) => setTimeout(r, 60));
  }
}

/**
 * Команда на сервере. true — команда разобрана (успех, отказ, вопрос — всё сказано);
 * false — сервер её не принял из-за связи, и её надо выполнить в браузере.
 * Остановка пробрасывается исключением — её разбирает общий catch runUtterance.
 */
async function runOnServer(utterance, { variants, ctrl, runId }) {
  const sync = server.sync;
  await settleOwnEdits(1500, ctrl.signal);
  if (ctrl.signal.aborted) throw new AGENT.AgentError({ code: 'cancelled' });
  let out;
  const commandId = AGENT.newCommandId();
  const startedAt = Date.now();
  /* Круг 26: какой процесс Orchestrator принял команду — по /agent/health (поле instance).
     Поток оборвётся — ответ с другим instance значит, что процесс перезапустился и
     команды больше нет; тот же instance — он жив и, может быть, ещё её доделывает. */
  const instance = serverAgent.health && serverAgent.health.ok && serverAgent.health.instance ? serverAgent.health.instance : '';
  serverAgent.current = { commandId, utterance, at: startedAt, instance };
  rememberInflight({ commandId, utterance, at: startedAt });
  try {
    out = await agentClient.run({
      command_id: commandId,
      project: server.project.id,
      text: utterance,
      // память разговора — как у brain в браузере: «а теперь синее» опирается на прошлое
      history: historyForServer(state.pairs),
      selection: state.selection.slice(0, 200),
      // круг 27, I6: выделение оставил агент, и человек его не трогал — так и говорим серверу
      selection_by: state.selection.length ? (state.selectionBy === 'agent' ? 'agent' : 'human') : undefined,
      board: activeArtboardId() || undefined,
      base_seq: sync.confirmed ? sync.confirmed.seq : undefined,
      client: sync.clientId,
      author: settings.author || undefined,
      mode: variants ? 'variants' : 'run',
      n: variants ? 3 : undefined,
      // круг 50: выключенное человеком — серверу (включить выключенное у сервиса нельзя)
      art: agentArtOptions(),
      signal: ctrl.signal,
      onEvent: (ev) => onServerAgentEvent(ev, runId, variants),
    });
    if (!pageLeaving) forgetInflight(commandId);
  } catch (e) {
    // страница уходит (перезагрузка): поток оборван ею, а не сервером — отметка остаётся
    if (!pageLeaving) forgetInflight(commandId);
    if (isCancelled(e)) {
      /* Круг 27, п.2. Транзакция пришла ещё до «стопа» — noteStoppedCommand уже сказал
         «агент успел записать — можно отменить». Признак уходит в catch runUtterance:
         «Команда остановлена» с возвратом текста в строку затёрло бы эту правду. */
      if (noteStoppedCommand(commandId, utterance, { startedAt })) e.settled = true;
      throw e;
    }
    if (!e.accepted && AGENT.isUpstreamDown(e)) {
      markAgentDown();
      if (state.provider) {
        toast('Сервер агента недоступен — выполняю команду в браузере.', 'plain', 6000);
        return false;
      }
    }
    hideStage();
    restoreCommand(utterance);
    showServerAgentError(e, utterance, { variants });
    return true;
  }
  hideStage();
  if (serverAgent.current && serverAgent.current.commandId === commandId) serverAgent.current = null;
  /* Итог пришёл, но прогон тем временем остановили или заменили: запись уже сделана, и
     шаг истории для неё всё равно нужен — иначе Ctrl+Z её не отменит. */
  if (state.runSeq !== runId || ctrl.signal.aborted) {
    const r = out.result ? normalizeResult(out.result) : null;
    if (r && r.txId) noteStoppedCommand(commandId, utterance, { startedAt, txId: r.txId });
    return true;
  }

  if (out.error) {
    // сервер сам сказал «остановлена»: до записи дело не дошло, ждать транзакцию незачем
    if (isCancelled(out.error)) { restoreCommand(utterance); cancelledMsg(utterance); return true; }
    restoreCommand(utterance);
    showServerAgentError(out.error, utterance, { variants });
    return true;
  }
  if (out.shell) { applyServerShell(out.shell, utterance); return true; }
  if (out.variants) {
    const list = variantsFromServer(out.variants, { doc: state.doc, core: CORE, commandId: out.command_id });
    if (!list.length) {
      restoreCommand(utterance);
      showMsg('warn', 'Варианты ничего не меняют', {
        note: 'Попробуйте сказать конкретнее — что именно поменять.',
        actions: [retryAction(utterance)],
      });
      return true;
    }
    if (ctrl.signal.aborted) return true;
    // слияние на сервере не отказывает — отметка «документ изменился» вариантам не нужна
    showVariants(list, utterance, null);
    return true;
  }
  if (out.result) { presentServerResult(out.result, utterance); return true; }
  if (out.status === 'detached') {
    addChat('you', utterance);
    awaitDetached(commandId, utterance, { variants, startedAt, instance });
    return true;
  }
  // поток кончился штатно, а итога нет: агенту нечего было менять
  restoreCommand(utterance);
  showMsg('warn', 'Агент не нашёл, что изменить', {
    note: 'Выделите слой или скажите, что именно поправить.',
    actions: [retryAction(utterance)],
  });
  return true;
}

/* Круг 25, п.3. Поток команды оборвался. Раньше оболочка обещала «ответ придёт по
   синхронизации» и замолкала навсегда — а если Orchestrator упал, команды больше нет
   нигде. Теперь проверяем: спрашиваем /agent/health и ждём транзакцию команды (по
   command_id, без него — свою транзакцию агента) не дольше DETACHED_WAIT_MS. Пришла —
   обычный итог. Orchestrator не отвечает или ответил уже другой процесс (был недоступен,
   стал доступен) — команды нет: говорим это, возвращаем текст в строку и даём «Повторить». */
const DETACHED_WAIT_MS = 25000;
const DETACHED_PROBE_MS = 2500;
/* Orchestrator не отвечает: начатую запись мог довести Document service — ждём ещё чуть-чуть. */
const DETACHED_DOWN_GRACE_MS = 5000;
/* Команды, которые объявлены невыполненными: если транзакция всё-таки придёт — скажем. */
const DETACHED_LOST_MS = 3 * 60 * 1000;

function awaitDetached(commandId, utterance, { variants = false, startedAt = Date.now(), instance = '' } = {}) {
  endDetached();
  const d = {
    commandId, utterance, variants, startedAt, at: Date.now(), timer: null,
    downSince: 0, wasDown: false, instance,
  };
  serverAgent.detached = d;
  showMsg('plain', 'Связь с агентом прервалась — проверяю, выполнена ли команда', {
    note: `«${clip(utterance, 60)}»: если сервер агента её доделал, правка придёт сама.`,
    role: 'detached',
  });
  /* Круг 27, п.1. Транзакция команды могла прийти по сокету ДО обрыва потока — она уже
     лежит в arrived. Смотрим туда на входе и после каждой проверки: иначе новый instance
     Orchestrator объявлял команду невыполненной, а «Повторить» записывал её второй раз. */
  const arrivedNow = () => SHELL.arrivedTxOf(serverAgent.arrived, { commandId: d.commandId, startedAt: d.startedAt });
  const settle = (txId) => {
    const got = serverAgent.arrived.get(txId);
    if (!got) return false;
    serverAgent.arrived.delete(txId);
    settleDetachedTx(d, got.tx, got.prevDoc, got.diff);
    return true;
  };
  const first = SHELL.detachedVerdict(d, { health: undefined, arrivedId: arrivedNow() });
  if (first.verdict === 'arrived' && settle(first.txId)) return;
  const step = async () => {
    if (serverAgent.detached !== d) return;
    const h = await probeAgent({ force: true });
    if (serverAgent.detached !== d) return;
    /* Сокет документа тоже лёг — значит, пропала связь (сеть, вход), а не Orchestrator: он,
       может быть, доделывает команду, и транзакция придёт с догоном. Ждём полный срок. */
    const netDown = !(server && server.status && server.status.online);
    const v = SHELL.detachedVerdict(d, {
      health: h || null, netDown, now: Date.now(), arrivedId: arrivedNow(),
      times: { waitMs: DETACHED_WAIT_MS, probeMs: DETACHED_PROBE_MS, downGraceMs: DETACHED_DOWN_GRACE_MS },
    });
    if (v.verdict === 'arrived' && settle(v.txId)) return;
    if (v.verdict === 'lost') { lostDetached(d, v.why); return; }
    d.timer = setTimeout(step, DETACHED_PROBE_MS);
  };
  d.timer = setTimeout(step, 400);
}

function endDetached() {
  const d = serverAgent.detached;
  if (d && d.timer) clearTimeout(d.timer);
  serverAgent.detached = null;
  return d;
}

/** Поток оборвался, а транзакция команды пришла синхронизацией: о ней и говорим. */
function settleDetachedTx(d, tx, prevDoc, diff) {
  if (serverAgent.detached === d) endDetached();
  const human = tx.title || 'Готово';
  // текст мог вернуться в строку — команда выполнена, второй раз её не шлём
  if (dom.command && dom.command.value.trim() === String(d.utterance || '').trim()) dom.command.value = '';
  addChat('agent', human);
  rememberPair(d.utterance, human);
  showMsg('result', human, {
    note: 'Агент закончил на сервере — правка пришла синхронизацией.',
    actions: [{ label: 'Отменить', onClick: () => undoTx(tx.tx_id) }],
    undoTx: tx.tx_id,
  });
  settleAgentTx(tx, prevDoc, diff, { label: d.utterance, human, select: [] });
}

/** Транзакция команды так и не пришла: команды нет — сказать, вернуть текст, дать повторить. */
function lostDetached(d, why) {
  endDetached();
  serverAgent.lost.set(d.commandId, { ...d, lostAt: Date.now() });
  for (const [id, x] of serverAgent.lost) if (Date.now() - x.lostAt > DETACHED_LOST_MS) serverAgent.lost.delete(id);
  const words = detachedLostWords(d.utterance, why === 'silent' ? 'silent' : why);
  restoreCommand(d.utterance);
  addChat('agent', words.title);
  serverAgent.lastFailed = { utterance: d.utterance, variants: d.variants };
  showMsg('error', words.title, {
    note: words.note,
    role: why === 'down' ? 'agent-down' : 'detached-lost',
    actions: [{ label: 'Повторить', primary: true, onClick: () => retryAfterProbe(d.utterance, { variants: d.variants }) }],
  });
  if (why === 'down') watchAgentHealth();
}

/** События потока §10.3 — в ту же ленту стадий, что у brain. */
function onServerAgentEvent(ev, runId, variants) {
  if (!ev || runId !== state.runSeq) return;
  if (ev.type === 'queued') {
    /* чья команда впереди — по присутствию, и только в очереди проекта; `workers` (круг 27) и
       `read` (круг 39: полное чтение ждёт семафора агента) — очереди агента, не проекта */
    const rec = SHELL.queuedStage(ev.data, server ? server.others : []);
    setAgentPresence({ queued: rec.position > 0 ? rec.position : true });
    onAgentStage({ stage: rec.stage, label: rec.label }, 0, runId);
  } else if (ev.type === 'stage') {
    setAgentPresence({ busy: true });
    onAgentStage(serverStageRec(ev.data), variants ? 3 : 0, runId);
  } else if (ev.type === 'retry') {
    onAgentStage({ stage: 'srv:retry', label: retryLabel(ev.data && ev.data.wait_ms, ev.data && ev.data.code, docDownWhy({ ...(ev.data || {}) })) }, 0, runId);
  }
}

/**
 * Сервер агента не отвечает, а своей модели у браузера нет (круг 25, п.1): команда не
 * выполнена и не потеряна — текст остаётся в строке, «Повторить» спрашивает Orchestrator
 * заново. «Выполнить в браузере» здесь нет: выполнять нечем.
 */
/** Браузер говорит, что сети нет (navigator.onLine). */
function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Команда не ушла: нет сети. Сеть вернётся — карточка сменится на «Повторить» (onNetworkBack). */
function offlineMsg(utterance, { variants = false } = {}) {
  restoreCommand(utterance);
  serverAgent.lastFailed = { utterance, variants };
  const w = SHELL.OFFLINE_WORDS;
  showMsg('error', w.title, { note: w.note, role: 'offline' });
}

/** Сеть вернулась: висящее «нет сети» — неправда; команду, которой она помешала, можно повторить. */
function onNetworkBack() {
  const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
  if (role !== 'offline') return;
  const again = serverAgent.lastFailed;
  serverAgent.lastFailed = null;
  // круг 43: о возврате сети — один раз: тост «Сеть вернулась — агент снова на связи» после этой карточки не нужен
  serverAgent.quietBackUntil = Date.now() + 15000;
  showMsg('plain', 'Сеть вернулась', {
    note: again ? `Команда «${clip(again.utterance, 60)}» не выполнялась — можно повторить.` : '',
    actions: again ? [{ label: 'Повторить', primary: true, onClick: () => retryFailed(again) }] : [],
    ms: again ? 0 : 5000,
  });
  if (server) probeAgent({ force: true });
}

function agentDownMsg(utterance, { variants = false } = {}) {
  if (isOffline()) { offlineMsg(utterance, { variants }); return; }
  /* Круг 27, п.9. Агента за этим сервером нет вовсе (Document service сам раздаёт клиент,
     /agent/ — 404): ждать нечего, «Повторить» не поможет — поможет своя модель в браузере. */
  if (serverAgent.absent) {
    restoreCommand(utterance);
    showMsg('warn', 'Агента на этом сервере нет — команда не отправлена', {
      note: 'Включите модель в браузере: шестерёнка → «Агент» → LM Studio. Текст остался в строке.',
      actions: [{ label: 'Настройки', primary: true, onClick: () => openSettings() }],
    });
    return;
  }
  restoreCommand(utterance);
  serverAgent.lastFailed = { utterance, variants };
  showMsg('error', AGENT_DOWN_WORDS.title, {
    note: AGENT_DOWN_WORDS.note,
    role: 'agent-down',
    actions: [{ label: 'Повторить', primary: true, onClick: () => retryAfterProbe(utterance, { variants }) }],
  });
  watchAgentHealth();
}

/* Круг 29, п.7: «Повторить через 8 с» выключена до срока — но текст команды вернулся в
   строку, и Enter отправлял его сразу, мимо отсчёта, получая тот же отказ. До срока та же
   команда из строки не уходит: человеку сказано, сколько ждать. */
let retryHold = null;   // {utterance, until}
function holdRetry(utterance, waitMs) {
  retryHold = waitMs > 0 ? { utterance: String(utterance || '').trim(), until: Date.now() + waitMs } : null;
}
/** true — команда придержана (сказано, сколько ждать). */
function retryHeld(utterance) {
  if (!retryHold) return false;
  const left = retryHold.until - Date.now();
  if (left <= 0) { retryHold = null; return false; }
  if (retryHold.utterance !== String(utterance || '').trim()) return false;
  toast(`Повторить можно через ${Math.ceil(left / 1000)} с — сервер попросил подождать.`, 'plain', 4000);
  return true;
}

/** «Повторить» после сбоя агента: строка уже держит текст — её и отправляем. */
function retryAfterProbe(utterance, { variants = false } = {}) {
  if (dom.command.value.trim() === String(utterance || '').trim()) dom.command.value = '';
  runUtterance(utterance, { variants });
}

/**
 * Пока на экране «модель/агент не отвечает», спрашиваем /agent/health чаще обычного — раз
 * в 10 с: карточка должна уйти, как только связь вернулась (п.7), а не через полминуты.
 */
/* Круг 43: пока документ «лежит» — по реплике (хранилище, связь при живой сети) или по ответу
   health агента (document: down), — health агента спрашиваем раз в AGENT_DOWN_PROBE_MS, а не
   плановой проверкой раз в 30 с: знак «Сервер агента не видит документ» приходит за секунды.
   В норме лишних запросов нет. */
const AGENT_DOWN_PROBE_MS = 4000;
function docTrouble() {
  if (!server || serverAgent.absent || engineHalted()) return false;
  const s = server.status || {};
  const h = serverAgent.health;
  const syncDown = s.storage === 'down' || (!s.online && !s.connecting && !browserOffline() && !!(server.sync && server.sync.view));
  const agentNoDoc = !!(h && h.ok === true && h.document !== 'up');
  return syncDown || agentNoDoc;
}
function armDocProbe() {
  if (serverAgent.docProbe || !docTrouble()) return;
  serverAgent.docProbe = setTimeout(() => {
    serverAgent.docProbe = null;
    if (!docTrouble()) return;
    probeAgent({ force: true }).finally(() => armDocProbe());
  }, AGENT_DOWN_PROBE_MS);
}

function watchAgentHealth() {
  if (serverAgent.watch) return;
  /* Круг 33 (u10b): перезапуск сервера агента — секунды; проверяем раз в 1,5 с, чтобы знак
     агента у всех участников сменился почти разом, а не с разницей до 10 с. */
  const next = () => {
    const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
    return role === 'agent-restart' ? AGENT_RESTART_PROBE_MS : AGENT_PROBE_MIN_MS;
  };
  const beat = () => {
    const role = dom.dockmsg && !dom.dockmsg.hidden ? dom.dockmsg.dataset.role : '';
    if (!server || !['model-down', 'agent-down', 'agent-restart', 'doc-down'].includes(role)) {
      serverAgent.watch = null;
      return;
    }
    probeAgent({ force: true });
    serverAgent.watch = setTimeout(beat, next());
  };
  serverAgent.watch = setTimeout(beat, next());
}

/** Отказ сервера агента — тем же доком, что отказ модели в браузере. */
function showServerAgentError(e, utterance, { variants = false } = {}) {
  if (e && e.code === 'shutting_down') { shuttingDownMsg(e, utterance, { variants }); return; }
  /* Круг 29: агент не нашёл проект — он пропал с сервера (реплика узнает чуть позже).
     Не «откройте заново», а путь к работе: сохранить её новым проектом. */
  if (e && e.code === 'not_found' && (!e.message || /проект/i.test(e.message))
    && server && server.sync && server.sync.view && SHELL.userNodeCount(server.sync.view) > 0) {
    const w = agentErrorWords(e);
    restoreCommand(utterance);
    server.goneShown = true;
    showMsg('error', w.title, {
      note: w.note,
      role: 'project-gone',
      actions: [
        { label: SHELL.PROJECT_GONE_WORDS.action, primary: true, onClick: () => saveAsNewProject() },
        { label: 'Проекты', onClick: () => openProjects() },
      ],
    });
    return;
  }
  // связь пропала у самого компьютера, а не у сервера агента (круг 27, п.7)
  if (e && (e.code === 'network' || AGENT.isUpstreamDown(e)) && isOffline()) { offlineMsg(utterance, { variants }); return; }
  /* Круг 41: Orchestrator сверил версию движка вкладки (426 engine). Те же слова и поведение,
     что у отказа по версии от сервиса документов: без «Повторить» — повтор ничего не изменит;
     вкладка старее — «Обновить страницу». */
  const cause = AGENT.engineCause(e);
  if (cause) {
    const w = agentErrorWords(e);
    restoreCommand(utterance);
    /* Круг 43: сервер документов ещё не обновился («устаревший» проект) — повтор имеет смысл
       позже: «Повторить» по сроку Retry-After. Остальное (вкладка или сервер агента старее) —
       без повтора: сейчас он ничего не изменит. */
    const actions = cause === 'client_old' ? [{ label: 'Обновить страницу', primary: true, onClick: () => location.reload() }]
      : cause === 'document_old' ? [{ label: 'Повторить', primary: true, waitMs: w.waitMs, onClick: () => retryAfterProbe(utterance, { variants }) }]
        : [];
    if (cause === 'document_old') holdRetry(utterance, w.waitMs);
    showMsg(cause === 'client_old' ? 'error' : 'warn', w.title, { note: w.note, role: 'engine', actions });
    return;
  }
  /* K2 (круг 31): документ не виден агенту из-за базы данных — это знает ошибка, health
     Orchestrator или своя реплика («сервер не может сохранить»). */
  const words = agentErrorWords(docDownWhy(e));
  const actions = [];
  const modelDown = isModelError(e) && e.code === 'llm_down';
  const agentDown = AGENT.isUpstreamDown(e) || e.code === 'network';
  if (e.retryable !== false) {
    /* Предохранитель модели (Retry-After): повтор раньше срока заведомо получит тот же
       отказ — кнопка выключена и считает секунды до срока (п.7). */
    actions.push({
      label: 'Повторить', primary: true, waitMs: words.waitMs,
      onClick: () => retryAfterProbe(utterance, { variants }),
      // срок вышел — спросим, вернулась ли модель: карточка уйдёт сама, если да
      onReady: () => { if (server) probeAgent({ force: true }); },
    });
  }
  // модель серверу не отвечает, а у браузера есть своя (её включил человек) — выполнить можно здесь
  if (state.provider && (isModelError(e) || e.code === 'document_down' || agentDown)) {
    actions.push({ label: 'Выполнить в браузере', onClick: () => runUtterance(utterance, { variants, local: true }) });
  }
  // круг 27, п.7: документ у сервера пропал — карточка уйдёт сама, когда он вернётся
  const docDown = e.code === 'document_down' || e.code === 'document_failed';
  const role = modelDown ? 'model-down' : agentDown ? 'agent-down' : docDown ? 'doc-down' : '';
  if (role) serverAgent.lastFailed = { utterance, variants };
  holdRetry(utterance, e.retryable !== false ? words.waitMs : 0);
  // «Подробности» с одной строкой «причина: …», повторяющей заголовок, — шум (круг 29, п.7)
  let details = techDetails(null, e);
  if (details === `причина: ${SHELL.errorCodeWords(e.code)}` && words.title.toLowerCase().startsWith(SHELL.errorCodeWords(e.code))) details = '';
  showMsg('error', words.title, {
    note: words.note,
    details,
    actions,
    role,
  });
  if (role) watchAgentHealth();
}

/**
 * Круг 27, I6. Orchestrator останавливается (`shutting_down`): идущая команда и ждавшие в
 * его очереди не выполнены — это не «остановлена». Очередь вкладки в умирающий процесс не
 * отправляем: она ждёт вместе с текущей, «Повторить» выполнит все по порядку. Карточка
 * сменится на «снова на связи», когда ответит новый процесс.
 */
function shuttingDownMsg(e, utterance, { variants = false } = {}) {
  const rest = [...state.queue, chainRun].filter((r) => r && r.text).map((r) => ({ text: r.text, variants: !!r.variants }));
  state.queue = [];
  chainRun = null;
  const words = SHELL.shuttingDownWords(rest.map((r) => r.text));
  const instance = (serverAgent.current && serverAgent.current.instance)
    || (serverAgent.health && serverAgent.health.instance) || '';
  const failed = { utterance, variants, rest, instance };
  serverAgent.lastFailed = failed;
  /* Круг 33 (u10b): сервер агента сам сказал «перезапускаюсь» — знак агента у всех участников
     один и тот же («агент недоступен»), а не «сервер» у того, кто давно не спрашивал health, и
     «недоступен» у того, кто спросил в паузе. Вернётся — частая проверка ниже скажет всем. */
  serverAgent.health = { ok: false, reason: 'restarting', ...(instance ? { instance } : {}) };
  serverAgent.healthFailedAt = Date.now();
  agentModeChanged();
  // в строке мог остаться текст команды из очереди — она теперь в «Повторить», строке нужна текущая
  if (dom.command && rest.some((r) => r.text.trim() === dom.command.value.trim())) dom.command.value = '';
  restoreCommand(utterance);
  addChat('agent', words.title);
  const waitMs = Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? Math.min(e.retryAfterMs, 15000) : 0;
  holdRetry(utterance, waitMs);
  showMsg('error', words.title, {
    note: words.note,
    role: 'agent-restart',
    actions: [{
      label: 'Повторить', primary: true, waitMs,
      onClick: () => retryFailed(failed),
      onReady: () => { if (server) probeAgent({ force: true }); },
    }],
  });
  watchAgentHealth();
}

/** «Повторить» после сбоя агента: сама команда, а за ней — что стояло в очереди вкладки. */
function retryFailed(failed) {
  if (!failed) return;
  if (serverAgent.lastFailed === failed) serverAgent.lastFailed = null;
  for (const r of failed.rest || []) enqueueRun(r, { silent: true });
  retryAfterProbe(failed.utterance, { variants: failed.variants });
}

/**
 * Событие `shell` от сервера прежней версии (до круга 38 он сам узнавал команды оболочки):
 * исполняем здесь тем же кодом, что исполняет таблица команд оболочки. Модель не звалась,
 * документ не менялся. Новый сервер такого события не шлёт — оболочка его и не ждёт.
 */
function applyServerShell(shell, utterance) {
  const intent = shellIntentFromServer(shell);
  if (intent && intent.kind === 'stop') {
    showMsg('plain', 'Агент сейчас ничего не делает.', { ms: 5000 });
    return;
  }
  if (intent && intent.kind === 'variants') {
    const src = intent.of || lastHumanUtterance(utterance);
    if (src) {
      addChat('you', utterance);
      chainAfterRun(src, { variants: true, note: `Считаю варианты к «${clip(src, 60)}»` });
    } else askVariants({ variantsSubject: intent.subject || '' }, utterance);
    return;
  }
  if (intent && applyShellIntent(intent, utterance)) return;
  // сервер знает слово, которого не знает этот клиент: пробуем свою таблицу
  const local = shellIntent(utterance);
  if (local && applyShellIntent(local, utterance)) return;
  showMsg('plain', 'Эту команду оболочки клиент пока не умеет', {
    note: `Сервер узнал «${clip(String(shell && shell.action || ''), 30)}». Обновите страницу — версия клиента могла устареть.`,
    ms: 8000,
  });
}

/**
 * Итог команды на сервере (§10.3 `result`): транзакция уже записана и придёт по сокету.
 * Здесь — только слова, выделение и шаг в истории, когда транзакция до нас доберётся.
 */
function presentServerResult(raw, utterance, { variant = null } = {}) {
  const r = normalizeResult(raw);
  const res = raw && typeof raw === 'object' ? raw : {};
  if (!r.txId || (!r.applied && !r.droppedCount)) {
    // записывать было нечего: переспрос, ответ или «так нельзя» — те же карточки, что у brain
    if (res.clarify) { showClarify(res, utterance); return; }
    if (res.cannot) { showCannot(res, utterance); return; }
    if (res.answer) { showAnswer({ answer: String(res.answer), followups: res.followups }, utterance); return; }
    addChat('you', utterance);
    /* K3 (круг 31): модель ответила пустым патчем — не ошибка и не «Готово»: агент не нашёл,
       что менять. Команда — в строке, чтобы её можно было уточнить. */
    const nothingFound = /^Агент не нашёл, что (поменять|изменить)/.test(r.summary || '');
    if (res.nothingChanged === true || res.nothingToChange === true || nothingFound) {
      restoreCommand(utterance, { focus: true });
      const said = r.summary && !nothingFound && !/^(ничего|нечего)/i.test(r.summary) ? r.summary : '';
      addChat('agent', 'Агент не нашёл, что поменять', [], said);
      showMsg('warn', 'Агент не нашёл, что поменять', {
        note: [said, 'Скажите точнее, что и где поправить, — или выделите слой и повторите.'].filter(Boolean).join(' · '),
        details: techDetails(r.warnings),
      });
      return;
    }
    if (r.summary) {
      addChat('agent', r.summary);
      rememberPair(utterance, r.summary);
      showMsg('answer', r.summary, { note: warnLine(r.warnings), details: techDetails(r.warnings) });
    } else {
      restoreCommand(utterance, { focus: true });
      addChat('agent', 'Ничего не изменилось', [], warnLine(r.warnings));
      showMsg('warn', 'Ничего не изменилось', {
        note: warnLine(r.warnings) || 'Скажите точнее, что и где поправить.',
        details: techDetails(r.warnings),
      });
    }
    return;
  }
  /* Круг 25, п.5: агент записал транзакцию, но ни одна операция не легла — это не «Готово»:
     говорим, что не применилось и кто помешал, отменять нечего. */
  if (!r.applied && r.droppedCount) {
    const w = droppedMsgOf(r.dropped, { applied: 0, agent: true });
    if (!variant) addChat('you', utterance);
    addChat('agent', w.title, [], w.note);
    rememberPair(utterance, w.title);
    restoreCommand(utterance);
    showMsg('warn', w.title, { note: w.note, role: 'dropped', actions: [retryAction(utterance)] });
    return;
  }
  /* Круг 39 (N6б): заголовок итога — что сделано (`result.title`, слова по операциям), а не
     пересказ плана, написанный до работы («Ставлю стиль h1.»). Слова модели — второй строкой. */
  const { headline, aside } = SHELL.agentHeadline({ title: r.title, summary: r.summary, plan: r.plan, variant });
  const partly = typeof res.cannot === 'string' ? res.cannot.trim() : '';
  const followups = Array.isArray(res.followups) ? res.followups.slice(0, 3).map(String) : [];
  const label = variant ? `${utterance} · ${variant.label || 'вариант'}` : utterance;
  const art = SHELL.artSummary(res.direction, res.critique, { blocked: !!issueLine(r.warnings) });
  rememberPair(utterance, headline);
  if (!variant) addChat('you', utterance);
  addChat('agent', headline, followups, aside);
  if (art) addChat('agent', art.line);
  state.awaitingClarify = null;
  // часть просьбы невыполнима — говорим вместе с тем, что сделано (как у brain, п.19)
  if (partly) addChat('agent', partly);
  const issue = issueLine(r.warnings);
  // круг 25, п.5: что из правки агента не легло и кто помешал — конкретно
  const dropped = r.dropped.length ? droppedMsgOf(r.dropped, { applied: r.applied, agent: true }).title : '';
  if (issue) addChat('agent', issue);
  showMsg(issue ? 'warn' : 'result', headline, {
    issue,
    art,
    note: [partly, aside, dropped, warnLine(r.warnings, { skipLayout: true })].filter(Boolean).join(' · '),
    details: techDetails(r.warnings),
    chips: followups.map((f) => ({ text: f, onClick: () => { dom.command.value = f; dom.command.focus(); } })),
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.txId) }],
    undoTx: r.txId,
  });
  // в «Историю» — что сделано (result.title = tx.title, круг 27), а не пересказ модели;
  // сервер прежней версии title не шлёт — тогда settleAgentTx берёт tx.title записи
  const wait = { label, human: r.title, select: r.select };
  const got = serverAgent.arrived.get(r.txId);
  if (got) {
    serverAgent.arrived.delete(r.txId);
    settleAgentTx(got.tx, got.prevDoc, got.diff, wait);
  } else {
    serverAgent.awaiting.set(r.txId, wait);
  }
}

/**
 * Транзакция агента пришла по сокету (она уже на холсте — её применила реплика). Своя
 * команда — шаг в истории с инверсией от вида до неё (отмена — новой транзакцией, §8.3)
 * и выделение того, что агент сделал. Чужой агент — только рамки, как чужая правка.
 */
function onAgentTx(tx, prevDoc, diff, mine) {
  if (!tx || !tx.tx_id) return;
  const wait = serverAgent.awaiting.get(tx.tx_id);
  if (wait) {
    serverAgent.awaiting.delete(tx.tx_id);
    settleAgentTx(tx, prevDoc, diff, wait);
    return;
  }
  const stopped = stoppedCommandFor(tx, mine);
  if (stopped) { settleStoppedTx(stopped, tx, prevDoc, diff); return; }
  // команда, о которой уже сказано «не выполнена», всё-таки записана: говорим правду
  const late = tx.command_id ? serverAgent.lost.get(tx.command_id) : null;
  if (late) {
    serverAgent.lost.delete(tx.command_id);
    const human = tx.title || 'Готово';
    if (dom.command && dom.command.value.trim() === String(late.utterance || '').trim()) dom.command.value = '';
    addChat('agent', `Агент всё-таки выполнил «${clip(late.utterance, 60)}»: ${human}`);
    rememberPair(late.utterance, human);
    showMsg('result', `Агент всё-таки выполнил команду: ${human}`, {
      note: `«${clip(late.utterance, 60)}» — повторять не нужно.`,
      actions: [{ label: 'Отменить', onClick: () => undoTx(tx.tx_id) }],
      undoTx: tx.tx_id,
    });
    settleAgentTx(tx, prevDoc, diff, { label: late.utterance, human, select: [] });
    return;
  }
  const det = serverAgent.detached;
  if (det && (tx.command_id ? tx.command_id === det.commandId : mine)) {
    settleDetachedTx(det, tx, prevDoc, diff);
    return;
  }
  // круг 29 (UX Д2): своя правка агента по команде, начатой до перезагрузки этой вкладки
  const pre = mine ? inflightBefore(tx) : null;
  if (pre) { settlePreReloadTx(pre, tx, prevDoc, diff); return; }
  serverAgent.arrived.set(tx.tx_id, { tx, prevDoc, diff, mine: !!mine, at: Date.now() });
  while (serverAgent.arrived.size > AGENT_ARRIVED_MAX) {
    serverAgent.arrived.delete(serverAgent.arrived.keys().next().value);
  }
}

/* ---------- круг 29 (UX Д2): команда, начатая до перезагрузки ---------- */
/* Команда ушла на сервер, вкладку перезагрузили, а Orchestrator её доделал: транзакция
   приходит своей (client тот же), но ждать её некому — стек отмены и итог остались в
   прежней странице. Отметка «команда в пути» живёт в sessionStorage (переживает
   перезагрузку этой вкладки, а другим вкладкам не видна) с id загрузки страницы: своя
   идущая команда этой загрузки отметкой «до перезагрузки» не считается. */
const INFLIGHT_KEY = 'imago.inflight.v1';
let pageLeaving = false;
try {
  addEventListener('beforeunload', () => { pageLeaving = true; });
  addEventListener('pagehide', () => { pageLeaving = true; });
  addEventListener('pageshow', () => { pageLeaving = false; });   // вернулись из кеша истории
} catch { /* не браузер */ }
const INFLIGHT_MAX_AGE = 15 * 60 * 1000;
const PAGE_LOAD = CORE.uid('pg');

function readInflight() {
  try {
    const raw = sessionStorage.getItem(INFLIGHT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    return Array.isArray(list) ? list.filter((m) => m && typeof m.commandId === 'string' && now - Number(m.at) < INFLIGHT_MAX_AGE) : [];
  } catch { return []; }
}

function writeInflight(list) {
  try { sessionStorage.setItem(INFLIGHT_KEY, JSON.stringify(list.slice(-8))); } catch { /* хранилища нет — без отметки */ }
}

function rememberInflight({ commandId, utterance, at }) {
  if (!server || !server.project || !commandId) return;
  writeInflight([...readInflight().filter((m) => m.commandId !== commandId),
    { commandId, utterance: String(utterance || '').slice(0, 300), at, project: server.project.id, page: PAGE_LOAD }]);
}

function forgetInflight(commandId) {
  const list = readInflight();
  const next = list.filter((m) => m.commandId !== commandId);
  if (next.length !== list.length) writeInflight(next);
}

/** Отметки команд этого проекта, начатых прежними загрузками страницы. */
function inflightOfPast() {
  const id = server && server.project ? server.project.id : '';
  return readInflight().filter((m) => m.project === id && m.page !== PAGE_LOAD);
}

/** Команда до перезагрузки, которой принадлежит своя транзакция агента (или null). */
function inflightBefore(tx) {
  const past = inflightOfPast();
  if (!past.length || !tx) return null;
  if (tx.command_id) return past.find((m) => m.commandId === tx.command_id) || null;
  // Orchestrator без command_id в транзакции: самая ранняя из прежних, если сейчас своя не идёт
  if (serverAgent.current) return null;
  return past.slice().sort((a, b) => a.at - b.at)[0] || null;
}

function settlePreReloadTx(pre, tx, prevDoc, diff) {
  forgetInflight(pre.commandId);
  const human = cleanText(tx.title) || describeOps(Array.isArray(tx.ops) ? tx.ops : [], prevDoc) || 'правка записана';
  settleAgentTx(tx, prevDoc, diff, { label: pre.utterance, human, select: [] });
  const undoable = state.history.some((t) => t.id === tx.tx_id);
  if (dom.command && dom.command.value.trim() === String(pre.utterance || '').trim()) dom.command.value = '';
  addChat('agent', `Команда «${clip(pre.utterance, 60)}», начатая до перезагрузки, выполнена: ${human}`);
  rememberPair(pre.utterance, human);
  showMsg('result', 'Команда, начатая до перезагрузки, выполнена', {
    note: `«${clip(pre.utterance, 60)}» — ${human.charAt(0).toLowerCase()}${human.slice(1)}.${undoable ? ` Отменить — кнопкой «Отменить»${keyOr('Mod+Z')}.` : ''}`,
    actions: undoable ? [{ label: 'Отменить', onClick: () => undoTx(tx.tx_id) }] : [],
    undoTx: undoable ? tx.tx_id : null,
  });
}

/** После открытия: команда до перезагрузки ещё может идти — сказать, что её итог придёт сам. */
const preReloadSaid = new Set();   // о каких командах уже сказано в этой загрузке страницы
function notePreReloadCommands() {
  const past = inflightOfPast().filter((m) => Date.now() - m.at < 5 * 60 * 1000 && !preReloadSaid.has(m.commandId));
  if (!past.length) return;
  for (const m of past) preReloadSaid.add(m.commandId);
  const last = past[past.length - 1];
  showMsg('plain', 'Команда, начатая до перезагрузки, могла продолжиться на сервере', {
    note: `«${clip(last.utterance, 60)}» — если агент её доделает, правка придёт сама и появится в «Истории».`,
    role: 'pre-reload',
    ms: 9000,
  });
}

/**
 * «Стоп» нажат, а Orchestrator мог уже записать транзакцию (§10.5: начатую запись он
 * доводит). Запоминаем команду: когда её транзакция придёт по сокету, ей нужен шаг истории
 * и строка «успел записать». Транзакция могла прийти и раньше «стопа» — тогда она уже
 * лежит в arrived.
 */
function noteStoppedCommand(commandId, utterance, { startedAt = Date.now(), txId = null } = {}) {
  if (!commandId) return false;
  if (serverAgent.current && serverAgent.current.commandId === commandId) serverAgent.current = null;
  const prev = serverAgent.stopped.get(commandId);
  const entry = {
    commandId, utterance, startedAt: prev ? prev.startedAt : startedAt, at: prev ? prev.at : Date.now(),
    txId: txId || (prev && prev.txId) || null,
  };
  serverAgent.stopped.set(commandId, entry);
  while (serverAgent.stopped.size > AGENT_STOPPED_MAX) {
    serverAgent.stopped.delete(serverAgent.stopped.keys().next().value);
  }
  for (const [id, got] of serverAgent.arrived) {
    if (stoppedCommandFor(got.tx, got.mine, got.at) !== entry) continue;
    serverAgent.arrived.delete(id);
    settleStoppedTx(entry, got.tx, got.prevDoc, got.diff);
    return true;
  }
  return false;
}

/**
 * Остановленная команда, которой принадлежит транзакция агента. Узнаём по command_id
 * в транзакции, по tx_id из итога, а если Orchestrator command_id в транзакцию не кладёт —
 * по своей вкладке (`client`): своя транзакция агента, которую никто не ждёт, пришедшая
 * вскоре после «стопа», — от остановленной команды.
 */
function stoppedCommandFor(tx, mine, at = Date.now()) {
  if (!tx || !serverAgent.stopped.size) return null;
  const now = Date.now();
  for (const [id, s] of serverAgent.stopped) {
    if (now - s.at > AGENT_STOPPED_MS) serverAgent.stopped.delete(id);
  }
  if (tx.command_id) return serverAgent.stopped.get(tx.command_id) || null;
  for (const s of serverAgent.stopped.values()) if (s.txId && s.txId === tx.tx_id) return s;
  if (!mine) return null;
  // идёт новая команда, и транзакция пришла после её начала — скорее всего, её
  const cur = serverAgent.current;
  if (cur && at >= cur.at) return null;
  // без command_id: самая ранняя остановленная, чей tx_id ещё не известен и которая
  // успела начаться до прихода транзакции
  for (const s of serverAgent.stopped.values()) {
    if (!s.txId && at >= s.startedAt) return s;
  }
  return null;
}

/** Транзакция остановленной команды: шаг истории (Ctrl+Z отменит) и одна честная строка. */
function settleStoppedTx(stopped, tx, prevDoc, diff) {
  serverAgent.stopped.delete(stopped.commandId);
  const words = stoppedWriteWords(tx, stopped.utterance, keyPlatformNow());
  settleAgentTx(tx, prevDoc, diff, { label: stopped.utterance, human: tx.title || stopped.utterance, select: [] });
  addChat('agent', words.title, [], words.note);
  rememberPair(stopped.utterance, tx.title || words.title);
  // команда вернулась в строку после «стопа» — она выполнена, второй раз её не шлём
  if (dom.command && dom.command.value.trim() === String(stopped.utterance || '').trim()) dom.command.value = '';
  showMsg('warn', words.title, {
    note: words.note,
    actions: [{ label: 'Отменить', primary: true, onClick: () => undoTx(tx.tx_id) }],
    undoTx: tx.tx_id,
  });
}

function settleAgentTx(tx, prevDoc, diff, wait) {
  const ops = Array.isArray(tx.ops) ? tx.ops : [];
  if (ops.length && prevDoc && !state.history.some((t) => t.id === tx.tx_id)) {
    let inverse = [];
    try { inverse = invertOps(prevDoc, ops); } catch { inverse = []; }
    if (inverse.length) {
      state.history.length = state.cursor;
      state.history.push({
        id: tx.tx_id, kind: 'ops', ops, inverse,
        label: wait.label || tx.title || 'Агент', who: 'agent', at: Date.now(), undone: false,
        human: wait.human || tx.title || describeOps(ops, prevDoc),
        pending: false, seq: tx.seq,
      });
      state.cursor = state.history.length;
      scheduleSave();
      refreshSheet();
    }
  }
  const ids = (wait.select || []).filter((id) => state.doc.nodes[id]);
  if (ids.length) setSelection(ids.slice(0, 40), { quiet: true, agent: true });
  else if (diff) selectTouched(diff);
  if (diff) revealChange(diff);
}

/** «Когда менялся» — словами, а не ISO-строкой. */
function whenWords(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 60 * 1000) return 'только что';
  const min = Math.round(d / 60000);
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Шторка «Проекты»: список, новый, переименование, переход — без перезагрузки страницы. */
async function openProjects() {
  if (!server) { if (solo) openSoloProjects(); return; }
  openSheet('Проекты', (body) => fillProjects(body, server.list, { loading: true }), { size: 'auto', key: 'projects' });
  await loadProjectsSheet();
}

/* Круг 31 (UX Д4): список не пришёл — шторка не говорит «Проектов пока нет» (они есть, их не
   прочитать), показывает открытый проект и «Повторить», а пока открыта — спрашивает сама с
   нарастающей паузой и перерисовывается, когда сервер ответил. */
const PROJECTS_RETRY_MS = [2000, 3000, 5000, 8000];
let projectsRetry = { timer: null, tries: 0 };

async function loadProjectsSheet() {
  if (projectsRetry.timer) { clearTimeout(projectsRetry.timer); projectsRetry.timer = null; }
  let list = null;
  let next = null;
  let failure = null;
  try {
    const page = await fetchProjectsPage();
    list = page.projects;
    next = page.next;
  } catch (e) { list = null; failure = e; }
  if (!server) return;
  if (list) {
    server.list = list;
    server.listNext = next;
    server.listFailed = null;
    projectsRetry.tries = 0;
    // проект не открылся из-за этого же сбоя — теперь откроется
    if (server.listWait) retryProjectList({ now: true });
  } else {
    server.listFailed = { storage: storageDownError(failure) };
    if (failure && storageDownError(failure) && server.sync && typeof server.sync.storageFailed === 'function') server.sync.storageFailed();
  }
  if (state.sheetOpen !== 'projects') return;
  openSheet('Проекты', (body) => fillProjects(body, list, { loading: false }), { size: 'auto', key: 'projects' });
  if (!list) {
    const delay = PROJECTS_RETRY_MS[Math.min(projectsRetry.tries, PROJECTS_RETRY_MS.length - 1)];
    projectsRetry.tries += 1;
    projectsRetry.timer = setTimeout(() => {
      projectsRetry.timer = null;
      if (state.sheetOpen === 'projects' && server && server.listFailed) loadProjectsSheet();
    }, delay);
  }
}

/** Имя нового проекта: «Новый проект», а если такое уже есть — «Новый проект 2», «3»… */
function freshProjectName(list) {
  const taken = new Set((list || []).map((p) => p && cleanText(p.name)).filter(Boolean));
  const base = 'Новый проект';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  return base;
}

/** «в 06:22:55» сегодня, «18.10 в 06:22» раньше — уточнение к «менялся … назад». */
function exactClock(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: Date.now() - t < 3600 * 1000 ? '2-digit' : undefined });
  return today ? `в ${time}` : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} в ${time}`;
}

/** Строка пропавшего с сервера проекта в шторке «Проекты»: имя и путь к спасению. */
function goneProjectItem() {
  const item = document.createElement('div');
  item.className = 'pitem';
  item.dataset.current = 'true';
  item.dataset.gone = 'on';
  const head = document.createElement('div');
  head.className = 'phead';
  const name = document.createElement('span');
  name.className = 'pname';
  name.textContent = server.project.name || docTitle() || 'Без названия';
  head.append(name);
  const meta = document.createElement('span');
  meta.className = 'pwhen';
  meta.textContent = 'открыт · на сервере его больше нет — работа цела в этом браузере';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn accent small';
  save.textContent = SHELL.PROJECT_GONE_WORDS.action;
  save.addEventListener('click', () => { closeSheet(); saveAsNewProject(); });
  const foot = document.createElement('div');
  foot.className = 'pgone';
  foot.appendChild(save);
  item.append(head, meta, foot);
  return item;
}

/** Перерисовать шторку проектов по уже загруженному списку (без запроса). */
/**
 * Круг 45: удалить пустую сироту спасения (DELETE с ключом первой попытки). Итог — словами; «уже
 * удалён» — не ошибка; «есть правки» — список перечитывается (строка «без правок» устарела).
 * Карточка «Первая попытка тоже сохранилась…» после удаления — неправда: снимается. Фокус —
 * на «Создать проект» (шторка перерисована, прежней кнопки нет).
 */
async function deleteOrphan(p, hint, btn) {
  if (btn) btn.disabled = true;
  let reload = false;
  try {
    // ключ и в теле, и в адресе: часть прокси режет тело у DELETE (круг 45, проход 3)
    await apiJson(`/api/projects/${encodeURIComponent(p.id)}?create_id=${encodeURIComponent(hint.createId)}`, { method: 'DELETE', body: { create_id: hint.createId } });
    forgetOrphan(hint.createId);
    if (Array.isArray(server.list)) server.list = server.list.filter((x) => x.id !== p.id);
    if (dom.dockmsg && !dom.dockmsg.hidden && dom.dockmsg.dataset.role === 'rescue-orphan') hideMsg();
    toast(SHELL.orphanDeleteWords(p.name), 'plain', 6000);
  } catch (e) {
    const gone = e && e.status === 404;
    const used = e && e.status === 409 && e.detail && e.detail.cause === 'not_empty';
    if (gone || used) forgetOrphan(hint.createId);
    else if (e && e.status === 409) notOrphan(hint.createId, p.id);
    if (gone && Array.isArray(server.list)) server.list = server.list.filter((x) => x.id !== p.id);
    // 409 not_empty: пометки «первая попытка» больше нет — и карточка о ней уже неправда (UX r45b М1)
    if ((gone || used) && dom.dockmsg && !dom.dockmsg.hidden && dom.dockmsg.dataset.role === 'rescue-orphan') hideMsg();
    reload = used;
    toast(SHELL.orphanDeleteWords(p.name, e), gone ? 'plain' : 'error', 8000);
  }
  if (reload) await loadProjectsSheet();
  else redrawProjects();
  // фокус — на первую строку списка, а не на «Создать проект»: тост итога ложится на ту кнопку (UX r45b М2)
  const body = dom['sheet-body'];
  const next = body && (body.querySelector('.pitem .pname') || body.querySelector('button'));
  if (next && state.sheetOpen === 'projects') next.focus();
}

function redrawProjects() {
  if (!server || state.sheetOpen !== 'projects') return;
  openSheet('Проекты', (body) => fillProjects(body, server.list, { loading: false }), { size: 'auto', key: 'projects' });
}

/** «Показать ещё»: следующая страница дописывается к списку (повторы — по id — вон). */
async function moreProjects(btn) {
  if (!server || !server.listNext) return;
  btn.disabled = true;
  btn.textContent = 'Загружаю…';
  try {
    const page = await fetchProjectsPage(server.listNext);
    const have = new Set((server.list || []).map((p) => p && p.id));
    server.list = [...(server.list || []), ...page.projects.filter((p) => p && !have.has(p.id))];
    server.listNext = page.next;
    redrawProjects();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Показать ещё';
    toast(`Список не догрузился: ${afterColon(humanError(e))}`, 'error', 8000);
  }
}

function fillProjects(body, list, { loading } = {}) {
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn subtle wide';
  /* Круг 29, п.7: кнопка звалась так же, как новый проект в списке, — две строки «Новый
     проект» подряд. Кнопка — действием, новый проект — с номером, если имя уже занято. */
  add.textContent = 'Создать проект';
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      const p = await createProject(freshProjectName(list || server.list));
      closeSheet();
      openProject(p);
      toast('Открыт новый проект — имя правится в шапке.', 'plain', 6000);
    } catch (e) {
      add.disabled = false;
      toast(`Проект не создался: ${afterColon(humanError(e))}`, 'error', 8000);
    }
  });
  body.appendChild(add);

  const items = (list || []).filter((p) => p && p.id).slice();
  items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (loading) {
    // пока свежий список в пути, показываем прежний — и говорим, что он может устареть
    const p = document.createElement('div');
    p.className = 'note';
    p.dataset.loading = 'on';
    p.textContent = 'Обновляю список…';
    body.appendChild(p);
  }
  const failed = list === null && !loading;
  if (failed) {
    const f = server.listFailed || {};
    const box = document.createElement('div');
    box.className = 'note';
    box.dataset.role = 'projects-failed';
    const p = document.createElement('span');
    p.textContent = f.storage
      ? 'Список не пришёл — база данных сервера недоступна. Обновлю сам, когда она вернётся.'
      : 'Список не пришёл — сервер недоступен. Обновлю сам, когда он ответит.';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn ghost small';
    again.textContent = 'Повторить';
    again.addEventListener('click', () => {
      again.disabled = true;
      again.textContent = 'Спрашиваю…';
      projectsRetry.tries = 0;
      loadProjectsSheet();
    });
    box.append(p, ' ', again);
    body.appendChild(box);
    // прежний список (если был) лучше пустоты: по нему можно перейти, когда сервер ответит
    for (const p2 of server.list || []) if (p2 && p2.id && !items.some((x) => x.id === p2.id)) items.push(p2);
  }
  const current = server.project ? server.project.id : '';
  // открытый проект — в списке всегда, даже когда список не пришёл
  if (failed && server.project && current && !items.some((p) => p.id === current) && !projectGone()) {
    items.unshift({ id: current, name: server.project.name || docTitle(), kind: server.project.kind, updated_at: server.project.updated_at || '' });
  }
  if (!items.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = loading ? 'Загружаю…' : failed ? 'Проекты появятся здесь, когда сервер ответит.' : 'Проектов пока нет.';
    body.appendChild(p);
    return;
  }
  // круг 29: открытого проекта на сервере нет — он в списке не придёт, но работа его здесь
  if (projectGone() && !items.some((p) => p.id === current)) body.appendChild(goneProjectItem());
  // одинаковые имена различаем временем создания (п.7)
  const names = new Map();
  for (const p of items) names.set(p.name || '', (names.get(p.name || '') || 0) + 1);
  const orphans = SHELL.rescueOrphanMatches(items, orphanHints());
  for (const p of items) {
    const item = document.createElement('div');
    item.className = 'pitem';
    item.dataset.current = String(p.id === current);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pname';
    open.textContent = p.name || 'Без названия';
    open.title = p.id === current ? 'Открыт сейчас' : 'Открыть проект';
    open.addEventListener('click', () => {
      if (p.id === current) { closeSheet(); return; }
      closeSheet();
      openProject(p);
    });
    const meta = document.createElement('span');
    meta.className = 'pwhen';
    /* Одноимённые различаем точным временем правки и числом правок: «5 минут назад» у
       двух «Новых проектов» подряд не говорит, какой из них какой (круг 29, п.7). */
    const twin = names.get(p.name || '') > 1;
    /* Круг 39 (UX): в одном списке не смешиваем «18.10 в 02:10:40» и «2 минуты назад» — у всех
       «менялся … назад»; одноимённым к этому — точное время и число правок. */
    /* Круг 41 (UX): «только что · 18.10 в 06:22:55» — одно время двумя словами; одноимённым —
       одна фраза «менялся только что, в 06:22:55» (время — уточнение), и число правок. */
    const when = whenWords(p.updated_at || p.created_at);
    const exact = twin ? exactClock(p.updated_at || p.created_at) : '';
    const edits = twin && Number.isFinite(Number(p.head_seq))
      ? (Number(p.head_seq) ? `${p.head_seq} ${plural(Number(p.head_seq), 'правка', 'правки', 'правок')}` : 'без правок') : '';
    const whenLine = when ? `менялся ${when}${exact ? `, ${exact}` : ''}` : (exact ? `менялся ${exact}` : '');
    // круг 43: пустой проект первой попытки спасения — помечен, чтобы его не путали со спасённым
    const hint = orphans.get(p.id) || null;
    const orphan = hint ? 'первая попытка сохранения, без последних правок' : '';
    meta.textContent = [p.id === current ? 'открыт' : '', p.kind === 'library' ? 'библиотека' : '', orphan, whenLine, edits].filter(Boolean).join(' · ');
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn ghost small';
    rename.textContent = 'Переименовать';
    rename.addEventListener('click', () => {
      const input = document.createElement('input');
      input.className = 'field pname-edit';
      input.value = p.name || '';
      input.maxLength = 120;
      input.setAttribute('aria-label', 'Новое имя проекта');
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const name = cutText(cleanText(input.value), 120);
        if (save && name && name !== p.name) {
          try {
            const got = await apiJson(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { name } });
            p.name = (got && got.name) || name;
            if (server.project && server.project.id === p.id) { server.project.name = p.name; setDocNameText(p.name); }
          } catch (e) { toast(`Имя не сохранилось: ${afterColon(humanError(e))}`, 'error', 8000); }
        }
        // список не перечитываем: догруженные страницы остались бы за бортом
        redrawProjects();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      open.replaceWith(input);
      input.focus();
      input.select();
    });
    const head = document.createElement('div');
    head.className = 'phead';
    head.append(open, rename);
    /* Круг 45 (§9.19): пустую сироту спасения своего ключа можно удалить — не молча: подтверждение
       в строке, как у проектов в браузере (круг 46), с именем; сервис сам откажет, если в ней есть
       правки. Кнопки — своей строкой под временем, чтобы имя не обрезалось. */
    let acts = null;
    if (hint && hint.createId && p.id !== current) {
      acts = document.createElement('div');
      acts.className = 'pacts';
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn ghost small';
      drop.dataset.role = 'orphan-delete';
      drop.textContent = 'Удалить';
      drop.title = 'Удалить пустую первую попытку';
      drop.addEventListener('click', () => {
        const ask = document.createElement('div');
        ask.className = 'pconfirm';
        ask.setAttribute('role', 'group');
        ask.setAttribute('aria-label', 'Подтверждение удаления');
        const q = document.createElement('span');
        q.textContent = `Удалить пустую первую попытку «${clip(p.name || 'Без названия', 40)}»? Правок в ней нет.`;
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'btn danger small';
        yes.textContent = 'Удалить';
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'btn ghost small';
        no.textContent = 'Оставить';
        no.addEventListener('click', () => { ask.remove(); acts.hidden = false; drop.focus(); });
        yes.addEventListener('click', () => deleteOrphan(p, hint, yes));
        ask.append(q, yes, no);
        acts.hidden = true;
        item.appendChild(ask);
        no.focus();
      });
      acts.append(drop);
    }
    item.append(head, meta);
    if (acts) item.append(acts);
    body.appendChild(item);
  }
  // круг 26: проектов больше страницы — догружаем по кнопке (сервис прежней версии отдаёт всё)
  if (!loading && list && list === server.list && server.listNext) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn subtle wide';
    more.dataset.role = 'projects-more';
    more.textContent = 'Показать ещё';
    more.addEventListener('click', () => moreProjects(more));
    body.appendChild(more);
  }
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
    // круг 47: видит ли модель картинки (снимок доски для самопроверки) — решает человек
    vision: settings.lmstudio.vision === true,
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
  const onServer = agentOnServer();
  const model = onServer && serverAgent.health && serverAgent.health.model ? `, ${serverAgent.health.model}` : '';
  const kind = onServer ? `сервер${model}` : (AGENT_KIND_WORDS[state.providerKind] || 'модель');
  const st = !agentReady() ? 'off' : (state.busy ? 'busy' : 'ready');
  // круг 39: первая проверка сервера агента ещё в пути — «не отвечает» было бы неправдой
  const checking = (serverBooting || (server && !serverAgent.health)) && !state.provider;
  const words = {
    // круг 25: в серверном режиме агент — сервер; «откройте настройки» там не помогут
    off: checking ? 'Подключаюсь к серверу агента…' : server ? 'Сервер агента не отвечает — правки руками сохраняются' : 'Агент не подключён — откройте настройки',
    ready: `Агент подключён: ${kind}`,
    busy: `Агент работает: ${kind}`,
  }[st];
  /* Круг 45 (UX r45): сервер агента без документа или модели — знак у слова «Imago» говорит то же,
     что знак агента в строке состояния (SHELL.agentBadge), а не «Агент подключён». */
  const badge = onServer && st !== 'off' ? SHELL.agentBadge('server', serverAgent.health) : null;
  if (badge && badge.dot !== 'on') {
    const why = agentModeTitle('server', serverAgent.health);
    dot.dataset.state = 'off';
    dot.title = why;
    dot.setAttribute('aria-label', why);
    return;
  }
  dot.dataset.state = st;
  dot.title = words;
  dot.setAttribute('aria-label', words);
}

function setRunnable(ok) {
  // круг 23: агент на сервере — команды принимаются и без своей модели у браузера
  ok = ok || commandReady();
  dom['btn-run'].disabled = !ok && !state.busy;
  paintRunButton();
  dom['btn-variants'].disabled = !ok || state.busy;
  updateAgentDot();
  // длинный пример обрезался на полуслове — примеры живут в чипах-подсказках
  dom.command.placeholder = ok
    ? (isNarrow() ? 'Что построить?' : 'Что построить или изменить? «/» — команды')
    : 'Агент не подключён — откройте настройки';
}

/** Текст ошибки применения: по новому контракту core отдаёт {code, message}, раньше — строку. */
function opError(err) {
  if (!err) return '';
  if (typeof err === 'string') return shellWord(err);
  return shellWord(err.message || err.code || 'причина не названа');
}

/* --------------------------------- история ----------------------------------- */

/** Применить операции как одну транзакцию. */
/**
 * Круг 27, п.8. Переименование геометрию не меняет, а решатель на 10 000 узлов считает её
 * ~60 мс, проверка раскладки — ещё ~30 мс: на каждое имя. Правка, в которой только имена
 * обычных узлов (не библиотеки: имя компонента видно у экземпляров), берёт прежнюю
 * геометрию; замечания раскладки досчитываются в простое (refreshIssuesSoon).
 */
function geometryNeutral(opsList, doc) {
  if (!Array.isArray(opsList) || !opsList.length || !doc || !doc.nodes) return false;
  const lib = libraryNode(doc);
  for (const op of opsList) {
    if (!op || op.op !== 'set' || op.path !== 'name' || !doc.nodes[op.id]) return false;
    if (lib && (op.id === lib.id || (ancestors(doc, op.id) || []).some((a) => (a && a.id ? a.id : a) === lib.id))) return false;
  }
  return true;
}

/**
 * Геометрия после правки: прежняя, если правка её не меняет, иначе — решатель.
 * Круг 51 (SPEC §18): раскладка по месту правки (CORE.solveAfter) — что изменилось, она узнаёт
 * по самим документам, поэтому годится и для чужой транзакции; нельзя — сама сделает полную.
 */
function geoAfter(opsList, prevDoc, nextDoc, prevGeo) {
  if (prevGeo && prevGeo.rects && geometryNeutral(opsList, prevDoc)) {
    return typeof CORE.solveCarry === 'function' ? CORE.solveCarry(prevGeo, prevDoc, nextDoc) : prevGeo;
  }
  if (typeof CORE.solveAfter === 'function') return CORE.solveAfter(prevGeo, prevDoc, nextDoc, opsList);
  return solveKept(nextDoc);
}

/** Геометрия состояния: с памятью для следующей раскладки по месту правки (SPEC §18). */
function solveKept(doc) {
  return solve(doc, { incremental: true });
}

/**
 * Круг 57 (SPEC §18.6): геометрия для нового документа состояния от текущей — по месту правки,
 * когда прежний документ не под рукой (отмена, повтор, подтверждение сервера, кадр догона).
 * Документ — из applyOps или реплики (неизменённые узлы общие), иначе всё равно полная.
 */
function solveFrom(prevGeo, doc) {
  return typeof CORE.solveNext === 'function' ? CORE.solveNext(prevGeo, doc) : solveKept(doc);
}

let issuesTimer = null;
/** Замечания раскладки досчитать в простое: имена в их тексте могли смениться. */
function refreshIssuesSoon() {
  if (issuesTimer) clearTimeout(issuesTimer);
  issuesTimer = setTimeout(() => {
    issuesTimer = null;
    const doc = state.doc;
    const next = layoutIssues(doc, state.geo);
    if (doc !== state.doc) return;
    const sig = (m) => [...m].map(([id, l]) => `${id}:${l.map((n) => n.message).join('|')}`).join(';');
    if (sig(next) === sig(state.issues)) return;
    state.issues = next;
    dropResolvedIssueToast();
    renderLayers();
  }, 400);
}

function commit(opsList, label, who = 'human', extra = {}) {
  // на холсте мог стоять предпросмотр варианта: правка ложится в документ, и холст
  // обязан показывать документ (п.1)
  unpeekVariant();
  if (!opsList || !opsList.length) return { ok: true, empty: true };
  // Круг 22: в серверном режиме транзакция уходит в реплику, а не в state.history + scheduleSave
  if (server) return serverCommit(opsList, label, who, extra);
  const prevDoc = state.doc;
  const inverse = invertOps(state.doc, opsList);
  const res = applyOps(state.doc, opsList);
  if (res.error) {
    showMsg('error', `Не удалось применить правку: ${opError(res.error)}`);
    return { ok: false, error: res.error };
  }
  const prevGeo = state.geo;
  state.doc = res.doc;
  state.geo = geoAfter(opsList, prevDoc, state.doc, prevGeo);

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
  else dropStaleStepCard();

  /* Круг 20, п.4. Вставка шага шкалы переписывает ссылки у десятков узлов, не сдвигая ни
     одного пикселя: рамки на них врали бы про объём правки (см. diffOf). Такая транзакция
     просит commit не рисовать рамок (extra.noFrames); история о ней говорит словами. */
  const diff = extra.noFrames ? { created: [], changed: [], removed: [], moved: [] } : diffOf(opsList, prevGeo);
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
      ? `${removed === 1 ? 'Слой удалён' : 'Слои удалены'} — ${backHint().charAt(0).toLowerCase()}${backHint().slice(1)}`
      : backHint(),
    actions: [{ label: 'Отменить', onClick: () => undoTx(tx.id) }],
    undoTx: tx.id,
    ms: 9000,
  });
}

function txId() {
  return `tx_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/**
 * Круг 22 (SPEC §8.3, §9.5). Транзакция в серверном режиме: оптимистично ложится в
 * реплику (view меняется сразу), встаёт в очередь и уходит на сервер; в стек отмены —
 * только свои содержательные правки (отмена и повтор — тоже транзакции, но записи
 * истории не заводят: они меняют состояние той записи, которую отменяют или возвращают).
 * Операции по узлам, которых уже нет (кто-то удалил раньше), отбрасываются реплика
 * теми же правилами, что сервер, — и человеку об этом сказано одной строкой.
 *
 * extra: undoOf/redoOf — служебная транзакция отмены/повтора; system — миграция
 * (author_kind:'system'); noHistory — без записи в стек; noRender — перерисует вызывающий
 * (перемотка истории); quiet и noFrames — как у обычного commit.
 */
function serverCommit(opsList, label, who = 'human', extra = {}) {
  const sync = server && server.sync;
  if (!sync || !sync.view) {
    /* Круг 31 (m2/m3): проект не открылся — список проектов не пришёл (база данных или сервер
       лежат). «Ещё открывается — подождите секунду» тут неправда: ждать придётся, пока
       вернётся сервер, и проект откроется сам. */
    if (!extra.noRender) {
      const wait = server && server.listWait;
      if (wait) {
        showMsg('error', wait.storage ? 'Правку некуда записать — база данных сервера недоступна' : 'Правку некуда записать — сервер недоступен', {
          note: 'Проект ещё не открыт. Он откроется сам, когда сервер снова ответит.',
          role: 'list-wait-edit',
          actions: [{ label: 'Попробовать снова', primary: true, onClick: () => retryProjectList() }],
        });
      } else showMsg('error', 'Проект ещё открывается — подождите секунду.');
    }
    return { ok: false, error: { code: 'not_open', message: 'проект не открыт' } };
  }
  const prevDoc = state.doc;
  const prevGeo = state.geo;
  const kind = extra.system ? 'system' : who === 'agent' ? 'agent' : 'human';
  /* J6 (круг 29): подпись транзакции человека — описание словами, как в «Истории»
     («Переименовал «A» в «B»», «Удалил «X»»), а не имя действия («Свойство», «Удалить»):
     её читают все, кто открыл «Историю» позже, и они видят только её. */
  const described = extra.human || describeOps(opsList, prevDoc);
  const title = kind !== 'human' ? label
    : extra.title ? extra.title
      : cutText(described || SHELL.txTitleWords(label) || label, 200);
  /* Круг 31 (K1): правка больше предела сервера (5000 операций или 3,5 МБ) — отмена удаления
     большой доски, импорт большого файла — уходит несколькими транзакциями подряд, одним
     шагом истории. У отмены и повтора части несут общий undo_of/redo_of и undo_part {i, n}. */
  const parts = SHELL.needsParts(opsList)
    ? SHELL.splitOpsForServer(opsList, { splitOps: typeof CORE.splitOps === 'function' ? CORE.splitOps : null })
    : [Array.isArray(opsList) ? opsList : [opsList]];
  const n = parts.length;
  const txs = [];
  const applied = [];
  const dropped = [];
  const predictedBy = {};
  let offset = 0;
  let refusedAt = -1;
  for (let i = 0; i < n; i++) {
    const meta = {
      title: n > 1 ? cutText(SHELL.partTitle(title, i, n), 200) : title,
      author_kind: kind, undo_of: extra.undoOf, redo_of: extra.redoOf,
    };
    if (n > 1) meta.undo_part = { i, n };
    const r = sync.commit(parts[i], meta);
    for (const d of r.dropped || []) dropped.push(Number.isInteger(d.index) ? { ...d, index: d.index + offset } : d);
    offset += parts[i].length;
    if (!r.tx) {
      const refused = (r.dropped || []).length > 0 && r.dropped.every((d) => d && (d.limit === 'tx_bytes' || d.limit === 'ops_per_tx'));
      if (refused) { refusedAt = i; break; }
      continue;
    }
    txs.push(r.tx);
    predictedBy[r.tx.tx_id] = (r.dropped || []).filter((d) => Number.isInteger(d.index)).map((d) => d.index).sort((x, y) => x - y);
    for (let k = 0; k < r.applied.length; k++) applied.push(r.applied[k]);
  }
  if (!txs.length) {
    // ни одной применимой операции: узлов уже нет — правка ушла в никуда, о чём и говорим
    const line = droppedLine(dropped);
    /* Реплика отказала по пределу (правка больше 4 МБ или 5000 операций): об этом уже
       сказал onSyncError — его строку не перебиваем общей «N правок не применились». */
    const refused = refusedAt >= 0;
    // отмене и повтору о причине скажет serverStep — своими словами
    if (!refused && !extra.noRender && kind !== 'system' && !extra.undoOf && !extra.redoOf) {
      const w = droppedMsgOf(dropped, { applied: 0 });
      showMsg('warn', w.title, { note: w.note, role: 'dropped' });
    }
    return { ok: false, error: { code: refused ? 'too_large' : 'not_found', message: line }, dropped };
  }
  const view = sync.view;
  const inverse = invertOps(prevDoc, applied);
  state.doc = view;
  state.geo = geoAfter(applied, prevDoc, state.doc, prevGeo);
  const service = !!(extra.undoOf || extra.redoOf || extra.noHistory);
  const tx = {
    id: txs[0].tx_id, kind: 'ops',
    ops: applied, inverse, label, who, at: Date.now(), undone: false,
    human: described,
    pending: true,
    predicted: predictedBy[txs[0].tx_id] || [],
    ...extra,
  };
  if (txs.length > 1) {
    // K1: части одной правки — подтверждаются по одной, шаг истории один
    tx.parts = txs.map((t) => t.tx_id);
    tx.partsLeft = new Set(tx.parts);
    tx.predictedBy = predictedBy;
  }
  for (const t of txs) noteTabTx(t.tx_id);
  if (!service) {
    // новая правка обрывает хвост отменённых: вернуть их больше нечем (как и в прежнем режиме)
    state.history.length = state.cursor;
    state.history.push(tx);
    state.cursor = state.history.length;
  }
  if (who === 'agent') dropUndoOffer();
  else if (!service && !extra.system) dropStaleStepCard();
  const diff = extra.noFrames ? { created: [], changed: [], removed: [], moved: [] } : diffOf(applied, prevGeo);
  if (!extra.noRender) {
    const hadIssues = state.issues;
    renderAll({ diff, prevGeo });
    if (who === 'human' && !service) announceIssues(freshIssues(hadIssues, state.issues));
    if (who === 'human' && !extra.quiet && !service) announceHuman(tx, diff);
    if (dropped.length && kind !== 'system' && refusedAt < 0) {
      const w = droppedMsgOf(dropped, { applied: applied.length });
      showMsg('warn', w.title, { note: w.note, role: 'dropped' });
    }
  }
  scheduleSave();
  refreshSheet();
  renderSyncStatus();
  return {
    ok: true, tx, diff, inverse, applied,
    parts: txs.map((t) => t.tx_id),
    // часть правки сервер не примет ни в каком виде (одна операция больше предела) — не вся
    partial: refusedAt >= 0 ? { at: refusedAt, of: n } : null,
  };
}

/* Круг 31: свои транзакции этой вкладки (sessionStorage — переживает перезагрузку, но не
   другую вкладку). Своя правка в журнале, которой нет здесь, — из другой вкладки: отменить
   её можно только там. */
const TAB_TX_KEY = 'imago.tabtx.v1';
const TAB_TX_KEEP = 400;
const tabTx = (() => {
  try {
    const raw = sessionStorage.getItem(TAB_TX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(-TAB_TX_KEEP) : []);
  } catch { return new Set(); }
})();
let tabTxTimer = null;

function noteTabTx(id) {
  if (!id) return;
  tabTx.add(String(id));
  while (tabTx.size > TAB_TX_KEEP) tabTx.delete(tabTx.values().next().value);
  if (tabTxTimer) return;
  tabTxTimer = setTimeout(() => {
    tabTxTimer = null;
    try { sessionStorage.setItem(TAB_TX_KEY, JSON.stringify([...tabTx])); } catch { /* приватный режим — на одну загрузку */ }
  }, 300);
}

/**
 * Замена документа целиком (импорт JSON) в серверном режиме — одна транзакция операций:
 * токены группами, снять всех детей корня, создать узлы нового документа сверху вниз
 * (родитель раньше детей, порядок братьев тот же, `exact`, чтобы узлы легли ровно такими,
 * какие они в файле). Корень остаётся свой: удалить его нельзя, а дети нового корня
 * приписываются к нему. Отмена — как у любой транзакции: инверсия вернёт прежние узлы.
 */
function serverCommitDoc(nextDoc, label, humanText, who = 'human') {
  // круг 31: операции замены — в shell.js (проверяются тестом без DOM); большие уходят частями (K1)
  const list = SHELL.replaceDocOps(state.doc, nextDoc);
  return commit(list, label, who, { human: humanText || label, quiet: true, noFrames: true, doc: true });
}

/**
 * Шаг истории в серверном режиме (SPEC §8.3 «Отмена — новая транзакция, а не откат»):
 * обратные операции своей записи уходят транзакцией с undo_of, повтор — с redo_of.
 * Стек — только свои правки в порядке seq; отменённые всегда хвостом, как и раньше.
 * После отмены запись помнит, чем её вернуть (инверсия транзакции отмены); после
 * повтора — чем снова отменить. Подтверждение сервера уточняет и то и другое (settleHistory).
 */
function serverStep(back, { quiet = false } = {}) {
  const what = back ? 'Отмена' : 'Повтор';
  let guard = state.history.length + 1;
  while (guard-- > 0) {
    if (back ? state.cursor === 0 : state.cursor >= state.history.length) return false;
    const i = back ? state.cursor - 1 : state.cursor;
    const tx = state.history[i];
    const list = back ? tx.inverse : tx.ops;
    // J6: «Отменил: переименовал «A» в «B»» — словами записи, а не именем действия
    const said = cleanText(tx.human || SHELL.txTitleWords(tx.label) || tx.label);
    // круг 31: значение, которое шаг вернёт поверх более поздней чужой правки того же свойства
    const clash = quiet ? [] : overwriteClash(back ? tx.ops : tx.inverse, list, tx);
    /* Круг 33, п.7: отмена (повтор) импорта меняет документ целиком — дерево слоёв и вид
       прежнего документа к нему не относятся: ветки сворачиваем до активной доски (как после
       импорта), выделение снимаем, а вид после отрисовки вписываем. */
    const whole = !!tx.doc && !quiet;
    if (whole) { state.selection = []; state.collapsed = null; }
    const r = serverCommit(list, `${what}: ${tx.label}`, 'human', {
      [back ? 'undoOf' : 'redoOf']: tx.id, quiet: true, noRender: quiet,
      title: cutText(`${back ? 'Отменил' : 'Вернул'}: ${said.charAt(0).toLowerCase()}${said.slice(1)}`, 200),
    });
    if (r.ok) {
      if (clash.length) announceOverwrite(clash, back);
      if (back) tx.ops = r.inverse; else tx.inverse = r.inverse;
      tx.lastTx = r.tx.id;
      // K1: отмена большой правки — несколько транзакций; подтверждение любой из них — этой записи
      tx.lastParts = r.parts && r.parts.length > 1 ? r.parts.slice() : null;
      tx.lastLeft = tx.lastParts ? new Set(tx.lastParts) : null;
      tx.pending = true;
      tx.undone = back;
      state.cursor += back ? -1 : 1;
      dropUndoOffer();
      if (whole) { state.userView = false; fitSmart(); }
      if (r.partial && !quiet) {
        toast(`${what} сделан не целиком: часть ${r.partial.at + 1} из ${r.partial.of} сервер не принимает — в ней слой больше 3,5 МБ.`, 'error', 9000);
      }
      return true;
    }
    /* Круг 31 (K1): отказ по пределу (одна операция больше 4 МБ) — шаг не выбрасываем: правка
       цела, отменить её не вышло, и человек узнал об этом от onSyncError. */
    if (r.error && r.error.code === 'too_large') return false;
    if (!r.dropped) return false;
    /* Менять уже нечего: узлы этой записи удалил кто-то другой. Мёртвую запись убираем из
       стека и идём к следующей — человек просил отменить последнюю ДЕЙСТВУЮЩУЮ правку, а
       не нажать ещё раз. */
    dropHistoryEntry(i);
    refreshSheet();
    if (!quiet) toast(`${what}: «${clip(tx.human || tx.label, 48)}» — менять уже нечего, ${droppedLine(r.dropped).replace(/^.*: /, '')}.`, 'plain', 6000);
  }
  return false;
}

/* Круг 31 (UX m7): Ctrl+Z возвращает своё значение свойства, которое после нас переписал
   соавтор, — его правка пропадает молча. Говорим об этом обоим: тому, кто отменил, — здесь,
   тому, чья правка пропала, — по пришедшей транзакции отмены (noteOverwritten). */

const TEXT_LEAF = /(^|\.)(name|characters|text|label|placeholder|title|alt)$/;

/** Значение свойства словами: тексты — в кавычках. */
function leafWords(path, v, doc) {
  if (typeof v === 'string' && TEXT_LEAF.test(String(path || ''))) return `«${clip(cleanText(v), 40)}»`;
  return humanValue(v, '', doc);
}

/** Значение листа операции в документе: у узла (set) или у токенов (setToken). */
function leafValue(doc, op) {
  if (!doc || !op || typeof op.path !== 'string') return undefined;
  if (op.op === 'setToken') return readPath(doc.tokens || {}, op.path);
  const n = doc.nodes ? doc.nodes[op.id] : null;
  return n ? readPath(n, op.path) : undefined;
}

/**
 * Какие листы шаг истории вернёт поверх более поздней чужой правки: значение, которое
 * поставила наша запись (`forward`), в документе уже другое — и известен, кто его поменял.
 * @returns {Array<{op, now, back, by}>}
 */
function overwriteClash(forward, list, tx) {
  const out = [];
  const sync = server && server.sync;
  if (!sync || typeof sync.whoChanged !== 'function' || !Array.isArray(forward) || !Array.isArray(list)) return out;
  if (list.length > 2000) return out;   // большие шаги (импорт, удаление доски) свойств по одному не переставляют
  const ours = new Map();
  for (const op of forward) {
    if (op && (op.op === 'set' || op.op === 'setToken') && typeof op.path === 'string') ours.set(`${op.op === 'set' ? op.id : '#'}|${op.path}`, op);
  }
  for (const op of list) {
    if (!op || (op.op !== 'set' && op.op !== 'setToken') || typeof op.path !== 'string') continue;
    const mine = ours.get(`${op.op === 'set' ? op.id : '#'}|${op.path}`);
    if (!mine) continue;
    const now = leafValue(state.doc, op);
    if (sameValue(now, mine.value) || sameValue(now, op.value)) continue;
    let by = null;
    try { by = sync.whoChanged(op, Number.isInteger(tx.seq) ? tx.seq : -1); } catch { by = null; }
    if (!by) continue;
    out.push({ op, now, back: op.value, by });
    if (out.length >= 3) break;
  }
  return out;
}

/** «Отмена вернула «Шапка» поверх правки Бориса «Шапка Б»» — в карточку отмены (undo/redo). */
let lastOverwrite = '';
function announceOverwrite(clash, back) {
  const c = clash[0];
  const doc = state.doc;
  const more = clash.length > 1 ? ` и ещё ${clash.length - 1} ${plural(clash.length - 1, 'свойство', 'свойства', 'свойств')}` : '';
  lastOverwrite = `${back ? 'Отмена вернула' : 'Повтор вернул'} ${leafWords(c.op.path, c.back, doc)} поверх ${SHELL.editOf(c.by)} ${leafWords(c.op.path, c.now, doc)}${more}.`;
}

/**
 * Пришла чужая отмена/повтор, и она переписала лист, который последней правила эта вкладка:
 * наша правка пропала — говорим чья отмена и что стало.
 */
function noteOverwritten(c, before) {
  if (!c || !Array.isArray(c.ops) || !before || !(c.undo_of || c.redo_of)) return false;
  const hit = [];
  for (const op of c.ops) {
    if (!op || (op.op !== 'set' && op.op !== 'setToken') || typeof op.path !== 'string') continue;
    const was = leafValue(before, op);
    if (sameValue(was, op.value)) continue;
    // последняя действующая своя правка этого листа поставила именно то, что сейчас переписано
    for (let i = state.cursor - 1; i >= 0; i--) {
      const t = state.history[i];
      const mine = Array.isArray(t.ops) ? t.ops.find((o) => o && o.op === op.op && o.path === op.path && (op.op === 'setToken' || o.id === op.id)) : null;
      if (!mine) continue;
      if (sameValue(mine.value, was)) hit.push({ op, was });
      break;
    }
    if (hit.length) break;
  }
  if (!hit.length) return false;
  const h = hit[0];
  const who = SHELL.whoDid({ author: c.author, author_kind: c.author_kind }, c.undo_of ? 'отменил' : 'вернул');
  const head = `${who.charAt(0).toUpperCase()}${who.slice(1)} свою правку — вместо вашей ${leafWords(h.op.path, h.was, before)} снова ${leafWords(h.op.path, h.op.value, state.doc)}.`;
  toast(`${head} Что изменилось — в «Истории».`, 'plain', 10000);
  return true;
}

/** Убрать запись из стека отмены, не сдвигая курсор мимо соседей. */
function dropHistoryEntry(i) {
  if (i < 0 || i >= state.history.length) return;
  state.history.splice(i, 1);
  if (state.cursor > i) state.cursor -= 1;
}

/**
 * Заменить документ целиком — и всё равно как транзакция: с шагом в истории и «Отменить».
 * Импорт раньше стирал документ и историю без возврата, а предупреждал серой строкой (п.1).
 */
function commitDoc(nextDoc, nextGeo, label, humanText, who = 'human') {
  // Круг 22: в серверном режиме документ целиком не заменить — только операциями (SPEC §8.3)
  if (server) return serverCommitDoc(nextDoc, label, humanText, who);
  const before = state.doc;
  // версия приходит из файла и бывает любой — вплоть до меньшей, чем текущая. Проверка
  // «документ изменился, пока агент работал» опирается на неё, поэтому версию выдаём
  // сами и только вверх; заодно у документа меняется id — сверяем и его (п.4)
  const doc = { ...nextDoc, version: Math.max(Number(nextDoc.version) || 0, (Number(before && before.version) || 0) + 1) };
  state.doc = doc;
  state.geo = nextGeo || solveKept(doc);
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
  // Круг 22: отмена в серверном режиме — новая транзакция с undo_of, а не откат журнала
  if (server) return serverStep(back, { quiet });
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
    const step = back ? tx.inverse : tx.ops;
    const res = applyOps(state.doc, step);
    if (res.error) { showMsg('error', `${what} не удался: ${opError(res.error)}`); return false; }
    // круг 57: отмена и повтор — по месту правки, как сама правка
    const prevDoc = state.doc;
    state.doc = res.doc; state.geo = geoAfter(step, prevDoc, state.doc, state.geo);
  }
  tx.undone = back;
  state.cursor += back ? -1 : 1;
  dropUndoOffer();
  if (!quiet) { renderAll(); scheduleSave(); refreshSheet(); }
  return true;
}

function undo() {
  const tx = state.history[state.cursor - 1];
  lastOverwrite = '';
  if (!stepHistory(true)) return false;
  restoreStepSelection(tx, true);
  const clash = lastOverwrite;
  lastOverwrite = '';
  // «Отменено: Заглушка: edit» — двойное двоеточие; факт правки точнее имени намерения (п.13)
  showMsg(clash ? 'warn' : 'plain', `Отменено — ${tx.human || tx.label}`, {
    // круг 31: отмена переписала более позднюю чужую правку — молча это не проходит
    note: clash,
    transient: !clash,
    actions: [{ label: 'Вернуть', onClick: () => redo() }],
  });
  return true;
}

/**
 * Круг 39 (UX): правка командой таблицы помнит выделение до и после. Отмена «Дублировать»
 * снимала копию вместе с выделением — теперь выделен снова оригинал; повтор — снова копия.
 */
function restoreStepSelection(tx, back) {
  const list = tx && (back ? tx.selBefore : tx.selAfter);
  if (!Array.isArray(list) || !list.length || !state.doc) return;
  const keep = list.filter((id) => nodeById(state.doc, id));
  if (keep.length) setSelection(keep);
}

/**
 * Ctrl+Z / Ctrl+Shift+Z. Отменять нечего — короткое «Отменять нечего» на пару секунд, а не
 * тишина: человек нажал и не понял, сработало ли (круг 27, п.7).
 */
function keyUndo(forward) {
  const empty = forward ? state.cursor >= state.history.length : state.cursor <= 0;
  if (empty) {
    /* Круг 31 (m8): своя последняя правка сделана в другой вкладке этого браузера — её стек
       отмены там. «Отменять нечего» без объяснения выглядело как сбой. */
    const other = forward ? null : otherTabEdit();
    if (other) {
      const what = human(cleanText(journalHuman.get(other.tx_id) || SHELL.txTitleWords(other.title) || ''));
      toast(what ? `Отменять в этой вкладке нечего. ${clip(what, 60)} — эта правка сделана в другой вкладке, отменить её можно там.`
        : 'Отменять в этой вкладке нечего: ваша последняя правка сделана в другой вкладке — отменить её можно там.', 'plain', 7000);
      return false;
    }
    // тостом: карточку в доке (итог, ошибку) пустое нажатие затирать не должно
    toast(forward ? 'Возвращать нечего' : 'Отменять нечего', 'plain', 2500);
    return false;
  }
  return forward ? redo() : undo();
}

/**
 * Возврат отвечает тем же, чем отмена. Раньше «Вернуть» молчал, а в доке продолжало
 * висеть «Отменено — …» с живой кнопкой: правка уже применена, а подпись уверяет в
 * обратном (круг 13, п.3). Сообщение помечено transient — следующий шаг истории снимает
 * его сам, через dropUndoOffer.
 */
function redo() {
  const tx = state.history[state.cursor];
  lastOverwrite = '';
  if (!stepHistory(false)) return false;
  restoreStepSelection(tx, false);
  const clash = lastOverwrite;
  lastOverwrite = '';
  const what = tx && (tx.human || tx.label);
  showMsg(clash ? 'warn' : 'plain', what ? `Вернул — ${what}` : 'Вернул правку', {
    note: clash,
    transient: !clash,
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
  // круг 37: слово инспектора — «непрозрачность» (поле «Непрозр.», §11 и §12.3)
  radius: 'Скругление', opacity: 'Непрозрачность', visible: 'Видимость', locked: 'Замок',
  rotate: 'Поворот', paths: 'Контуры', viewBox: 'Холст контуров',
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
  // круг 19: поля компонента и экземпляра (SPEC §5.4–5.5) — без них в истории правок
  // стояло бы «Component.name «Кнопка»» и «Props ...»
  component: 'Компонент', 'component.name': 'Имя компонента', 'component.props': 'Свойства компонента',
  props: 'Свойства', of: 'Компонент',
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
  // круг 19: свойства экземпляра зовутся так, как их назвал человек у компонента,
  // и словаря на них быть не может — имя берём прямо из пути
  if (p.startsWith('props.')) return `Свойство «${p.slice(6)}»`;
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
  // круг 37 (SPEC §12): поворот и контуры вектора — в предупреждениях агента тоже словами
  'rotate', 'paths', 'viewBox',
];
const TECH_PATH_RE = new RegExp(`(?<![\\w.])(?:${TECH_PATHS.map((p) => p.replace(/\./g, '\\.')).join('|')})(?![\\w.])`, 'g');

/** Пути в человеческой реплике — словами инспектора. Внутри «…» и без них (п.9). */
function humanizePaths(text) {
  let s = String(text == null ? '' : text);
  if (!/[a-z]/.test(s)) return s;
  /* Круг 20 (SPEC §6.7). Ссылка на шаг в чужом тексте — у валидатора «шага «spacing.99»
     нет — в шкале отступов 13 шагов (0..12)» — печатается номером шага: слов spacing/radii
     человек не видит, а какая это шкала, фраза говорит сама. */
  s = s.replace(/«(spacing|radii)\.(\d+)»/g, (all, sc, i) => `«№${i}»`);
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

/* ---- круг 20 (SPEC §6.7): слова о шкалах -------------------------------------- */

/* Названия шкал в косвенных падежах: SCALE_NAMES ядра даёт именительный («шкала отступов»),
   а во фразах оболочки нужны «в шкале отступов» и «по шкале». Слов spacing/radii человек
   не видит ни здесь, ни в инспекторе, ни в истории. */
const SCALE_LOC = { spacing: 'шкале отступов', radii: 'шкале скруглений' };

/**
 * В какой шкале живёт поле по его пути: зазор и отступы — в шкале отступов, скругление —
 * в шкале скруглений (SPEC §6.2). Тот же перечень, что у ядра (nodeScaleRefs), но оболочке
 * он нужен для СЛОВ: значение такого поля печатается пикселями с пометкой «(шаг шкалы)»
 * либо «(мимо шкалы)». Пути приходят и полными («layout.gap»), и короткими («gap»,
 * «padding.t») — из предупреждений мозга.
 * @returns {'spacing'|'radii'|null}
 */
function scaleOfPath(path) {
  const p = String(path || '');
  if (/^(layout\.)?(gap|padding)(\.|$)/.test(p)) return 'spacing';
  if (/^radius(\.|$)/.test(p)) return 'radii';
  return null;
}

/** Ссылка на шаг — числом шага для человека; мёртвая — честно «шага нет». */
function scaleRefWord(value, doc) {
  const ref = parseScaleRef(value);
  if (!ref) return '';
  const px = resolveScale(doc || state.doc, value, ref.scale);
  return px === undefined ? `шаг №${ref.index} (в ${SCALE_LOC[ref.scale]} его нет)` : String(Math.round(px * 100) / 100);
}

/**
 * Пометка к значению поля из шкалы (SPEC §6.7): «(шаг шкалы)» — записано ссылкой на живой
 * шаг, «(мимо шкалы)» — числом, «(шага нет в шкале)» — ссылкой на несуществующий шаг.
 * Отступ целиком ({t,r,b,l}) — по шкале, только если все четыре стороны — ссылки.
 * @returns {string} пусто, если поле не из шкалы или значение не задано
 */
function scaleMark(value, scale, doc) {
  if (!scale || value === undefined || value === null) return '';
  const one = (v) => {
    if (typeof v === 'number') return 'off';
    const ref = parseScaleRef(v);
    if (!ref) return '';
    return resolveScale(doc || state.doc, v, scale) === undefined ? 'dead' : 'on';
  };
  let kind;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sides = ['t', 'r', 'b', 'l'].map((k) => one(value[k])).filter(Boolean);
    if (!sides.length) return '';
    kind = sides.includes('dead') ? 'dead' : sides.every((k) => k === 'on') ? 'on' : 'off';
  } else kind = one(value);
  return kind === 'on' ? '(шаг шкалы)' : kind === 'off' ? '(мимо шкалы)' : kind === 'dead' ? '(шага нет в шкале)' : '';
}

function nodeTitle(node, doc) {
  return node ? String(displayName(doc || state.doc, node) || 'слой') : '';
}
function nodeTitleById(doc, id) {
  const n = id && doc && doc.nodes ? doc.nodes[id] : null;
  return n ? nodeTitle(n, doc) : '';
}

/**
 * Значение свойства словами: числа как есть, режимы и токены — по-русски.
 * @param {*} value
 * @param {'w'|'h'} [axis] ось размера: от неё зависит, «во всю ширину» или «во всю высоту».
 * @param {object} [doc] круг 20: документ, по чьим шкалам разрешать ссылки (по умолчанию текущий)
 */
function humanValue(value, axis, doc) {
  if (value === undefined || value === null) return 'не задано';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'string') {
    // круг 20 (SPEC §6.7): ссылка на шаг шкалы — пикселями, сырая строка 'spacing.6' не печатается
    if (parseScaleRef(value)) return scaleRefWord(value, doc);
    return (axis && sizeLabels(axis)[value]) || VALUE_WORDS[value] || SWATCH_NAMES[value]
      || TYPE_LABELS[value] || (value.length > 36 ? `${value.slice(0, 34)}…` : value);
  }
  if (Array.isArray(value)) return value.map((v) => humanValue(v, axis, doc)).join(', ');
  if (typeof value === 'object') {
    /* Отступ {t,r,b,l}: стороны бывают числами и ссылками (круг 20) — сравниваем и печатаем
       их пикселями, иначе «spacing.8/spacing.7/…» либо пустота вместо значения. */
    if (value.t !== undefined && (typeof value.t === 'number' || parseScaleRef(value.t))) {
      const side = (v) => (typeof v === 'number' ? String(v) : (parseScaleRef(v) ? scaleRefWord(v, doc) : String(v)));
      const [t, r, b, l] = [value.t, value.r, value.b, value.l].map(side);
      return (t === r && r === b && b === l) ? t : `${t}/${r}/${b}/${l}`;
    }
    /* Круг 16, п.4. Токен приходит и строкой («display»), и объектом ({token:'display'}) —
       ядро приводит одно к другому. Слово человеку обязано быть одним и тем же, иначе
       describeSet печатает «display → крупный» как разницу там, где разницы нет. */
    if (value.token) return SWATCH_NAMES[value.token] || TYPE_LABELS[value.token] || String(value.token);
    // круг 37 (SPEC §12.1): градиент — «градиент #F4A261–#E76F51, 90°»
    if (value.gradient) {
      return SHELL.paintWord(value, { colors: ((doc || state.doc).tokens || {}).colors, colorWord: (v) => humanValue(v) });
    }
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
    /* Круг 19. Объявленное свойство компонента — объект {name, kind, target, path}: без этой
       ветки «Свойства компонента» печатались пустотой, а список из трёх свойств — «, , ». */
    if (typeof value.name === 'string' && typeof value.kind === 'string' && PROP_KINDS.has(value.kind)) {
      return value.name;
    }
    // положение: без этой ветки первая правка pos печаталась без значения вовсе (п.31)
    if (typeof value.x === 'number' || typeof value.y === 'number') {
      // круг 37: до десятой — стрелка с Shift двигает на 10, без него на 1, и полпикселя
      // от магнита не должны прятать сдвиг округлением
      const c = (v) => String(Math.round((Number(v) || 0) * 10) / 10).replace('.', ',');
      return `x ${c(value.x)} · y ${c(value.y)}`;
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
  Обводка: 'f', Обрезка: 'f', Заливка: 'f', Ширина: 'f', Высота: 'f', Прозрачность: 'f', Непрозрачность: 'f',
  Поворот: 'm',
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

/**
 * «Зазор 16 → 24»: внутри объекта находим тот ключ, который действительно поменялся.
 * @param {object} doc документ ДО транзакции — по нему «было»
 * @param {Map} born узлы, созданные этой же транзакцией
 * @param {object} [afterDoc] круг 20: документ с уже применёнными правками шкал этой же
 *   транзакции — по нему разрешается «стало». Вставка шага (insertScaleStep) переписывает
 *   ссылки вместе со шкалой, и «spacing.7» ПОСЛЕ вставки — прежние 16, а не 20 до неё.
 */
function describeSet(op, doc, born, afterDoc) {
  // узла, созданного этой же транзакцией, в документе ДО неё нет: берём его из операции,
  // иначе правка печаталась без имени — «Зазор 24» вместо «Зазор 24 в «Карточка»» (п.18)
  const node = nodeById(doc, op.id) || (born && born.get(op.id)) || null;
  let path = String(op.path || '');
  let before = readPath(node, path);
  let after = op.value;
  const nextDoc = afterDoc || doc;
  // круг 37: положение — парой «x, y»: сдвиг по одной оси иначе читался одним числом без оси
  if (path !== 'pos' && before && after && typeof before === 'object' && typeof after === 'object'
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
  const word = (v, d) => {
    // круг 37: поворот — градусами, непрозрачность — процентами; снятое поле — его умолчание
    if (path === 'rotate') return SHELL.rotateWord(v ?? 0);
    if (path === 'opacity') return `${Math.round((typeof v === 'number' ? v : 1) * 100)} %`;
    if (v === undefined || v === null) return notSetWord(label);
    if (table && table[v] !== undefined) return table[v];
    // круг 31: текст — в кавычках: «Текст Привет → Пока» читалось как три слова подряд
    if (typeof v === 'string' && TEXT_LEAF.test(path) && !parseScaleRef(v)) return `«${clip(cleanText(v), 40)}»`;
    return humanValue(v, axis, d);
  };
  const to = word(after, nextDoc);
  // у узла в потоке положения не было: «было → стало» без первой половины непонятно (п.31)
  const wasFree = before === undefined && /^(pos|override)$/.test(path);
  const from = wasFree ? 'по потоку' : (before === undefined ? '' : word(before, doc));
  let value = from && from !== to ? `${from} → ${to}` : to;
  /* Круг 20 (SPEC §6.7): у зазора, отступов и скругления к пикселям дописано, КАК записано
     значение — «Зазор 16 → 24 (шаг шкалы)» либо «24 (мимо шкалы)». Одни и те же пиксели
     ссылкой и числом — разные правки (§6.4), и без пометки они читались бы одинаково. */
  const scale = scaleOfPath(path);
  const mark = scale ? scaleMark(after, scale, nextDoc) : '';
  if (mark) value = `${value} ${mark}`;
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

/**
 * «Шкала отступов 0…64 → 0…72»: у шкал говорит их размах, а не перечень чисел.
 * Круг 20: шкалу правят и по одному шагу (`setToken spacing.6 = 20`) — тогда фраза про
 * сам шаг и про цену правки: «шкала отступов: шаг 16 → 20, переверстано 17 узлов».
 * Цена — по документу ДО правки: сколько узлов ссылалось на этот шаг, столько и поехало.
 * @param {string} scale 'spacing' | 'radii'
 */
function scaleTokenPhrase(word, scale, op, doc) {
  const tokensOf = (doc && doc.tokens) || {};
  const prev = tokensOf[scale];
  const seg = String(op.path || '').split('.');
  if (seg.length === 2 && /^\d+$/.test(seg[1]) && typeof op.value === 'number') {
    const i = Number(seg[1]);
    const was = scaleSteps(doc, scale)[i];
    const now = humanValue(op.value);
    const change = typeof was === 'number' && was !== op.value ? `${humanValue(was)} → ${now}` : now;
    const nodes = new Set(scaleRefsIn(doc, scale).filter((r) => r.index === i).map((r) => r.id)).size;
    const tail = nodes
      ? `, переверстано ${nodes} ${plural(nodes, 'слой', 'слоя', 'слоёв')}`
      : ' — на него никто не ссылается';
    return `${word}: шаг ${change}${tail}`;
  }
  const next = Array.isArray(op.value) ? op.value : [];
  const was = Array.isArray(prev) ? prev : [];
  if (!next.length) return word;
  // вставка шага (SPEC §6.1) меняет длину шкалы, а не размах — говорим о длине
  if (was.length && next.length !== was.length) {
    return `${word}: ${was.length} → ${next.length} ${plural(next.length, 'шаг', 'шага', 'шагов')}`;
  }
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

  // имена шкал — те же, что у ядра (SCALE_NAMES): «шкала отступов», «шкала скруглений»
  if (bag.spacing.length) out.push(scaleTokenPhrase(SCALE_NAMES.spacing, 'spacing', bag.spacing[0], doc));
  if (bag.radii.length) out.push(scaleTokenPhrase(SCALE_NAMES.radii, 'radii', bag.radii[0], doc));
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
    else if (tops.length) phrases.push(`добавил ${tops.length} ${plural(tops.length, 'слой', 'слоя', 'слоёв')}${tail}`);
  }
  if (removes.length === 1) phrases.push(`удалил «${titleOf(removes[0].id)}»`);
  else if (removes.length) phrases.push(`удалил ${removes.length} ${plural(removes.length, 'слой', 'слоя', 'слоёв')}`);
  if (moves.length === 1) {
    const to = placeOf(moves[0].parent);
    phrases.push(`перенёс «${titleOf(moves[0].id)}»${to ? ` в «${to}»` : ''}`);
  } else if (moves.length) {
    phrases.push(`перенёс ${moves.length} ${plural(moves.length, 'слой', 'слоя', 'слоёв')}`);
  }

  /* Круг 20. Ссылки в «стало» разрешаем по документу, в котором уже стоят новые шкалы этой
     же транзакции: после вставки шага прежняя «spacing.7» — это новая «spacing.8», и обе
     дают 16, а не 16 → 20 (см. describeSet). Правок шкал в транзакции обычно нет — тогда
     это тот же документ. */
  let afterDoc = doc;
  if (tokens.length) {
    try { const r = applyOps(doc, tokens); if (!r.error) afterDoc = r.doc; } catch { /* останемся на прежнем */ }
  }
  // одинаковую правку у нескольких узлов сводим в одну строку
  const groups = new Map();
  const stateSets = [];   // круг 36: правки состояний и движения — своими фразами ниже
  const vectorSets = [];  // круг 37: правки контуров — по вектору до/после, своими фразами
  for (const op of sets) {
    if (SHELL.isStatePath(op.path)) { stateSets.push(op); continue; }
    if (SHELL.isVectorPath(op.path)) { vectorSets.push(op); continue; }
    /* Круг 27, п.7: переименование — одним глаголом. «Имя Шапка → Шапка 1 Ани в «Шапка»»
       было тремя именами подряд без кавычек, и место правки повторяло старое имя. */
    if (op.path === 'name' && doc && doc.nodes && doc.nodes[op.id] && !born.has(op.id)) {
      const was = cleanText(doc.nodes[op.id].name || '') || titleOf(op.id);
      const now = cleanText(op.value == null ? '' : String(op.value));
      if (now && was !== now) { phrases.push(`переименовал «${clip(was, 40)}» в «${clip(now, 40)}»`); continue; }
    }
    const d = describeSet(op, doc, born, afterDoc);
    const g = groups.get(d.key) || { label: d.label, value: d.value, nodes: [] };
    if (d.node) g.nodes.push(d.node);
    groups.set(d.key, g);
  }
  for (const g of groups.values()) {
    const uniq = [...new Set(g.nodes)];
    if (uniq.length === 1) phrases.push(`${g.label} ${g.value} в «${uniq[0]}»`);
    else if (uniq.length > 1) phrases.push(`${g.label} ${g.value} у ${uniq.length} ${plural(uniq.length, 'слоя', 'слоёв', 'слоёв')}`);
    else phrases.push(`${g.label} ${g.value}`);
  }
  /* Круг 36 (SPEC §11.4): «Наведение «Кнопка»: подъём 2 px, тень средняя, 120 мс» — по слою
     до и после, а не по путям: одинаково звучат правка поля и запись состояния целиком. */
  if (stateSets.length) {
    const byId = new Map();
    for (const op of stateSets) { if (!byId.has(op.id)) byId.set(op.id, []); byId.get(op.id).push(op); }
    for (const [id, list] of byId) {
      const before = nodeById(doc, id) || born.get(id) || null;
      let after = before || {};
      for (const op of list) after = SHELL.setLocal(after, op.path, op.value);
      const said = SHELL.stateEditPhrases(before, after, titleOf(id), {
        tokens: (afterDoc && afterDoc.tokens) || doc.tokens, colorWord: (v) => humanValue(v),
      });
      for (const p of said) phrases.push(p);
    }
  }
  /* Круг 37 (SPEC §12.3): «Заливка всех контуров «Тело»: #8BD3C7 → #F4A261», «Контур 3
     «Глаз»: обводка нет → #14161C» — по вектору до и после, как состояния выше. */
  if (vectorSets.length) {
    const byId = new Map();
    for (const op of vectorSets) { if (!byId.has(op.id)) byId.set(op.id, []); byId.get(op.id).push(op); }
    for (const [id, list] of byId) {
      const before = nodeById(doc, id) || born.get(id) || null;
      let after = before || {};
      for (const op of list) after = SHELL.setLocal(after, op.path, op.value);
      const said = SHELL.vectorEditPhrases(before, after, titleOf(id), {
        colors: ((afterDoc && afterDoc.tokens) || doc.tokens || {}).colors, colorWord: (v) => humanValue(v),
      });
      for (const p of said) phrases.push(p);
    }
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
  // перерисовка по смене вида: панели не двигались — берём прошлый замер (круг 27, п.8)
  const key = `insets${opts.forFit ? 1 : 0}${opts.noMsg ? 1 : 0}`;
  if (viewChromeQuick && layoutMemo.has(key)) return { ...layoutMemo.get(key) };
  const got = measureInsets(opts);
  layoutMemo.set(key, got);
  return { ...got };
}

function measureInsets(opts = {}) {
  const out = { top: 0, right: 0, bottom: 0, left: 0, bottomWanted: 0 };
  const host = (stage && stage.el) || dom.canvas;
  if (!host || typeof host.getBoundingClientRect !== 'function') return out;
  const base = host.getBoundingClientRect();
  // тот же замер — и положение холста для canvasFrame (круг 27, п.8)
  layoutMemo.set('frame', { left: base.left, top: base.top });
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
 * Круг 27, п.8. Кнопка «Вписать», пустое состояние и чужие рамки зависят от вида — но
 * считать их на КАЖДОЕ событие колёсика нельзя: замер холста после смены viewBox
 * заставлял браузер тут же переложить весь SVG (на 10 000 узлов — 130–250 мс на событие,
 * колёсико шло рывками). Теперь — один раз за кадр, и размер холста берётся из
 * ResizeObserver: вид меняет только viewBox, а не размер холста.
 */
let viewChromeFrame = 0;
let viewChromeFull = false;  // перерисовку просил не только вид: панели могли сдвинуться — мерить заново
let viewChromeSize = null;   // {w, h} холста по ResizeObserver; null — не знаем, меряем
function scheduleViewChrome({ full = false } = {}) {
  if (full) viewChromeFull = true;
  if (viewChromeFrame) return;
  const run = () => {
    viewChromeFrame = 0;
    viewChromeQuick = !viewChromeFull && !!viewChromeSize;
    viewChromeFull = false;
    try {
      // на кнопке видно, вписано сейчас или масштаб ручной (п.18)
      updateFitButton();
      if (dom['empty-state'] && !dom['empty-state'].hidden) renderEmptyState();
      // чужие рамки живут в экранных координатах — при зуме и панораме их надо переставить
      if (server) renderPresence();
    } finally { viewChromeQuick = false; }
  };
  if (typeof requestAnimationFrame !== 'function') { run(); return; }
  viewChromeFrame = requestAnimationFrame(run);
}
let viewChromeQuick = false;

/**
 * Видимая область холста. Сцена отдаёт viewportRect() в координатах окна, а накладки
 * оболочки лежат внутри холста, поэтому начало координат здесь всегда 0,0 — как у toScreen().
 */
function stageViewport() {
  /* Перерисовка по смене вида: размер холста от зума и панорамы не меняется — берём прошлый
     замер или размер от ResizeObserver, а не перекладываем SVG ради замера (круг 27, п.8). */
  if (viewChromeQuick) {
    const m = layoutMemo.get('vp');
    if (m) return { ...m };
    if (viewChromeSize) return { x: 0, y: 0, w: viewChromeSize.w, h: viewChromeSize.h };
  }
  const got = measureViewport();
  layoutMemo.set('vp', got);
  return { ...got };
}

function measureViewport() {
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
 * Замеры панелей и холста, которые от вида (зум, панорама) не зависят: последний замер.
 * Сбрасываются, как только ResizeObserver или окно сказали, что что-то сдвинулось.
 */
const layoutMemo = new Map();

/** Посчитать fn, беря замеры панелей из памяти: между замером и fn менялся только вид. */
function withViewMemo(fn) {
  const was = viewChromeQuick;
  viewChromeQuick = true;
  try { return fn(); } finally { viewChromeQuick = was; }
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
  const wanted = ids && ids.length ? ids : fitAllIds();
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
  // замеры панелей только что сделаны, менялся лишь вид — не перекладываем SVG (круг 27, п.8)
  withViewMemo(() => updateFitButton());
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
  const abs = fitAllIds();
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
  // ширина холста — из ResizeObserver, когда она известна: clientWidth после смены вида
  // перекладывал весь SVG (круг 27, п.8)
  const canvasW = viewChromeSize ? viewChromeSize.w : (dom.canvas ? dom.canvas.clientWidth : 0);
  const short = isNarrow() || (dom.canvas && canvasW < 520);
  let label = 'Вписать';
  if (many && scope === 'all' && !short) label = 'Вписать доску';
  else if (many && scope === 'one' && !short) label = 'Вписать всё';
  if (btn.textContent !== label) btn.textContent = label;
  btn.dataset.fit = scope ? (many ? scope : 'plain') : 'off';
  const name = act ? nodeTitleById(state.doc, act) : '';
  const now = scope === 'all'
    ? 'Сейчас в кадре все доски целиком.'
    : scope === 'one'
      ? `Сейчас в кадре${name ? ` «${name}»` : ' активная доска'} целиком.`
      : 'Сейчас в кадр помещается не всё.';
  const next = !many
    ? 'Нажмите, чтобы вписать макет в свободную часть холста.'
    : scope === 'all'
      ? `Нажмите, чтобы вписать${name ? ` «${name}»` : ' активную доску'}.`
      : scope === 'one'
        ? 'Нажмите, чтобы показать все доски.'
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
  // на широком экране шторка и док не встречаются — переменную держим нулевой и док не
  // меряем (замер посреди перекладки холста стоил 100–300 мс на большом документе, круг 27);
  // но если инспектор стал нижним листом, док поднят и здесь (круг 16, п.1)
  if (isNarrow() || inspIsSheet()) {
    const r = dom.dock.getBoundingClientRect();
    const vh = globalThis.innerHeight || 0;
    if (r.height && vh) gap = Math.max(0, Math.round(vh - r.top) + 8);
  }
  const now = root.style.getPropertyValue('--dock-gap');
  const next = `${gap}px`;
  if (now !== next) root.style.setProperty('--dock-gap', next);
}

/** Экранное положение холста: рельс — колонка сетки, и левый край холста переезжает. */
function canvasFrame() {
  if (viewChromeQuick && layoutMemo.has('frame')) return { ...layoutMemo.get('frame') };
  const host = (stage && stage.el) || dom.canvas;
  const r = host && host.getBoundingClientRect ? host.getBoundingClientRect() : null;
  const got = { left: r ? r.left : 0, top: r ? r.top : 0 };
  layoutMemo.set('frame', got);
  return { ...got };
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
  // зовётся сразу после смены вида: панели не двигались — замеры из памяти (круг 27, п.8)
  withViewMemo(() => {
    state.freeArea = freeAreaNow();
    state.freeBox = overlayBox(FIT_BASIS);
    state.viewAnchor = fitAnchor();
  });
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
  withViewMemo(() => updateFitButton());
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
  withViewMemo(() => updateFitButton());
}

/**
 * Помещается ли целиком то, по чему в последний раз вписывали. Мера та же, что у
 * fitScopeNow: настоящее свободное поле холста, без куска под доком.
 */
function fitTargetVisible() {
  const fit = state.lastFit;
  if (!fit || !stage || !state.doc || !viewIsSane(stage.view) || typeof stage.toScreen !== 'function') return true;
  const rects = (state.geo && state.geo.rects) || {};
  const ids = (fit.ids && fit.ids.length ? fit.ids : fitAllIds())
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
/**
 * Что значит «весь документ» для вписывания (круг 29, п.7): доски и компоненты библиотеки.
 * Библиотека рисуется на холсте под досками (SPEC §5.3); вписывание по одним доскам
 * оставляло её верх выглядывать из-под подсказок и командной строки.
 */
function fitAllIds() {
  const ids = artboards(state.doc).map((a) => a.id);
  const lib = state.doc ? libraryNode(state.doc) : null;
  const rects = (state.geo && state.geo.rects) || {};
  if (lib && Array.isArray(lib.children)) for (const c of lib.children) if (finiteRect(rects[c])) ids.push(c);
  return ids;
}

function fitSmart(opts = {}) {
  const abs = fitAllIds();
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
const LOUD_ISSUES = new Set([
  'overflow', 'out-of-parent', 'zero-size',
  /* Круг 19, п.7. Из четырёх новых кодов показываем ВСЕ четыре, но не потому, что их
     четыре, а потому, что каждый из них человек видит на холсте и без нас — и без
     подписи гадает, что случилось:
       dead-instance   — экземпляр не рисуется вовсе (компонент удалили),
       component-cycle — компонент не раскрывается (сам в себе),
       instance-too-deep — раскрытие обрывается на восьмом уровне, дальше пусто,
       unknown-prop    — значение в экземпляре есть, а действия от него нет.
     Последний — единственный тихий: на холсте всё цело, просто правка не применяется,
     и сказать о нём тем более некому. Замечание держится, пока держится причина. */
  'dead-instance', 'unknown-prop', 'component-cycle', 'instance-too-deep',
  /* Круг 20, п.5 (SPEC §6.1). dead-scale-ref — ссылка на шаг, которого в шкале нет: решатель
     считает такой отступ нулём, и человек видит на холсте схлопнувшийся зазор, не понимая
     почему. Замечание громкое — оно единственное объясняет картинку. Соседний off-scale
     (число мимо шкалы, info) громким НЕ делаем: это не поломка, а выбор, и о нём говорит
     сам инспектор пометкой «мимо шкалы» у поля — второй голос был бы нытьём. */
  'dead-scale-ref',
]);

/** Чем начинается фраза о замечании: раскладка и компоненты — разные разговоры (п.7). */
const COMPONENT_ISSUES = new Set(['dead-instance', 'unknown-prop', 'component-cycle', 'instance-too-deep']);
const issueTopic = (code) => (COMPONENT_ISSUES.has(code) ? 'Компоненты' : 'Раскладка');

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

/**
 * Замечание словами. Ядро подписывает узел его именем, а безымянный — идентификатором
 * (`node.name || id`), и человек читал «i_2l998v выходит за «Сводка недели»». Безымянных
 * узлов стало заметно больше: экземпляр, поставленный из библиотеки, своего имени не
 * заводит — его зовут именем компонента. Подставляем то же имя, каким узел подписан
 * всюду ещё (круг 19, п.7). Чего в документе нет (мёртвая ссылка dead-instance) —
 * оставляем как есть: это и есть ответ на вопрос «чего именно нет».
 */
function issueText(note) {
  // круг 20, п.5: dead-scale-ref пишет «layout.gap → шага «spacing.99» нет» — путь и ссылку
  // переводим в слова инспектора («зазор», «№99») тем же переводчиком, что реплики агента
  /* Круг 39 (UX): «на 58.29×0» — дробные пиксели и «×0»; размер словами, как в репликах агента
     («на 58 px по ширине»). */
  const t = humanizePaths(shellWord(String((note && note.message) || note || '')))
    .replace(/на\s+(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/g,
      (all, w2, h2) => sizeWords(Number(String(w2).replace(',', '.')), Number(String(h2).replace(',', '.'))))
    /* Круг 41 (UX): «нулевой размер (0×0)» — запись разработчика; человеку — что видно */
    .replace(/(«[^»]*»):\s*нулевой размер\s*\((\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)\)/g, (all, who, w2, h2) => {
      const w0 = Number(String(w2).replace(',', '.')) === 0;
      const h0 = Number(String(h2).replace(',', '.')) === 0;
      return `${who}: ${w0 && h0 ? 'пустой слой — ни ширины, ни высоты' : w0 ? 'слой без ширины' : 'слой без высоты'}, его не видно`;
    });
  if (!state.doc || !state.doc.nodes) return t;
  return t.replace(/«([A-Za-z0-9_]+)»/g, (all, id) => (
    state.doc.nodes[id] ? `«${nodeTitleById(state.doc, id)}»` : all));
}

/**
 * Круг 19, п.8. В документе и в ядре объявленное поле зовётся «пропс» (так его называет
 * SPEC §5.4), а на экране у нас — «свойство»: в панели стоит «Что можно менять», рядом
 * «Объявить свойство», и одно и то же не может зваться двумя словами в одном окне.
 * Слово меняем ровно там, где чужой текст попадает человеку на глаза, — в замечаниях
 * валидатора и в причинах отказа операции; сам документ и ядро мы не трогаем.
 */
function shellWord(text) {
  return String(text || '')
    // «пропс» мужского рода, «свойство» — среднего: где за словом идёт сказуемое,
    // меняем пару целиком, иначе выйдет «свойство должен быть объектом»
    .replace(/пропс должен/gi, 'свойство должно')
    // \b в JS считает границей только ASCII — с кириллицей он не срабатывает вовсе
    .replace(/пропс([а-яё]*)/gi, (all, tail) => {
      const base = /^[А-ЯЁ]/.test(all) ? 'Свойств' : 'свойств';
      // пропс→свойство, пропса→свойства, пропсы→свойства, пропсов→свойств, пропсом→свойством
      const map = { '': 'о', 'а': 'а', 'у': 'у', 'ом': 'ом', 'е': 'е', 'ы': 'а', 'ов': '', 'ам': 'ам', 'ами': 'ами' };
      return base + (map[tail.toLowerCase()] !== undefined ? map[tail.toLowerCase()] : 'о');
    });
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
let issueToast = null;   // круг 39: {el, keys} — тост раскладки и замечания, о которых он
function announceIssues(fresh) {
  if (!fresh.length) return;
  const first = fresh[0];
  const more = fresh.length > 1 ? ` · и ещё ${fresh.length - 1}` : '';
  // круг 19, п.7: «Раскладка: компонента в документе нет» звучало бы небылицей —
  // у замечаний о компонентах свой зачин
  if (issueToast && issueToast.el) issueToast.el.remove();
  const el = toast(`${issueTopic(first.code)}: ${clip(issueText(first), 84)}${more}`, 'warn', 8000);
  issueToast = { el, keys: fresh.map(issueKey) };
}
const issueKey = (n) => `${n.nodeId}|${n.code}|${n.message}`;
/**
 * Круг 39 (UX): замечание, о котором говорит тост, ушло (отмена, следующая правка) — тост
 * уходит сразу, а не висит свои 8 с поверх уже целой раскладки.
 */
function dropResolvedIssueToast() {
  const t = issueToast;
  if (!t) return;
  if (!t.el || !t.el.isConnected) { issueToast = null; return; }
  const live = new Set();
  for (const list of state.issues.values()) for (const n of list) live.add(issueKey(n));
  if (!t.keys.some((k) => live.has(k))) { t.el.remove(); issueToast = null; }
}

let issuesGeo = null;   // геометрия, по которой посчитаны state.issues
/* Круг 29, п.9. Большой документ: каждая раскладка холста стоит сотни миллисекунд (SVG-текст
   перекладывается целиком). Колонки сетки въезжали анимацией (.18 с), и появление
   инспектора давало пять-шесть раскладок подряд — по одной на кадр анимации; прокрутка
   рельса к строке слоя заставляла раскладку ещё и синхронно. В «тяжёлом» режиме колонки
   меняются сразу, а прокрутка рельса ждёт кадра. */
const HEAVY_NODES = 3000;
function markHeavy() {
  const n = state.doc && state.doc.nodes ? Object.keys(state.doc.nodes).length : 0;
  const heavy = n >= HEAVY_NODES ? 'on' : '';
  if (dom.app && (dom.app.dataset.heavy || '') !== heavy) dom.app.dataset.heavy = heavy;
}
function docIsHeavy() {
  return !!(dom.app && dom.app.dataset.heavy === 'on');
}

/* Круг 41: основы имён слоёв для «/выделить …» — частями в простое после перерисовки (на 20 тыс.
   слоёв первое выделение по имени иначе считало их все разом, ~0,1 с на Enter). */
let nameWarm = null;
function warmNamesSoon() {
  const doc = state.doc;
  if (!doc || !doc.nodes || (nameWarm && nameWarm.doc === doc)) return;
  if (nameWarm && nameWarm.handle) (globalThis.cancelIdleCallback || clearTimeout)(nameWarm.handle);
  const job = { doc, ids: null, next: 0, handle: null };
  nameWarm = job;
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  const step = () => {
    job.handle = null;
    if (nameWarm !== job) return;
    const r = SHELL.warmNameStems(job.doc, { from: job.next, count: 1500, ids: job.ids });
    job.ids = r.ids;
    job.next = r.next;
    if (job.next < job.ids.length) job.handle = idle(step);
  };
  job.handle = idle(step);
}

function renderAll(opts = {}) {
  markHeavy();
  warmNamesSoon();
  // та же геометрия (переименование) — раскладка та же: проверку досчитаем в простое
  if (state.geo && state.geo === issuesGeo) refreshIssuesSoon();
  else state.issues = layoutIssues(state.doc, state.geo);
  issuesGeo = state.geo;
  dropResolvedIssueToast();
  /* На холсте мог стоять предпросмотр варианта. Любая перерисовка документа (отмена,
     правка руками, возврат истории) снимает его — иначе холст показывает документ,
     а плашка сверху уверяет «Вариант 1 — предпросмотр», и «Взять этот» упирается
     в «документ изменился» (круг 11, п.4). */
  unpeekVariant();
  ensureDocFonts(state.doc);
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
  // кнопка вида — в ближайшем кадре: замер холста здесь заставлял браузер раскладывать SVG
  // посреди перерисовки, а потом ещё раз после вписывания (круг 27, п.8)
  scheduleViewChrome({ full: true });
  setDocNameText(docTitle());
  // чужие рамки считаются по той же геометрии — перерисовка холста перерисовывает и их;
  // своё присутствие (выделение и активная доска) уходит другим — реплика не шлёт одно и то же дважды
  if (server) { renderPresence(); sharePresence(); }
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
  /* Имя то же — прокрутку не трогаем: чтение scrollLeft на каждой перерисовке заставляло
     браузер раскладывать весь холст посреди кадра (на 10 000 узлов — 0,4 с; круг 27, п.8). */
  if (el.textContent === name && el.title === name) return;
  if (el.textContent !== name) el.textContent = name;
  /* В покое имя обрезано многоточием, и прочитать его целиком было негде: title не
     было вовсе. Теперь полное имя всегда под курсором и у экранного диктора (п.6). */
  el.title = name;
  el.setAttribute('aria-label', `Имя документа: ${name}`);
  // круг 27, I4: и во вкладке браузера — имя проекта, а не просто «Imago Studio»
  try { document.title = name ? `${name} — Imago Studio` : 'Imago Studio'; } catch { /* без документа */ }
  resetDocNameScroll();
}

function resetDocNameScroll() {
  const el = dom.docname;
  if (!el) return;
  // Chrome возвращает прокрутку на следующем кадре, если каретка ещё в конце строки; читаем
  // в кадре, а не сразу — синхронное чтение scrollLeft раскладывало страницу (круг 27, п.8)
  if (typeof requestAnimationFrame !== 'function') { if (el.scrollLeft) el.scrollLeft = 0; return; }
  requestAnimationFrame(() => {
    if (el.scrollLeft) el.scrollLeft = 0;
    requestAnimationFrame(() => { if (el.scrollLeft) el.scrollLeft = 0; });
  });
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
  /* Круг 33, п.1. Человек печатает в инспекторе — выделение от агента (итог его правки)
     не перехватывает панель: иначе поле сменялось полем другого слоя посреди слова, и
     остаток набора уходил в имя новой доски. Рамки правки на холсте агент покажет и так. */
  if (opts.agent === true && inspFocused()) return;
  /* Круг 36: в просмотре выделения нет. Итог правки агента выделения не ставит (просмотр
     остаётся), а выбор слоя человеком (рельс, «выдели …») — это возврат к правке. */
  if (previewOn() && Array.isArray(ids) && ids.length) {
    if (opts.agent === true) return;
    setPreview(false, { restore: false });
  }
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
  // круг 22: выделение видно другим участникам
  if (server) sharePresence();
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
  withViewMemo(() => updateFitButton());
}

/* ------------------------------ пустое состояние ----------------------------- */

/* Круг 37 (SPEC §12.2): агент рисует иллюстрации — это надо показать там, где человек
   решает, с чего начать. */
const EMPTY_EXAMPLES = [
  'экран оплаты с полем карты и итогом',
  'карточка товара с фото и кнопкой',
  'нарисуй милого монстра',
];
const ARTBOARD_EXAMPLES = [
  'добавь шапку с заголовком и датой',
  'список из трёх карточек',
  'нарисуй милого монстра',
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
  // круг 22: проект ещё не открыт (ждём журнал или сервер) — холст пуст не потому, что нечего строить;
  // круг 39 (N6а): и до первого hello — копия из журнала могла отстать от сервера
  if ((server && !(server.sync && server.sync.view)) || projectConnecting()) { host.hidden = true; return; }
  const empty = docIsEmpty();
  const blank = !empty && activeArtboardIsEmpty();
  host.hidden = !(empty || blank);
  host.dataset.kind = empty ? 'doc' : 'artboard';
  // карточка на холсте и приветствие в доке — один и тот же текст с одними чипами,
  // и стрелка «командная строка внизу» указывала на копию самой себя: носитель
  // остаётся один, и это карточка на холсте (п.6)
  if (!host.hidden && state.introOpen) hideMsg();
  if (host.hidden) return;

  dom['empty-title'].textContent = empty ? 'Скажите, что построить' : 'Доска пуста';
  dom['empty-sub'].textContent = empty
    ? 'Агент соберёт макет и покажет, что сделал.'
    : 'Скажите, что должно быть на ней.';
  const list = empty ? EMPTY_EXAMPLES : ARTBOARD_EXAMPLES;
  const box = dom['empty-examples'];
  box.textContent = '';
  for (const ex of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'empty-example';
    b.textContent = ex;
    /* Круг 18, п.4. В голосовой сессии командной строки нет, и «подставить в строку»
       было бы действием в никуда: пример просто выполняется — это и значит его нажать. */
    b.addEventListener('click', () => {
      if (dom.app.dataset.voice === 'on') { runUtterance(ex); return; }
      dom.command.value = ex; dom.command.focus();
    });
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
/* Ширина ряда вкладок по ResizeObserver (0 — ещё не знаем) и место под одну вкладку,
   «+» и «ещё N» — по стилям .tab (круг 27, п.7). */
let tabsRowW = 0;
const TAB_SLOT = 100;
const TAB_ADD_SLOT = 34;
const TAB_MORE_SLOT = 62;

/** Сколько вкладок показать из n: все, если влезают, иначе — сколько влезет рядом с «ещё N». */
function tabsThatFit(n) {
  if (!tabsRowW) return Math.min(n, MAX_TABS);
  const all = Math.floor((tabsRowW - TAB_ADD_SLOT) / TAB_SLOT);
  if (n <= Math.min(all, MAX_TABS)) return n;
  return Math.max(1, Math.min(MAX_TABS, Math.floor((tabsRowW - TAB_ADD_SLOT - TAB_MORE_SLOT) / TAB_SLOT)));
}

function watchTabsRow() {
  const host = dom['artboard-tabs'];
  if (!host || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    const w = Math.round((e && e.contentRect && e.contentRect.width) || 0);
    if (Math.abs(w - tabsRowW) < 4) return;
    if (!state.doc) { tabsRowW = w; return; }
    const n = artboards(state.doc).length;
    const before = tabsThatFit(n);
    tabsRowW = w;
    if (tabsThatFit(n) !== before) renderTabs();
  }).observe(host);
}

/**
 * Круг 18, п.5. «Непонятно, как создавать новые доски»: кнопка была в трёх местах и
 * ни одно из них не оказалось тем самым. Теперь «+» стоит в ряду вкладок — там, где
 * человек и так переключается между досками. Кнопка из подвала рельса и кнопка из
 * панели вида убраны: подвал рельса лежит под прокручиваемым списком слоёв (на длинном
 * документе его просто не видно), а панель вида прячет свои крайние кнопки, как только
 * холст уже 520 px, — то есть ровно тогда, когда место дорого. В пустом состоянии
 * кнопка осталась: там ей и место, и ряда вкладок ещё нет.
 */
function addTabPlus(host) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tab add';
  b.title = 'Новая доска';
  b.setAttribute('aria-label', 'Новая доска');
  b.appendChild(iconEl('plus'));
  b.addEventListener('click', () => addArtboard());
  host.appendChild(b);
}

function renderTabs() {
  const host = dom['artboard-tabs'];
  host.textContent = '';
  const list = artboards(state.doc);
  const activeId = activeArtboardId();
  host.dataset.mode = isNarrow() ? 'pick' : 'tabs';
  if (!list.length) { addTabPlus(host); return; }

  // на узком экране ряд вкладок не помещается — но переключать экраны всё равно надо (п.6)
  if (isNarrow()) {
    const active = list.find((a) => a.id === activeId) || list[0];
    const b = document.createElement('button');
    b.className = 'tab pick';
    b.title = 'Выбрать доску';
    b.setAttribute('aria-haspopup', 'dialog');
    const name = document.createElement('span');
    name.className = 'pick-name';
    name.textContent = active.name || defaultName(active);
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
    addTabPlus(host);
    return;
  }

  let shown = list;
  let rest = [];
  /* Круг 27, п.7. Сколько вкладок влезает — по ширине ряда (её отдаёт ResizeObserver, без
     замера посреди перерисовки): лишние уходят в «ещё N», а не обрезаются краем ряда, и
     «+» не уезжает за край. */
  const fit = tabsThatFit(list.length);
  if (list.length > fit) {
    /* Окно вкладок — непрерывный кусок списка вокруг активного. Раньше показывались
       первые семь, а активный просто приписывался в конец: при 16 артбордах ряд шёл
       «3 4 5 6» и вдруг «18», и пропуск читался как пропажа экранов (круг 15, п.11). */
    const at = Math.max(0, list.findIndex((a) => a.id === activeId));
    const from = Math.max(0, Math.min(at - Math.floor((fit - 1) / 2), list.length - fit));
    shown = list.slice(from, from + fit);
    rest = list.filter((a) => !shown.includes(a));
  }

  for (const ab of shown) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = ab.name || defaultName(ab);
    b.title = ab.name || defaultName(ab);
    b.setAttribute('aria-current', String(ab.id === activeId));
    b.addEventListener('click', () => { setSelection([ab.id]); fitView([ab.id]); });
    host.appendChild(b);
  }
  if (rest.length) {
    const more = document.createElement('button');
    more.className = 'tab more';
    more.textContent = `ещё ${rest.length}`;
    more.title = 'Показать остальные доски';
    more.addEventListener('click', () => openArtboardList(rest));
    host.appendChild(more);
  }
  addTabPlus(host);
}

/** Список досок: и для не поместившихся вкладок, и для узкого экрана. */
function openArtboardList(list) {
  const activeId = activeArtboardId();
  openSheet('Доски', (body) => {
    for (const ab of list) {
      const b = document.createElement('button');
      b.className = 'btn subtle wide ablist';
      b.style.justifyContent = 'flex-start';
      b.setAttribute('aria-current', String(ab.id === activeId));
      b.textContent = ab.name || defaultName(ab);
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
  const list = artboards(state.doc);
  const first = state.selection[0];
  if (first) {
    let n = nodeById(state.doc, first);
    while (n && n.parent && n.parent !== state.doc.root) n = nodeById(state.doc, n.parent);
    /* Круг 19, п.2. Подъём до ребёнка корня доходит и до БИБЛИОТЕКИ: выделили компонент —
       и «активной доской» становилась она. Это не мелочь: отсюда кормятся вкладки,
       «Вписать», и главное — экспорт, который предложил бы сохранить библиотеку как
       доску (SPEC §5.3: библиотека доской не считается нигде). Выделение внутри
       библиотеки активной доски не меняет — берём первую настоящую. */
    if (n && isArtboard(state.doc, n)) return n.id;
  }
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
  /* Круг 39 (N6а): проект ещё не прочитан — «Слоёв пока нет» и «Компонентов пока нет» были
     бы неправдой о документе, которого ещё не видно. */
  if (serverBooting || (server && !(server.sync && server.sync.view))) {
    const note = document.createElement('div');
    note.className = 'layers-empty';
    note.textContent = server && server.listWait ? 'Проект не открыт.'
      : engineHalted() ? 'Проект пока не открыть: сервер ещё на прежней версии редактора.' : 'Подключаюсь к проекту…';
    host.appendChild(note);
    host.removeAttribute('aria-activedescendant');
    return;
  }

  const lib = libraryNode(state.doc);
  const rows = [];
  const walk = (id, depth) => {
    const n = nodeById(state.doc, id);
    if (!n) return;
    // библиотека — не доска: её группа собирается ниже, отдельно (круг 19, п.2)
    if (lib && id === lib.id) return;
    const isPage = n.type === 'page';
    if (!isPage) rows.push({ id, depth, node: n });
    const kids = n.children || [];
    if (!isPage && set.has(id)) return;
    for (const c of kids) walk(c, isPage ? 0 : depth + 1);
  };
  walk(state.doc.root, 0);
  const boardRows = rows.length;

  /* Круг 19, п.2. Прежний обход пропускал страницы, но обходил их ДЕТЕЙ, и компоненты
     («Кнопка», «Метка», «Карточка показателя») стояли в одном столбце с досками, ничем от
     них не отличаясь: по рельсу нельзя было понять, что доска, а что заготовка. Теперь у
     библиотеки своя группа внизу списка — заголовок-ветка, под ним компоненты. Заголовок
     не выделяется (страницу правят не в инспекторе): щелчок по нему складывает группу. */
  if (lib) rows.push({ id: lib.id, depth: 0, node: lib, lib: true });
  const libOpen = lib && !set.has(lib.id);
  if (libOpen) for (const c of (lib.children || [])) walk(c, 1);

  if (!rows.length) {
    const note = document.createElement('div');
    note.className = 'layers-empty';
    note.textContent = 'Слоёв пока нет.';
    host.appendChild(note);
    host.removeAttribute('aria-activedescendant');
    return;
  }
  // досок нет, а библиотека есть всегда: без этой строки пустой документ выглядел бы так,
  // будто в нём одна библиотека и есть
  if (!boardRows) {
    const note = document.createElement('div');
    note.className = 'layers-empty';
    note.textContent = 'Слоёв пока нет.';
    host.appendChild(note);
  }

  // roving tabindex: в табуляцию попадает ровно одна строка
  if (!rows.some((r) => r.id === state.railFocus)) {
    const sel = rows.find((r) => state.selection.includes(r.id));
    state.railFocus = sel ? sel.id : rows[0].id;
  }

  for (const r of rows) {
    const n = r.node;
    const row = document.createElement('div');
    // заголовок группы библиотеки оформлен как рубрика, а не как слой (круг 19, п.2)
    row.className = r.lib ? 'layer lib-head' : 'layer';
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

    const nm = document.createElement('span');
    nm.className = 'name';
    // круг 19, п.8: компонент зовут ЕГО именем (component.name) — тем же, что в бейдже
    // экземпляра на холсте и в словаре агента, а не именем узла-заготовки
    const shown = r.lib ? 'Библиотека'
      : isMaster(state.doc, n) ? componentName(n)
        : (n.name || defaultName(n));
    nm.textContent = shown;
    /* Экземпляр в подсказке описан ровно так же, как в словаре агента (SPEC §5.9):
       «Кнопка "Оплатить" вид=accent». Одна строка вместо поддерева — по ней видно,
       чем этот экземпляр отличается от соседнего, не раскрывая ничего. */
    nm.title = r.lib ? 'Компоненты документа: из них собирается продукт'
      : n.type === 'instance' ? (instanceSummary(state.doc, n) || shown)
        : shown;
    if (r.lib) {
      row.append(tw, nm);
    } else {
      const g = document.createElement('span');
      g.className = 'glyph';
      /* Круг 37 (SPEC §12.3): у вектора и иллюстрации — значки, а не буква: «•» вектора
         ничем не отличался от неизвестного узла. Детали иллюстрации подписаны своими
         именами; в подсказке — что это и чем залито. */
      const icon = layerIconFor(n);
      if (icon) { g.appendChild(iconEl(icon)); g.dataset.icon = icon; } else g.textContent = glyphFor(n);
      row.append(tw, g, nm);
      const tip = layerTipFor(n);
      if (tip) nm.title = tip;
    }
    // круг 36: у слоя есть состояния — маленькая метка, по ней видно, что он «живой»
    if (!r.lib && SHELL.hasStates(n)) {
      const t = document.createElement('span');
      t.className = 'tagpill motion';
      t.appendChild(iconEl('motion'));
      const words = SHELL.statesOf(n).map((k) => SHELL.STATE_TITLES[k].toLowerCase()).join(', ');
      t.title = `Состояния: ${words} — видно в режиме «Просмотр» (P)`;
      t.setAttribute('role', 'img');
      t.setAttribute('aria-label', `Есть состояния: ${words}`);
      row.dataset.states = 'on';
      row.appendChild(t);
    }
    /* Круг 19, п.4. Список компонентов должен быть ВИДЕН, а не спрятан за меню: он и есть
       половина смысла работы. Поэтому вставка экземпляра живёт прямо в строке компонента —
       «+» рядом с именем кладёт экземпляр на открытую доску (см. placeInstance). */
    if (!r.lib && isMaster(state.doc, n)) {
      // строке компонента нужен запас под «+» и счётчик: без него они уезжали на вторую
      // строку у длинных имён («Карточка показателя»)
      row.dataset.kind = 'master';
      const used = (state.doc.nodes && Object.values(state.doc.nodes)
        .filter((x) => x && x.type === 'instance' && x.of === r.id).length) || 0;
      if (used) {
        row.dataset.used = 'on';   // строке со счётчиком имени положено меньше: см. styles.css
        const t = document.createElement('span');
        t.className = 'tagpill count';
        /* Только число: с ромбом пилюля шире на 9 px, и при рельсе уже 190 px «+» уезжал
           на вторую строку. Что считается — сказано в подсказке и доступном имени. */
        t.textContent = String(used);
        t.title = `${used} ${plural(used, 'экземпляр', 'экземпляра', 'экземпляров')} на досках`;
        t.setAttribute('role', 'img');
        t.setAttribute('aria-label', t.title);
        row.appendChild(t);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'layer-add';
      /* Стрелка и крестик в строке живут с tabIndex −1: у них есть клавиши (Arrow*, Delete).
         У «+» клавиши нет, и оставить её только мыши нельзя. Поэтому она попадает в
         табуляцию вместе со СВОЕЙ строкой — по правилу roving tabindex: Tab с выделенной
         строки ведёт на её «+», а не пробегает по всем компонентам подряд. */
      add.tabIndex = r.id === state.railFocus ? 0 : -1;
      add.title = `Поставить «${componentName(n)}» на доску`;
      add.setAttribute('aria-label', add.title);
      add.appendChild(iconEl('plus'));
      add.addEventListener('click', (e) => { e.stopPropagation(); placeInstance(r.id); });
      row.appendChild(add);
    }
    if (n.override) {
      const t = document.createElement('span');
      t.className = 'tagpill'; t.textContent = 'вручную';
      row.appendChild(t);
    }
    // замечание раскладки держится, пока держится причина: тост уходит, значок — нет (п.5)
    const bad = state.issues.get(r.id);
    if (bad && bad.length) {
      const words = bad.map(issueText).join(' \u00b7 ');
      const t = document.createElement('span');
      t.className = 'tagpill warn';
      t.textContent = '!';
      t.title = words;
      t.setAttribute('role', 'img');
      // круг 19, п.7: у замечания о компонентах свой зачин — «раскладка» тут ни при чём
      t.setAttribute('aria-label', `${issueTopic(bad[0].code)}: ${words}`);
      row.appendChild(t);
    }
    row.addEventListener('click', (e) => {
      state.railFocus = r.id;
      // заголовок группы не выделяется: щелчок по нему складывает и раскрывает библиотеку
      if (r.lib) { setBranch(r.id, set.has(r.id)); focusLayerRow(r.id); return; }
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

  /* Круг 19, п.1 и п.4. У документа, пришедшего из прежней версии, библиотека пустая:
     заголовок группы без единой строки под ним — тупик, по которому не догадаться, что
     это вообще такое и откуда там берутся компоненты. Пишем прямо, откуда. */
  if (lib && libOpen && !(lib.children || []).length) {
    const hint = document.createElement('div');
    hint.className = 'layers-empty lib-empty';
    hint.textContent = 'Компонентов пока нет. Выделите слой на доске и нажмите «Сделать компонентом» — '
      + 'он переедет сюда, и его можно будет ставить на доски сколько угодно раз.';
    host.appendChild(hint);
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
    // «+» компонента ходит в табуляции за своей строкой (круг 19, п.4)
    const add = row.querySelector('.layer-add');
    if (add && (add.tabIndex === 0) !== focus) add.tabIndex = focus ? 0 : -1;
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
    : `Удалить ${roots.length} ${plural(roots.length, 'слой', 'слоя', 'слоёв')}`;
  // quiet: сообщение говорим тут сами — иначе их будет два, и разными словами (п.10)
  const r = commit(roots.map((id) => OPS.remove(id)), label, 'human', { quiet: true });
  if (!r.ok) return false;
  setSelection([]);
  /* Описание берём у движка — то же самое, что на холсте: было «Удалил «Шапка»» с
     холста и «Удалить «Строка статуса»» из рельса, будто это разные события (п.10). */
  const said = (r.tx && r.tx.human) || label;
  showMsg('plain', said, {
    note: backHint(),
    ms: 9000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
  return true;
}

/** Клавиатура в дереве слоёв: стрелки ходят, Enter выделяет, Delete удаляет. */
function onLayerKey(e, rows, cur) {
  /* Круг 19, п.4. Событие всплывает к строке и с кнопок внутри неё, а Enter здесь гасится
     через preventDefault — и «+» компонента, дойдя до него табуляцией, на Enter не
     срабатывала вовсе: строка съедала нажатие и просто выделяла себя. Клавиши строки —
     дело строки; кнопка внутри отвечает за себя сама. */
  if (e.target !== e.currentTarget) return;
  const idx = rows.findIndex((r) => r.id === cur.id);
  const focusRow = (i) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    state.railFocus = r.id;
    for (const el2 of dom.layers.querySelectorAll('.layer')) {
      const on = el2.dataset.id === r.id;
      el2.tabIndex = on ? 0 : -1;
      const add = el2.querySelector('.layer-add');
      if (add) add.tabIndex = on ? 0 : -1;   // «+» следует за своей строкой (круг 19, п.4)
    }
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
    // заголовок библиотеки не выделяется — он складывается (круг 19, п.2)
    if (cur.lib) { setBranch(cur.id, set.has(cur.id)); focusLayerRow(cur.id); return; }
    setSelection([cur.id]);
    focusRow(idx);   // дерево перерисовалось — без этого фокус падал на <body> (п.9)
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // то же, что Delete на холсте: удаляем выделенное, а если строка не выделена — её саму (п.13)
    e.preventDefault();
    if (cur.lib) return;   // библиотеку удалять нечем: это не слой
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
  for (const other of dom.layers.querySelectorAll('.layer')) {
    other.tabIndex = other === el2 ? 0 : -1;
    const add = other.querySelector('.layer-add');
    if (add) add.tabIndex = other === el2 ? 0 : -1;
  }
  try { el2.focus({ preventScroll: true }); } catch { el2.focus(); }
}

/** Подвести рельс к выделенной строке. */
function revealLayerRow() {
  const id = state.selection[0];
  if (!id || !dom.layers) return;
  const row = dom.layers.querySelector(`.layer[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  /* Круг 29, п.9: scrollIntoView раскладывает документ синхронно — вместе с холстом,
     который выделение только что пометило грязным. На большом документе — после кадра,
     когда раскладка уже сделана и прокрутка стоит копейки. */
  if (docIsHeavy()) {
    requestAnimationFrame(() => setTimeout(() => {
      if (row.isConnected && state.selection[0] === id) row.scrollIntoView({ block: 'nearest' });
    }, 0));
    return;
  }
  row.scrollIntoView({ block: 'nearest' });
}

/* Круг 19, п.2. Экземпляр помечен ТЕМ ЖЕ знаком, что на холсте: Stage._instanceLabel
   рисует в бейдже «◇ Кнопка», и в рельсе он тоже ◇ — иначе один и тот же узел зовётся
   на экране двумя разными значками. Сам компонент — тот же ромб, но закрашенный: это
   заготовка, с которой экземпляры сняты. */
const GLYPH_INSTANCE = '◇';
const GLYPH_MASTER = '◆';

/** Значок строки слоя вместо буквы (круг 37): вектор, иллюстрация — или пусто. */
function layerIconFor(n) {
  if (!n || isArtboard(state.doc, n.id)) return '';
  if (n.type === 'vector') return 'vector';
  if (SHELL.isIllustration(state.doc, n)) return 'illustration';
  return '';
}

/** Подсказка строки слоя у вектора и иллюстрации: что это и сколько в нём деталей. */
function layerTipFor(n) {
  const name = n.name || defaultName(n);
  if (n.type === 'vector') {
    const paths = SHELL.vectorPaths(n);
    const fill = paths.length ? SHELL.paintWord(paths[0].fill, { colors: colorsAt(n), colorWord: (v) => humanValue(v) }) : '';
    const inIll = SHELL.isIllustration(state.doc, nodeById(state.doc, n.parent));
    return `${name} — ${inIll ? 'деталь иллюстрации' : 'вектор'}, ${paths.length} ${plural(paths.length, 'контур', 'контура', 'контуров')}`
      + `${fill && fill !== 'нет' ? `, заливка ${fill}` : ''}`;
  }
  if (SHELL.isIllustration(state.doc, n)) {
    return `${name} — ${illustrationWords(n).toLowerCase()}. Выделяйте, двигайте и перекрашивайте их по одной`;
  }
  return '';
}

/** «Иллюстрация: 19 деталей в 14 слоях» — детали считаются контурами, как у агента. */
function illustrationWords(n) {
  const { parts, layers } = SHELL.illustrationCounts(state.doc, n);
  const tail = layers && layers !== parts ? ` в ${layers} ${plural(layers, 'слое', 'слоях', 'слоях')}` : '';
  return `Иллюстрация: ${parts} ${plural(parts, 'деталь', 'детали', 'деталей')}${tail}`;
}

function glyphFor(n) {
  if (isArtboard(state.doc, n.id)) return '▣';
  if (n.type === 'instance') return GLYPH_INSTANCE;
  if (isMaster(state.doc, n)) return GLYPH_MASTER;
  return ({ frame: '▤', text: 'T', rect: '▭', ellipse: '◯', image: '⬚' })[n.type] || '•';
}
/**
 * Имя-заглушка берём у движка: у оболочки был свой список, и безымянный артборд
 * назывался на холсте «Артборд», а в имени файла и в рельсе — «Группа». Имя у одного
 * узла теперь одно (круг 13, п.11).
 */
function defaultName(n) {
  const name = placeholderName(state.doc, n);
  // круг 37: пока ядро не знает вектора, заглушкой было бы «Узел»
  return n && n.type === 'vector' && name === 'Узел' ? 'Вектор' : name;
}

/* ------------------------------- компоненты ---------------------------------- */

/**
 * Круг 19 (SPEC §5). Сначала библиотека, потом продукт из неё. Оболочка не заводит своих
 * структур: список компонентов считает ядро из детей библиотеки, а каждая правка приходит
 * готовым списком операций и ложится в обычный commit — поэтому отмена достаётся даром.
 *
 * СЛОВО (п.8). В интерфейсе живут три слова: «библиотека», «компонент», «экземпляр».
 * «Мастера» и «инстанса» нет нигде — это слова из кода, и человек ими не говорит.
 * Поле component.props зовём «свойствами»: в инспекторе «свойство» уже значит ровно это.
 */

/** Вид свойства словами: им подписана и строка компонента, и выбор при объявлении. */
const PROP_KIND_WORDS = { text: 'текст', enum: 'выбор', color: 'цвет', number: 'число', bool: 'да/нет' };

/* Значение выбора человеческим словом — теми же таблицами, что подписывают палитру и
   поля инспектора: иначе у компонента стоит «accent | surface», а у экземпляра под тем
   же свойством сегменты «акцент | карточка», и человек не связывает одно с другим. */
const enumWord = (v) => SWATCH_NAMES[v] || VALUE_WORDS[v] || TYPE_LABELS[v] || String(v);

/** Компоненты документа — производная от детей библиотеки, считает ядро (SPEC §5.4). */
function libraryList() {
  try { return libComponents(state.doc) || []; } catch { return []; }
}

/** Лежит ли узел в библиотеке (сам библиотека или внутри неё). */
function inLibrary(id) {
  const n = nodeById(state.doc, id);
  if (!n) return false;
  if (isLibrary(state.doc, n)) return true;
  return ancestors(state.doc, id).some((a) => isLibrary(state.doc, a));
}

/** Абзац-пояснение: та же серая приписка, что и в остальных панелях. */
function noteEl(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

/**
 * Куда встанет новый экземпляр. Выделен контейнер — внутрь него; выделен узел — сразу за
 * ним, у того же родителя; ничего подходящего — в конец открытой доски. В библиотеку
 * экземпляр не кладём никогда: там живут заготовки, а не сборка (SPEC §5.3).
 * @returns {{parent:string, index?:number}|null} null — досок нет вовсе
 */
function instanceHome() {
  const sel = state.selection.filter((id) => nodeById(state.doc, id));
  if (sel.length === 1 && !inLibrary(sel[0])) {
    const n = nodeById(state.doc, sel[0]);
    if (n && n.type === 'frame') return { parent: n.id };
    const p = n ? nodeById(state.doc, n.parent) : null;
    if (p && p.type === 'frame') return { parent: p.id, index: (p.children || []).indexOf(n.id) + 1 };
  }
  const list = artboards(state.doc);
  if (!list.length) return null;
  const act = list.find((a) => a.id === activeArtboardId()) || list[0];
  return { parent: act.id };
}

/** Поставить экземпляр компонента на доску (п.4). */
function placeInstance(masterId) {
  const master = nodeById(state.doc, masterId);
  if (!isMaster(state.doc, master)) return;
  const home = instanceHome();
  if (!home) {
    showMsg('warn', 'Экземпляр положить некуда', {
      note: 'В документе нет ни одной доски. Заведите доску — и компонент встанет на неё.',
      actions: [{ label: 'Пустая доска', primary: true, onClick: () => addArtboard() }],
    });
    return;
  }
  const list = instanceOps(state.doc, { of: masterId, parent: home.parent, index: home.index });
  if (!list.length) {
    showMsg('error', 'Экземпляр не поставить', { note: `«${componentName(master)}» сейчас не компонент библиотеки.` });
    return;
  }
  const born = list[0].node.id;
  // quiet: о правке говорим сами — иначе сообщений будет два, и разными словами
  /* human: describeOps прочитал бы это как «добавил узел» — правда, но не та, которую
     человек только что сделал. Своя строка идёт и в историю, и в «Отменить». */
  const r = commit(list, `Поставить «${componentName(master)}»`, 'human', {
    quiet: true,
    human: `Поставил «${componentName(master)}» в «${nodeTitleById(state.doc, home.parent)}»`,
  });
  if (!r.ok) return;
  setSelection([born]);
  showMsg('plain', `Поставил «${componentName(master)}» в «${nodeTitleById(state.doc, home.parent)}»`, {
    note: `Что у него можно менять — в панели справа. ${backHint()}`,
    ms: 9000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
}

/**
 * Очевидные свойства будущего компонента: текст внутри (п.3). Кнопка без своей подписи
 * как компонент бесполезна — её придётся отсоединять на первом же экране, — поэтому текст
 * предлагаем сразу и включённым. Остальное объявляется позже, у самого компонента: гадать
 * за человека, какая заливка «вид», а какая просто заливка, оболочка не берётся.
 * @returns {Array<{name:string,kind:string,target:string,path:string,sample:string}>}
 */
function suggestProps(doc, id) {
  const texts = [];
  for (const nid of subtreeIds(doc, id)) {
    const n = nodeById(doc, nid);
    if (n && n.type === 'text' && nid !== id) texts.push(n);
  }
  const used = new Set();
  const out = [];
  for (const n of texts.slice(0, 4)) {
    // один текст внутри — это и есть «текст» компонента; несколько — зовём их своими именами
    let name = texts.length === 1 ? 'текст' : String(n.name || '').trim().toLowerCase();
    if (!name || name.length > 24 || used.has(name)) name = `текст ${out.length + 1}`;
    if (used.has(name)) continue;
    used.add(name);
    out.push({ name, kind: 'text', target: n.id, path: 'characters', sample: String(n.characters || '') });
  }
  return out;
}

/** Пилюля-выбор: то же согласие «да/нет», что сегменты, но списком (п.3). */
function pickPill(label, sample, on, onToggle) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pickpill';
  b.setAttribute('aria-pressed', String(on));
  const box = document.createElement('span');
  box.className = 'pickpill-box';
  box.setAttribute('aria-hidden', 'true');
  const t = document.createElement('span');
  t.className = 'pickpill-text';
  t.textContent = label;
  b.append(box, t);
  if (sample) {
    const s = document.createElement('span');
    s.className = 'pickpill-sample';
    s.textContent = sample;
    b.appendChild(s);
  }
  b.addEventListener('click', () => {
    const now = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(now));
    onToggle(now);
  });
  return b;
}

/** Спросить имя и что можно будет менять — и сделать узел компонентом (п.3). */
function openMakeComponent(id) {
  const node = nodeById(state.doc, id);
  if (!node) return;
  const can = canMakeComponent(state.doc, id);
  // причина у ядра уже словами — своей выдумывать не надо
  if (!can.ok) { showMsg('warn', 'Компонентом это не станет', { note: `${can.reason}.` }); return; }
  const was = displayName(state.doc, node);
  const suggested = suggestProps(state.doc, id);
  const picked = new Set(suggested.map((p) => p.name));
  const taken = new Set(libraryList().map((c) => c.name.toLowerCase()));

  openSheet('Сделать компонентом', (body) => {
    body.appendChild(noteEl(`«${was}» переедет в библиотеку, а на его месте останется экземпляр. `
      + 'Дальше правка компонента будет менять все его экземпляры разом.'));

    const nameField = field('input', was, () => { /* читаем при нажатии */ }, 'Имя компонента');
    const dup = noteEl('');
    dup.hidden = true;
    const checkDup = () => {
      const v = String(nameField.value || '').trim().toLowerCase();
      dup.hidden = !v || !taken.has(v);
      if (!dup.hidden) dup.textContent = `Компонент с именем «${nameField.value.trim()}» уже есть — будет два с одним именем.`;
    };
    nameField.addEventListener('input', checkDup);
    checkDup();
    body.appendChild(group('Имя компонента', [nameField, dup]));

    const rows = [noteEl(suggested.length
      ? 'Свойство — то, что разрешено менять у экземпляра. Текст внутри нужен почти всегда; '
        + 'остальное объявляется позже, у самого компонента.'
      : 'Внутри нет текста, а больше оболочка ничего не угадывает. Свойства объявляются потом, '
        + 'у самого компонента; компонент без свойств законен.')];
    for (const p of suggested) {
      rows.push(pickPill(`${p.name} — ${PROP_KIND_WORDS[p.kind]}`, p.sample ? `«${clip(p.sample, 22)}»` : '',
        picked.has(p.name), (on) => { if (on) picked.add(p.name); else picked.delete(p.name); }));
    }
    body.appendChild(group('Что можно будет менять', rows));

    const go = document.createElement('button');
    go.className = 'btn accent wide';
    go.textContent = 'Сделать компонентом';
    go.addEventListener('click', () => {
      // change у поля мог не случиться (нажали мышью, не покидая поле) — читаем напрямую
      const typed = String(nameField.value || '').trim();
      makeComponentNow(id, typed || was, suggested.filter((p) => picked.has(p.name)));
    });
    body.appendChild(go);
  }, { size: 'auto', key: 'make-component' });
}

/** Одна транзакция: узел уезжает в библиотеку, на его месте встаёт экземпляр. */
function makeComponentNow(id, name, props) {
  const clean = (props || []).map((p) => ({
    name: p.name, kind: p.kind, target: p.target, path: p.path,
    ...(Array.isArray(p.values) ? { values: p.values.slice() } : {}),
  }));
  /* ensureLibraryOps внутри makeComponentOps на каждый вызов даёт НОВЫЙ id библиотеки,
     поэтому инвертировать нужно ровно тот массив, который применили. commit так и делает:
     invertOps и applyOps получают один и тот же list. */
  const list = makeComponentOps(state.doc, id, { name, props: clean });
  if (!list.length) {
    const can = canMakeComponent(state.doc, id);
    showMsg('warn', 'Компонентом это не станет', { note: `${can.reason || 'слой не годится'}.` });
    return;
  }
  const born = list.find((o) => o.op === 'create' && o.node && o.node.type === 'instance');
  // «перенёс узел; добавил узел» — верно по операциям и бесполезно по смыслу
  const r = commit(list, `Сделать компонентом «${name}»`, 'human', {
    quiet: true, human: `Сделал «${displayName(state.doc, nodeById(state.doc, id))}» компонентом «${name}»`,
  });
  if (!r.ok) return;
  closeSheet();
  if (born) setSelection([born.node.id]);
  const what = clean.length
    ? `У экземпляров можно менять: ${clean.map((p) => p.name).join(', ')}.`
    : 'Свойства можно объявить у самого компонента — он в группе «Библиотека» в панели слоёв.';
  showMsg('result', `«${name}» — теперь компонент`, {
    note: `Заготовка уехала в библиотеку, на её месте — экземпляр. ${what} ${backHint()}`,
    ms: 13000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
}

/** Отсоединить экземпляр: на его месте — настоящая копия (SPEC §5.7). */
function detachInstance(id) {
  const node = nodeById(state.doc, id);
  if (!node || node.type !== 'instance') return;
  const master = masterOf(state.doc, node);
  const title = master ? componentName(master) : displayName(state.doc, node);
  const list = detachInstanceOps(state.doc, id);
  if (!list.length) {
    showMsg('warn', 'Отсоединять не от чего', {
      note: `Компонента этого экземпляра в документе нет — копировать нечего.`,
    });
    return;
  }
  const born = list.find((o) => o.op === 'create');
  // по операциям это «удалил узел; добавил 4 узла» — по смыслу одно действие
  const r = commit(list, `Отсоединить «${title}»`, 'human', {
    quiet: true, human: `Отсоединил экземпляр «${title}» от компонента`,
  });
  if (!r.ok) return;
  if (born) setSelection([born.node.id]);
  // род имени компонента заранее неизвестен («Кнопка отсоединён»), поэтому согласуем
  // фразу со словом «экземпляр», а имя берём в кавычки
  showMsg('plain', `Экземпляр «${title}» отсоединён от компонента`, {
    note: `Это обычная копия: правки компонента её больше не касаются. ${backHint()}`,
    ms: 10000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
}

/** Показать сам компонент: выделяем его, рельс сам раскроет группу «Библиотека». */
function showComponent(masterId) {
  if (!nodeById(state.doc, masterId)) return;
  setSelection([masterId]);
  focusLayerRow(masterId);
}

/** Значения экземпляра целиком: имя свойства может содержать точку, так что путь — «props». */
function setInstanceProp(node, name, value) {
  const next = { ...(node.props && typeof node.props === 'object' ? node.props : {}) };
  if (value === undefined) delete next[name]; else next[name] = value;
  commit([OPS.set(node.id, 'props', next)], `Свойство «${name}»`);
}

/**
 * Поле для одного свойства экземпляра — по его виду (п.5). Вид объявлен у компонента,
 * и оболочка ему подчиняется: текст правится полем, выбор — сегментами, да/нет —
 * переключателем, цвет — теми же образцами, что заливка, число — числовым полем.
 */
function instancePropControl(node, prop) {
  const raw = node.props ? node.props[prop.name] : undefined;
  const put = (v) => setInstanceProp(node, prop.name, v);
  if (prop.kind === 'text') {
    const cur = typeof raw === 'string' ? raw : masterPropValue(node, prop);
    return field(String(cur).includes('\n') ? 'textarea' : 'input', String(cur), (v) => put(v), prop.name);
  }
  if (prop.kind === 'number') {
    /* Круг 20: у компонента скругление стоит ссылкой ('radii.4'), и Number() от неё давал 0.
       Значение экземпляра по виду «число» ядро принимает только числом (propValue), поэтому
       пишем число, а показываем пиксели, разрешив ссылку компонента через ядро. */
    const master = masterPropValue(node, prop);
    const fromMaster = resolveScale(state.doc, Array.isArray(master) ? master[0] : master);
    const cur = typeof raw === 'number' ? raw : (typeof fromMaster === 'number' ? fromMaster : Number(master) || 0);
    return numberField(cur, (v) => put(v), { label: prop.name });
  }
  if (prop.kind === 'bool') {
    const cur = typeof raw === 'boolean' ? raw : masterPropValue(node, prop) !== false;
    return segField(['on', 'off'], cur ? 'on' : 'off', (v) => put(v === 'on'), ['Да', 'Нет']);
  }
  if (prop.kind === 'enum') {
    const values = Array.isArray(prop.values) ? prop.values : [];
    const cur = typeof raw === 'string' ? raw : String(masterPropValue(node, prop) || '');
    const words = values.map(enumWord);
    // до трёх коротких значений — сегменты (выбор виден целиком), дальше список
    const short = values.length <= 3 && words.every((w) => w.length <= 12);
    return short ? segField(values, cur, (v) => put(v), words)
      : selectField(values, cur, (v) => put(v), Object.fromEntries(values.map((v, i) => [v, words[i]])));
  }
  if (prop.kind === 'color') {
    const cur = raw !== undefined ? raw : masterPropValue(node, prop);
    return swatches(node, prop.name, prop.name, { value: cur, onPick: (v) => put(v) });
  }
  return field('input', raw === undefined ? '' : String(raw), (v) => put(v), prop.name);
}

/** Что стоит у самого компонента: это и есть значение экземпляра, пока своего нет. */
function masterPropValue(node, prop) {
  const target = nodeById(state.doc, prop.target);
  if (!target) return '';
  return readPath(target, prop.path);
}

/** Строка свойства со сбросом: «как в компоненте» — это отсутствие своего значения. */
function propRow(node, prop) {
  const r = row(prop.name, instancePropControl(node, prop));
  const own = !!(node.props && Object.prototype.hasOwnProperty.call(node.props, prop.name));
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'row-reset';
  back.textContent = '↺';
  back.title = `Вернуть «${prop.name}» как в компоненте`;
  back.setAttribute('aria-label', back.title);
  back.disabled = !own;
  back.addEventListener('click', () => setInstanceProp(node, prop.name, undefined));
  r.appendChild(back);
  return r;
}

/** Панель экземпляра (п.5). */
function instanceInspector(body, node) {
  const master = masterOf(state.doc, node);
  const name = master ? componentName(master) : '';

  const head = document.createElement('div');
  head.className = 'comp-head';
  const mark = document.createElement('span');
  mark.className = 'comp-mark';
  mark.textContent = GLYPH_INSTANCE;
  mark.setAttribute('aria-hidden', 'true');
  const what = document.createElement('span');
  what.className = 'comp-what';
  what.textContent = master ? `Экземпляр компонента «${name}»` : 'Экземпляр без компонента';
  head.append(mark, what);
  body.appendChild(head);

  if (!master) {
    body.appendChild(noteEl('Компонента, с которого снят этот экземпляр, в документе нет: '
      + 'на холсте он не рисуется. Его можно удалить или вернуть компонент отменой правки.'));
    return;
  }

  const show = document.createElement('button');
  show.className = 'btn subtle small';
  show.textContent = 'Показать компонент';
  show.title = `Выделить «${name}» в библиотеке`;
  show.addEventListener('click', () => showComponent(master.id));

  const props = libraryList().find((c) => c.id === master.id);
  const list = (props && props.props) || [];
  if (list.length) {
    const rows = list.map((p) => propRow(node, p));
    rows.push(noteEl('Кнопка ↺ убирает своё значение — тогда свойство берётся у компонента.'));
    body.appendChild(group('Что можно менять', rows));
  } else {
    body.appendChild(group('Что можно менять', [
      noteEl(`У компонента «${name}» не объявлено ни одного свойства — менять у экземпляра нечего. `
        + 'Свойства объявляются у самого компонента.'),
    ]));
  }

  const detach = document.createElement('button');
  detach.className = 'btn subtle small';
  detach.textContent = 'Отсоединить';
  detach.title = 'Превратить экземпляр в обычную копию';
  detach.addEventListener('click', () => detachInstance(node.id));

  body.appendChild(group('Компонент', [
    noteEl('Внутренности экземпляра правятся у компонента: здесь меняются только объявленные '
      + 'свойства. Нужна разовая правка — отсоедините, и получится обычная копия.'),
    show,
    detach,
  ]));
}

/**
 * Круг 19, п.6. Узел ВНУТРИ компонента правится теми же полями, что любой другой, но
 * последствия у правки другие: она разойдётся по всем экземплярам. Человек, дошедший
 * сюда крошками или кликом по холсту, об этом ниоткуда не узнаёт — предупреждение
 * стоит до полей, тем же словом и тем же видом, что у самого компонента.
 * @returns {boolean} сказали ли что-нибудь (иначе слово берёт makeComponentGroup)
 */
function insideComponentWarn(body, node) {
  const master = ancestors(state.doc, node.id).find((a) => isMaster(state.doc, a));
  if (!master) return false;
  const info = libraryList().find((c) => c.id === master.id);
  const used = info ? info.instances : 0;
  const warn = document.createElement('p');
  warn.className = 'comp-warn';
  warn.setAttribute('role', 'status');
  warn.textContent = used
    ? `Это внутренность компонента «${componentName(master)}». Правка разойдётся по всем `
      + `${used} ${plural(used, 'экземпляру', 'экземплярам', 'экземплярам')} на досках.`
    : `Это внутренность компонента «${componentName(master)}». Экземпляров у него пока нет.`;
  const go = document.createElement('button');
  go.className = 'btn subtle small';
  go.textContent = 'Показать компонент';
  go.addEventListener('click', () => showComponent(master.id));
  body.append(warn, go);
  return true;
}

/** Панель компонента (п.6). */
function masterInspector(body, node) {
  const info = libraryList().find((c) => c.id === node.id);
  const used = info ? info.instances : 0;
  const name = componentName(node);

  const head = document.createElement('div');
  head.className = 'comp-head';
  const mark = document.createElement('span');
  mark.className = 'comp-mark';
  mark.textContent = GLYPH_MASTER;
  mark.setAttribute('aria-hidden', 'true');
  const what = document.createElement('span');
  what.className = 'comp-what';
  what.textContent = `Компонент «${name}»`;
  head.append(mark, what);
  body.appendChild(head);

  // предупреждение должно стоять ДО полей, иначе его читают уже после правки
  const warn = document.createElement('p');
  warn.className = 'comp-warn';
  warn.setAttribute('role', 'status');
  warn.textContent = used > 1
    ? `Правка заденет все ${used} ${plural(used, 'экземпляр', 'экземпляра', 'экземпляров')} на досках.`
    : used === 1
      ? 'Правка заденет единственный экземпляр на досках.'
      : 'Экземпляров пока нет: правка не заденет ничего, кроме самой заготовки.';
  body.appendChild(warn);

  const nameField = field('input', name, (v) => {
    const t = String(v || '').trim();
    // пустое имя ядро не примет — молча возвращаем прежнее, а не ругаемся ошибкой операции
    if (!t) { renderInspector(); return; }
    if (t === name) return;
    // оба поля одной транзакцией: иначе рельс зовёт компонент старым именем, а панель новым
    const list = [OPS.set(node.id, 'component.name', t)];
    if (String(node.name || '') !== t) list.push(OPS.set(node.id, 'name', t));
    commit(list, `Имя компонента «${t}»`);
  }, 'Имя компонента');
  body.appendChild(group('Имя компонента', [nameField]));

  const put = document.createElement('button');
  put.className = 'btn subtle small';
  put.textContent = 'Поставить на доску';
  put.addEventListener('click', () => placeInstance(node.id));

  const rows = [];
  const props = (info && info.props) || [];
  for (const p of props) rows.push(propLine(node, p));
  if (!props.length) {
    rows.push(noteEl('Свойств нет: экземпляры будут одинаковыми. Это законно — например, у логотипа '
      + 'или разделителя менять нечего.'));
  }
  const add = document.createElement('button');
  add.className = 'btn subtle small';
  add.textContent = 'Объявить свойство';
  add.addEventListener('click', () => openAddProp(node.id));
  rows.push(add);
  body.appendChild(group('Что можно менять у экземпляров', rows));
  body.appendChild(group('Экземпляры', [
    noteEl(used
      ? `На досках ${used} ${plural(used, 'экземпляр', 'экземпляра', 'экземпляров')} этого компонента.`
      : 'На досках экземпляров этого компонента нет.'),
    put,
  ]));
}

/** Строка объявленного свойства: имя, вид, где оно живёт — и «убрать». */
function propLine(master, p) {
  const wrap = document.createElement('div');
  wrap.className = 'propline';
  const t = document.createElement('span');
  t.className = 'propline-name';
  t.textContent = p.name;
  const k = document.createElement('span');
  k.className = 'propline-kind';
  k.textContent = p.kind === 'enum' && p.values && p.values.length
    ? `${PROP_KIND_WORDS.enum}: ${p.values.map(enumWord).join(' | ')}`
    : PROP_KIND_WORDS[p.kind] || p.kind;
  const w = document.createElement('span');
  w.className = 'propline-where';
  const target = nodeById(state.doc, p.target);
  w.textContent = `${target ? displayName(state.doc, target) : '?'} · ${humanPath(p.path) || p.path}`;
  w.title = w.textContent;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'propline-del';
  del.textContent = '×';
  del.title = `Убрать свойство «${p.name}»`;
  del.setAttribute('aria-label', del.title);
  del.addEventListener('click', () => removeProp(master.id, p.name));
  wrap.append(t, k, w, del);
  return wrap;
}

/**
 * Убрать свойство. Одной транзакцией — вместе со значениями в экземплярах: иначе у них
 * остаётся имя, которого компонент уже не объявлял (валидатор зовёт это unknown-prop).
 * Порядок важен: сначала чистим экземпляры, потом компонент, иначе промежуточное
 * состояние документа не проходит проверку схемы.
 */
function removeProp(masterId, propName) {
  const master = nodeById(state.doc, masterId);
  if (!master || !master.component) return;
  const rest = (master.component.props || []).filter((p) => p && p.name !== propName);
  const list = [];
  for (const n of Object.values(state.doc.nodes || {})) {
    if (!n || n.type !== 'instance' || n.of !== masterId) continue;
    if (!n.props || !Object.prototype.hasOwnProperty.call(n.props, propName)) continue;
    const next = { ...n.props };
    delete next[propName];
    list.push(OPS.set(n.id, 'props', next));
  }
  const touched = list.length;
  list.push(OPS.set(masterId, 'component.props', rest));
  const r = commit(list, `Убрать свойство «${propName}»`, 'human', {
    quiet: true, human: `Убрал свойство «${propName}» у компонента «${componentName(master)}»`,
  });
  if (!r.ok) return;
  showMsg('plain', `Свойство «${propName}» убрано у компонента «${componentName(master)}»`, {
    note: touched
      ? `Значение пропало у ${touched} ${plural(touched, 'экземпляра', 'экземпляров', 'экземпляров')}. ${backHint()}`
      : backHint(),
    ms: 9000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
}

/* Что у узла разрешено объявлять свойством. Список короткий нарочно: это поля, у которых
   есть поле в инспекторе, значит человек видит, что именно изменится. Пути те же, что
   понимает `set`, — ядро проверит их ещё раз (checkComponent). */
const PROP_FIELDS = {
  text: [
    { path: 'characters', label: 'Текст', kinds: ['text'] },
    { path: 'color', label: 'Цвет текста', kinds: ['color', 'enum'] },
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
  frame: [
    { path: 'fill', label: 'Заливка', kinds: ['color', 'enum'] },
    { path: 'radius', label: 'Скругление', kinds: ['number'] },
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
  rect: [
    { path: 'fill', label: 'Заливка', kinds: ['color', 'enum'] },
    { path: 'radius', label: 'Скругление', kinds: ['number'] },
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
  ellipse: [
    { path: 'fill', label: 'Заливка', kinds: ['color', 'enum'] },
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
  image: [
    { path: 'src', label: 'Источник', kinds: ['text'] },
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
  instance: [
    { path: 'visible', label: 'Виден', kinds: ['bool'] },
  ],
};

/** Узлы внутри компонента — там, где свойство может жить. */
function propTargets(masterId) {
  const out = [];
  for (const id of subtreeIds(state.doc, masterId)) {
    const n = nodeById(state.doc, id);
    if (!n || !PROP_FIELDS[n.type]) continue;
    out.push({ id, label: id === masterId ? `${displayName(state.doc, n)} — сам компонент` : displayName(state.doc, n) });
  }
  return out;
}

/**
 * Объявить свойство (п.6). Самое трудное место круга: человеку надо выбрать узел ВНУТРИ
 * компонента и путь к полю. Сводим выбор к трём шагам, каждый из которых — список того,
 * что у этого узла вообще есть: где → что менять → как. Имя подставляется от поля и
 * правится; значения выбора предлагаются от нынешнего значения узла.
 */
function openAddProp(masterId) {
  const master = nodeById(state.doc, masterId);
  if (!master || !master.component) return;
  const targets = propTargets(masterId);
  if (!targets.length) return;
  const draft = { target: targets[0].id, path: '', kind: '', values: '', name: '' };

  const fieldsOf = (id) => {
    const n = nodeById(state.doc, id);
    return (n && PROP_FIELDS[n.type]) || [];
  };
  const pickField = (path) => {
    const list = fieldsOf(draft.target);
    const f = list.find((x) => x.path === path) || list[0];
    draft.path = f ? f.path : '';
    draft.kind = f ? f.kinds[0] : '';
    draft.name = f ? f.label.toLowerCase() : '';
    const cur = draft.target ? readPath(nodeById(state.doc, draft.target), draft.path) : undefined;
    const token = colorToken(cur);
    // выбор всегда начинается с того, что стоит сейчас: «accent|surface», а не пустая строка
    draft.values = token ? `${token}, surface` : '';
  };
  pickField('');

  openSheet('Объявить свойство', (body) => {
    body.appendChild(noteEl(`Свойство — то, что экземпляры компонента «${componentName(master)}» `
      + 'смогут менять у себя. Всё остальное у них будет общим.'));

    const where = selectField(targets.map((t) => t.id), draft.target, (v) => {
      draft.target = v;
      pickField('');
      redraw();
    }, Object.fromEntries(targets.map((t) => [t.id, t.label])));
    body.appendChild(group('Где', [where]));

    const rest = document.createElement('div');
    rest.className = 'group-stack';
    body.appendChild(rest);

    const go = document.createElement('button');
    go.className = 'btn accent wide';
    go.textContent = 'Объявить';
    body.appendChild(go);

    let nameField = null;
    function redraw() {
      rest.textContent = '';
      const list = fieldsOf(draft.target);
      const what = selectField(list.map((f) => f.path), draft.path, (v) => { pickField(v); redraw(); },
        Object.fromEntries(list.map((f) => [f.path, f.label])));
      rest.appendChild(group('Что менять', [what]));

      const f = list.find((x) => x.path === draft.path);
      const kinds = (f && f.kinds) || [];
      if (kinds.length > 1) {
        rest.appendChild(group('Как', [
          segField(kinds, draft.kind, (v) => { draft.kind = v; redraw(); },
            kinds.map((k) => (k === 'color' ? 'любой цвет' : 'выбор из нескольких'))),
        ]));
      }
      if (draft.kind === 'enum') {
        const vals = field('input', draft.values, (v) => { draft.values = v; }, 'Значения через запятую');
        vals.addEventListener('input', () => { draft.values = vals.value; });
        rest.appendChild(group('Значения', [
          vals,
          noteEl('Через запятую. Для заливки и цвета это имена из палитры: accent, surface, surfaceAlt, accentSoft.'),
        ]));
      }
      nameField = field('input', draft.name, (v) => { draft.name = v; }, 'Имя свойства');
      nameField.addEventListener('input', () => { draft.name = nameField.value; });
      rest.appendChild(group('Имя свойства', [
        nameField,
        noteEl('Этим именем свойство назовётся и в панели экземпляра, и в словаре агента.'),
      ]));
      hydrateIcons(dom.sheet);
    }
    redraw();

    go.addEventListener('click', () => {
      const name = String((nameField && nameField.value) || draft.name || '').trim();
      addProp(masterId, {
        name,
        kind: draft.kind,
        target: draft.target,
        path: draft.path,
        values: draft.kind === 'enum'
          ? String(draft.values || '').split(',').map((x) => x.trim()).filter(Boolean)
          : undefined,
      });
    });
  }, { size: 'auto', key: 'add-prop' });
}

/** Дописать свойство компоненту. Схему проверяет ядро — нам довольно отсеять пустяки. */
function addProp(masterId, p) {
  const master = nodeById(state.doc, masterId);
  if (!master || !master.component) return;
  const why = (t) => showMsg('warn', 'Свойство не объявлено', { note: t });
  if (!p.name) { why('У свойства должно быть имя.'); return; }
  // круг 34: имя — один сегмент пути `props.<имя>`, ядро точку не примет (checkComponent)
  if (p.name.includes('.')) { why('В имени свойства не бывает точки — назовите его без неё.'); return; }
  const had = (master.component.props || []).slice();
  if (had.some((x) => x && x.name === p.name)) {
    why(`Свойство «${p.name}» у компонента «${componentName(master)}» уже есть.`);
    return;
  }
  if (p.kind === 'enum' && (!p.values || p.values.length < 2)) {
    why('Для выбора нужно хотя бы два значения через запятую.');
    return;
  }
  had.push({
    name: p.name, kind: p.kind, target: p.target, path: p.path,
    ...(p.kind === 'enum' ? { values: p.values } : {}),
  });
  const r = commit([OPS.set(masterId, 'component.props', had)], `Свойство «${p.name}» у «${componentName(master)}»`,
    'human', { quiet: true, human: `Объявил свойство «${p.name}» у компонента «${componentName(master)}»` });
  if (!r.ok) return;
  closeSheet();
  showMsg('result', `«${componentName(master)}»: объявлено свойство «${p.name}»`, {
    note: `Теперь оно правится у каждого экземпляра в панели справа. ${backHint()}`,
    ms: 10000,
    actions: [{ label: 'Отменить', onClick: () => undoTx(r.tx.id) }],
    undoTx: r.tx.id,
  });
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
    // что в поле было при сборке: всё сверх этого — набор, который перерисовка не сотрёт (круг 33)
    if ((f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') && f.dataset.initial === undefined) f.dataset.initial = f.value;
  }
}

/* Круг 33, п.1. Набор в инспекторе переживает перерисовку. Пересборка панели (чужая
   транзакция, итог агента, подтверждение своей правки) стирала недописанное: поле строилось
   заново из документа, а фокус с кареткой возвращались в поле с прежним текстом — буквы
   «Ани по буквам» пропадали. Хуже: если панель тем временем показывала уже ДРУГОЙ слой
   (агент выделил новую доску), фокус возвращался в поле того слоя, и остаток набора уходил
   в его имя. Теперь: запоминаем, какой слой правится и что в поле набрано; тот же слой —
   набранное и каретка возвращаются; другой — фокус в чужое поле не ставится (набранное
   записывается в свой слой); слой удалили — панель остаётся с пояснением, и обрывок набора
   никуда не записывается. */
let inspRebuilding = false;

function inspFocused() {
  const body = dom['insp-body'];
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  return !!(body && a && a !== body && body.contains(a));
}

function grabInspFocus() {
  const body = dom['insp-body'];
  const a = document.activeElement;
  if (!body || !a || !body.contains(a) || !a.dataset || !a.dataset.fkey) return null;
  const memo = { key: a.dataset.fkey, start: null, end: null, node: body.dataset.node || '', value: null, dirty: false, commit: null };
  try { memo.start = a.selectionStart; memo.end = a.selectionEnd; } catch { /* number не даёт каретку */ }
  if ((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.dataset.initial !== undefined) {
    memo.value = a.value;
    memo.dirty = a.value !== a.dataset.initial;
    memo.commit = typeof a._commitNow === 'function' ? a._commitNow : null;
  }
  return memo;
}

function restoreInspFocus(memo, nodeId) {
  const body = dom['insp-body'];
  if (!memo || !body) return;
  // панель показывает другой слой: в его поле набор не продолжаем (буквы ушли бы туда)
  if (memo.node && memo.node !== nodeId) {
    // недописанное — в свой слой, одной правкой и уже после перерисовки
    if (memo.dirty && memo.commit) queueMicrotask(memo.commit);
    // фокус — на панель, а не на <body>: иначе Backspace удалил бы выделенное на холсте
    if (dom.inspector && !dom.inspector.hidden) { try { dom.inspector.focus({ preventScroll: true }); } catch { /* без фокуса */ } }
    return;
  }
  const f = body.querySelector(`[data-fkey="${CSS.escape(memo.key)}"]`);
  if (!f) return;
  if (memo.dirty && typeof memo.value === 'string' && f.value !== memo.value) f.value = memo.value;
  try { f.focus({ preventScroll: true }); } catch { f.focus(); }
  if (memo.start == null) return;
  try { f.setSelectionRange(memo.start, memo.end); } catch { /* тип поля не поддерживает каретку */ }
}

/**
 * Слой, который сейчас правят в инспекторе, удалили (чужая транзакция, агент). Панель не
 * исчезает из-под рук: поля остаются, но только для чтения, и сказано, что случилось.
 * Набранное никуда не записывается. Уйдёт фокус из панели — она закроется.
 */
function orphanInspector(memo) {
  const body = dom['insp-body'];
  if (!body || body.dataset.orphan === memo.node) return;
  body.dataset.orphan = memo.node;
  /* Поля не «только для чтения»: в таком поле пробел прокручивал панель, и набор будто
     пропадал. Поле остаётся живым (набранное видно и его можно скопировать), но ничего не
     записывает; кнопки и списки — выключены. */
  for (const f of body.querySelectorAll('input, textarea, select, button')) {
    if (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') f.dataset.orphan = '1';
    else f.disabled = true;
  }
  const r = removedInfo.get(memo.node);
  const by = r && r.by ? r.by : null;
  const who = by && by.author_kind === 'agent' ? 'Агент удалил этот слой'
    : by && by.author ? `${SHELL.whoDid(by, 'удалил')} этот слой` : 'Этот слой удалили';
  const note = document.createElement('p');
  note.className = 'insp-issue';
  note.setAttribute('role', 'status');
  note.dataset.orphanNote = '1';
  note.textContent = `${who} — набранное здесь не записано.`;
  body.prepend(note);
  body.scrollTop = 0;
}

function renderInspector() {
  const body = dom['insp-body'];
  const keepFocus = grabInspFocus();
  const id = state.selection.length === 1 && !state.inspQuiet ? state.selection[0] : null;
  const node = id ? nodeById(state.doc, id) : null;
  // правили слой, которого больше нет, — панель остаётся, пока в ней фокус (п.1)
  if (keepFocus && keepFocus.node && (!node || node.id !== keepFocus.node) && !nodeById(state.doc, keepFocus.node)) {
    dom.inspector.hidden = false;
    orphanInspector(keepFocus);
    return;
  }
  if (dom.app.dataset.insp !== (node ? 'on' : 'off')) scheduleViewRecheck(240);
  dom.app.dataset.insp = node ? 'on' : 'off';
  syncPanelModes();   // инспектор занял или отдал колонку — пересчитать бюджет (круг 16, п.1)
  if (node && railIsDrawer() && dom.app.dataset.rail === 'on') setRail('off');
  // на узком экране лист инспектора и док вместе не оставляют холста: знакомство уступает
  if (node && isNarrow() && state.introOpen) hideMsg();
  dom.inspector.hidden = !node;
  if (!node) { delete body.dataset.node; delete body.dataset.orphan; return; }

  // поле с фокусом сейчас вынется из документа: его blur/change не должны записать обрывок
  inspRebuilding = true;
  try { body.textContent = ''; } finally { inspRebuilding = false; }
  body.dataset.node = node.id;
  delete body.dataset.orphan;

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
    crumbs.setAttribute('aria-label', 'Путь до слоя');
    for (const a of chain) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb';
      b.textContent = a.name || defaultName(a);
      b.title = `Выделить «${a.name || defaultName(a)}» — слой снаружи`;
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
    warn.textContent = issues.map(issueText).join(' · ');
    body.appendChild(warn);
  }

  /* Круг 19, п.6 и п.8. У компонента имя ОДНО. В документе их два поля — `name` узла и
     `component.name`, — и показывать оба значило бы спрашивать человека, какое из них
     настоящее: рельс, холст и словарь агента берут разные. Поэтому у компонента группа
     «Имя» не показывается вовсе, а «Имя компонента» ниже пишет оба поля одной правкой. */
  if (!isMaster(state.doc, node)) {
    body.appendChild(group('Имя', [
      field('input', node.name || '', (v) => setProp(node.id, 'name', v), 'Имя слоя'),
    ]));
  }

  /* Круг 19, п.5. Экземпляр правится не как обычный узел: внутренности у него общие с
     компонентом, своё — только объявленные свойства, размер и место. Поэтому дальше
     панели расходятся, и заливка с типографикой у экземпляра не показываются вовсе:
     их там нет, и поле, которое ничего не меняет, — хуже отсутствия поля. */
  if (node.type === 'instance') {
    instanceInspector(body, node);
    if (node.size || masterOf(state.doc, node)) {
      const master = masterOf(state.doc, node);
      const eff = {
        id: node.id,
        size: {
          w: (node.size && node.size.w) || (master && master.size && master.size.w) || { mode: 'hug' },
          h: (node.size && node.size.h) || (master && master.size && master.size.h) || { mode: 'hug' },
        },
      };
      const own = node.size && (node.size.w || node.size.h);
      body.appendChild(group('Размер', [
        row('Ширина', sizeField(eff, 'w')),
        row('Высота', sizeField(eff, 'h')),
        noteEl(own ? 'Незаданная ось берётся у компонента.' : 'Размер сейчас целиком от компонента.'),
      ]));
    }
    // круг 37: место в свободной рамке и поворот — свои у экземпляра, как размер
    const freeParentI = SHELL.freeParentOf(state.doc, node);
    if (freeParentI && !node.override) body.appendChild(freePosGroup(node, freeParentI));
    body.appendChild(lookGroup(node));
    // круг 36 (SPEC §11.1): у экземпляра состояния свои — как размер и место
    if (statesAllowed(node)) body.appendChild(statesGroup(node));
    if (node.override) body.appendChild(overrideGroup(node));
    const del = document.createElement('button');
    del.className = 'btn danger small';
    del.textContent = 'Удалить экземпляр';
    del.addEventListener('click', () => deleteNodes([node.id]));
    body.appendChild(del);
    tagInspFields(body);
    restoreInspFocus(keepFocus, node.id);
    return;
  }

  // круг 19, п.6: сам компонент — это заготовка, и об этом сказано до всех полей
  if (isMaster(state.doc, node)) masterInspector(body, node);
  // внутри компонента makeComponentGroup повторил бы ту же мысль слабее («Компонентом
  // не станет: узел внутри другого компонента») — одного объяснения довольно
  else if (!insideComponentWarn(body, node)) makeComponentGroup(body, node);

  if (node.type === 'text') {
    body.appendChild(group('Текст', [
      field('textarea', node.characters || '', (v) => setProp(node.id, 'characters', v), 'Текст слоя'),
    ]));
    const st = typeof node.style === 'string' ? { token: node.style } : (node.style || {});
    body.appendChild(group('Типографика', [
      row('Стиль', selectField(Object.keys(state.doc.tokens.type), st.token || 'body',
        (v) => setProp(node.id, 'style', { ...st, token: v }), TYPE_LABELS)),
      row('Кегль', numberField(st.fontSize ?? tokenType(st.token, node).fontSize,
        (v) => setProp(node.id, 'style', { ...st, fontSize: v }))),
      row('Жирность', selectField(['400', '500', '600', '700'],
        String(st.fontWeight ?? tokenType(st.token, node).fontWeight),
        (v) => setProp(node.id, 'style', { ...st, fontWeight: Number(v) }), WEIGHT_LABELS)),
      row('Выключка', segField(['left', 'center', 'right'], node.align || 'left',
        (v) => setProp(node.id, 'align', v),
        ['left', 'center', 'right'].map((v) => TEXT_ALIGN_LABELS[v]))),
    ]));
  }

  if (node.type === 'frame') {
    const L = node.layout || {};
    /* Круг 20, п.2 (SPEC §6.3, §6.7). Зазор и отступ в документе — ссылки на шаги шкалы
       отступов (или числа мимо неё); читать их как числа нельзя — числовое поле показывало
       для ссылки 0. Поле scaleField показывает пиксели через resolveLayout и признак
       «по шкале» / «мимо шкалы», а пишет ссылку либо число. Отступ, как и прежде, правится
       одним числом на все четыре стороны; когда стороны разные, это сказано в подписи. */
    const R = resolveLayout(state.doc, node.layout);
    // отступ бывает и краткой записью (число, ссылка, массив) — верх берём из любой формы
    const padRaw = L.padding;
    const pad = { t: padRaw && typeof padRaw === 'object' && !Array.isArray(padRaw) ? padRaw.t
      : Array.isArray(padRaw) ? padRaw[0] : padRaw };
    const sidesDiffer = R.padding.t !== R.padding.r || R.padding.t !== R.padding.b || R.padding.t !== R.padding.l;
    const padNote = sidesDiffer
      ? `стороны разные: ${R.padding.t}/${R.padding.r}/${R.padding.b}/${R.padding.l} — новое значение встанет на все четыре`
      : '';
    /* Круг 37 (SPEC §12.1): «свободно» — рамка без авто-раскладки, дети стоят по своим X/Y
       (так собрана иллюстрация). Смена потока не двигает детей: входя в свободную рамку, они
       получают X/Y там, где стояли, уходя — теряют их (setLayoutMode, одна транзакция).
       Зазор и выравнивание в свободной рамке ничего не значат — вместо них подпись. */
    const modeNow = SHELL.layoutModeOf(node);   // без режима решатель ставит 'none'
    const modeSeg = segField(['column', 'row', 'none'], modeNow,
      (v) => setLayoutMode(node, v), ['column', 'row', 'none'].map((v) => MODE_LABELS[v]));
    modeSeg.classList.add('mode-seg');
    const MODE_TIPS = {
      column: 'Столбец: дети друг под другом, место считает раскладка',
      row: 'Строка: дети в ряд, место считает раскладка',
      none: 'Свободно: каждый слой стоит где поставлен (X/Y) — как детали иллюстрации',
    };
    ['column', 'row', 'none'].forEach((m, i) => { const b = modeSeg.children[i]; if (b) { b.title = MODE_TIPS[m]; b.dataset.mode = m; } });
    if (modeNow === 'none') {
      body.appendChild(group('Раскладка', [
        row('Поток', modeSeg),
        noteEl(SHELL.isIllustration(state.doc, node)
          ? `${illustrationWords(node)}. `
            // доска выделяет своих детей щелчком, рамка внутри доски — шагом вглубь (двойным)
            + (isArtboard(state.doc, node.id) ? 'Щелчок по детали на холсте выделяет её. '
              : 'Двойной щелчок по детали на холсте выделяет её, дальше щелчок по соседней — сразу. ')
            + 'Тащите детали мышью (Shift — по одной оси) или стрелками; выше рисуется та, что ниже в «Слоях».'
          : 'Свободно: слои стоят по своим X и Y — тащите их на холсте или двигайте стрелками. '
            + 'Выше рисуется тот, кто ниже в «Слоях».'),
        row('Отступ', scaleField(pad.t, 'spacing', (v) => {
          setProp(node.id, 'layout.padding', { t: v, r: v, b: v, l: v });
        }, { label: 'Отступ', note: padNote })),
      ]));
    } else body.appendChild(group('Раскладка', [
      row('Поток', modeSeg),
      row('Зазор', scaleField(L.gap, 'spacing', (v) => setProp(node.id, 'layout.gap', v), { label: 'Зазор' })),
      row('Отступ', scaleField(pad.t, 'spacing', (v) => {
        setProp(node.id, 'layout.padding', { t: v, r: v, b: v, l: v });
      }, { label: 'Отступ', note: padNote })),
      row('Выравн.', selectField(['start', 'center', 'end', 'stretch'], L.align || 'start',
        (v) => setProp(node.id, 'layout.align', v), ALIGN_LABELS)),
      row('Распред.', selectField(['start', 'center', 'end', 'between'], L.justify || 'start',
        (v) => setProp(node.id, 'layout.justify', v), JUSTIFY_LABELS)),
      scaleLink('spacing'),
    ]));
  }

  if (node.size) {
    body.appendChild(group('Размер', [
      row('Ширина', sizeField(node, 'w')),
      row('Высота', sizeField(node, 'h')),
    ]));
  }
  // круг 37 (SPEC §12.3): деталь свободной рамки — своё место; поворот и непрозрачность — у всех
  const freeParent = SHELL.freeParentOf(state.doc, node);
  if (freeParent && !node.override) body.appendChild(freePosGroup(node, freeParent));
  if (SHELL.canRotate(node) && !isArtboard(state.doc, node.id)) body.appendChild(lookGroup(node));
  if (node.type === 'vector') body.appendChild(vectorGroup(node));

  if ('fill' in node || node.type === 'frame' || node.type === 'rect' || node.type === 'ellipse') {
    body.appendChild(fillGroup(node));
  }
  { const tg = boardThemeGroup(node); if (tg) body.appendChild(tg); }
  if (node.type === 'text') {
    body.appendChild(group('Цвет текста', [swatches(node, 'color', 'Цвет текста')]));
  }
  if ('radius' in node) {
    /* Круг 20, п.2: скругление — ссылка на шаг шкалы скруглений; покорнерный массив схема
       принимает, но правится он тут как одно значение — по первому углу (сцена его и
       рисует нулём, см. resolveRadius), и об этом сказано в подписи. */
    const raw = Array.isArray(node.radius) ? node.radius[0] : node.radius;
    const corners = Array.isArray(node.radius) ? 'скругление задано по углам — здесь правится как одно' : '';
    body.appendChild(group('Скругление', [
      scaleField(raw, 'radii', (v) => setProp(node.id, 'radius', v), { label: 'Скругление', note: corners, bare: true }),
      scaleLink('radii'),
    ]));
  }

  // круг 36 (SPEC §11.3): как слой ведёт себя под рукой — после того, как он выглядит
  if (statesAllowed(node)) body.appendChild(statesGroup(node));

  if (node.override) body.appendChild(overrideGroup(node));

  const del = document.createElement('button');
  del.className = 'btn danger small';
  /* Круг 19, п.6. Удаление компонента — самая резкая из правок, которые задевают все
     экземпляры: они остаются в документе без своей заготовки и перестают рисоваться
     (валидатор зовёт это dead-instance). Кнопка называет, ЧТО удаляет, а счёт сломанного
     стоит рядом с ней — до нажатия, а не в сообщении после. */
  if (isMaster(state.doc, node)) {
    const info = libraryList().find((c) => c.id === node.id);
    const used = info ? info.instances : 0;
    del.textContent = 'Удалить компонент';
    if (used) {
      const one = used === 1;
      const note = noteEl(`${used} ${plural(used, 'экземпляр', 'экземпляра', 'экземпляров')} `
        + `${one ? 'останется' : 'останутся'} без компонента и ${one ? 'перестанет' : 'перестанут'} `
        + 'рисоваться. Вернуть можно будет отменой.');
      note.className = 'note danger-note';
      body.appendChild(note);
    }
  } else {
    del.textContent = 'Удалить слой';
  }
  del.addEventListener('click', () => deleteNodes([node.id]));
  body.appendChild(del);

  // поля получили устойчивые имена — и фокус с кареткой вернулись на своё место (п.20)
  tagInspFields(body);
  restoreInspFocus(keepFocus, node.id);
}

/**
 * Круг 19, п.3. «Сделать компонентом» живёт в инспекторе, а не в рельсе: решение
 * принимают, глядя на сам узел и на его поля. Стоит сразу под именем — это утверждение
 * о том, чем узел может стать, родня шапкам экземпляра и компонента; внизу панели живут
 * разрушительные действия, и кнопке созидания там не место. В рельсе на компоненты
 * заведена своя группа, и «+» в её строках кладёт экземпляр: обе половины работы стоят
 * там, где на них смотрят.
 * Отказ показываем только там, где он что-то объясняет: «доска компонентом не станет»
 * на каждой выделенной доске — шум, а «узел внутри другого компонента» отвечает ровно
 * на тот вопрос, который человек и задал, нажав на узел внутри компонента.
 */
function makeComponentGroup(body, node) {
  const can = canMakeComponent(state.doc, node);
  if (can.ok) {
    const mk = document.createElement('button');
    mk.className = 'btn subtle small';
    mk.textContent = 'Сделать компонентом';
    mk.title = `Отправить «${displayName(state.doc, node)}» в библиотеку и оставить здесь экземпляр`;
    mk.addEventListener('click', () => openMakeComponent(node.id));
    body.appendChild(group('Компонент', [mk]));
    return;
  }
  const why = String(can.reason || '');
  /* Круг 27, п.7: «доска/страница компонентом не станет» — это и есть шум из комментария
     выше, а с зачином выходила тавтология «Компонентом не станет: доска компонентом не
     станет.» Такой отказ не показываем; остальные — одной фразой без повтора. */
  if (/компонентом не станет/i.test(why)) return;
  if (/компонент|библиотек/i.test(why)) {
    body.appendChild(group('Компонент', [noteEl(`Компонентом не станет: ${why}.`)]));
  }
}

/* --------------------- круг 36 (SPEC §11.3): раздел «Состояния» --------------------- */

/** У каких узлов раздел есть: §11.1 (не страница) и не доска — доску наводкой не трогают. */
function statesAllowed(node) {
  return SHELL.canHaveStates(node) && !isArtboard(state.doc, node.id);
}

/** Шаги подъёма: шаги шкалы отступов до 24 px (§11.1: подъём −24…24). */
function liftSteps() {
  return scaleSteps(state.doc, 'spacing')
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v > 0 && x.v <= 24);
}

const SCALE_CHOICES = [0.95, 0.97, 0.98, 1.02, 1.03, 1.05, 1.1];
const OPACITY_CHOICES = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
const SPEED_REFS = ['motion.fast', 'motion.base', 'motion.slow'];
const EASINGS = ['standard', 'emphasized', 'decelerate', 'accelerate', 'linear', 'spring'];

/** Записать поле состояния одной транзакцией (`set`, отмена — та же). */
function writeState(node, key, field, value) {
  const list = SHELL.stateWriteOps(node, key, field, value);
  if (!list.length) return;
  commit(list.map((o) => OPS.set(node.id, o.path, o.value)), 'Состояние');
}

function writeMotion(node, field, value) {
  const list = SHELL.motionWriteOps(node, field, value);
  if (!list.length) return;
  commit(list.map((o) => OPS.set(node.id, o.path, o.value)), 'Движение');
}

/** Выбор из списка, где «—» значит «как в покое» (поле не задано). */
function optField(choices, current, onChange, word, label) {
  const sel = document.createElement('select');
  sel.className = 'field';
  if (label) sel.setAttribute('aria-label', label);
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
    return o;
  };
  add('', 'как в покое');
  const keys = choices.map((c) => JSON.stringify(c));
  choices.forEach((c, i) => add(keys[i], word(c)));
  if (current !== undefined && !keys.includes(JSON.stringify(current))) add(JSON.stringify(current), word(current));
  sel.value = current === undefined ? '' : JSON.stringify(current);
  sel.addEventListener('change', () => onChange(sel.value === '' ? undefined : JSON.parse(sel.value)));
  return sel;
}

/** Цвет состояния: та же палитра токенов, свёрнутая под строку «Заливка: акцент». */
function stateColorField(node, key, field, cur, title) {
  const d = document.createElement('details');
  d.className = 'state-color';
  const sum = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'swatch-dot';
  const tok = colorToken(cur);
  const hex = tok ? colorsAt(node)[tok] : null;
  // «как в покое» — пунктирное кольцо, а не перечёркнутый кружок «без заливки»: это не цвет
  if (cur !== undefined && hex) dot.style.background = hex; else dot.classList.add(cur === undefined ? 'same' : 'none');
  const txt = document.createElement('span');
  txt.textContent = `${title}: ${cur === undefined ? 'как в покое' : humanValue(cur)}`;
  sum.append(dot, txt);
  d.appendChild(sum);
  d.appendChild(swatches(node, field, `${title} при состоянии`, {
    value: cur, noneLabel: 'Как в покое', onPick: (v) => writeState(node, key, field, v),
  }));
  return d;
}

function statesGroup(node) {
  const has = SHELL.statesOf(node);
  // вкладка помнится для слоя, на котором её выбрали; у другого слоя — первое заданное
  let key = state.stateTabFor === node.id && SHELL.STATE_KEYS.includes(state.stateTab) ? state.stateTab : null;
  if (!key) key = has[0] || 'hover';
  const st = (node.states && node.states[key]) || null;
  const motion = node.motion || {};
  const kids = [];

  // вкладки: «Наведение / Нажатие / Фокус», у заданных — точка
  const tabs = document.createElement('div');
  tabs.className = 'seg state-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Состояние');
  for (const k of SHELL.STATE_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(k === key));
    b.setAttribute('aria-pressed', String(k === key));
    b.dataset.state = k;
    b.textContent = SHELL.STATE_TITLES[k];
    if (has.includes(k)) {
      b.dataset.set = 'on';
      b.title = `${SHELL.STATE_TITLES[k]} задано`;
    }
    b.addEventListener('click', () => { state.stateTab = k; state.stateTabFor = node.id; renderInspector(); });
    tabs.appendChild(b);
  }
  kids.push(tabs);

  const title = SHELL.STATE_TITLES[key];
  if (!st) {
    kids.push(noteEl(`${title} не задано — слой не меняется. Любое поле ниже его задаст.`));
    if (key === 'hover') {
      const quick = document.createElement('button');
      quick.type = 'button';
      quick.className = 'btn subtle small';
      quick.textContent = 'Подъём и тень';
      quick.title = 'Приподнять на 2 px и дать среднюю тень при наведении — одной правкой';
      const lift = liftSteps()[0];
      quick.addEventListener('click', () => {
        const value = { lift: lift ? scaleRef('spacing', lift.i) : 2, shadow: 'shadow.md' };
        const list = node.states && typeof node.states === 'object'
          ? [OPS.set(node.id, 'states.hover', value)]
          : [OPS.set(node.id, 'states', { hover: value })];
        if (!node.motion) list.push(OPS.set(node.id, 'motion', { duration: 'motion.fast' }));
        commit(list, 'Состояние');
      });
      kids.push(quick);
    }
  }
  const cur = st || {};
  if ('fill' in node || ['frame', 'rect', 'ellipse', 'instance'].includes(node.type)) {
    kids.push(stateColorField(node, key, 'fill', cur.fill, 'Заливка'));
  }
  if (node.type === 'text') kids.push(stateColorField(node, key, 'color', cur.color, 'Цвет текста'));

  // тень: нет / лёгкая / средняя / сильная (незаданная читается как «нет», если у слоя её нет)
  const baseShadow = node.shadow && node.shadow !== 'none' ? node.shadow : null;
  const shadowNow = cur.shadow !== undefined ? cur.shadow : (baseShadow || 'none');
  const shadowKeys = Object.keys(SHELL.SHADOW_WORDS);
  // списком, а не переключателем: четыре слова в узкой колонке (1024 px) слипались
  kids.push(row('Тень', selectField(shadowKeys, shadowNow, (v) => {
    const write = v === 'none' && !baseShadow ? undefined : (v === baseShadow ? undefined : v);
    writeState(node, key, 'shadow', write);
  }, SHELL.SHADOW_WORDS)));

  const lifts = liftSteps().map((x) => scaleRef('spacing', x.i));
  kids.push(row('Подъём', optField(lifts, cur.lift, (v) => writeState(node, key, 'lift', v),
    (v) => SHELL.stateValueWord('lift', v, { tokens: state.doc.tokens }), 'Подъём')));
  kids.push(row('Масштаб', optField(SCALE_CHOICES, cur.scale, (v) => writeState(node, key, 'scale', v),
    (v) => SHELL.stateValueWord('scale', v), 'Масштаб')));
  kids.push(row('Непрозр.', optField(OPACITY_CHOICES, cur.opacity, (v) => writeState(node, key, 'opacity', v),
    (v) => SHELL.stateValueWord('opacity', v), 'Непрозрачность')));

  // движение — одно на слой, общее для всех состояний
  const dur = motion.duration;
  const speedNow = typeof dur === 'string' && SPEED_REFS.includes(dur) ? dur : (dur === undefined ? 'motion.base' : null);
  kids.push(row('Скорость', segField(SPEED_REFS, speedNow, (v) => writeMotion(node, 'duration', v),
    SPEED_REFS.map((r) => SHELL.SPEED_WORDS[r]))));
  if (typeof dur === 'number') kids.push(noteEl(`Сейчас ${numText(dur)} мс — мимо шкалы движения; выбор выше поставит шаг шкалы.`));
  kids.push(row('Кривая', selectField(EASINGS, motion.easing || 'standard',
    (v) => writeMotion(node, 'easing', v), SHELL.EASING_WORDS)));
  if (motion.follow === 'parent') kids.push(noteEl('Следует за родителем: состояние включается, когда наводят на родителя с состояниями.'));

  const acts = document.createElement('div');
  acts.className = 'state-acts';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'btn subtle small with-icon';
  play.append(iconEl('play'));
  const pl = document.createElement('span');
  pl.textContent = 'Проиграть';
  play.appendChild(pl);
  play.disabled = !st;
  play.title = st ? `Показать «${title.toLowerCase()}» на холсте на 1,5 с` : `${title} не задано — проигрывать нечего`;
  play.addEventListener('click', () => playStateNow(node.id, key));
  acts.appendChild(play);
  if (st) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn ghost small state-remove';
    rm.textContent = 'Убрать состояние';
    rm.title = `Убрать «${title.toLowerCase()}» у слоя — вернуть можно отменой`;
    rm.addEventListener('click', () => {
      const list = SHELL.stateRemoveOps(node, key);
      if (list.length) commit(list.map((o) => OPS.set(node.id, o.path, o.value)), 'Убрать состояние');
    });
    acts.appendChild(rm);
  }
  kids.push(acts);
  const g = group('Состояния', kids);
  g.classList.add('states-group');
  return g;
}

/* ----------------- круг 37 (SPEC §12.3): векторы, иллюстрации, поворот ----------------- */

/** Открытые редакторы краски: перерисовка инспектора после правки их не захлопывает. */
const paintOpen = new Set();
/** Выбранный контур вектора: {node, i} — список контуров помнит выбор для слоя. */
let pathPick = null;

/**
 * Круг 48 (SPEC §15): документ, каким его видит слой — токены его доски (тема поверх документа).
 * Образцы цветов инспектора и кружки краски показывают значения той доски, где слой лежит.
 */
function tokenDoc(node) {
  if (!node || !node.id || typeof CORE.docAt !== 'function') return state.doc;
  // узлы раскрытых экземпляров есть только в geo.expanded — доску ищем и по ним
  const ex = state.geo && state.geo.expanded;
  const get = (id) => (ex && typeof id === 'string' && Object.prototype.hasOwnProperty.call(ex, id) ? ex[id]
    : state.doc.nodes && typeof id === 'string' && Object.prototype.hasOwnProperty.call(state.doc.nodes, id) ? state.doc.nodes[id] : undefined);
  try { return CORE.docAt(state.doc, node.id, get) || state.doc; } catch { return state.doc; }
}
/** Цвета токенов на доске слоя. */
function colorsAt(node) {
  const d = tokenDoc(node);
  return (d && d.tokens && d.tokens.colors) || state.doc.tokens.colors || {};
}

/** Фон кружка-образца краски: ядро знает градиенты точнее (resolvePaint), без него — словарь. */
function paintBg(p, node) {
  if (p === undefined || p === null) return '';
  if (typeof CORE.paintCss === 'function') {
    try { const css = CORE.paintCss(tokenDoc(node), p); if (css) return css; } catch { /* ниже — своё */ }
  }
  return SHELL.paintCss(p, colorsAt(node));
}

/** Записать поле контура (или всех контуров) одной транзакцией. */
function writePaths(node, which, field, value) {
  // «без заливки» у контура, который унаследовал бы краску вектора, — явное «нет» (null)
  if (value === undefined && (field === 'fill' || field === 'stroke') && node[field] !== undefined && node[field] !== null) value = null;
  const list = SHELL.pathsWriteOps(node, which, field, value);
  if (!list.length) return;
  commit(list.map((o) => OPS.set(node.id, o.path, o.value)), which === 'all' ? 'Контуры' : 'Контур');
}

/** Поле, которое пишет значение по умолчанию снятием (поворот 0, непрозрачность 100 %). */
function writeVisual(node, path, value, neutral) {
  const v = value === neutral ? undefined : value;
  if (v === undefined && node[path] === undefined) return;
  if (v !== undefined && node[path] === v) return;
  commit([OPS.set(node.id, path, v)], path === 'rotate' ? 'Поворот' : 'Непрозрачность');
}

/** Цветовое поле: кружок-образец и hex рядом; правка — по «change» (одна транзакция). */
function colorInput(hex, onPick, label) {
  const w = document.createElement('div');
  w.className = 'paint-color';
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.className = 'paint-color-input';
  inp.value = SHELL.toHex6(hex) || '#000000';
  inp.setAttribute('aria-label', label);
  inp.title = label;
  const code = field('input', (SHELL.toHex6(hex) || '').toUpperCase(), (v) => {
    const h = SHELL.toHex6(String(v).trim().startsWith('#') ? String(v).trim() : `#${String(v).trim()}`);
    if (!h) { toast('Цвет пишется шестнадцатеричным кодом: #F4A261.', 'plain', 5000); return; }
    onPick(h);
  }, `${label}: код`);
  code.classList.add('paint-hex');
  code.spellcheck = false;
  inp.addEventListener('change', () => onPick(inp.value));
  w.append(inp, code);
  return w;
}

/**
 * Редактор краски (§12.1 Paint): сплошной цвет (код, палитра документа) или градиент —
 * два цвета, вид (линейный / радиальный) и угол. Свёрнут в строку «Заливка: #F4A261»,
 * как цвет состояния; кружок показывает краску как есть, градиент — градиентом.
 * @param {*} cur краска сейчас (undefined — нет; при mixed — «разные»)
 * @param {{key:string, title:string, mixed?:boolean, onPick:(v:any)=>void, node:object, noneLabel?:string}} o
 */
function paintField(cur, o) {
  const colors = colorsAt(o.node);
  const d = document.createElement('details');
  d.className = 'state-color paint-field';
  d.dataset.paint = o.key;
  if (paintOpen.has(o.key)) d.open = true;
  d.addEventListener('toggle', () => { if (d.open) paintOpen.add(o.key); else paintOpen.delete(o.key); });
  const sum = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'swatch-dot';
  const css = o.mixed ? '' : paintBg(cur, o.node);
  if (css) dot.style.background = css; else dot.classList.add(o.mixed ? 'same' : 'none');
  const txt = document.createElement('span');
  txt.className = 'paint-word';
  const word = o.mixed ? 'разные' : SHELL.paintWord(cur, { colors, colorWord: (v) => humanValue(v) });
  txt.textContent = `${o.title}: ${word}`;
  txt.title = txt.textContent;
  sum.append(dot, txt);
  d.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'paint-body';
  const kind = o.mixed ? 'color' : SHELL.paintKind(cur);
  const isGrad = kind === 'gradient';
  const isPat = kind === 'pattern';
  const base = (!o.mixed && SHELL.paintHex(cur, colors)) || '#F4A261';
  // круг 49 (SPEC §16): фактура — третьим видом, только там, где ядро её принимает (заливка)
  const modes = o.pattern ? ['solid', 'gradient', 'pattern'] : ['solid', 'gradient'];
  const modeSeg = segField(modes, isPat ? 'pattern' : isGrad ? 'gradient' : 'solid', (v) => {
    if (v === 'gradient' && !isGrad) o.onPick(SHELL.gradientWith(o.mixed ? base : (cur ?? base), {}, colors));
    else if (v === 'pattern' && !isPat) o.onPick(SHELL.patternWith(o.mixed ? undefined : cur, {}, colors));
    else if (v === 'solid' && (isGrad || isPat)) o.onPick(isPat ? (SHELL.patternOf(cur).bg || base) : (SHELL.paintHex(cur, colors) || base));
  }, o.pattern ? ['Цвет', 'Градиент', 'Фактура'] : ['Цвет', 'Градиент']);
  nameControl(modeSeg, o.pattern ? `${o.title}: цвет, градиент или фактура` : `${o.title}: цвет или градиент`);
  body.appendChild(modeSeg);

  if (isPat) {
    const pt = SHELL.patternOf(cur);
    const set = (ch) => o.onPick(SHELL.patternWith(cur, ch, colors));
    const kindSel = selectField(SHELL.PATTERN_KINDS, pt.kind, (v) => set({ kind: v }), SHELL.PATTERN_RU);
    nameControl(kindSel, `${o.title}: вид фактуры`);
    body.appendChild(row('Узор', kindSel));
    const hexOf = (v) => SHELL.paintHex(v, colors) || '';
    body.appendChild(row('Цвет', colorInput(hexOf(pt.color), (h) => set({ color: h }), `${o.title}: цвет узора`)));
    body.appendChild(row('Подложка', colorInput(hexOf(pt.bg), (h) => set({ bg: h }), `${o.title}: цвет подложки`)));
    body.appendChild(row('Шаг', numberField(Number(pt.size) || 12, (v) => set({ size: v }), { min: 4, max: 200, label: `${o.title}: шаг узора, px` })));
    if (pt.kind === 'lines' || pt.kind === 'waves' || pt.kind === 'grid' || pt.kind === 'checks') {
      body.appendChild(row('Угол', numberField(Number(pt.angle) || 0, (v) => set({ angle: v }), { min: 0, max: 360, label: `${o.title}: угол узора` })));
    }
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'btn ghost small';
    off.textContent = o.noneLabel || 'Без заливки';
    off.addEventListener('click', () => o.onPick(undefined));
    body.appendChild(off);
  } else if (!isGrad) {
    body.appendChild(row('Код', colorInput(kind === 'none' ? '' : base, (h) => o.onPick(h), `${o.title}: цвет`)));
    body.appendChild(swatches(o.node, 'fill', `${o.title}: палитра`, {
      // «разные» — ни один образец не нажат, и «без заливки» тоже
      value: o.mixed ? '\u0000mixed' : cur, noneLabel: o.noneLabel || 'Без заливки', onPick: (v) => o.onPick(v),
    }));
    // «Без заливки» в swatches — пунктирное кольцо при noneLabel; здесь это настоящее «нет»
    const none = body.querySelector('.swatch-dot.same');
    if (none) { none.classList.remove('same'); none.classList.add('none'); }
  } else {
    const g = SHELL.gradientOf(cur);
    const stops = Array.isArray(g.stops) ? g.stops : [];
    const first = SHELL.stopColor(stops[0], colors) || base;
    const last = SHELL.stopColor(stops[stops.length - 1], colors) || base;
    const radial = g.kind === 'radial';
    // на всю ширину: в узкой колонке (1024 px) «Радиальный» рядом с подписью не помещался
    const kindSeg = segField(['linear', 'radial'], radial ? 'radial' : 'linear',
      (v) => o.onPick(SHELL.gradientWith(cur, { kind: v }, colors)), ['Линейный', 'Радиальный']);
    nameControl(kindSeg, `${o.title}: вид градиента`);
    body.appendChild(kindSeg);
    body.appendChild(row(radial ? 'Центр' : 'Начало', colorInput(first, (h) => o.onPick(SHELL.gradientWith(cur, { from: h }, colors)), `${o.title}: ${radial ? 'цвет в центре' : 'цвет в начале'}`)));
    body.appendChild(row(radial ? 'Край' : 'Конец', colorInput(last, (h) => o.onPick(SHELL.gradientWith(cur, { to: h }, colors)), `${o.title}: ${radial ? 'цвет у края' : 'цвет в конце'}`)));
    if (!radial) {
      body.appendChild(row('Угол', numberField(Number.isFinite(Number(g.angle)) ? Number(g.angle) : SHELL.GRADIENT_ANGLE_DEFAULT,
        (v) => o.onPick(SHELL.gradientWith(cur, { angle: v }, colors)), { min: 0, max: 360, label: `${o.title}: угол градиента` })));
    }
    if (stops.length > 2) body.appendChild(noteEl(`Промежуточных цветов: ${stops.length - 2} — они остаются как есть.`));
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'btn ghost small';
    off.textContent = o.noneLabel || 'Без заливки';
    off.addEventListener('click', () => o.onPick(undefined));
    body.appendChild(off);
  }
  d.appendChild(body);
  return d;
}

/** «Вид»: поворот (у всех, кроме страницы и доски) и непрозрачность — визуальные поля §11–12. */
function lookGroup(node) {
  const kids = [];
  const rot = numberField(Number(node.rotate) || 0, (v) => writeVisual(node, 'rotate', v, 0),
    { min: -360, max: 360, label: 'Поворот, градусы' });
  const unit = (el, u) => {
    const w = document.createElement('div');
    w.className = 'unit-field';
    const s = document.createElement('span');
    s.className = 'unit';
    s.textContent = u;
    s.setAttribute('aria-hidden', 'true');
    w.append(el, s);
    return w;
  };
  kids.push(row('Поворот', unit(rot, '°')));
  const op = numberField(Math.round((node.opacity ?? 1) * 100), (v) => writeVisual(node, 'opacity', Math.round(v) / 100, 1),
    { min: 0, max: 100, label: 'Непрозрачность, проценты' });
  kids.push(row('Непрозр.', unit(op, '%')));
  return group('Вид', kids);
}

/** У ребёнка свободной рамки — X и Y от её края (§12.3); тащить можно и мышью. */
function freePosGroup(node, parent) {
  const pos = node.pos && typeof node.pos === 'object' ? node.pos : { x: 0, y: 0 };
  const put = (axis, v) => {
    const next = { x: Number(pos.x) || 0, y: Number(pos.y) || 0, [axis]: v };
    if (node.pos && next.x === node.pos.x && next.y === node.pos.y) return;
    commit([OPS.set(node.id, 'pos', next)], 'Положение');
  };
  const x = numberField(Number(pos.x) || 0, (v) => put('x', v), { min: -100000, max: 100000, label: 'X' });
  const y = numberField(Number(pos.y) || 0, (v) => put('y', v), { min: -100000, max: 100000, label: 'Y' });
  const pair = document.createElement('div');
  pair.className = 'xy-pair';
  const lx = document.createElement('label'); lx.textContent = 'X'; nameControl(x, 'X', lx);
  const ly = document.createElement('label'); ly.textContent = 'Y'; nameControl(y, 'Y', ly);
  pair.append(lx, x, ly, y);
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('label');
  l.textContent = 'Место';
  r.append(l, pair);
  return group('Положение', [
    r,
    noteEl(`От левого верхнего угла «${displayName(state.doc, parent)}». Тащите на холсте или стрелками: 1 px, с Shift — 10 px.`),
  ]);
}

/** Контуры вектора: краска всех разом, список с цветом и правка выбранного (§12.3). */
function vectorGroup(node) {
  const paths = SHELL.vectorPaths(node);
  const kids = [];
  if (!paths.length) {
    kids.push(noteEl('Контуров нет — вектор пустой. Попросите агента дорисовать.'));
    return group('Контуры', kids);
  }
  const all = paths.length > 1 ? 'всех' : '';
  const fillC = SHELL.commonPathValue(node, 'fill');
  const strokeC = SHELL.commonPathValue(node, 'stroke');
  const widthC = SHELL.commonPathValue(node, 'strokeWidth');
  kids.push(paintField(fillC.value, {
    key: `${node.id}|all|fill`, title: all ? 'Заливка всех' : 'Заливка', mixed: fillC.mixed, node,
    onPick: (v) => writePaths(node, 'all', 'fill', v),
  }));
  kids.push(paintField(strokeC.value, {
    key: `${node.id}|all|stroke`, title: all ? 'Обводка всех' : 'Обводка', mixed: strokeC.mixed, node, noneLabel: 'Без обводки',
    onPick: (v) => writePaths(node, 'all', 'stroke', v),
  }));
  // толщина без обводки ничего не значит — поле появляется, когда обводка есть
  if (strokeC.mixed || SHELL.paintKind(strokeC.value) !== 'none') kids.push(row('Толщина', numberField(widthC.mixed ? 0 : (Number(widthC.value) || 0),
    (v) => writePaths(node, 'all', 'strokeWidth', v),
    { min: 0, max: 64, label: widthC.mixed ? 'Толщина обводки всех контуров (сейчас разная)' : 'Толщина обводки всех контуров' })));
  if (widthC.mixed && (strokeC.mixed || SHELL.paintKind(strokeC.value) !== 'none')) kids.push(noteEl('Толщина у контуров разная — новое число встанет всем.'));

  if (paths.length > 1) {
    const colors = colorsAt(node);
    const pick = pathPick && pathPick.node === node.id && pathPick.i < paths.length ? pathPick.i : -1;
    const list = document.createElement('div');
    list.className = 'path-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', `Контуры: ${paths.length}`);
    paths.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'path-row';
      b.dataset.path = String(i);
      b.setAttribute('aria-pressed', String(i === pick));
      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      // что контур показывает на деле: своя краска или унаследованная от вектора
      const fillNow = SHELL.effectivePathValue(node, p, 'fill');
      const strokeNow = SHELL.effectivePathValue(node, p, 'stroke');
      const css = paintBg(fillNow, node);
      if (css) dot.style.background = css; else dot.classList.add('none');
      const sc = SHELL.paintHex(strokeNow, colors);
      if (sc && Number(SHELL.effectivePathValue(node, p, 'strokeWidth')) > 0) dot.style.boxShadow = `0 0 0 2px var(--panel-2), 0 0 0 3.5px ${sc}`;
      const nm = document.createElement('span');
      nm.className = 'path-name';
      nm.textContent = SHELL.pathLabel(i, p);
      const wd = document.createElement('span');
      wd.className = 'path-val';
      const say = (v) => SHELL.paintWord(v, { colors, colorWord: (x) => humanValue(x) });
      wd.textContent = say(fillNow);
      b.title = `${SHELL.pathLabel(i, p)}: заливка ${say(fillNow)}${sc ? `, обводка ${say(strokeNow)}` : ''}`;
      b.append(dot, nm, wd);
      b.addEventListener('click', () => {
        pathPick = i === pick ? null : { node: node.id, i };
        renderInspector();
        const again = dom['insp-body'].querySelector(`.path-row[data-path="${i}"]`);
        if (again) again.focus();
      });
      list.appendChild(b);
    });
    kids.push(list);
    if (pick >= 0) {
      const p = paths[pick] || {};
      const sub = document.createElement('div');
      sub.className = 'path-edit';
      const h = document.createElement('div');
      h.className = 'path-edit-title';
      h.textContent = SHELL.pathLabel(pick, p);
      sub.appendChild(h);
      sub.appendChild(paintField(SHELL.effectivePathValue(node, p, 'fill'), {
        key: `${node.id}|${pick}|fill`, title: 'Заливка', node, onPick: (v) => writePaths(node, pick, 'fill', v),
      }));
      sub.appendChild(paintField(SHELL.effectivePathValue(node, p, 'stroke'), {
        key: `${node.id}|${pick}|stroke`, title: 'Обводка', node, noneLabel: 'Без обводки',
        onPick: (v) => writePaths(node, pick, 'stroke', v),
      }));
      if (SHELL.paintKind(SHELL.effectivePathValue(node, p, 'stroke')) !== 'none') sub.appendChild(row('Толщина', numberField(Number(SHELL.effectivePathValue(node, p, 'strokeWidth')) || 0,
        (v) => writePaths(node, pick, 'strokeWidth', v), { min: 0, max: 64, label: `Толщина обводки, ${SHELL.pathLabel(pick, p)}` })));
      kids.push(sub);
    } else {
      kids.push(noteEl('Выберите контур — у него своя заливка и обводка.'));
    }
  }
  return group('Контуры', kids);
}

/**
 * Заливка рамки, прямоугольника, эллипса (§12.1: тоже Paint). Токен палитры — прежние
 * образцы; свой цвет или градиент — редактор краски (в нём та же палитра). Перейти к
 * градиенту можно и из образцов — кнопкой под ними.
 */
function fillGroup(node) {
  const kind = SHELL.paintKind(node.fill);
  const pick = (v) => setProp(node.id, 'fill', v);
  if (kind === 'gradient' || kind === 'color' || kind === 'pattern') {
    return group('Заливка', [paintField(node.fill, { key: `${node.id}|fill`, title: 'Заливка', node, onPick: pick, pattern: true })]);
  }
  const grad = document.createElement('button');
  grad.type = 'button';
  grad.className = 'linkish';
  grad.textContent = 'Градиент, фактура или свой цвет…';
  grad.title = 'Залить градиентом из текущего цвета — вернуть можно отменой';
  grad.addEventListener('click', () => pick(SHELL.gradientWith(node.fill, {}, colorsAt(node))));
  return group('Заливка', [swatches(node, 'fill', 'Заливка'), grad]);
}

/* ---- круг 37 (§12.3): детали свободной рамки под рукой на холсте ---- */

/** Shift зажат прямо сейчас (по последнему событию указателя или клавиатуры). */
let shiftNow = false;
/** Жест сдвига детали с замком оси: {id, axis:'x'|'y', pos:{x,y}} — для поправки коммита. */
let axisLock = null;

/** Деталь — ребёнок свободной рамки (не доски и не холста). */
function detailParent(id) {
  const n = id ? nodeById(state.doc, id) : null;
  return n ? SHELL.freeParentOf(state.doc, n) : null;
}

/** Верхняя деталь рамки под точкой мира: сцена знает контуры, без неё — по рамкам. */
function detailUnder(frame, w) {
  if (stage && typeof stage._topUnder === 'function') {
    try {
      let n = stage._topUnder(w);
      while (n && n.parent && n.parent !== frame.id) n = nodeById(state.doc, n.parent);
      if (n && n.parent === frame.id) return n;
    } catch { /* ниже — по рамкам */ }
  }
  const rects = (state.geo && state.geo.rects) || {};
  const kids = (frame.children || []).slice().reverse();
  for (const id of kids) {
    const n = nodeById(state.doc, id);
    const r = rects[id];
    if (!n || !r || n.visible === false || n.locked) continue;
    if (w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h) return n;
  }
  return null;
}

/**
 * Сцена выделяет щелчком верхний уровень доски (иллюстрацию целиком), вглубь — двойным
 * щелчком или с Ctrl/Alt. Внутри иллюстрации это значило бы двойной щелчок на КАЖДУЮ деталь.
 * Поэтому, когда выделена деталь, щелчок по соседней детали той же рамки выделяет её сразу
 * — и её же можно тут же тащить (сцена берёт выделенный узел под курсором). Щелчок мимо
 * рамки — обычный выбор сцены.
 *
 * Shift во время сдвига детали держит ось (больший из сдвигов): точку мира для жеста
 * сцена берёт через toWorld — её мы и проецируем, поэтому призрак и итог совпадают.
 */
function initDetailGestures() {
  if (!stage || !stage.el) return;
  const host = stage.el;
  const track = (e) => { shiftNow = !!e.shiftKey; };
  host.addEventListener('pointerdown', (e) => {
    track(e);
    axisLock = null;
    if (e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || previewOn()) return;
    if (e.target && e.target.dataset && e.target.dataset.handle) return;
    if (state.selection.length !== 1) return;
    const frame = detailParent(state.selection[0]);
    if (!frame) return;
    const w = stage.toWorld(e.clientX, e.clientY);
    const fr = state.geo && state.geo.rects && state.geo.rects[frame.id];
    if (!fr || w.x < fr.x || w.x > fr.x + fr.w || w.y < fr.y || w.y > fr.y + fr.h) return;
    const hit = detailUnder(frame, w);
    if (hit && hit.id !== state.selection[0]) setSelection([hit.id], { quiet: true });
  }, true);
  host.addEventListener('pointermove', track, true);
  host.addEventListener('pointerup', track, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftNow = true; }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftNow = false; }, true);
  window.addEventListener('blur', () => { shiftNow = false; });

  const baseToWorld = stage.toWorld;
  stage.toWorld = function (clientX, clientY) {
    const w = baseToWorld.call(this, clientX, clientY);
    const d = this._drag;
    if (!d || (d.mode !== 'move' && d.mode !== 'maybe-move') || !d.start || !d.id) return w;
    if (!shiftNow || !detailParent(d.id)) { if (axisLock && axisLock.id === d.id) axisLock = null; return w; }
    const dx = w.x - d.start.x;
    const dy = w.y - d.start.y;
    const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    const n = nodeById(state.doc, d.id);
    const pos = n && n.pos ? n.pos : { x: 0, y: 0 };
    axisLock = { id: d.id, axis, pos: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 } };
    return axis === 'x' ? { x: w.x, y: d.start.y } : { x: d.start.x, y: w.y };
  };
}

/**
 * Итог жеста сцены перед записью: сдвиг детали с Shift держит ось и после магнитов (они
 * могли сместить другую ось на пару пикселей). Остальные правки сцены — как есть.
 */
function stageOps(ops) {
  const lock = axisLock;
  axisLock = null;
  if (!lock || !Array.isArray(ops) || ops.length !== 1) return ops;
  const op = ops[0];
  if (!op || op.op !== 'set' || op.id !== lock.id || op.path !== 'pos' || !op.value) return ops;
  const keep = lock.axis === 'x' ? 'y' : 'x';
  return [{ ...op, value: { ...op.value, [keep]: lock.pos[keep] } }];
}

/** Смена потока рамки: в «свободно» и обратно — без прыжков детей (§12.1). */
function setLayoutMode(node, mode) {
  const R = resolveLayout(state.doc, node.layout);
  const list = SHELL.freeModeOps(node, state.doc, state.geo.rects, R.padding, mode);
  if (!list.length) return;
  commit(list.map((o) => OPS.set(o.id, o.path, o.value)), 'Поток');
}

/** Ручное положение узла: одна и та же группа у обычного узла и у экземпляра (круг 19, п.5). */
function overrideGroup(node) {
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Слой отсоединён: положение задано вручную и переживает правки агента.';
  const btn = document.createElement('button');
  btn.className = 'btn subtle small';
  btn.textContent = 'Вернуть в поток';
  btn.addEventListener('click', () => commit([OPS.set(node.id, 'override', undefined)], 'Вернуть в поток'));
  return group('Положение', [note, btn]);
}

function tokenType(token, node) {
  const d = node ? tokenDoc(node) : state.doc;
  return (d.tokens.type && d.tokens.type[token]) || { fontSize: 16, fontWeight: 400 };
}

/**
 * Круг 48 (SPEC §15): тема выделенной доски — строка «что своё» и кнопка «Вернуть общее
 * оформление». Задают тему словами агенту; здесь — увидеть и снять.
 */
function boardThemeGroup(node) {
  if (!node || node.type !== 'frame' || node.parent !== state.doc.root || typeof CORE.boardTheme !== 'function') return null;
  const t = CORE.boardTheme(node);
  if (!t) return null;
  const bits = [];
  for (const [k, v] of Object.entries(t.colors || {})) bits.push(`${k} ${v}`);
  for (const [k, v] of Object.entries(t.type || {})) bits.push(`${k} — ${[v.font, v.fontWeight].filter(Boolean).join(' ')}`);
  const line = document.createElement('div');
  line.className = 'note';
  line.textContent = bits.length ? `Своё у экрана: ${bits.slice(0, 4).join(', ')}${bits.length > 4 ? ` и ещё ${bits.length - 4}` : ''}` : 'Тема пустая';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = 'Вернуть общее оформление';
  btn.addEventListener('click', () => commit([OPS.set(node.id, 'theme', undefined)], 'Тема экрана снята'));
  return group('Тема экрана', [line, btn]);
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
  inp.dataset.initial = inp.value;
  if (label) inp.setAttribute('aria-label', label);
  /* Круг 33, п.1: записываем один раз и только набранное. После перерисовки набор
     возвращается в поле программно — браузер такого текста «изменённым» не считает и
     change на Enter не шлёт, поэтому Enter и уход из поля пишут сами. Пока панель
     пересобирается или слой удалён, ничего не пишется. */
  const commitNow = (force) => {
    if (inp.readOnly || inp.dataset.orphan) return;
    if (force !== true && (inspRebuilding || inp.isConnected === false)) return;
    if (inp.value === inp.dataset.initial) return;
    inp.dataset.initial = inp.value;
    onChange(inp.value);
  };
  inp._commitNow = () => commitNow(true);
  inp.addEventListener('change', () => commitNow());
  inp.addEventListener('blur', () => commitNow());
  if (kind !== 'textarea') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) commitNow(); });
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
  /* Круг 20, п.4. Что в поле записано в документ: пока текст равен записанному, Ctrl+Z
     в этом поле отменяет ПРАВКУ ДОКУМЕНТА, а не набор (набирать нечего — см. onKey).
     Иначе после Enter в шаге шкалы фокус оставался в поле, и Ctrl+Z не делал ничего. */
  inp.dataset.committed = inp.value;
  if (opts.label) inp.setAttribute('aria-label', opts.label);
  inp.addEventListener('change', () => {
    // круг 33: Enter ниже и родной change — одна запись, а не две
    if (inp.value === inp.dataset.committed || inp.readOnly || inp.dataset.orphan || inspRebuilding || inp.isConnected === false) return;
    const raw = inp.value.trim();
    const n = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      inp.value = numText(value);
      inp.dataset.committed = inp.value;
      toast('Тут нужно число — оставил прежнее значение.', 'plain', 5000);
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== n) {
      toast(`Допустимо от ${numText(min)} до ${numText(max)} — поставил ${numText(clamped)}.`, 'plain', 6000);
    }
    inp.value = numText(clamped);
    inp.dataset.committed = inp.value;
    onChange(clamped);
  });
  // набор, возвращённый в поле после перерисовки, браузер изменённым не считает (круг 33)
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inp.value !== inp.dataset.committed) inp.dispatchEvent(new Event('change'));
  });
  return inp;
}
/**
 * Круг 20, п.2 (SPEC §6.7). Поле зазора, отступа и скругления. В документе стоит ссылка
 * на шаг шкалы ('spacing.6') или число мимо шкалы; человек шкалу знать не обязан: он видит
 * ПИКСЕЛИ и признак «по шкале» / «мимо шкалы», а выбирает из шагов шкалы (список со
 * значениями) либо «своё число». Выбран шаг — пишется ссылка; своё число — число.
 *
 * Своё число, ТОЧНО равное шагу, пишется ссылкой на этот шаг: так же поступает мозг с
 * числом от модели (§6.6), и документ не обрастает числами, которые от шкалы ничем не
 * отличаются, кроме записи. Человек это видит сразу — подпись под полем говорит «по шкале».
 *
 * Мёртвая ссылка (шага с таким номером в шкале нет) — отдельное состояние: решатель считает
 * её нулём, и подпись говорит об этом прямо; выбор любого шага её лечит.
 *
 * @param {any} raw сырое значение поля: ссылка, число либо undefined (= 0)
 * @param {'spacing'|'radii'} scale
 * @param {(v:any)=>void} write что записать — ссылку или число
 * @param {{label:string, note?:string}} opts note — приписка к подписи («стороны разные…»)
 */
function scaleField(raw, scale, write, opts = {}) {
  const doc = state.doc;
  const steps = scaleSteps(doc, scale);
  const ref = parseScaleRef(raw);
  const px = raw === undefined ? 0 : resolveScale(doc, raw, scale);   // undefined — мёртвая ссылка
  const dead = !!ref && px === undefined;
  const onScale = !!ref && !dead;
  const shownPx = px === undefined ? 0 : px;
  const label = opts.label || SCALE_NAMES[scale];

  const wrap = document.createElement('div');
  wrap.className = 'scalepick';
  wrap.dataset.state = dead ? 'dead' : onScale ? 'scale' : 'off';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', label);

  const line = document.createElement('div');
  line.className = 'scalepick-line';
  const sel = document.createElement('select');
  sel.className = 'field';
  sel.setAttribute('aria-label', `${label}: шаг шкалы`);
  steps.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = numText(v);
    sel.appendChild(o);
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'своё число';
  sel.appendChild(custom);
  if (dead) {
    const o = document.createElement('option');
    o.value = 'dead';
    o.disabled = true;
    o.textContent = `шаг №${ref.index} — нет`;
    sel.appendChild(o);
    sel.value = 'dead';
  } else {
    sel.value = onScale ? String(ref.index) : 'custom';
  }
  line.appendChild(sel);

  // своё число: поле появляется рядом со списком, пока выбрано «своё число»
  let num = null;
  const showNum = (focus) => {
    if (num) return;
    num = numberField(shownPx, (v) => {
      // круг 20: число, совпавшее с шагом, — ссылка на шаг (см. шапку функции)
      const i = scaleIndexOf(state.doc, scale, v);
      write(i >= 0 ? scaleRef(scale, i) : v);
    }, { label: `${label}: своё число` });
    num.classList.add('scalepick-num');
    line.appendChild(num);
    if (focus) { try { num.focus(); num.select(); } catch { /* поле могло не встать */ } }
  };
  if (!dead && !onScale) showNum(false);

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') { showNum(true); return; }
    if (sel.value === 'dead') return;
    write(scaleRef(scale, Number(sel.value)));
  });
  wrap.appendChild(line);

  /* Подпись — то, что человек читает: «12 · по шкале», «15 · мимо шкалы». Слово «шкала»
     здесь без уточнения: какая именно, сказано в заголовке группы и в ссылке под ней. */
  const note = document.createElement('div');
  note.className = 'scalepick-note';
  let text = dead
    ? `шага №${ref.index} в ${SCALE_LOC[scale]} нет — считается 0`
    : `${numText(shownPx)} · ${onScale ? 'по шкале' : 'мимо шкалы'}`;
  if (opts.note) text += ` · ${opts.note}`;
  note.textContent = text;
  wrap.appendChild(note);
  return wrap;
}

/**
 * Круг 20, п.4. Ссылка на редактор шкал прямо из инспектора: человек читает «по шкале» и тут
 * же может посмотреть, что это за шкала, и поправить её. Вторая дорога — кнопка «Шкалы»
 * в шапке: она нужна, когда ничего не выделено.
 */
function scaleLink(scale) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'linkish';
  b.textContent = `${SCALE_NAMES[scale].charAt(0).toUpperCase()}${SCALE_NAMES[scale].slice(1)}…`;
  b.title = `Открыть ${SCALE_NAMES[scale].replace(/^шкала/, 'шкалу')}: значения шагов и сколько слоёв на них ссылается`;
  b.addEventListener('click', () => openScales(scale));
  return b;
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
      scheduleViewChrome();
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
/**
 * @param {object} node узел, которому принадлежит цвет
 * @param {string} prop поле узла (или имя свойства компонента — тогда пишет opts.onPick)
 * @param {string} label доступное имя группы
 * @param {{value?:*, onPick?:Function}} [opts] круг 19, п.5: у свойства экземпляра цвет
 *   лежит не в поле узла, а в props — читаем и пишем его снаружи, палитра та же самая.
 */
function swatches(node, prop, label, opts = {}) {
  const w = document.createElement('div');
  w.className = 'swatch-groups';
  w.setAttribute('role', 'group');
  w.setAttribute('aria-label', label || 'Цвет');
  const colors = colorsAt(node);
  const cur = colorToken('value' in opts ? opts.value : node[prop]);
  const pick = typeof opts.onPick === 'function' ? opts.onPick : ((v) => setProp(node.id, prop, v));
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
    b.addEventListener('click', () => pick({ token: name }));
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
  dot.className = opts.noneLabel ? 'swatch-dot same' : 'swatch-dot none';
  const cap = document.createElement('span');
  cap.className = 'swatch-name';
  cap.textContent = opts.noneLabel || (prop === 'color' ? 'Без цвета' : 'Без заливки');
  none.append(dot, cap);
  none.title = cap.textContent;
  none.addEventListener('click', () => pick(undefined));
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
/* Круг 38: справка, палитра, ошибки набора «/…», выделение и вид — тоже не ждут агента. Правки
   командами таблицы — те же ручные правки (стрелка M, мимо очереди агента): холст во время работы
   агента правится руками, значит, и командой. */
const SHELL_WHILE_BUSY = new Set(['stop', 'variants-close', 'fit', 'zoom', 'sheet', 'rail', 'theme', 'export', 'preview',
  'help', 'palette', 'slash-unknown', 'slash-bad', 'fit-selection', 'inspector', 'select', 'select-all', 'select-rel',
  'delete', 'duplicate', 'rename', 'visible', 'lock', 'order', 'wrap', 'ungroup', 'align', 'direction', 'gap']);

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
  // круг 25: по кодовым точкам — эмодзи в имени не режется пополам
  if (Array.from(t).length <= n) return t;
  const cut = cutText(t, n, { ellipsis: true });
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
  /* Круг 39 (UX): итог предыдущей команды (с припиской и «Отменить») остаётся на экране, пока
     следующая из очереди работает, — раньше он мелькал на 0,2 с и пропадал. */
  setTimeout(() => runUtterance(next.text, { variants: next.variants, keepResult: true }), 60);
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

async function runUtterance(text, { variants = false, toModel = false, local = false, keepResult = false } = {}) {
  const utterance = String(text || '').trim();
  if (!utterance) {
    /* Сюда приходит только пустая СТРОКА: нераспознанную речь голосовой путь до сюда
       не доводит. «Я не расслышал команду» в ответ на клик по «Выполнить» — неправда,
       а в артефакте микрофона нет вовсе (круг 11, п.5). */
    const examples = (docIsEmpty() ? EMPTY_EXAMPLES : ARTBOARD_EXAMPLES).slice(0, 2);
    // круг 17: недоступный голос помечен data-unavailable, а не disabled (объяснение по нажатию)
    const voice = !!dom['btn-mic'] && !dom['btn-mic'].disabled
      && dom['btn-mic'].dataset.unavailable !== 'on';
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

  /* Круг 29 (UX Д3): проекта на сервере нет — агенту его не прочитать и не записать.
     Команду не отправляем (она вернулась бы «проект не найден»), а говорим, что делать. */
  if (server && projectGone()) { projectGoneCommandMsg(utterance); return; }
  // круг 41 (UX Д7): версии разошлись — агент правку не запишет; не отправляем и говорим почему
  if (server && engineHalted()) { engineCommandMsg(utterance); return; }
  /* Круг 31 (m2/m3): проект не открылся — список проектов не пришёл. Агенту нечего читать и
     некуда писать: команду не отправляем, текст остаётся в строке. */
  if (server && !server.project) { noProjectCommandMsg(utterance); return; }
  if (server && !local && retryHeld(utterance)) return;
  /* Круг 27, п.7. Сети нет у самого компьютера — так и говорим. Раньше команда ждала
     проверки сервера агента и получала «сервер агента не отвечает», хотя дело не в нём. */
  if (server && !local && isOffline()) { offlineMsg(utterance, { variants }); return; }
  // круг 23: на сервере агент свой — модель браузера ему не нужна; local — «выполнить в браузере»
  let onServer = !local && agentOnServer();
  /* Круг 25, п.1. Агент «недоступен» по прошлой проверке — спросим Orchestrator ещё раз
     прямо сейчас: он мог вернуться, а ждать следующей проверки (30 с) человеку незачем. */
  if (server && !local && !onServer && !state.provider && !serverAgent.absent) {
    await probeAgent({ force: true });
    onServer = agentOnServer();
  }
  if (server && !state.provider && !onServer) {
    agentDownMsg(utterance, { variants });
    return;
  }
  if (!state.provider && !onServer) {
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
  if (!(keepResult && msgUndoTx)) hideMsg();
  if (!variants) hideVariants();
  setBusy(true);
  showStage({ stage: 'classify', label: 'Разбираю запрос', detail: utterance });

  // снимок, по которому агент считает: если человек правит руками, операции лягут не туда
  const baseStamp = docStamp(state.doc);

  try {
    /* Круг 23 (SPEC §10). Команда — на сервер; false значит «сервер её не принял», и
       тогда тот же прогон продолжает brain здесь, как раньше. */
    if (onServer && await runOnServer(utterance, { variants, ctrl, runId })) return;
    if (state.runSeq !== runId || ctrl.signal.aborted) return;

    if (variants) {
      const list = await runVariants({
        doc: state.doc, selection: state.selection, utterance,
        provider: state.provider, n: 3, signal: ctrl.signal,
        onStage: (rec) => onAgentStage(rec, 3, runId),
        history: state.pairs.slice(), geo: state.geo, activeArtboardId: activeArtboardId(),
        selectionBy: state.selectionBy,
        imageColors: imageColorsInPage,
        ...agentArtOptions(),
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
      if (docChangedUnder(baseStamp)) { staleMsg(utterance); return; }
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
      // круг 47 (SPEC §14.4): снимок черновика доски для визуального критика
      render: renderForCritic,
      imageColors: imageColorsInPage,
      ...agentArtOptions(),
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
        note: warnLine(res.warnings) || 'Выделите слой или скажите, что именно поправить.',
        details: techDetails(res.warnings, null, res.serviceNotes),
        actions: [retryAction(utterance)],
      });
      return;
    }

    if (docChangedUnder(baseStamp)) { staleMsg(utterance); return; }
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

    /* Главная строка — что именно изменилось; слова агента уходят во вторую строку (п.2).
     * Круг 19: у операций, которые мозг собрал сам (res.local — компонент, переименование,
     * отсоединение), разбор по диффу читается как бухгалтерия: «Добавил «Ярлыки» в «Маршрут
     * дня»; перенёс «Ярлыки» и ещё 1 правка» вместо «Компонент из «Ярлыки»». Человек просил
     * одну вещь, и одной вещью она и должна называться — а перечень правок уходит второй
     * строкой, где он к месту. */
    const conceptual = res.local ? String((res.plan && res.plan.title) || '').trim() : '';
    const headline = conceptual || r.tx.human || summary;
    const aside = res.local
      ? [r.tx.human, summary && summary !== conceptual ? summary : ''].filter(Boolean).join(' · ')
      : (summary && summary !== headline ? summary : '');
    // в память разговора кладём факт, а не намерение: иначе «верни как было» не на что опереть (п.12)
    // круг 47 (SPEC §14.5): образ, палитра, шрифты и вердикт критика — под итогом
    const art = SHELL.artSummary(res.direction, res.critique, { blocked: !!issueLine(res.warnings) });
    rememberPair(utterance, headline);
    addChat('you', utterance);
    addChat('agent', headline, followups, aside);
    if (art) addChat('agent', art.line);
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
      art,
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
      const verdict = SHELL.stoppedRunVerdict({ settled: !!e.settled, replacing: replacingRun });
      if (verdict !== 'cancelled') replacingRun = false;
      // «успел записать» уже на экране (круг 27, п.2) или команду заменили — молчим
      if (verdict !== 'cancelled') return;
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

/**
 * Переспрос агента: вопрос попадает и в память разговора, и в ожидание ответа (п.10).
 *
 * Круг 18, п.1. Раньше переспрос возвращал команду в строку и говорил «допишите» —
 * то есть заставлял формулировать заново ту же мысль. Теперь brain присылает вместе с
 * вопросом до трёх ГОТОВЫХ команд (res.clarifyOptions): имена слоёв в них сверены с
 * документом на его стороне. Их и показываем кнопками, а четвёртой строкой — «свой
 * вариант», поле прямо в карточке: печатать надо там, где спросили, а не искать
 * глазами командную строку.
 *
 * Что стало с прежней склейкой. Готовый вариант — законченная команда, склеивать её
 * с прежней репликой нельзя: «убери последнее» + «отмени последнюю правку» — это уже
 * не команда. Поэтому нажатие варианта выполняет его КАК ЕСТЬ и гасит awaitingClarify.
 * Для своего ответа склейка, наоборот, остаётся: человек отвечает на вопрос («шапку»),
 * а не формулирует команду, и без прежней реплики такой ответ бессмыслен. Живёт она
 * теперь в state.awaitingClarify.base, а не в тексте командной строки, — поэтому
 * restoreCommand отсюда убран: возвращать текст, который человеку больше не нужно
 * править, значит опять звать его вниз, в строку.
 */
function showClarify(res, utterance) {
  const q = typeof res.clarify === 'string'
    ? res.clarify
    : (res.clarify.question || res.clarify.message || 'Уточните, что нужно сделать.');
  // контракт: res.clarifyOptions; старую форму res.clarify.options тоже принимаем
  const raw = Array.isArray(res.clarifyOptions)
    ? res.clarifyOptions
    : ((res.clarify && Array.isArray(res.clarify.options)) ? res.clarify.options : []);
  const options = raw.map((o) => String(o || '').trim()).filter(Boolean).slice(0, 3);
  addChat('you', utterance);
  addChat('agent', q);
  // пара «вопрос агента → ответ человека» нужна модели: иначе ответ «сводку» ей не к чему привязать
  rememberPair(utterance, `переспросил: ${q}`);
  state.awaitingClarify = { question: q, base: utterance };
  renderHints();
  // поля с готовыми ответами нет — ведём себя как раньше: текст обратно в строку
  if (!options.length) restoreCommand(utterance, { focus: true });
  showMsg('question', q, {
    role: 'clarify',
    note: options.length
      ? 'Выберите готовый ответ или напишите свой — команду заново набирать не нужно.'
      : 'Допишите команду в строке внизу или скажите ответ голосом — я добавлю его к команде.',
    ask: options,
  });
}

/**
 * Ответы на переспрос внутри карточки (круг 18, п.1). Четвёртая строка — «свой
 * вариант»: по нажатию она разворачивается в поле и сразу получает фокус, так что
 * печатать человек начинает там же, куда смотрит.
 */
function renderAskOptions(host, options) {
  host.textContent = '';
  const list = (options || []).slice(0, 3);
  host.hidden = !list.length;
  if (!list.length) return;
  for (const text of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ask-option';
    b.textContent = human(text);
    b.title = 'Выполнить эту команду';
    // команда готовая: выполняем как есть, без склейки с прежней репликой
    b.addEventListener('click', () => answerClarify(text, { glue: false }));
    host.appendChild(b);
  }

  const own = document.createElement('button');
  own.type = 'button';
  own.className = 'ask-option ask-own';
  own.textContent = 'Свой вариант…';
  own.addEventListener('click', () => {
    const form = document.createElement('form');
    form.className = 'ask-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ask-input';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Свой ответ на вопрос агента');
    input.placeholder = 'Напишите ответ…';
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'btn accent small';
    go.textContent = 'Ответить';
    form.append(input, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const said = input.value.trim();
      // свой ответ — это ответ на вопрос, а не команда: его склеиваем с прежней репликой
      if (said) answerClarify(said, { glue: true });
    });
    own.replaceWith(form);
    input.focus();
  });
  host.appendChild(own);
}

/** Ответ на переспрос: закрыть вопрос и выполнить то, что получилось. */
function answerClarify(text, { glue = false } = {}) {
  const said = String(text || '').trim();
  if (!said) return;
  const base = glue && state.awaitingClarify ? String(state.awaitingClarify.base || '').trim() : '';
  const full = base && !said.toLowerCase().includes(base.toLowerCase()) ? `${base} ${said}` : said;
  state.awaitingClarify = null;
  hideMsg();
  dom.command.value = '';
  runUtterance(full);
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
  // вариант сервера записывается не сразу: дорабатываем, когда он лёг
  if (rest && ok && typeof ok.then === 'function') {
    toast(`Взял «${pick.label}» — дорабатываю: ${clip(rest, 50)}`, 'plain', 5000);
    ok.then((done) => { if (done) setTimeout(() => runUtterance(rest), 90); });
    return true;
  }
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
  // круг 47: тема документа не перекрасит экраны в собственной палитре — это человек должен прочесть
  /собран\S* в собственной палитре/i,
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
    // круг 29, п.7: «код: llm_failed» человеку не говорит ничего — причина словами
    if (err.code) bits.push(`причина: ${SHELL.errorCodeWords(err.code)}`);
    // «вид: agent» — имя класса ошибки, а не сведение о ней (круг 27, п.7)
    if (err.kind && err.kind !== err.code && err.kind !== 'agent') bits.push(`вид: ${err.kind}`);
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
  // круг 27, п.7: status 0 — кода ответа нет (ошибка пришла в потоке или связи не было):
  // «HTTP 0» ничего не говорит и читается как поломка
  if (Number.isFinite(err.status) && err.status > 0) add('ответ сервера', `HTTP ${err.status}`);
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
/**
 * Устарела ли база, по которой считал агент. В прежнем режиме — да, если документ
 * изменился: операции легли бы не туда. В серверном режиме (круг 22, SPEC §8.3 «Слияние не
 * отказывает») транзакция всё равно перекладывается поверх чужих и своих правок теми же
 * правилами, что на сервере, а что не легло — сказано словами (dropped). Отказ «документ
 * изменился» там не нужен: с двумя людьми в проекте он срабатывал бы на каждой второй команде.
 */
function docChangedUnder(baseStamp) {
  if (server) return false;
  return docStamp(state.doc) !== baseStamp;
}

function staleMsg(utterance) {
  showMsg('error', 'Документ изменился, пока агент работал', {
    note: 'Правки считались по прежнему макету, поэтому я их не применил.',
    actions: [{ label: 'Пересчитать по новому макету', primary: true, onClick: () => runUtterance(utterance) }],
  });
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
  run.disabled = state.busy ? false : !commandReady();
  /* Двух «Стоп» на экране быть не должно: кнопка в блоке хода работы нужна ровно
     тогда, когда главная занята отправкой набранного (п.6). Круг 18, п.2: блок
     переехал наверх справа, но правило то же — и в голосовой сессии, где командной
     строки не видно вовсе, «Стоп» остаётся единственным и потому виден всегда
     (круг 18, п.4). */
  const workStop = dom['btn-work-stop'];
  if (workStop) workStop.hidden = !state.busy || (stopping && dom.app.dataset.voice !== 'on');
}

/* Круг 31: когда агент закончил. «Стоп», нажатый на долю секунды позже конца работы, попадает
   в ту же кнопку — уже «Выполнить» при пустой строке — и затирал карточку результата
   «Строка внизу пуста». Такой клик — не команда. */
let lastRunEndAt = 0;
const LATE_STOP_MS = 900;

function setBusy(on) {
  if (!on && state.busy) lastRunEndAt = Date.now();
  state.busy = on;
  // круг 25, п.8: занятость агента — и в присутствии (в браузере и на сервере одинаково)
  setAgentPresence(on ? { busy: true } : null);
  dom.app.dataset.busy = on ? 'on' : 'off';
  updateAgentDot();
  if (!on) runHoldFired = false;
  paintRunButton();
  dom['btn-variants'].disabled = on || !commandReady();
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
  prompt_too_large: 'Выделите слой поменьше или скажите короче.',
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

/* Служебное в тексте ошибки: такую строку человеку не показываем (круг 25, п.7). */
const NOISE_RE = /failed to fetch|networkerror|load failed|https?:\/\/|\b[1-5]\d\d\b|\bjson\b|econn|etimedout|enotfound|\b(?:tx|cmd|c|f|t|lib)_[a-z0-9]{6,}\b/i;

/** После двоеточия — со строчной: «Имя не сохранилось: нет связи с сервером» (круг 33, п.7). */
function afterColon(text) {
  const t = String(text == null ? '' : text);
  if (/^[A-ZА-ЯЁ]{2}/.test(t)) return t;   // аббревиатура (JSON, SVG) — как есть
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function humanError(e) {
  if (!e) return 'Что-то пошло не так';
  if (typeof e === 'string') return e;
  const code = typeof e.code === 'string' ? e.code : '';
  const kind = typeof e.kind === 'string' ? e.kind : '';
  if (kind === 'cancelled' || code === 'cancelled' || e.name === 'AbortError') return 'Команда остановлена';
  // J5 (круг 29): «ни одна правка не легла» — не сбой модели; те же слова, что у сервера
  if (code === 'not_applied') {
    const w = agentErrorWords(e);
    return w.note ? `${w.title} · ${w.note}` : w.title;
  }
  // круг 31 (K2): «хранилище недоступно» — это база данных сервера, так и говорим везде одинаково
  if (storageDownError(e)) return 'база данных сервера недоступна';

  // собственное сообщение ошибки точнее любого общего: оно и есть первая строка —
  // если в нём нет служебного: «Failed to fetch», адреса, коды HTTP человеку не говорят
  // ничего (круг 25, п.7); такое уходит в «Подробности», а здесь — свои слова
  const raw = String(e.message || '').trim();
  const noisy = NOISE_RE.test(raw);
  const own = noisy
    ? (/fetch|network|load failed|econn|enotfound|etimedout/i.test(raw) || e instanceof TypeError
      ? (server ? 'Нет связи с сервером' : 'Нет связи с моделью')
      : Number.isFinite(e.status) && e.status >= 500 ? 'Сервер сейчас не отвечает как надо' : '')
    : raw;
  let hint = '';
  // круг 25: в серверном режиме ошибки чаще про сервер, а не про модель — этот совет там не к месту
  if (!agentReady() && !server) {
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

/**
 * Круг 18, п.2. Ход работы показывается наверху справа, а не зелёным блоком в доке.
 * Причина простая: док — место, где человек печатает и читает итог правки, а стадии
 * туда добавляли третий этаж и выдавливали макет вверх на каждую команду. Наверху
 * справа список никому не мешает и, главное, сам исчезает, когда работа кончилась.
 * Внизу остаётся ровно то, что должно жить до решения человека, — карточка итога
 * с «Отменить».
 */
let workFadeTimer = null;

function showStage(rec, variantsTotal = 0) {
  clearTimeout(workFadeTimer);
  dom.worklog.hidden = false;
  dom.worklog.dataset.done = '';
  dom.app.dataset.work = 'on';   // по нему тосты уступают место списку (круг 18, п.2)
  dom['work-label'].textContent = human(state.stageGoal || 'Агент работает');
  const parts = [];
  if (variantsTotal && state.variantSeen.length) {
    parts.push(`вариант ${Math.min(state.variantSeen.length, variantsTotal)} из ${variantsTotal}`);
  }
  const goal = state.stageGoal || '';
  // круг 27, п.7: без адресов и английского «Failed to fetch»; подпись, повторяющая
  // подробность («Повторяю запрос: X — X»), не удваивается
  let label = SHELL.stageText(cleanStage(rec && rec.label));
  let detail = SHELL.stageText(cleanStage(rec && rec.detail));
  if (detail && label && label.includes(detail)) detail = '';
  else if (detail && label && detail.includes(label)) label = '';
  const step = [label, detail]
    .filter(Boolean)
    .filter((s, i, all) => all.indexOf(s) === i && (!goal || !String(s).includes(goal)))
    .join(' — ');
  if (step) parts.push(step);
  dom['work-detail'].textContent = parts.join(' · ');
  renderStageSteps(rec);
}

/**
 * Шаги плана: человек видит, что агент собирается сделать, пока он это делает (п.17).
 * Круг 18: пройденные шаги гаснут — список читается сверху вниз и видно, где агент.
 */
function renderStageSteps(rec) {
  const host = dom['work-steps'];
  if (!host) return;
  const list = (state.stageSteps || []).slice(0, 5);
  const sig = list.join('|');
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.textContent = '';
    for (const st of list) {
      const li = document.createElement('li');
      li.textContent = human(st);
      li.title = st;
      host.appendChild(li);
    }
    host.hidden = !list.length;
  }
  markStepsDone(rec);
}

/* Стадии brain идут по порядку; на «generate» план уже разобран, на «verify» — сделан.
   Точного соответствия «стадия → шаг» в контракте нет, поэтому не выдумываем его:
   гасим ровно столько шагов, сколько стадий работы позади. */
const STAGE_PROGRESS = { plan: 0, generate: 1, materialize: 2, solve: 3, verify: 4, repair: 4, done: 5 };

function markStepsDone(rec) {
  const host = dom['work-steps'];
  if (!host || host.hidden) return;
  const stage = rec && typeof rec.stage === 'string' ? rec.stage : '';
  const done = STAGE_PROGRESS[stage];
  if (done === undefined) return;
  const rows = host.children;
  for (let i = 0; i < rows.length; i++) rows[i].dataset.done = i < done ? 'on' : '';
}

function hideStage() {
  dom.app.dataset.work = '';
  const host = dom['work-steps'];
  if (dom.worklog.hidden) return;
  /* Исчезает сам: блок гаснет за 0.5 с и только потом прячется. Мгновенное
     исчезновение читалось сбоем — «было и пропало», без ответа, чем кончилось. */
  dom.worklog.dataset.done = 'on';
  clearTimeout(workFadeTimer);
  workFadeTimer = setTimeout(() => {
    dom.worklog.hidden = true;
    dom.worklog.dataset.done = '';
    if (host) { host.hidden = true; host.dataset.sig = ''; host.textContent = ''; }
  }, 500);
}

const MSG_ICON = {
  result: 'check', error: 'alert', answer: 'spark', question: 'ask', plain: 'spark', warn: 'alert',
};
let msgUndoTx = null;
/* Сообщение, которое живёт ровно до следующего шага истории: предложение отменить и
   отклик отмены/возврата. */
let msgTransient = false;
let msgTimer = null;
/* Круг 25, п.7: кнопки с обратным отсчётом (предохранитель модели) — их таймеры живут,
   пока живёт сообщение. */
let msgActTimers = [];
function clearMsgActTimers() {
  for (const t of msgActTimers) clearInterval(t);
  msgActTimers = [];
}

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
  clearMsgActTimers();
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

  /* Круг 47 (SPEC §14.5): решение арт-директора — образ, образцы палитры, пара шрифтов — и
     оценка критика. Человек видит, ЧТО агент придумал, и может сослаться: «теплее», «другой шрифт». */
  const oldArt = bodyBox.querySelector('.msg-art');
  if (oldArt) oldArt.remove();
  if (opts.art) {
    const box = document.createElement('div');
    box.className = 'msg-art';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Оформление, которое выбрал агент');
    const head = document.createElement('div');
    head.className = 'msg-art-head';
    if (opts.art.swatches.length) {
      const row = document.createElement('span');
      row.className = 'msg-art-swatches';
      for (const sw of opts.art.swatches) {
        // образец — кнопка: цвет в строку команды («сделай акцент …» договорит человек)
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'msg-art-swatch';
        dot.style.background = sw.hex;
        dot.title = `${sw.label} ${sw.hex}`;
        dot.setAttribute('aria-label', `${sw.label} ${sw.hex} — вставить в строку команды`);
        dot.addEventListener('click', () => {
          const cur = dom.command.value.trim();
          dom.command.value = cur ? `${cur} ${sw.hex}` : `${sw.label} ${sw.hex} — `;
          dom.command.focus();
        });
        row.appendChild(dot);
      }
      head.appendChild(row);
    }
    for (const fam of opts.art.families || []) {
      // название гарнитуры — ею же: так выбор виден, а не только назван
      const f = document.createElement('span');
      f.className = 'msg-art-font';
      f.style.fontFamily = `"${fam.replace(/["\\]/g, '')}", var(--ui)`;
      f.textContent = `Аа ${fam}`;
      head.appendChild(f);
    }
    if (head.childNodes.length) box.appendChild(head);
    if (opts.art.concept) {
      const words = document.createElement('div');
      words.className = 'msg-art-words';
      const full = document.createElement('span');
      full.className = 'msg-art-full';
      full.textContent = human(opts.art.concept);
      words.appendChild(full);
      if (opts.art.conceptShort && opts.art.conceptShort !== opts.art.concept) {
        const short = document.createElement('span');
        short.className = 'msg-art-short';
        short.textContent = human(opts.art.conceptShort);
        short.setAttribute('aria-hidden', 'true');
        words.appendChild(short);
        words.classList.add('has-short');   // без :has (Firefox до 121) вёрстка та же
        // узкий экран: нажатие раскрывает образ целиком (материалы), повторное — сворачивает; на
        // широком образ виден целиком — там это обычный текст, без лишней остановки Tab
        const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 480px)') : null;
        const toggle = () => {
          if (!narrow || !narrow.matches) return;
          const open = words.dataset.open !== 'on';
          words.dataset.open = open ? 'on' : '';
          words.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        const asButton = () => {
          if (narrow && narrow.matches) {
            words.tabIndex = 0;
            words.setAttribute('role', 'button');
            words.setAttribute('aria-expanded', words.dataset.open === 'on' ? 'true' : 'false');
            words.setAttribute('aria-label', `Образ: ${human(opts.art.concept)}`);
          } else {
            words.removeAttribute('tabindex');
            for (const a of ['role', 'aria-expanded', 'aria-label']) words.removeAttribute(a);
          }
        };
        asButton();
        // слушатель живёт, пока карточка на странице: следующий итог заменит блок целиком
        if (narrow && typeof narrow.addEventListener === 'function') {
          const onChange = () => { if (!words.isConnected) { narrow.removeEventListener('change', onChange); return; } asButton(); };
          narrow.addEventListener('change', onChange);
        }
        words.addEventListener('click', toggle);
        words.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && narrow && narrow.matches) { e.preventDefault(); toggle(); } });
      }
      box.appendChild(words);
    }
    if (opts.art.verdict) {
      const v = document.createElement('div');
      v.className = 'msg-art-verdict';
      v.textContent = human(opts.art.verdict);
      box.appendChild(v);
    }
    bodyBox.insertBefore(box, dom['dockmsg-chips']);
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

  // готовые ответы на переспрос — выше чипов: это главное действие карточки (круг 18, п.1)
  renderAskOptions(dom['dockmsg-ask'], opts.ask);

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
    /* Повтор раньше срока заведомо получит тот же отказ: кнопка выключена и считает
       секунды до срока, потом включается сама (п.7). */
    if (Number.isFinite(a.waitMs) && a.waitMs > 0) {
      const until = Date.now() + a.waitMs;
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
          b.disabled = false;
          b.textContent = a.label;
          b.removeAttribute('aria-disabled');
          return true;
        }
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
        b.textContent = `${a.label} через ${left} с`;
        return false;
      };
      if (!tick()) {
        const t = setInterval(() => { if (tick()) { clearInterval(t); if (typeof a.onReady === 'function') a.onReady(); } }, 250);
        msgActTimers.push(t);
      }
    }
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
  clearMsgActTimers();
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
/**
 * Круг 39 (UX): новая своя правка — карточка «Отменено — … / Вернуть» (или «Вернул — … /
 * Отменить») устарела: «Вернуть» после новой правки ничего не вернёт. Карточки с отменой
 * конкретной транзакции (итог агента, правка командой) живут дальше — их «Отменить» честное.
 */
function dropStaleStepCard() { if (msgTransient && !msgUndoTx) hideMsg(); }

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
      // круг 47: у варианта может быть своё арт-направление — его гарнитуры тоже на страницу
      docFontsDoc = null;
      ensureDocFonts(v.preview.doc);
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
  // круг 23: вариант посчитал сервер — выбор уходит в /agent/apply, транзакция придёт по сокету
  if (v && v.server) return acceptServerVariant(v, utterance);
  if (state.variantsBase != null && docChangedUnder(state.variantsBase)) {
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

/**
 * Вариант сервера: Orchestrator записывает его транзакцией и отвечает итогом (§10.2).
 * Локально ничего не применяем — транзакция приходит по сокету, как любая другая.
 * Возвращает обещание: «возьми второй, но заголовок крупнее» дорабатывает после записи.
 */
function acceptServerVariant(v, utterance) {
  hideVariants();
  if (dom.command.value.trim() === String(utterance || '').trim()) dom.command.value = '';
  addChat('you', utterance);
  showStage({ stage: 'srv:write', label: 'Записываю вариант' });
  return agentClient.apply(v.server.command_id, v.server.key).then((result) => {
    hideStage();
    presentServerResult(result, utterance, { variant: v });
    return true;
  }).catch((e) => {
    hideStage();
    const words = agentErrorWords(e);
    showMsg('error', `Вариант не записан: ${words.title}`, {
      note: words.note || 'Посчитайте варианты заново.',
      details: techDetails(null, e),
      actions: [{ label: 'Посчитать заново', primary: true, onClick: () => runUtterance(utterance, { variants: true }) }],
    });
    return false;
  });
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
  ensureDocFonts(pv.doc);
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
  // вариант сервера без операций: подпись — его собственное описание (§10.3)
  if (v && v.server && !(v.ops && v.ops.length)) {
    const n = Number(v.opsCount) || 0;
    return v.description || (n ? `${n} ${plural(n, 'правка', 'правки', 'правок')}` : 'без изменений');
  }
  const list = v.ops || [];
  const created = list.filter((o) => o.op === 'create').length;
  const removed = list.filter((o) => o.op === 'remove').length;
  const changed = new Set(list.filter((o) => o.op === 'set' || o.op === 'move').map((o) => o.id)).size;

  /* Круг 20: зазор, отступ и скругление в операциях варианта — ссылки на шаги шкалы, а не
     числа; пиксели из них даёт только ядро (resolveScale). Шкалу берём из документа
     варианта, если он есть: вариант вправе менять и её. */
  const vdoc = (v.preview && v.preview.doc) || state.doc;
  const pxOf = (val, doc) => {
    const one = val && typeof val === 'object' && !Array.isArray(val) ? val.t : val;
    const n = resolveScale(doc, one);
    return typeof n === 'number' ? n : null;
  };
  const nums = new Map();
  for (const o of list) {
    if (o.op !== 'set') continue;
    const value = pxOf(o.value, vdoc);
    if (value == null) continue;
    const key = String(o.path || '').split('.').pop();
    const label = NUM_LABELS[key];
    if (!label || nums.has(label)) continue;
    const beforeNum = pxOf(readPath(nodeById(state.doc, o.id), o.path), state.doc);
    nums.set(label, beforeNum != null && beforeNum !== value ? `${beforeNum} → ${value}` : String(value));
  }

  const bits = [...nums].slice(0, 2).map(([k, val]) => `${k} ${val}`);
  if (created) bits.push(`+${created} ${plural(created, 'слой', 'слоя', 'слоёв')}`);
  /* Круг 16, п.8: «1 узел правлено» — род не согласован. Ставим глагол впереди, тогда
     согласуются все три формы: «изменён 1 узел», «изменены 2 узла», «изменено 5 узлов». */
  if (changed) {
    bits.push(`${plural(changed, 'изменён', 'изменены', 'изменено')} ${changed} `
      + plural(changed, 'слой', 'слоя', 'слоёв'));
  }
  if (removed) bits.push(`−${removed} ${plural(removed, 'слой', 'слоя', 'слоёв')}`);
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
  // вариант сервера без превью и операций: различаем по ключу, иначе все слились бы в один
  if (v.server && !(v.ops && v.ops.length)) return 'k:' + String(v.server.key);
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

/* Таблица команд оболочки живёт в src/shell.js (`SHELL_COMMANDS`, круг 38, SPEC §13) — одна
   на всё: фразы, слэш-формы, палитра и справка «Команды». Здесь — только привязка к
   документу и активной доске этой вкладки и исполнение команд. */
const normSaid = SHELL.normSaid;
const numSaid = SHELL.numSaid;
const RE_VARIANTS_BARE = SHELL.RE_VARIANTS_BARE;

/** Узлы, чьё имя похоже на сказанное. Внутри активного артборда — дороже. */
function nodesByName(phrase, opts = {}) {
  return SHELL.nodesByName(state.doc, phrase, { activeId: activeArtboardId(), ...opts });
}

/** Один узел по имени — для предмета просьбы о вариантах (п.2). */
function findNodeByName(phrase) {
  const hits = nodesByName(phrase);
  return hits.length ? hits[0].node : null;
}

/**
 * Намерение, которое выполняет сама оболочка. null — значит это команда агенту.
 * Правила узкие нарочно: «покажи сводку недели» — переключение (артборд с таким именем
 * есть), «добавь сводку недели» — работа для модели.
 */
function shellIntent(said) {
  return SHELL.shellIntent(said, { doc: state.doc, activeArtboardId: activeArtboardId() });
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
    showMsg('plain', `Активная доска: «${nodeTitle(node)}»`, {
      note: 'Команды без выделения агент выполняет здесь.', ms: 5000,
    });
  }
  return true;
}

/**
 * Выполнить намерение оболочки. false — не смогли, и тогда реплика уйдёт агенту.
 */
/**
 * Круг 41 (UX): справочное сообщение дока («Активная доска: …», «Сначала выделите слой») к
 * следующей команде устарело — не держим его под новым действием. Карточки с отменой, вопросы
 * и ошибки с ролью живут, сколько им положено.
 */
function dropStaleInfoCard() {
  const h = dom.dockmsg;
  if (!h || h.hidden || msgUndoTx || msgTransient || h.dataset.role) return;
  if (h.dataset.kind === 'plain' || h.dataset.kind === 'answer') hideMsg();
}

function applyShellIntent(intent, said) {
  if (!intent) return false;
  dropStaleInfoCard();
  switch (intent.kind) {
    case 'stop': {
      if (state.running) stopAgent();
      else showMsg('plain', 'Агент сейчас ничего не делает.', { ms: 5000 });
      return true;
    }
    case 'preview': {
      setPreview(intent.on !== false, { say: true });
      return true;
    }
    // круг 50 (SPEC §17.2): настройки агента; без «вкл/выкл» — сказать, как сейчас
    case 'agent-setting': {
      if (intent.on == null) {
        const on = settings[AGENT_SETTING[intent.what].key] !== false;
        const w = AGENT_SETTING[intent.what];
        showMsg('plain', `${w.title} ${on ? w.onWord : w.offWord}.`, { note: `${on ? 'Выключить' : 'Включить'}: ${w.slash} ${on ? 'выкл' : 'вкл'}`, ms: 7000 });
        return true;
      }
      setAgentSetting(intent.what, intent.on, { say: true });
      return true;
    }
    // круг 46: проекты — на сервере и без него (группа «Файл»)
    case 'projects':
    case 'project-new':
    case 'project-open':
    case 'project-rename':
    case 'project-duplicate': {
      if (!server && !solo) { showMsg('plain', 'Проекты ещё открываются — повторите через секунду.', { ms: 5000 }); return true; }
      applyProjectCommand(intent);
      return true;
    }
    case 'new-board': {
      const r = addArtboard();
      if (r && r.ok) showMsg('result', 'Новая доска готова', { note: 'Скажите, что на ней построить.', ms: 7000 });
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
      toast(state.fitAll ? 'Вписаны все доски' : 'Вписана активная доска', 'plain', 3500);
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
      else if (intent.what === 'scales') openScales();
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
      if (!abs.length) { showMsg('plain', 'В документе нет досок.', { ms: 5000 }); return true; }
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
    default: return applyTableCommand(intent, said);
  }
}

/* ------------- круг 38 (SPEC §13): новые команды таблицы оболочки ------------- */

/** Выделенные слои, которые ещё есть в документе. */
function liveSelection() {
  return state.selection.filter((id) => nodeById(state.doc, id));
}

/** Команде нужен выделенный слой, а его нет: честная подсказка — агенту такое не уходит. */
function needSelectionMsg(intent) {
  const c = SHELL.shellCommand(SHELL.commandIdOf(intent));
  showMsg('plain', 'Сначала выделите слой', {
    note: c ? `«${c.title}» работает с выделенным: щёлкните слой на холсте или в списке слоёв.` : 'Щёлкните слой на холсте или в списке слоёв.',
    ms: 7000,
  });
  return true;
}

/**
 * Правка командой таблицы — обычная транзакция тем же путём, что ручная (commit), с
 * подписью словами (J6) и «Отменить» одним шагом.
 * @param {{ops?: object[], error?: string, words?: string, ids?: string[], id?: string}} r
 * @param {{kind: string}} intent намерение — по нему из таблицы берётся имя действия
 */
function commitTableEdit(r, intent, { select = null, extra = null } = {}) {
  // имя действия — из таблицы: своего списка названий у оболочки нет
  const c = SHELL.shellCommand(SHELL.commandIdOf(intent));
  const label = c ? c.title : 'Правка';
  if (!r || r.error || !r.ops || !r.ops.length) {
    showMsg('plain', (r && r.error) || 'Править нечего', { ms: 6000 });
    return true;
  }
  // круг 39 (UX): отмена возвращает выделение, с которым команду дали (копию сняли — снова оригинал)
  const res = commit(r.ops, label, 'human', {
    human: r.words, quiet: true, selBefore: liveSelection(), ...(select && select.length ? { selAfter: select.slice() } : {}),
    ...(extra || {}),
  });
  if (!res || !res.ok) return true;
  if (select && select.length) setSelection(select.filter((id) => nodeById(state.doc, id)));
  const said = (res.tx && res.tx.human) || r.words || label;
  showMsg('plain', said, {
    note: backHint(),
    ms: 7000,
    transient: true,
    ...(res.tx ? { actions: [{ label: 'Отменить', onClick: () => undoTx(res.tx.id) }], undoTx: res.tx.id } : {}),
  });
  return true;
}

/** Выполнить команду таблицы, которой нет среди прежних видов намерений. */
function applyTableCommand(intent, said) {
  const doc = state.doc;
  const sel = liveSelection();
  if (SHELL.needsSelection(intent) && !sel.length) return needSelectionMsg(intent);
  const rects = (state.geo && state.geo.rects) || {};
  switch (intent.kind) {
    case 'palette': openPalette(); return true;
    case 'help': openCommandsHelp(); return true;
    case 'slash-unknown': {
      showMsg('plain', `Команды «/${intent.name}» нет`, {
        note: `Все команды — в палитре (${keyText('Mod+K') ? `${keyText('Mod+K')} или «/»` : '«/» в строке команд'}) и в справке «Команды».`,
        actions: [{ label: 'Все команды', onClick: () => { hideMsg(); openCommandsHelp(); } }],
        ms: 8000,
      });
      return true;
    }
    case 'slash-bad': {
      showMsg('plain', intent.say || 'Команда набрана не так', { note: intent.usage || '', ms: 8000 });
      return true;
    }
    case 'fit-selection': {
      state.fitAll = false;
      state.userView = true;
      fitView(sel);
      updateFitButton();
      toast('Вписано выделенное', 'plain', 3000);
      return true;
    }
    case 'select-all': {
      const ids = SHELL.selectAllIds(doc, activeArtboardId());
      setSelection(ids);
      toast(ids.length ? `Выделено ${ids.length} ${plural(ids.length, 'слой', 'слоя', 'слоёв')}` : 'Выделять нечего', 'plain', 3500);
      return true;
    }
    case 'select-rel': {
      const r = SHELL.relatedIds(doc, sel, intent.rel);
      if (r.error) { showMsg('plain', r.error, { ms: 5000 }); return true; }
      setSelection(r.ids);
      const many = r.ids.length > 1 ? ` и ещё ${r.ids.length - 1}` : '';
      toast(`Выделено «${nodeTitleById(doc, r.ids[0])}»${many}`, 'plain', 3500);
      return true;
    }
    case 'select-name':
    case 'artboard-name':
      return false;
    case 'delete': deleteNodes(sel); return true;
    case 'duplicate': {
      const r = SHELL.duplicateOps(doc, sel);
      return commitTableEdit(r, intent, { select: r.ids });
    }
    case 'rename': return commitTableEdit(SHELL.renameOps(doc, sel, intent.name), intent);
    case 'visible': return commitTableEdit(SHELL.visibleOps(doc, sel, intent.on), intent);
    case 'lock': return commitTableEdit(SHELL.lockOps(doc, sel, intent.on), intent);
    case 'order': return commitTableEdit(SHELL.reorderOps(doc, sel, intent.to), intent);
    case 'wrap': {
      const r = SHELL.wrapOps(doc, sel, { rects });
      /* дети перечислены в самом create (SHELL.wrapOps): если соавтор успел удалить их все,
         слияние отбросит и рамку (core.rebase, круг 39) — пустой «Группы» не будет нигде,
         второй транзакцией убирать нечего; часть удалил — подпись поправит settleWrapWords */
      const kids = r.ops ? ((r.ops.find((o) => o.op === 'create') || {}).node || {}).children : null;
      return commitTableEdit(r, intent, { select: r.id ? [r.id] : null, extra: r.id ? { wrapOf: r.id, wrapKids: Array.isArray(kids) ? kids.slice() : [] } : null });
    }
    case 'ungroup': {
      const r = SHELL.ungroupOps(doc, sel, { rects });
      return commitTableEdit(r, intent, { select: r.ids });
    }
    case 'align': return commitTableEdit(SHELL.alignOps(doc, sel, intent.how), intent);
    case 'direction': return commitTableEdit(SHELL.directionOps(doc, sel, intent.mode), intent);
    case 'gap': return commitTableEdit(SHELL.gapStepOps(doc, sel, intent.step), intent);
    case 'inspector': {
      if (intent.on) {
        if (sel.length !== 1) return needSelectionMsg(intent);
        state.inspQuiet = false;
      } else state.inspQuiet = true;
      renderInspector();
      return true;
    }
    case 'import': importJson(); return true;
    case 'variants': {
      // варианты считает агент: команда таблицы только запускает их к последней команде
      if (said) addChat('you', said);
      const src = lastHumanUtterance(said);
      if (src) chainAfterRun(src, { variants: true, note: `Считаю варианты к «${clip(src, 60)}»` });
      else askVariants({ variantsSubject: '' }, said);
      return true;
    }
    default: return false;
  }
}

/* ------------- круг 38 (SPEC §13): палитра команд и справка «Команды» ------------- */
/*
 * Палитра — список под рукой у строки команд: Ctrl/⌘+K или «/» в начале строки. Ищет по
 * названию, слэш-имени и фразам; строки и их порядок даёт таблица (SHELL.paletteRows) —
 * своего списка команд у оболочки нет. Строка команд при этом — поле поиска (combobox),
 * список — listbox с aria-activedescendant: всё доступно с клавиатуры.
 */
const palette = { rows: [], active: 0, draft: null };

function paletteOpen() { return !!(dom.palette && !dom.palette.hidden); }

/** Открыть палитру. Набранное в строке не теряется: вернётся, когда палитра закроется. */
function openPalette() {
  if (!dom.palette) return;
  if (dom.app.dataset.voice === 'on' && typeof toggleVoice === 'function') toggleVoice();
  if (!dom.sheet.hidden) closeSheet();   // палитра — у строки команд, шторка-диалог ей мешала бы
  const cur = dom.command.value;
  if (!/^\s*\//.test(cur)) {
    palette.draft = cur;
    dom.command.value = '/';
  } else if (palette.draft == null) palette.draft = '';
  palette.active = 0;
  dom.palette.hidden = false;
  dom.command.setAttribute('aria-expanded', 'true');
  dom.command.focus();
  const end = dom.command.value.length;
  try { dom.command.setSelectionRange(end, end); } catch { /* поле без выделения */ }
  renderPalette();
}

/**
 * Закрыть палитру. restore — вернуть в строку то, что было набрано до неё (Esc, щелчок мимо);
 * после исполнения команды строку чистит сама команда.
 */
function closePalette({ restore = true } = {}) {
  if (!dom.palette || dom.palette.hidden) return;
  dom.palette.hidden = true;
  dom.command.setAttribute('aria-expanded', 'false');
  dom.command.removeAttribute('aria-activedescendant');
  if (restore && /^\s*\//.test(dom.command.value)) dom.command.value = palette.draft || '';
  palette.draft = null;
}

function renderPalette() {
  const list = dom['palette-list'];
  if (!list) return;
  const q = dom.command.value;
  const rows = SHELL.paletteRows(q, { doc: state.doc, activeArtboardId: activeArtboardId() });
  palette.rows = rows;
  palette.active = Math.max(0, Math.min(rows.length - 1, palette.active));
  list.textContent = '';
  const grouped = !q.replace(/^\s*\/+/, '').trim();
  let lastGroup = '';
  rows.forEach((r, i) => {
    if (grouped && r.group !== lastGroup) {
      lastGroup = r.group;
      const h = document.createElement('li');
      h.className = 'pal-group';
      h.setAttribute('role', 'presentation');
      h.textContent = r.group;
      list.appendChild(h);
    }
    const li = document.createElement('li');
    li.className = 'pal-row';
    li.id = `pal-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === palette.active));
    li.dataset.cmd = r.id;
    const main = document.createElement('span');
    main.className = 'pal-main';
    const title = document.createElement('span');
    title.className = 'pal-title';
    title.textContent = r.title;
    const ex = document.createElement('span');
    ex.className = 'pal-ex';
    ex.textContent = r.example || '';
    main.append(title, ex);
    li.appendChild(main);
    if (keyText(r.keys)) {
      const k = document.createElement('kbd');
      k.className = 'pal-key';
      k.textContent = keyText(r.keys);
      li.appendChild(k);
    }
    if (r.hint) li.title = r.hint;
    li.addEventListener('pointerdown', (e) => e.preventDefault());   // фокус остаётся в строке
    li.addEventListener('click', () => { palette.active = i; runPaletteRow(r); });
    list.appendChild(li);
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'pal-empty';
    li.setAttribute('role', 'presentation');
    li.textContent = 'Такой команды нет. Enter — подсказка, «/помощь» — все команды. Просьбу к агенту наберите без «/».';
    list.appendChild(li);
  }
  if (rows.length) {
    dom.command.setAttribute('aria-activedescendant', `pal-opt-${palette.active}`);
    const cur = list.querySelector(`#pal-opt-${palette.active}`);
    if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
  } else dom.command.removeAttribute('aria-activedescendant');
}

function movePalette(d) {
  const n = palette.rows.length;
  if (!n) return;
  palette.active = (palette.active + d + n) % n;
  for (const li of dom['palette-list'].querySelectorAll('.pal-row')) {
    li.setAttribute('aria-selected', String(li.id === `pal-opt-${palette.active}`));
  }
  dom.command.setAttribute('aria-activedescendant', `pal-opt-${palette.active}`);
  const cur = dom['palette-list'].querySelector(`#pal-opt-${palette.active}`);
  if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
}

/** Исполнить строку палитры — тем же путём, что набранную команду (submitCommand). */
function runPaletteRow(r) {
  if (!r) return;
  if (r.fill) {
    // команде нужен аргумент: дописываем «/масштаб » и ждём число
    dom.command.value = r.fill;
    dom.command.focus();
    palette.active = 0;
    renderPalette();
    return;
  }
  runShellText(r.run);
}

/** Команда таблицы текстом «/…»: как будто её набрали и нажали Enter; набранное до палитры — вернуть. */
function runShellText(text) {
  const draft = palette.draft;
  closePalette({ restore: false });
  dom.command.value = text;
  submitCommand();
  if (draft && !dom.command.value.trim()) dom.command.value = draft;
}

/** Клавиши строки команд, пока открыта палитра. true — нажатие забрала палитра. */
function paletteKey(e) {
  if (!paletteOpen() || e.isComposing) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); return true; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return true; }
  if (e.key === 'Tab' && !e.shiftKey && palette.rows[palette.active]) {
    // Tab дописывает команду в строку, не исполняя
    e.preventDefault();
    const r = palette.rows[palette.active];
    dom.command.value = r.fill || r.run;
    palette.active = 0;
    renderPalette();
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const r = palette.rows[palette.active];
    if (r) runPaletteRow(r);
    else runShellText(dom.command.value.trim());   // «/взлетай» — честный ответ оболочки
    return true;
  }
  return false;
}

/** Справка «Команды» — из таблицы по группам: одна истина, без ручного списка. */
function openCommandsHelp() {
  closePalette();
  openSheet('Команды', fillCommandsHelp, { key: 'commands' });
}

function fillCommandsHelp(body) {
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Эти команды оболочка выполняет сама — без агента и без сети. Наберите «/» в строке команд'
    + `${keyText('Mod+K') ? ` или нажмите ${keyText('Mod+K')}` : ''}: откроется поиск. Всё, чего здесь нет, скажите словами — это работа агента.`;
  body.appendChild(note);
  for (const g of SHELL.helpGroups()) {
    const rows = g.commands.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cmd-help';
      b.dataset.cmd = c.id;
      const head = document.createElement('span');
      head.className = 'cmd-help-head';
      const title = document.createElement('span');
      title.className = 'cmd-help-title';
      title.textContent = c.title;
      head.appendChild(title);
      if (c.slash.length) {
        const sl = document.createElement('code');
        sl.className = 'cmd-help-slash';
        sl.textContent = c.example || SHELL.slashOf(c);
        head.appendChild(sl);
      }
      if (keyText(c.keys)) {
        const k = document.createElement('kbd');
        k.textContent = keyText(c.keys);
        head.appendChild(k);
      }
      b.appendChild(head);
      const what = [c.hint, c.phrases[0] ? `«${c.phrases[0]}»` : ''].filter(Boolean).join(' · ');
      if (what) {
        const ex = document.createElement('span');
        ex.className = 'cmd-help-ex';
        ex.textContent = what;
        b.appendChild(ex);
      }
      const a = c.args && c.args[0];
      b.title = c.id === 'palette' ? 'Открыть палитру' : (a && !a.optional ? `Набрать ${SHELL.slashOf(c)} …` : `Выполнить ${SHELL.slashOf(c)}`);
      b.addEventListener('click', () => {
        closeSheet();
        if (c.id === 'palette') { openPalette(); return; }
        if (a && !a.optional) {
          palette.draft = dom.command.value && !/^\s*\//.test(dom.command.value) ? dom.command.value : '';
          dom.command.value = `${SHELL.slashOf(c)} `;
          openPalette();
          return;
        }
        runShellText(SHELL.slashOf(c));
      });
      return b;
    });
    body.appendChild(group(g.group, rows));
  }
}

/* ---------------------------------- голос ------------------------------------ */

/**
 * Ошибки распознавания — по-русски: код «no-speech» или «not-allowed» человеку
 * не говорит ничего (п.13).
 */
/**
 * Круг 17: артефакт отдаёт страницу в рамке, у которой в `allow` микрофона нет вовсе
 * (`translator; language-detector; fullscreen; clipboard-write; gamepad`). Конструктор
 * `webkitSpeechRecognition` при этом на месте, поэтому кнопка включалась, распознавание
 * падало с кодом `not-allowed`, и человек читал «разрешите его для этой страницы» — совет,
 * который в артефакте выполнить НЕЛЬЗЯ ничем: разрешения у этой рамки нет и взяться ему
 * неоткуда. Спрашиваем саму страницу, позволена ли ей эта возможность, и говорим правду.
 * Неизвестный ответ считаем «позволено»: лучше попробовать и показать настоящую ошибку,
 * чем заранее отнять голос там, где он работает.
 */
function micBlockedByPage() {
  try {
    const pol = document.permissionsPolicy || document.featurePolicy;
    if (!pol || typeof pol.allowsFeature !== 'function') return false;
    return pol.allowsFeature('microphone') === false;
  } catch { return false; }
}

/** Что сказать про голос там, где его не может быть в принципе. */
const VOICE_NO_MIC = 'Микрофон в этой рамке заблокирован платформой — разрешить его нельзя. '
  + 'Голос работает в локальной сборке: запустите START.cmd.';

const VOICE_ERRORS = {
  'no-speech': 'Я ничего не услышал — скажите ещё раз.',
  'audio-capture': 'Микрофон не найден: проверьте, что он подключён и выбран в системе.',
  'not-allowed': 'Браузер не дал доступ к микрофону — разрешите его значком слева в адресной строке и нажмите ещё раз.',
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
  /* Круг 17: кнопку гасим не только когда распознавания нет в браузере, но и когда странице
     запрещён микрофон (артефакт). Кнопку НЕ делаем `disabled`: по нажатой кнопке человек
     получает объяснение, а мёртвая кнопка молчит и человек жмёт её снова и снова — именно
     так и вышло. Поэтому: вид «недоступна», подсказка в title, объяснение по нажатию. */
  const blocked = !SR || micBlockedByPage();
  if (blocked) {
    btn.dataset.state = 'off';
    btn.dataset.unavailable = 'on';
    /* aria-disabled тут был бы неправдой: кнопка ДЕЙСТВУЕТ — объясняет, почему голоса нет.
       С этим признаком её не нажать ни с клавиатуры вспомогательными средствами, ни
       автоматикой, и человек снова остался бы без ответа (круг 17). */
    btn.setAttribute('aria-label', 'Голос недоступен — почему');
    btn.title = SR
      ? VOICE_NO_MIC
      : 'Этот браузер не умеет распознавать речь. Голос работает в Chrome — в локальной сборке.';
    const say = () => showMsg('warn', 'Голос здесь недоступен', {
      note: btn.title,
      actions: [{ label: 'Набрать текстом', onClick: () => dom.command.focus() }],
    });
    btn.addEventListener('click', say);
    toggleVoice = say;
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

  /* Круг 18, п.4. Наговариваемое тихим шрифтом над микрофоном. Буфером по-прежнему
     служит dom.command (на нём держатся отправка, склейка с переспросом и разбор
     команд оболочки), но во время сессии строки не видно — текст человек читает
     здесь. */
  const paintSaid = () => {
    const box = dom['voice-said'];
    if (!box) return;
    const text = wanted ? String(dom.command.value || '').trim() : '';
    box.textContent = text;
  };

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
    /* Смысл микрофона — не видеть окна ввода: на время сессии командная строка,
       подсказки и чипы уходят целиком, а в правом нижнем углу остаётся значок
       включённого микрофона (круг 18, п.4). Макет при этом ничем не заслонён. */
    dom.app.dataset.voice = wanted ? 'on' : '';
    if (dom.voicebar) dom.voicebar.hidden = !wanted;
    paintSaid();
    renderHints();      // подсказки уходят вместе со строкой и возвращаются с ней
    paintRunButton();   // «Стоп» остаётся доступен: главной кнопки сейчас не видно
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
    paintSaid();
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
      paintSaid();   // то же самое, но тихим шрифтом над микрофоном (круг 18, п.4)
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

  /* Значок в правом нижнем углу — он же способ выйти обратно к печати: нажатие гасит
     микрофон и возвращает командную строку с фокусом (круг 18, п.4). */
  const off = dom['btn-voice-off'];
  if (off) {
    off.addEventListener('click', () => {
      if (!wanted) return;
      stop();
      dom.command.focus();
    });
  }
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
    // круг 38: пока открыта палитра, стрелки, Enter, Tab и Esc — её
    if (paletteKey(e)) return;
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    submitOnce();
  });
  // «/» в начале строки открывает палитру, стёртый «/» — закрывает
  dom.command.addEventListener('input', () => {
    const slash = /^\s*\//.test(dom.command.value);
    if (slash && !paletteOpen()) openPalette();
    else if (slash) { palette.active = 0; renderPalette(); }
    else if (paletteOpen()) closePalette({ restore: false });
  });
  if (dom['btn-palette-help']) {
    dom['btn-palette-help'].addEventListener('pointerdown', (e) => e.preventDefault());
    dom['btn-palette-help'].addEventListener('click', () => openCommandsHelp());
  }
  // щелчок мимо палитры и строки — закрыть, вернув набранное
  document.addEventListener('pointerdown', (e) => {
    if (!paletteOpen()) return;
    if (dom.palette.contains(e.target) || dom.commandbar.contains(e.target)) return;
    closePalette();
  }, true);
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
    // «Стоп» опоздал: агент закончил мгновение назад — карточку результата не трогаем
    if (!state.running && !dom.command.value.trim() && Date.now() - lastRunEndAt < LATE_STOP_MS) return;
    submitOnce();
  });
  dom['btn-work-stop'].addEventListener('click', () => stopAgent());
  // надпись на главной кнопке зависит от того, есть ли в строке текст
  dom.command.addEventListener('input', () => { if (state.busy) paintRunButton(); });
  dom['btn-variants'].addEventListener('click', () => submitCommand({ variants: true }));
  bindRunHold();
  dom['btn-msg-close'].addEventListener('click', hideMsg);
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

  // круг 36: «Просмотр» в панели масштаба и «Выйти» на плашке
  if (dom['btn-preview']) dom['btn-preview'].addEventListener('click', () => setPreview(!previewOn()));
  if (dom['btn-preview-exit']) dom['btn-preview-exit'].addEventListener('click', () => setPreview(false));
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
  // круг 33, п.1: панель удалённого слоя живёт, пока в ней фокус; ушёл — закрываем
  dom['insp-body'].addEventListener('focusout', () => {
    if (!dom['insp-body'].dataset.orphan) return;
    setTimeout(() => {
      if (!dom['insp-body'].dataset.orphan || inspFocused()) return;
      delete dom['insp-body'].dataset.orphan;
      dom['insp-body'].textContent = '';
      delete dom['insp-body'].dataset.node;
      renderInspector();
    }, 0);
  });
  dom['btn-sheet-close'].addEventListener('click', closeSheet);
  dom.sheet.addEventListener('keydown', trapSheetFocus);
  dom['btn-history'].addEventListener('click', () => openHistory());
  dom['btn-export'].addEventListener('click', openExport);
  // круг 20, п.4: редактор шкал — шторка о документе, рядом с историей и экспортом
  dom['btn-scales'].addEventListener('click', () => openScales());
  dom['btn-settings'].addEventListener('click', openSettings);
  // три состояния темы: тёмная, светлая и «как в системе» (п.13)
  dom['btn-theme'].addEventListener('click', () => cycleTheme());

  dom.docname.addEventListener('blur', () => {
    const name = dom.docname.textContent.trim() || 'Без названия';
    setDocNameText(name);
    // круг 22: в серверном режиме имя — у проекта (PATCH), meta.name операциями не правится
    if (server) { renameProject(name); return; }
    // круг 46: имя в шапке — имя проекта (список и шторка узнают его сразу)
    if (solo && solo.current) { if (name !== ((state.doc.meta || {}).name || '')) renameSoloProject(solo.current, name); return; }
    state.doc = { ...state.doc, meta: { ...state.doc.meta, name } };
    scheduleSave();
  });
  dom.docname.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dom.docname.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDocNameText(docTitle());
      dom.docname.blur();
    }
  });
  if (dom['btn-projects']) dom['btn-projects'].addEventListener('click', () => openProjects());
  // окно вернулось в сеть — не ждать паузы переподключения; сеть пропала — закрыть сокет
  // самим: иначе до таймаута TCP статус уверял бы «в сети»
  globalThis.addEventListener('online', () => {
    if (server && server.sync) server.sync.reconnect();
    onNetworkBack();
  });
  globalThis.addEventListener('offline', () => {
    if (server && server.sync) server.sync.offline();
    // круг 39: сети нет — и сервер агента недостижим; «агент: сервер» в шапке было бы неправдой
    if (server && !serverAgent.absent) markAgentDown();
  });
  // имя документа — строка, а не разметка: вставляем ровно текст (п.15)
  const plainInsert = (e, text) => {
    e.preventDefault();
    const t = cutText(cleanText(text), 120);
    if (!t) return;
    let done = false;
    try { done = document.execCommand('insertText', false, t); } catch { done = false; }
    if (!done) dom.docname.textContent = cutText(`${dom.docname.textContent}${t}`, 120);
    if (!done) resetDocNameScroll();
  };
  dom.docname.addEventListener('paste', (e) => plainInsert(e, e.clipboardData && e.clipboardData.getData('text/plain')));
  dom.docname.addEventListener('drop', (e) => plainInsert(e, e.dataTransfer && e.dataTransfer.getData('text/plain')));

  globalThis.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    // одиночная буква — только когда фокус не на органе управления: иначе «l» и «h»
    // срабатывали с любой кнопки, по которой человек только что щёлкнул (круг 9, п.15)
    const bare = !typing && bareKeyOk();
    // круг 38: «/» вне полей — палитра команд (строка команд с «/» в начале)
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openPalette(); return; }
    /* Круг 18, п.4. Во время голосовой сессии командной строки не видно, и Escape —
       самый короткий путь обратно к печати: он гасит микрофон, а строка возвращается
       вместе с фокусом. Стоит раньше прочих Escape нарочно: шторки в этот момент
       обычно закрыты, а «выйти из голоса» — то, чего человек хочет первым делом. */
    if (e.key === 'Escape' && dom.app.dataset.voice === 'on') {
      e.preventDefault();
      if (typeof toggleVoice === 'function') toggleVoice();
      dom.command.focus();
      return;
    }
    if (e.key === 'Escape' && !dom.sheet.hidden) { e.preventDefault(); closeSheet(); return; }
    /* Круг 36: из просмотра Esc выводит первым — это режим холста, а не всплывашка. Если
       сцена забрала Esc себе (снимала фокус с узла, defaultPrevented), выходит второй Esc. */
    if (e.key === 'Escape' && previewOn() && !typing && !e.defaultPrevented) { e.preventDefault(); setPreview(false); return; }
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
    // круг 38 (SPEC §13): Ctrl/⌘+K — палитра команд, повторно — закрыть
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (paletteOpen()) closePalette();
      else openPalette();
      return;
    }
    // ⌘G — обернуть выделенное в рамку, ⇧⌘G — разгруппировать (команды таблицы)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'g' && !typing && !e.defaultPrevented) {
      e.preventDefault();
      applyShellIntent({ kind: e.shiftKey ? 'ungroup' : 'wrap' }, '');
      return;
    }
    /* Ctrl+A и Ctrl+D — в onModKeyCapture (круг 39): одна команда таблицы откуда угодно. */
    // отмена работает из любого места оболочки; сцена ловит своё событие раньше (capture) и ставит defaultPrevented
    /* Круг 20, п.4. Числовое поле, в котором ничего не набрано сверх записанного (шаг шкалы
       после Enter, зазор в инспекторе), для Ctrl+Z — не «печать»: набора, который можно
       отменить, в нём нет, а правка документа есть. В остальных полях Ctrl+Z остаётся
       за браузером — отменой набора. */
    const numIdle = typing && e.target.type === 'number'
      && e.target.dataset.committed !== undefined && e.target.value === e.target.dataset.committed;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && (!typing || numIdle) && !e.defaultPrevented) {
      e.preventDefault();
      keyUndo(e.shiftKey);
    }
    if (e.key.toLowerCase() === 'h' && bare) { e.preventDefault(); openHistory(); }
    // круг 36 (SPEC §11.3): P — просмотр туда и обратно
    if (e.key.toLowerCase() === 'p' && bare && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setPreview(!previewOn());
    }
    if (e.key.toLowerCase() === 'l' && bare && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setRail(dom.app.dataset.rail === 'off' ? 'on' : 'off', true);
    }
  });
}

/**
 * Круг 39 (N3, N6в): Ctrl/⌘+A — «Выделить всё на доске» (как `/выделить всё`), Ctrl/⌘+D —
 * «Дублировать» (как `/дублировать`): одна запись таблицы, одна подпись, одна реализация.
 * Работает с холста, из списка слоёв и с любой кнопки; в полях ввода Ctrl+A — выделение
 * текста, как у браузера. Просмотр и открытая шторка — не место правкам: туда не вмешиваемся.
 */
function onModKeyCapture(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return;
  // круг 46: Mod+O — «Проекты» откуда угодно (браузер иначе открыл бы диалог файла)
  const lo = String(e.key).toLowerCase();
  if (e.code === 'KeyO' || lo === 'o' || lo === 'щ') {
    if (!server && !solo) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    applyProjectCommand({ kind: 'projects' });
    return;
  }
  const k = e.code === 'KeyA' || String(e.key).toLowerCase() === 'a' || String(e.key).toLowerCase() === 'ф' ? 'a'
    : e.code === 'KeyD' || String(e.key).toLowerCase() === 'd' || String(e.key).toLowerCase() === 'в' ? 'd' : '';
  if (!k) return;
  const t = e.target;
  const typing = !!(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable));
  if (typing) return;
  if (dom.sheet && !dom.sheet.hidden && dom.sheet.contains(t)) return;
  if (typeof previewOn === 'function' && previewOn()) return;
  if (!state.doc) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  applyShellIntent({ kind: k === 'a' ? 'select-all' : 'duplicate' }, '');
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

/* ---------------------- круг 36 (SPEC §11.3): режим «Просмотр» ---------------------- */

/** Выделение до просмотра: выйдя, человек возвращается к тому, что правил. */
let previewMemo = null;

function previewOn() { return !!(dom.app && dom.app.dataset.preview === 'on'); }

/** Есть ли в документе хоть одно состояние — иначе в просмотре нечему оживать. */
function docHasStates() {
  const nodes = (state.doc && state.doc.nodes) || {};
  for (const id in nodes) if (SHELL.hasStates(nodes[id])) return true;
  return false;
}

/**
 * Включить или выключить просмотр. В просмотре выделение и правка выключены (это делает
 * сцена — `stage.setPreview`), а наведение, нажатие и фокус проигрывают состояния.
 * @param {boolean} on
 * @param {{say?: boolean, restore?: boolean}} [o] say — ответить словами (команда голосом
 *   или строкой); restore — вернуть выделение, бывшее до просмотра (по умолчанию да)
 * @returns {boolean} режим переключился
 */
function setPreview(on, { say = false, restore = true } = {}) {
  const want = !!on;
  if (want === previewOn()) {
    if (say) showMsg('plain', want ? 'Просмотр уже включён — наведите на элементы.' : 'Просмотр и так выключен — можно править.', { ms: 5000 });
    return false;
  }
  if (want && (!stage || typeof stage.setPreview !== 'function')) {
    toast('Просмотр недоступен: холст этой версии его не умеет. Обновите страницу.', 'error', 7000);
    return false;
  }
  if (want) {
    unpeekVariant();
    stopPlayState();
    previewMemo = state.selection.slice();
    // выделение гаснет вместе с инспектором: в просмотре правки нет
    if (state.selection.length) setSelection([], { quiet: true });
  }
  dom.app.dataset.preview = want ? 'on' : 'off';
  try { if (stage && typeof stage.setPreview === 'function') stage.setPreview(want); }
  catch (e) { console.warn('[imago] setPreview', e); }
  const b = dom['btn-preview'];
  if (b) {
    b.setAttribute('aria-pressed', String(want));
    b.title = want ? 'Выйти из просмотра и вернуться к правке (P или Esc)' : 'Просмотр: наведение и нажатие оживают (P)';
  }
  if (dom.previewbar) dom.previewbar.hidden = !want;
  if (!want) {
    const back = restore ? (previewMemo || []).filter((id) => nodeById(state.doc, id)) : [];
    previewMemo = null;
    if (back.length) setSelection(back, { quiet: true });
  }
  if (want && !docHasStates()) {
    toast('В макете пока нет состояний: задайте их в инспекторе («Состояния») или скажите «оживи кнопки».', 'plain', 8000);
  } else if (say) {
    showMsg('plain', want ? 'Просмотр: наведите на элементы' : 'Просмотр выключен — можно править.', {
      note: want ? 'Выделение и правка выключены. Выйти — P, Esc или «выйди из просмотра».' : '', ms: 6000,
    });
  }
  renderHints();
  return true;
}

/* «Проиграть» в инспекторе: состояние выделенного узла показывается на холсте 1,5 с. */
const PLAY_STATE_MS = 1500;
let playTimer = null;
let playing = null;   // {id, key}

function playStateNow(id, key) {
  if (!stage || typeof stage.playState !== 'function') {
    toast('Проиграть не выйдет: холст этой версии не умеет состояния. Обновите страницу.', 'error', 7000);
    return;
  }
  stopPlayState();
  try { stage.playState(id, key); } catch (e) { console.warn('[imago] playState', e); return; }
  playing = { id, key };
  playTimer = setTimeout(() => stopPlayState(), PLAY_STATE_MS);
}

function stopPlayState() {
  clearTimeout(playTimer);
  playTimer = null;
  if (!playing) return;
  const was = playing;
  playing = null;
  try { if (stage && typeof stage.playState === 'function') stage.playState(was.id, null); }
  catch { /* сцена уже перерисована — проигрывать нечего */ }
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

/* -------------------------- круг 55: картинка в макет --------------------------- */

/** Файл-картинка из буфера или перетаскивания; не картинка — null. */
function imageFileOf(list) {
  for (const it of list ? Array.from(list) : []) {
    const f = typeof it.getAsFile === 'function' ? (it.kind === 'file' ? it.getAsFile() : null) : it;
    if (f && /^image\/(png|jpeg|gif|webp)$/i.test(f.type || '')) return f;
  }
  return null;
}

function editableTarget(t) {
  return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')));
}

function onImagePaste(e) {
  if (editableTarget(e.target)) return;   // в поле команды и в инспекторе вставка — их дело
  const file = imageFileOf(e.clipboardData && e.clipboardData.items);
  if (!file) return;
  e.preventDefault();
  insertImageFile(file, null);
}

function onImageDragOver(e) {
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
  if (types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
}

function onImageDrop(e) {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  // любой файл с холста — наш: иначе браузер откроет его вместо редактора
  e.preventDefault();
  const file = imageFileOf(files);
  if (!file) {
    showMsg('error', 'Этот файл на макет не ляжет', { note: 'Подойдут картинки PNG, JPEG, GIF и WebP.', ms: 7000 });
    return;
  }
  insertImageFile(file, { x: e.clientX, y: e.clientY });
}

/**
 * Картинка → data:-адрес не больше IMAGE_INSERT.maxSide по большей стороне и maxBytes по весу
 * (документ ходит транзакциями: тело запроса сервера — 4 МБ). С прозрачностью — PNG, иначе JPEG.
 * Анимация GIF не сохраняется (первый кадр). Не открылась за 8 с — null.
 */
function prepareImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = (v) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(v); };
    const timer = setTimeout(() => { img.onload = img.onerror = null; finish(null); }, 8000);
    img.onerror = () => finish(null);
    img.onload = () => {
      try {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!(nw > 0 && nh > 0)) { finish(null); return; }
        let k = Math.min(1, SHELL.IMAGE_INSERT.maxSide / Math.max(nw, nh));
        let alpha = null;
        for (let i = 0; i < 6; i++) {
          const w = Math.max(1, Math.round(nw * k));
          const h = Math.max(1, Math.round(nh * k));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, w, h);
          if (alpha === null) {
            alpha = false;
            if (!/jpeg/i.test(file.type)) {
              const d = g.getImageData(0, 0, w, h).data;
              for (let j = 3; j < d.length; j += 4) if (d[j] < 255) { alpha = true; break; }
            }
          }
          const src = c.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.86);
          const bytes = Math.floor(((src.length - src.indexOf(',') - 1) * 3) / 4);
          if (bytes <= SHELL.IMAGE_INSERT.maxBytes) { finish({ src, width: w, height: h }); return; }
          k *= 0.75;
        }
        finish(null);
      } catch { finish(null); }
    };
    img.src = url;
  });
}

async function insertImageFile(file, client) {
  if (!state.doc) return;
  const ready = await prepareImage(file);
  if (!ready) {
    showMsg('error', 'Картинку не удалось открыть', { note: 'Подойдут PNG, JPEG, GIF и WebP.', ms: 7000 });
    return;
  }
  // брошена на доску — в эту доску; мимо досок — новой доской на месте броска; вставка — по выделению
  let selection = state.selection;
  let at = null;
  if (client && stage && typeof stage.toWorld === 'function') {
    const w = stage.toWorld(client.x, client.y);
    // верхняя видимая доска под точкой (позже в списке — выше на холсте)
    const hit = artboards(state.doc).slice().reverse().find((a) => {
      const r = state.geo.rects[a.id];
      return a.visible !== false && r && w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h;
    });
    selection = hit ? [hit.id] : [];
    at = { x: w.x, y: w.y };
  }
  if (!at) at = nextArtboardPos(artboards(state.doc));
  const stamp = Date.now().toString(36);
  const r = SHELL.imageInsertOps(state.doc, {
    selection, src: ready.src, width: ready.width, height: ready.height, fileName: file.name || '',
    at, ids: { board: `ab_${stamp}`, image: `img_${stamp}` }, boards: artboards(state.doc).length,
    innerWidth: (id) => {
      const r = state.geo.rects[id];
      const n = nodeById(state.doc, id);
      if (!r || !n) return null;
      const pad = n.layout ? resolveLayout(state.doc, n.layout).padding : null;
      return r.w - (pad ? (Number(pad.l) || 0) + (Number(pad.r) || 0) : 0);
    },
    origin: (id) => { const r = state.geo.rects[id]; return r ? { x: r.x, y: r.y } : null; },
  });
  if (r.error) { showMsg('error', `Картинку не вставил: ${r.error}`, { ms: 7000 }); return; }
  const res = commit(r.ops, 'Картинка');
  if (!res || !res.ok) return;
  setSelection(r.select);
  if (!r.into) fitAfterLayout(r.select);
  showMsg('result', 'Картинка на макете', { note: 'Можно сказать: «собери экран в цветах этой картинки».', ms: 8000 });
}

function addArtboard() {
  const abs = artboards(state.doc);
  const at = nextArtboardPos(abs);
  const id = `ab_${Date.now().toString(36)}`;
  /* Круг 20 (SPEC §6.5): новая доска встаёт на шкалы документа — иначе единственный узел
     с «голыми» числами заводила бы сама оболочка. Значения те же, что раньше; ссылкой
     становится то, что в шкале есть, остальное остаётся числом (мимо шкалы). */
  const onScale = (scale, n) => { const i = scaleIndexOf(state.doc, scale, n); return i >= 0 ? scaleRef(scale, i) : n; };
  const sp = (n) => onScale('spacing', n);
  const node = {
    id, type: 'frame', name: `Доска ${abs.length + 1}`, parent: state.doc.root, children: [],
    pos: { x: at.x, y: at.y },
    size: { w: { mode: 'fixed', value: ARTBOARD_W }, h: { mode: 'fixed', value: ARTBOARD_H } },
    layout: { mode: 'column', gap: sp(16), padding: { t: sp(24), r: sp(20), b: sp(24), l: sp(20) }, align: 'stretch', justify: 'start', wrap: false },
    fill: { token: 'surface' }, radius: onScale('radii', 16),
  };
  const r = commit([OPS.create(node)], 'Новая доска');
  if (r.ok) { setSelection([id]); fitAfterLayout([id]); }
  return r;
}

/* ---------------------------------- шторки ----------------------------------- */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let sheetReturnFocus = null;
/** Шторки, ради которых документ гасить нельзя: они про сам документ (п.9). */
/* Круг 19, п.3 и п.6: обе шторки компонентов — тоже разговор о документе. В «Сделать
   компонентом» человек смотрит на узел, который называет; в «Объявить свойство» выбирает
   узел ВНУТРИ компонента и должен видеть, какой именно он выбрал на холсте. */
/* Круг 20, п.4: редактор шкал — тем более разговор о документе: правка шага переверстывает
   холст, и человек должен видеть, как разъезжаются карточки, не закрывая шторку. */
const QUIET_SHEETS = new Set(['history', 'export', 'artboards', 'make-component', 'add-prop', 'scales']);

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

/**
 * Чужие правки для «Истории» (круг 25, п.4): кто, что, когда. Свои (`mine`) здесь не нужны —
 * они в стеке отмены со своими кнопками; служебные (миграция формата) человеку не говорят ничего.
 */
function othersEdits() {
  if (!server) return [];
  const own = new Set(state.history.map((t) => t.id));
  for (const t of state.history) {
    if (t.lastTx) own.add(t.lastTx);
    // круг 31: части большой правки и её отмены — тоже этой записи
    for (const id of t.parts || []) own.add(id);
    for (const id of t.lastParts || []) own.add(id);
  }
  /* Круг 29 (J3, UX Д2): своя транзакция, которой нет в стеке отмены, — правка агента по
     команде, начатой до перезагрузки, правка из другой вкладки этого браузера или старше
     сохранённой истории. Её тоже видно — «вы» / «Агент · вы», без кнопок: отменять её
     отсюда нечем. Служебные свои (отмена и повтор) — состояние записи стека, не строка. */
  const list = journalList().filter((t) => t && t.tx_id && !own.has(t.tx_id) && t.author_kind !== 'system'
    && !(isOwnTx(t) && /^(?:Отмена|Повтор|Отменил|Вернул):/.test(cleanText(t.title)))
    // круг 30: запись без операций и без выпавших (повтор, ops: []) — документ не менялся,
    // строка «Правка без изменений» в ленте только мешает; выпавшие — «не применилась»
    && !(emptyTx(t) && !(Number(t.dropped_count) > 0)));
  return collapseParts(list);
}

/**
 * Круг 31 (K1): части одной большой правки («… · часть 2 из 3») — одной строкой ленты:
 * подпись без хвоста, операции и выпавшие — суммой, время — последней части.
 * Круг 32: части узнаются точно — по `undo_part {i, n}` записи (сервер его хранит) и общему
 * `undo_of`/`redo_of` от одной вкладки, а не по подписи (`SHELL.collapseParts`).
 */
function collapseParts(list) {
  return SHELL.collapseParts(list, { empty: emptyTx });
}

/**
 * Запись журнала без операций (`empty` из /history и реплики, круг 29–30): правка получила
 * номер, но все её операции выпали при слиянии — или их не было вовсе.
 */
function emptyTx(t) {
  return !!(t && (t.empty === true || (t.empty === undefined && t.ops_count === 0)));
}

/**
 * Своя (этого браузера) правка руками из другой вкладки — новейшая своя в журнале, если её
 * нет ни в стеке отмены, ни среди транзакций этой вкладки (круг 31).
 */
function otherTabEdit() {
  if (!server || !server.sync) return null;
  const inStack = new Set();
  for (const t of state.history) { inStack.add(t.id); if (t.lastTx) inStack.add(t.lastTx); for (const id of t.parts || []) inStack.add(id); }
  for (const t of journalList()) {
    if (!t || !isOwnTx(t) || t.author_kind !== 'human' || emptyTx(t)) continue;
    if (/^(?:Отмена|Повтор|Отменил|Вернул):/.test(cleanText(t.title))) continue;
    if (inStack.has(t.tx_id) || tabTx.has(t.tx_id)) return null;
    return t;
  }
  return null;
}

/** Своя правка из другой вкладки этого браузера (не из этой загрузки и не до её перезагрузки). */
function fromOtherTab(t) {
  return !!(t && isOwnTx(t) && t.author_kind !== 'agent' && !tabTx.has(t.tx_id));
}

/** Своя ли транзакция журнала: отметка реплики или своя вкладка (client). */
function isOwnTx(t) {
  return !!(t && (t.mine || (t.client && server && server.sync && t.client === server.sync.clientId)));
}

/** Строка чужой правки: время, что (заголовок или описание), кто. Отменять чужое нельзя. */
function otherEditItem(t) {
  const item = document.createElement('div');
  item.className = 'hitem';
  const agent = t.author_kind === 'agent';
  item.dataset.who = agent ? 'agent' : 'other';
  const head = document.createElement('div');
  head.className = 'hhead';
  const when = document.createElement('span');
  when.className = 'when';
  const at = Date.parse(t.created_at || '');
  when.textContent = Number.isFinite(at) ? new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  if (Number.isFinite(at)) when.title = whenWords(t.created_at);
  const what = document.createElement('span');
  what.className = 'what';
  // круг 31: у сведённых частей описание первой части — не про всю правку; подпись — про всю
  const described = t.partOf ? '' : (journalHuman.get(t.tx_id) || '');
  // J3/J6: у опоздавших описания по операциям нет — подпись транзакции, словами
  const title = SHELL.txTitleWords(t.title);
  const mine = isOwnTx(t);
  if (mine) item.dataset.who = agent ? 'agent' : 'mine';
  // отмена и повтор — своей подписью («Отменил: …»): описание операций назвало бы их новой правкой
  const rewind = /^(?:Отменил|Вернул):/.test(title);
  // круг 30: все операции выпали при слиянии — сама правка не применилась (а не «без изменений»)
  /* круг 45 (UX r45b М3): у правки руками подпись транзакции — те же слова, что у автора в его «Истории»
     («Открепил «Шапка»»), и те же, что увидит соавтор после перезагрузки; описание по операциям
     («Замок да → не задан…») — только запас. «Обернул» — по тому, что легло (круг 43). */
  // подпись старого клиента, переписанная LEGACY_TITLES («Правка» → «Изменил макет»), — не авторская: точнее по операциям
  const authored = !agent && title && title === cleanText(t.title) && !/^Обернул /.test(title);
  const base = emptyTx(t) ? (title ? human(title) : 'Правка') : human((rewind || authored ? title : described) || title || (t.ops_count
    ? `${t.ops_count} ${plural(t.ops_count, 'изменение', 'изменения', 'изменений')}`
    : 'Правка без изменений'));
  // круг 43: по метаданным журнала — не легло ничего («— не применилась») или часть («· не легло 1 из 3»)
  const text = emptyTx(t) ? `${base} — не применилась` : SHELL.appliedLine(base, { ops: t.ops_count, dropped: t.dropped_count });
  what.textContent = text;
  what.title = title && title !== text ? `${text} · ${title}` : text;
  const who = document.createElement('span');
  who.className = 'who';
  /* Правка агента по чужой команде: чья команда — по вкладке (client) из присутствия, а
     когда автор ушёл — из памяти (круг 29, п.7). Своя — «Агент · вы». */
  const fullBy = agent && !mine ? commandAuthorOf(t) : '';
  const byName = fullBy ? cutText(fullBy, 16, { ellipsis: true }) : '';
  const otherTab = mine && fromOtherTab(t);
  if (mine) {
    who.textContent = agent ? 'Агент · вы' : 'вы';
    who.title = agent
      ? 'Правка агента по вашей команде — например, начатой до перезагрузки страницы. Отменить её отсюда нельзя: её нет в стеке отмены этой вкладки'
      : otherTab ? 'Эта правка сделана в другой вкладке — отменить её можно там'
        : 'Ваша правка старше сохранённой истории — отменить её отсюда нельзя';
  } else {
    who.textContent = agent ? (byName ? `Агент · ${byName}` : 'Агент') : (cutText(cleanText(t.author), 24, { ellipsis: true }) || 'Без имени');
    who.title = agent
      ? (byName ? `Правка агента по команде: ${fullBy}` : 'Правка агента по команде участника')
      : `Правку сделал(а) ${cleanText(t.author) || 'участник без имени'}`;
  }
  head.append(when, what, who);
  item.appendChild(head);
  const dropped = Number(t.dropped_count) || 0;
  /* Круг 33 (L2): серия частей ещё не вся — «правка Ани в пути (1 из 3)»; новейшая часть
     давно — «не завершена»: вкладка автора, видимо, закрылась посреди отправки. */
  const series = SHELL.partSeriesWords(t, { mine });
  if (series) {
    const foot = document.createElement('div');
    foot.className = 'hfoot';
    const tag = document.createElement('span');
    tag.className = 'tagpill';
    tag.dataset.series = series.state;
    tag.textContent = series.text;
    tag.title = series.state === 'stale'
      ? 'Остальные части этой большой правки так и не пришли — в документе только то, что успело дойти'
      : 'Большая правка приходит частями — остальные ещё в пути';
    foot.appendChild(tag);
    item.appendChild(foot);
    if (series.state === 'transit') armSeriesRefresh(t);
  }
  if (otherTab && !emptyTx(t)) {
    const foot = document.createElement('div');
    foot.className = 'hfoot';
    const tag = document.createElement('span');
    tag.className = 'tagpill';
    tag.textContent = 'эта правка сделана в другой вкладке — отменить её можно там';
    foot.appendChild(tag);
    item.appendChild(foot);
  }
  // круг 43: сколько не легло — уже в строке (SHELL.appliedLine); метка — только у частей без счёта операций
  if (dropped && !emptyTx(t) && !Number.isFinite(Number(t.ops_count))) {
    const foot = document.createElement('div');
    foot.className = 'hfoot';
    const tag = document.createElement('span');
    tag.className = 'tagpill';
    tag.textContent = `${dropped} ${plural(dropped, 'правка не применилась', 'правки не применились', 'правок не применились')}`;
    foot.appendChild(tag);
    item.appendChild(foot);
  }
  return item;
}

/** «в пути» станет «не завершена» и без новых частей — перерисовать открытую «Историю» к сроку. */
let seriesTimer = null;
function armSeriesRefresh(t) {
  if (seriesTimer) return;
  const at = Date.parse(t.created_at || '');
  if (!Number.isFinite(at)) return;
  const wait = Math.max(1000, at + SHELL.PART_STALE_MS - Date.now() + 500);
  seriesTimer = setTimeout(() => {
    seriesTimer = null;
    if (state.sheetOpen === 'history' && state.sheetTab !== 'chat') refreshSheet();
  }, wait);
}

function fillEdits(body) {
  const others = othersEdits();
  if (!state.history.length && !others.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = 'Пока ничего не менялось.';
    body.appendChild(p);
    return;
  }
  /* Свои и чужие — одной лентой по времени, новые сверху. Свои — со своими кнопками
     (вернуться, вернуть), чужие — только кто, что и когда. */
  /* Круг 45: порядок — по seq подтверждения (SHELL.historyOrder), одинаковый у всех соавторов;
     своя запись встаёт по номеру новейшей своей части в журнале (SHELL.ownHistoryKeys). */
  const ownKeys = SHELL.ownHistoryKeys(state.history, journalList());
  let above = 0;   // чужих записей выше по ленте (сделаны позже): метка «ваши правки сейчас здесь»
  for (const step of SHELL.historyOrder(ownKeys, others)) {
    if (step.other !== undefined) { body.appendChild(otherEditItem(others[step.other])); above++; continue; }
    const i = step.own;
    const tx = state.history[i];
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
    // строка истории — это описание правки, а не сырое имя намерения (п.4); круг 43 — по применённому
    const text = SHELL.appliedLine(human(tx.human || tx.label), { ops: Array.isArray(tx.ops) ? tx.ops.length : 0, dropped: tx.dropped || 0 });
    const what = document.createElement('span');
    what.className = 'what'; what.textContent = text;
    what.title = tx.label && tx.label !== text ? `${text} · команда: ${human(tx.label)}` : text;
    const who = document.createElement('span');
    // круг 29, п.7: правка агента по своей команде — «Агент · вы», как у соавторов «Агент · Аня»
    who.className = 'who'; who.textContent = tx.who === 'agent' ? 'Агент · вы' : 'вы';
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
    // круг 22: правка применена у нас, но сервер её ещё не подтвердил — это видно
    if (server && tx.pending) {
      const wait = document.createElement('span');
      wait.className = 'tagpill wait';
      wait.textContent = 'ждёт подтверждения';
      wait.title = 'Правка применена здесь и отправлена на сервер; после подтверждения её увидят все.';
      foot.appendChild(wait);
    }
    if (current) {
      const now = document.createElement('span');
      now.className = 'hnow';
      /* Круг 33, п.7: выше по ленте — правки других, сделанные позже: они в документе остаются,
         и «документ сейчас здесь» под ними было бы неправдой. Тогда метка — про свои правки. */
      const later = above > 0;
      now.textContent = later ? 'ваши правки сейчас здесь' : 'документ сейчас здесь';
      now.title = later
        ? 'Правки других участников выше по ленте сделаны позже и остаются в документе — ваша отмена их не трогает'
        : 'Документ сейчас в состоянии сразу после этой правки';
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
  }
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
  if (dom.sheet.hidden) return;
  if (state.sheetOpen === 'history') openHistory();
  // круг 20: у редактора шкал те же права — после Ctrl+Z шаг обязан показывать прежнее число
  else if (state.sheetOpen === 'scales') openScales(scalesFocus, { keepFocus: true });
}

/* ------------------------------ круг 20: редактор шкал ------------------------------ */

/** Какую шкалу человек открыл из инспектора — её и ставим первой. */
let scalesFocus = null;

/**
 * Шторка «Шкалы» (SPEC §6.7, круг 20, п.4). Значения шагов правятся прямо здесь, и правка
 * любого сразу переверстывает всё, что на него ссылается: это `setToken spacing.<i>`,
 * обычный commit, отмена по Ctrl+Z даром. У каждого шага стоит, сколько узлов на него
 * ссылается (scaleRefsIn) — цена правки видна до правки, а не после.
 *
 * Шаг 0 со значением 0 ЗАПЕРТ. Миграция (§6.5) превратила все нули документа в 'spacing.0':
 * «отступа нет» и «отступ — нулевой шаг шкалы» в записи неотличимы, и правка нулевого
 * шага дала бы отступы всему, у чего их никогда не было. Это осознанное решение круга 20,
 * и подсказка у замка говорит о нём словами.
 *
 * Вставка шага — «+» у строки: новый шаг встаёт ПОСЛЕ неё со значением посередине до
 * следующего (или на шаг выше последнего), ссылки переписываются ядром (insertScaleStep),
 * так что ни один узел не меняет пикселей. Удаления шага в этом круге нет.
 * @param {'spacing'|'radii'} [focus] какую шкалу показать первой
 */
function openScales(focus, opts = {}) {
  if (focus && SCALE_NAMES[focus]) scalesFocus = focus;
  // перерисовка по commit/refreshSheet: фокус возвращается на то же поле — кроме вставки
  // шага, после которой под каретку встаёт новый шаг (scalesPendingFocus, см. fillScales)
  const memo = opts.keepFocus && !scalesPendingFocus ? grabSheetFocus() : null;
  openSheet('Шкалы документа', (body) => fillScales(body), { key: 'scales' });
  if (memo) restoreSheetFocus(memo);
}

function grabSheetFocus() {
  const a = document.activeElement;
  if (!a || !dom['sheet-body'].contains(a) || !a.dataset || !a.dataset.skey) return null;
  return { key: a.dataset.skey };
}
function restoreSheetFocus(memo) {
  const f = dom['sheet-body'].querySelector(`[data-skey="${CSS.escape(memo.key)}"]`);
  if (!f) return;
  try { f.focus({ preventScroll: true }); } catch { f.focus(); }
}

/** Сколько узлов ссылается на каждый шаг шкалы: индекс → число узлов. */
function scaleUsage(scale) {
  const byStep = new Map();
  for (const r of scaleRefsIn(state.doc, scale)) {
    const set = byStep.get(r.index) || new Set();
    set.add(r.id);
    byStep.set(r.index, set);
  }
  return byStep;
}

/** Значение для нового шага после i-го: посередине до следующего, за последним — шаг вверх. */
function nextStepValue(steps, i) {
  const cur = Number(steps[i]) || 0;
  const nxt = steps[i + 1];
  if (typeof nxt === 'number' && nxt > cur) return Math.round((cur + nxt) / 2);
  const prev = steps[i - 1];
  const stride = typeof prev === 'number' && cur > prev ? cur - prev : (cur || 4);
  return cur + stride;
}

function setScaleStep(scale, i, value) {
  const steps = scaleSteps(state.doc, scale);
  if (i === 0 && steps[0] === 0) return;   // запертый ноль — см. openScales
  if (steps[i] === value) return;
  const r = commit([OPS.setToken(`${scale}.${i}`, value)], 'Шаг шкалы', 'human', { quiet: true });
  if (!r.ok) return;
  // пересчитать нечего: холст перерисовал commit, шторку — refreshSheet
}

function insertStepAfter(scale, i) {
  const steps = scaleSteps(state.doc, scale);
  const value = nextStepValue(steps, i);
  const list = insertScaleStep(state.doc, scale, i + 1, value);
  if (!list.length) { toast('Шаг вставить не удалось.', 'error', 6000); return; }
  const rewritten = list.length - 1;
  const word = SCALE_NAMES[scale];
  // новый шаг — под каретку: человек его вставил, чтобы поправить. Ставим ДО commit:
  // шторку перерисует refreshSheet внутри него
  scalesPendingFocus = `${scale}|${i + 1}|value`;
  const r = commit(list, 'Новый шаг шкалы', 'human', {
    quiet: true, noFrames: true,
    // своя фраза: 50 переписанных ссылок — не 50 правок узлов, пиксели у них не менялись
    human: `${word.charAt(0).toUpperCase()}${word.slice(1)}: новый шаг ${value} после ${humanValue(steps[i])}`
      + (rewritten ? `, ссылки ${rewritten} ${plural(rewritten, 'поля', 'полей', 'полей')} переставлены без сдвига` : ''),
  });
  if (!r.ok) scalesPendingFocus = null;
}
let scalesPendingFocus = null;

function fillScales(body) {
  body.appendChild(noteEl('Зазоры, отступы и скругления в документе ссылаются на шаги этих шкал. '
    + `Правка шага переверстывает всё, что на него ссылается; ${keyText('Mod+Z') ? `отмена — ${keyText('Mod+Z')}` : 'отмена — кнопкой «Отменить»'}.`));
  const order = scalesFocus === 'radii' ? ['radii', 'spacing'] : ['spacing', 'radii'];
  for (const scale of order) body.appendChild(scaleEditor(scale));
  if (scalesPendingFocus) {
    const f = body.querySelector(`[data-skey="${CSS.escape(scalesPendingFocus)}"]`);
    scalesPendingFocus = null;
    if (f) { try { f.focus({ preventScroll: true }); f.select(); } catch { /* не страшно */ } }
  }
}

function scaleEditor(scale) {
  const steps = scaleSteps(state.doc, scale);
  const usage = scaleUsage(scale);
  const name = SCALE_NAMES[scale];
  const box = document.createElement('section');
  box.className = 'scale-ed';
  box.dataset.scale = scale;
  box.setAttribute('aria-label', name);

  const head = document.createElement('h4');
  head.className = 'scale-ed-title';
  head.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  box.appendChild(head);

  const total = new Set([...usage.values()].flatMap((s) => [...s])).size;
  const sub = noteEl(total
    ? `${steps.length} ${plural(steps.length, 'шаг', 'шага', 'шагов')} · ${plural(total, 'ссылается', 'ссылаются', 'ссылаются')} ${total} ${plural(total, 'слой', 'слоя', 'слоёв')}`
    : `${steps.length} ${plural(steps.length, 'шаг', 'шага', 'шагов')} · пока никто не ссылается`);
  sub.className = 'note scale-ed-sub';
  box.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'scale-rows';
  list.setAttribute('role', 'list');
  steps.forEach((v, i) => list.appendChild(scaleRow(scale, steps, i, usage.get(i))));
  box.appendChild(list);
  return box;
}

function scaleRow(scale, steps, i, users) {
  const v = steps[i];
  const locked = i === 0 && v === 0;
  const n = users ? users.size : 0;
  const rowEl = document.createElement('div');
  rowEl.className = 'scale-row';
  rowEl.setAttribute('role', 'listitem');
  if (locked) rowEl.dataset.locked = 'on';
  if (!n) rowEl.dataset.unused = 'on';

  const idx = document.createElement('span');
  idx.className = 'scale-idx';
  idx.textContent = `шаг ${i}`;

  let val;
  if (locked) {
    val = document.createElement('span');
    val.className = 'field scale-locked';
    val.textContent = '0';
    val.title = 'Нулевой шаг заперт: на него ссылается всё, у чего отступа нет вовсе, — '
      + 'миграция превратила все нули документа в ссылки на него. Правка дала бы отступы там, где их не было.';
    val.setAttribute('role', 'img');
    val.setAttribute('aria-label', `Шаг 0, значение 0, заперт. ${val.title}`);
    val.tabIndex = 0;
  } else {
    val = numberField(v, (next) => setScaleStep(scale, i, next), { label: `${SCALE_NAMES[scale]}, шаг ${i}: значение` });
    val.dataset.skey = `${scale}|${i}|value`;
  }

  const use = document.createElement('span');
  use.className = 'scale-use';
  use.textContent = n ? `${n} ${plural(n, 'слой', 'слоя', 'слоёв')}` : 'не используется';
  use.title = n
    ? `На этот шаг ссылаются ${n} ${plural(n, 'слой', 'слоя', 'слоёв')}: правка значения переверстает их все`
    : 'На этот шаг сейчас никто не ссылается: правка ничего не сдвинет';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn ghost icon small scale-add';
  add.title = `Вставить шаг после ${humanValue(v)}`;
  add.setAttribute('aria-label', add.title);
  add.appendChild(iconEl('plus'));
  add.dataset.skey = `${scale}|${i}|add`;
  add.addEventListener('click', () => insertStepAfter(scale, i));

  rowEl.append(idx, val, use, add);
  return rowEl;
}

function openExport() {
  openSheet('Экспорт и импорт', (body) => fillExport(body), { size: 'auto', key: 'export' });
}

/**
 * Имя файла: документ и артборд вместе. Кнопка обещала «PNG · Маршрут дня», а сохраняла
 * «Рабочая-неделя.png» — и второй артборд затирал первый (круг 9, п.7).
 */
function exportName(ext, abId) {
  const doc = safeName(server ? docTitle() : state.doc.meta && state.doc.meta.name);
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
  if (!ok) { toast('Картинку снимают с доски, а её в документе нет.', 'error', 8000); return false; }
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
    toast(`Картинка не получилась: ${afterColon(humanError(e))}`, 'error', 9000);
    return false;
  }
}

/** Вектор активного артборда. */
async function exportSvg() {
  const { id, ok } = exportTarget();
  if (!ok) { toast('Вектор снимают с доски, а её в документе нет.', 'error', 8000); return false; }
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
  catch (e) { toast(`Вектор не получился: ${afterColon(humanError(e))}`, 'error', 9000); return false; }
  if (dataIsEmpty(markup)) {
    toast('Вектор не получился: сцена не отдала разметку доски.', 'error', 9000);
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
  // круг 50: шрифты из сети выключены человеком — сказать, что их в файле нет
  if (fonts === 'off' && settings.webFonts === false) {
    return what === 'SVG' ? 'Шрифты из сети выключены — начертания в SVG не встроены: у получателя текст будет шрифтами его системы.'
      : `Шрифты из сети выключены — ${what} нарисован шрифтами системы.`;
  }
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
  /* Круг 33, п.7: в серверной сборке файл скачивается обычной ссылкой браузера — строка про
     «запущена локально» там лишняя и сбивает с толку. Пояснение — только где оно правда. */
  if (downloads || !server) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = downloads
      ? 'Файл будет предложен к сохранению — подтвердите в диалоге.'
      : 'Сохранение файлов доступно, когда страница запущена локально или получила разрешение.';
    body.appendChild(note);
  }

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
    png.textContent = 'PNG — нет доски';
    png.disabled = true;
    png.title = 'Картинку снимают с доски, а её в документе нет';
  } else {
    png.textContent = abName ? `PNG · ${abName}` : 'PNG активной доски';
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
  mk(hasBoard ? 'SVG' : 'SVG — нет доски',
    hasBoard ? `Вектор активной доски — ${exportName('svg', abId)}` : '',
    () => exportSvg(),
    hasBoard ? '' : 'Вектор снимают с доски, а её в документе нет');
  mk('JSON', `Весь документ — ${exportName('json', null)}, его можно вернуть импортом`, () => exportJson());
  body.appendChild(rest);
  /* Круг 36 (SPEC §11.3): SVG несёт состояния как CSS — в браузере файл реагирует на мышь.
     Об этом сказано только там, где это правда: в доске есть слои с состояниями. */
  if (hasBoard && SHELL.subtreeHasStates(state.doc, abId)) {
    const mo = document.createElement('div');
    mo.className = 'note export-motion';
    mo.appendChild(iconEl('motion'));
    const t = document.createElement('span');
    t.textContent = 'SVG — с микроанимациями (откройте в браузере): наведение и нажатие оживают.';
    mo.appendChild(t);
    body.appendChild(mo);
    const svgBtn = rest.firstElementChild;
    if (svgBtn) svgBtn.title = `${svgBtn.title} — с микроанимациями: откройте файл в браузере`;
  }

  const hint = document.createElement('div');
  hint.className = 'note';
  hint.textContent = hasBoard
    ? (huge
      ? `Артборд ${Math.round(rect.w)}×${Math.round(rect.h)} px крупный: PNG выйдет в уменьшенном масштабе или не выйдет вовсе — вектор надёжнее.`
      : `PNG — картинка ${Math.round(rect.w * wantScale)}×${Math.round(rect.h * wantScale)} px, SVG — вектор, JSON — весь документ целиком.`)
    : 'Картинка и вектор снимаются с доски. Пока её нет, можно сохранить только JSON документа.';
  body.appendChild(hint);

  // импорт жил в «Настройках агента», а искать его человек идёт туда, где экспорт (п.21)
  const imp = document.createElement('button');
  imp.className = 'btn subtle wide';
  imp.textContent = 'Импортировать JSON документа';
  imp.addEventListener('click', importJson);
  const impNote = document.createElement('div');
  impNote.className = 'note';
  impNote.textContent = `Файл станет открытым документом. Прежний вернётся кнопкой «Отменить»${keyOr('Mod+Z')}.`;
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
  // браузер скачал молча — человеку нужно то же «Сохранено», что и при диалоге (круг 33)
  toast(`Сохранено: ${filename}`, 'plain');
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
  /* Круг 22: в серверном режиме имя участника — то, что видят другие у рамки выделения
     и в истории. Спрашивается при первом входе, здесь меняется. */
  if (server) {
    const nameField = field('input', settings.author || '', (v) => {
      setAuthor(v);
      if (settings.author) toast(`Для других участников вы — ${settings.author}.`, 'plain', 5000);
    }, 'Ваше имя для других участников');
    nameField.placeholder = 'Как вас называть';
    nameField.maxLength = 40;
    const hint = document.createElement('div');
    hint.className = 'note';
    hint.textContent = server.project
      ? `Проект «${server.project.name || 'Без названия'}» — правки уходят на сервер и видны всем участникам.`
      : 'Правки уходят на сервер и видны всем участникам.';
    body.appendChild(group('Участник', [row('Имя', nameField), hint]));
  }

  const status = document.createElement('div');
  status.className = 'note';
  status.textContent = state.providerKind === 'claude'
    ? 'Агент работает через Claude на этой странице.'
    : state.providerKind === 'lmstudio'
      ? (server
        ? `Команды агента выполняет сервер; если он не отвечает — LM Studio этого компьютера: ${settings.lmstudio.baseUrl}`
        : `Агент работает через LM Studio: ${settings.lmstudio.baseUrl}`)
      // круг 25: в серверном режиме своя модель не нужна — агент живёт на сервере
      : server
        ? 'Команды агента выполняет сервер. Своя модель здесь нужна, только чтобы работать, когда сервер агента не отвечает.'
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
      // круг 25: модель браузера включил человек сам — в серверном режиме только такая и работает
      settings.lmstudio.chosen = true;
      saveSettings();
      agentModeChanged();
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
    // круг 47 (SPEC §14.3): мультимодальной модели агент показывает снимок собранного экрана
    row('Картинки', selectField(['no', 'yes'], settings.lmstudio.vision === true ? 'yes' : 'no', (v) => {
      settings.lmstudio.vision = v === 'yes';
      saveSettings();
      if (state.providerKind === 'lmstudio') useLmStudio();
    }, { no: 'модель их не видит', yes: 'видит (Qwen-VL, Gemma 3, LLaVA…)' })),
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
  // круг 25: в серверном режиме модель браузера — запасной путь; выключить её можно здесь же
  if (server && state.providerKind === 'lmstudio') {
    const off = document.createElement('button');
    off.className = 'btn subtle wide';
    off.textContent = 'Не использовать LM Studio';
    off.addEventListener('click', () => {
      state.provider = null;
      state.providerKind = null;
      settings.lmstudio.enabled = false;
      settings.lmstudio.chosen = false;
      saveSettings();
      agentModeChanged();
      openSettings();
    });
    lmRows.push(off);
  }
  body.appendChild(group('Локальная модель (LM Studio)', lmRows));

  // микрофон-переключатель раньше слушал комнату без конца, хотя об этом нигде не сказано (п.9)
  // круг 17: голос недоступен и когда кнопка не disabled, а помечена data-unavailable
  const micOff = !!dom['btn-mic']
    && (dom['btn-mic'].disabled || dom['btn-mic'].dataset.unavailable === 'on');
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
    ? VOICE_NO_MIC
    : '«Одна команда»: микрофон выключается сам — после отправки и после десяти секунд тишины. '
      + '«Слушать постоянно»: слышит всё, что говорят рядом, пока его не выключить.';
  body.appendChild(group('Голос', [always, voiceNote]));
  // круг 50 (SPEC §17.2): то же, что команды «/образ», «/самопроверка», «/шрифты из сети»
  const artRow = (label, key, what) => row(label, segField(['on', 'off'], settings[key] === false ? 'off' : 'on',
    (v) => { setAgentSetting(what, v === 'on'); openSettings(); }, ['Вкл', 'Выкл']));
  const artNote = document.createElement('div');
  artNote.className = 'note';
  artNote.textContent = 'Арт-направление: перед новым экраном агент решает образ, палитру и шрифты. Самопроверка: смотрит на собранное '
    + 'и дорабатывает шаблонное (дольше и дороже). Шрифты из сети: гарнитуры макета из Google Fonts на холсте, в снимке и в экспорте; '
    + 'выключены — макет шрифтами системы (шрифт самого интерфейса грузится как раньше). Это настройки: действуют, пока их не поменять.';
  body.appendChild(group('Агент: оформление', [
    artRow('Арт-направление', 'artDirection', 'direction'),
    artRow('Самопроверка', 'artCritic', 'critic'),
    artRow('Шрифты из сети', 'webFonts', 'webFonts'),
    artNote,
  ]));
  /* Круг 25, п.6: на телефоне кнопка темы уступает место имени проекта в шапке — выбор
     темы есть и здесь (и голосом: «тёмная тема интерфейса»). */
  body.appendChild(group('Оформление', [row('Тема', segField(
    ['auto', 'light', 'dark'],
    THEME_WORDS[settings.theme] ? settings.theme : 'auto',
    (v) => { setTheme(v); openSettings(); },
    ['Как в системе', 'Светлая', 'Тёмная'],
  ))]));
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
    if (guard-- <= 0) return 'связи слоёв замкнуты в кольцо';
    const id = stack.pop();
    if (seen.has(id)) return 'один слой стоит в дереве дважды';
    seen.add(id);
    const n = doc.nodes[id];
    if (!n) return `слой «${id}» указан среди вложенных, но не описан`;
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
  if (!raw.nodes[raw.root]) throw new Error(`корень документа «${raw.root}» не описан`);
  // сначала чиним копию и считаем геометрию — состояние трогаем, только если всё сошлось
  const next = createDoc(raw);
  if (!next || !next.nodes || !next.root || !next.nodes[next.root]) {
    throw new Error('в документе нет корня');
  }
  // и ещё раз сверяемся с тем, что пришло: у подменённого документа и корень, и узлы чужие.
  // Разобранных узлов может стать меньше (битые рёбра отбрасываются), но не больше.
  const alien = Object.keys(next.nodes).filter((id) => !raw.nodes[id]);
  if (next.root !== raw.root || alien.length) throw new Error('не разобрался как документ Imago');
  const tree = treeProblem(next);
  if (tree) throw new Error(tree);
  const geo = solveKept(next);
  if (!geo || !geo.rects) throw new Error('раскладка не считается');
  // createDoc чинит узлы не по схеме, но починка бывает и неполной: размер без числа
  // доходит до solve и возвращается как NaN. Такой документ до состояния не допускаем.
  const broken = firstBrokenRect(geo);
  if (broken) {
    const name = nodeTitleById(next, broken) || broken;
    throw new Error(`размеры слоя «${name}» — не числа, раскладка не считается`);
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
  /* Круг 19, п.1. МИГРАЦИЯ. Документы, сохранённые до компонентов, библиотеки не имеют,
     а ядро намеренно не заводит её в createDoc: импорт сверяет разобранные узлы с узлами
     файла (проверка `alien` выше), и новая библиотека сорвала бы эту сверку как чужой узел.
     Поэтому библиотеку добавляем ЗДЕСЬ — после всех проверок и ровно один раз на обе
     дороги, по которым чужой документ попадает в состояние: импорт JSON и восстановление
     из хранилища (обе идут через adoptDoc). Вызов идемпотентен: если библиотека уже есть,
     ensureLibrary отдаёт тот же самый документ, и пересчитывать нечего. */
  const withLib = ensureLibrary(next);
  let out = { doc: withLib, geo, lost, lostEdges };
  if (withLib !== next) {
    // библиотека рисуется на холсте рядом с досками (SPEC §5.3) — геометрию считаем заново
    const geoLib = solve(withLib);
    if (!geoLib || !geoLib.rects) throw new Error('раскладка не считается');
    out = { ...out, geo: geoLib, migrated: true };
  }
  /* Круг 20, п.1 (SPEC §6.5). Вторая миграция там же, где первая: число, точно равное шагу
     шкалы, становится ссылкой на этот шаг, число мимо шкалы остаётся числом. Идёт ПОСЛЕ
     библиотеки, чтобы её узлы тоже встали на шкалу. Геометрию не пересчитываем: миграция
     меняет только запись значения, а не само значение — ссылка разрешается ровно в то
     число, из которого выросла (это проверено на демо-документе круга 18: отпечаток
     геометрии до и после совпадает). Идемпотентна: документ на ссылках возвращается тем же
     объектом, и флага rescaled у него нет. */
  const withScales = ensureScaleRefs(out.doc);
  if (withScales !== out.doc) out = { ...out, doc: withScales, rescaled: true };
  return out;
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
      const raw = parseJsonFile(text);
      /* Круг 31 (UX Д1): документ на сервере — не больше 20 000 узлов (SPEC §9.8). Больший
         файл не ляжет ни одной транзакцией, ни пачками — говорим это сразу, числом, а не
         после раскладки на десятки секунд. */
      const rawCount = raw && raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes) ? Object.keys(raw.nodes).length : 0;
      if (server && rawCount > LIMITS.docNodes) {
        closeSheet();
        showMsg('error', SHELL.importTooBigWords(rawCount, LIMITS.docNodes), {
          note: 'Документ остался прежним. Разделите файл на части или удалите из него лишнее.',
          actions: [{ label: 'Выбрать другой файл', primary: true, onClick: () => importJson() }],
        });
        return;
      }
      const taken = adoptDoc(raw);
      /* Круг 41 (UX Д6): предел раскрытия экземпляров — до записи, тем же правилом, что у
         сервиса (400 на импорт): иначе ядро молча не раскрывало лишнее, а сервер отбрасывал
         create, и человек читал «Загружен документ» без части слоёв. */
      const over = typeof CORE.expandProblem === 'function' ? CORE.expandProblem(taken.doc) : null;
      if (over) {
        closeSheet();
        const w = SHELL.expandLimitWords(over);
        showMsg('error', w.title, {
          note: w.note,
          actions: [{ label: 'Выбрать другой файл', primary: true, onClick: () => importJson() }],
        });
        return;
      }
      // круг 46: без сервера файл становится новым проектом, открытый остаётся как был
      if (!server && solo) { await importAsSoloProject(taken, f.name); return; }
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
      // библиотека, заведённая миграцией, тоже узел: предел — по документу, который ляжет
      if (server && count > LIMITS.docNodes) {
        closeSheet();
        showMsg('error', SHELL.importTooBigWords(count, LIMITS.docNodes), {
          note: 'Документ остался прежним. Разделите файл на части или удалите из него лишнее.',
          actions: [{ label: 'Выбрать другой файл', primary: true, onClick: () => importJson() }],
        });
        return;
      }
      if (server && count >= BIG_DOC) {
        // большой файл ляжет несколькими транзакциями (K1) — строку держим до конца
        showMsg('plain', `Загружаю «${clip(f.name, 40)}»: ${count} ${plural(count, 'слой', 'слоя', 'слоёв')}…`);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }
      const r = commitDoc(taken.doc, taken.geo, `Импорт «${nowName}»`,
        `Загрузил «${nowName}» вместо «${wasName}»`);
      closeSheet();
      /* Круг 31 (UX Д1): правка не легла (проект не открыт, сервер отказал) — раньше здесь
         падало «Cannot read properties of undefined» на r.tx.id. */
      if (!r || !r.ok) {
        if (r && r.error && r.error.code === 'not_open') return;   // карточку уже показал serverCommit
        if (r && r.error && r.error.code === 'too_large') return;  // и об этом сказано (onSyncError)
        throw new Error(r && r.error && r.error.message ? `сервер не принял документ — ${r.error.message}` : 'сервер не принял документ');
      }
      state.userView = false;
      fitSmart();
      const blank = artboards(taken.doc).length === 0;
      const bits = [`слоёв: ${count}`];
      if (taken.lost) {
        bits.push(`не прочитал ${taken.lost} ${plural(taken.lost, 'слой', 'слоя', 'слоёв')}`);
      }
      // круг 16, п.12: узлы целы, а вложение пришлось выпрямить — молчать об этом нельзя
      if (taken.lostEdges) {
        bits.push(`не сохранил ${taken.lostEdges} `
          + `${plural(taken.lostEdges, 'связь', 'связи', 'связей')} между слоями — вложение выпрямлено`);
      }
      if (blank) bits.push('досок в файле не оказалось — холст пуст');
      // круг 19, п.1: файл из прежней версии библиотеки не имел — говорим об этом словами,
      // иначе в рельсе просто из ниоткуда появляется группа «Библиотека»
      if (taken.migrated || taken.rescaled) {
        /* Круг 20, п.1: то же для шкал. Человек открыл файл, в котором стояли числа, а в
           инспекторе теперь читает «по шкале» — откуда это взялось, надо сказать словами. */
        const done = [];
        if (taken.migrated) done.push('завёл библиотеку компонентов');
        if (taken.rescaled) done.push('отступы и скругления перевёл на шкалы документа');
        bits.push(`файл из прежней версии — ${done.join(', ')}`);
      }
      /* Круг 16, п.13(б). На таком документе правка и отмена занимают заметное время, и
         честнее сказать об этом заранее, чем оставлять человека гадать, не завис ли
         редактор: во время самой правки поток занят и нарисовать предупреждение нечем. */
      if (count >= BIG_DOC) bits.push('документ большой — правка и отмена будут заметно медленнее');
      if (r.partial) bits.push(`часть ${r.partial.at + 1} из ${r.partial.of} сервер не принял — в ней слой больше 3,5 МБ`);
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
  // круг 22: у открытого документа в серверном режиме имя — имя проекта
  if (server && server.project && doc === state.doc) return docTitle();
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
  // круг 37: у иллюстрации и её деталей — то, что с ними делают словами
  const ill = node && SHELL.isIllustration(state.doc, node);
  const detail = node && !ill && SHELL.isIllustration(state.doc, nodeById(state.doc, node.parent));
  if (ill) {
    // не про конкретного монстра: иллюстрацией бывает и печенька
    list = ['добавь мелких деталей и бликов', 'перекрась в пастельные тона', 'сделай тени мягче'];
  } else if (detail || (node && node.type === 'vector')) {
    list = ['перекрась в тёплые тона', 'добавь блик и мягкую тень', 'сделай крупнее и чуть поверни'];
  } else if (node && node.type === 'text') {
    list = ['сделай крупнее и добавь подзаголовок', 'перепиши короче и строже', 'выровняй по центру'];
  } else if (node && isArtboard(state.doc, node.id)) {
    list = ['добавь нижнюю панель с тремя кнопками', 'сделай тёмную тему', 'добавь шапку с аватаром и датой'];
  } else if (node) {
    list = ['добавь сюда кнопку «Оплатить»', 'увеличь отступы и скругления', 'оживи при наведении: подъём и тень'];
  } else {
    // круг 36 (SPEC §11.4): микроанимации — тоже работа агента, и это надо показать
    // круг 37 (SPEC §12.2): и иллюстрации
    list = ['экран оплаты с полем карты и итогом', 'нарисуй милого монстра', 'оживи кнопки: подъём и тень при наведении'];
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
/* Круг 18, п.5. Человек называет их досками, и оболочка говорит так же. Но часть
   слов приходит из brain.js, а он — не наш файл: «завернул в артборд», «поменялись
   ВСЕ артборды», «нужен отдельный артборд». Переводим их здесь, на самой границе
   показа, и только целыми фразами: словарь по корню дал бы «Нужен отдельный доска» —
   род у слов разный. Внутри «…» не трогаем ничего: там имя слоя, а имя принадлежит
   документу, а не словарю оболочки. В отчёте это записано как просьба к brain.js
   говорить «доска» самому. */
const BOARD_PHRASES = [
  [/завернул в артборд/g, 'завернул в доску'],
  [/Нужен отдельный артборд/g, 'Нужна отдельная доска'],
  [/нужен отдельный артборд/g, 'нужна отдельная доска'],
  [/поменялись ВСЕ артборды/g, 'поменялись ВСЕ доски'],
  [/все артборды/g, 'все доски'],
  [/артборды/g, 'доски'],
  [/артбордов/g, 'досок'],
];

/** Перевод вне кавычек: имя слоя «Артборд 2» должно остаться собой. */
/* Круг 33, п.7: человек называет их слоями (рельс «Слои»), а слова brain и сервера —
   «подходит узлов — 4», «узел уже удалён». Тоже на границе показа и тоже вне кавычек; род у
   «узел» и «слой» один, поэтому падежи переводятся слово в слово. */
const LAYER_FORMS = {
  'узел': 'слой', 'узла': 'слоя', 'узлу': 'слою', 'узлом': 'слоем', 'узле': 'слое',
  'узлы': 'слои', 'узлов': 'слоёв', 'узлам': 'слоям', 'узлами': 'слоями', 'узлах': 'слоях',
};
const LAYER_RE = /(?<![А-Яа-яЁё])([Уу])(зел|зла|злу|злом|зле|злы|злов|злам|злами|злах)(?![А-Яа-яЁё])/g;

function boardWords(text) {
  const s = String(text == null ? '' : text);
  const board = /артборд/i.test(s);
  const layer = /[Уу]з(?:ел|л)/.test(s);
  if (!board && !layer) return s;
  return s.split(/(«[^»]*»)/).map((part) => {
    if (part.startsWith('«')) return part;
    let out = part;
    if (board) for (const [re, to] of BOARD_PHRASES) out = out.replace(re, to);
    if (layer) {
      out = out.replace(LAYER_RE, (m, u, rest) => {
        const to = LAYER_FORMS[`у${rest}`];
        if (!to) return m;
        return u === 'У' ? to.charAt(0).toUpperCase() + to.slice(1) : to;
      });
    }
    return out;
  }).join('');
}

function human(text) {
  let depth = 0;
  let out = '';
  // технические пути → слова инспектора: «layout.gap» человеку ничего не говорит (п.9)
  for (const ch of boardWords(humanizePaths(text))) {
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
  // круг 27, п.7: под шапкой тост ложился на панель масштаба — от шапки встаём на обычное место
  if (!host || host.classList.contains('topbar')) {
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

/* Круг 39 (N6в): клавиши — по платформе (Ctrl на Windows/Linux, ⌘ на macOS), на телефоне без
   клавиатуры о них не говорим вовсе. Платформа считается один раз. */
let keyPf = null;
function keyPlatformNow() {
  if (!keyPf) {
    const mq = typeof matchMedia === 'function' ? (q) => matchMedia(q).matches : null;
    keyPf = SHELL.keyPlatform(typeof navigator !== 'undefined' ? navigator : null, mq);
  }
  return keyPf;
}
/** «Ctrl+Z» / «⌘Z» / '' (телефон). */
function keyText(keys) {
  return SHELL.keyLabel(keys, keyPlatformNow());
}
/** « или Ctrl+Z» — хвост фразы; на телефоне пусто. */
function keyOr(keys) {
  const k = keyText(keys);
  return k ? ` или ${k}` : '';
}
/** «Вернуть можно здесь или по Ctrl+Z.» — на телефоне «Вернуть можно здесь.» */
function backHint() {
  const k = keyText('Mod+Z');
  return k ? `Вернуть можно здесь или по ${k}.` : 'Вернуть можно здесь.';
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ------------------ круг 46: проекты без сервера (соло-режим) ------------------ */
/*
 * В соло-режиме (артефакт, dist/local) проектов много, как файлов в Figma. Хранилище —
 * SHELL.openSoloStore (тела в IndexedDB, список в localStorage). Открытый проект — solo.current;
 * его документ живёт в state.doc, как и раньше, и сохраняется тем же scheduleSave/saveNow, но в
 * хранилище проектов. Выделение — своё у каждого проекта на сессию, вид и активная доска — в
 * индексе, история и разговор — в теле проекта (как прежде у единственного документа).
 */
let solo = null;   // {store, current, base, sessions: Map, tombs: Map, conflict}
const SOLO_MIGRATED_KEY = 'imago.projects.migrated.v1';

/** localStorage, если к нему вообще можно прикоснуться (в песочнице доступ бросает). */
function lsOrNull() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/**
 * Проекты соло-режима: открыть хранилище, перенести единственный прежний документ первым
 * проектом (один раз), открыть текущий. true — документ взят из проекта (или из прежней копии).
 */
async function initSoloProjects() {
  let store = null;
  try {
    store = await SHELL.openSoloStore({
      indexedDB: (() => { try { return globalThis.indexedDB || null; } catch { return null; } })(),
      localStorage: lsOrNull(),
      BroadcastChannel: typeof BroadcastChannel === 'function' ? BroadcastChannel : null,
    });
  } catch { store = SHELL.createSoloStore({}); }
  solo = { store, current: null, base: null, sessions: new Map(), tombs: new Map(), conflict: null };
  try { await store.adoptExit(); } catch { /* запись ухода не прочиталась — тело то, что было */ }
  store.onRemote(onSoloRemote);
  try { globalThis.addEventListener('storage', (ev) => { if (solo) solo.store.storageEvent(ev); }); } catch { /* без событий окна */ }
  if (dom['btn-projects']) dom['btn-projects'].hidden = false;
  const list = store.list();
  if (list.length) {
    const want = store.current() && list.some((p) => p.id === store.current()) ? store.current() : list[0].id;
    const ok = await loadSoloProject(want, { first: true });
    if (ok) return true;
    // текущий не прочитался — следующий по свежести
    for (const p of list) if (p.id !== want && await loadSoloProject(p.id, { first: true })) return true;
  }
  // проектов нет: один раз — перенос прежнего документа (imago.doc.v1 / хранилище артефакта)
  let migrated = '';
  try { migrated = (lsOrNull() && lsOrNull().getItem(SOLO_MIGRATED_KEY)) || ''; } catch { migrated = ''; }
  let restored = false;
  if (!migrated && !list.length) restored = db ? await restoreFromDb() : await restoreFromLocal();
  // прежний документ не открылся — человек решает его судьбу; проект заведём после решения
  if (state.saveBlocked) return false;
  if (migrated || list.length) { state.doc = createDoc('empty'); state.geo = solveKept(state.doc); state.history = []; state.cursor = 0; state.chat = []; state.pairs = []; }
  const name = migrated || list.length ? SHELL.freshSoloName(store.list()) : docName(state.doc);
  const entry = await store.create({ name, payload: savePayload() });
  try { const ls = lsOrNull(); if (ls) ls.setItem(SOLO_MIGRATED_KEY, entry.id); } catch { /* метка не легла — индекс всё равно не пуст */ }
  solo.current = entry.id;
  solo.base = entry.updated_at;
  store.setCurrent(entry.id);
  state.doc = { ...state.doc, meta: { ...state.doc.meta, name: entry.name } };
  setDocNameText(docTitle());
  renderAll();
  return restored;
}

/** Плашка о хранилище: в памяти — «не сохраняются», в localStorage — «места мало». Один раз. */
function soloStorageNotice() {
  if (!solo || solo.noticeShown) return;
  const w = solo.store.warn;
  if (!w) return;
  solo.noticeShown = true;
  if (w === 'memory') {
    showMsg('warn', 'Проекты не сохраняются в этом браузере', {
      note: 'Хранилище браузера закрыто для этой страницы (приватный режим или запрет сайтам хранить данные). Работа живёт, пока открыта вкладка, — сохраняйте её экспортом в JSON.',
      role: 'solo-storage',
      actions: [{ label: 'Экспорт', primary: true, onClick: () => openExport() }],
    });
  } else if (w === 'local') {
    toast('Проекты хранятся в памяти браузера без IndexedDB — места мало (около 5 МБ на все). Большие проекты сохраняйте экспортом.', 'plain', 10000);
  }
}

/** Сохранить открытый проект сейчас — перед уходом к другому. false — не сохранился (сказано). */
async function flushSoloSave() {
  if (!solo || !solo.current) return true;
  // вид и активная доска — в индексе, без записи тела
  try { solo.store.setView(solo.current, viewSnapshot(), activeArtboardId()); } catch { /* вид не важнее работы */ }
  if (!state.dirty) return true;
  clearTimeout(saveTimer);
  for (let i = 0; i < 20 && saveFlight; i++) await new Promise((r) => setTimeout(r, 50));
  await saveNow();
  return !state.dirty;
}

function viewSnapshot() {
  if (!stage || !viewIsSane(stage.view)) return null;
  return { zoom: stage.view.zoom, pan: { x: stage.view.pan.x, y: stage.view.pan.y } };
}

/**
 * Прочитать проект и сделать его открытым: документ, история, разговор, выделение этой сессии,
 * вид из индекса. Ничего не пишет. false — тело не прочиталось (сказано словами).
 */
async function loadSoloProject(id, { first = false } = {}) {
  const store = solo.store;
  const entry = store.entry(id);
  let payload = null;
  try { payload = await store.read(id); } catch { payload = null; }
  if (!entry || !payload || !payload.doc) {
    if (!first) toast(`Проект «${clip((entry && entry.name) || 'без имени', 40)}» не прочитался из хранилища браузера.`, 'error', 9000);
    return false;
  }
  let taken = null;
  try { taken = adoptDoc(payload.doc); } catch (e) {
    toast(`Проект «${clip(entry.name, 40)}» не открылся: ${afterColon(humanError(e))}`, 'error', 9000);
    return false;
  }
  const sess = solo.sessions.get(id) || {};
  state.doc = { ...taken.doc, meta: { ...(taken.doc.meta || {}), name: entry.name } };
  state.geo = taken.geo;
  // с ухода проект не менялся (та же запись) — история и разговор этой сессии целиком
  const same = !!(sess.history && sess.at && sess.at === entry.updated_at);
  if (same) {
    state.chat = sess.chat;
    state.pairs = sess.pairs;
    state.history = sess.history;
    state.cursor = sess.cursor;
  } else {
    state.chat = sanitizeChat(payload.chat);
    state.pairs = sanitizePairs(payload.pairs);
    const past = sanitizeHistory(payload.history, payload.cursor);
    state.history = past.list;
    state.cursor = past.cursor;
  }
  state.collapsed = Array.isArray(payload.collapsed) && payload.collapsed.length ? new Set(payload.collapsed.filter((x) => typeof x === 'string')) : null;
  state.selection = (sess.selection || []).filter((x) => state.doc.nodes[x]);
  // активная доска из индекса (после перезагрузки выделения нет): не первая — выделяем её, как вкладка
  if (!state.selection.length && entry.board && state.doc.nodes[entry.board]) {
    const boards = artboards(state.doc);
    if (boards.length > 1 && boards[0].id !== entry.board && boards.some((b) => b.id === entry.board)) state.selection = [entry.board];
  }
  state.awaitingClarify = null;
  state.lastFit = null;
  state.issues = new Map();
  state.dirty = false;
  state.docRev += 1;
  state.saveBlocked = null;
  solo.current = id;
  solo.base = entry.updated_at || null;
  solo.conflict = null;
  store.setCurrent(id);
  hideVariants();
  setDocNameText(docTitle());
  renderAll();
  // вид проекта — из индекса; нет — вписать
  if (entry.view && viewIsSane(entry.view)) {
    withView(() => applyView(entry.view));
    state.userView = true;
    rememberView();
    updateZoomLabel(stage.view);
  } else fitSmart();
  refreshSheet();
  if (taken.lost) showMsg('warn', 'Проект открыт не полностью', { note: `${taken.lost} ${plural(taken.lost, 'слой', 'слоя', 'слоёв')} прочитать не удалось.` });
  return true;
}

/**
 * Открыть другой проект: команда агента, идущая сейчас, к нему не относится — останавливаем
 * (её правка не ляжет в чужой документ), открытый проект сохраняем до ухода.
 */
async function openSoloProject(id, { quiet = false } = {}) {
  if (!solo || !id) return false;
  if (id === solo.current) return true;
  if (solo.switching) return false;
  solo.switching = true;
  try {
    const stopped = state.running ? state.lastUtterance : '';
    if (state.running) stopAgent();
    if (state.queue.length) state.queue = [];
    // прогон дожидаемся до конца: его правка и слова не должны лечь в другой проект
    for (let i = 0; i < 80 && state.running; i++) await new Promise((r) => setTimeout(r, 50));
    if (state.running) {
      showMsg('warn', 'Агент ещё заканчивает команду', {
        note: 'Другой проект открою, когда он остановится, — иначе его правка легла бы не туда. Попробуйте через пару секунд.',
        ms: 8000,
      });
      return false;
    }
    if (!(await flushSoloSave())) {
      if (!solo.conflict) {
        showMsg('error', 'Проект не сохранился — другой не открываю', {
          note: 'Иначе правки этого проекта пропали бы. Сохраните его экспортом в JSON и попробуйте снова.',
          actions: [{ label: 'Экспорт', primary: true, onClick: () => openExport() }],
        });
      }
      return false;
    }
    // сессия проекта: выделение, а ещё полная история и разговор (в теле они урезаны пределом)
    if (solo.current) {
      solo.sessions.set(solo.current, {
        selection: state.selection.slice(), history: state.history, cursor: state.cursor,
        chat: state.chat, pairs: state.pairs, at: solo.base,
      });
    }
    hideMsg();
    const ok = await loadSoloProject(id);
    if (ok && stopped && !quiet) {
      restoreCommand(stopped);
      toast(`Команда «${clip(stopped, 50)}» остановлена: открыт другой проект. Текст остался в строке.`, 'plain', 8000);
    }
    return ok;
  } finally { solo.switching = false; }
}

/** Новый проект: пустой документ, имя «Новый проект» (или своё). */
async function newSoloProject(name = '') {
  if (!solo) return false;
  const doc = createDoc('empty');
  const nm = cutText(cleanText(name), 120) || SHELL.freshSoloName(solo.store.list());
  let entry;
  try { entry = await solo.store.create({ name: nm, payload: { doc, chat: [], pairs: [], history: [], cursor: 0, savedAt: Date.now() } }); }
  catch (e) { toast(`Проект не создался: ${afterColon(humanError(e))}`, 'error', 9000); return false; }
  const ok = await openSoloProject(entry.id);
  if (ok) toast(`Открыт новый проект «${clip(entry.name, 50)}» — имя правится в шапке.`, 'plain', 6000);
  if (state.sheetOpen === 'projects') redrawSoloProjects();
  return ok;
}

async function renameSoloProject(id, name) {
  const nm = cutText(cleanText(name), 120);
  if (!solo || !nm) return null;
  if (id === solo.current) {
    state.doc = { ...state.doc, meta: { ...state.doc.meta, name: nm } };
    setDocNameText(docTitle());
    scheduleSave();
  }
  let e = null;
  try { e = await solo.store.rename(id, nm); } catch (err) { toast(`Имя не сохранилось: ${afterColon(humanError(err))}`, 'error', 8000); }
  if (state.sheetOpen === 'projects') redrawSoloProjects();
  return e;
}

async function duplicateSoloProject(id = solo && solo.current) {
  if (!solo || !id) return null;
  if (id === solo.current && !(await flushSoloSave())) return null;
  let e = null;
  try { e = await solo.store.duplicate(id); } catch (err) { toast(`Копия не сохранилась: ${afterColon(humanError(err))}`, 'error', 9000); return null; }
  if (!e) return null;
  if (state.sheetOpen === 'projects') redrawSoloProjects();
  toastAction(`Сделал копию «${clip(e.name, 50)}»`, 'Открыть', () => openSoloProject(e.id).then(() => closeSheet()), 8000);
  return e;
}

/**
 * Удалить проект; тело держим до закрытия тоста «Вернуть» (и до перезагрузки). Удалили
 * открытый — открываем самый свежий из оставшихся, а если их нет — новый пустой.
 */
async function deleteSoloProject(id) {
  if (!solo) return;
  const wasCurrent = id === solo.current;
  if (wasCurrent) { clearTimeout(saveTimer); state.dirty = false; }
  let tomb = null;
  try { tomb = await solo.store.remove(id); } catch (e) { toast(`Не удалилось: ${afterColon(humanError(e))}`, 'error', 8000); return; }
  if (!tomb) return;
  // открытого больше нет: его тело в надгробии — свежее того, что в памяти, не бывает (правки сохранены выше)
  if (wasCurrent) {
    if (tomb.payload && state.doc) tomb.payload = { ...tomb.payload, ...savePayload() };
    solo.current = null;
    const rest = solo.store.list();
    if (rest.length) await loadSoloProject(rest[0].id);
    else await newSoloProject();
  }
  solo.tombs.set(id, tomb);
  if (state.sheetOpen === 'projects') redrawSoloProjects();
  const t = toastAction(`Удалил «${clip(tomb.entry.name, 50)}»`, 'Вернуть', async () => {
    const back = solo.tombs.get(id);
    if (!back) return;
    solo.tombs.delete(id);
    try { await solo.store.restore(back); } catch (e) { toast(`Не вернулся: ${afterColon(humanError(e))}`, 'error', 8000); return; }
    toast(`Вернул «${clip(back.entry.name, 50)}»`, 'plain', 4000);
    if (state.sheetOpen === 'projects') redrawSoloProjects();
  }, 10000);
  // тост закрылся — надгробие больше не нужно
  setTimeout(() => { if (!t.isConnected) solo.tombs.delete(id); }, 10500);
}

/** Тост с одной кнопкой («Вернуть», «Открыть»). */
function toastAction(text, label, onClick, ms = 8000) {
  const t = toast(text, 'plain', ms);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 't-action';
  b.textContent = label;
  b.addEventListener('click', () => { t.remove(); onClick(); });
  t.appendChild(b);
  return t;
}

/** Другая вкладка: список поменялся или открытый проект сохранён там новее. */
function onSoloRemote(msg) {
  if (!solo || !msg) return;
  if (state.sheetOpen === 'projects') redrawSoloProjects();
  if (msg.type === 'saved' && msg.id === solo.current && msg.updated_at && (!solo.base || msg.updated_at > solo.base)) {
    // здесь несохранённых правок нет — просто берём свежую версию; есть — решает человек
    if (!state.dirty && !state.running && !solo.switching) { reloadSoloFresh(); return; }
    soloConflict();
    return;
  }
  // имя открытого проекта поменяли в другой вкладке — шапка и документ узнают его сразу
  const e = solo.current ? solo.store.entry(solo.current) : null;
  if (e && e.name && state.doc && e.name !== ((state.doc.meta || {}).name || '')) {
    state.doc = { ...state.doc, meta: { ...state.doc.meta, name: e.name } };
    if (document.activeElement !== dom.docname) setDocNameText(docTitle());
  }
  // открытый проект удалили в другой вкладке — здесь он цел, и сохранение вернёт его в список
  if (msg.type === 'list' && solo.current && !solo.store.entry(solo.current)) {
    toast('Этот проект удалили в другой вкладке. Здесь он открыт — первая же правка вернёт его в список.', 'plain', 9000);
  }
}

/** Другая вкладка сохранила открытый проект, здесь правок нет: открыть её версию тихо. */
async function reloadSoloFresh() {
  const id = solo.current;
  solo.sessions.set(id, { selection: state.selection.slice() });
  const view = viewSnapshot();
  if (!(await loadSoloProject(id))) return;
  // вид этой вкладки — её: человек смотрел сюда, прыгать нечему
  if (view) { withView(() => applyView(view)); state.userView = true; rememberView(); updateZoomLabel(stage.view); }
  toast('Проект обновлён: его сохранили в другой вкладке.', 'plain', 4000);
}

/** Проект сохранён в другой вкладке позже: молча не затираем — решает человек. */
function soloConflict() {
  if (!solo || solo.conflict) return;
  solo.conflict = { at: Date.now() };
  showMsg('warn', 'Проект изменён в другой вкладке', {
    note: 'Там его сохранили позже, чем здесь. Пока вы не решите, эта вкладка его не сохраняет.',
    role: 'solo-conflict',
    actions: [
      { label: 'Открыть свежую версию', primary: true, onClick: async () => {
        const id = solo.current;
        solo.conflict = null;
        state.dirty = false;
        clearTimeout(saveTimer);
        hideMsg();
        solo.current = null;
        await loadSoloProject(id);
        toast('Открыта свежая версия проекта.', 'plain', 4000);
      } },
      { label: 'Оставить мою', onClick: async () => {
        solo.conflict = null;
        hideMsg();
        state.dirty = true;
        let r = null;
        try { r = await solo.store.write(solo.current, savePayload(), { force: true }); } catch { r = null; }
        if (r && r.ok) { solo.base = r.entry.updated_at; state.dirty = false; toast('Оставил версию этой вкладки — она сохранена.', 'plain', 5000); }
        else toast('Не сохранилось — попробуйте ещё раз или сохраните экспортом.', 'error', 8000);
      } },
    ],
  });
}

/** Шторка «Проекты» соло-режима: тот же вид, что у серверной. query — отбор по имени. */
function openSoloProjects({ query = '' } = {}) {
  if (!solo) return;
  solo.query = query;
  openSheet('Проекты', fillSoloProjects, { size: 'auto', key: 'projects' });
}

function redrawSoloProjects() {
  if (!solo || state.sheetOpen !== 'projects') return;
  const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.role : '';
  openSheet('Проекты', fillSoloProjects, { size: 'auto', key: 'projects' });
  if (focus === 'projects-search') {
    const q = dom['sheet-body'] && dom['sheet-body'].querySelector('[data-role="projects-search"]');
    if (q) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch { /* поле без выделения */ } }
  }
}

function fillSoloProjects(body) {
  const store = solo.store;
  const all = store.list();
  const warn = store.warn;
  if (warn === 'memory' || warn === 'local') {
    const n = document.createElement('div');
    n.className = 'note';
    n.dataset.role = 'solo-storage';
    n.textContent = warn === 'memory'
      ? 'Проекты не сохраняются в этом браузере: хранилище закрыто для страницы. Работа живёт, пока открыта вкладка, — сохраняйте её экспортом.'
      : 'Проекты хранятся без IndexedDB — места мало (около 5 МБ на все). Большие сохраняйте экспортом.';
    body.appendChild(n);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn subtle wide';
  // как в серверной шторке (круг 29, п.7): кнопка — действием, новый проект — «Новый проект N»
  add.textContent = 'Создать проект';
  add.addEventListener('click', async () => {
    add.disabled = true;
    if (await newSoloProject()) closeSheet();
    else add.disabled = false;
  });
  body.appendChild(add);
  // поиск — когда проектов больше восьми (или пришли с отбором по имени)
  let list = all;
  if (all.length > 8 || solo.query) {
    const q = document.createElement('input');
    q.className = 'field';
    q.type = 'search';
    q.dataset.role = 'projects-search';
    q.placeholder = 'Найти проект по имени';
    q.setAttribute('aria-label', 'Найти проект по имени');
    q.value = solo.query || '';
    q.addEventListener('input', () => { solo.query = q.value; redrawSoloProjects(); });
    body.appendChild(q);
    list = SHELL.filterSoloProjects(all, solo.query || '');
  }
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty-note';
    p.textContent = all.length ? 'Проектов с таким именем нет.' : 'Проектов пока нет.';
    body.appendChild(p);
    return;
  }
  for (const p of list) body.appendChild(soloProjectItem(p));
}

function soloProjectItem(p) {
  const current = solo.current;
  const item = document.createElement('div');
  item.className = 'pitem';
  item.dataset.current = String(p.id === current);
  item.dataset.id = p.id;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'pname';
  open.textContent = p.name || 'Без названия';
  open.title = p.id === current ? 'Открыт сейчас' : 'Открыть проект';
  open.addEventListener('click', async () => {
    if (p.id === current) { closeSheet(); return; }
    if (await openSoloProject(p.id)) closeSheet();
  });
  const meta = document.createElement('span');
  meta.className = 'pwhen';
  meta.textContent = [p.id === current ? 'открыт' : '', SHELL.soloMetaLine(p, whenWords(p.updated_at || p.created_at))].filter(Boolean).join(' · ');
  const mk = (label, fn, cls = 'btn ghost small') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  const rename = mk('Переименовать', () => {
    const input = document.createElement('input');
    input.className = 'field pname-edit';
    input.value = p.name || '';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Новое имя проекта');
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = cutText(cleanText(input.value), 120);
      if (save && name && name !== p.name) await renameSoloProject(p.id, name);
      else redrawSoloProjects();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    open.replaceWith(input);
    input.focus();
    input.select();
  });
  const dup = mk('Дублировать', () => duplicateSoloProject(p.id));
  const del = mk('Удалить', () => {
    // подтверждение — здесь же, в строке: confirm() в артефакте не работает
    const ask = document.createElement('div');
    ask.className = 'pconfirm';
    ask.setAttribute('role', 'group');
    ask.setAttribute('aria-label', 'Подтверждение удаления');
    const q = document.createElement('span');
    q.textContent = `Удалить «${clip(p.name || 'Без названия', 40)}»? Вернуть можно будет из тоста.`;
    const yes = mk('Удалить', async () => { yes.disabled = true; await deleteSoloProject(p.id); }, 'btn danger small');
    const no = mk('Оставить', () => { ask.remove(); acts.hidden = false; del.focus(); });
    ask.append(q, yes, no);
    acts.hidden = true;
    item.appendChild(ask);
    no.focus();
  });
  const head = document.createElement('div');
  head.className = 'phead';
  head.append(open);
  const acts = document.createElement('div');
  acts.className = 'pacts';
  acts.append(rename, dup, del);
  item.append(head, meta, acts);
  return item;
}

/** «Открыть проект «…»» словами: один — открываем, несколько — шторка с отбором, нет — слова. */
async function openProjectByName(name) {
  if (server) {
    if (!server.list || !server.list.length) { try { const page = await fetchProjectsPage(); server.list = page.projects; server.listNext = page.next; } catch { /* шторка скажет сама */ } }
    const f = SHELL.findSoloProject(server.list || [], name);
    if (f.one) { if (!server.project || f.one.id !== server.project.id) openProject(f.one); toast(`Открыт проект «${clip(f.one.name, 50)}»`, 'plain', 4000); return; }
    openProjects();
    if (!f.many.length) showMsg('plain', `Проекта «${clip(name, 40)}» нет`, { note: 'Вот все проекты — выберите в списке.', ms: 7000 });
    return;
  }
  if (!solo) return;
  const f = SHELL.findSoloProject(solo.store.list(), name);
  if (f.one) {
    if (f.one.id === solo.current) { toast(`Проект «${clip(f.one.name, 50)}» уже открыт`, 'plain', 4000); return; }
    if (await openSoloProject(f.one.id)) toast(`Открыт проект «${clip(f.one.name, 50)}»`, 'plain', 4000);
    return;
  }
  if (f.many.length) { openSoloProjects({ query: name }); return; }
  openSoloProjects();
  showMsg('plain', `Проекта «${clip(name, 40)}» нет`, { note: 'Вот все проекты — выберите в списке или создайте новый.', ms: 7000 });
}

/** Команды таблицы о проектах — на сервере и без него. true — разобрано. */
async function applyProjectCommand(intent) {
  switch (intent.kind) {
    case 'projects':
      if (server) openProjects(); else openSoloProjects();
      return true;
    case 'project-new':
      if (server) {
        try {
          const p = await createProject(intent.name || freshProjectName(server.list));
          openProject(p);
          toast(`Открыт новый проект «${clip(p.name || '', 50)}» — имя правится в шапке.`, 'plain', 6000);
        } catch (e) { toast(`Проект не создался: ${afterColon(humanError(e))}`, 'error', 8000); }
      } else await newSoloProject(intent.name || '');
      return true;
    case 'project-open':
      await openProjectByName(intent.name);
      return true;
    case 'project-rename':
      if (server) { renameProject(intent.name); setDocNameText(cutText(cleanText(intent.name), 120)); }
      else if (solo && solo.current) await renameSoloProject(solo.current, intent.name);
      toast(`Проект называется «${clip(cleanText(intent.name), 50)}»`, 'plain', 4000);
      return true;
    case 'project-duplicate':
      if (server) await duplicateServerProject();
      else await duplicateSoloProject();
      return true;
    default: return false;
  }
}

/** Копия проекта на сервере: новый проект с нынешним документом одним запросом. */
async function duplicateServerProject() {
  const view = server && server.sync && server.sync.view;
  if (!view) { toast('Копировать нечего: проект ещё не открыт.', 'error', 6000); return; }
  const name = SHELL.copySoloName(server.list || [], docTitle());
  let plan;
  try { plan = SHELL.rescuePlan(view, { name }); } catch { plan = null; }
  if (!plan || !plan.whole) { toast('Проект слишком большой для копии одним запросом — сохраните его экспортом и импортируйте.', 'error', 9000); return; }
  try {
    const p = await apiJson('/api/projects', { method: 'POST', body: plan.body });
    toastAction(`Сделал копию «${clip(p.name || name, 50)}»`, 'Открыть', () => openProject(p), 8000);
  } catch (e) { toast(`Копия не создалась: ${SHELL.rescueFailWords(e)}.`, 'error', 9000); }
}

/** Импорт в соло-режиме: файл становится новым проектом, открытый остаётся как был. */
async function importAsSoloProject(taken, fileName) {
  const name = cutText(cleanText(docName(taken.doc)), 120) || cutText(cleanText(String(fileName || '').replace(/\.json$/i, '')), 120) || SHELL.freshSoloName(solo.store.list());
  const was = docName(state.doc);
  let entry;
  try {
    entry = await solo.store.create({ name: SHELL.freshSoloName(solo.store.list(), name), payload: { doc: taken.doc, chat: [], pairs: [], history: [], cursor: 0, savedAt: Date.now() } });
  } catch (e) { showMsg('error', 'Файл не загрузился', { note: `Хранилище браузера не приняло его: ${afterColon(humanError(e))}` }); return; }
  closeSheet();
  if (!(await openSoloProject(entry.id))) return;
  const bits = [`слоёв: ${Object.keys(taken.doc.nodes).length}`, `прежний «${clip(was, 40)}» — в «Проектах»`];
  if (taken.lost) bits.push(`не прочитал ${taken.lost} ${plural(taken.lost, 'слой', 'слоя', 'слоёв')}`);
  showMsg(taken.lost ? 'warn' : 'result', `Загрузил «${clip(entry.name, 50)}» новым проектом`, {
    note: bits.join(' · '),
    actions: [{ label: 'Проекты', onClick: () => openSoloProjects() }],
  });
}

/* -------------------------------- сохранение --------------------------------- */

function scheduleSave() {
  /* Круг 22: в серверном режиме документ живёт в реплике и её журнале; в db/localStorage
     не пишем ничего. Оболочке остаётся пометить журнал: история и разговор лежат рядом
     с документом (journalExtra), и реплика перепишет их вместе со своим состоянием. */
  if (server) { if (server.sync) server.sync.touch(); return; }
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
  // круг 46: открыт проект соло-режима — пишем в хранилище проектов, прежние ключи не трогаем
  if (solo && solo.current) { await saveSoloNow(payload, done); return; }
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
  // круг 22: журнал реплики дописывается сейчас, не дожидаясь паузы в 200 мс
  if (server) { if (server.sync) server.sync.flush(); return; }
  if (solo && solo.current) {
    try { solo.store.setView(solo.current, viewSnapshot(), activeArtboardId()); } catch { /* вид не важнее работы */ }
    if (!state.dirty || state.saveBlocked || solo.conflict) return;
    clearTimeout(saveTimer);
    try { solo.store.saveOnExit(solo.current, savePayload()); } catch { /* места нет — осталась последняя запись */ }
    return;
  }
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

/**
 * Запись открытого проекта соло-режима. Проект сохранили в другой вкладке позже нашей
 * последней записи — молча не затираем: плашка «Проект изменён в другой вкладке».
 */
async function saveSoloNow(payload, done) {
  if (solo.conflict) {
    // плашку закрыли крестиком, не решив: правка не сохраняется — напоминаем той же плашкой
    if (!dom.dockmsg || dom.dockmsg.hidden || dom.dockmsg.dataset.role !== 'solo-conflict') { solo.conflict = null; soloConflict(); }
    return;
  }
  saveFlight = true;
  let r = null;
  let err = null;
  try { r = await solo.store.write(solo.current, payload, { base: solo.base }); }
  catch (e) { err = e; }
  finally { saveFlight = false; }
  if (r && r.conflict) { soloConflict(); return; }
  if (r && r.ok) {
    solo.base = r.entry.updated_at;
    solo.failWarned = false;
    done();
    if (r.big && !solo.bigWarned) {
      solo.bigWarned = true;
      toast('Проект большой для памяти браузера без IndexedDB — сохраните его экспортом, чтобы не потерять.', 'plain', 10000);
    }
    if (state.sheetOpen === 'projects') redrawSoloProjects();
    return;
  }
  state.dirty = true;
  if (!solo.failWarned) {
    solo.failWarned = true;
    showMsg('error', 'Проект не сохраняется', {
      note: `Хранилище браузера не приняло запись${err ? `: ${afterColon(humanError(err))}` : ''}. Сохраните проект файлом — он не пропадёт.`,
      actions: [{ label: 'Экспорт', primary: true, onClick: openExport }],
    });
  }
}

/** Прежний документ не открылся, человек выбрал «Начать заново»: нынешний — первым проектом. */
async function startSoloAfterBlock() {
  try {
    const entry = await solo.store.create({ name: docName(state.doc) || SHELL.freshSoloName(solo.store.list()), payload: savePayload() });
    try { const ls = lsOrNull(); if (ls) ls.setItem(SOLO_MIGRATED_KEY, entry.id); } catch { /* метка не легла */ }
    solo.current = entry.id;
    solo.base = entry.updated_at;
    solo.store.setCurrent(entry.id);
  } catch { /* хранилище не приняло — скажет первая запись */ }
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
      note: `${taken.lost} ${plural(taken.lost, 'слой', 'слоя', 'слоёв')} из сохранённой копии прочитать не удалось.`,
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
          // круг 46: проектов ещё нет — нынешний документ становится первым, прежняя копия цела
          if (solo && !solo.current) startSoloAfterBlock();
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
    .map((p) => ({ utterance: cutText(p.utterance, 500), summary: cutText(p.summary || '', 500) }));
}

/* -------------------------------- настройки ---------------------------------- */

/** Круг 50 (SPEC §17.2): настройки живого дизайна — ключ в settings и слова. */
const AGENT_SETTING = {
  direction: { key: 'artDirection', title: 'Арт-направление', onWord: 'включено', offWord: 'выключено', slash: '/образ',
    onSay: 'Новые экраны — снова с образом: палитра и мотивы под предмет (если сервис агента его не выключил).', offSay: 'Новые экраны собираю без образа — в оформлении документа.' },
  critic: { key: 'artCritic', title: 'Самопроверка', onWord: 'включена', offWord: 'выключена', slash: '/самопроверка',
    onSay: 'После сборки смотрю на экран и дорабатываю шаблонное (если сервис агента её не выключил).', offSay: 'Собранный экран больше не проверяю — быстрее, но шаблонное останется.' },
  webFonts: { key: 'webFonts', title: 'Шрифты из сети', onWord: 'включены', offWord: 'выключены', slash: '/шрифты из сети',
    onSay: 'Гарнитуры снова загружаются из Google Fonts.', offSay: 'Шрифты макета из сети больше не загружаю и не встраиваю в снимок и экспорт: макет — шрифтами системы, агент шрифтов не выбирает. Уже загруженные останутся до перезагрузки страницы.' },
};

/** Выключенное человеком — для brain в браузере и для сервера (только false). */
function agentArtOptions() {
  const out = {};
  if (settings.artDirection === false) out.direction = false;
  if (settings.artCritic === false) out.critic = false;
  if (settings.webFonts === false) out.webFonts = false;
  return out;
}

function setAgentSetting(what, on, { say = false } = {}) {
  const w = AGENT_SETTING[what];
  if (!w) return;
  const was = settings[w.key] !== false;
  settings[w.key] = !!on;
  saveSettings();
  if (what === 'webFonts') {
    if (stage && stage.opts) stage.opts.embedFonts = !!on;
    if (on) { docFontsDoc = null; ensureDocFonts(state.doc); }
  }
  // это настройка, а не разовая просьба — так и говорим
  const keep = ` Это настройка — действует, пока не ${on ? 'выключите' : 'включите'}: ${w.slash} ${on ? 'выкл' : 'вкл'}.`;
  if (say) showMsg('result', was === !!on ? `${w.title} и так ${on ? w.onWord : w.offWord}` : `${w.title} ${on ? w.onWord : w.offWord}`, { note: (on ? w.onSay : w.offSay) + keep, ms: 9000 });
}

function loadSettings() {
  // локальная сборка кладёт свои значения по умолчанию в window.IMAGO_DEFAULTS
  const dflt = (typeof globalThis !== 'undefined' && globalThis.IMAGO_DEFAULTS) || {};
  const base = {
    // «как в системе» по умолчанию: человек со светлой системой получал тёмное
    // приложение при первом запуске (круг 9, п.13)
    theme: 'auto',
    rail: 'auto',
    railW: 0,             // круг 18, п.3: ручная ширина рельса, 0 — значение по умолчанию
    introSeen: false,
    voiceAlways: false,   // «слушать постоянно» — по выбору человека, не по умолчанию (п.9)
    author: '',           // круг 22: имя для других участников (серверный режим)
    // круг 50 (SPEC §17.2): арт-направление, самопроверка агента и шрифты из сети — выключаемы
    artDirection: true,
    artCritic: true,
    webFonts: true,
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
/** Объявленные ширины колонок {w, rail, insp, vars}: окно другой ширины — читаем заново. */
let panelWidths = null;

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
    /* Круг 27, п.8. Ширины колонок — из CSS, но getComputedStyle сразу после смены
       data-insp пересчитывал стили ВСЕГО документа (на 10 000 узлов — 70–90 мс на каждом
       выделении). Объявленные ширины зависят только от ширины окна и ручной ширины
       рельса — их и запоминаем, сбрасывая на resize и в applyRailWidth. */
    const w = globalThis.innerWidth || 0;
    if (!panelWidths || panelWidths.w !== w) {
      const cs = getComputedStyle(app);
      const read = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
      panelWidths = { w, rail: read('--rail-w'), insp: read('--insp-w'), vars: read('--vars-w') };
    }
    const px = (name) => ({ '--rail-w': panelWidths.rail, '--insp-w': panelWidths.insp, '--vars-w': panelWidths.vars })[name] || 0;
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
/* ---- ширина рельса: правая кромка — тяга (круг 18, п.3) ----------------------
   Пределы замерены на демо-документе (39 строк слоёв, вложенность до 4):
     140 px — режется уже имя самой доски («Маршрут дня»), рельс перестаёт называть
              то единственное, ради чего он открыт;
     152 px — обрезано 30 имён из 39, глубокие — больше чем наполовину;
     168 px — обрезано 28, но доски и первый уровень целы: это и есть разумный низ;
     208 px — прежняя жёсткая ширина, обрезано 13 из 39;
     280 px — не обрезано ни одного имени.
   Выше 280 читаемость уже не растёт, поэтому потолок 420 px — это запас на длинные
   имена и глубокую вложенность, а не бесконечная растяжка за счёт холста. Сверху
   ширину ещё раз ограничивает окно: холсту гарантирован CANVAS_MIN, иначе ручная
   ширина ломала бы бюджет колонок круга 16. */
const RAIL_MIN = 168;
const RAIL_MAX = 420;

function railLimit() {
  const w = globalThis.innerWidth || 0;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, w ? w - CANVAS_MIN : RAIL_MAX));
}

function railWidthNow() {
  const set = Number(settings.railW) || 0;
  return set ? Math.max(RAIL_MIN, Math.min(railLimit(), Math.round(set))) : 208;
}

/**
 * Ставит ширину рельса переменной --rail-w на .app. Именно переменной, а не свойством
 * .rail: по --rail-w syncPanelModes считает, сколько места рельс попросит, и весь
 * бюджет колонок круга 16 остаётся верным без единой правки в нём.
 */
function applyRailWidth(px, remember = false) {
  const set = Number(px) || 0;
  const w = set ? Math.max(RAIL_MIN, Math.min(railLimit(), Math.round(set))) : 0;
  if (w) dom.app.style.setProperty('--rail-w', `${w}px`);
  else dom.app.style.removeProperty('--rail-w');
  panelWidths = null;   // ширина рельса другая — колонки считаем заново (круг 27, п.8)
  const grip = dom['rail-grip'];
  if (grip) {
    grip.setAttribute('aria-valuenow', String(w || 208));
    grip.setAttribute('aria-valuemin', String(RAIL_MIN));
    grip.setAttribute('aria-valuemax', String(railLimit()));
    grip.setAttribute('aria-valuetext', `${w || 208} пикселей`);
  }
  if (remember) { settings.railW = w; saveSettings(); }
  syncPanelModes();        // рельс стал шире или уже — бюджет колонок изменился (круг 16, п.1)
  scheduleViewRecheck(240);
}

/** Тяга: мышью, пальцем и с клавиатуры — это орган управления, а не полоска. */
function initRailGrip() {
  const grip = dom['rail-grip'];
  if (!grip) return;
  let from = 0;
  let base = 0;

  const move = (e) => {
    applyRailWidth(base + (e.clientX - from));
  };
  const up = (e) => {
    grip.dataset.drag = '';
    globalThis.removeEventListener('pointermove', move);
    globalThis.removeEventListener('pointerup', up);
    try { grip.releasePointerCapture(e.pointerId); } catch { /* захвата и не было */ }
    applyRailWidth(base + (e.clientX - from), true);   // запоминаем только итог жеста
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    from = e.clientX;
    base = railWidthNow();
    grip.dataset.drag = 'on';
    grip.focus();
    try { grip.setPointerCapture(e.pointerId); } catch { /* без захвата тоже работает */ }
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  });
  // двойной щелчок по кромке — обратно к ширине по умолчанию
  grip.addEventListener('dblclick', () => { applyRailWidth(0, true); toast('Ширина панели слоёв сброшена', 'plain', 3000); });
  grip.addEventListener('keydown', (e) => {
    const cur = railWidthNow();
    let next = null;
    if (e.key === 'ArrowLeft') next = cur - (e.shiftKey ? 48 : 16);
    else if (e.key === 'ArrowRight') next = cur + (e.shiftKey ? 48 : 16);
    else if (e.key === 'Home') next = RAIL_MIN;
    else if (e.key === 'End') next = railLimit();
    else if (e.key === 'Enter' || e.key === ' ') next = 0;   // к значению по умолчанию
    else return;
    e.preventDefault();
    applyRailWidth(next, true);
  });
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

/* Прогонам в браузере (tools/smoke.mjs и проверка серверного режима) нужен взгляд внутрь:
   документ, история и реплика. Только чтение — оболочка этим сама не пользуется. */
Object.defineProperty(globalThis, '__imago', {
  value: { state, hashDoc: CORE.hashDoc, get sync() { return server ? server.sync : null; }, get server() { return server; } },
  enumerable: false, configurable: true,
});

/* Запуск — последней строкой: к этому моменту объявлены все константы модуля. */
boot();
