/**
 * Imago Studio — словарь оболочки (SPEC §7, §10; круги 23–24).
 *
 * Чистые функции без DOM:
 *   • словарь команд оболочки `shellIntent` — один на клиент (app.js) и сервер (JEV,
 *     server/orchestrator/jev): «отмени два раза», «впиши всё», «покажи второй экран»…;
 *     `shellEventOf`/`shellIntentFromServer` — перевод в событие `shell {action, args}` и обратно;
 *   • слова серверного агента: где он работает, как назвать стадию, ошибку, вариант.
 * Тесты: test/shell.test.mjs (словарь, одинаковый по обе стороны), test/agent.test.mjs.
 */

import {
  artboards, isArtboard, subtreeIds, placeholderName,
} from './core.js';
import { recognizeAction } from './brain.js';

/** Где выполняется команда агента — слова для строки состояния. */
export const AGENT_MODE_WORDS = Object.freeze({
  server: 'агент: сервер',
  browser: 'агент: в браузере',
  off: 'агент недоступен',
});

/**
 * Где работать агенту. На сервере — только когда проект открыт через Document service,
 * реплика в сети, `/agent/health` ответил и Orchestrator видит документ; модель у
 * сервера должна быть настроена. Иначе — прежний путь, brain в браузере, если у браузера
 * есть своя модель; без неё агент недоступен.
 *
 * @param {{inProject: boolean, online: boolean, health: object|null, hasProvider: boolean}} s
 * @returns {'server'|'browser'|'off'}
 */
export function decideAgentMode({ inProject = false, online = false, health = null, hasProvider = false } = {}) {
  const h = health && health.ok === true ? health : null;
  if (inProject && online && h && h.document === 'up') {
    if (h.llm === 'up') return 'server';
    // модель у сервера лежит: своя в браузере выручит; нет своей — пусть скажет сервер
    if (h.llm === 'down' && !hasProvider) return 'server';
  }
  return hasProvider ? 'browser' : 'off';
}

/** Подробности о режиме — для подсказки у строки состояния. */
export function agentModeTitle(mode, health, providerWords = '') {
  if (mode === 'server') {
    const model = health && health.model ? ` · модель ${health.model}` : '';
    const llm = health && health.llm === 'down' ? ' · модель серверу сейчас не отвечает' : '';
    return `Команды агента выполняет сервер${model}${llm}`;
  }
  if (mode === 'browser') {
    return `Команды агента выполняются в этом браузере${providerWords ? ` (${providerWords})` : ''}`;
  }
  return 'Агента нет: сервер агента не отвечает, а своей модели у браузера не настроено';
}

/** Стадии §10.3 словами человека — когда сервер не прислал свою подпись. */
export const STAGE_WORDS = Object.freeze({
  jev: 'Разбираю запрос',
  read: 'Читаю документ',
  library: 'Смотрю библиотеку компонентов',
  llm: 'Думаю над правкой',
  validate: 'Проверяю раскладку',
  repair: 'Исправляю найденное',
  write: 'Записываю правку',
});

/**
 * Событие `stage` → запись для ленты стадий оболочки. Имя стадии помечено `srv:` —
 * у brain в браузере свои стадии и своя разметка шагов, и путать их нельзя.
 */
export function serverStageRec(data = {}) {
  const key = typeof data.key === 'string' ? data.key : '';
  const label = String(data.label || STAGE_WORDS[key] || 'Агент работает').trim();
  const rec = { stage: `srv:${key || 'stage'}`, label };
  if (data.variant != null) rec.variant = data.variant;
  if (data.detail) rec.detail = String(data.detail);
  return rec;
}

/** Событие `queued` словами. */
export function queuedLabel(position) {
  const n = Number(position);
  if (!Number.isFinite(n) || n <= 0) return 'В очереди проекта';
  return `В очереди проекта: впереди ${n} ${plural(n, 'команда', 'команды', 'команд')}`;
}

/** Повтор по Retry-After словами. */
export function retryLabel(waitMs) {
  const s = Math.max(1, Math.round((Number(waitMs) || 0) / 1000));
  return `Сервер агента занят — повторю через ${s} с`;
}

/**
 * Команда оболочки, которую узнал JEV (`shell {action, args}`) → намерение в терминах
 * оболочки (те же `kind`, что у её словаря). Неизвестное — null: оболочка попробует
 * свой словарь и, если и он молчит, скажет об этом.
 */
export function shellIntentFromServer(shell) {
  if (!shell || typeof shell !== 'object') return null;
  const action = String(shell.action || '').trim().toLowerCase().replace(/_/g, '-');
  const a = shell.args && typeof shell.args === 'object' ? shell.args : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  switch (action) {
    case 'undo':
    case 'redo':
      return { kind: action, times: Math.max(1, Math.min(20, num(a.times ?? a.count ?? a.n) || 1)) };
    case 'stop':
      return { kind: 'stop' };
    case 'select':
    case 'selection': {
      const ids = Array.isArray(a.ids) ? a.ids : Array.isArray(a.select) ? a.select : (a.id ? [a.id] : []);
      return { kind: 'select', ids: ids.filter((x) => typeof x === 'string'), ...(a.name ? { name: String(a.name) } : {}) };
    }
    case 'deselect':
    case 'clear-selection':
      return { kind: 'select', ids: [] };
    case 'zoom': {
      const to = num(a.to ?? a.zoom ?? a.value);
      const by = num(a.by);
      return { kind: 'zoom', ...(to ? { to: to > 10 ? to / 100 : to } : {}), ...(by ? { by } : {}) };
    }
    case 'fit':
      // «вписать» без уточнения — по-умному: поля all нет вовсе, как у словаря оболочки
      return a.all == null ? { kind: 'fit' } : { kind: 'fit', all: !!a.all };
    case 'artboard':
    case 'board': {
      const out = { kind: 'artboard' };
      if (typeof (a.id ?? a.board) === 'string') out.id = a.id ?? a.board;
      if (num(a.index) !== undefined) out.index = num(a.index);
      if (num(a.step) !== undefined) out.step = num(a.step);
      if (Array.isArray(a.list)) out.list = a.list;
      return out;
    }
    case 'new-board':
    case 'new-artboard':
      return { kind: 'new-board' };
    case 'export':
      // what: '' — «экспорт» без формата: открыть окно экспорта
      if (typeof a.what === 'string' || typeof a.format === 'string') return { kind: 'export', what: String(a.what ?? a.format).toLowerCase() };
      return { kind: 'export' };
    case 'sheet':
    case 'history':
    case 'settings': {
      const what = action === 'sheet' ? (a.what || 'history') : action;
      return { kind: 'sheet', what, ...(a.tab ? { tab: String(a.tab) } : {}) };
    }
    case 'rail':
    case 'layers':
      return { kind: 'rail', on: a.on == null ? true : !!a.on };
    case 'theme':
      return { kind: 'theme', mode: ['dark', 'light', 'auto', 'cycle', 'ask'].includes(a.mode) ? a.mode : 'cycle' };
    case 'variants-close':
      return { kind: 'variants-close' };
    case 'variants':
      // args.of — к какой команде считать варианты («а по-другому» после прошлой)
      return {
        kind: 'variants',
        ...(num(a.n) ? { n: num(a.n) } : {}),
        ...(a.of ? { of: String(a.of) } : {}),
        ...(a.subject ? { subject: String(a.subject) } : {}),
      };
    default:
      return null;
  }
}

/** Ошибки сервера агента словами: заголовок и что делать (§10.2). */
const ERROR_WORDS = {
  busy: ['Агент на сервере занят командами этого проекта', 'Повторите чуть позже.'],
  llm_down: ['Модель недоступна серверу агента', 'Проверьте, что LM Studio запущена и в ней включён сервер (Developer → Start Server).'],
  llm_failed: ['Модель ответила ошибкой', 'Попробуйте ещё раз или скажите иначе.'],
  document_down: ['Сервер агента не достучался до документа', 'Повторите через несколько секунд.'],
  too_large: ['Команда слишком большая для сервера агента', 'Скажите короче или выделите узел поменьше.'],
  bad_request: ['Сервер агента не понял команду', 'Обновите страницу: версия клиента могла устареть.'],
  not_found: ['Проекта нет на сервере агента', 'Откройте проект заново.'],
  upstream_down: ['Сервер агента недоступен', 'Проверьте, что запущен контейнер orchestrator.'],
  upstream_timeout: ['Сервер агента не ответил вовремя', 'Повторите команду.'],
  network: ['Сервер агента недоступен', 'Проверьте связь и повторите.'],
  timeout: ['Сервер агента не ответил вовремя', 'Повторите команду.'],
  bad_response: ['Сервер агента прислал непонятный ответ', 'Повторите команду.'],
};

/**
 * @param {{code?: string, message?: string, retryAfterMs?: number|null}} err
 * @returns {{title: string, note: string}}
 */
export function agentErrorWords(err) {
  const e = err || {};
  const [title, hint] = ERROR_WORDS[e.code] || [String(e.message || 'Агент на сервере не справился'), ''];
  const own = String(e.message || '').trim();
  const bits = [];
  if (own && own !== title && ERROR_WORDS[e.code]) bits.push(own.replace(/\s*[.:;]\s*$/, ''));
  if (Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0) {
    bits.push(`повторить можно через ${Math.max(1, Math.round(e.retryAfterMs / 1000))} с`);
  } else if (hint) bits.push(hint.replace(/\s*[.]\s*$/, ''));
  return { title, note: bits.join(' · ') };
}

/** Ошибка модели: тут может выручить своя модель браузера. */
export function isModelError(err) {
  return !!(err && (err.code === 'llm_down' || err.code === 'llm_failed'));
}

/** Сколько символов реплики и итога уходит в память разговора (§10.5, MAX_HISTORY_CHARS). */
export const HISTORY_PAIRS = 5;
export const HISTORY_CHARS = 500;

/**
 * Память разговора для `/agent/command` (§10.5 `history`): последние пять пар
 * `{utterance, summary}`, строки не длиннее 500 символов. Пары без реплики не нужны
 * планировщику — выбрасываются.
 * @param {{utterance?: string, summary?: string}[]} pairs
 */
export function historyForServer(pairs) {
  const cut = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t.length > HISTORY_CHARS ? `${t.slice(0, HISTORY_CHARS - 1)}…` : t;
  };
  return (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && typeof p === 'object' && String(p.utterance || '').trim())
    .slice(-HISTORY_PAIRS)
    .map((p) => ({ utterance: cut(p.utterance), summary: cut(p.summary) }));
}

/**
 * Правка слишком большая (SPEC §9.8, `too_large`): сервер отверг её или реплика не стала
 * её заводить. Правки нет ни на холсте, ни в журнале — говорим это и что делать.
 * @param {{limit?: string, detail?: {limit?: string}, tx?: object}} e
 * @param {{txBytes?: number, opsPerTx?: number, docNodes?: number, docBytes?: number}} [limits]
 */
export function tooLargeWords(e = {}, limits = {}) {
  const limit = String((e && (e.limit || (e.detail && e.detail.limit))) || '');
  const mb = (b, d) => Math.round((Number(b) || d) / (1024 * 1024));
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const title = 'Правка слишком большая — она не сохранена';
  let note;
  switch (limit) {
    case 'ops_per_tx':
      note = `В ней больше ${num(limits.opsPerTx || 5000)} операций, а сервер столько за раз не принимает. `
        + 'Сделайте её по частям: выделите меньше и повторите.';
      break;
    case 'doc_nodes':
      note = `Документ упёрся в предел — ${num(limits.docNodes || 20000)} узлов. Удалите лишнее, тогда новое ляжет.`;
      break;
    case 'doc_bytes':
      note = `Документ упёрся в предел размера — ${mb(limits.docBytes, 24 * 1024 * 1024)} МБ. Удалите лишнее, тогда новое ляжет.`;
      break;
    default:
      note = `Сервер не принимает правки больше ${mb(limits.txBytes, 4 * 1024 * 1024)} МБ. `
        + 'Сделайте её по частям или уберите из неё большие тексты и картинки.';
  }
  return { title, note };
}

/**
 * «Стоп» нажат, когда Orchestrator уже записал транзакцию: остановить запись нельзя, она
 * пришла по сокету. Шаг истории заведён — человек должен знать, что её можно отменить.
 * @param {{title?: string}} [tx]
 * @param {string} [utterance]
 */
export function stoppedWriteWords(tx, utterance = '') {
  const what = String((tx && tx.title) || utterance || '').trim();
  const short = what.length > 80 ? `${what.slice(0, 79)}…` : what;
  return {
    title: 'Агент успел записать правку до остановки — можно отменить',
    note: short ? `«${short}» уже на холсте. Отменить — кнопкой ниже или Ctrl+Z.` : 'Отменить — кнопкой ниже или Ctrl+Z.',
  };
}

/**
 * `result` (§10.3) → то, что оболочке нужно показать. `applied` и `dropped` бывают и
 * числом, и списком — считаем и то и другое.
 */
export function normalizeResult(r) {
  const x = r && typeof r === 'object' ? r : {};
  const count = (v) => (Array.isArray(v) ? v.length : (Number.isFinite(Number(v)) ? Number(v) : 0));
  return {
    txId: typeof x.tx_id === 'string' && x.tx_id ? x.tx_id : '',
    seq: Number.isFinite(x.seq) ? x.seq : null,
    applied: count(x.applied),
    dropped: Array.isArray(x.dropped) ? x.dropped : [],
    droppedCount: count(x.dropped),
    summary: String(x.summary || '').trim(),
    warnings: Array.isArray(x.warnings) ? x.warnings.map((w) => String(w || '')).filter(Boolean) : [],
    select: Array.isArray(x.select) ? x.select.filter((id) => typeof id === 'string') : [],
  };
}

/**
 * Варианты сервера (§10.3 `variants.items`) → карточки в форме, которую понимает панель
 * вариантов: `{label, ops, preview: {doc, geo}}` плюс `server: {command_id, key}` — по
 * нему выбор уходит в `POST /agent/apply`, а не в локальный commit. Превью считается своим
 * движком: из `preview.doc`, если сервер прислал документ, или из операций поверх текущего.
 *
 * @param {object[]} items
 * @param {{doc: object, core: {applyOps: Function, solve: Function}, commandId: string}} ctx
 */
export function variantsFromServer(items, { doc, core, commandId }) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it, i) => {
    const item = it && typeof it === 'object' ? it : {};
    const pv = item.preview && typeof item.preview === 'object' ? item.preview : null;
    const ops = Array.isArray(item.ops) ? item.ops : (pv && Array.isArray(pv.ops) ? pv.ops : []);
    let preview = null;
    try {
      if (pv && pv.doc && pv.doc.nodes && pv.doc.root) {
        preview = { doc: pv.doc, geo: core.solve(pv.doc) };
      } else if (ops.length && doc) {
        const r = core.applyOps(doc, ops);
        if (r && !r.error && r.doc) preview = { doc: r.doc, geo: core.solve(r.doc) };
      }
    } catch { preview = null; }
    return {
      label: String(item.label || `Вариант ${i + 1}`),
      description: String(item.description || ''),
      opsCount: Number.isFinite(item.ops_count) ? item.ops_count : ops.length,
      ops,
      preview,
      server: { command_id: commandId, key: item.key != null ? item.key : i },
    };
  });
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ------------------- словарь оболочки: одна таблица на клиент и сервер ------------------- */
/**
 * Человек наблюдает за макетом и говорит. Но переключить видимый артборд, вписать,
 * приблизить, выделить слой, экспортировать, открыть историю голосом было нельзя — всё
 * уходило в модель правкой макета, а «отмени два раза» вообще считалось созданием
 * (круг 9, п.6). Это дешёвые правила рядом с BUSY_WORDS и VARIANT_WORDS оболочки, и они же
 * работают для набранной команды: активный артборд задаёт область работы агента,
 * и выбирать её надо словами.
 *
 * Круг 24: словарь вынесен из app.js сюда, без DOM и без состояния оболочки — документ и
 * активная доска приходят аргументом. Его же зовёт JEV на сервере (server/orchestrator/jev):
 * узкой копии там больше нет, и фраза значит одно и то же по обе стороны сети
 * (test/shell.test.mjs). Расширять его новыми формами не нужно (§7) — следующий шаг —
 * классификатор.
 */

/** Реплика в один вид: без знаков, в нижнем регистре, одиночные пробелы. */
export function normSaid(text) {
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
  'артборд', 'артборде', 'артборда', 'доска', 'доски', 'доске', 'доску', 'доской',
  'экран', 'экране', 'экрана', 'экраном',
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
export function nameMatches(name, phrase) {
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
export function artboardsByName(doc, phrase) {
  if (!doc || !doc.nodes) return [];
  return artboards(doc)
    .map((a) => ({ node: a, score: nameMatches(a.name || '', phrase) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.node);
}

/** Узлы, чьё имя похоже на сказанное. Внутри активного артборда — дороже. */
export function nodesByName(doc, phrase, { activeId = null, artboardsToo = true } = {}) {
  if (!doc || !doc.nodes) return [];
  const inside = activeId && doc.nodes[activeId] ? new Set(subtreeIds(doc, activeId)) : new Set();
  const out = [];
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (!n || n.type === 'page') continue;
    if (!artboardsToo && isArtboard(doc, id)) continue;
    const score = nameMatches(n.name || placeholderName(doc, n), phrase);
    if (!score) continue;
    out.push({ id, node: n, score: score + (inside.has(id) ? 0.5 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
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
export function numSaid(word) {
  const w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (/^\d{1,3}$/.test(w)) return Number(w);
  if (NUM_SAID[w] != null) return NUM_SAID[w];
  const m = ORD_RE.exec(w);
  if (m && ORD_END.test(m[2])) return ORD_STEMS[m[1]];
  return null;
}

const RE_UNDO_BARE = /^(отмена|отмени|отменить|отмени это|отмени правку|отмени последнее|верни как было|верни как раньше|верни назад|назад|не так)$/;
const RE_REDO_BARE = /^(верни обратно|повтори правку|вперёд|вперед)$/;
export const RE_VARIANTS_BARE = /^(варианты|три варианта|дай варианты|покажи варианты|другие варианты|ещё варианты|еще варианты|сделай иначе|а можно иначе)$/;
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
/* Круг 18, п.5: «доска» — слово человека, и оно понимается наравне с прежними. */
const AB_KIND = '(?:доск[а-яё]*|артборд[а-яё]*|экран[а-яё]*|макет[а-яё]*|страниц[а-яё]*|вкладк[а-яё]*|лист[а-яё]*)';
const RE_PICK = /^(?:выдели|выделить|выделите|выбери|выбрать|укажи|отметь)\s+(?:слой\s+|узел\s+|элемент\s+)?(.+)$/;
/* Круг 18, п.5. Раз интерфейс зовёт их досками, сказать «новая доска» человек вправе
   ожидать. Модель этого слова не знает (её словарь — «экран», «артборд»), поэтому
   пустую доску делает сама оболочка — как она уже делает отмену, масштаб и экспорт
   (SPEC §4). Форма только целиковая: «собери доску оплаты» — работа для агента. */
const RE_NEW_BOARD = /^(?:нов(?:ая|ую) доск[ау]|пуст(?:ая|ую) доск[ау]|созда(?:й|ть) доску|добав(?:ь|ить) доску|ещ[ёе] одн(?:а доска|у доску)|новый артборд|пустой артборд)$/;

/**
 * Намерение, которое выполняет сама оболочка. null — значит это команда агенту.
 * Правила узкие нарочно: «покажи сводку недели» — переключение (артборд с таким именем
 * есть), «добавь сводку недели» — работа для модели.
 *
 * Круг 24: один словарь на клиент и на JEV сервера (SPEC §7, §10.5). Без документа
 * (`ctx.doc` нет — так зовёт JEV) формы, которым нужны имена слоёв и досок, молчат:
 * их оболочка узнаёт сама до сети. Номер и «следующая доска» документа не требуют.
 *
 * @param {string} said реплика
 * @param {{doc?: object|null, activeArtboardId?: string|null}} [ctx]
 * @returns {{kind: string}|null}
 */
export function shellIntent(said, ctx = {}) {
  const doc = ctx && ctx.doc && ctx.doc.nodes ? ctx.doc : null;
  const activeId = ctx && ctx.activeArtboardId ? ctx.activeArtboardId : null;
  const t = normSaid(said);
  if (!t || t.length > 140) return null;

  /* «Стоп», набранное в строке, уходило в модель — и агент начинал СТРОИТЬ макет по
     слову «стоп». Голосом эта ветка была, печатной строке не досталось (круг 13, п.8).
     Форма только целиковая: «добавь стоп-кран» сюда не попадает. */
  if (RE_STOP_BARE.test(t)) return { kind: 'stop' };

  // «закрой варианты» — до общего запрета на слово «вариант» ниже
  if (RE_VARIANTS_CLOSE.test(t)) return { kind: 'variants-close' };

  // пустая доска — дело оболочки, модель для этого не нужна (круг 18, п.5)
  if (RE_NEW_BOARD.test(t)) return { kind: 'new-board' };

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
  /* Остальные целиковые формы отмены и возврата — закрытый список brain (`recognizeAction`):
     тот же, что видит конвейер, поэтому оболочка и сервер не расходятся с ним. */
  const action = recognizeAction(said);
  if (action) return { kind: action, times: 1 };

  /* — вид: вписать и масштаб — */
  if (/^(вписать|впиши|вмести|вместить|вписать в окно|вписать на экран)$/.test(t)) return { kind: 'fit' };
  if (/^(вписать всё|вписать все|впиши всё|впиши все|покажи всё|покажи все|покажи весь макет|покажи целиком|целиком|общий вид|обзор)$/.test(t)) {
    return { kind: 'fit', all: true };
  }
  if (/^(вписать экран|впиши экран|вписать артборд|впиши артборд|вписать доску|впиши доску|покажи этот экран|покажи активный экран|покажи эту доску)$/.test(t)) {
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
    const hits = nodesByName(doc, pick[1], { activeId });
    if (hits.length) {
      const best = hits[0].score;
      const same = hits.filter((h) => h.score >= best - 0.01).slice(0, 12);
      return { kind: 'select', ids: same.map((h) => h.id), name: same[0].node.name || placeholderName(doc, same[0].node) };
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
      const hits = artboardsByName(doc, tail);
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

/**
 * Намерение оболочки → событие `shell {action, args}` (§10.3, §10.5). Обратное —
 * `shellIntentFromServer`; круг туда-обратно возвращает то же намерение (тест сверяет).
 * @param {{kind: string}} intent
 * @returns {{action: string, args: object}|null}
 */
export function shellEventOf(intent) {
  if (!intent || typeof intent !== 'object' || !intent.kind) return null;
  const { kind, ...args } = intent;
  return { action: kind, args };
}
