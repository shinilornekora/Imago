/**
 * Imago Studio — таблица команд оболочки и слова оболочки (SPEC §7, §10, §13; круги 23–24, 38).
 *
 * Чистые функции без DOM:
 *   • открытая таблица команд оболочки `SHELL_COMMANDS` (круг 38, §13): каждая команда описана
 *     явно — имя, группа, фразы, слэш-форма, клавиша, аргументы; по ней строятся палитра
 *     (Ctrl/⌘+K, «/» в строке команд) и справка «Команды». Узнаёт команду `shellIntent` —
 *     слэш-форму (`/масштаб 150`) точно, естественную фразу («отмени два раза», «впиши всё»)
 *     целиком. Исполняет команду клиент сам, без сети и без модели; всё, что таблица не
 *     узнала, — работа агента. Правки команд (дублировать, обернуть в рамку, выровнять детей…)
 *     собираются здесь операциями ядра и уходят обычной транзакцией;
 *   • `shellIntentFromServer` — событие `shell {action, args}` старого сервера (совместимость);
 *   • слова серверного агента: где он работает, как назвать стадию, ошибку, вариант.
 * Тесты: test/shell*.test.mjs (таблица, слэш-формы, правки), test/agent.test.mjs.
 */

import {
  artboards, isArtboard, subtreeIds, placeholderName,
  ops as OPS, ancestors, normalizeLayout, resolveLayout, uid,
  scaleSteps, scaleRef, parseScaleRef, resolveScale,
} from './core.js';
// круг 25: cutText/cleanText появляются в core параллельно — берём оттуда, если уже есть
import * as CORE_NS from './core.js';
import { recognizeAction, RE_IMAGE_REF, textRole, ruToken } from './brain.js';
import { catalogFont, nearestWeight, FONT_CATALOG } from './fonts.js';
// круг 41: причины отброшенного — одна истина со словами реплики (§9.10)
import { DROP_WORDS } from './sync.js';

/* ------------------------------ строки человеку ------------------------------ */

/**
 * Строка не длиннее n символов — по кодовым точкам, а не по UTF-16: `.slice(0, n)` резал
 * эмодзи и редкие иероглифы пополам, и в имени оставался «битый» полусимвол (круг 25, п.7).
 * Обрезанное кончается «…» (если `ellipsis`). Берётся из core, когда он это умеет.
 * @param {string} s
 * @param {number} n
 * @param {{ellipsis?: boolean}} [o]
 */
export function cutText(s, n, { ellipsis = false } = {}) {
  const str = String(s == null ? '' : s);
  const max = Math.max(0, Math.trunc(Number(n) || 0));
  if (!ellipsis && typeof CORE_NS.cutText === 'function') return CORE_NS.cutText(str, max);
  const cps = Array.from(str);
  if (cps.length <= max) return str;
  if (!ellipsis) return cps.slice(0, max).join('');
  return `${cps.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/**
 * Строка для человека: без управляющих и невидимых символов, одиночные пробелы, без краёв.
 * Сначала — `core.cleanText` (без `\u0000` и одиночных суррогатов), если core его уже умеет.
 */
export function cleanText(s) {
  const str = String(s == null ? '' : s);
  const safe = typeof CORE_NS.cleanText === 'function' ? CORE_NS.cleanText(str) : str;
  return String(safe)
    // круг 33: изоляторы направления (U+2066–U+2069) и арабская метка (U+061C) тоже невидимы
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Служебное, что человеку не показывают: адреса, коды HTTP, «JSON», «fetch», сырые id и
 * латинские слова из стека. Такую строку оболочка не произносит — у неё есть свои слова.
 */
const JARGON = /https?:\/\/|\blocalhost\b|\b\d{3}\b|json|fetch|econn|enotfound|etimedout|socket|stack|undefined|null\b|\b[a-z]+_[a-z_]+\b|\b(?:tx|cmd|c|f|t|lib)_[a-z0-9]{6,}\b|[a-z]{5,}/i;
export function isJargon(text) {
  return JARGON.test(String(text || ''));
}

/** Где выполняется команда агента — слова для строки состояния. */
export const AGENT_MODE_WORDS = Object.freeze({
  server: 'агент: сервер',
  browser: 'агент: в браузере',
  off: 'агент недоступен',
});

/**
 * Где работать агенту (круг 25). Решает ответ `/agent/health`, а не сокет Document
 * service: пока Hub переподключается, Orchestrator жив и читает документ сам — команда
 * уходила в браузер зря (ревью, Д5). На сервере — когда проект открыт через Document
 * service и Orchestrator ответил `ok`. Модель браузера идёт в дело, только если её
 * включил человек (`hasProvider`): в серверной сборке её по умолчанию нет, и прежде
 * команда уходила на localhost:1234 и падала «Failed to fetch» (п.1).
 *
 *   • health.ok, документ и модель у сервера живы → server;
 *   • health.ok, но модель или документ у сервера лежат: своя модель есть → browser,
 *     нет → server (сервер сам скажет, что не так, и это честнее «недоступен»);
 *   • health не ok или его ещё нет → browser при своей модели, иначе off.
 *
 * @param {{inProject: boolean, health: object|null, hasProvider: boolean}} s
 * @returns {'server'|'browser'|'off'}
 */
export function decideAgentMode({ inProject = false, health = null, hasProvider = false } = {}) {
  const h = health && health.ok === true ? health : null;
  if (inProject && h) {
    if (h.document === 'up' && h.llm === 'up') return 'server';
    return hasProvider ? 'browser' : 'server';
  }
  return hasProvider ? 'browser' : 'off';
}

/**
 * Круг 45 (UX r44): знак агента в шапке — в тон тосту. Сервер агента выбран, но документа он не
 * видит (или модель на нём не отвечает) — точка жёлтая и подпись с причиной, а не зелёное
 * «агент: сервер» рядом с тостом «Сервер агента не видит документ».
 * @returns {{dot: 'on'|'off'|'error', words: string}}
 */
export function agentBadge(mode, health) {
  const h = health && health.ok === true ? health : null;
  if (mode === 'server') {
    // прежний оркестратор полей document/llm не отдаёт — молчание не считаем поломкой (критик r45 S9)
    if (h && h.document !== undefined && h.document !== 'up') return { dot: 'off', words: 'агент: сервер без документа' };
    if (h && h.llm !== undefined && h.llm !== 'up') return { dot: 'off', words: 'агент: сервер без модели' };
    return { dot: 'on', words: AGENT_MODE_WORDS.server };
  }
  if (mode === 'browser') return { dot: 'off', words: AGENT_MODE_WORDS.browser };
  return { dot: 'error', words: AGENT_MODE_WORDS.off };
}

/** Подробности о режиме — для подсказки у строки состояния. */
export function agentModeTitle(mode, health, providerWords = '') {
  const h = health && health.ok === true ? health : null;
  if (mode === 'server') {
    if (h && h.document !== undefined && h.document !== 'up' && storageReason(h)) return 'Команды агента выполняет сервер, но база данных сервера сейчас недоступна — команды не выполняются, правки руками ждут в очереди';
    if (h && h.document !== undefined && h.document !== 'up') return 'Команды агента выполняет сервер, но сейчас он не видит документ — правки руками сохраняются';
    if (h && h.llm === 'unconfigured') return 'Команды агента выполняет сервер, но модель на нём не настроена — это забота администратора';
    if (h && h.llm !== 'up') return 'Команды агента выполняет сервер, но модель на нём сейчас не отвечает — попробуйте позже';
    return 'Команды агента выполняет сервер';
  }
  if (mode === 'browser') {
    const why = h ? 'модель на сервере сейчас не отвечает' : 'сервер агента не отвечает';
    return `Команды агента выполняются в этом браузере${providerWords ? ` (${providerWords})` : ''}: ${why}`;
  }
  if (health && health.reason === 'offline') return 'Нет сети — команды агента не выполняются. Правки руками ждут во вкладке';
  return 'Сервер агента не отвечает — команды агента не выполняются. Правки руками сохраняются';
}

/**
 * Что сказать человеку, когда ответ `/agent/health` изменился (круг 25, п.2). Только по
 * ответу health — не по сокету документа, не при смене проекта; null — молчать.
 * Первый ответ (prev нет) не объявляется: человек ещё ничего не потерял.
 * @param {object|null} prev прежний ответ health
 * @param {object|null} next новый
 * @param {{hasProvider?: boolean}} [o]
 * @returns {{text: string, kind: 'plain'|'error', back?: boolean}|null}
 */
export function agentHealthNotice(prev, next, { hasProvider = false, editsWait = false } = {}) {
  if (!prev || !next) return null;
  const was = prev.ok === true ? (prev.document !== 'up' ? 'nodoc' : prev.llm !== 'up' ? 'nollm' : 'up') : 'down';
  const now = next.ok === true ? (next.document !== 'up' ? 'nodoc' : next.llm !== 'up' ? 'nollm' : 'up') : 'down';
  if (was === now) return null;
  const local = hasProvider ? ' Команды пока выполняются в браузере.' : '';
  if (now === 'up') {
    // круг 41 (UX): пропажа была из-за сети компьютера — и возвращается сеть, а не сервер
    if (was === 'down' && prev.reason === 'offline') return { text: 'Сеть вернулась — агент снова на связи.', kind: 'plain', back: true };
    const text = { down: 'Сервер агента снова на связи.', nodoc: 'Сервер документа снова на связи — агент работает.', nollm: 'Модель на сервере снова отвечает.' }[was];
    return { text, kind: 'plain', back: true };
  }
  /* круг 41 (UX): нет сети у компьютера — так и говорим: сервер агента тут ни при чём, правки
     ждут во вкладке (а не «сохраняются») */
  if (now === 'down' && next.reason === 'offline') return { text: `Нет сети — агент недоступен.${local || ' Правки руками ждут во вкладке и уйдут, когда сеть вернётся.'}`, kind: 'plain' };
  // круг 41: сервер документов тоже недоступен (реплика не в сети) — правки не «сохраняются», а ждут
  if (now === 'down') return { text: `Сервер агента не отвечает.${local || (editsWait ? ' Правки руками ждут во вкладке.' : ' Правки руками сохраняются.')}`, kind: 'plain' };
  if (now === 'nodoc') {
    // K2: причина — база данных, а не сервис документа
    // круг 32: 'schema' — база догоняет схему после восстановления из копии (обычно секунды)
    const why = next.document_reason === 'engine' ? 'сервер документов ещё на прежней версии редактора'
      : schemaReason(next) ? 'сервер обновляет базу данных' : storageReason(next) ? 'база данных сервера недоступна' : 'сервер документа не отвечает';
    return { text: `Сервер агента не видит документ — ${why}.${local}`, kind: 'plain' };
  }
  if (was === 'up') return { text: `Модель на сервере не отвечает — попробуйте позже.${local}`, kind: 'plain' };
  return null;
}

/** Orchestrator не ответил на команду, а своей модели у браузера нет (п.1). */
export const AGENT_DOWN_WORDS = Object.freeze({
  title: 'Сервер агента не отвечает — команда не выполнена',
  note: 'Правки руками сохраняются. Текст команды остался в строке.',
});

/**
 * Поток команды оборвался, а транзакция так и не пришла (круг 25, п.3).
 * @param {string} utterance
 * @param {'restarted'|'down'|'silent'} why перезапустился / не отвечает / молчит
 */
export function detachedLostWords(utterance, why = 'restarted') {
  const what = cutText(cleanText(utterance), 60, { ellipsis: true });
  const head = what ? `Команда «${what}» не выполнена` : 'Команда не выполнена';
  const tail = {
    restarted: 'сервер агента перезапустился',
    down: 'сервер агента не отвечает',
    silent: 'ответа от сервера агента нет',
  }[why] || 'сервер агента перезапустился';
  return { title: `${head} — ${tail}`, note: 'Текст команды вернулся в строку. Правки руками сохраняются.' };
}

/** Стадии §10.3 словами человека — когда сервер не прислал свою подпись. */
export const STAGE_WORDS = Object.freeze({
  intent: 'Разбираю запрос',
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
  // круг 38: первая стадия теперь `intent`; `jev` от сервера прежней версии — она же
  const key = data.key === 'jev' ? 'intent' : typeof data.key === 'string' ? data.key : '';
  const label = String(data.label || STAGE_WORDS[key] || 'Агент работает').trim();
  const rec = { stage: `srv:${key || 'stage'}`, label };
  if (data.variant != null) rec.variant = data.variant;
  if (data.detail) rec.detail = String(data.detail);
  return rec;
}

/**
 * Событие `queued` словами. `ahead` — имена тех, чья команда впереди (из присутствия:
 * у них `busy`/`queued`, §9.9), если оболочка их знает. `scope` (круг 27, §10.8):
 * `'project'` — очередь проекта (по одной команде на проект), `'workers'` — команда
 * принята и ждёт свободного исполнителя (воркера) агента: очередь проекта ни при чём,
 * впереди — команды любых проектов, их имён оболочка не знает. Круг 39: `'read'` — полное
 * чтение документа ждёт семафора чтений агента (впереди — чтения любых проектов, тоже без
 * имён); прочие (будущие) очереди агента — общими словами, тоже без имён.
 * @param {number} position
 * @param {string[]} [ahead]
 * @param {'project'|'workers'|'read'|string} [scope]
 */
export function queuedLabel(position, ahead = [], scope = 'project') {
  if (scope === 'workers') return 'Ждёт свободного исполнителя агента…';
  if (scope === 'read') return 'Ждёт очереди на чтение документа…';
  if (scope !== 'project') return 'Ждёт очереди агента…';
  const n = Number(position);
  const names = (Array.isArray(ahead) ? ahead : []).map((a) => cutText(cleanText(a), 40, { ellipsis: true })).filter(Boolean);
  const whose = names.length
    ? ` (${names.slice(0, 2).join(', ')}${names.length > 2 ? ` и ещё ${names.length - 2}` : ''})`
    : '';
  if (!Number.isFinite(n) || n <= 0) return names.length ? `В очереди проекта: впереди команда${whose}` : 'В очереди проекта';
  return `В очереди проекта: впереди ${n} ${plural(n, 'команда', 'команды', 'команд')}${whose}`;
}

/** Очередь события `queued` (§10.3): нет поля (прежний Orchestrator) — очередь проекта. */
export function queuedScope(data) {
  const s = data && typeof data === 'object' ? data.scope : undefined;
  if (s === undefined || s === null || s === '' || s === 'project') return 'project';
  return typeof s === 'string' ? s : 'project';
}

/**
 * Событие `queued` → стадия ленты. «Чьи команды впереди» (по присутствию: у кого агент сейчас
 * работает) — только для очереди ПРОЕКТА: в очереди исполнителей (`workers`) и чтений
 * (`read`, круг 39) впереди команды других проектов, и имена соавторов этого проекта были бы
 * неправдой.
 * @param {{position?: number, scope?: string}} data
 * @param {{author?: string, busy?: boolean|number}[]} [others] присутствие проекта
 * @returns {{stage: 'srv:queued', label: string, scope: string, position: number}}
 */
export function queuedStage(data, others = []) {
  const position = data && Number.isFinite(data.position) ? data.position : 0;
  const scope = queuedScope(data);
  const ahead = scope !== 'project' ? [] : (Array.isArray(others) ? others : [])
    .filter((p) => p && (p.busy === true || (typeof p.busy === 'number' && p.busy > 0)))
    .map((p) => p.author || 'Без имени');
  return { stage: 'srv:queued', label: queuedLabel(position, ahead, scope), scope, position };
}

/**
 * Чужое присутствие с `busy`/`queued` (§9.9) словами: «Аня ждёт агента…».
 * @param {{author?: string, busy?: boolean|number, queued?: boolean|number}} p
 * @returns {string} пусто — агент на этого человека не работает
 */
export function presenceAgentWords(p) {
  if (!p || typeof p !== 'object') return '';
  const name = cutText(cleanText(p.author), 40, { ellipsis: true }) || 'Без имени';
  const queued = p.queued === true || (typeof p.queued === 'number' && p.queued > 0);
  const busy = p.busy === true || (typeof p.busy === 'number' && p.busy > 0);
  if (queued) return `${name} ждёт агента…`;
  if (busy) return `${name}: агент работает…`;
  return '';
}

/** Повтор по Retry-After словами. */
export function retryLabel(waitMs, code = '', extra = null) {
  const s = Math.max(1, Math.round((Number(waitMs) || 0) / 1000));
  // K2 (круг 31): документ не виден из-за базы данных
  if (code === 'document_down' && storageReason(extra)) return `База данных сервера недоступна — повторю через ${s} с`;
  // круг 27, п.7: 503 бывает не только от занятости — называем то, что случилось
  const why = {
    document_down: 'Сервер агента не видит документ',
    document_failed: 'Сервер агента не смог прочитать документ',
    llm_down: 'Модель на сервере не отвечает',
    shutting_down: 'Сервер агента перезапускается',
  }[code] || 'Сервер агента занят';
  return `${why} — повторю через ${s} с`;
}

/**
 * Событие `shell {action, args}` от сервера прежней версии (до круга 38 сервер сам узнавал
 * команды оболочки) → намерение в терминах таблицы оболочки (те же `kind`, что у
 * `shellIntent`). Новый сервер такого события не шлёт; принимаем его ради совместимости
 * одной версии. Неизвестное — null: оболочка попробует свою таблицу.
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
    // круг 36 (SPEC §11.3): режим «Просмотр»; без on — включить
    case 'preview':
      return { kind: 'preview', on: a.on == null ? true : !(a.on === false || a.on === 'false' || a.on === 0) };
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
    case 'agent-setting':
      return ['direction', 'critic', 'webFonts'].includes(a.what) ? { kind: 'agent-setting', what: a.what, on: typeof a.on === 'boolean' ? a.on : null } : null;
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

/**
 * Ошибки сервера агента словами: заголовок и что делать (§10.2). Человек в браузере не
 * администратор: «запустите LM Studio» и «проверьте контейнер orchestrator» ему не по
 * силам и не по адресу (круг 25, п.7) — ему говорим, что делать ему: подождать, повторить,
 * поправить команду. Тексты сервера к знакомому коду приписываются, только если в них нет
 * служебного (адресов, кодов, «JSON», латиницы).
 */
const PROJECT_GONE_AGENT_TITLE = 'Проекта больше нет на сервере — команда не выполнена';
const ERROR_WORDS = {
  busy: ['Агент занят командами этого проекта', 'Повторите чуть позже.'],
  llm_down: ['Модель на сервере не отвечает', 'Попробуйте позже.'],
  llm_failed: ['Модель ответила ошибкой', 'Попробуйте ещё раз или скажите иначе.'],
  document_down: ['Сервер агента не видит документ', 'Повторите через несколько секунд — правки руками сохраняются.'],
  document_failed: ['Сервер агента не смог прочитать документ', 'Повторите через несколько секунд.'],
  too_large: ['Команда слишком большая для агента', 'Скажите короче или выделите слой поменьше.'],
  bad_request: ['Сервер агента не понял команду', 'Обновите страницу: версия редактора могла устареть.'],
  /* Круг 29: проекта нет (базу восстановили из копии, проект удалили) — «Откройте проект
     заново» вело в никуда: открывать нечего. Работа цела во вкладке — её сохраняют копией. */
  not_found: [PROJECT_GONE_AGENT_TITLE, 'Ваша работа цела в этой вкладке — сохраните её новым проектом.'],
  /* J5 (круг 29): модель ответила, но ни одна правка не легла — это не «ошибка модели». */
  not_applied: ['Не получилось применить правку', 'Назовите слой так, как он подписан в списке слоёв, — или выделите его и повторите.'],
  upstream_down: [AGENT_DOWN_WORDS.title, 'Правки руками сохраняются.'],
  upstream_timeout: ['Сервер агента не ответил вовремя', 'Повторите команду.'],
  network: [AGENT_DOWN_WORDS.title, 'Правки руками сохраняются.'],
  timeout: ['Сервер агента не ответил вовремя', 'Повторите команду.'],
  bad_response: ['Сервер агента ответил непонятно', 'Повторите команду.'],
  // круг 27, I6: и идущая команда, и ждавшие в очереди — не выполнены, а не «остановлены»
  shutting_down: ['Сервер агента перезапускается — команда не выполнена', 'Текст команды остался в строке — повторите через несколько секунд.'],
  worker_failed: ['Агент на сервере сбился на этой команде', 'Повторите или скажите иначе.'],
  /* K3 (круг 31): исключение в коде агента, а не ответ модели — повтор не поможет. */
  internal: ['Внутренняя ошибка агента — сообщите администратору', 'Команда не выполнена, текст остался в строке.'],
  /* K3: модель ответила слишком большим, слишком глубоким или не-JSON ответом — разово. */
  llm_bad_response: ['Ответ модели не удалось разобрать — попробуйте ещё раз', 'Текст команды остался в строке.'],
  /* Круг 39 (N1): `engine` от Orchestrator — его движок и движок сервиса документов разошлись
     (сервер обновляется): перезагрузка страницы тут не поможет, правки руками сохраняются. */
  engine: ['Сервер агента и сервер документов сейчас разных версий', 'Команда не выполнена — так бывает, пока сервер обновляется. Правки руками сохраняются; текст остался в строке.'],
};

/* Коды, у которых текст сервера человеку не добавляет ничего, кроме совета администратору
   («проверьте, что сервер модели запущен»): своих слов достаточно. */
const OWN_SILENT = new Set(['llm_down', 'upstream_down', 'network', 'document_down', 'document_failed',
  'shutting_down', 'busy', 'timeout', 'upstream_timeout', 'worker_failed', 'internal', 'engine', 'bad_response', 'not_found',
  'llm_bad_response']);

/** K2 (круг 31): Orchestrator не видит документ, потому что лежит база данных Document service. */
export const STORAGE_DOWN_AGENT_WORDS = Object.freeze({
  title: 'База данных сервера недоступна — команда не выполнена',
  note: 'Текст команды остался в строке — повторите, когда она вернётся. Правки руками ждут в очереди.',
});

/**
 * Причина «документ недоступен» — хранилище (K2): `document_reason: 'storage'` у ответа
 * health или у ошибки команды (в самой ошибке или в её detail), либо detail.storage 'down'.
 */
export function storageReason(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.document_reason === 'storage' || x.reason === 'storage' || schemaReason(x)) return true;
  const d = x.detail && typeof x.detail === 'object' ? x.detail : null;
  return !!(d && (d.document_reason === 'storage' || d.reason === 'storage' || d.storage === 'down' || d.cause === 'storage'));
}

/** Причина — схема базы догоняется после восстановления из копии (DOC круг 31): обычно секунды. */
export function schemaReason(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.document_reason === 'schema' || x.reason === 'schema') return true;
  const d = x.detail && typeof x.detail === 'object' ? x.detail : null;
  return !!(d && (d.document_reason === 'schema' || d.reason === 'schema' || d.storage === 'schema' || d.cause === 'schema'));
}

/**
 * Код ошибки агента словами — для «Подробностей» (круг 29, п.7): «код: llm_failed» человеку
 * не говорит ничего. Незнакомый код — общими словами, без латиницы.
 * @param {string} code
 * @returns {string}
 */
export function errorCodeWords(code) {
  const known = ERROR_WORDS[code];
  if (known) {
    const t = known[0].split(' — ')[0];
    return t.charAt(0).toLowerCase() + t.slice(1);
  }
  if (code === 'cancelled') return 'команда остановлена';
  return 'сбой агента';
}

/**
 * @param {{code?: string, message?: string, retryAfterMs?: number|null}} err
 * @returns {{title: string, note: string, waitMs: number}}
 */
export function agentErrorWords(err) {
  const e = err || {};
  const known = ERROR_WORDS[e.code];
  const own = cleanText(e.message || '');
  const ownOk = own && !isJargon(own);
  /* J5: «Не получилось применить правку: <почему>» — причина от brain, если она человеческая
     и сама не повторяет заголовок; подсказка — назвать слой. */
  /* not_found бывает не только о проекте: «Варианты этой команды не найдены или устарели»
     (POST /agent/apply). Не про проект — словами сервера, а не «проекта больше нет». */
  if (e.code === 'not_found' && ownOk && !/проект/i.test(own)) {
    const [head, ...rest] = own.split(/\s+—\s+/);
    return { title: head.replace(/\s*[.:;]\s*$/, ''), note: rest.join(' — ').replace(/\s*[.]\s*$/, ''), waitMs: 0 };
  }
  if (e.code === 'not_applied') {
    const [title, hint] = ERROR_WORDS.not_applied;
    let why = ownOk ? own.replace(/\s*[.:;]\s*$/, '') : '';
    const low = why.toLowerCase();
    for (const lead of ['не получилось применить правку', 'ни одну правку не удалось применить', 'ни одна правка не применилась']) {
      if (low.startsWith(lead)) { why = why.slice(lead.length).replace(/^\s*[:—–-]\s*/, ''); break; }
    }
    why = cutText(why, 140, { ellipsis: true });
    /* Круг 31 (ORCH): совет «назовите слой» — только когда причина в выборе слоя (brain
       кладёт `hint: 'name_layer'` в ошибку, Orchestrator — в detail). «У текста нет
       раскладки» — не про имя слоя, совет там сбивал с толку. */
    const nameIt = e.hint === 'name_layer' || !!(e.detail && typeof e.detail === 'object' && e.detail.hint === 'name_layer');
    return { title: why ? `${title}: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : title, note: nameIt ? hint.replace(/\s*[.]\s*$/, '') : '', waitMs: 0 };
  }
  /* Круг 41: Orchestrator сверил версию движка вкладки (426 engine, detail.cause). Вкладка
     старее — обновить страницу; сервер агента старее — ждать его обновления; повтор сейчас
     ничего не даст, поэтому ни «повторите», ни срока. */
  if (e.code === 'engine' && e.detail && e.detail.cause === 'client_old') {
    return { title: 'Вышла новая версия редактора — обновите страницу', note: 'Сервер агента работает с новой версией, эта вкладка — с прежней. Команда не выполнена, текст остался в строке', waitMs: 0, engine: 'client_old' };
  }
  /* Круг 43: проект на сервере документов записан более новой версией, а сервер ещё не
     обновился — повтор имеет смысл, когда его обновят (кнопка «Повторить» по сроку). */
  if (e.code === 'engine' && e.detail && e.detail.cause === 'server_old' && e.detail.server === 'document') {
    const waitMs = Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? e.retryAfterMs : 0;
    return { title: 'Сервер документов ещё не обновился — команда не выполнена', note: 'Проект записан более новой версией редактора, а сервер документов ещё на прежней. Текст команды остался в строке — повторите, когда сервер обновят', waitMs, engine: 'document_old' };
  }
  if (e.code === 'engine' && e.detail && e.detail.cause === 'agent_old') {
    return { title: 'Сервер агента ещё не обновился — команда не выполнена', note: 'Он на прежней версии редактора, а сервер документов — уже на новой; повтор сейчас не поможет. Текст команды остался в строке — выполните её, когда сервер агента обновят', waitMs: 0, engine: 'agent_old' };
  }
  if (e.code === 'engine' && e.detail && e.detail.cause === 'server_old') {
    return { title: 'Сервер агента ещё не обновился — команда не выполнена', note: 'Он на прежней версии редактора, повтор сейчас не поможет. Текст команды остался в строке — выполните её, когда сервер обновят', waitMs: 0, engine: 'server_old' };
  }
  // K2: документ недоступен агенту из-за базы данных — так и говорим, а не «сервер документа не отвечает»
  if ((e.code === 'document_down' || e.code === 'document_failed') && storageReason(e)) {
    const waitMs = Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? e.retryAfterMs : 0;
    if (schemaReason(e)) return { title: 'Сервер обновляет базу данных — команда не выполнена', note: 'Обычно это секунды — повторите. Правки руками ждут в очереди', waitMs };
    return { title: STORAGE_DOWN_AGENT_WORDS.title, note: STORAGE_DOWN_AGENT_WORDS.note.replace(/\s*[.]\s*$/, ''), waitMs };
  }
  const [title, hint] = known || [ownOk ? own : 'Агент на сервере не справился с командой', 'Повторите или скажите иначе.'];
  const bits = [];
  if (known && ownOk && !OWN_SILENT.has(e.code) && own !== title && !own.startsWith(title)) bits.push(own.replace(/\s*[.:;]\s*$/, ''));
  /* Пауза Retry-After — только от самого сервера агента (очередь, предохранитель модели).
     Упавший сервер nginx помечает тем же заголовком, но там ждать нечего: повтор спросит
     заново, жив ли он. */
  const fromProxy = e.code === 'upstream_down' || e.code === 'upstream_timeout' || e.code === 'network';
  const waitMs = !fromProxy && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? e.retryAfterMs : 0;
  // срок повтора считает сама кнопка «Повторить через N с» — в тексте он застыл бы
  if (hint) bits.push(hint.replace(/\s*[.]\s*$/, ''));
  return { title, note: bits.join(' · '), waitMs };
}

/* ------------------------- dropped: что не применилось и почему ------------------------- */

/* Мужские имена на -а/-я и общие, по которым род не угадать: глагол тогда — «удалил(а)». */
const MALE_A = new Set(['никита', 'илья', 'кузьма', 'фома', 'лука', 'миша', 'паша', 'гоша', 'вова', 'дима',
  'лёша', 'леша', 'коля', 'толя', 'петя', 'ваня', 'серёжа', 'сережа', 'митя', 'федя', 'юра', 'гриша', 'костя',
  'алёша', 'алеша', 'стёпа', 'степа', 'боря', 'гена', 'жора', 'сёма', 'сема', 'тёма', 'тема', 'вася', 'лёва', 'лева',
  'добрыня', 'савва', 'данила', 'фока', 'ерёма', 'кирюша', 'андрюша', 'миха']);
const ANY_A = new Set(['саша', 'женя', 'валя', 'шура', 'слава', 'стася', 'сима', 'тоша', 'мира']);

/**
 * Имя в родительном падеже — «правки Бориса», «правки Ани» (круг 31). Склоняем только
 * одиночное кириллическое имя по окончанию; несклоняемое и составное — как есть, в кавычках
 * подписи не нуждается: «правки (Анна Ковалёва)».
 * @param {string} name
 * @returns {string|null} null — склонить не взялись
 */
export function nameGenitive(name) {
  const n = cleanText(name);
  if (!n || /\s/.test(n) || !/^[А-ЯЁа-яё-]+$/.test(n)) return null;
  const low = n.toLowerCase();
  const last = low.slice(-1);
  const prev = low.slice(-2, -1);
  if (/[бвгджзклмнпрстфхцчшщ]/.test(last)) return n + 'а';
  if (last === 'й' || last === 'ь') return MALE_A.has(low) || /[ая]$/.test(low) ? null : n.slice(0, -1) + 'я';
  if (last === 'я') return n.slice(0, -1) + 'и';
  if (last === 'а') return n.slice(0, -1) + (/[гкхжчшщ]/.test(prev) ? 'и' : 'ы');
  return null;
}

/** «правки Бориса» / «правки агента» / «правки (Анна Ковалёва)» — чья правка. */
export function editOf(who) {
  if (!who) return 'чужой правки';
  if (who.author_kind === 'agent') return 'правки агента';
  const name = cutText(cleanText(who.author), 40, { ellipsis: true });
  if (!name) return 'чужой правки';
  const g = nameGenitive(name);
  return g ? `правки ${g}` : `правки (${name})`;
}

/**
 * Глагол прошедшего времени в роде автора: «Аня удалила», «Борис удалил», «Агент удалил».
 * Род по имени угадывается по окончанию; где не угадать — «удалил(а)».
 * @param {{author?: string, author_kind?: string}|null} who
 * @param {string} verb мужская форма: «удалил»
 * @returns {string} «Аня удалила» / «кто-то удалил»
 */
export function whoDid(who, verb) {
  if (!who) return `кто-то ${verb}`;
  if (who.author_kind === 'agent') return `агент ${verb}`;
  if (who.author_kind === 'system') return `система ${verb}а`;
  const name = cutText(cleanText(who.author), 40, { ellipsis: true });
  if (!name) return `кто-то ${verb}`;
  const first = name.split(' ')[0].toLowerCase();
  if (ANY_A.has(first)) return `${name} ${verb}(а)`;
  if (/[ая]$/.test(first) && !MALE_A.has(first)) return `${name} ${verb}а`;
  return `${name} ${verb}`;
}

/**
 * Круг 33, п.7. Подпись правки пишет вкладка автора в мужском роде («Загрузил «Б»»). В словах
 * о другом человеке глагол согласуется с ним: «Аня отменила правку — загрузила «Б»», а не
 * «— загрузил». Первое слово подписи — глагол прошедшего времени на «-л»; иначе — как есть.
 * @param {{author?: string, author_kind?: string}|null} who
 * @param {string} phrase
 */
export function agreeVerb(who, phrase) {
  const s = String(phrase == null ? '' : phrase);
  const m = /^([А-ЯЁа-яё]+л)(?=[\s:,.]|$)/.exec(s);
  if (!m || !who) return s;
  const word = m[1];
  const said = whoDid(who, word.toLowerCase());
  const verb = said.slice(said.lastIndexOf(' ') + 1);
  const cased = word.charAt(0) === word.charAt(0).toUpperCase() ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
  return cased + s.slice(word.length);
}

/** Какой правки касалась отброшенная операция: существительное и согласованный глагол. */
/** create с непустым списком детей — «сгруппировать» существующие слои. */
const isGroupCreate = (op) => !!(op && op.op === 'create' && op.node && Array.isArray(op.node.children) && op.node.children.length);

function droppedSubject(op, nameOf) {
  const o = op && typeof op === 'object' ? op : {};
  const nm = (id) => {
    const n = cutText(cleanText(typeof nameOf === 'function' ? nameOf(id) : ''), 40, { ellipsis: true });
    return n ? ` «${n}»` : '';
  };
  switch (o.op) {
    case 'set':
      if (o.path === 'name') {
        /* Своё же переименование уже видно в имени слоя: «Переименование «Карточка Ани»» о
           слое, который был «Карточкой встречи», — путаница. Тогда говорим, во что. */
        const now = typeof nameOf === 'function' ? cleanText(nameOf(o.id)) : '';
        const to = cutText(cleanText(o.value), 40, { ellipsis: true });
        if (to && (!now || now === cleanText(o.value))) return { noun: `Переименование в «${to}»`, failed: 'не применилось' };
        return { noun: `Переименование${nm(o.id)}`, failed: 'не применилось' };
      }
      return { noun: `Правка${nm(o.id)}`, failed: 'не применилась' };
    case 'move': return { noun: `Перенос${nm(o.id)}`, failed: 'не применился' };
    case 'create': {
      const n = cutText(cleanText(o.node && (o.node.name || o.node.text)), 40, { ellipsis: true });
      // круг 39: «сгруппировать» (create с перечисленными детьми, wrapOps) — это обёртка, не новый слой
      if (isGroupCreate(o)) return { noun: `Рамка${n ? ` «${n}»` : ''}`, failed: 'не создана' };
      return { noun: `Добавление${n ? ` «${n}»` : ' слоя'}`, failed: 'не применилось' };
    }
    case 'remove': return { noun: `Удаление${nm(o.id)}`, failed: 'не применилось' };
    case 'setToken': return { noun: 'Правка шкалы', failed: 'не применилась' };
    default: return { noun: 'Правка', failed: 'не применилась' };
  }
}

/**
 * Круг 41 (арх. Н2): почему «Сохранить как новый проект» не удалось — словами оболочки по коду
 * и статусу ответа; текст сервера (create_id, тело запроса…) человеку не показываем.
 * @param {{status?: number, code?: string, detail?: object, retryable?: boolean}|Error} e
 * @returns {string} строчными, без точки
 */
export function rescueFailWords(e) {
  const x = e && typeof e === 'object' ? e : {};
  const d = x.detail && typeof x.detail === 'object' ? x.detail : {};
  const st = Number(x.status) || 0;
  if (st === 0 && (x instanceof TypeError || /fetch|network|сеть|связ/i.test(String(x.message || '')))) return 'нет связи с сервером';
  if (st === 409) return 'сервер уже создал проект по прошлой попытке, а документ с тех пор изменился';
  if (st === 413 || x.code === 'too_large') return 'документ больше, чем сервер принимает за раз';
  if (d.limit === 'expand_nodes' || x.limit === 'expand_nodes') return 'в документе слишком много вложенных экземпляров';
  if (d.limit === 'doc_nodes' || x.limit === 'doc_nodes') return 'документ упёрся в предел числа слоёв';
  if (st === 400) return 'сервер не принял документ';
  if (st === 503 && (d.cause === 'storage' || d.storage === 'down' || d.cause === 'timeout')) return 'база данных сервера недоступна';
  if (st === 503 && d.cause === 'schema') return 'сервер обновляет базу данных';
  if (st === 503 && d.cause === 'engine') return 'сервер ещё на прежней версии редактора';
  if (st === 503 || st === 429 || x.code === 'busy') return 'сервер занят';
  if (st === 426) return 'вышла новая версия редактора — обновите страницу';
  if (st >= 500) return 'сервер не ответил как надо';
  if (x.retryable === false && x.message && !isJargon(x.message)) return cleanText(x.message).replace(/[.\s]+$/u, '');
  return 'сервер не ответил как надо';
}

/**
 * Круг 43: спасение сохранилось новым проектом, а первая попытка — отдельным (409: её ключ занят
 * проектом с прежним документом; или тело первой попытки не пережило перезагрузку). Говорим, что
 * он есть и где его узнать; круг 45 — в «Проектах» его можно удалить кнопкой (пустой, свой ключ).
 * @param {{name?: string, certain?: boolean}} o
 */
export function rescueOrphanWords(o = {}) {
  const name = cutText(cleanText(o.name || ''), 60, { ellipsis: true }) || 'Без названия';
  return o.certain
    ? `Первая попытка тоже сохранилась — отдельным проектом «${name}» без последних правок. В «Проектах» он помечен «первая попытка»; работа — в открытом сейчас.`
    : `Если первая попытка всё же успела сохраниться, в «Проектах» будет ещё один «${name}» без последних правок — он помечен «первая попытка»; работа — в открытом сейчас.`;
}

/**
 * Подсказка, по которой проект списка похож на пустую первую попытку спасения (круг 43), или null.
 * Круг 45: список сервиса отдаёт `created_at`; прежний сервис его не отдаёт — у пустого проекта
 * `updated_at` совпадает со временем создания, берём его. У подсказки может быть `createId` —
 * ключ первой попытки: им сирота удаляется (`DELETE /api/projects/:id`).
 */
export function rescueOrphanHint(p, hints = []) {
  if (!p || typeof p !== 'object' || Number(p.head_seq || 0) !== 0) return null;
  const at = Date.parse(p.created_at || p.updated_at || '');
  if (!Number.isFinite(at)) return null;
  const fits = (Array.isArray(hints) ? hints : []).filter((h) => h && p.id !== h.keep && cleanText(p.name) === cleanText(h.name)
    && at >= (Number(h.since) || 0) - 60 * 1000 && at <= (Number(h.at) || Date.now()) + 1000);
  // две попытки с одним именем: окна могут перекрыться — берём ту, чьё начало ближе всех ко времени
  // создания проекта (первая попытка создаётся сразу после начала). Не «последнюю до создания»: часы
  // сервера, отстающие на секунды, отдали бы сироте второй попытки ключ первой (критик кода r45c)
  let best = null;
  let bestD = Infinity;
  for (const h of fits) {
    const d = Math.abs(at - (Number(h.since) || 0));
    if (d < bestD) { best = h; bestD = d; }
  }
  return best;
}

/**
 * Круг 45, проход 3 (UX r45c): пометка сирот по всему списку — одна подсказка помечает не больше
 * ОДНОЙ строки. Одноимённую пустую попытку соавтора (или другой вкладки) в том же окне иначе
 * назвали бы «своей первой попыткой» с кнопкой «Удалить». Строка подсказке — ближайшая по времени
 * создания к началу спасения (`since`); строки из `h.not` (сервер ответил «не этот create_id») —
 * не её. → Map id → подсказка.
 */
export function rescueOrphanMatches(list = [], hints = []) {
  /* Назначение по каждому имени — оптимальное, а не жадное (критик кода r45d): подсказки по началу
     спасения и строки по времени создания идут в одном порядке, поэтому лучшее назначение сохраняет
     порядок; динамика — сначала больше пар, затем меньше сумма расстояний. Жадное «ближайшая пара
     первой» при h1 = t0, h2 = t0+10 с и строках t0+6 с, t0+30 с отдавало обе строки чужим ключам. */
  const timeOf = (p) => Date.parse((p && (p.created_at || p.updated_at)) || '');
  const out = new Map();
  const groups = new Map();
  for (const h of Array.isArray(hints) ? hints : []) {
    if (!h || typeof h.name !== 'string') continue;
    const k = cleanText(h.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  for (const [name, hs] of groups) {
    hs.sort((a, b) => (Number(a.since) || 0) - (Number(b.since) || 0));
    const rows = (Array.isArray(list) ? list : []).filter((p) => p && cleanText(p.name) === name && hs.some((h) => rescueOrphanHint(p, [h]) === h))
      .sort((a, b) => timeOf(a) - timeOf(b));
    const fits = (h, p) => !(Array.isArray(h.not) && h.not.includes(p.id)) && rescueOrphanHint(p, [h]) === h;
    const H = hs.length;
    const R = rows.length;
    // dp[i][j] = [пар, сумма] для первых i подсказок и j строк; лучше — больше пар, при равенстве меньше сумма
    const better = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] < b[1]);
    const dp = Array.from({ length: H + 1 }, () => Array.from({ length: R + 1 }, () => [0, 0]));
    const how = Array.from({ length: H + 1 }, () => new Array(R + 1).fill(0));
    for (let i = 0; i <= H; i++) {
      for (let j = 0; j <= R; j++) {
        if (!i && !j) continue;
        let best = null;
        let via = 0;
        if (i > 0) { best = dp[i - 1][j]; via = 1; }
        if (j > 0 && (!best || better(dp[i][j - 1], best))) { best = dp[i][j - 1]; via = 2; }
        if (i > 0 && j > 0 && fits(hs[i - 1], rows[j - 1])) {
          const prev = dp[i - 1][j - 1];
          const cand = [prev[0] + 1, prev[1] + Math.abs(timeOf(rows[j - 1]) - (Number(hs[i - 1].since) || 0))];
          if (better(cand, best)) { best = cand; via = 3; }
        }
        dp[i][j] = best;
        how[i][j] = via;
      }
    }
    for (let i = H, j = R; i > 0 || j > 0;) {
      const v = how[i][j];
      if (v === 3) { out.set(rows[j - 1].id, hs[i - 1]); i--; j--; } else if (v === 1) i--; else j--;
    }
  }
  return out;
}

/** Тело первой попытки спасения хранится до стольких символов JSON: больше — sessionStorage может не принять. */
export const RESCUE_BODY_KEEP = 1_500_000;

/**
 * Запись задания спасения для sessionStorage (круг 43; круг 45 — вынесено из app.js ради
 * поведенческого теста, мутант RS2). Тело создания хранится только у одной пачки, пока проекта
 * нет, и только до `keep` символов: с ним повтор после перезагрузки идёт тем же create_id.
 * → {rec, body, full, lean}: `full` — строка с телом (если есть), `lean` — без него (запас, когда
 * хранилище не приняло полную).
 */
export function rescueMemo(job, { from = '', sig = '', now = Date.now(), keep = RESCUE_BODY_KEEP } = {}) {
  let body = '';
  try {
    if (job && !job.project && job.plan && job.plan.whole && job.plan.body) {
      const text = JSON.stringify(job.plan.body);
      if (text.length <= keep) body = text;
    }
  } catch { body = ''; }
  const rec = {
    from, project: job && job.project ? { id: job.project.id, name: job.project.name || '' } : null,
    create_id: (job && job.createId) || '', body_sig: (job && job.bodySig) || '',
    done: job ? job.done : 0, total: job ? job.total : 0, sig, at: now, started_at: (job && job.startedAt) || now,
    ...(job && job.orphan ? { orphan: job.orphan } : {}),
  };
  const lean = JSON.stringify(rec);
  return { rec, body, lean, full: body ? JSON.stringify({ ...rec, body }) : lean };
}

/** Похоже ли, что проект списка — пустая первая попытка спасения (помета в «Проектах», круг 43). */
export function isRescueOrphan(p, hints = []) {
  return !!rescueOrphanHint(p, hints);
}

/** Круг 45: итог удаления сироты словами (`status` ответа или ошибки DELETE). */
export function orphanDeleteWords(name, e = null) {
  const n = cutText(cleanText(name || ''), 60, { ellipsis: true }) || 'Без названия';
  if (!e) return `Удалил пустую первую попытку «${n}».`;
  const d = (e && e.detail) || {};
  if (e.status === 409 && d.cause === 'not_empty') return `«${n}» не удалил: в нём уже есть правки.`;
  if (e.status === 409) return `«${n}» не удалил: это не первая попытка из этой вкладки.`;
  if (e.status === 404) return `«${n}» уже удалён.`;
  if (e.status === 405 || e.status === 501) return `«${n}» не удалил: сервер ещё не умеет удалять проекты.`;
  return `«${n}» не удалил: ${rescueFailWords(e)}.`;
}

/**
 * Круг 43: строка «Истории» по применённому. Не легла часть операций — «Обернул 2 слоя ·
 * не легло 1 из 3»; не легло ничего — «… — не применилась». Подпись записи задаётся до
 * слияния, поэтому честность — по `ops_count`/`dropped_count` журнала (или своей записи).
 * @param {string} text подпись (что сделано)
 * @param {{ops?: number, dropped?: number}} n
 */
export function appliedLine(text, { ops = 0, dropped = 0 } = {}) {
  const t = String(text || '').trim() || 'Правка';
  const d = Math.max(0, Number(dropped) || 0);
  const a = Math.max(0, Number(ops) || 0);
  if (!a && d) return `${t} — не применилась`;
  if (!d) return t;
  return `${t} · не легло ${d} из ${a + d}`;
}

/**
 * Круг 45 (UX r44): порядок ленты «Истории» — один у всех соавторов. Чужие — по `seq` подтверждения
 * (новые сверху; без номера — по времени). Свои идут в порядке стека отмены, а между чужими встают по
 * `seq` своей подтверждённой записи; неподтверждённая своя (ещё в пути) — новее всего подтверждённого.
 * Прежде свои вставали по времени ВКЛАДКИ: офлайн-правка Ани оказывалась ниже правки Бориса,
 * легшей раньше, а у Бориса — наоборот.
 * @param {{at?: number, seq?: number|null}[]} own стек отмены, от старых к новым
 * @param {{seq?: number, created_at?: string}[]} others чужие записи журнала
 * @returns {{own?: number, other?: number}[]} индексы в исходных списках, новые сверху
 */
export function historyOrder(own = [], others = []) {
  const timeOf = (t) => { const v = Date.parse((t && t.created_at) || ''); return Number.isFinite(v) ? v : 0; };
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const theirs = others.map((t, i) => ({ i, seq: num(t && t.seq), at: timeOf(t) }))
    .sort((a, b) => (a.seq !== null && b.seq !== null ? b.seq - a.seq : b.at - a.at));
  const out = [];
  let k = 0;
  for (let j = own.length - 1; j >= 0; j--) {
    const tx = own[j] || {};
    const seq = num(tx.seq);
    const at = Number(tx.at) || 0;
    // чужая выше своей, если она новее: по номерам, когда они есть у обеих; своя без номера — в пути
    const newer = (o) => (seq !== null && o.seq !== null ? o.seq > seq : seq === null && tx.pending ? false : o.at >= at);
    while (k < theirs.length && newer(theirs[k])) out.push({ other: theirs[k++].i });
    out.push({ own: j });
  }
  while (k < theirs.length) out.push({ other: theirs[k++].i });
  return out;
}

/**
 * Круг 45 (критик кода r45 Д1/Д2): ключи своих записей для `historyOrder`. Правка из нескольких частей
 * встаёт по НОВЕЙШЕЙ части: соавтор видит её строку журнала с номером последней части, и порядок
 * у обоих должен совпасть. Номер берётся из журнала по частям правки (`id`, `parts`; не отмены),
 * без журнала — из `seq` самой записи.
 * @param {{id?: string, at?: number, seq?: number, pending?: boolean, parts?: string[], lastParts?: string[]}[]} history
 * @param {{tx_id?: string, seq?: number}[]} journal
 * @returns {{at: number, seq: number|null, pending: boolean}[]}
 */
export function ownHistoryKeys(history = [], journal = []) {
  const seqOf = new Map();
  for (const t of journal || []) if (t && t.tx_id && Number.isFinite(t.seq)) seqOf.set(t.tx_id, t.seq);
  return (history || []).map((tx) => {
    // только части самой правки: отмена или повтор (lastTx, lastParts) у соавтора — своя строка «Отменил»,
    // а правка остаётся на своём номере (критик кода r45b Д1′)
    const ids = [tx && tx.id, ...((tx && tx.parts) || [])].filter(Boolean);
    let seq = null;
    for (const id of ids) { const v = seqOf.get(id); if (Number.isFinite(v) && (seq === null || v > seq)) seq = v; }
    if (seq === null && Number.isFinite(tx && tx.seq)) seq = tx.seq;
    return { at: Number(tx && tx.at) || 0, seq, pending: !!(tx && tx.pending) };
  });
}

/** «52 008» — тысячи через неразрывный пробел. */
export function countWords(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

/**
 * Круг 41 (UX Д6): документ сверх предела раскрытия экземпляров (core.expandProblem) — отказ
 * импорта словами, как у сервиса: до записи, документ прежний.
 * @param {{cost?: number, max?: number}} p
 */
export function expandLimitWords(p = {}) {
  const cost = Number.isFinite(p.cost) ? p.cost : null;
  const max = Number.isFinite(p.max) ? p.max : null;
  return {
    title: 'Файл не загружен: слишком много вложенных экземпляров',
    note: `${cost && max ? `Экземпляры компонентов раскрылись бы в ${countWords(cost)} слоёв — больше предела ${countWords(max)}. ` : ''}`
      + 'Документ остался прежним. Удалите из файла лишние экземпляры или разберите тяжёлый компонент.',
  };
}

/** Причина отказа словами; who — кто помешал (для removed/orphan). */
function droppedReason(d, who, many) {
  const reason = d && (d.limit || d.reason);
  // круг 39: группа, все слои которой удалены (core.rebase отбросил пустую рамку)
  if (reason === 'removed' && !many && isGroupCreate(d.op)) {
    return who ? `${whoDid(who, 'удалил')} слои, которые в неё входили` : 'слоёв, которые в неё входили, уже нет';
  }
  switch (reason) {
    case 'removed':
      return who ? `${whoDid(who, 'удалил')} ${many ? 'эти слои' : 'этот слой'}` : (many ? 'эти слои уже удалены' : 'этот слой уже удалён');
    case 'orphan':
      return who ? `${whoDid(who, 'удалил')} слой, куда он добавлялся` : 'слой, куда он добавлялся, уже удалён';
    case 'cycle': return 'перенос положил бы слой внутрь самого себя';
    case 'exists': return 'такой слой уже есть';
    case 'stale':
      return who
        ? `с тех пор ${whoDid(who, 'изменил')} то же самое, а эта правка сделана до восстановления базы из резервной копии`
        : 'правка сделана до восстановления базы из резервной копии, а документ с тех пор другой';
    /* Круг 41 (UX Д5): пределы и «не подошла» — словами реплики (DROP_WORDS, одна истина),
       без местоимения: подлежащее бывает «Добавление», «Перенос», «Правка» — «она» не про всех. */
    default: return DROP_WORDS[reason] || DROP_WORDS.invalid;
  }
}

/**
 * Отброшенное сервером (§9.1 `dropped`) — человеку конкретно (круг 25, п.5): что, почему
 * и кто помешал. «Переименование «Карточка встречи» не применилось — Аня удалила этот
 * слой». «Остальное применено» — только если применять было что.
 *
 * @param {{
 *   dropped: object[],                  // записи dropped: {index, op, reason, limit?, by?, label?} и {more}
 *   applied?: number,                   // сколько операций транзакции легло
 *   nameOf?: (id: string) => string,    // имя слоя (в том числе уже удалённого)
 *   whoOf?: (d: object) => object|null, // кто помешал: d.by или whoRemoved реплики
 *   agent?: boolean,                    // транзакция агента: «Часть правки агента…»
 * }} o
 * @returns {{title: string, note: string, stale: boolean}}
 */
export function droppedWords({ dropped = [], applied = 0, nameOf = null, whoOf = null, agent = false } = {}) {
  const list = (Array.isArray(dropped) ? dropped : []).filter((d) => d && typeof d === 'object');
  const real = list.filter((d) => !(typeof d.more === 'number' && d.index === undefined && d.reason === undefined));
  const more = list.reduce((n, d) => n + (real.includes(d) ? 0 : Math.max(0, d.more || 0)), 0);
  const total = real.length + more;
  const first = real[0] || {};
  const reasonOf = (d) => d.limit || d.reason || 'invalid';
  const sameReason = real.every((d) => reasonOf(d) === reasonOf(first));
  const who = (d) => (d && d.by && typeof d.by === 'object' ? d.by : (typeof whoOf === 'function' ? whoOf(d) : null));
  const firstWho = who(first);
  const sameWho = real.every((d) => {
    const w = who(d);
    return (w && w.author) === (firstWho && firstWho.author) && (w && w.author_kind) === (firstWho && firstWho.author_kind);
  });
  const stale = reasonOf(first) === 'stale';
  let title;
  if (total <= 1) {
    const subj = droppedSubject(first.op, nameOf);
    const noun = agent ? `${subj.noun} от агента` : subj.noun;
    title = `${noun} ${subj.failed} — ${droppedReason(first, firstWho, false)}`;
  } else {
    const head = agent
      ? `${total} ${plural(total, 'правка агента не применилась', 'правки агента не применились', 'правок агента не применились')}`
      : `${total} ${plural(total, 'правка не применилась', 'правки не применились', 'правок не применились')}`;
    title = sameReason
      ? `${head} — ${droppedReason(first, sameWho ? firstWho : null, true)}`
      : `${head}: ${[...new Set(real.map((d) => droppedReason(d, null, false)))].slice(0, 2).join('; ')}`;
  }
  const notes = [];
  if (applied > 0) notes.push('Остальное в правке применено.');
  if (stale) notes.push('Посмотрите на холст и при необходимости сделайте правку заново.');
  // круг 41 (UX Д5): предел раскрытия экземпляров — что делать
  if (real.some((d) => reasonOf(d) === 'expand_nodes')) {
    const d = real.find((x) => reasonOf(x) === 'expand_nodes');
    const cost = d && Number.isFinite(d.cost) ? d.cost : null;
    const max = d && Number.isFinite(d.max) ? d.max : null;
    const lim = max || CORE_NS.MAX_EXPANDED_NODES;
    const nums = cost && max ? `Раскрытие дало бы ${countWords(cost)} слоёв — предел ${countWords(max)}. `
      : lim ? `Экземпляры компонентов раскрываются в слои, и их не может быть больше ${countWords(lim)}. ` : '';
    notes.push(`${nums}Удалите лишние экземпляры или разберите тяжёлый компонент.`);
  }
  return { title, note: notes.join(' '), stale };
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
      note = `Документ упёрся в предел — ${num(limits.docNodes || 20000)} слоёв. Удалите лишнее, тогда новое ляжет.`;
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
export function stoppedWriteWords(tx, utterance = '', platform = {}) {
  const what = String((tx && tx.title) || utterance || '').trim();
  const short = what.length > 80 ? `${what.slice(0, 79)}…` : what;
  // круг 39: клавиша — по платформе, на телефоне без клавиш — только кнопка
  const key = keyLabel('Mod+Z', platform);
  const how = `Отменить — кнопкой «Отменить»${key ? ` или ${key}` : ''}.`;
  return {
    title: 'Агент успел записать правку до остановки — можно отменить',
    // круг 29, п.7: кнопка стоит справа от текста на широком экране и под ним на узком —
    // «кнопкой ниже» было неправдой на половине экранов; называем её саму
    note: short ? `«${short}» уже на холсте. ${how}` : how,
  };
}

/* -------------------- круг 27: оборванный поток и «стоп» без DOM -------------------- */

/**
 * Транзакция команды, которая пришла по сокету РАНЬШЕ, чем оборвался поток (круг 27, п.1):
 * Hub разослал её, а итог `result` до вкладки не дошёл. Она лежит среди «пришедших без
 * итога» (`arrived`: tx_id → {tx, mine, at}); не найти её здесь — значит объявить команду
 * невыполненной, а после «Повторить» записать её второй раз.
 *
 * Узнаём по `command_id` в транзакции. Без него (Orchestrator прежней версии) — своя
 * транзакция агента (`mine`), пришедшая после начала команды.
 * @param {Map<string, {tx: object, mine?: boolean, at?: number}>|Iterable} arrived
 * @param {{commandId?: string, startedAt?: number}} o
 * @returns {string|null} tx_id или null
 */
export function arrivedTxOf(arrived, { commandId = '', startedAt = 0 } = {}) {
  if (!arrived) return null;
  for (const [id, got] of arrived) {
    const tx = got && got.tx;
    if (!tx) continue;
    if (tx.command_id) {
      if (commandId && tx.command_id === commandId) return id;
      continue;
    }
    if (got.mine && Number(got.at) >= Number(startedAt || 0)) return id;
  }
  return null;
}

/** Сроки ожидания оборванной команды (app.js: awaitDetached). */
export const DETACHED_TIMES = Object.freeze({ waitMs: 25000, probeMs: 2500, downGraceMs: 5000 });

/**
 * Один шаг проверки оборванной команды (круг 25, п.3; круг 26 — instance; круг 27, п.1 —
 * сначала пришедшая транзакция). Решение без DOM и таймеров: оболочка зовёт его на входе
 * и после каждого ответа `/agent/health`.
 *
 *   • транзакция команды уже пришла (`arrivedId`) → `arrived` — что бы ни ответил health;
 *   • health ok с другим instance → `lost: restarted`; тот же instance → ждать полный срок;
 *   • instance неизвестен: был недоступен и снова ok → `restarted`; не отвечает дольше
 *     downGraceMs → `down` (если связь пропала у всей вкладки — ждём полный срок);
 *   • срок вышел → `lost: down|silent`.
 *
 * `d` — состояние ожидания {at, instance, wasDown, downSince, netDown}; функция дописывает в
 * него то, что узнала (wasDown, downSince, netDown, instance).
 * @param {object} d
 * @param {{health?: object|null, netDown?: boolean, now?: number, arrivedId?: string|null, times?: object}} o
 * @returns {{verdict: 'arrived', txId: string}|{verdict: 'lost', why: 'restarted'|'down'|'silent'}|{verdict: 'wait'}}
 */
export function detachedVerdict(d, o = {}) {
  const { netDown = false, now = Date.now(), arrivedId = null, times = DETACHED_TIMES } = o || {};
  if (arrivedId) return { verdict: 'arrived', txId: arrivedId };
  if (!o || o.health === undefined) return { verdict: 'wait' };   // проверки ещё не было — только транзакция
  const health = o.health;
  const t = { ...DETACHED_TIMES, ...(times || {}) };
  const ok = !!(health && health.ok);
  const inst = ok && typeof health.instance === 'string' ? health.instance : '';
  if (inst && d.instance) {
    if (inst !== d.instance) return { verdict: 'lost', why: 'restarted' };
    if (now - d.at >= t.waitMs) return { verdict: 'lost', why: 'silent' };
    return { verdict: 'wait' };
  }
  if (inst && !d.instance && !d.wasDown) d.instance = inst;
  if (netDown) d.netDown = true;
  if (!ok) {
    d.wasDown = true;
    if (!d.downSince) d.downSince = now;
  }
  if (!d.netDown) {
    if (ok && d.wasDown) return { verdict: 'lost', why: 'restarted' };
    if (!ok && now - d.downSince >= t.downGraceMs) return { verdict: 'lost', why: 'down' };
  }
  if (now - d.at >= t.waitMs) return { verdict: 'lost', why: ok ? 'silent' : 'down' };
  return { verdict: 'wait' };
}

/**
 * Что сказать, когда прогон кончился «стопом» (круг 27, п.2). Если транзакция команды
 * пришла ещё до «стопа», оболочка уже сказала «агент успел записать — можно отменить»
 * (`settled`): «Команда остановлена» с возвратом текста в строку затёрло бы правду, и
 * «Повторить» записал бы её второй раз.
 * @param {{settled?: boolean, replacing?: boolean}} o
 * @returns {'settled'|'replaced'|'cancelled'}
 */
export function stoppedRunVerdict({ settled = false, replacing = false } = {}) {
  if (settled) return 'settled';
  if (replacing) return 'replaced';
  return 'cancelled';
}

/**
 * Есть ли в документе что-то, кроме служебного: корневой страницы и библиотеки компонентов
 * (круг 27, I7). Новый пустой проект мигрировать — не «документ из прежней версии».
 * @param {{root?: string, nodes?: object}} doc
 * @returns {number} сколько пользовательских узлов
 */
export function userNodeCount(doc) {
  if (!doc || !doc.nodes) return 0;
  let n = 0;
  for (const node of Object.values(doc.nodes)) {
    if (!node || node.id === doc.root) continue;
    if (node.type === 'page' && node.parent === doc.root && (node.role === 'library' || CORE_NS.isLibrary?.(doc, node))) continue;
    n++;
  }
  return n;
}

/**
 * Сервер агента перезапускается (I6, `shutting_down`): команда не выполнена — и та, что шла,
 * и те, что ждали очереди.
 * @param {string[]} [queued] тексты команд, что стояли в очереди вкладки
 */
export function shuttingDownWords(queued = []) {
  const list = (Array.isArray(queued) ? queued : []).map((t) => cutText(cleanText(t), 40, { ellipsis: true })).filter(Boolean);
  const more = list.length
    ? ` Не выполнены и ${list.length === 1 ? 'команда' : 'команды'} из очереди: ${list.map((t) => `«${t}»`).join(', ')} — «Повторить» выполнит все по порядку.`
    : '';
  return {
    title: 'Сервер агента перезапускается — команда не выполнена',
    note: `Текст команды остался в строке — повторите через несколько секунд.${more}`,
  };
}

/** Сеть пропала у самой вкладки (navigator.onLine): дело не в сервере агента (круг 27, п.7). */
export const OFFLINE_WORDS = Object.freeze({
  title: 'Нет сети — команда не выполнена',
  note: 'Компьютер не в сети. Правки руками сохраняются в этой вкладке и уйдут на сервер, когда сеть вернётся; текст команды остался в строке.',
});

/**
 * Проект пропал с сервера (I3: базу восстановили из резервной копии, проект удалили), а
 * его вид у вкладки есть — работу можно сохранить новым проектом.
 */
export const PROJECT_GONE_WORDS = Object.freeze({
  title: 'Проекта больше нет на сервере',
  // круг 29: работа лежит в журнале браузера — переживает и перезагрузку страницы
  note: 'Например, базу восстановили из резервной копии. Ваша работа цела в этом браузере — и после перезагрузки страницы: сохраните её новым проектом.',
  action: 'Сохранить как новый проект',
});

/* ------------------- круг 31 (K1): большая правка — несколькими транзакциями ------------------- */

/** Предел части: операций — как у сервера (SPEC §9.8), байт — с запасом под 4 МБ тела. */
export const PART_MAX_OPS = 5000;
export const PART_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);

const utf8Len = (() => {
  const enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  return (str) => (enc ? enc.encode(str).length : unescape(encodeURIComponent(str)).length);
})();

/**
 * Разрезать список операций на части, каждая из которых сервер примет одной транзакцией
 * (K1). Части идут подряд в исходном порядке: применённые по очереди, они дают то же, что
 * весь список (родители создаются раньше детей — так уже упорядочены и инверсия удаления,
 * и импорт). `splitOps` ядра (если есть) — первым; его ответ берётся, только если он
 * сохраняет все операции. Одна операция больше предела байт — своей частью: сервер откажет
 * ей честно (too_large), а не всей правке.
 * @param {object[]} ops
 * @param {{maxOps?: number, maxBytes?: number, splitOps?: Function|null}} [o]
 * @returns {object[][]}
 */
export function splitOpsForServer(ops, { maxOps = PART_MAX_OPS, maxBytes = PART_MAX_BYTES, splitOps = null } = {}) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return [];
  if (typeof splitOps === 'function') {
    try {
      const got = splitOps(list, { maxOps, maxBytes });
      if (Array.isArray(got) && got.length && got.every((b) => Array.isArray(b) && b.length && b.length <= maxOps)
        && got.reduce((n, b) => n + b.length, 0) === list.length) return got;
    } catch { /* ядро не смогло — режем сами */ }
  }
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const op of list) {
    let b = 0;
    try { b = utf8Len(JSON.stringify(op)) + 1; } catch { b = 1; }
    if (cur.length && (cur.length >= maxOps || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(op);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Нужно ли резать правку на части (K1). */
export function needsParts(ops, { maxOps = PART_MAX_OPS, maxBytes = PART_MAX_BYTES } = {}) {
  const list = Array.isArray(ops) ? ops : [];
  if (list.length > maxOps) return true;
  if (list.length < 200) return false;   // мелкая правка 3,5 МБ не наберёт без огромных строк — проверим ниже
  let bytes = 0;
  for (const op of list) {
    try { bytes += utf8Len(JSON.stringify(op)) + 1; } catch { bytes += 1; }
    if (bytes > maxBytes) return true;
  }
  return false;
}

/** Подпись части большой правки: «Загрузил «X» · часть 2 из 3». */
export function partTitle(title, i, n) {
  const base = cleanText(title || '');
  return n > 1 ? `${base} · часть ${i + 1} из ${n}` : base;
}

/** Подпись без хвоста части — части одной правки сводятся в «Истории» в одну строку. */
export function partBase(title) {
  const t = cleanText(title || '');
  const m = /^(.*) · часть (\d+) из (\d+)$/.exec(t);
  return m ? { base: m[1], i: Number(m[2]) - 1, n: Number(m[3]) } : null;
}

/**
 * Часть большой правки записи журнала — `undo_part {i, n}` (круг 32: сервер его хранит и отдаёт
 * в рассылке и /history): i — номер с 0, n — частей (≥ 2). Негодное — null.
 * @param {{undo_part?: any}} t
 * @returns {{i: number, n: number}|null}
 */
export function undoPartOf(t) {
  const p = t && t.undo_part;
  if (!p || typeof p !== 'object') return null;
  const { i, n } = p;
  return Number.isInteger(i) && Number.isInteger(n) && n > 1 && i >= 0 && i < n ? { i, n } : null;
}

/**
 * Части одной большой правки — одной строкой «Истории» (круг 31, K1; точно — с круга 32).
 * Список — новые первыми; части одной правки ушли из одной вкладки подряд, так что в журнале
 * идут i = n−1, n−2, …, 0 (между ними могут стоять чужие записи). Часть узнаётся по
 * `undo_part {i, n}`, правка — по вкладке (`client`), общему `undo_of`/`redo_of` и `n`; следующая
 * (более старая) часть той же правки — ровно i − 1. Подпись — без хвоста «· часть i из n»,
 * операции и выпавшие — суммой, время и `tx_id` — новейшей части, `parts` — все tx_id.
 * Записи без `undo_part` (сервер прежней версии его не хранил) остаются как есть.
 * @param {object[]} list
 * @param {{empty?: (t: object) => boolean}} [o]
 * @returns {object[]}
 */
export function collapseParts(list, { empty = (t) => !!(t && t.empty) } = {}) {
  const out = [];
  const open = new Map();   // ключ правки → {row, next: какой i ждём}
  for (const t of Array.isArray(list) ? list : []) {
    const part = undoPartOf(t);
    if (!part) { out.push(t); continue; }
    const key = `${t.client || ''}|${t.undo_of || ''}|${t.redo_of || ''}|${part.n}`;
    const g = open.get(key);
    if (g && g.next === part.i) {
      const row = g.row;
      row.ops_count = (Number(row.ops_count) || 0) + (Number(t.ops_count) || 0);
      row.dropped_count = (Number(row.dropped_count) || 0) + (Number(t.dropped_count) || 0);
      row.empty = !!(row.empty && empty(t));
      row.parts.push(t.tx_id);
      g.next = part.i - 1;
      if (g.next < 0) open.delete(key);
      continue;
    }
    const p = partBase(t.title);
    // круг 33 (L2): partTop — номер новейшей пришедшей части; меньше n-1 — серия ещё не вся
    const row = { ...t, title: p && p.n === part.n ? p.base : cleanText(t.title || ''), partOf: key, parts: [t.tx_id], empty: empty(t), partTop: part.i, partN: part.n };
    out.push(row);
    if (part.i > 0) open.set(key, { row, next: part.i - 1 });
    else open.delete(key);
  }
  return out;
}

/** Сколько ждём следующую часть большой правки, прежде чем сказать «не завершена» (L2). */
export const PART_STALE_MS = 3 * 60 * 1000;

/**
 * Круг 33 (L2). Большая правка уходит частями, и атомарности серии на сервере нет: вкладка
 * автора могла закрыться после первой части. Остальные участники видят это по `undo_part`
 * в рассылке: пока последней части нет — «правка Ани в пути (1 из 3)»; новейшая часть старше
 * PART_STALE_MS — «правка Ани не завершена (1 из 3)». Строка из collapseParts; null — серия
 * целая (или это не серия).
 * @param {object} row строка collapseParts
 * @param {{now?: number, staleMs?: number, mine?: boolean}} [o]
 * @returns {{state: 'transit'|'stale', got: number, n: number, text: string}|null}
 */
export function partSeriesWords(row, { now = Date.now(), staleMs = PART_STALE_MS, mine = false } = {}) {
  if (!row || !Number.isInteger(row.partTop) || !Number.isInteger(row.partN)) return null;
  const n = row.partN;
  if (n < 2 || row.partTop >= n - 1 || row.partTop < 0) return null;
  const got = row.partTop + 1;
  const at = Date.parse(row.created_at || '');
  const stale = Number.isFinite(at) && now - at > staleMs;
  const whose = mine ? 'ваша правка' : `правка ${editOf(row).replace(/^правки\s+/, '')}`;
  const text = stale ? `${whose} не завершена (${got} из ${n})` : `${whose} в пути (${got} из ${n})`;
  return { state: stale ? 'stale' : 'transit', got, n, text };
}

/**
 * Замена документа целиком (импорт JSON в серверном режиме) — операциями (SPEC §8.3):
 * токены группами, снять всех детей корня, создать узлы нового документа сверху вниз
 * (родитель раньше детей, порядок братьев тот же, `exact` — узлы ложатся ровно такими, какие
 * в файле). Корень остаётся свой: удалить его нельзя, а дети нового корня приписываются к
 * нему. Список может быть больше предела транзакции — его режет splitOpsForServer (K1).
 * @param {object} cur  текущий документ
 * @param {object} nextDoc  документ из файла (уже проверенный adoptDoc)
 * @returns {object[]}
 */
export function replaceDocOps(cur, nextDoc) {
  const list = [];
  const tokens = nextDoc.tokens && typeof nextDoc.tokens === 'object' ? nextDoc.tokens : {};
  for (const group of Object.keys(tokens)) list.push({ op: 'setToken', path: group, value: tokens[group] });
  const rootNode = cur.nodes[cur.root];
  for (const id of ((rootNode && rootNode.children) || [])) list.push({ op: 'remove', id });
  const nextRoot = nextDoc.nodes[nextDoc.root];
  const stack = [];
  const kidsOf = (n) => (n && Array.isArray(n.children) ? n.children : []);
  for (let i = kidsOf(nextRoot).length - 1; i >= 0; i--) stack.push(kidsOf(nextRoot)[i]);
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    const n = nextDoc.nodes[id];
    if (!n || typeof n !== 'object' || seen.has(id)) continue;
    seen.add(id);
    const node = { ...n, parent: n.parent === nextDoc.root ? cur.root : n.parent };
    // дети придут своими операциями — узел создаём пустым, порядок даст порядок обхода
    if (Array.isArray(n.children)) node.children = []; else delete node.children;
    list.push({ op: 'create', node, exact: true });
    const kids = kidsOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return list;
}

/* ------------------------- круг 31: предел числа узлов у импорта ------------------------- */

/** Файл больше предела документа — словами, с числом узлов. */
export function importTooBigWords(count, max = 20000) {
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `Файл слишком большой: ${num(count)} ${plural(count, 'слой', 'слоя', 'слоёв')}, предел ${num(max)}`;
}

/* -------------- круг 29: «Сохранить как новый проект» для большого документа -------------- */

/** Пачка досылки — с запасом под пределом тела Document service и nginx (4 МБ, SPEC §9.8). */
export const RESCUE_TX_BYTES = Math.floor(3.5 * 1024 * 1024);
/** Операций в пачке — под пределом сервера (5000 на транзакцию). */
export const RESCUE_TX_OPS = 4000;

const enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
/** Байты UTF-8 строки (тело запроса меряется в байтах, а не в символах). */
export function utf8Bytes(str) {
  const s = String(str);
  if (enc) return enc.encode(s).length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Как сохранить документ новым проектом (арх. Д2, круг 29). Небольшой — одним
 * `POST /api/projects {name, doc}` (`whole`). Больше пачки — тело в 4 МБ не пролезло бы
 * (413), и работа пропавшего проекта не сохранялась бы вовсе: тогда проект создаётся с
 * «остовом» (корень без детей и шкалы — тот же корень, те же токены), а узлы досылаются
 * пачками `create` (exact — узел ложится ровно таким, каким был) в порядке родителей:
 * родитель раньше детей, братья — по порядку (create кладёт в конец списка детей). Каждая
 * пачка ≤ maxBytes байт JSON операций и ≤ maxOps операций; документ, собранный из остова и
 * пачек, совпадает с исходным по hashDoc (test/shell.test.mjs).
 *
 * @param {{root: string, nodes: object, tokens?: object, meta?: object}} doc
 * @param {{name?: string, maxBytes?: number, maxOps?: number}} [o]
 * @returns {{whole: boolean, body?: object, skeleton?: object, batches: object[][], nodes: number, bytes: number, oversize: string[]}}
 *   oversize — узлы, которые сами по себе больше пачки (их сервер не примет ни в какой пачке)
 */
export function rescuePlan(doc, { name = '', maxBytes = RESCUE_TX_BYTES, maxOps = RESCUE_TX_OPS } = {}) {
  if (!doc || !doc.nodes || !doc.root || !doc.nodes[doc.root]) throw new Error('документа нет');
  const whole = { name, doc };
  const wholeBytes = utf8Bytes(JSON.stringify(whole));
  if (wholeBytes <= maxBytes) return { whole: true, body: whole, batches: [], nodes: Object.keys(doc.nodes).length, bytes: wholeBytes, oversize: [] };
  const rootNode = doc.nodes[doc.root];
  const top = Array.isArray(rootNode.children) ? rootNode.children : [];
  /* Библиотека — в остове (пустой, дети придут пачками): проект без неё, открытый кем-то
     посреди досылки, получил бы от миграции оболочки вторую библиотеку. Остальные дети
     корня встают вокруг неё по своим местам (create с index). */
  const libId = top.find((id) => {
    const n = doc.nodes[id];
    return n && n.type === 'page' && (n.role === 'library' || (typeof CORE_NS.isLibrary === 'function' && CORE_NS.isLibrary(doc, n)));
  }) || null;
  const skeleton = {
    root: doc.root,
    nodes: { [doc.root]: { ...rootNode, children: libId ? [libId] : [] } },
    tokens: doc.tokens,
    ...(doc.meta ? { meta: doc.meta } : {}),
  };
  if (libId) skeleton.nodes[libId] = { ...doc.nodes[libId], children: [] };
  const batches = [];
  const oversize = [];
  let cur = [];
  let curBytes = 2;   // «[]»
  let total = 0;
  let count = 0;
  const seen = new Set([doc.root]);
  const kidsOf = (n) => (n && Array.isArray(n.children) ? n.children : []);
  const stack = [];
  const topIndex = new Map(top.map((id, i) => [id, i]));
  for (let i = top.length - 1; i >= 0; i--) stack.push(top[i]);
  while (stack.length) {
    const id = stack.pop();
    const n = doc.nodes[id];
    if (!n || typeof n !== 'object' || seen.has(id)) continue;
    seen.add(id);
    const kids0 = kidsOf(n);
    if (id === libId) {   // уже в остове — только дети
      for (let i = kids0.length - 1; i >= 0; i--) stack.push(kids0[i]);
      continue;
    }
    const node = { ...n };
    // дети придут своими операциями — узел создаём пустым, порядок даст порядок обхода
    if (Array.isArray(n.children)) node.children = []; else delete node.children;
    const op = { op: 'create', node, exact: true };
    // ребёнок корня — на своё место рядом с библиотекой из остова; прочие — в конец (по порядку)
    if (libId && n.parent === doc.root && topIndex.has(id)) op.index = topIndex.get(id);
    const b = utf8Bytes(JSON.stringify(op)) + 1;   // + запятая
    if (b + 2 > maxBytes) oversize.push(id);
    if (cur.length && (curBytes + b > maxBytes || cur.length >= maxOps)) {
      batches.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(op);
    curBytes += b;
    total += b;
    count += 1;
    const kids = kidsOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  if (cur.length) batches.push(cur);
  return { whole: false, skeleton, body: { name, doc: skeleton }, batches, nodes: count + 1, bytes: total, oversize };
}

/* --------------- круг 29, J6: подписи транзакций словами («как в Истории») --------------- */

/* Подписи ручных транзакций прежних версий — повелительные и безличные («Свойство»,
   «Удалить «X»»): опоздавший к истории читал их как команды. Здесь — в прошедшем времени. */
const LEGACY_TITLES = [
  [/^Свойство$/, 'Изменил свойство'],
  [/^Свойство «(.+)» у «(.+)»$/, 'Изменил свойство «$1» у «$2»'],
  [/^Свойство «(.+)»$/, 'Изменил свойство «$1»'],
  [/^Удалить (.+)$/, 'Удалил $1'],
  [/^Убрать свойство (.+)$/, 'Убрал свойство $1'],
  [/^Поставить (.+)$/, 'Поставил $1'],
  [/^Сделать компонентом (.+)$/, 'Сделал компонентом $1'],
  [/^Отсоединить (.+)$/, 'Отсоединил $1'],
  [/^Имя компонента (.+)$/, 'Переименовал компонент в $1'],
  [/^Вернуть в поток$/, 'Вернул в поток'],
  [/^Новая доска$/, 'Добавил новую доску'],
  [/^Шаг шкалы$/, 'Изменил шаг шкалы'],
  [/^Новый шаг шкалы$/, 'Добавил шаг шкалы'],
  [/^Правка$/, 'Изменил макет'],
  [/^Миграция формата$/, 'Обновил формат документа'],
  [/^(?:props|override|component\.props)$/, 'Изменил свойство'],
];

/**
 * Подпись транзакции журнала для «Истории» (J3/J6): своя подпись словами — как есть;
 * повелительная прежних версий — в прошедшем времени; «Отмена: …»/«Повтор: …» — «Отменил»/
 * «Вернул». Пусто — пусто (оболочка скажет «N изменений»).
 * @param {string} title
 * @returns {string}
 */
export function txTitleWords(title) {
  let t = cleanText(title);
  if (!t) return '';
  const undo = /^(Отмена|Повтор):\s*(.+)$/.exec(t);
  if (undo) {
    const inner = txTitleWords(undo[2]) || undo[2];
    return `${undo[1] === 'Отмена' ? 'Отменил' : 'Вернул'}: ${inner.charAt(0).toLowerCase()}${inner.slice(1)}`;
  }
  for (const [re, to] of LEGACY_TITLES) {
    if (re.test(t)) { t = t.replace(re, to); break; }
  }
  return t;
}

/**
 * Строка ленты стадий без служебного (круг 27, п.7): «Нет связи с моделью
 * (http://localhost:1234/v1): Failed to fetch» → «Нет связи с моделью». Адрес в скобках
 * и латинский хвост после двоеточия срезаются; если и после этого строка — жаргон, её нет.
 * @param {string} text
 * @returns {string}
 */
export function stageText(text) {
  let t = cleanText(text);
  if (!t) return '';
  t = t.replace(/\s*\((?:https?:\/\/|localhost|\d{1,3}\.)[^)]*\)/gi, '');
  t = t.replace(/\s*:\s*[A-Za-z][^А-Яа-яЁё]*$/, '');
  t = t.replace(/\s*https?:\/\/\S+/gi, '').trim();
  if (!t || /^[^А-Яа-яЁё]*$/.test(t)) return '';
  return t;
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
    // круг 27: что сделано, словами по операциям (= tx.title записи) — для «Истории»
    title: typeof x.title === 'string' ? x.title.trim() : '',
    // круг 39 (N5д): план — отдельно от итога (сервер прежней версии клал его в summary)
    plan: typeof x.plan === 'string' ? x.plan.trim() : (x.plan && typeof x.plan.summary === 'string' ? x.plan.summary.trim() : ''),
    warnings: Array.isArray(x.warnings) ? x.warnings.map((w) => String(w || '')).filter(Boolean) : [],
    select: Array.isArray(x.select) ? x.select.filter((id) => typeof id === 'string') : [],
  };
}

/**
 * Круг 39 (N6б): заголовок итога команды агента и вторая строка. Заголовок — что сделано
 * (`result.title`, = tx.title записи, словами по операциям); без него — `summary`. Вторая
 * строка — слова модели, если они о другом; план (то, что агент собирался сделать до работы)
 * второй строкой не повторяется — он в будущем времени и итогом не является.
 * @param {{title?: string, summary?: string, plan?: string, variant?: {label?: string}|null}} r
 * @returns {{headline: string, aside: string}}
 */
export function agentHeadline({ title = '', summary = '', plan = '', variant = null } = {}) {
  const t = cleanText(title);
  const s = cleanText(summary);
  const p = cleanText(plan);
  if (variant) return { headline: `Принят вариант «${cleanText(variant.label) || 'без названия'}»`, aside: t || s };
  const headline = t || s || 'Готово';
  return { headline, aside: s && s !== headline && s !== p ? s : '' };
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

/* ------------------- естественные фразы команд оболочки (часть таблицы §13) ------------------- */
/**
 * Человек наблюдает за макетом и говорит. Но переключить видимый артборд, вписать,
 * приблизить, выделить слой, экспортировать, открыть историю голосом было нельзя — всё
 * уходило в модель правкой макета, а «отмени два раза» вообще считалось созданием
 * (круг 9, п.6). Это дешёвые правила рядом с BUSY_WORDS и VARIANT_WORDS оболочки, и они же
 * работают для набранной команды: активный артборд задаёт область работы агента,
 * и выбирать её надо словами.
 *
 * Круг 24: словарь вынесен из app.js сюда, без DOM и без состояния оболочки — документ и
 * активная доска приходят аргументом. Круг 38 (§13): закрытого классификатора «оболочка или
 * модель» в системе больше нет — ни на сервере, ни в планах. Команды оболочки — открытая
 * таблица `SHELL_COMMANDS` ниже: её видит человек (палитра, справка «Команды»), её фразы и
 * слэш-формы узнаёт `shellIntent`, исполняет клиент. Копий регулярок нет ни в app.js, ни на
 * сервере (test/shell.test.mjs).
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
  return stemsMatch(nameStems(name), wantStems(phrase));
}
/* Круг 39 (N6е): на документе в 20 тыс. слоёв разбор фразы и имени на каждом узле стоил
   100+ мс на нажатие. Фраза разбирается один раз, основы имён — кешем (имя → основы). */
const wantStems = (phrase) => saidWords(phrase).map(stemWord).filter((w) => w.length >= 3);
const STEMS_CACHE = new Map();
const STEMS_CACHE_MAX = 60000;
let stemsComputed = 0;   // сколько основ посчитано заново (не из кеша) — тестам: тёплый поиск не считает ни одной
/** Круг 45: счётчик основ имён, посчитанных мимо кеша (для теста скорости «/выделить …» без часов). */
export function nameStemsComputed() { return stemsComputed; }
function nameStems(name) {
  const key = String(name || '');
  let got = STEMS_CACHE.get(key);
  if (got) return got;
  // слова уже в нижнем регистре и без знаков (saidWords) — основа сразу, без второй чистки
  stemsComputed++;
  got = [];
  for (const w of saidWords(key, false)) if (w) got.push(w.length > 4 ? w.slice(0, w.length - 2) : w);
  if (STEMS_CACHE.size >= STEMS_CACHE_MAX) STEMS_CACHE.clear();
  STEMS_CACHE.set(key, got);
  return got;
}
/**
 * Круг 41: основы имён слоёв — заранее, частями в простое (оболочка зовёт после перерисовки),
 * чтобы первое «/выделить …» на большом документе не считало их все разом.
 * @param {object} doc
 * @param {{from?: number, count?: number, ids?: string[]}} [o] ids — список (тот же между частями)
 * @returns {{ids: string[], next: number}} next — с какого продолжить (= ids.length — всё)
 */
export function warmNameStems(doc, { from = 0, count = 2000, ids = null } = {}) {
  const list = ids || (doc && doc.nodes ? Object.keys(doc.nodes) : []);
  const end = Math.min(list.length, from + count);
  for (let i = from; i < end; i++) {
    const n = doc.nodes[list[i]];
    if (n && n.type !== 'page' && typeof n.name === 'string' && n.name) nameStems(n.name);
  }
  return { ids: list, next: end };
}
function stemsMatch(have, want) {
  if (!want.length) return 0;
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
  const want = wantStems(phrase);
  if (!want.length) return [];
  /* Круг 41: «внутри активной доски» — по цепочке родителей только у совпавших узлов (с
     памятью по родителям), а не множеством всего поддерева доски: на 20 тыс. слоёв это
     было большей частью времени `/выделить …`. */
  const nodes = doc.nodes;
  const own = (id) => (Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null);
  const under = new Map();
  const isInside = (id) => {
    if (!activeId || !own(activeId)) return false;
    const path = [];
    let cur = id;
    let res = false;
    for (let k = 0; cur && k < 512; k++) {
      if (cur === activeId) { res = true; break; }
      if (under.has(cur)) { res = under.get(cur); break; }
      path.push(cur);
      const n = own(cur);
      cur = n ? n.parent : null;
    }
    for (const p of path) under.set(p, res);
    return res;
  };
  const out = [];
  for (const id in nodes) {
    if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
    const n = nodes[id];
    if (!n || n.type === 'page') continue;
    if (!artboardsToo && isArtboard(doc, id)) continue;
    const score = stemsMatch(nameStems(n.name || placeholderName(doc, n)), want);
    if (!score) continue;
    out.push({ id, node: n, score: score + (isInside(id) ? 0.5 : 0) });
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
/* Круг 36 (SPEC §11.3): «Просмотр» — режим холста, в котором наведение и нажатие проигрывают
   состояния. Формы только целиковые: «добавь просмотр» и «сделай экран просмотра» — работа
   для модели. «просмотр» и «режим просмотра» — включить; выйти — явными словами. */
const PV_LEAD = '(?:включи |включить |открой |открыть |покажи |показать |запусти |запустить |перейди в |перейти в |войди в |войти в |давай |в )?';
/* Круг 50: «выключи арт-направление», «включи самопроверку», «не грузи шрифты из сети», «собирай без
   образа» — только целиком: «выключи образ на кнопке» сюда не попадает. */
const RE_AGENT_SETTING = /^(?:(включи|включить|верни|выключи|выключить|отключи|отключить)\s+(арт-направление|арт направление|образ|самопроверку|критика|шрифты из сети|шрифты|веб-шрифты|веб шрифты|вебшрифты)|(?:собирай|работай|делай)\s+(без образа|без арт-направления|без самопроверки|без шрифтов из сети|с образом|с арт-направлением|с самопроверкой|со шрифтами из сети)|(не проверяй себя|проверяй себя|не грузи шрифты из сети|не загружай шрифты из сети|грузи шрифты из сети|загружай шрифты из сети))$/;
function agentSettingOf(m) {
  const word = m[2] || m[3] || m[4] || '';
  const what = /образ|арт/.test(word) ? 'direction' : /провер|критик/.test(word) ? 'critic' : 'webFonts';
  const on = m[1] ? /^(включ|верни)/.test(m[1]) : !/(^|\s)(без|не)\s/.test(word);
  return { kind: 'agent-setting', what, on };
}
const RE_PREVIEW_ON = new RegExp(`^${PV_LEAD}(?:режим просмотра|режим предпросмотра|просмотр|предпросмотр)$`
  + '|^посмотреть вживую$|^покажи вживую$|^проверить анимации$|^проверь анимации$');
const RE_PREVIEW_OFF = /^(?:выйди|выйти|выход|выходи) из (?:режима )?(?:пред)?просмотра$|^(?:выключи|выключить|закрой|закрыть|заверши|завершить|останови|остановить) (?:режим (?:пред)?просмотра|(?:пред)?просмотр)$|^(?:хватит|конец) (?:пред)?просмотра$|^(?:вернись|вернуться|назад) к правке$|^режим правки$/;

/**
 * Намерение, которое выполняет сама оболочка. null — значит это команда агенту.
 * Правила узкие нарочно: «покажи сводку недели» — переключение (артборд с таким именем
 * есть), «добавь сводку недели» — работа для модели.
 *
 * Круг 38 (§13): слэш-форма (`/масштаб 150`, `/zoom 150`, `/выровнять влево`) разбирается
 * точно по таблице `SHELL_COMMANDS`; незнакомое имя после «/» — тоже команда оболочки
 * (`slash-unknown`), агенту она не уходит. Без документа (`ctx.doc` нет —
 * `isShellCommandText`) естественные формы, которым нужны имена слоёв и досок, молчат.
 * Номер и «следующая доска» документа не требуют.
 *
 * @param {string} said реплика
 * @param {{doc?: object|null, activeArtboardId?: string|null}} [ctx]
 * @returns {{kind: string}|null}
 */
export function shellIntent(said, ctx = {}) {
  const doc = ctx && ctx.doc && ctx.doc.nodes ? ctx.doc : null;
  const activeId = ctx && ctx.activeArtboardId ? ctx.activeArtboardId : null;
  // круг 38: слэш-форма — точная и предсказуемая, раньше всех естественных фраз
  if (/^\s*\//.test(String(said || ''))) return slashIntent(said, { doc, activeId });
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

  /* Круг 36 (SPEC §11.3): режим «Просмотр» — дело оболочки, как масштаб и тема. Раньше
     RE_SHOW: «покажи просмотр» иначе искал бы доску с именем «просмотр». */
  // круг 50 (SPEC §17.2): настройки агента словами — до доски/слоя по имени
  { const m = RE_AGENT_SETTING.exec(t); if (m) return agentSettingOf(m); }
  if (RE_PREVIEW_OFF.test(t)) return { kind: 'preview', on: false };
  if (RE_PREVIEW_ON.test(t)) return { kind: 'preview', on: true };

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

  /* — круг 38 (§13): новые команды таблицы — целиковые фразы, без модели — */
  const fresh = naturalIntent(t, said);
  if (fresh) return fresh;

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
 * Намерение оболочки → событие `shell {action, args}` в форме сервера прежней версии
 * (совместимость, §10.5). Обратное — `shellIntentFromServer`; круг туда-обратно возвращает
 * то же намерение (тест сверяет).
 * @param {{kind: string}} intent
 * @returns {{action: string, args: object}|null}
 */
export function shellEventOf(intent) {
  if (!intent || typeof intent !== 'object' || !intent.kind) return null;
  const { kind, ...args } = intent;
  return { action: kind, args };
}

/* ================= круг 38 (SPEC §13): открытая таблица команд оболочки ================= */
/*
 * Решение руководителя: закрытого классификатора «оболочка или модель» в системе нет.
 * Вместо него — большой ЯВНЫЙ набор команд оболочки: каждая описана здесь одной записью,
 * её видно человеку (палитра Ctrl/⌘+K и «/», справка «Команды»), её исполняет клиент сам —
 * без сети и без модели. Всё, что таблица не узнала, — работа агента.
 *
 * Запись: {id, group, title, hint, slash:[имена после «/»], phrases:[примеры фраз],
 *   keys?, args?:[{name, kind:'number'|'text'|'enum', values?, optional?}], edit,
 *   needs?:'selection', example?:'/слэш аргументы', bare?, byAgent?, inPalette?}
 *   edit — команда меняет документ (обычная транзакция, отмена одним шагом);
 *   needs — без выделения не выполняется: честная подсказка, агенту не уходит;
 *   bare — у команды с необязательным аргументом есть смысл и без него (строка палитры);
 *   byAgent — фразы этой команды понимает агент (варианты считает модель), палитра и
 *   слэш-форма запускают их напрямую.
 */

/** Группы справки и палитры — в этом порядке. */
export const SHELL_GROUPS = Object.freeze(['Вид', 'Выделение', 'Правка', 'Доски', 'Панели', 'Файл', 'История', 'Агент', 'Справка']);

const ON_OFF = ['вкл', 'выкл'];
const SHOW_HIDE = ['показать', 'скрыть'];
const ALIGN_VALUES = ['влево', 'по центру', 'вправо', 'вверх', 'вниз', 'растянуть'];

const deepFreeze = (list) => Object.freeze(list.map((c) => Object.freeze({
  ...c,
  slash: Object.freeze([...(c.slash || [])]),
  phrases: Object.freeze([...(c.phrases || [])]),
  ...(c.args ? { args: Object.freeze(c.args.map((a) => Object.freeze({ ...a, ...(a.values ? { values: Object.freeze([...a.values]) } : {}) }))) } : {}),
  edit: !!c.edit,
})));

/** Все команды оболочки. Порядок внутри группы — порядок в палитре и справке. */
export const SHELL_COMMANDS = deepFreeze([
  /* — Вид — */
  { id: 'zoom', group: 'Вид', title: 'Масштаб', hint: 'Масштаб холста в процентах, от 10 до 600', slash: ['масштаб', 'zoom', 'зум'], args: [{ name: 'проценты', kind: 'number' }], example: '/масштаб 150', phrases: ['масштаб 150%', 'зум 200'] },
  { id: 'zoom-in', group: 'Вид', title: 'Крупнее', hint: 'Приблизить холст на шаг', slash: ['крупнее', 'zoom-in'], phrases: ['приблизь', 'увеличь масштаб'] },
  { id: 'zoom-out', group: 'Вид', title: 'Мельче', hint: 'Отдалить холст на шаг', slash: ['мельче', 'zoom-out'], phrases: ['отдали', 'уменьши масштаб'] },
  { id: 'zoom-reset', group: 'Вид', title: 'Масштаб 100 %', hint: 'Реальный размер', slash: ['100', 'сто'], phrases: ['сто процентов', 'реальный размер'] },
  { id: 'fit', group: 'Вид', title: 'Вписать', hint: 'Как кнопка «Вписать»: доску или всё — по обстановке', slash: ['вписать', 'fit'], phrases: ['впиши', 'вписать в окно'] },
  { id: 'fit-all', group: 'Вид', title: 'Вписать всё', hint: 'Показать все доски разом', slash: ['вписать всё', 'всё', 'fit all'], phrases: ['впиши всё', 'покажи всё', 'общий вид'] },
  { id: 'fit-board', group: 'Вид', title: 'Вписать доску', hint: 'Показать активную доску целиком', slash: ['вписать доску', 'fit board'], phrases: ['впиши доску', 'покажи эту доску'] },
  { id: 'fit-selection', group: 'Вид', title: 'Вписать выделенное', hint: 'Приблизить к выделенным слоям', slash: ['вписать выделенное', 'к выделенному', 'fit selection'], phrases: ['впиши выделенное', 'покажи выделенное', 'приблизь к выделенному'], needs: 'selection' },
  { id: 'preview', group: 'Вид', title: 'Режим просмотра', hint: 'Наведение и нажатие на холсте проигрывают состояния', slash: ['просмотр', 'preview'], keys: 'P', args: [{ name: 'режим', kind: 'enum', values: ON_OFF, optional: true }], example: '/просмотр вкл', phrases: ['просмотр', 'выйди из просмотра'] },
  { id: 'theme', group: 'Вид', title: 'Тема интерфейса', hint: 'Тёмная, светлая или как в системе; без слова — следующая', slash: ['тема', 'theme'], args: [{ name: 'какая', kind: 'enum', values: ['тёмная', 'светлая', 'системная'], optional: true }], bare: true, example: '/тема тёмная', phrases: ['тёмная тема интерфейса', 'светлый интерфейс', 'как в системе'] },

  /* — Выделение — */
  { id: 'select-all', group: 'Выделение', title: 'Выделить всё на доске', hint: 'Верхние слои активной доски, кроме скрытых и запертых', slash: ['выделить всё', 'select all'], keys: 'Mod+A', phrases: ['выдели всё', 'выбери всё на доске'] },
  { id: 'deselect', group: 'Выделение', title: 'Снять выделение', hint: '', slash: ['снять выделение', 'снять', 'deselect'], keys: 'Esc', phrases: ['сними выделение', 'убери выделение'] },
  { id: 'select-parent', group: 'Выделение', title: 'Выделить родителя', hint: 'Рамку, в которой лежит выделенный слой', slash: ['родитель', 'parent'], phrases: ['выдели родителя', 'на уровень выше'], needs: 'selection' },
  { id: 'select-children', group: 'Выделение', title: 'Выделить детей', hint: 'Слои внутри выделенной рамки', slash: ['дети', 'children'], phrases: ['выдели детей', 'на уровень ниже'], needs: 'selection' },
  { id: 'select-next', group: 'Выделение', title: 'Следующий сосед', hint: 'Следующий слой в том же родителе', slash: ['следующий', 'next'], phrases: ['следующий слой', 'выдели следующий'], needs: 'selection' },
  { id: 'select-prev', group: 'Выделение', title: 'Предыдущий сосед', hint: 'Предыдущий слой в том же родителе', slash: ['предыдущий', 'prev'], phrases: ['предыдущий слой', 'выдели предыдущий'], needs: 'selection' },
  { id: 'select-name', group: 'Выделение', title: 'Выделить по имени', hint: 'Слой, чьё имя похоже на сказанное', slash: ['выделить', 'select'], args: [{ name: 'имя', kind: 'text' }], example: '/выделить заголовок', phrases: ['выдели заголовок экрана'] },

  /* — Правка: обычные транзакции, отмена одним шагом — */
  { id: 'delete', group: 'Правка', title: 'Удалить', hint: 'Удалить выделенные слои', slash: ['удалить', 'delete'], keys: 'Del', phrases: ['удали выделенное', 'удалить выбранное'], edit: true, needs: 'selection' },
  { id: 'duplicate', group: 'Правка', title: 'Дублировать', hint: 'Копия рядом с оригиналом', slash: ['дублировать', 'копия', 'duplicate'], keys: 'Mod+D', phrases: ['дублируй', 'сделай копию'], edit: true, needs: 'selection' },
  { id: 'rename', group: 'Правка', title: 'Переименовать', hint: 'Новое имя выделенного слоя', slash: ['переименовать', 'имя', 'rename'], args: [{ name: 'новое имя', kind: 'text' }], example: '/переименовать Шапка', phrases: ['переименуй в «Шапка»'], edit: true, needs: 'selection' },
  { id: 'hide', group: 'Правка', title: 'Скрыть', hint: 'Сделать слой невидимым — он остаётся в списке слоёв', slash: ['скрыть', 'hide'], phrases: ['скрой выделенное', 'сделай невидимым'], edit: true, needs: 'selection' },
  { id: 'show', group: 'Правка', title: 'Показать', hint: 'Вернуть видимость скрытому слою', slash: ['показать', 'show'], phrases: ['сделай видимым', 'верни видимость'], edit: true, needs: 'selection' },
  { id: 'lock', group: 'Правка', title: 'Закрепить', hint: 'Запереть слой: на холсте его не выделить и не сдвинуть, только в списке слоёв', slash: ['закрепить', 'запереть', 'lock'], phrases: ['закрепи', 'запри'], edit: true, needs: 'selection' },
  { id: 'unlock', group: 'Правка', title: 'Открепить', hint: 'Снять замок со слоя', slash: ['открепить', 'отпереть', 'unlock'], phrases: ['открепи', 'отопри'], edit: true, needs: 'selection' },
  { id: 'raise', group: 'Правка', title: 'Поднять в порядке', hint: 'На место раньше среди соседей — выше в списке слоёв', slash: ['выше', 'поднять', 'up'], phrases: ['подними', 'выше в списке'], edit: true, needs: 'selection' },
  { id: 'lower', group: 'Правка', title: 'Опустить в порядке', hint: 'На место позже среди соседей — ниже в списке слоёв', slash: ['ниже', 'опустить', 'down'], phrases: ['опусти', 'ниже в списке'], edit: true, needs: 'selection' },
  { id: 'to-start', group: 'Правка', title: 'В начало', hint: 'Первым среди соседей', slash: ['в начало', 'first'], phrases: ['перемести в начало', 'поставь первым'], edit: true, needs: 'selection' },
  { id: 'to-end', group: 'Правка', title: 'В конец', hint: 'Последним среди соседей', slash: ['в конец', 'last'], phrases: ['перемести в конец', 'поставь последним'], edit: true, needs: 'selection' },
  { id: 'wrap', group: 'Правка', title: 'Обернуть в рамку', hint: 'Сгруппировать выделенных соседей в новую рамку', slash: ['обернуть', 'группа', 'group'], keys: 'Mod+G', phrases: ['оберни в рамку', 'сгруппируй'], edit: true, needs: 'selection' },
  { id: 'ungroup', group: 'Правка', title: 'Разгруппировать', hint: 'Достать детей из рамки и убрать саму рамку', slash: ['разгруппировать', 'ungroup'], keys: 'Shift+Mod+G', phrases: ['разгруппируй', 'разбери группу'], edit: true, needs: 'selection' },
  { id: 'align', group: 'Правка', title: 'Выровнять детей', hint: 'Как стоят дети в выделенной рамке', slash: ['выровнять', 'align'], args: [{ name: 'как', kind: 'enum', values: ALIGN_VALUES }], example: '/выровнять влево', phrases: ['выровняй детей по центру', 'выровнять содержимое влево'], edit: true, needs: 'selection' },
  { id: 'direction', group: 'Правка', title: 'Направление', hint: 'Дети рамки — строкой или колонкой', slash: ['направление', 'поток', 'direction'], args: [{ name: 'как', kind: 'enum', values: ['строка', 'колонка'] }], example: '/направление строка', phrases: ['расположи в строку', 'в колонку'], edit: true, needs: 'selection' },
  { id: 'gap-more', group: 'Правка', title: 'Зазор больше', hint: 'Зазор между детьми рамки — на шаг шкалы отступов больше', slash: ['зазор больше', 'зазор+', 'gap+'], phrases: ['увеличь зазор', 'зазор больше'], edit: true, needs: 'selection' },
  { id: 'gap-less', group: 'Правка', title: 'Зазор меньше', hint: 'Зазор между детьми рамки — на шаг шкалы отступов меньше', slash: ['зазор меньше', 'зазор-', 'gap-'], phrases: ['уменьши зазор', 'зазор меньше'], edit: true, needs: 'selection' },

  /* — Доски — */
  { id: 'board', group: 'Доски', title: 'К доске', hint: 'Доска по номеру или имени — с ней работает агент', slash: ['доска', 'board'], args: [{ name: 'номер или имя', kind: 'text' }], example: '/доска 2', phrases: ['покажи второй экран', 'открой маршрут дня'] },
  { id: 'board-next', group: 'Доски', title: 'Следующая доска', hint: '', slash: ['следующая доска', 'next board'], phrases: ['покажи следующую доску'] },
  { id: 'board-prev', group: 'Доски', title: 'Предыдущая доска', hint: '', slash: ['предыдущая доска', 'prev board'], phrases: ['вернись на предыдущий', 'покажи предыдущую доску'] },

  /* — Панели — */
  { id: 'layers', group: 'Панели', title: 'Слои', hint: 'Панель слоёв слева', slash: ['слои', 'layers'], keys: 'L', args: [{ name: 'как', kind: 'enum', values: SHOW_HIDE, optional: true }], example: '/слои скрыть', phrases: ['покажи слои', 'спрячь слои'] },
  { id: 'inspector', group: 'Панели', title: 'Инспектор', hint: 'Свойства выделенного слоя справа', slash: ['инспектор', 'inspector'], args: [{ name: 'как', kind: 'enum', values: SHOW_HIDE, optional: true }], example: '/инспектор скрыть', phrases: ['покажи инспектор', 'скрой инспектор'] },
  { id: 'history', group: 'Панели', title: 'История правок', hint: 'Все правки с отменой до любой из них', slash: ['история', 'history'], keys: 'H', phrases: ['история', 'что менялось'] },
  { id: 'chat', group: 'Панели', title: 'Диалог с агентом', hint: 'Что вы сказали и что ответил агент', slash: ['диалог', 'chat'], phrases: ['покажи диалог', 'переписка'] },
  { id: 'scales', group: 'Панели', title: 'Шкалы и токены', hint: 'Шаги отступов и скруглений документа', slash: ['шкалы', 'токены', 'scales'], phrases: ['шкалы', 'покажи токены'] },
  { id: 'settings', group: 'Панели', title: 'Настройки агента', hint: '', slash: ['настройки', 'settings'], phrases: ['настройки', 'открой настройки'] },

  /* — Файл — */
  { id: 'export', group: 'Файл', title: 'Экспорт', hint: 'SVG, PNG или JSON; без формата — окно экспорта', slash: ['экспорт', 'export'], args: [{ name: 'формат', kind: 'enum', values: ['svg', 'png', 'json'], optional: true }], bare: true, example: '/экспорт png', phrases: ['экспорт png', 'экспортируй в svg'] },
  { id: 'import', group: 'Файл', title: 'Импорт JSON', hint: 'Открыть документ из файла', slash: ['импорт', 'import'], phrases: ['импорт', 'импортируй файл'] },
  { id: 'new-board', group: 'Файл', title: 'Новая доска', hint: 'Пустая доска рядом с остальными', slash: ['новая доска', 'new board'], phrases: ['новая доска', 'пустая доска'] },
  /* круг 46: проекты — и без сервера (соло-режим), и на сервере (та же шторка «Проекты») */
  { id: 'projects', group: 'Файл', title: 'Проекты', hint: 'Все проекты: открыть, создать, переименовать, дублировать, удалить', slash: ['проекты', 'projects'], keys: 'Mod+O', phrases: ['покажи проекты', 'мои проекты'] },
  { id: 'project-new', group: 'Файл', title: 'Новый проект', hint: 'Пустой документ отдельным проектом; без имени — «Новый проект»', slash: ['новый проект', 'new project'], args: [{ name: 'имя', kind: 'text', optional: true }], bare: true, example: '/новый проект Лендинг', phrases: ['создай новый проект', 'новый документ', 'новый файл'] },
  { id: 'project-open', group: 'Файл', title: 'Открыть проект', hint: 'Проект по имени; похожих несколько — список «Проекты» с ними', slash: ['открыть', 'открыть проект', 'open'], args: [{ name: 'имя', kind: 'text' }], example: '/открыть Лендинг', phrases: ['открой проект Лендинг'] },
  { id: 'project-rename', group: 'Файл', title: 'Переименовать проект', hint: 'Новое имя открытого проекта (оно же в шапке)', slash: ['переименовать проект', 'rename project'], args: [{ name: 'новое имя', kind: 'text' }], example: '/переименовать проект Лендинг', phrases: ['переименуй проект в «Лендинг»'] },
  { id: 'project-duplicate', group: 'Файл', title: 'Дублировать проект', hint: 'Копия открытого проекта отдельным проектом', slash: ['дублировать проект', 'копия проекта', 'duplicate project'], phrases: ['дублируй проект', 'сделай копию проекта'] },

  /* — История — */
  { id: 'undo', group: 'История', title: 'Отменить', hint: 'Последнюю правку или несколько', slash: ['отменить', 'отмена', 'undo'], keys: 'Mod+Z', args: [{ name: 'сколько', kind: 'number', optional: true }], bare: true, example: '/отменить 3', phrases: ['отмени', 'отмени три раза'] },
  { id: 'redo', group: 'История', title: 'Повторить', hint: 'Вернуть отменённое', slash: ['повторить', 'redo'], keys: 'Shift+Mod+Z', args: [{ name: 'сколько', kind: 'number', optional: true }], bare: true, example: '/повторить 2', phrases: ['верни обратно', 'вперёд два раза'] },

  /* — Агент — */
  { id: 'stop', group: 'Агент', title: 'Стоп', hint: 'Остановить работу агента', slash: ['стоп', 'stop'], phrases: ['стоп', 'хватит'] },
  { id: 'variants', group: 'Агент', title: 'Три варианта', hint: 'Три варианта последней команды — их считает агент', slash: ['варианты', 'variants'], phrases: ['три варианта', 'покажи варианты'], byAgent: true },
  { id: 'variants-close', group: 'Агент', title: 'Закрыть варианты', hint: 'Макет остаётся прежним', slash: ['закрыть варианты'], phrases: ['закрой варианты', 'ни один не подходит'] },
  // круг 50 (SPEC §17.2): настройки агента — словом, слэшем и в настройках; без слова — сказать, как сейчас
  { id: 'art-direction', group: 'Агент', title: 'Арт-направление', hint: 'Образ, палитра и шрифты перед сборкой нового экрана; без слова — сказать, включено ли', slash: ['образ', 'арт-направление', 'art'], args: [{ name: 'режим', kind: 'enum', values: ON_OFF, optional: true }], bare: true, example: '/образ выкл', phrases: ['выключи арт-направление', 'собирай без образа'] },
  { id: 'art-critic', group: 'Агент', title: 'Самопроверка', hint: 'Агент смотрит на собранный экран и дорабатывает шаблонное; без слова — сказать, включена ли', slash: ['самопроверка', 'критик', 'critic'], args: [{ name: 'режим', kind: 'enum', values: ON_OFF, optional: true }], bare: true, example: '/самопроверка выкл', phrases: ['выключи самопроверку', 'не проверяй себя'] },
  { id: 'web-fonts', group: 'Агент', title: 'Шрифты из сети', hint: 'Гарнитуры макета из Google Fonts на холсте, в экспорте и при арт-направлении; выкл — шрифты системы', slash: ['шрифты из сети', 'шрифты', 'веб-шрифты', 'web fonts'], args: [{ name: 'режим', kind: 'enum', values: ON_OFF, optional: true }], bare: true, example: '/шрифты из сети выкл', phrases: ['не грузи шрифты из сети', 'выключи веб-шрифты'] },

  /* — Справка — */
  { id: 'help', group: 'Справка', title: 'Команды', hint: 'Справка: все команды оболочки по группам', slash: ['помощь', 'команды', 'help', '?'], phrases: ['команды', 'что ты умеешь'] },
  { id: 'palette', group: 'Справка', title: 'Палитра команд', hint: 'Поиск команды по названию, «/» или фразе', slash: [], keys: 'Mod+K', phrases: [], inPalette: false },
]);

const CMD_BY_ID = new Map(SHELL_COMMANDS.map((c) => [c.id, c]));

/**
 * Круг 39 (N6в): клавиши в таблице хранятся абстрактно («Mod+A», «Shift+Mod+G»): Mod — Ctrl на
 * Windows и Linux, ⌘ на macOS. Подпись — по платформе: «Ctrl+Shift+G» или «⇧⌘G».
 * На устройстве без клавиатуры (телефон) подписи нет вовсе — пустая строка.
 * @param {string} keys
 * @param {{mac?: boolean, touch?: boolean}} [o]
 */
export function keyLabel(keys, { mac = false, touch = false } = {}) {
  const k = String(keys || '').trim();
  if (!k || touch) return '';
  const parts = k.split('+').filter(Boolean);
  const key = parts.pop();
  const shift = parts.includes('Shift');
  const mod = parts.includes('Mod');
  const alt = parts.includes('Alt');
  if (mac) return `${shift ? '⇧' : ''}${alt ? '⌥' : ''}${mod ? '⌘' : ''}${key}`;
  return [mod ? 'Ctrl' : '', shift ? 'Shift' : '', alt ? 'Alt' : '', key].filter(Boolean).join('+');
}

/**
 * Платформа по `navigator`: macOS/iOS — ⌘, прочее — Ctrl; «без клавиш» — грубый указатель
 * без наведения (телефон, планшет без клавиатуры). Без navigator (тесты) — Ctrl и клавиши есть.
 * @param {object} [nav] navigator
 * @param {(q: string) => boolean} [mq] matchMedia(q).matches
 */
export function keyPlatform(nav = (typeof navigator !== 'undefined' ? navigator : null), mq = null) {
  const plat = nav ? String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '') : '';
  const ua = nav ? String(nav.userAgent || '') : '';
  const mac = /mac|iphone|ipad|ipod/i.test(plat) || (!plat && /Mac OS X|iPhone|iPad/.test(ua));
  let touch = false;
  try { touch = !!(mq && mq('(hover: none) and (pointer: coarse)')); } catch { touch = false; }
  return { mac, touch };
}

/** «Ctrl+Z» / «⌘Z» — как назвать отмену на этой платформе; на телефоне — пусто. */
export function undoKeyWords(platform = {}) {
  return keyLabel('Mod+Z', platform);
}

/** Запись таблицы по id. */
export function shellCommand(id) {
  return CMD_BY_ID.get(id) || null;
}

/** Ключ слэш-имени: нижний регистр, «ё» как «е», одиночные пробелы. */
function slashKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/* Слэш-имена: длинные раньше коротких — «/вписать всё» не должно стать «/вписать» с хвостом. */
const SLASH_NAMES = SHELL_COMMANDS
  .flatMap((c) => c.slash.map((name) => ({ key: slashKey(name), name, cmd: c })))
  .sort((a, b) => b.key.length - a.key.length);

/** Главная слэш-форма команды: «/масштаб». */
export function slashOf(cmd) {
  const c = typeof cmd === 'string' ? CMD_BY_ID.get(cmd) : cmd;
  return c && c.slash.length ? `/${c.slash[0]}` : '';
}

/** Что сказать, когда аргумент негоден: пример из таблицы. */
function usageOf(cmd) {
  if (cmd.example) return `Например: ${cmd.example}`;
  const a = cmd.args && cmd.args[0];
  if (a && a.values) return `Например: /${cmd.slash[0]} ${a.values[0]}`;
  return `Например: /${cmd.slash[0]}`;
}

const bad = (cmd, say) => ({ kind: 'slash-bad', id: cmd.id, say, usage: usageOf(cmd) });

/** Число аргумента: «150», «150%», «150 %», «три». */
function argNum(rest) {
  const s = slashKey(rest).replace(/\s*%$/, '').replace(/\s*процент[а-яё]*$/, '');
  if (/^\d{1,4}$/.test(s)) return Number(s);
  const n = numSaid(s);
  return n == null ? null : n;
}

/** Значение перечня по словам аргумента; null — не узнали. */
function argPick(rest, table) {
  const s = slashKey(rest);
  for (const [value, re] of table) if (re.test(s)) return value;
  return null;
}

const ON_WORDS = [[true, /^(вкл|включить|включи|on|да|показать|покажи|открыть|открой)$/], [false, /^(выкл|выключить|выключи|off|нет|скрыть|скрой|спрятать|спрячь|закрыть|закрой)$/]];
const ALIGN_WORDS = [
  ['left', /^(влево|слева|лево|left|по левому краю|по левому)$/],
  ['center', /^(по центру|центр|в центр|посередине|center|middle)$/],
  ['right', /^(вправо|справа|право|right|по правому краю|по правому)$/],
  ['top', /^(вверх|сверху|верх|top|по верху|по верхнему краю)$/],
  ['bottom', /^(вниз|снизу|низ|bottom|по низу|по нижнему краю)$/],
  ['stretch', /^(растянуть|растяни|растянуто|stretch|во всю ширину|по ширине)$/],
];
const DIRECTION_WORDS = [['row', /^(строка|строкой|в строку|ряд|row|горизонтально)$/], ['column', /^(колонка|колонкой|в колонку|столбец|column|вертикально)$/]];
const THEME_WORDS = [['dark', /^(т[её]мн[а-я]*|dark)$/], ['light', /^(светлая|светл[а-я]*|light)$/], ['auto', /^(системная|как в системе|авто|auto|system)$/]];
const EXPORT_WORDS = [['svg', /^(svg|свг|вектор[а-я]*)$/], ['png', /^(png|пнг|картинк[а-я]*|изображение)$/], ['json', /^(json|джейсон|документ)$/]];
/** Слова выравнивания для фраз и подписей правки. */
export const ALIGN_HOW_WORDS = Object.freeze({ left: 'влево', center: 'по центру', right: 'вправо', top: 'вверх', bottom: 'вниз', stretch: 'растянуть' });

/** Намерение по записи таблицы без аргументов (id → то, что исполняет оболочка). */
const PLAIN_INTENTS = {
  'zoom-in': () => ({ kind: 'zoom', by: 1.25 }),
  'zoom-out': () => ({ kind: 'zoom', by: 1 / 1.25 }),
  'zoom-reset': () => ({ kind: 'zoom', to: 1 }),
  fit: () => ({ kind: 'fit' }),
  'fit-all': () => ({ kind: 'fit', all: true }),
  'fit-board': () => ({ kind: 'fit', all: false }),
  'fit-selection': () => ({ kind: 'fit-selection' }),
  'select-all': () => ({ kind: 'select-all' }),
  deselect: () => ({ kind: 'select', ids: [] }),
  'select-parent': () => ({ kind: 'select-rel', rel: 'parent' }),
  'select-children': () => ({ kind: 'select-rel', rel: 'children' }),
  'select-next': () => ({ kind: 'select-rel', rel: 'next' }),
  'select-prev': () => ({ kind: 'select-rel', rel: 'prev' }),
  delete: () => ({ kind: 'delete' }),
  duplicate: () => ({ kind: 'duplicate' }),
  hide: () => ({ kind: 'visible', on: false }),
  show: () => ({ kind: 'visible', on: true }),
  lock: () => ({ kind: 'lock', on: true }),
  unlock: () => ({ kind: 'lock', on: false }),
  raise: () => ({ kind: 'order', to: 'up' }),
  lower: () => ({ kind: 'order', to: 'down' }),
  'to-start': () => ({ kind: 'order', to: 'first' }),
  'to-end': () => ({ kind: 'order', to: 'last' }),
  wrap: () => ({ kind: 'wrap' }),
  ungroup: () => ({ kind: 'ungroup' }),
  'gap-more': () => ({ kind: 'gap', step: 1 }),
  'gap-less': () => ({ kind: 'gap', step: -1 }),
  'board-next': () => ({ kind: 'artboard', step: 1 }),
  'board-prev': () => ({ kind: 'artboard', step: -1 }),
  history: () => ({ kind: 'sheet', what: 'history', tab: 'edits' }),
  chat: () => ({ kind: 'sheet', what: 'history', tab: 'chat' }),
  scales: () => ({ kind: 'sheet', what: 'scales' }),
  settings: () => ({ kind: 'sheet', what: 'settings' }),
  import: () => ({ kind: 'import' }),
  'new-board': () => ({ kind: 'new-board' }),
  projects: () => ({ kind: 'projects' }),
  'project-duplicate': () => ({ kind: 'project-duplicate' }),
  stop: () => ({ kind: 'stop' }),
  variants: () => ({ kind: 'variants' }),
  'variants-close': () => ({ kind: 'variants-close' }),
  help: () => ({ kind: 'help' }),
};

/** Круг 50: настройка агента — «вкл»/«выкл»; без слова — спросить, как сейчас (on: null). */
function agentSettingArg(what, rest, cmd) {
  if (!rest) return { kind: 'agent-setting', what, on: null };
  const on = argPick(rest, ON_WORDS);
  return on == null ? bad(cmd, `${cmd.title}: «вкл» или «выкл»`) : { kind: 'agent-setting', what, on };
}

/** Разбор аргументов у команд, которым они нужны: (хвост, хвост как набран, ctx) → намерение. */
const SLASH_ARGS = {
  zoom(rest, raw, ctx, cmd) {
    const n = argNum(rest);
    if (n == null) return bad(cmd, 'Масштаб — числом в процентах');
    if (n < 10 || n > 600) return bad(cmd, 'Масштаб — от 10 до 600 %');
    return { kind: 'zoom', to: n / 100 };
  },
  'art-direction': (rest, raw, ctx, cmd) => agentSettingArg('direction', rest, cmd),
  'art-critic': (rest, raw, ctx, cmd) => agentSettingArg('critic', rest, cmd),
  'web-fonts': (rest, raw, ctx, cmd) => agentSettingArg('webFonts', rest, cmd),
  preview(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'preview', on: true };
    const on = argPick(rest, ON_WORDS);
    return on == null ? bad(cmd, 'Просмотр: «вкл» или «выкл»') : { kind: 'preview', on };
  },
  theme(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'theme', mode: 'cycle' };
    const mode = argPick(rest, THEME_WORDS);
    return mode ? { kind: 'theme', mode } : bad(cmd, 'Тема: тёмная, светлая или системная');
  },
  'select-name'(rest, raw, ctx, cmd) {
    if (!rest) return bad(cmd, 'Скажите, какой слой выделить');
    if (!ctx.doc) return { kind: 'select-name', name: cleanText(raw) };
    const hits = nodesByName(ctx.doc, rest, { activeId: ctx.activeId });
    if (!hits.length) return bad(cmd, `Слоя «${cutText(cleanText(raw), 40, { ellipsis: true })}» не нашёл`);
    const best = hits[0].score;
    const same = hits.filter((h) => h.score >= best - 0.01).slice(0, 12);
    return { kind: 'select', ids: same.map((h) => h.id), name: same[0].node.name || placeholderName(ctx.doc, same[0].node) };
  },
  rename(rest, raw, ctx, cmd) {
    const name = renameValue(raw);
    return name ? { kind: 'rename', name } : bad(cmd, 'Скажите новое имя');
  },
  'project-new'(rest, raw) {
    const name = renameValue(raw);
    return name ? { kind: 'project-new', name } : { kind: 'project-new' };
  },
  'project-open'(rest, raw, ctx, cmd) {
    const name = renameValue(raw);
    return name ? { kind: 'project-open', name } : bad(cmd, 'Скажите, какой проект открыть');
  },
  'project-rename'(rest, raw, ctx, cmd) {
    const name = renameValue(raw);
    return name ? { kind: 'project-rename', name } : bad(cmd, 'Скажите новое имя проекта');
  },
  align(rest, raw, ctx, cmd) {
    const how = argPick(rest, ALIGN_WORDS);
    return how ? { kind: 'align', how } : bad(cmd, 'Выровнять: влево, по центру, вправо, вверх, вниз или растянуть');
  },
  direction(rest, raw, ctx, cmd) {
    const mode = argPick(rest, DIRECTION_WORDS);
    return mode ? { kind: 'direction', mode } : bad(cmd, 'Направление: строка или колонка');
  },
  board(rest, raw, ctx, cmd) {
    if (!rest) return bad(cmd, 'Скажите номер доски или её имя');
    const n = argNum(rest);
    if (n != null && /^\d+$|^[а-яё]+$/.test(slashKey(rest)) && n >= 1) return { kind: 'artboard', index: n - 1 };
    if (!ctx.doc) return { kind: 'artboard', name: cleanText(raw) };
    const hits = artboardsByName(ctx.doc, rest);
    if (hits.length === 1) return { kind: 'artboard', id: hits[0].id };
    if (hits.length > 1) return { kind: 'artboard', list: hits.map((a) => a.id) };
    return bad(cmd, `Доски «${cutText(cleanText(raw), 40, { ellipsis: true })}» нет`);
  },
  layers(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'rail', on: true };
    const on = argPick(rest, ON_WORDS);
    return on == null ? bad(cmd, 'Слои: «показать» или «скрыть»') : { kind: 'rail', on };
  },
  inspector(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'inspector', on: true };
    const on = argPick(rest, ON_WORDS);
    return on == null ? bad(cmd, 'Инспектор: «показать» или «скрыть»') : { kind: 'inspector', on };
  },
  export(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'export', what: '' };
    const what = argPick(rest, EXPORT_WORDS);
    return what ? { kind: 'export', what } : bad(cmd, 'Экспорт: svg, png или json');
  },
  undo(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'undo', times: 1 };
    const n = argNum(rest);
    return n ? { kind: 'undo', times: Math.max(1, Math.min(20, n)) } : bad(cmd, 'Сколько правок отменить — числом');
  },
  redo(rest, raw, ctx, cmd) {
    if (!rest) return { kind: 'redo', times: 1 };
    const n = argNum(rest);
    return n ? { kind: 'redo', times: Math.max(1, Math.min(20, n)) } : bad(cmd, 'Сколько правок вернуть — числом');
  },
};

/** Новое имя из «в «Шапка»», «"Шапка"», «Шапка»: без кавычек и краёв, не длиннее 120. */
function renameValue(raw) {
  let s = cleanText(raw);
  const q = /^[«"“„'](.*)[»"”“']$/.exec(s);
  if (q) s = q[1].trim();
  return cutText(s, 120);
}

/**
 * Слэш-форма → намерение. Имя ищется по таблице (длинные раньше), хвост — аргументы.
 * Незнакомое имя — `slash-unknown`: это команда оболочки, только такой нет.
 * @returns {object} намерение; не бывает null — «/» уже сказал, что это команда редактора
 */
function slashIntent(said, { doc = null, activeId = null } = {}) {
  const rawBody = String(said || '').replace(/^\s*\/+/, '').trim();
  const body = slashKey(rawBody);
  if (!body) return { kind: 'palette' };
  const hit = SLASH_NAMES.find((s) => body === s.key || body.startsWith(`${s.key} `));
  if (!hit) return { kind: 'slash-unknown', name: cutText(cleanText(rawBody.split(/\s+/)[0]), 40, { ellipsis: true }) };
  const cmd = hit.cmd;
  const words = hit.key.split(' ').length;
  const raw = rawBody.split(/\s+/).slice(words).join(' ');
  const rest = slashKey(raw);
  const parse = SLASH_ARGS[cmd.id];
  if (parse) return parse(rest, raw, { doc, activeId }, cmd);
  if (cmd.id === 'palette') return { kind: 'palette' };
  // у команды без аргументов хвост — ошибка набора, а не «сделай что-то ещё»
  if (rest) return bad(cmd, `У команды ${slashOf(cmd)} нет аргументов`);
  return PLAIN_INTENTS[cmd.id] ? PLAIN_INTENTS[cmd.id]() : { kind: 'slash-unknown', name: cmd.slash[0] };
}

/* Естественные фразы новых команд (круг 38). Только целиковые: «удали выделенное» — команда,
   «удали шапку» — работа агента. Порядок важен: раньше выделения по имени и показа доски. */
const NATURAL = [
  ['select-all', /^(?:выдели|выделить|выделите|выбери|выбрать) вс[её](?: на доске| на экране| слои)?$/],
  ['select-parent', /^(?:(?:выдели|выделить|выбери|выбрать) родител[а-яё]*|к родителю|(?:на )?уровень выше)$/],
  ['select-children', /^(?:(?:выдели|выделить|выбери|выбрать) (?:детей|дочерние|дочерних|вложенные|содержимое)|(?:на )?уровень ниже)$/],
  ['select-next', /^(?:следующий (?:слой|сосед|элемент)|(?:выдели|выбери) следующий(?: слой)?)$/],
  ['select-prev', /^(?:предыдущий (?:слой|сосед|элемент)|(?:выдели|выбери) предыдущий(?: слой)?)$/],
  ['fit-selection', /^(?:впиши|вписать|покажи|показать) выделенное$|^(?:приблизь|приблизить) к выделенному$|^к выделенному$/],
  ['delete', /^(?:удали|удалить|удалите) (?:выделенное|выделенные|выбранное|выбранные)$/],
  ['duplicate', /^(?:дублируй|дублировать|продублируй|продублировать|дубль|(?:сделай|создай|сделать) копию|дублируй выделенное)$/],
  ['hide', /^(?:(?:скрой|скрыть|спрячь|спрятать) (?:выделенное|выбранное|это)|сделай невидимым|сделай невидимыми|сделать невидимым)$/],
  ['show', /^(?:сделай видимым|сделай видимыми|сделать видимым|верни видимость|(?:покажи|показать) скрытое)$/],
  ['lock', /^(?:закрепи|закрепить|запри|запереть|заблокируй|заблокировать)(?: выделенное| это| слой)?$/],
  ['unlock', /^(?:открепи|открепить|отопри|отпереть|разблокируй|разблокировать)(?: выделенное| это| слой)?$/],
  ['raise', /^(?:подними|поднять|подними выше|выше в списке|на место раньше|раньше в порядке|подними в порядке)$/],
  ['lower', /^(?:опусти|опустить|опусти ниже|ниже в списке|на место позже|позже в порядке|опусти в порядке)$/],
  ['to-start', /^(?:в начало|(?:перемести|переставь|поставь) в начало|(?:поставь|сделай) первым)$/],
  ['to-end', /^(?:в конец|(?:перемести|переставь|поставь) в конец|(?:поставь|сделай) последним)$/],
  ['wrap', /^(?:(?:оберни|обернуть|заверни|завернуть|объедини|объединить) в рамку|сгруппируй|сгруппировать|в группу)$/],
  ['ungroup', /^(?:разгруппируй|разгруппировать|(?:разбери|разобрать) группу)$/],
  ['gap-more', /^(?:увеличь|увеличить|прибавь) зазор$|^зазор (?:больше|шире)$|^больше зазор$/],
  ['gap-less', /^(?:уменьши|уменьшить|убавь) зазор$|^зазор (?:меньше|уже)$|^меньше зазор$/],
  ['inspector', /^(?:(?:покажи|открой|показать|открыть) )?инспектор$/, () => ({ kind: 'inspector', on: true })],
  ['inspector', /^(?:скрой|скрыть|спрячь|спрятать|закрой|закрыть|убери|сверни) инспектор$/, () => ({ kind: 'inspector', on: false })],
  ['scales', /^(?:(?:покажи|открой|показать|открыть) )?(?:шкалы|токены|шкалы отступов)$/],
  ['import', /^(?:импорт|импортировать|импортируй)(?: файл| json| документ)?$|^(?:загрузи|загрузить) файл$/],
  ['projects', /^(?:(?:покажи|открой|показать|открыть) )?(?:мои |все )?проекты$|^список проектов$/],
  ['project-new', /^(?:(?:создай|создать|сделай|сделать|заведи|завести|начни|начать|открой|открыть) )?(?:новый|чистый|пустой) (?:проект|документ|файл)$/, () => ({ kind: 'project-new' })],
  ['project-duplicate', /^(?:дублируй|продублируй|скопируй|дублировать|продублировать|скопировать) проект$|^(?:сделай|создай|сделать|создать) копию проекта$/],
  ['help', /^(?:команды|какие есть команды|список команд|(?:покажи|открой) команды|что ты умеешь|что умеешь|что ты можешь|помощь|справка)$/],
];

/** Направление и выравнивание детей — с аргументом внутри фразы. */
const RE_DIRECTION = /^(?:(?:расположи|расположить|поставь|сделай|выстрой|перестрой)\s+)?(в строку|строкой|в колонку|колонкой|в столбец)$/;
const RE_ALIGN_KIDS = /^(?:выровняй|выровнять)\s+(?:детей|содержимое|вложенные|дочерние)\s+(.+)$/;
const RE_RENAME = /^\s*(?:переименуй|переименовать|переименуйте)(?:\s+(?:слой|это|выделенное|его|её))?\s+в\s+(.+?)\s*$/i;
/* круг 46: проекты словами — имя проекта берётся из набранного (регистр и кавычки) */
const RE_PROJECT_OPEN = /^\s*(?:открой|открыть|откройте|перейди в|перейти в|переключись на|переключиться на)\s+проект\s+(.+?)\s*$/i;
const RE_PROJECT_RENAME = /^\s*(?:переименуй|переименовать|переименуйте)\s+проект\s+в\s+(.+?)\s*$/i;
const RE_PROJECT_NEW_NAMED = /^\s*(?:создай|создать|заведи|завести)\s+(?:новый\s+)?проект\s+(.+?)\s*$/i;

/** Новые фразы таблицы → намерение; null — не они. */
function naturalIntent(t, said) {
  for (const [id, re, make] of NATURAL) {
    if (re.test(t)) return make ? make() : PLAIN_INTENTS[id]();
  }
  const dir = RE_DIRECTION.exec(t);
  if (dir) return { kind: 'direction', mode: /строк/.test(dir[1]) ? 'row' : 'column' };
  const al = RE_ALIGN_KIDS.exec(t);
  if (al) {
    const how = argPick(al[1], ALIGN_WORDS);
    if (how) return { kind: 'align', how };
  }
  const po = RE_PROJECT_OPEN.exec(String(said || ''));
  if (po) { const name = renameValue(po[1]); if (name) return { kind: 'project-open', name }; }
  const pr = RE_PROJECT_RENAME.exec(String(said || ''));
  if (pr) { const name = renameValue(pr[1]); if (name) return { kind: 'project-rename', name }; }
  const pn = RE_PROJECT_NEW_NAMED.exec(String(said || ''));
  if (pn) { const name = renameValue(pn[1]); if (name) return { kind: 'project-new', name }; }
  const rn = RE_RENAME.exec(String(said || ''));
  if (rn) {
    const name = renameValue(rn[1]);
    if (name) return { kind: 'rename', name };
  }
  return null;
}

/**
 * Явная ли это команда оболочки — без документа (круг 38). Всякая слэш-форма — да; фраза —
 * если таблица узнаёт её без имён слоёв и досок. Orchestrator зовёт это, чтобы не
 * отдавать модели «отмени» от старого клиента; исполнять команду он не должен.
 * @param {string} text
 * @returns {boolean}
 */
export function isShellCommandText(text) {
  const s = String(text == null ? '' : text);
  if (/^\s*\/\S?/.test(s)) return true;
  return !!shellIntent(s);
}

/**
 * Какая запись таблицы стоит за намерением (палитра, справка, тесты). null — не из таблицы.
 * @param {{kind: string}} intent
 * @returns {string|null}
 */
export function commandIdOf(intent) {
  if (!intent || typeof intent !== 'object') return null;
  switch (intent.kind) {
    case 'zoom':
      if (intent.by) return intent.by > 1 ? 'zoom-in' : 'zoom-out';
      return intent.to === 1 ? 'zoom-reset' : 'zoom';
    case 'fit': return intent.all == null ? 'fit' : intent.all ? 'fit-all' : 'fit-board';
    case 'fit-selection': return 'fit-selection';
    case 'preview': return 'preview';
    case 'theme': return 'theme';
    case 'select-all': return 'select-all';
    case 'select': return (intent.ids || []).length || intent.name ? 'select-name' : 'deselect';
    case 'select-name': return 'select-name';
    case 'select-rel': return { parent: 'select-parent', children: 'select-children', next: 'select-next', prev: 'select-prev' }[intent.rel] || null;
    case 'delete': return 'delete';
    case 'duplicate': return 'duplicate';
    case 'rename': return 'rename';
    case 'visible': return intent.on ? 'show' : 'hide';
    case 'lock': return intent.on ? 'lock' : 'unlock';
    case 'order': return { up: 'raise', down: 'lower', first: 'to-start', last: 'to-end' }[intent.to] || null;
    case 'wrap': return 'wrap';
    case 'ungroup': return 'ungroup';
    case 'align': return 'align';
    case 'direction': return 'direction';
    case 'gap': return intent.step > 0 ? 'gap-more' : 'gap-less';
    case 'artboard':
      if (intent.step) return intent.step > 0 ? 'board-next' : 'board-prev';
      return 'board';
    case 'rail': return 'layers';
    case 'inspector': return 'inspector';
    case 'sheet':
      if (intent.what === 'settings') return 'settings';
      if (intent.what === 'scales') return 'scales';
      return intent.tab === 'chat' ? 'chat' : 'history';
    case 'export': return 'export';
    case 'import': return 'import';
    case 'new-board': return 'new-board';
    case 'projects': return 'projects';
    case 'project-new': return 'project-new';
    case 'project-open': return 'project-open';
    case 'project-rename': return 'project-rename';
    case 'project-duplicate': return 'project-duplicate';
    case 'undo': return 'undo';
    case 'redo': return 'redo';
    case 'stop': return 'stop';
    case 'variants': return 'variants';
    case 'variants-close': return 'variants-close';
    case 'agent-setting': return { direction: 'art-direction', critic: 'art-critic', webFonts: 'web-fonts' }[intent.what] || null;
    case 'help': return 'help';
    case 'palette': return 'palette';
    default: return null;
  }
}

/** Нужен ли команде выделенный слой (без него — подсказка, а не агент). */
export function needsSelection(intent) {
  const c = CMD_BY_ID.get(commandIdOf(intent));
  return !!(c && c.needs === 'selection');
}

/** Справка «Команды»: группы по порядку, внутри — записи таблицы. Одна истина — таблица. */
export function helpGroups() {
  return SHELL_GROUPS
    .map((group) => ({ group, commands: SHELL_COMMANDS.filter((c) => c.group === group) }))
    .filter((g) => g.commands.length);
}

/** Пример команды для человека: слэш-форма и первая фраза. */
export function commandExample(cmd) {
  const slash = cmd.example || slashOf(cmd);
  const phrase = cmd.phrases[0] ? `«${cmd.phrases[0]}»` : '';
  return [slash, phrase].filter(Boolean).join(' · ');
}

/**
 * Строки палитры. Команда с перечнем значений — строкой на значение («Выровнять детей:
 * по центру»); с числом или именем — строкой, которая дописывает «/имя » в строку команд.
 * У каждой: {key, id, group, title, hint, example, keys, run?: текст команды, fill?: заготовка}.
 */
function paletteBase() {
  const rows = [];
  for (const c of SHELL_COMMANDS) {
    if (c.inPalette === false) continue;
    const slash = slashOf(c);
    const a = c.args && c.args[0];
    const base = { id: c.id, group: c.group, hint: c.hint || '', keys: c.keys || '', phrases: c.phrases };
    if (!a || a.optional && (c.bare || a.kind !== 'enum')) {
      /* Круг 39 (UX): голая строка исполняет ровно «/тема» — подпись не должна обещать
         «/тема тёмная» (пример с аргументом остаётся в справке и у строк со значением). */
      const example = a ? slash : commandExample(c);
      rows.push({ ...base, key: c.id, title: c.title, example, run: slash });
    }
    if (a && a.kind === 'enum') {
      for (const v of a.values) {
        rows.push({ ...base, key: `${c.id}:${v}`, title: `${c.title}: ${v}`, example: `${slash} ${v}`, run: `${slash} ${v}`, value: v });
      }
    } else if (a && !a.optional) {
      rows.push({ ...base, key: c.id, title: `${c.title}…`, example: commandExample(c), fill: `${slash} ` });
    }
  }
  return rows;
}
const PALETTE_BASE = Object.freeze(paletteBase().map((r) => Object.freeze(r)));

/**
 * Поиск по палитре: по названию, слэш-имени, фразам и значениям. Пустой запрос — всё по
 * порядку таблицы. Запрос, который целиком разбирается командой (`/масштаб 150`), даёт
 * первой строкой её саму — Enter исполняет ровно набранное.
 * @param {string} query текст строки команд (с «/» или без)
 * @param {{doc?: object|null, activeArtboardId?: string|null, limit?: number}} [ctx]
 * @returns {object[]}
 */
export function paletteRows(query, ctx = {}) {
  const rawQ = String(query == null ? '' : query).replace(/^\s*\/+/, '');
  const q = slashKey(rawQ);
  const limit = Number.isFinite(ctx.limit) ? ctx.limit : 200;
  if (!q) return PALETTE_BASE.slice(0, limit);
  const out = [];
  /* Круг 39 (N6е): строке палитры документ не нужен — она только узнаёт команду и её
     целиковость; поиск слоя по имени (по всем узлам документа) — при исполнении. */
  const exact = slashIntent(`/${rawQ}`, { doc: null, activeId: null });
  const exactId = commandIdOf(exact);
  const qWords = q.split(' ');
  for (const r of PALETTE_BASE) {
    const c = CMD_BY_ID.get(r.id);
    const title = slashKey(r.title);
    let score = 0;
    for (const s of c.slash) {
      const k = slashKey(s);
      if (r.value ? slashKey(`${k} ${r.value}`) === q : k === q) score = Math.max(score, 100);
      else if (k.startsWith(q) || (r.value && slashKey(`${k} ${r.value}`).startsWith(q))) score = Math.max(score, 80);
    }
    if (!score && title.split(/[\s:]+/).some((w) => w.startsWith(q))) score = 60;
    if (!score && title.includes(q)) score = 50;
    if (!score && c.phrases.some((p) => slashKey(p).includes(q))) score = 40;
    if (!score && r.value && slashKey(r.value).startsWith(q)) score = 35;
    if (!score && qWords.length > 1) {
      const hay = slashKey([r.title, ...c.slash, ...c.phrases, r.value || '', c.hint || ''].join(' '));
      if (qWords.every((w) => hay.includes(w))) score = 30;
    }
    if (!score && slashKey(c.group).startsWith(q)) score = 20;
    if (!score && slashKey(c.hint || '').includes(q) && q.length >= 3) score = 10;
    if (score) out.push({ r, score });
  }
  out.sort((a, b) => b.score - a.score);
  const rows = out.map((o) => o.r);
  // набрано целиком и с аргументом: «/масштаб 150» — первой строкой ровно это
  const complete = exactId && exact.kind !== 'slash-bad' && exact.kind !== 'slash-unknown' && exact.kind !== 'palette';
  if (complete && /\s/.test(q) && !rows.some((r) => slashKey(r.run || '') === slashKey(`/${rawQ}`))) {
    const c = CMD_BY_ID.get(exactId);
    const tail = rawQ.split(/\s+/).slice(1).join(' ');
    rows.unshift({
      key: `typed:${q}`, id: exactId, group: c.group, hint: c.hint || '', keys: c.keys || '', phrases: c.phrases,
      title: `${c.title}: ${cutText(cleanText(tail), 40, { ellipsis: true })}`, example: `/${cleanText(rawQ)}`, run: `/${cleanText(rawQ)}`, typed: true,
    });
  }
  return rows.slice(0, limit);
}

/* ------------- правки команд таблицы: операции ядра, документ не меняют ------------- */

const r2 = (v) => Math.round(v * 100) / 100;
const nodeOf = (doc, id) => (doc && doc.nodes && Object.prototype.hasOwnProperty.call(doc.nodes, id) ? doc.nodes[id] : null);
const titleOf = (doc, id) => {
  const n = nodeOf(doc, id);
  return n ? (n.name || placeholderName(doc, n) || 'слой') : 'слой';
};
const quoted = (doc, ids) => (ids.length === 1 ? `«${cutText(titleOf(doc, ids[0]), 60, { ellipsis: true })}»` : `${ids.length} ${plural(ids.length, 'слой', 'слоя', 'слоёв')}`);

/** Выделенные без потомков уже выделенного — как у удаления и дублирования на холсте. */
export function selectionRoots(doc, ids) {
  const list = [...new Set((ids || []).filter((id) => nodeOf(doc, id) && nodeOf(doc, id).type !== 'page'))];
  return list.filter((id) => !ancestors(doc, id).some((a) => list.includes(a.id)));
}

/**
 * Дублировать (круг 39, N3): операции — `core.duplicateOps`, единственная реализация копии
 * (перепись внутренних ссылок и пропсов, новое имя компонента у копии мастера, «родитель +
 * ребёнок» — одна копия, сдвиг там, где место задаёт pos); оболочка добавляет только слова.
 * Отказ — словами без id.
 * @returns {{ops: object[], ids: string[], words: string}|{error: string}}
 */
export function duplicateOps(doc, ids, o = {}) {
  let r;
  try { r = CORE_NS.duplicateOps(doc, ids, o); } catch (e) { r = { error: e }; }
  if (!r || r.error || !Array.isArray(r.ops) || !r.ops.length) return { error: dupErrorWords(r && r.error) };
  const roots = Array.isArray(r.roots) && r.roots.length ? r.roots : selectionRoots(doc, ids);
  return { ops: r.ops, ids: Array.isArray(r.ids) ? r.ids : [], words: `Дублировал ${quoted(doc, roots)}` };
}

/** Отказ копии словами: без id и кода (они — в консоли разработчика, не человеку). */
function dupErrorWords(err) {
  const msg = cleanText(typeof err === 'string' ? err : (err && (err.message || err.code)) || '');
  if (!msg) return 'Копировать нечего';
  if (/^Копировать нечего/.test(msg)) return msg;   // ядро уже говорит словами
  if (isJargon(msg) || /\b[a-z]{1,4}_[a-z0-9]{4,}\b/i.test(msg)) return 'Копию сделать не вышло — этот слой так не копируется';
  return `Копию сделать не вышло: ${msg.charAt(0).toLowerCase()}${msg.slice(1)}`;
}

/** Переименовать выделенные (обычно один слой). */
export function renameOps(doc, ids, name) {
  const t = cutText(cleanText(name), 120);
  if (!t) return { error: 'Имя пустое' };
  const list = (ids || []).filter((id) => nodeOf(doc, id) && nodeOf(doc, id).type !== 'page' && nodeOf(doc, id).name !== t);
  if (!list.length) return { error: `Слой уже называется «${t}»` };
  const was = quoted(doc, list);
  return { ops: list.map((id) => OPS.set(id, 'name', t)), words: `Переименовал ${was} в «${t}»` };
}

/** Скрыть / показать: `visible: false` — скрыт, поля нет — виден (§1.2). */
export function visibleOps(doc, ids, on) {
  const list = selectionRoots(doc, ids).filter((id) => (nodeOf(doc, id).visible === false) === !!on);
  if (!list.length) return { error: on ? 'Выделенное и так видно' : 'Выделенное уже скрыто' };
  return {
    ops: list.map((id) => OPS.set(id, 'visible', on ? undefined : false)),
    words: `${on ? 'Показал' : 'Скрыл'} ${quoted(doc, list)}`,
  };
}

/** Закрепить / открепить: поле `locked` модели (§1.2) — на холсте слой не выделяется и не двигается. */
export function lockOps(doc, ids, on) {
  const list = selectionRoots(doc, ids).filter((id) => !!nodeOf(doc, id).locked !== !!on);
  if (!list.length) return { error: on ? 'Выделенное уже закреплено' : 'Выделенное и не было закреплено' };
  return {
    ops: list.map((id) => OPS.set(id, 'locked', on ? true : undefined)),
    words: `${on ? 'Закрепил' : 'Открепил'} ${quoted(doc, list)}`,
  };
}

/* Перестановка внутри родителя: целевой порядок, затем ходы `move` — выбранные по
   возрастанию целевого места или в обратном порядке; ходы проверяются прогоном на копии
   списка. Круг 41: запасной «переставить всех детей» убран — он недостижим (подъём,
   опускание, в начало и в конец всегда сходятся одним из двух путей, 200 тыс. случаев,
   notes-r39-CORE); не сошлось — пусто, и команда честно говорит «порядок не изменился». */
function movesTo(parentId, cur, target, moved) {
  const tryOrder = (order) => {
    const sim = cur.slice();
    const list = [];
    for (const id of order) {
      const t = target.indexOf(id);
      sim.splice(sim.indexOf(id), 1);
      sim.splice(t, 0, id);
      list.push(OPS.move(id, parentId, t));
    }
    return sim.join('\u0001') === target.join('\u0001') ? list : null;
  };
  const asc = moved.slice().sort((a, b) => target.indexOf(a) - target.indexOf(b));
  return tryOrder(asc) || tryOrder(asc.slice().reverse()) || [];
}

/**
 * Поднять / опустить / в начало / в конец среди соседей (move внутри родителя). «Выше» —
 * раньше в списке детей, как в панели слоёв.
 * @param {'up'|'down'|'first'|'last'} to
 */
export function reorderOps(doc, ids, to) {
  const roots = selectionRoots(doc, ids);
  const byParent = new Map();
  for (const id of roots) {
    const p = nodeOf(doc, id).parent;
    if (!nodeOf(doc, p)) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(id);
  }
  const list = [];
  const movedAll = [];
  for (const [p, sel] of byParent) {
    const cur = (nodeOf(doc, p).children || []).slice();
    const isSel = new Set(sel);
    let target = cur.slice();
    if (to === 'first') target = [...cur.filter((c) => isSel.has(c)), ...cur.filter((c) => !isSel.has(c))];
    else if (to === 'last') target = [...cur.filter((c) => !isSel.has(c)), ...cur.filter((c) => isSel.has(c))];
    else if (to === 'up') {
      for (let i = 1; i < target.length; i++) {
        if (isSel.has(target[i]) && !isSel.has(target[i - 1])) [target[i - 1], target[i]] = [target[i], target[i - 1]];
      }
    } else if (to === 'down') {
      for (let i = target.length - 2; i >= 0; i--) {
        if (isSel.has(target[i]) && !isSel.has(target[i + 1])) [target[i + 1], target[i]] = [target[i], target[i + 1]];
      }
    }
    if (target.join('\u0001') === cur.join('\u0001')) continue;
    const moved = target.filter((id, i) => cur[i] !== id && isSel.has(id));
    const ops = movesTo(p, cur, target, moved.length ? moved : sel);
    for (const op of ops) list.push(op);
    for (const id of sel) movedAll.push(id);
  }
  const where = { up: 'выше', down: 'ниже', first: 'в начало', last: 'в конец' }[to] || '';
  if (!list.length) return { error: { up: 'Выше некуда — слой и так первый', down: 'Ниже некуда — слой и так последний', first: 'Слой и так первый', last: 'Слой и так последний' }[to] || 'Порядок не изменился' };
  // круг 39 (UX): «Опустил «…» в порядке» — тяжело; говорим, куда в списке слоёв
  const words = {
    up: `Поднял ${quoted(doc, movedAll)} выше в списке слоёв`,
    down: `Опустил ${quoted(doc, movedAll)} ниже в списке слоёв`,
    first: `Поставил ${quoted(doc, movedAll)} ${movedAll.length > 1 ? 'первыми' : 'первым'} в списке слоёв`,
    last: `Поставил ${quoted(doc, movedAll)} ${movedAll.length > 1 ? 'последними' : 'последним'} в списке слоёв`,
  }[to] || `Переставил ${quoted(doc, movedAll)} ${where}`.trim();
  return { ops: list, words };
}

/** Рамка без свободной раскладки: у неё есть дети и поток. */
const isFlowFrame = (n) => !!n && n.type === 'frame' && ['row', 'column'].includes(normalizeLayout(n.layout).mode);

/**
 * Обернуть выделенных соседей в новую рамку. В потоке рамка встаёт на место первого и
 * повторяет поток родителя (направление, зазор, выравнивание), размер — по содержимому.
 * В свободной рамке и на доске со свободной раскладкой — рамка по общим границам, дети
 * сохраняют места на холсте.
 * @param {{rects?: object, name?: string}} [o] rects — геометрия решателя (для свободной рамки)
 */
export function wrapOps(doc, ids, { rects = null, name = 'Группа' } = {}) {
  const roots = selectionRoots(doc, ids);
  if (!roots.length) return { error: 'Оборачивать нечего' };
  if (roots.some((id) => isArtboard(doc, id))) return { error: 'Доску обернуть нельзя — она верхний уровень документа' };
  const parents = new Set(roots.map((id) => nodeOf(doc, id).parent));
  if (parents.size !== 1) return { error: 'Обернуть можно соседей одного родителя — выделите слои в одной рамке' };
  const pid = [...parents][0];
  const parent = nodeOf(doc, pid);
  if (!parent || parent.type !== 'frame') return { error: 'Здесь рамку не поставить' };
  const kids = parent.children || [];
  const order = roots.slice().sort((a, b) => kids.indexOf(a) - kids.indexOf(b));
  const index = kids.indexOf(order[0]);
  const raw = normalizeLayout(parent.layout);
  // ноль — тоже шаг шкалы (§6): рамка оболочки не заводит чисел «мимо шкалы»
  const zi = scaleSteps(doc, 'spacing').indexOf(0);
  const zero = zi >= 0 ? scaleRef('spacing', zi) : 0;
  const pad0 = { t: zero, r: zero, b: zero, l: zero };
  const id = uid('f');
  const ri = scaleSteps(doc, 'radii').indexOf(0);
  const frame = { type: 'frame', id, name, parent: pid, children: [], radius: ri >= 0 ? scaleRef('radii', ri) : 0 };
  const list = [];
  const moves = [];
  if (raw.mode === 'none') {
    const pr = rects && rects[pid];
    const rs = order.map((k) => rects && rects[k]);
    if (!pr || rs.some((r) => !r)) return { error: 'Раскладка ещё не посчитана — повторите через мгновение' };
    const x1 = Math.min(...rs.map((r) => r.x));
    const y1 = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w));
    const y2 = Math.max(...rs.map((r) => r.y + r.h));
    frame.layout = { mode: 'none', gap: zero, padding: pad0, align: 'start', justify: 'start', wrap: false };
    frame.size = { w: { mode: 'fixed', value: r2(x2 - x1) }, h: { mode: 'fixed', value: r2(y2 - y1) } };
    // круг 41 (D4): pos в свободной рамке отсчитывается от её отступа — как у решателя и сцены
    const pad = resolveLayout(doc, parent.layout).padding;
    frame.pos = { x: r2(x1 - pr.x - (pad.l || 0)), y: r2(y1 - pr.y - (pad.t || 0)) };
    order.forEach((k, i) => moves.push(OPS.set(k, 'pos', { x: r2(rs[i].x - x1), y: r2(rs[i].y - y1) })));
  } else {
    frame.layout = { mode: raw.mode, gap: raw.gap, padding: pad0, align: raw.align, justify: 'start', wrap: false };
    frame.size = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  }
  /* Круг 39: дети перечислены в самом create («сгруппировать» одной операцией ядра), а не
     ходами move после него: слияние вычёркивает из списка удалённых соавтором (§9.6), а если
     не осталось ни одного — отбрасывает и сам create (core.rebase): рамка не переживает
     своих слоёв, пустой «Группы» не бывает ни у кого. */
  frame.children = order.slice();
  list.push(OPS.create(frame, index));
  for (const op of moves) list.push(op);
  return { ops: list, id, words: wrapWords(doc, order, name) };
}

/** «Обернул «Шапка» в рамку «Группа»» / «Обернул 2 слоя в рамку …» — и после слияния (круг 41). */
export function wrapWords(doc, ids, name = 'Группа') {
  return `Обернул ${quoted(doc, ids)} в рамку «${cutText(cleanText(name), 60, { ellipsis: true }) || 'Группа'}»`;
}

/**
 * Круг 41 (UX): «Обернуть» подтверждена в другой форме — соавтор успел удалить часть слоёв, и
 * слияние вычеркнуло их из списка детей. Подпись правки — по тому, что легло на самом деле.
 * @param {object} doc документ после подтверждения
 * @param {object[]} ops применённая форма транзакции
 * @param {string} id рамка
 * @param {string[]} asked какие слои оборачивали
 * @returns {null|{words: string, lost: number}} null — легло как просили (или рамки нет)
 */
export function wrapSettledWords(doc, ops, id, asked) {
  const c = (Array.isArray(ops) ? ops : []).find((o) => o && o.op === 'create' && o.node && o.node.id === id);
  if (!c || !Array.isArray(c.node.children) || !Array.isArray(asked)) return null;
  const kids = c.node.children;
  const lostIds = asked.filter((k) => !kids.includes(k));
  const lost = lostIds.length;
  if (!lost || !kids.length) return null;
  return { words: wrapWords(doc, kids, c.node.name), lost, lostIds };
}

/**
 * Круг 43: «1 слой в рамку не вошёл: его удалил Борис» — кто удалил, если известно (один на
 * всех пропавших); иначе «…уже удалили».
 * @param {number} lost
 * @param {{author?: string, author_kind?: string}|null} who
 */
export function wrapLostWords(lost, who = null) {
  const head = `${lost} ${plural(lost, 'слой', 'слоя', 'слоёв')} в рамку не ${lost === 1 ? 'вошёл' : 'вошли'}`;
  const it = lost === 1 ? 'его' : 'их';
  if (!who || (!cleanText(who.author || '') && who.author_kind !== 'agent')) return `${head}: ${it} уже удалили.`;
  // «Борис удалил» → «его удалил Борис»: глагол вперёд, согласование — у whoDid
  const said = whoDid(who, 'удалил');
  const k = said.lastIndexOf(' ');
  return k > 0 ? `${head}: ${it} ${said.slice(k + 1)} ${said.slice(0, k)}.` : `${head}: ${it} ${said}.`;
}

/**
 * Разгруппировать: дети рамки встают на её место в родителе, рамка уходит. В свободном
 * родителе дети сохраняют места на холсте (pos по геометрии решателя).
 */
export function ungroupOps(doc, ids, { rects = null } = {}) {
  const roots = selectionRoots(doc, ids);
  const id = roots.find((k) => nodeOf(doc, k).type === 'frame');
  if (!id) return { error: 'Разгруппировать можно рамку — выделите её' };
  if (isArtboard(doc, id)) return { error: 'Доску разгруппировать нельзя — выделите рамку внутри неё' };
  const node = nodeOf(doc, id);
  const parent = nodeOf(doc, node.parent);
  if (!parent || parent.type !== 'frame') return { error: 'Эту рамку разгруппировать нельзя' };
  const kids = (node.children || []).filter((k) => nodeOf(doc, k));
  const at = (parent.children || []).indexOf(id);
  const free = normalizeLayout(parent.layout).mode === 'none';
  const pr = rects && rects[parent.id];
  // круг 41 (D4): отступ свободного родителя — pos детей отсчитывается от него
  const pad = resolveLayout(doc, parent.layout).padding;
  const list = [];
  kids.forEach((k, i) => {
    list.push(OPS.move(k, parent.id, at + i));
    const r = rects && rects[k];
    if (free && pr && r) list.push(OPS.set(k, 'pos', { x: r2(r.x - pr.x - (pad.l || 0)), y: r2(r.y - pr.y - (pad.t || 0)) }));
  });
  list.push(OPS.remove(id));
  return { ops: list, ids: kids, words: `Разгруппировал «${cutText(titleOf(doc, id), 60, { ellipsis: true })}»` };
}

/**
 * Выровнять детей рамки. Поле — как его зовёт ядро: `layout.align` (поперёк потока) и
 * `layout.justify` (вдоль). В колонке «влево/вправо/по центру» — поперёк, «вверх/вниз» —
 * вдоль; в строке наоборот. «Растянуть» — `align: stretch`.
 * @param {'left'|'center'|'right'|'top'|'bottom'|'stretch'} how
 */
export function alignOps(doc, ids, how) {
  const frames = selectionRoots(doc, ids).filter((id) => isFlowFrame(nodeOf(doc, id)));
  if (!frames.length) {
    const one = nodeOf(doc, (ids || [])[0]);
    if (one && one.type === 'frame') return { error: 'У свободной рамки нет выравнивания — дети стоят по своим местам' };
    return { error: 'Выравнивание детей — у рамки с раскладкой. Выделите рамку' };
  }
  const list = [];
  for (const id of frames) {
    const L = normalizeLayout(nodeOf(doc, id).layout);
    const col = L.mode === 'column';
    const cross = col ? { left: 'start', center: 'center', right: 'end', stretch: 'stretch' } : { top: 'start', center: 'center', bottom: 'end', stretch: 'stretch' };
    const main = col ? { top: 'start', bottom: 'end' } : { left: 'start', right: 'end' };
    if (cross[how] && L.align !== cross[how]) list.push(OPS.set(id, 'layout.align', cross[how]));
    else if (main[how] && L.justify !== main[how]) list.push(OPS.set(id, 'layout.justify', main[how]));
  }
  if (!list.length) return { error: 'Дети уже так выровнены' };
  return { ops: list, words: `Выровнял детей ${quoted(doc, [...new Set(list.map((o) => o.id))])} ${ALIGN_HOW_WORDS[how] || ''}`.trim() };
}

/** Направление потока рамки: строка или колонка (`layout.mode`). */
export function directionOps(doc, ids, mode) {
  const frames = selectionRoots(doc, ids).filter((id) => nodeOf(doc, id).type === 'frame' && !isArtboardFree(doc, id));
  if (!frames.length) return { error: 'Направление — у рамки. Выделите рамку' };
  const list = frames.filter((id) => normalizeLayout(nodeOf(doc, id).layout).mode !== mode)
    .map((id) => OPS.set(id, 'layout.mode', mode));
  if (!list.length) return { error: mode === 'row' ? 'Дети уже стоят строкой' : 'Дети уже стоят колонкой' };
  // круг 39 (UX): «Выстроил строкой детей «…»» — тяжело; «Дети «Карточка» теперь строкой»
  const ids2 = list.map((o) => o.id);
  const whose = ids2.length === 1 ? `«${cutText(titleOf(doc, ids2[0]), 60, { ellipsis: true })}»` : `в ${ids2.length} ${plural(ids2.length, 'рамке', 'рамках', 'рамках')}`;
  return { ops: list, words: `Дети ${whose} теперь ${mode === 'row' ? 'строкой' : 'колонкой'}` };
}
/* Доска со свободной раскладкой — холст, а не поток: направление ей не задаём. */
function isArtboardFree(doc, id) {
  return isArtboard(doc, id) && normalizeLayout(nodeOf(doc, id).layout).mode === 'none';
}

/** Зазор на шаг шкалы отступов больше/меньше (§6: пишется ссылка 'spacing.N'). */
export function gapStepOps(doc, ids, step) {
  const frames = selectionRoots(doc, ids).filter((id) => isFlowFrame(nodeOf(doc, id)));
  if (!frames.length) return { error: 'Зазор — у рамки с раскладкой. Выделите рамку' };
  const steps = scaleSteps(doc, 'spacing');
  const list = [];
  const said = [];
  for (const id of frames) {
    const raw = normalizeLayout(nodeOf(doc, id).layout).gap;
    const now = resolveScale(doc, raw, 'spacing');
    const cur = Number.isFinite(now) ? now : 0;
    const ref = parseScaleRef(raw);
    let next = -1;
    if (ref && ref.scale === 'spacing' && Number.isFinite(steps[ref.index])) next = ref.index + step;
    else if (step > 0) next = steps.findIndex((v) => v > cur);
    else for (let i = steps.length - 1; i >= 0; i--) if (steps[i] < cur) { next = i; break; }
    if (next < 0 || next >= steps.length || !Number.isFinite(steps[next])) continue;
    list.push(OPS.set(id, 'layout.gap', scaleRef('spacing', next)));
    said.push(`${cur} → ${steps[next]} px`);
  }
  if (!list.length) return { error: step > 0 ? 'Зазор уже самый большой на шкале отступов' : 'Зазор уже самый маленький на шкале отступов' };
  return { ops: list, words: `Зазор ${quoted(doc, list.map((o) => o.id))}: ${said[0]}` };
}

/* ------------------ выделение командами таблицы: только ids, без правки ------------------ */

/** «Выделить всё на доске»: верхние слои доски, кроме скрытых и запертых. */
export function selectAllIds(doc, boardId) {
  const board = nodeOf(doc, boardId);
  if (!board || !isArtboard(doc, boardId)) return artboards(doc).map((a) => a.id);
  const out = (board.children || []).filter((k) => {
    const n = nodeOf(doc, k);
    return n && n.visible !== false && !n.locked;
  });
  return out.length ? out : [boardId];
}

/**
 * Родитель, дети, соседи выделенного. {ids} или {error} словами.
 * @param {'parent'|'children'|'next'|'prev'} rel
 */
export function relatedIds(doc, ids, rel) {
  const sel = (ids || []).filter((id) => nodeOf(doc, id));
  if (!sel.length) return { error: 'Сначала выделите слой' };
  if (rel === 'parent') {
    const out = [...new Set(sel.map((id) => nodeOf(doc, id).parent).filter((p) => {
      const n = nodeOf(doc, p);
      return n && p !== doc.root && n.type !== 'page';
    }))];
    return out.length ? { ids: out } : { error: 'Выше доски слоёв нет' };
  }
  if (rel === 'children') {
    const out = sel.flatMap((id) => (nodeOf(doc, id).children || []).filter((k) => nodeOf(doc, k)));
    return out.length ? { ids: out } : { error: `У ${quoted(doc, sel)} нет вложенных слоёв` };
  }
  const id = sel[sel.length - 1];
  const node = nodeOf(doc, id);
  const sibs = isArtboard(doc, id) ? artboards(doc).map((a) => a.id) : ((nodeOf(doc, node.parent) || {}).children || []);
  const i = sibs.indexOf(id);
  const j = rel === 'next' ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= sibs.length) return { error: rel === 'next' ? 'Это последний слой среди соседей' : 'Это первый слой среди соседей' };
  return { ids: [sibs[j]] };
}

/* ---------------- круг 36 (SPEC §11): состояния и движение словами ---------------- */

/** Состояния узла по порядку вкладок инспектора. */
export const STATE_KEYS = Object.freeze(['hover', 'press', 'focus']);
/** Имя состояния — заголовок вкладки и начало фразы в «Истории»: «Наведение «Кнопка»: …». */
export const STATE_TITLES = Object.freeze({ hover: 'Наведение', press: 'Нажатие', focus: 'Фокус' });
/** Где состояния допустимы (§11.1): у страницы — нет. Доски оболочка отсекает сама. */
export const STATE_NODE_TYPES = Object.freeze(['frame', 'text', 'rect', 'ellipse', 'image', 'instance', 'vector']);   // круг 37: и вектор (§12.1)
/** Шкала теней (§11.1): ссылка → слово инспектора. */
export const SHADOW_WORDS = Object.freeze({ none: 'нет', 'shadow.sm': 'лёгкая', 'shadow.md': 'средняя', 'shadow.lg': 'сильная' });
/** Шкала движения: ссылка → «Скорость» инспектора. */
export const SPEED_WORDS = Object.freeze({ 'motion.fast': 'быстро', 'motion.base': 'обычно', 'motion.slow': 'медленно' });
/** Кривые движения словами. */
export const EASING_WORDS = Object.freeze({
  standard: 'обычная', emphasized: 'выразительная', decelerate: 'с торможением',
  accelerate: 'с разгоном', linear: 'ровная', spring: 'пружина',
});
/** Умолчания ядра для шкалы движения (§11.1), мс — пока документ своих не задал. */
export const MOTION_DEFAULTS = Object.freeze({ fast: 120, base: 200, slow: 320 });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Может ли у узла быть состояние (§11.1). */
export function canHaveStates(node) {
  return !!(node && STATE_NODE_TYPES.includes(node.type));
}

/** Есть ли у узла хоть одно непустое состояние — значок в «Слоях» и пометка экспорта. */
export function hasStates(node) {
  const s = node && isObj(node.states) ? node.states : null;
  if (!s) return false;
  return STATE_KEYS.some((k) => isObj(s[k]) && Object.keys(s[k]).length > 0);
}

/** Какие состояния у узла заданы: ['hover', 'press']. */
export function statesOf(node) {
  const s = node && isObj(node.states) ? node.states : null;
  return s ? STATE_KEYS.filter((k) => isObj(s[k]) && Object.keys(s[k]).length > 0) : [];
}

/** Длительность в мс: число как есть, ссылка — по токенам документа или умолчаниям ядра. */
export function motionMs(value, tokens) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = /^motion\.(fast|base|slow)$/.exec(String(value || ''));
  if (!m) return undefined;
  const own = tokens && isObj(tokens.motion) ? tokens.motion[m[1]] : undefined;
  return typeof own === 'number' && Number.isFinite(own) ? own : MOTION_DEFAULTS[m[1]];
}

/** Подъём в px: число как есть, 'spacing.N' — шаг шкалы отступов. */
export function liftPx(value, tokens) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = /^spacing\.(\d+)$/.exec(String(value || ''));
  if (!m) return undefined;
  const steps = tokens && Array.isArray(tokens.spacing) ? tokens.spacing : [];
  const v = steps[Number(m[1])];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Запись поля состояния наименьшей правкой (`set`, §11.1): есть `states.hover` — пишем его
 * поле; нет — пишем `states.hover` целиком; нет и `states` — его. Тогда отмена возвращает
 * узел ровно к прежнему виду, без пустых `states: {hover: {}}`. Снятие последнего поля
 * снимает всё состояние, последнего состояния — и `states`.
 * @returns {{path: string, value?: any}[]} пути и значения для `ops.set(node.id, …)`
 */
export function stateWriteOps(node, key, field, value) {
  if (!node || !STATE_KEYS.includes(key) || !field) return [];
  const states = isObj(node.states) ? node.states : null;
  const cur = states && isObj(states[key]) ? states[key] : null;
  if (value === undefined) {
    if (!cur || !(field in cur)) return [];
    if (Object.keys(cur).some((k) => k !== field)) return [{ path: `states.${key}.${field}`, value: undefined }];
    return stateRemoveOps(node, key);
  }
  if (cur) return [{ path: `states.${key}.${field}`, value }];
  if (states) return [{ path: `states.${key}`, value: { [field]: value } }];
  return [{ path: 'states', value: { [key]: { [field]: value } } }];
}

/** «Убрать состояние»: последнее состояние уносит и `states` (движение остаётся как было). */
export function stateRemoveOps(node, key) {
  const states = node && isObj(node.states) ? node.states : null;
  if (!states || !(key in states)) return [];
  const others = Object.keys(states).filter((k) => k !== key);
  return others.length ? [{ path: `states.${key}`, value: undefined }] : [{ path: 'states', value: undefined }];
}

/** Поле движения той же дисциплиной, что `stateWriteOps`. */
export function motionWriteOps(node, field, value) {
  if (!node || !field) return [];
  const m = isObj(node.motion) ? node.motion : null;
  if (value === undefined) {
    if (!m || !(field in m)) return [];
    return Object.keys(m).some((k) => k !== field) ? [{ path: `motion.${field}`, value: undefined }] : [{ path: 'motion', value: undefined }];
  }
  if (m) return [{ path: `motion.${field}`, value }];
  return [{ path: 'motion', value: { [field]: value } }];
}

/** Путь правки — про состояния или движение (§11.1). */
export function isStatePath(path) {
  return /^(states|motion)(\.|$)/.test(String(path || ''));
}

/** Иммутабельная запись по пути — как у ядра: undefined снимает ключ; массивы (круг 37:
 *  `paths.3.fill`) копируются массивами, а не превращаются в объекты. */
export function setLocal(obj, path, value) {
  const parts = String(path).split('.');
  const root = Array.isArray(obj) ? obj.slice() : { ...(isObj(obj) ? obj : {}) };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    cur[parts[i]] = Array.isArray(next) ? next.slice() : isObj(next) ? { ...next } : {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return root;
}

const STATE_FIELD_WORDS = {
  fill: ['заливка', 'f'], color: ['цвет текста', 'm'], stroke: ['обводка', 'f'],
  opacity: ['непрозрачность', 'f'], scale: ['масштаб', 'm'], lift: ['подъём', 'm'], shadow: ['тень', 'f'],
};
const STATE_FIELD_ORDER = ['lift', 'shadow', 'scale', 'opacity', 'fill', 'color', 'stroke'];
const MOTION_FIELD_ORDER = ['duration', 'easing', 'delay', 'follow'];
const pct = (v) => `${Math.round(Number(v) * 100)} %`;
const num = (v) => String(Math.round(Number(v) * 100) / 100).replace('.', ',');

/** Значение поля состояния словами («2 px», «средняя», «95 %», «акцент»). */
export function stateValueWord(field, v, ctx = {}) {
  if (v === undefined || v === null) return '';
  const tokens = ctx.tokens || null;
  switch (field) {
    case 'lift': {
      const px = liftPx(v, tokens);
      return px === undefined ? String(v) : `${num(px)} px`;
    }
    case 'shadow': return SHADOW_WORDS[v] || String(v);
    case 'scale':
    case 'opacity': return typeof v === 'number' ? pct(v) : String(v);
    case 'fill':
    case 'color':
    case 'stroke': {
      const w = typeof ctx.colorWord === 'function' ? ctx.colorWord(v) : '';
      return w || (isObj(v) ? String(v.token || v.color || '') : String(v));
    }
    default: return typeof v === 'number' ? num(v) : String(v);
  }
}

function stateFieldPhrase(field, from, to, ctx) {
  const [label, g] = STATE_FIELD_WORDS[field] || [field, 'n'];
  if (to === undefined) return `${label} ${g === 'f' ? 'убрана' : g === 'm' ? 'убран' : 'убрано'}`;
  if (field === 'shadow' && to === 'none') return 'без тени';
  const t = stateValueWord(field, to, ctx);
  const f = from === undefined ? '' : (field === 'shadow' && from === 'none' ? 'нет' : stateValueWord(field, from, ctx));
  return f && f !== t ? `${label} ${f} → ${t}` : `${label} ${t}`;
}

function motionValueWord(field, v, ctx) {
  if (field === 'duration' || field === 'delay') {
    const ms = field === 'duration' ? motionMs(v, ctx.tokens) : (typeof v === 'number' ? v : undefined);
    return ms === undefined ? String(v) : `${num(ms)} мс`;
  }
  if (field === 'easing') return EASING_WORDS[v] || String(v);
  if (field === 'follow') return v === 'parent' ? 'вслед за родителем' : 'само по себе';
  return String(v);
}

function motionFieldPhrase(field, from, to, ctx) {
  if (field === 'follow') return to === undefined ? 'само по себе' : motionValueWord('follow', to, ctx);
  const label = field === 'duration' ? '' : field === 'easing' ? 'кривая ' : field === 'delay' ? 'задержка ' : `${field} `;
  if (to === undefined) {
    return field === 'duration' ? 'скорость обычная' : field === 'easing' ? 'кривая обычная' : field === 'delay' ? 'без задержки' : `${field} убрано`;
  }
  const t = motionValueWord(field, to, ctx);
  const f = from === undefined ? '' : motionValueWord(field, from, ctx);
  const val = f && f !== t ? `${f} → ${t}` : t;
  return field === 'easing' ? `${label}«${val}»` : `${label}${val}`;
}

const changed = (a, b) => {
  if (a === b) return false;
  try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
};

/**
 * Правка состояний одного слоя словами (§11.4): «Наведение «Кнопка»: подъём 2 px, тень
 * средняя, 120 мс». Сравнивает слой до и после, а не пути операций, — одинаково звучат
 * и `set states.hover.lift`, и `set states` целиком, и правка агента.
 * @param {object|null} before узел до правки
 * @param {object|null} after узел после
 * @param {string} name имя слоя для «…»
 * @param {{tokens?: object, colorWord?: (v:any)=>string}} [ctx]
 * @returns {string[]} фразы (пусто — состояния и движение не изменились)
 */
export function stateEditPhrases(before, after, name, ctx = {}) {
  const b = before || {};
  const a = after || {};
  const bs = isObj(b.states) ? b.states : {};
  const as = isObj(a.states) ? a.states : {};
  const q = `«${name || 'слой'}»`;
  const out = [];
  for (const key of STATE_KEYS) {
    const was = isObj(bs[key]) ? bs[key] : null;
    const now = isObj(as[key]) ? as[key] : null;
    if (!was && !now) continue;
    const title = STATE_TITLES[key];
    if (was && Object.keys(was).length && (!now || !Object.keys(now).length)) { out.push(`${title} ${q}: убрано`); continue; }
    const fields = [...new Set([...STATE_FIELD_ORDER, ...Object.keys(was || {}), ...Object.keys(now || {})])];
    const bits = [];
    for (const f of fields) {
      const x = was ? was[f] : undefined;
      const y = now ? now[f] : undefined;
      if (!changed(x, y)) continue;
      bits.push(stateFieldPhrase(f, x, y, ctx));
    }
    if (bits.length) out.push(`${title} ${q}: ${bits.join(', ')}`);
  }
  const bm = isObj(b.motion) ? b.motion : {};
  const am = isObj(a.motion) ? a.motion : {};
  const mbits = [];
  for (const f of [...new Set([...MOTION_FIELD_ORDER, ...Object.keys(bm), ...Object.keys(am)])]) {
    if (!changed(bm[f], am[f])) continue;
    // «обычная» кривая — умолчание: явная запись того же самого видимой разницы не даёт
    if (f === 'easing' && (bm[f] || 'standard') === (am[f] || 'standard')) continue;
    if (f === 'follow' && (bm[f] || 'self') === (am[f] || 'self')) continue;
    mbits.push(motionFieldPhrase(f, bm[f], am[f], ctx));
  }
  if (mbits.length) {
    // движение досказывает единственную фразу о состоянии: «…: подъём 2 px, 120 мс»
    if (out.length === 1 && !/: убрано$/.test(out[0])) out[0] = `${out[0]}, ${mbits.join(', ')}`;
    else out.push(`Движение ${q}: ${mbits.join(', ')}`);
  }
  return out;
}

/** В доске (поддереве) есть узлы с состояниями — для пометки экспорта SVG. */
export function subtreeHasStates(doc, rootId) {
  if (!doc || !doc.nodes || !rootId) return false;
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = doc.nodes[id];
    if (!n) continue;
    if (hasStates(n)) return true;
    if (n.type === 'instance' && n.of && doc.nodes[n.of]) stack.push(n.of);
    for (const c of (n.children || [])) stack.push(c);
  }
  return false;
}

/* ---------------- круг 37 (SPEC §12): векторы и иллюстрации в оболочке ---------------- */

/** Режим раскладки рамки, как его понимает решатель: без `layout` (или без режима) — 'none'. */
export function layoutModeOf(node) {
  const m = node && isObj(node.layout) ? node.layout.mode : undefined;
  return m === 'row' || m === 'column' || m === 'none' ? m : 'none';
}

/** Свободная рамка (§12.1): дети стоят по своему `pos`, авто-раскладки нет. */
export function isFreeFrame(node) {
  if (typeof CORE_NS.isFreeFrame === 'function') return !!CORE_NS.isFreeFrame(node);
  return !!(node && node.type === 'frame' && layoutModeOf(node) === 'none');
}

/** Иллюстрация — свободная рамка, в которой есть хотя бы один вектор (§12.1). */
export function isIllustration(doc, node) {
  if (!isFreeFrame(node) || !doc || !doc.nodes) return false;
  if (node.role === 'illustration') return true;   // так помечает рамку образец ядра
  return (node.children || []).some((id) => doc.nodes[id] && doc.nodes[id].type === 'vector');
}

/**
 * Сколько в иллюстрации деталей и слоёв. Деталь — контур (как считает агент в «Нарисовал
 * «Монстрик»: 19 деталей»): вектор из трёх контуров — три детали; не-вектор — одна.
 * @returns {{parts:number, layers:number}}
 */
export function illustrationCounts(doc, node) {
  const kids = node && Array.isArray(node.children) ? node.children : [];
  let parts = 0;
  for (const id of kids) {
    const n = doc && doc.nodes ? doc.nodes[id] : null;
    if (!n) continue;
    parts += n.type === 'vector' ? Math.max(1, vectorPaths(n).length) : 1;
  }
  return { parts, layers: kids.length };
}

/** Родитель-свободная рамка узла (не корень, не страница) — или null. */
export function freeParentOf(doc, node) {
  if (!doc || !doc.nodes || !node || !node.parent || node.parent === doc.root) return null;
  const p = doc.nodes[node.parent];
  return isFreeFrame(p) ? p : null;
}

/** Поворот есть у всех узлов, кроме страницы (§12.1: «визуальное поле, как scale в §11»). */
export function canRotate(node) {
  return !!(node && typeof node.type === 'string' && node.type !== 'page');
}

/** Контуры вектора — массив (пустой, если их нет). */
export function vectorPaths(node) {
  return node && node.type === 'vector' && Array.isArray(node.paths) ? node.paths : [];
}

/** Путь правки — про контуры вектора. */
export function isVectorPath(path) {
  return /^(paths|viewBox)(\.|$)/.test(String(path || ''));
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Цвет для `<input type=color>`: '#abc' → '#aabbcc'; не hex — null. */
export function toHex6(c) {
  const s = String(c || '').trim();
  if (!HEX_RE.test(s)) return null;
  let h = s.slice(1);
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((x) => x + x).join('');
  return `#${h.slice(0, 6).toLowerCase()}`;
}

/** Градиент краски (§12.1) — или null. */
export function gradientOf(p) {
  return isObj(p) && isObj(p.gradient) ? p.gradient : null;
}

/** Вид краски: 'none' | 'token' | 'color' | 'gradient'. */
export function paintKind(p) {
  if (p === undefined || p === null || p === '') return 'none';
  if (patternOf(p)) return 'pattern';   // круг 49 (SPEC §16)
  if (gradientOf(p)) return 'gradient';
  if (typeof p === 'string') return HEX_RE.test(p) || /^(rgb|hsl)a?\(/i.test(p) ? 'color' : 'token';
  if (isObj(p)) {
    if (typeof p.token === 'string') return 'token';
    const c = typeof p.color === 'string' ? p.color : typeof p.value === 'string' ? p.value : '';
    if (c) return paintKind(c);
  }
  return 'none';
}

/** Имя токена краски — или null. */
export function paintToken(p) {
  if (typeof p === 'string' && paintKind(p) === 'token') return p;
  if (isObj(p) && typeof p.token === 'string') return p.token;
  if (isObj(p) && !gradientOf(p)) {
    const c = typeof p.color === 'string' ? p.color : typeof p.value === 'string' ? p.value : '';
    if (c && paintKind(c) === 'token') return c;
  }
  return null;
}

/** Цвет стопа: свой цвет или токен по палитре. */
export function stopColor(stop, colors) {
  if (!isObj(stop)) return null;
  if (typeof stop.color === 'string' && stop.color) return stop.color;
  if (typeof stop.token === 'string' && colors && typeof colors[stop.token] === 'string') return colors[stop.token];
  return null;
}

/** Один цвет, которым краску показать в кружке (у градиента — первый стоп, у фактуры — цвет узора). */
export function paintHex(p, colors) {
  const k = paintKind(p);
  if (k === 'none') return null;
  if (k === 'pattern') return paintHex(patternOf(p).color, colors);
  if (k === 'gradient') {
    const stops = Array.isArray(gradientOf(p).stops) ? gradientOf(p).stops : [];
    return stops.length ? stopColor(stops[0], colors) : null;
  }
  const tok = paintToken(p);
  if (tok) return colors && typeof colors[tok] === 'string' ? colors[tok] : null;
  if (typeof p === 'string') return p;
  return (isObj(p) && (p.color || p.value)) || null;
}

/** Угол линейного градиента — как в CSS (0 — снизу вверх, 90 — слева направо); без угла
 *  ядро рисует 180° — сверху вниз (notes-r37-CORE). */
export const GRADIENT_ANGLE_DEFAULT = 180;

/** CSS-фон для кружка-образца: сплошной цвет или `linear-/radial-gradient(...)`. */
export function paintCss(p, colors) {
  const g = gradientOf(p);
  if (!g) return paintHex(p, colors) || '';
  const stops = (Array.isArray(g.stops) ? g.stops : [])
    .map((s) => {
      const c = stopColor(s, colors);
      if (!c) return null;
      const at = Number.isFinite(Number(s.at)) ? Math.round(Number(s.at) * 100) : null;
      return at === null ? c : `${c} ${at}%`;
    })
    .filter(Boolean);
  if (!stops.length) return '';
  if (stops.length === 1) stops.push(stops[0]);
  if (g.kind === 'radial') {
    const cx = Number.isFinite(Number(g.cx)) ? Number(g.cx) : 0.5;
    const cy = Number.isFinite(Number(g.cy)) ? Number(g.cy) : 0.5;
    return `radial-gradient(circle at ${Math.round(cx * 100)}% ${Math.round(cy * 100)}%, ${stops.join(', ')})`;
  }
  const angle = Number.isFinite(Number(g.angle)) ? Number(g.angle) : GRADIENT_ANGLE_DEFAULT;
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
}

/** Двухцветный градиент: {gradient:{kind, angle?, stops:[{at:0,color},{at:1,color}]}}. */
export function makeGradient(kind, from, to, angle = GRADIENT_ANGLE_DEFAULT) {
  const g = { kind: kind === 'radial' ? 'radial' : 'linear' };
  if (g.kind === 'linear') g.angle = clampAngle(angle);
  g.stops = [{ at: 0, color: from }, { at: 1, color: to }];
  return { gradient: g };
}

function clampAngle(a) {
  const n = Math.round(Number(a));
  if (!Number.isFinite(n)) return GRADIENT_ANGLE_DEFAULT;
  return Math.min(360, Math.max(0, n));
}

/**
 * Градиент с правкой редактора: вид, угол, цвет первого/последнего стопа. Средние стопы и
 * центр радиального градиента остаются как были. Из сплошного цвета — градиент от него.
 * @param {*} p краска до правки
 * @param {{kind?:'linear'|'radial', angle?:number, from?:string, to?:string}} change
 * @param {object} [colors] палитра — цвет из токена в стоп пишется значением
 */
export function gradientWith(p, change = {}, colors = null) {
  const g0 = gradientOf(p);
  if (!g0) {
    const base = paintHex(p, colors) || '#ffffff';
    const out = makeGradient(change.kind || 'linear', change.from || base, change.to || shade(base),
      change.angle ?? GRADIENT_ANGLE_DEFAULT);
    return out;
  }
  const g = { ...g0 };
  const stops = (Array.isArray(g0.stops) ? g0.stops : []).map((s) => ({ ...s }));
  while (stops.length < 2) stops.push({ at: stops.length ? 1 : 0, color: '#ffffff' });
  if (change.kind) {
    g.kind = change.kind === 'radial' ? 'radial' : 'linear';
    if (g.kind === 'linear' && g.angle === undefined) g.angle = GRADIENT_ANGLE_DEFAULT;
    if (g.kind === 'radial') delete g.angle;
  }
  if (change.angle !== undefined && g.kind !== 'radial') g.angle = clampAngle(change.angle);
  const put = (s, c) => { const n = { ...s, color: c }; delete n.token; return n; };
  if (change.from) stops[0] = put(stops[0], change.from);
  if (change.to) stops[stops.length - 1] = put(stops[stops.length - 1], change.to);
  g.stops = stops;
  return { gradient: g };
}

/** Тон темнее — второй цвет нового градиента, чтобы переход было видно сразу. */
function shade(hex) {
  const h = toHex6(hex);
  if (!h) return '#000000';
  const k = 0.72;
  const ch = (i) => Math.round(parseInt(h.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0');
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/* Круг 49 (SPEC §16): фактура в заливке. */
export const PATTERN_KINDS = Object.freeze(['dots', 'lines', 'grid', 'checks', 'waves', 'grain']);
export const PATTERN_RU = Object.freeze({ dots: 'горошек', lines: 'полосы', grid: 'сетка', checks: 'шахматка', waves: 'волны', grain: 'зерно' });
/** Фактура краски — или null. */
export function patternOf(p) {
  return isObj(p) && isObj(p.pattern) ? p.pattern : null;
}
/**
 * Фактура с изменениями (вид, цвет узора, подложка, шаг, угол). Из сплошной краски — горошек цвета
 * «muted» по прежнему цвету (он становится подложкой): вид узнаётся сразу, отмена вернёт как было.
 */
export function patternWith(p, change = {}, colors = null) {
  const cur = patternOf(p);
  const base = cur ? { ...cur } : { kind: 'dots', color: colors && typeof colors.muted === 'string' ? 'muted' : '#5b6270' };
  if (!cur && p !== undefined && p !== null && p !== '' && !gradientOf(p)) base.bg = paintToken(p) || paintHex(p, colors) || undefined;
  const out = { ...base, ...change };
  if (!PATTERN_KINDS.includes(out.kind)) out.kind = 'dots';
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null || out[k] === '') delete out[k];
  if (out.size !== undefined) out.size = Math.max(4, Math.min(200, Math.round(Number(out.size) || 12)));
  if (out.angle !== undefined) out.angle = clampAngle(out.angle);
  return { pattern: out };
}

/** Краска словами: «акцент», «#F4A261», «градиент #F4A261–#E76F51, 90°», «фактура «горошек»: акцент по фону», «нет». */
export function paintWord(p, ctx = {}) {
  const k = paintKind(p);
  if (k === 'none') return 'нет';
  if (k === 'pattern') {
    const pt = patternOf(p);
    const w = (v) => (typeof v === 'string' ? paintWord(v, ctx) : '');
    return `фактура «${PATTERN_RU[pt.kind] || pt.kind}»: ${w(pt.color)}${pt.bg ? ` по ${w(pt.bg)}` : ''}`;
  }
  const colors = ctx.colors || (ctx.tokens && ctx.tokens.colors) || null;
  const one = (c, tok) => {
    if (tok) {
      const w = typeof ctx.colorWord === 'function' ? ctx.colorWord({ token: tok }) : '';
      return w || tok;
    }
    return String(c || '').toUpperCase();
  };
  if (k === 'gradient') {
    const g = gradientOf(p);
    const stops = Array.isArray(g.stops) ? g.stops : [];
    const ends = stops.length ? [stops[0], stops[stops.length - 1]] : [];
    const words = ends.map((s) => one(s.color || stopColor(s, colors), !s.color && s.token ? s.token : null));
    const body = words.length ? ` ${words[0]}–${words[1]}` : '';
    if (g.kind === 'radial') return `радиальный градиент${body}`;
    const angle = Number.isFinite(Number(g.angle)) ? Number(g.angle) : GRADIENT_ANGLE_DEFAULT;
    return `градиент${body}, ${angle}°`;
  }
  const tok = paintToken(p);
  if (tok) return one(null, tok);
  return one(typeof p === 'string' ? p : (p.color || p.value));
}

/** Поворот словами: «15°», «−30°». */
export function rotateWord(v) {
  const n = Math.round(Number(v) * 10) / 10;
  if (!Number.isFinite(n)) return '0°';
  return `${String(n).replace('-', '−').replace('.', ',')}°`;
}

/** Подпись контура: его имя (`paths[i].name`) или номер с единицы — «Контур 3». */
export function pathLabel(i, p) {
  const own = p && typeof p.name === 'string' ? cleanText(p.name) : '';
  return own ? cutText(own, 40, { ellipsis: true }) : `Контур ${Number(i) + 1}`;
}

/** Краска обводки узла-вектора (Stroke: строка или {color, width}) — умолчание контуров. */
function nodeStrokePaint(node) {
  const s = node ? node.stroke : undefined;
  if (s === undefined || s === null) return undefined;
  if (typeof s === 'string') return s;
  if (isObj(s) && !gradientOf(s)) return s.color !== undefined ? s.color : (s.token ? { token: s.token } : undefined);
  return s;
}

/**
 * Что контур показывает на деле (notes-r37-CORE): нет своей заливки/обводки — берётся узла;
 * нет своей толщины — `stroke.width` узла, иначе 1.
 * @param {object} node вектор @param {object} p контур
 * @param {'fill'|'stroke'|'strokeWidth'|'opacity'} field
 */
export function effectivePathValue(node, p, field) {
  const own = isObj(p) ? p[field] : undefined;
  if (own !== undefined) return own;
  if (field === 'fill') return node ? node.fill : undefined;
  if (field === 'stroke') return nodeStrokePaint(node);
  if (field === 'strokeWidth') {
    const w = node && isObj(node.stroke) ? node.stroke.width : undefined;
    return typeof w === 'number' ? w : 1;
  }
  return undefined;
}

/**
 * Общее значение поля у всех контуров: {value, mixed}. Пустой вектор — {value: undefined}.
 * @param {object} node вектор
 * @param {'fill'|'stroke'|'strokeWidth'|'opacity'} field
 */
export function commonPathValue(node, field) {
  const list = vectorPaths(node);
  if (!list.length) return { value: undefined, mixed: false };
  const first = effectivePathValue(node, list[0], field);
  const mixed = list.some((p) => changed(effectivePathValue(node, p, field), first));
  return { value: mixed ? undefined : first, mixed };
}

/**
 * Правка поля контура наименьшими `set` (§12.3): `paths.<i>.<field>` — по контуру, которому
 * она что-то меняет; `which === 'all'` — у всех контуров разом (одна транзакция, точная
 * отмена). Снятие (value undefined) — только там, где поле было.
 * @returns {{path:string, value?:any}[]}
 */
export function pathsWriteOps(node, which, field, value) {
  const list = vectorPaths(node);
  if (!list.length || !field) return [];
  const idx = which === 'all' ? list.map((_, i) => i) : [Number(which)];
  const out = [];
  for (const i of idx) {
    if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
    const p = isObj(list[i]) ? list[i] : {};
    if (value === undefined ? !(field in p) : !changed(p[field], value)) continue;
    out.push({ path: `paths.${i}.${field}`, value });
  }
  return out;
}

const PATH_FIELD_WORDS = {
  fill: 'заливка', stroke: 'обводка', strokeWidth: 'толщина обводки', opacity: 'непрозрачность',
  d: 'форма', fillRule: 'правило заливки', lineCap: 'концы линий', lineJoin: 'стыки линий',
};
const PATH_FIELD_ORDER = ['d', 'fill', 'stroke', 'strokeWidth', 'opacity', 'fillRule', 'lineCap', 'lineJoin'];

function pathValueWord(field, v, ctx) {
  if (field === 'fill' || field === 'stroke') return paintWord(v, ctx);
  if (field === 'opacity') return v === undefined ? '100 %' : pct(v);
  if (field === 'strokeWidth') return v === undefined ? 'нет' : num(v);
  if (field === 'd') return 'изменена';
  return v === undefined ? 'нет' : String(v);
}

const UNKNOWN = Symbol('разное «до»');

function pathFieldPhrase(field, from, to, ctx) {
  const label = PATH_FIELD_WORDS[field] || field;
  if (field === 'd') return 'форма изменена';
  const t = pathValueWord(field, to, ctx);
  const f = from === UNKNOWN ? ''
    : from === undefined && (field === 'fill' || field === 'stroke') ? 'нет'
    : from === undefined ? '' : pathValueWord(field, from, ctx);
  return f && f !== t ? `${label} ${f} → ${t}` : `${label} ${t}`;
}

/**
 * Правка контуров одного вектора словами (§12.3, «История»): «Заливка всех контуров
 * «Тело»: #8BD3C7 → #F4A261», «Контур 3 «Глаз»: обводка нет → #14161C, толщина обводки 2»,
 * «3 контура «Монстр»: заливка акцент». Сравнивает узел до и после — одинаково звучат
 * правка по одному полю, всех контуров разом и перерисовка агента.
 * @param {object|null} before @param {object|null} after @param {string} name
 * @param {{colorWord?: Function, colors?: object, tokens?: object}} [ctx]
 * @returns {string[]}
 */
export function vectorEditPhrases(before, after, name, ctx = {}) {
  const bp = Array.isArray(before && before.paths) ? before.paths : [];
  const ap = Array.isArray(after && after.paths) ? after.paths : [];
  const q = `«${name || 'вектор'}»`;
  const out = [];
  if (!changed(bp, ap) && !changed(before && before.viewBox, after && after.viewBox)) return out;
  if (bp.length !== ap.length) {
    const n = ap.length;
    out.push(`Контуры ${q} перерисованы: ${bp.length} → ${n}`);
    return out;
  }
  if (changed(before && before.viewBox, after && after.viewBox) && !changed(bp, ap)) {
    out.push(`Холст контуров ${q} изменён`);
    return out;
  }
  // поле → значение «после» → список номеров контуров (и было ли у них одно «до»)
  const groups = new Map();
  for (let i = 0; i < ap.length; i++) {
    const b = isObj(bp[i]) ? bp[i] : {};
    const a = isObj(ap[i]) ? ap[i] : {};
    const fields = [...new Set([...PATH_FIELD_ORDER, ...Object.keys(b), ...Object.keys(a)])];
    const bits = [];
    for (const f of fields) {
      if (!changed(b[f], a[f])) continue;
      bits.push({ f, from: b[f], to: a[f] });
    }
    if (!bits.length) continue;
    const key = JSON.stringify(bits.map((x) => [x.f, x.to === undefined ? null : x.to]));
    const g = groups.get(key) || { bits, idx: [], froms: new Set() };
    g.idx.push(i);
    g.froms.add(JSON.stringify(bits.map((x) => (x.from === undefined ? null : x.from))));
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const sameFrom = g.froms.size === 1;
    const words = g.bits.map((x) => pathFieldPhrase(x.f, sameFrom ? x.from : UNKNOWN, x.to, ctx));
    let who;
    if (ap.length === 1) {
      // у вектора один контур — говорим о самом слое: «Заливка в «Животик»: #A → #B»
      const one = words.map((w, i) => (i ? w : `${w.charAt(0).toUpperCase()}${w.slice(1)}`));
      const first = one[0];
      const label = PATH_FIELD_WORDS[g.bits[0].f] || g.bits[0].f;
      const rest = first.slice(label.length + 1);
      out.push(g.bits[0].f === 'd' ? `Форма ${q} изменена${one.length > 1 ? `, ${one.slice(1).join(', ')}` : ''}`
        : `${first.slice(0, label.length)} в ${q}: ${[rest, ...one.slice(1)].join(', ')}`);
      continue;
    }
    if (g.idx.length === ap.length && ap.length > 1) {
      who = g.bits.length === 1 ? null : `Все контуры в ${q}`;
      if (!who) {
        const label = PATH_FIELD_WORDS[g.bits[0].f] || g.bits[0].f;
        const w = words[0].slice(label.length + 1);
        out.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} всех контуров в ${q}: ${w}`);
        continue;
      }
    } else if (g.idx.length === 1) {
      const p = ap[g.idx[0]];
      const own = p && typeof p.name === 'string' && cleanText(p.name);
      who = own ? `Контур «${pathLabel(g.idx[0], p)}» в ${q}` : `${pathLabel(g.idx[0], p)} в ${q}`;
    } else who = `${g.idx.length} ${plural(g.idx.length, 'контур', 'контура', 'контуров')} в ${q}`;
    out.push(`${who}: ${words.join(', ')}`);
  }
  return out;
}

/**
 * Смена раскладки рамки на «свободно» и обратно без прыжков (§12.1): входя в свободную
 * рамку, дети получают `pos` там, где стояли в потоке; уходя из неё — `pos` снимается
 * (в потоке он ничего не значит). Всё — одной транзакцией вместе с `layout.mode`.
 * @param {object} frame рамка
 * @param {object} doc документ (дети)
 * @param {Record<string,{x:number,y:number}>} rects прямоугольники решателя
 * @param {{l:number,t:number}} pad разрешённый отступ рамки (pos — от края содержимого)
 * @param {'row'|'column'|'none'} mode новый режим
 * @returns {{id:string, path:string, value?:any}[]}
 */
export function freeModeOps(frame, doc, rects, pad, mode) {
  if (!frame || !doc || !doc.nodes) return [];
  const was = layoutModeOf(frame);
  if (was === mode) return [];
  const out = [{ id: frame.id, path: 'layout.mode', value: mode }];
  const fr = rects && rects[frame.id];
  const kids = (frame.children || []).map((id) => doc.nodes[id]).filter(Boolean);
  const r2 = (v) => Math.round(v * 100) / 100;
  if (mode === 'none' && fr) {
    for (const k of kids) {
      const r = rects[k.id];
      if (!r) continue;
      const pos = { x: r2(r.x - fr.x - ((pad && pad.l) || 0)), y: r2(r.y - fr.y - ((pad && pad.t) || 0)) };
      if (!changed(k.pos, pos)) continue;
      out.push({ id: k.id, path: 'pos', value: pos });
    }
  } else if (was === 'none') {
    for (const k of kids) if (k.pos !== undefined) out.push({ id: k.id, path: 'pos', value: undefined });
  }
  return out;
}

/* ======================= круг 46: проекты без сервера (соло-режим) ======================= */
/*
 * В соло-режиме (артефакт, dist/local) документов много, как файлов в Figma. Тела документов —
 * в IndexedDB (большие в localStorage не влезают), запасной путь — localStorage с честным
 * предупреждением о размере, последний — память вкладки («проекты не сохраняются в этом
 * браузере»). Список — лёгкий индекс в localStorage: {id, name, created_at, updated_at, boards,
 * nodes, bytes, view, board, tab}. Все обращения к хранилищам — в try/catch.
 * Две вкладки: BroadcastChannel (и событие storage на индексе) — список обновляется; запись
 * поверх более новой записи другой вкладки не проходит молча (`conflict`).
 * Без DOM: окружение (indexedDB, localStorage, BroadcastChannel) передаётся явно — тестам свои.
 */

export const SOLO_INDEX_KEY = 'imago.projects.v1';
export const SOLO_EXIT_KEY = 'imago.projects.exit.v1';
export const SOLO_BODY_PREFIX = 'imago.project.';
export const SOLO_CHANNEL = 'imago-projects';
export const SOLO_IDB = 'imago-projects';
/** Запасной путь: тело больше — localStorage, скорее всего, не примет (≈5 МБ на сайт). */
export const SOLO_LOCAL_WARN_BYTES = 2 * 1024 * 1024;

const soloId = () => `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const nowIso = (now) => new Date(now()).toISOString();

/** Сводка документа для индекса: досок и слоёв. */
export function soloDocStats(doc) {
  let boards = 0;
  try { boards = artboards(doc).length; } catch { boards = 0; }
  return { boards, nodes: userNodeCount(doc) };
}

/** «Новый проект», «Новый проект 2»… — свободное имя среди списка. */
export function freshSoloName(list, base = 'Новый проект') {
  const taken = new Set((list || []).map((p) => p && cleanText(p.name)).filter(Boolean));
  const b = cleanText(base) || 'Новый проект';
  if (!taken.has(b)) return b;
  for (let i = 2; i < 10000; i++) if (!taken.has(`${b} ${i}`)) return `${b} ${i}`;
  return `${b} ${Date.now()}`;
}

/** «Шапка копия», «Шапка копия 2»… — имя дубликата проекта. */
export function copySoloName(list, name) {
  return freshSoloName(list, `${cleanText(name) || 'Без названия'} копия`);
}

/** Строка списка: «2 доски · 48 слоёв · менялся 5 минут назад» (время — словами оболочки). */
export function soloMetaLine(p, when = '') {
  const b = Number(p && p.boards) || 0;
  const n = Number(p && p.nodes) || 0;
  const bits = [
    b ? `${b} ${plural(b, 'доска', 'доски', 'досок')}` : 'без досок',
    `${n} ${plural(n, 'слой', 'слоя', 'слоёв')}`,
  ];
  if (when) bits.push(`менялся ${when}`);
  return bits.join(' · ');
}

/** Поиск по имени: все слова запроса — в имени (регистр и «ё/е» не важны). */
export function filterSoloProjects(list, query) {
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return (list || []).slice();
  return (list || []).filter((p) => { const n = norm(p && p.name); return words.every((w) => n.includes(w)); });
}

/**
 * Проект по сказанному имени: точное совпадение — он; иначе все, где имя похоже.
 * @returns {{one: object|null, many: object[]}}
 */
export function findSoloProject(list, name) {
  const want = cleanText(name).toLowerCase().replace(/ё/g, 'е');
  if (!want) return { one: null, many: [] };
  const all = (list || []).filter((p) => p && p.id);
  const exact = all.filter((p) => cleanText(p.name).toLowerCase().replace(/ё/g, 'е') === want);
  if (exact.length === 1) return { one: exact[0], many: exact };
  const like = exact.length ? exact : all.filter((p) => nameMatches(p.name || '', name) > 0 || cleanText(p.name).toLowerCase().replace(/ё/g, 'е').includes(want));
  return { one: like.length === 1 ? like[0] : null, many: like };
}

/* ---- хранилища тел ---- */

/** Тела в памяти вкладки (последний запасной путь и тесты). */
export function memoryBodies() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(id) { return m.has(id) ? JSON.parse(m.get(id)) : null; },
    async put(id, payload) { m.set(id, JSON.stringify(payload)); },
    async del(id) { m.delete(id); },
  };
}

/** Тела в localStorage (запасной путь: размер ограничен). */
export function localBodies(ls) {
  return {
    kind: 'local',
    async get(id) { const raw = ls.getItem(SOLO_BODY_PREFIX + id); return raw ? JSON.parse(raw) : null; },
    async put(id, payload) { ls.setItem(SOLO_BODY_PREFIX + id, JSON.stringify(payload)); },
    async del(id) { ls.removeItem(SOLO_BODY_PREFIX + id); },
  };
}

/** Тела в IndexedDB: база SOLO_IDB, хранилище «bodies». Открытие — промисом; не вышло — бросает. */
export function idbBodies(idb, name = SOLO_IDB) {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = idb.open(name, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { try { const db = req.result; if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies'); } catch (e) { reject(e); } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB не открылась'));
      req.onblocked = () => reject(new Error('IndexedDB занята'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  };
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction('bodies', mode); } catch (e) { reject(e); return; }
      const store = tx.objectStore('bodies');
      let out;
      let req;
      try { req = fn(store); } catch (e) { reject(e); return; }
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || (req && req.error) || new Error('IndexedDB: запись не прошла'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
    });
  };
  return {
    kind: 'idb',
    open,
    async get(id) { const v = await run('readonly', (s) => s.get(id)); return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v); },
    async put(id, payload) { await run('readwrite', (s) => s.put(JSON.stringify(payload), id)); },
    async del(id) { await run('readwrite', (s) => s.delete(id)); },
  };
}

/* ---- индекс ---- */

export function memoryIndex() {
  let data = { v: 1, list: [], current: null };
  return { kind: 'memory', load() { return JSON.parse(JSON.stringify(data)); }, save(d) { data = JSON.parse(JSON.stringify(d)); } };
}

export function localIndex(ls) {
  return {
    kind: 'local',
    load() {
      const raw = ls.getItem(SOLO_INDEX_KEY);
      const d = raw ? JSON.parse(raw) : null;
      return d && Array.isArray(d.list) ? d : { v: 1, list: [], current: null };
    },
    save(d) { ls.setItem(SOLO_INDEX_KEY, JSON.stringify(d)); },
  };
}

/** Работает ли localStorage на самом деле (в приватном режиме и песочнице — бросает). */
export function usableLocalStorage(ls) {
  try {
    if (!ls) return null;
    const k = 'imago.probe';
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch { return null; }
}

/**
 * Хранилище проектов соло-режима.
 * @param {{bodies?: object, index?: object, channel?: object|null, now?: () => number, tab?: string,
 *          ls?: Storage|null, mode?: string, warn?: string}} o
 */
export function createSoloStore(o = {}) {
  const now = o.now || (() => Date.now());
  const tab = o.tab || `t_${Math.random().toString(36).slice(2, 10)}`;
  const bodies = o.bodies || memoryBodies();
  const index = o.index || memoryIndex();
  const ls = o.ls || null;
  const channel = o.channel || null;
  const listeners = new Set();
  const mode = o.mode || bodies.kind;
  let warn = o.warn || (bodies.kind === 'memory' ? 'memory' : bodies.kind === 'local' ? 'local' : '');
  let cache = null;

  const load = () => {
    try { cache = index.load(); } catch { cache = cache || { v: 1, list: [], current: null }; }
    if (!cache || !Array.isArray(cache.list)) cache = { v: 1, list: [], current: null };
    return cache;
  };
  const save = (d) => {
    cache = d;
    try { index.save(d); return true; } catch { warn = warn || 'index'; return false; }
  };
  const emit = (msg) => { for (const fn of listeners) { try { fn(msg); } catch { /* слушатель не роняет хранилище */ } } };
  const post = (msg) => { try { if (channel) channel.postMessage({ ...msg, tab }); } catch { /* канала нет — другие вкладки узнают по storage */ } };
  if (channel) {
    try {
      channel.onmessage = (ev) => {
        const m = ev && ev.data;
        if (!m || typeof m !== 'object' || m.tab === tab) return;
        load();
        emit(m);
      };
    } catch { /* без канала */ }
  }
  const entryOf = (id) => load().list.find((p) => p.id === id) || null;
  const touchEntry = (d, id, patch) => {
    const i = d.list.findIndex((p) => p.id === id);
    if (i < 0) return null;
    d.list[i] = { ...d.list[i], ...patch };
    return d.list[i];
  };

  const api = {
    tab, mode,
    get warn() { return warn; },
    /** Список, новые по правке сверху. */
    list() {
      return load().list.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    },
    entry: entryOf,
    current() { return load().current || null; },
    setCurrent(id) { const d = load(); d.current = id; save(d); },
    /** Вид проекта (масштаб, сдвиг, активная доска) — в индексе, без записи тела. */
    setView(id, view, board) {
      const d = load();
      if (touchEntry(d, id, { view: view || null, board: board || null })) save(d);
    },
    async read(id) {
      return bodies.get(id);
    },
    /**
     * Записать тело проекта. `base` — updated_at, который эта вкладка знает: запись другой
     * вкладки новее — {conflict} без записи (если не `force`).
     */
    async write(id, payload, { base = null, force = false } = {}) {
      const d = load();
      const e = d.list.find((p) => p.id === id);
      if (!e) return { ok: false, missing: true };
      if (!force && base && e.updated_at && e.updated_at > base && e.tab && e.tab !== tab) {
        return { ok: false, conflict: true, entry: { ...e } };
      }
      let text = '';
      try { text = JSON.stringify(payload); } catch { return { ok: false, error: 'документ не сериализуется' }; }
      await bodies.put(id, payload);
      const stats = soloDocStats(payload && payload.doc);
      let at = nowIso(now);
      if (base && at <= base) at = new Date(Date.parse(base) + 1).toISOString();
      const d2 = load();
      const name = cleanText(payload && payload.doc && payload.doc.meta && payload.doc.meta.name) || e.name;
      const entry = touchEntry(d2, id, { name, updated_at: at, ...stats, bytes: text.length, tab });
      if (!entry) return { ok: false, missing: true };
      save(d2);
      post({ type: 'saved', id, updated_at: at });
      const big = bodies.kind === 'local' && text.length > SOLO_LOCAL_WARN_BYTES;
      return { ok: true, entry: { ...entry }, big };
    },
    async create({ name = '', payload, id = '' } = {}) {
      const d = load();
      const pid = id || soloId();
      const nm = cutText(cleanText(name), 120) || freshSoloName(d.list);
      const body = { ...payload, doc: { ...payload.doc, meta: { ...(payload.doc.meta || {}), name: nm } } };
      await bodies.put(pid, body);
      const at = nowIso(now);
      const entry = { id: pid, name: nm, created_at: at, updated_at: at, ...soloDocStats(body.doc), bytes: JSON.stringify(body).length, view: null, board: null, tab };
      const d2 = load();
      d2.list.push(entry);
      save(d2);
      post({ type: 'list' });
      return { ...entry };
    },
    async rename(id, name) {
      const nm = cutText(cleanText(name), 120);
      if (!nm) return null;
      const body = await bodies.get(id);
      if (body && body.doc) await bodies.put(id, { ...body, doc: { ...body.doc, meta: { ...(body.doc.meta || {}), name: nm } } });
      const d = load();
      const e = touchEntry(d, id, { name: nm });
      if (!e) return null;
      save(d);
      post({ type: 'list' });
      return { ...e };
    },
    async duplicate(id) {
      const e = entryOf(id);
      const body = await bodies.get(id);
      if (!e || !body) return null;
      return api.create({ name: copySoloName(load().list, e.name), payload: { ...body, history: [], cursor: 0 } });
    },
    /** Удалить; вернёт надгробие (запись и тело) для «Вернуть». */
    async remove(id) {
      const d = load();
      const e = d.list.find((p) => p.id === id);
      if (!e) return null;
      let body = null;
      try { body = await bodies.get(id); } catch { body = null; }
      d.list = d.list.filter((p) => p.id !== id);
      if (d.current === id) d.current = null;
      save(d);
      try { await bodies.del(id); } catch { /* тело останется сиротой — не страшно */ }
      post({ type: 'list' });
      return { entry: { ...e }, payload: body };
    },
    async restore(tomb) {
      if (!tomb || !tomb.entry || !tomb.payload) return null;
      await bodies.put(tomb.entry.id, tomb.payload);
      const d = load();
      if (!d.list.some((p) => p.id === tomb.entry.id)) d.list.push({ ...tomb.entry });
      save(d);
      post({ type: 'list' });
      return { ...tomb.entry };
    },
    /** Запись при уходе со страницы — синхронно (IndexedDB не успевает): localStorage. */
    saveOnExit(id, payload) {
      if (!ls) return false;
      try { ls.setItem(SOLO_EXIT_KEY, JSON.stringify({ id, payload, at: nowIso(now), tab })); return true; } catch { return false; }
    },
    /** Запись при уходе, сделанная до перезагрузки: новее тела — переносится в тело. */
    async adoptExit() {
      if (!ls) return null;
      let rec = null;
      try { rec = JSON.parse(ls.getItem(SOLO_EXIT_KEY) || 'null'); } catch { rec = null; }
      if (!rec || !rec.id || !rec.payload) return null;
      const e = entryOf(rec.id);
      try { ls.removeItem(SOLO_EXIT_KEY); } catch { /* снимем в следующий раз */ }
      if (!e || (e.updated_at && rec.at <= e.updated_at)) return null;
      await bodies.put(rec.id, rec.payload);
      const d = load();
      touchEntry(d, rec.id, { updated_at: rec.at, ...soloDocStats(rec.payload.doc), tab: rec.tab || tab });
      save(d);
      return rec.id;
    },
    /** Сообщения других вкладок: {type:'saved', id, updated_at} / {type:'list'}. */
    onRemote(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Событие storage окна (индекс поменяла другая вкладка без канала). */
    storageEvent(ev) {
      if (!ev || ev.key !== SOLO_INDEX_KEY) return;
      const before = cache ? new Map(cache.list.map((p) => [p.id, p.updated_at])) : new Map();
      load();
      for (const p of cache.list) {
        if (p.tab !== tab && before.has(p.id) && p.updated_at > before.get(p.id)) emit({ type: 'saved', id: p.id, updated_at: p.updated_at });
      }
      emit({ type: 'list' });
    },
    close() { try { if (channel) channel.close(); } catch { /* уже закрыт */ } },
  };
  return api;
}

/**
 * Открыть хранилище проектов в этом окружении: IndexedDB → localStorage → память.
 * @param {{indexedDB?: any, localStorage?: any, BroadcastChannel?: any, now?: () => number}} env
 */
export async function openSoloStore(env = {}) {
  const ls = usableLocalStorage(env.localStorage);
  let bodies = null;
  if (env.indexedDB) {
    try { const b = idbBodies(env.indexedDB); await b.open(); bodies = b; } catch { bodies = null; }
  }
  if (!bodies && ls) bodies = localBodies(ls);
  if (!bodies) bodies = memoryBodies();
  // список без localStorage не переживёт перезагрузку — тогда и тела в памяти: честно «не сохраняются»
  if (!ls) bodies = memoryBodies();
  const index = ls ? localIndex(ls) : memoryIndex();
  let channel = null;
  try { channel = env.BroadcastChannel ? new env.BroadcastChannel(SOLO_CHANNEL) : null; } catch { channel = null; }
  return createSoloStore({ bodies, index, channel, ls, now: env.now });
}

/* ── Круг 47 (SPEC §14.5): живой дизайн в карточке итога ────────────────── */

/** Роли палитры решения словами — подписи образцов цвета. */
export const ART_ROLE_WORDS = Object.freeze({
  bg: 'фон', surface: 'плашки', text: 'текст', muted: 'подписи', accent: 'акцент', accent2: 'второй акцент',
});

/**
 * Решение арт-директора и вердикт критика → что показать под итогом команды: образ, образцы
 * палитры, пару шрифтов и оценку критика одной строкой. Данные приходят с сервера: цвет — только
 * #rrggbb, строки — обрезанные, чужое — мимо. null — показывать нечего.
 * @param {object|null} direction @param {object|null} critique
 * @returns {{concept: string, swatches: Array<{role: string, hex: string, label: string}>, fonts: string, verdict: string, line: string}|null}
 */
export function artSummary(direction, critique, opts = {}) {
  const d = direction && typeof direction === 'object' ? direction : null;
  const c = critique && typeof critique === 'object' ? critique : null;
  const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const concept = d ? str(d.concept, 160) : '';
  const pal = d && d.palette && typeof d.palette === 'object' ? d.palette : {};
  const swatches = Object.keys(ART_ROLE_WORDS)
    .map((role) => ({ role, hex: typeof pal[role] === 'string' && /^#[0-9a-f]{6}$/i.test(pal[role]) ? pal[role].toLowerCase() : '', label: ART_ROLE_WORDS[role] }))
    .filter((x) => x.hex);
  const f = d && d.fonts && typeof d.fonts === 'object' ? d.fonts : {};
  const fonts = [str(f.display, 40), str(f.text, 40)].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' + ');
  // круг 47: оценка — о ПЕРВОЙ сборке; круг 52: доработку по снимку критик смотрит ещё раз (after)
  let verdict = '';
  const first = c && (Array.isArray(c.issues) ? str(c.issues[0], 120) : '');
  const score = c && (typeof c.score === 'number' || (typeof c.score === 'string' && c.score.trim()))
    && Number.isFinite(Number(c.score)) ? Math.round(Math.max(0, Math.min(10, Number(c.score))) * 10) / 10 : null;
  if (c && c.seen === 'signals') {
    const n = Array.isArray(c.signals) ? c.signals.length : 0;
    // приметы — короткой формой (полная фраза — для модели); старый сервер short не шлёт — первая фраза
    const shorts = (Array.isArray(c.short) ? c.short : []).map((x) => str(x, 40)).filter(Boolean);
    const what = shorts.length ? shorts.slice(0, 2).join(', ') : (first ? `${first.charAt(0).toLowerCase()}${first.slice(1)}` : '');
    verdict = c.revised ? `Самопроверка: ${what || 'шаблонные ходы'} → доработал`
      : c.verdict === 'revise' ? `Самопроверка: ${what || 'шаблонные ходы'} — доработка не легла, оставил собранное`
        : n ? `Самопроверка: в целом не шаблонно; ${what}` : 'Самопроверка: шаблонных ходов не нашёл';
  } else if (c && score !== null) {
    const s10 = String(score).replace('.', ',');
    const a = c.after && typeof c.after === 'object' ? c.after : null;
    const later = a && Number.isFinite(Number(a.score)) && (typeof a.score === 'number' || (typeof a.score === 'string' && a.score.trim()))
      ? String(Math.round(Math.max(0, Math.min(10, Number(a.score))) * 10) / 10).replace('.', ',') : null;
    verdict = c.revised && later !== null && later !== s10 ? `Первая сборка — ${s10} из 10 → после доработки ${later} из 10`
      : c.revised && later !== null ? `Первая сборка — ${s10} из 10 → доработал${a.verdict === 'ok' ? ', критик доволен' : ', оценка та же'}${first ? `: ${first.charAt(0).toLowerCase()}${first.slice(1)}` : ''}`
      : c.revised ? `Первая сборка — ${s10} из 10 → доработал${first ? `: ${first.charAt(0).toLowerCase()}${first.slice(1)}` : ''}${c.recheck === 'unchecked' ? ' (доработку не перепроверил)' : ''}`
        : c.recheck === 'worse' && later !== null ? `Взгляд со стороны: ${s10} из 10, доработка вышла не лучше (${later} из 10) — оставил первую сборку`
          : c.verdict === 'revise' ? `Взгляд со стороны: ${s10} из 10, доработка не легла — оставил собранное`
            : `Взгляд со стороны: ${s10} из 10`;
  }
  // при нечитаемом тексте оценка вида не к месту — главное там замечание проверки
  if (opts.blocked && verdict && !(c && c.revised)) verdict = '';
  if (!concept && !swatches.length && !fonts && !verdict) return null;
  const line = [concept ? `Образ: ${concept}` : '', fonts, verdict].filter(Boolean).join(' · ');
  // семейства отдельно: оболочка набирает их название ими же («Аа Prata»)
  // короткий образ — до двоеточия или тире («Ночная беговая дорожка»): узкому экрану
  // режем только по «: » или « — » (не внутри «12:30» и кавычек) и только если до него от двух слов
  let conceptShort = concept;
  const sep = /:\s| [—–] /g;
  for (let m; concept && (m = sep.exec(concept));) {
    const head = concept.slice(0, m.index).trim();
    if ((head.match(/«/g) || []).length !== (head.match(/»/g) || []).length) continue;   // внутри кавычек
    if (head.split(/\s+/).length >= 2) conceptShort = head;
    break;
  }
  return { concept, conceptShort, swatches, fonts, families: [str(f.display, 40), str(f.text, 40)].filter((x, i, a) => x && a.indexOf(x) === i), verdict, line };
}

/**
 * Круг 59 (SPEC §21.6): несколько картинок разом — мудборд: одна доска-образец, картинки рядами по
 * MOODBOARD.perRow (каждый ряд — своя рамка), каждая вписана в клетку MOODBOARD.cell × cell·MOODBOARD.tall
 * с сохранением пропорций (мелкие — увеличиваются при показе: цвета от этого не меняются). Доска из одних
 * картинок — образец по §21: арт-директор видит цвета всех (до четырёх, §20). Больше MOODBOARD.max —
 * лишние не кладутся (их число — в `dropped`). Одна картинка — как imageInsertOps без выделения.
 * @param {object} doc
 * @param {{images: {src: string, width: number, height: number, fileName?: string}[], at: {x: number, y: number},
 *   ids: {board: string, images: string[], rows?: string[]}, boards?: number, name?: string}} o — name доски
 *   (по умолчанию «Образец»; круг 63: брошенные на холст — «Картинки»)
 * @returns {{ops: object[], select: string[], into: null, dropped: number}|{error: string}}
 */
export const MOODBOARD = { cell: 240, tall: 1.5, perRow: 2, gap: 12, pad: 12, max: 4 };
export function moodboardOps(doc, o) {
  const list = o && Array.isArray(o.images) ? o.images : [];
  if (!list.length) return { error: 'картинок нет' };
  const taken = list.slice(0, MOODBOARD.max);
  const dropped = list.length - taken.length;
  const made = [];
  for (let i = 0; i < taken.length; i++) {
    const one = imageInsertOps(doc, { ...taken[i], selection: [], at: o.at, ids: { board: o.ids.board, image: o.ids.images[i] }, boards: o.boards });
    if (one.error) return { error: `${taken[i].fileName || `картинка ${i + 1}`}: ${one.error}` };
    if (taken.length === 1) return { ...one, dropped };
    const img = one.ops.map((x) => x.node).find((n) => n && n.type === 'image');
    // вписать в клетку: ширина — клетка, слишком высокая — по высоте клетки
    const k = Number(taken[i].height) / Number(taken[i].width);
    let w = MOODBOARD.cell;
    let h = Math.round(w * k);
    if (h > MOODBOARD.cell * MOODBOARD.tall) { h = Math.round(MOODBOARD.cell * MOODBOARD.tall); w = Math.max(1, Math.round(h / k)); }
    made.push({ ...img, size: { w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: Math.max(1, h) } } });
  }
  const p = MOODBOARD.pad;
  const cols = Math.min(MOODBOARD.perRow, made.length);
  const board = {
    id: o.ids.board, type: 'frame', name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Образец', parent: doc.root, children: [],
    pos: { x: Math.round(Number(o.at && o.at.x) || 0), y: Math.round(Number(o.at && o.at.y) || 0) },
    size: { w: { mode: 'fixed', value: cols * MOODBOARD.cell + (cols - 1) * MOODBOARD.gap + 2 * p }, h: { mode: 'hug' } },
    layout: { mode: 'column', gap: MOODBOARD.gap, padding: { t: p, r: p, b: p, l: p }, align: 'start', justify: 'start', wrap: false },
  };
  const ops = [{ op: 'create', node: board }];
  for (let r = 0; r * MOODBOARD.perRow < made.length; r++) {
    const rowId = (o.ids.rows && o.ids.rows[r]) || `${o.ids.board}_r${r}`;
    ops.push({ op: 'create', node: { id: rowId, type: 'frame', name: `Ряд ${r + 1}`, parent: board.id, children: [],
      size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
      layout: { mode: 'row', gap: MOODBOARD.gap, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'center', justify: 'start', wrap: false } } });
    for (const n of made.slice(r * MOODBOARD.perRow, (r + 1) * MOODBOARD.perRow)) ops.push({ op: 'create', node: { ...n, parent: rowId } });
  }
  return { ops, select: [board.id], into: null, dropped };
}

/**
 * Круг 59: что из брошенного или вставленного не легло в мудборд — словами, у каждой причины своя фраза.
 * @param {{images: number, taken: number, failed: number, other: number, into?: 'reference'|'board'}} c картинок
 *   всего, взято (до max), из взятых не открылось, файлов не-картинок; куда кладутся — образцом или на холст
 * @returns {string} '' — легло всё
 */
export function moodboardLeftover({ images = 0, taken = 0, failed = 0, other = 0, into = 'reference' } = {}) {
  const pl = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  };
  const out = [];
  const over = Math.max(0, images - taken);
  // круг 63: не образец (брошены на холст) — тот же предел, но словами «за раз»
  const cap = into === 'reference' ? `в образец идёт до ${MOODBOARD.max}` : `за раз кладу до ${MOODBOARD.max}`;
  if (over) out.push(`Ещё ${over} ${pl(over, 'картинка не вошла', 'картинки не вошли', 'картинок не вошли')}: ${cap}.`);
  if (failed > 0) out.push(`${failed} ${pl(failed, 'картинка не открылась', 'картинки не открылись', 'картинок не открылись')}.`);
  if (other > 0) out.push(`${other} ${pl(other, 'файл — не картинка', 'файла — не картинки', 'файлов — не картинки')}.`);
  return out.join(' ');
}

/**
 * Круг 58 (SPEC §21.5): картинка, вставленная в строку команды, — образец для этой команды. Она ложится
 * на макет отдельной доской (её цвета видит арт-директор, модели со зрением — её саму), а в строке
 * появляются слова об образце, если их там ещё нет: команда без них образца не берёт (§21).
 * Пустая строка — готовая команда «собери экран в цветах этой картинки» с выделенным словом «экран»:
 * человек впечатывает свой предмет поверх. Строка с «/» — команда оболочки, её не трогаем.
 * @param {string} value текст строки команды
 * @returns {{value: string, caret: number, caretEnd?: number}}
 */
export const REFERENCE_WORDS = 'в цветах этой картинки';
/** Круг 59: образец из нескольких картинок (мудборд). */
export const REFERENCE_WORDS_MANY = 'в цветах этих картинок';
export function referenceCommandText(value, { many = false } = {}) {
  const text = String(value == null ? '' : value);
  if (RE_IMAGE_REF.test(text) || text.trim().startsWith('/')) return { value: text, caret: text.length };
  const head = text.replace(/[\s,.;:—–-]+$/u, '');
  const words = many ? REFERENCE_WORDS_MANY : REFERENCE_WORDS;
  if (!head.trim()) {
    const v = `собери экран ${words}`;
    return { value: v, caret: 7, caretEnd: 12 };
  }
  const value2 = `${head} ${words}`;
  return { value: value2, caret: value2.length };
}

/**
 * Круг 58: текст, который браузер кладёт в буфер вместе с картинкой, — имя файла или адрес, а не
 * слова человека: каждая строка кончается расширением картинки или это адрес (круг 59: несколько строк —
 * несколько файлов).
 */
export function clipboardTextIsLabel(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  // несколько файлов из файлового менеджера — их имена по строке на файл
  const lines = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.length <= 32 && lines.every((x) => /^(?:https?:\/\/|data:image\/|file:\/\/)\S+$/iu.test(x)
    || (/\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/iu.test(x) && x.length <= 255));
}

/**
 * Круг 55 (SPEC §21): картинка в макет — вставкой из буфера или перетаскиванием файла. Куда:
 * выделена рамка — в неё последним слоем; выделен другой слой — в его рамку сразу за ним; ничего
 * (или выделено несколько, или библиотека) — новой доской по размеру картинки в `at`. Ширина — не
 * больше IMAGE_INSERT.maxW, высота по пропорции. Имя — из имени файла без расширения.
 * Рамка уже картинки — ширина по её внутренней ширине (`innerWidth(id)` от оболочки); узкая рамка (меньше
 * IMAGE_INSERT.minInto: кнопка, чип) — картинка за ней, а не внутри. В рамку без потока (`layout.mode`
 * none) — в точку броска (`at` в мировых координатах, `origin` — угол рамки).
 * @param {object} doc
 * @param {{selection?: string[], src: string, width: number, height: number, fileName?: string,
 *   at: {x: number, y: number}, ids: {board: string, image: string}, boards?: number,
 *   innerWidth?: (id: string) => number|null, origin?: (id: string) => {x: number, y: number}|null}} o
 * @returns {{ops: object[], select: string[], into: string|null}|{error: string}}
 */
/* хранится вдвое крупнее показа (960 при показе до 480) и до 600 КБ: предел документа на сервере — 24 МБ,
   и каждая картинка — ещё и в истории отмены */
export const IMAGE_INSERT = { maxW: 480, maxSide: 960, maxBytes: 600 * 1024, minInto: 160 };
export function imageInsertOps(doc, o) {
  const nodes = doc && doc.nodes && typeof doc.nodes === 'object' ? doc.nodes : null;
  if (!nodes || typeof doc.root !== 'string') return { error: 'документ не открыт' };
  if (!o || typeof o.src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(o.src)) return { error: 'это не картинка' };
  const nw = Number(o.width);
  const nh = Number(o.height);
  if (!(nw > 0 && nh > 0)) return { error: 'у картинки нет размера' };
  const sized = (cap) => {
    const w = Math.max(1, Math.round(Math.min(nw, IMAGE_INSERT.maxW, cap > 0 ? cap : Infinity)));
    return { w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: Math.max(1, Math.round((w * nh) / nw)) } };
  };
  const inner = (id) => (typeof o.innerWidth === 'function' ? Number(o.innerWidth(id)) || 0 : 0);
  const freeAt = (parent) => {
    if (!parent || (parent.layout && parent.layout.mode && parent.layout.mode !== 'none')) return {};
    const org = typeof o.origin === 'function' ? o.origin(parent.id) : null;
    return org ? { pos: { x: Math.max(0, Math.round(o.at.x - org.x)), y: Math.max(0, Math.round(o.at.y - org.y)) } } : {};
  };
  const base = typeof o.fileName === 'string' ? o.fileName.replace(/\.[a-z0-9]{2,5}$/i, '') : '';
  const name = base.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Картинка';
  const image = { id: o.ids.image, type: 'image', name, src: o.src, size: sized(0) };
  const own = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null;
  const inLibrary = (id) => {
    for (let cur = id, i = 0; own(cur) && i < 64; i++) {
      const n = own(cur);
      if (n.type === 'page' && n.role === 'library') return true;
      cur = n.parent;
    }
    return false;
  };
  const sel = Array.isArray(o.selection) ? o.selection.filter((id) => own(id) && id !== doc.root) : [];
  if (sel.length === 1 && !inLibrary(sel[0])) {
    const n = own(sel[0]);
    const roomy = n.type === 'frame' && (n.parent === doc.root || !(inner(n.id) > 0) || inner(n.id) >= IMAGE_INSERT.minInto);
    if (n.type === 'frame' && !n.locked && n.visible !== false && roomy) {
      return { ops: [{ op: 'create', node: { ...image, size: sized(inner(n.id)), parent: n.id, ...freeAt(n) } }], select: [image.id], into: n.id };
    }
    const p = own(n.parent);
    if (p && p.type === 'frame' && p.id !== doc.root && !p.locked && p.visible !== false) {
      const at = Array.isArray(p.children) ? p.children.indexOf(n.id) : -1;
      return { ops: [{ op: 'create', node: { ...image, size: sized(inner(p.id)), parent: p.id, ...freeAt(p) }, ...(at >= 0 ? { index: at + 1 } : {}) }], select: [image.id], into: p.id };
    }
  }
  const pad = 0;
  const board = {
    id: o.ids.board, type: 'frame', name: name === 'Картинка' ? `Картинка ${(Number(o.boards) || 0) + 1}` : name, parent: doc.root, children: [],
    pos: { x: Math.round(Number(o.at && o.at.x) || 0), y: Math.round(Number(o.at && o.at.y) || 0) },
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
    layout: { mode: 'column', gap: 0, padding: { t: pad, r: pad, b: pad, l: pad }, align: 'start', justify: 'start', wrap: false },
  };
  return { ops: [{ op: 'create', node: board }, { op: 'create', node: { ...image, parent: board.id } }], select: [image.id], into: null };
}

/* ------------------------- круг 67: цвета экрана в инспекторе ------------------------- */

/** Имя цвета, которое тема доски принимает (как `THEME_NAME_RE` ядра): «__proto__» ключом не пишется. */
const THEME_COLOR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** Цвет кодом без прозрачности ('#abc' | '#aabbcc') → '#aabbcc'; иначе null (с прозрачностью — не равен никакому выбору). */
function opaqueHex(c) {
  const v = String(c == null ? '' : c).trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? toHex6(v) : null;
}

/**
 * Круг 67 (SPEC §15.6): строки «Цвета экрана» — каждый цвет документа (и имена темы, которых в
 * документе нет) с тем, что видит доска: `hex` — действующий (для поля выбора; null — цвет задан не
 * кодом), `own` — свой у экрана, `docHex` — общий без прозрачности (null — нет такого или он не код
 * без прозрачности), `alpha` — общий с прозрачностью, `editable` — тема примет этот цвет.
 * @returns {{name: string, hex: string|null, own: boolean, docHex: string|null, alpha: boolean, editable: boolean}[]}
 */
export function boardColorRows(doc, board) {
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const own = isObj(theme.colors) ? theme.colors : {};
  const base = (doc && doc.tokens && isObj(doc.tokens.colors)) ? doc.tokens.colors : {};
  const limit = (CORE_NS.THEME_LIMITS && CORE_NS.THEME_LIMITS.colors) || 64;
  const room = Object.keys(own).length < limit;
  const rows = [];
  for (const name of [...Object.keys(base), ...Object.keys(own).filter((k) => !Object.prototype.hasOwnProperty.call(base, k))]) {
    const mine = Object.prototype.hasOwnProperty.call(own, name) ? toHex6(own[name]) : null;
    const docHex = opaqueHex(base[name]);
    const shown = mine || toHex6(base[name]);
    rows.push({ name, hex: shown, own: !!mine, docHex, alpha: !mine && !docHex && !!shown,
      editable: THEME_COLOR_NAME_RE.test(name) && (!!mine || room) });
  }
  return rows;
}

/** Фон, на котором читается текст доски: её заливка-токен, иначе холст. */
function boardGround(board, base) {
  const f = board && board.fill;
  const t = typeof f === 'string' ? f : (isObj(f) && typeof f.token === 'string' ? f.token : null);
  return t && Object.prototype.hasOwnProperty.call(base, t) ? t : 'canvas';
}

/**
 * Круг 67 (SPEC §15.6): правка цвета экрана из инспектора — операция по пути `theme.colors.<имя>`
 * (две правки разных цветов одной доски с двух вкладок не затирают друг друга). `hex` null или
 * равный общему цвету документа — цвет снимается с темы; тема опустела — снимается вся (цвета
 * опустели, шрифты есть — снимаются только цвета). Шрифты темы не трогаются. Ничего не меняется,
 * имя не по ядру или тема не годится — null. `title` — имя цвета человеку («акцент») для истории.
 * @returns {{ops: object[], label: string, warnings: string[]}|null}
 */
export function themeColorOps(doc, board, name, hex, { title } = {}) {
  if (!board || !board.id || typeof name !== 'string' || !THEME_COLOR_NAME_RE.test(name)) return null;
  const want = hex == null ? null : toHex6(hex);
  if (hex != null && !want) return null;
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const base = (doc && doc.tokens && isObj(doc.tokens.colors)) ? doc.tokens.colors : {};
  const colors = { ...(isObj(theme.colors) ? theme.colors : {}) };
  const docHex = opaqueHex(base[name]);
  const had = Object.prototype.hasOwnProperty.call(colors, name);
  if (want === null || want === docHex) {
    if (!had) return null;
    delete colors[name];
  } else {
    if (had && toHex6(colors[name]) === want) return null;
    colors[name] = want;
  }
  const next = { ...theme };
  if (Object.keys(colors).length) next.colors = colors; else delete next.colors;
  const value = Object.keys(next).length ? next : undefined;
  if (value !== undefined && CORE_NS.themeProblem && CORE_NS.themeProblem(value)) return null;
  const ops = value === undefined ? [OPS.set(board.id, 'theme', undefined)]
    : !next.colors ? [OPS.set(board.id, 'theme.colors', undefined)]
      : [OPS.set(board.id, `theme.colors.${name}`, colors[name])];
  const screen = `«${String(board.name || 'Доска').slice(0, 40)}»`;
  const said = typeof title === 'string' && title.trim() ? title.trim().slice(0, 40) : name;
  const label = value === undefined ? `Экран ${screen} вернулся к оформлению документа`
    : colors[name] ? `Свой цвет экрана ${screen}: ${said} ${want.toUpperCase()}`
      : `Экран ${screen}: ${said} — как в документе`;
  // контраст после правки — по тому, что увидит доска; фон — её заливка (часто карточка, не холст)
  const ground = boardGround(board, base);
  const pairs = [['text', ground, 4.5, 'текст на фоне экрана читается'], ['muted', ground, 3, 'подписи на фоне экрана читаются'],
    ['text', 'surface', 4.5, 'текст на карточках читается'], ['onAccent', 'accent', 4.5, 'текст на акценте читается']]
    .filter(([fg, bg], i, all) => all.findIndex(([f, b]) => f === fg && b === bg) === i);
  const warnings = [];
  const seen = (k) => opaqueHex((value && value.colors && value.colors[k]) || base[k]);
  if (CORE_NS.contrastRatio) {
    for (const [fg, bg, min, ru] of pairs) {
      if (fg !== name && bg !== name) continue;
      const a = seen(fg); const b = seen(bg);
      if (!a || !b) continue;
      const r = CORE_NS.contrastRatio(a, b);
      // вниз до десятых: 2.96 — не «3.0 при нужных 3»
      if (r < min) warnings.push(`На экране ${screen} ${ru} плохо: контраст ${(Math.floor(r * 10) / 10).toFixed(1)}:1 (нужно от ${min}:1)`);
    }
  }
  return { ops, label, warnings };
}

/* ------------------------- круг 68: шрифты экрана в инспекторе ------------------------- */

const FONT_ROLE_WORDS = { display: 'заголовков', text: 'текста' };
const famKey = (f) => String(f || '').replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Насыщенность, которую сами подбираем стилю роли (как арт-директор, §15.3): «heading» в тексте — не тоньше 600. */
function roleWeight(base, name, role) {
  const docW = isObj(base) && typeof base.fontWeight === 'number' ? base.fontWeight : 400;
  return role === 'text' && /head/i.test(name) ? Math.max(docW, 600) : docW;
}

/** Стили текста документа, которые тема доски может перекрасить шрифтом, по ролям (как у арт-директора). */
function fontRoleStyles(doc) {
  const types = (doc && doc.tokens && isObj(doc.tokens.type)) ? doc.tokens.type : {};
  const out = { display: [], text: [] };
  for (const name of Object.keys(types)) {
    if (!THEME_COLOR_NAME_RE.test(name) || !isObj(types[name])) continue;
    const role = textRole(doc, name, 0);
    if (role) out[role].push(name);
  }
  return out;
}

/**
 * Круг 68 (SPEC §15.7): строки «Шрифты экрана» — две роли, как у арт-директора (§15.3): заголовки
 * (display/title/hero и кегль от 24) и текст (прочие, кроме моно). `font` — шрифт, каким доска видит
 * стили роли (разные — null), `own` — у какого-то стиля роли шрифт свой у экрана, `docFont` —
 * общий шрифт роли в документе (разные — null).
 * @returns {{role: 'display'|'text', title: string, styles: string[], font: string|null, own: boolean, docFont: string|null}[]}
 */
export function boardFontRows(doc, board) {
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const tt = isObj(theme.type) ? theme.type : {};
  const types = (doc && doc.tokens && isObj(doc.tokens.type)) ? doc.tokens.type : {};
  const roles = fontRoleStyles(doc);
  const one = (list) => (list.length && list.every((f) => famKey(f) === famKey(list[0])) ? list[0] : null);
  return ['display', 'text'].filter((r) => roles[r].length).map((role) => {
    const styles = roles[role];
    const docFonts = styles.map((n) => types[n].font || '');
    const seen = styles.map((n, i) => (isObj(tt[n]) && tt[n].font) || docFonts[i]);
    return { role, title: `Шрифт ${FONT_ROLE_WORDS[role]}`, styles, font: one(seen), own: styles.some((n) => isObj(tt[n]) && !!tt[n].font), docFont: one(docFonts) };
  });
}

/**
 * Круг 68 (SPEC §15.7): шрифт роли у одного экрана — по операции на стиль по пути `theme.type.<стиль>`
 * (`{font, fontWeight?}`: насыщенность — ближайшая у семейства к стилю документа, пишется, только если
 * отличается). Шрифт стиля в документе тот же — запись стиля снимается; `family` null — снимаются все
 * стили роли. Опустели шрифты, цвета есть — `set theme.type` пустым; опустела тема — `set theme` пустым.
 * Только семейства набора (`FONT_CATALOG`). Ничего не меняется — null.
 * @returns {{ops: object[], label: string}|null}
 */
export function themeFontOps(doc, board, role, family) {
  if (!board || !board.id || !FONT_ROLE_WORDS[role]) return null;
  const fam = family == null ? null : catalogFont(family);
  if (family != null && !fam) return null;
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const types = (doc && doc.tokens && isObj(doc.tokens.type)) ? doc.tokens.type : {};
  const type = { ...(isObj(theme.type) ? theme.type : {}) };
  const styles = fontRoleStyles(doc)[role];
  if (!styles.length) return null;
  const changed = [];
  for (const name of styles) {
    const base = types[name];
    const docW = typeof base.fontWeight === 'number' ? base.fontWeight : 400;
    const was = type[name];
    // насыщенность, записанная темой (агентом), — своя: шрифт её не стирает и берёт за образец
    // как у арт-директора (§15.3): «heading» в роли текста — не тоньше 600
    const roleW = roleWeight(base, name, role);
    // ближайшая к стилю у прежнего шрифта (её писали сами — при смене шрифта считается заново)
    const autoW = isObj(was) && was.font ? nearestWeight(was.font, roleW) : null;
    const ownW = isObj(was) && typeof was.fontWeight === 'number' && was.fontWeight !== autoW ? was.fontWeight : null;
    let entry;
    if (!fam || famKey(base.font) === famKey(fam.family)) entry = ownW != null && ownW !== docW ? { fontWeight: ownW } : undefined;
    else {
      const want = ownW != null ? ownW : roleW;
      const w = nearestWeight(fam.family, want);
      entry = w !== docW ? { font: fam.family, fontWeight: w } : { font: fam.family };
    }
    if (JSON.stringify(was) === JSON.stringify(entry)) continue;
    if (entry === undefined) delete type[name]; else type[name] = entry;
    changed.push(name);
  }
  if (!changed.length) return null;
  const next = { ...theme };
  if (Object.keys(type).length) next.type = type; else delete next.type;
  const value = Object.keys(next).length ? next : undefined;
  if (value !== undefined && CORE_NS.themeProblem && CORE_NS.themeProblem(value)) return null;
  const ops = value === undefined ? [OPS.set(board.id, 'theme', undefined)]
    : !next.type ? [OPS.set(board.id, 'theme.type', undefined)]
      : changed.map((n) => OPS.set(board.id, `theme.type.${n}`, type[n]));
  const screen = `«${String(board.name || 'Доска').slice(0, 40)}»`;
  const label = value === undefined ? `Экран ${screen} вернулся к оформлению документа`
    : fam && changed.some((n) => type[n]) ? `Шрифт ${FONT_ROLE_WORDS[role]} экрана ${screen}: ${fam.family}`
      : `Экран ${screen}: шрифт ${FONT_ROLE_WORDS[role]} — как в документе`;
  return { ops, label };
}

/** Круг 68: семейства набора для выбора шрифта — по видам, как в меню арт-директора. */
export function fontChoices() {
  const kinds = [['sans', 'Гротески'], ['serif', 'Антиквы'], ['slab', 'Брусковые'], ['display', 'Акцидентные'], ['script', 'Рукописные']];
  return kinds.map(([k, title]) => ({ title, families: FONT_CATALOG.filter((f) => f.kind === k).map((f) => f.family) })).filter((g) => g.families.length);
}

/* ------------------------- круг 73: шрифт отдельного стиля экрана ------------------------- */

/**
 * Круг 73 (SPEC §15.10): строки «По стилям» — каждый стиль ролей (§15.7) отдельно: каким шрифтом и
 * насыщенностью доска его видит, что в документе, что своё у экрана и какие насыщенности есть у
 * видимого шрифта (вне набора — только записанная).
 * @returns {{style: string, title: string, role: string, font: string, docFont: string, ownFont: boolean,
 *   weight: number, docWeight: number, ownWeight: boolean, weights: number[]}[]}
 */
export function boardStyleFontRows(doc, board) {
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const tt = isObj(theme.type) ? theme.type : {};
  const types = (doc && doc.tokens && isObj(doc.tokens.type)) ? doc.tokens.type : {};
  const roles = fontRoleStyles(doc);
  const out = [];
  for (const role of ['display', 'text']) {
    for (const style of roles[role]) {
      const base = types[style];
      const mine = isObj(tt[style]) ? tt[style] : {};
      const docFont = String(base.font || '');
      const docWeight = typeof base.fontWeight === 'number' ? base.fontWeight : 400;
      const font = mine.font || docFont;
      const weight = typeof mine.fontWeight === 'number' ? mine.fontWeight : docWeight;
      const fam = catalogFont(font);
      const weights = fam ? [...fam.weights] : [weight];
      // своя — не та, что сами подобрали шрифту (ближайшая к стилю роли, как в круге 68)
      const autoWeight = nearestWeight(font, roleWeight(base, style, role));
      const ownWeight = typeof mine.fontWeight === 'number' && !(mine.font && mine.fontWeight === autoWeight);
      const ru = ruToken('type', style);
      out.push({ style, title: ru.charAt(0).toUpperCase() + ru.slice(1), role, font, docFont, ownFont: !!mine.font,
        weight, docWeight, autoWeight, ownWeight, weights });
    }
  }
  return out;
}

/**
 * Круг 73 (SPEC §15.10): шрифт и/или насыщенность одного стиля у экрана — одна операция
 * `theme.type.<стиль>`. `change.font`: семейство набора или null («как в документе»); `change.fontWeight`:
 * число или null («как в документе»); не названное — как есть. Новый шрифт без названной насыщенности
 * берёт ближайшую к своей (записанной) или к документу; записывается то, что отличается от документа.
 * Опустела запись — снимается; опустели шрифты — `theme.type` пустым; опустела тема — `theme` пустым.
 * @returns {{ops: object[], label: string}|null}
 */
export function themeStyleFontOps(doc, board, style, change = {}) {
  if (!board || !board.id || !isObj(change)) return null;
  const types = (doc && doc.tokens && isObj(doc.tokens.type)) ? doc.tokens.type : {};
  const roles = fontRoleStyles(doc);
  const role = roles.display.includes(style) ? 'display' : roles.text.includes(style) ? 'text' : null;
  if (!role) return null;
  const base = types[style];
  const rw = roleWeight(base, style, role);
  const theme = (CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || {};
  const type = { ...(isObj(theme.type) ? theme.type : {}) };
  const was = isObj(type[style]) ? type[style] : {};
  const docW = typeof base.fontWeight === 'number' ? base.fontWeight : 400;
  let font = was.font;
  if (Object.prototype.hasOwnProperty.call(change, 'font')) {
    if (change.font == null) font = undefined;
    else {
      const fam = catalogFont(change.font);
      if (!fam) return null;
      font = famKey(fam.family) === famKey(base.font) ? undefined : fam.family;
    }
  }
  const seenFont = font || base.font;
  let weight = was.fontWeight;
  if (Object.prototype.hasOwnProperty.call(change, 'fontWeight')) {
    // «как в документе» — ближайшая у видимого шрифта к стилю (у Prata — 400, а не несуществующие 600)
    if (change.fontWeight == null) weight = nearestWeight(seenFont, rw);
    else {
      const w = Number(change.fontWeight);
      if (!Number.isFinite(w) || w < 100 || w > 900) return null;
      weight = nearestWeight(seenFont, w);
    }
  } else if (font !== was.font) {
    // шрифт сменился, насыщенность не названа — ближайшая у нового к своей насыщенности стиля; своя —
    // только не та, что сами подобрали прежнему шрифту (ближайшая к стилю роли, как в круге 68);
    // шрифт вне набора — nearestWeight отдаёт просимое
    const autoW = was.font && typeof was.fontWeight === 'number' ? nearestWeight(was.font, rw) : null;
    const ownW = typeof was.fontWeight === 'number' && was.fontWeight !== autoW ? was.fontWeight : null;
    weight = nearestWeight(seenFont, ownW != null ? ownW : rw);
  }
  if (weight === docW) weight = undefined;
  const entry = {};
  if (font) entry.font = font;
  if (weight !== undefined) entry.fontWeight = weight;
  const next = Object.keys(entry).length ? entry : undefined;
  if (JSON.stringify(type[style]) === JSON.stringify(next)) return null;
  if (next) type[style] = next; else delete type[style];
  const whole = { ...theme };
  if (Object.keys(type).length) whole.type = type; else delete whole.type;
  const value = Object.keys(whole).length ? whole : undefined;
  if (value !== undefined && CORE_NS.themeProblem && CORE_NS.themeProblem(value)) return null;
  const ops = value === undefined ? [OPS.set(board.id, 'theme', undefined)]
    : !whole.type ? [OPS.set(board.id, 'theme.type', undefined)]
      : [OPS.set(board.id, `theme.type.${style}`, next)];
  const screen = `«${String(board.name || 'Доска').slice(0, 40)}»`;
  const ru = ruToken('type', style);
  const what = `стиль «${ru.charAt(0).toUpperCase() + ru.slice(1)}»`;
  const label = value === undefined ? `Экран ${screen} вернулся к оформлению документа`
    : next ? `Экран ${screen}, ${what}: ${[next.font || base.font, next.fontWeight || docW].filter(Boolean).join(' ')}`
      : `Экран ${screen}, ${what} — как в документе`;
  return { ops, label };
}

/* ------------------------- круг 78: снять часть темы ------------------------- */

/**
 * Круг 78 (SPEC §15.15): вернуть экрану цвета (`part:'colors'`) или шрифты (`part:'type'`) документа,
 * не трогая другую часть своей темы. Одна операция: `set theme.<part>` пустым, а если другой части
 * нет — `set theme` пустым. Части нет — null.
 * @returns {{ops: object[], label: string}|null}
 */
export function themePartResetOps(board, part) {
  if (!board || !board.id || (part !== 'colors' && part !== 'type')) return null;
  // неверная тема — не «часть»: инспектор кнопок частей тогда не рисует, функция тоже молчит
  const theme = typeof CORE_NS.boardTheme === 'function' ? CORE_NS.boardTheme(board) : (isObj(board.theme) ? board.theme : null);
  if (!theme || !isObj(theme[part]) || !Object.keys(theme[part]).length) return null;
  const other = part === 'colors' ? 'type' : 'colors';
  const rest = isObj(theme[other]) && Object.keys(theme[other]).length;
  const screen = `«${String(board.name || 'Доска').slice(0, 40)}»`;
  if (!rest) return { ops: [OPS.set(board.id, 'theme', undefined)], label: `Экран ${screen} вернулся к оформлению документа` };
  return {
    ops: [OPS.set(board.id, `theme.${part}`, undefined)],
    label: part === 'colors' ? `Экран ${screen}: цвета — как в документе` : `Экран ${screen}: шрифты — как в документе`,
  };
}

/**
 * Круг 81 (SPEC §15.17): метка «своя тема» у экрана в списке слоёв — по ней видно, какие экраны
 * не в оформлении документа. Только доска верхнего уровня (не библиотека) с действующей темой.
 * @returns {{swatch: string|null, colors: number, styles: number, title: string}|null}
 */
export function boardThemeBadge(doc, node) {
  if (!doc || !node || node.type !== 'frame' || node.parent !== doc.root || node.role === 'library') return null;
  if (node.theme == null) return null;   // null core тоже считает «темы нет»
  const theme = typeof CORE_NS.boardTheme === 'function' ? CORE_NS.boardTheme(node) : null;
  if (!theme) {
    return { swatch: null, colors: 0, styles: 0, broken: true, title: 'Тема экрана повреждена и не действует — экран в оформлении документа; «Вернуть общее оформление» в инспекторе её снимет (щелчок откроет)' };
  }
  const colors = isObj(theme.colors) ? Object.keys(theme.colors) : [];
  const styles = isObj(theme.type) ? Object.keys(theme.type) : [];
  if (!colors.length && !styles.length) return null;
  const swatch = colors.length ? theme.colors.canvas || theme.colors.accent || theme.colors[colors[0]] : null;
  const bits = [
    colors.length ? `${colors.length} ${plural(colors.length, 'цвет', 'цвета', 'цветов')}` : '',
    styles.length ? `шрифты ${styles.length} ${plural(styles.length, 'стиля', 'стилей', 'стилей')}` : '',
  ].filter(Boolean).join(', ');
  return { swatch: swatch || null, colors: colors.length, styles: styles.length, title: `Своя тема экрана: ${bits} — щелчок откроет её в инспекторе` };
}

/* ------------------------- круг 70: тема с другого экрана ------------------------- */

/** Тема для сравнения: ключи по порядку (тема {colors,type} и {type,colors} — одна и та же). */
function themeKey(t) {
  const sort = (v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : typeof v === 'string' ? v.toLowerCase() : v);
  return JSON.stringify(t ? sort(t) : null);
}

/** Имена досок страницы для выбора и истории: повторяющиеся — с номером по порядку («Экран (2)»). */
function boardLabels(doc) {
  const root = doc && doc.nodes && doc.nodes[doc.root];
  const ids = (root && Array.isArray(root.children) ? root.children : []).filter((id) => doc.nodes[id] && doc.nodes[id].type === 'frame' && doc.nodes[id].role !== 'library');
  const seen = new Map();
  const total = new Map();
  for (const id of ids) { const n = String(doc.nodes[id].name || 'Доска').slice(0, 60); total.set(n, (total.get(n) || 0) + 1); }
  const out = new Map();
  for (const id of ids) {
    const n = String(doc.nodes[id].name || 'Доска').slice(0, 60);
    const k = (seen.get(n) || 0) + 1;
    seen.set(n, k);
    out.set(id, total.get(n) > 1 ? `${n} (${k})` : n);
  }
  return out;
}

/**
 * Круг 70 (SPEC §15.8): экраны, чью тему можно взять для этой доски, — доски страницы с годной своей
 * темой, кроме самой доски и экранов с той же темой; имена повторяются — с номером.
 * @returns {{id: string, name: string}[]}
 */
export function themeSources(doc, board) {
  if (!doc || !board) return [];
  const mine = themeKey((CORE_NS.boardTheme && CORE_NS.boardTheme(board)) || null);
  const out = [];
  for (const [id, name] of boardLabels(doc)) {
    const n = doc.nodes[id];
    if (id === board.id) continue;
    const t = CORE_NS.boardTheme && CORE_NS.boardTheme(n);
    if (!t || themeKey(t) === mine) continue;
    out.push({ id, name });
  }
  return out;
}

/**
 * Круг 70 (SPEC §15.8): тема экрана `fromId` — этой доске, одной операцией `set theme` (копия:
 * дальше темы живут порознь). Своя тема доски заменяется — об этом в подписи. Источник без годной
 * темы, библиотека, та же доска или та же тема — null.
 * @returns {{ops: object[], label: string, replaced: boolean}|null}
 */
export function copyThemeOps(doc, board, fromId) {
  const src = doc && doc.nodes && doc.nodes[fromId];
  if (!board || !board.id || !src || src.id === board.id || src.role === 'library' || src.parent !== doc.root) return null;
  const t = CORE_NS.boardTheme && CORE_NS.boardTheme(src);
  if (!t) return null;
  const mine = CORE_NS.boardTheme && CORE_NS.boardTheme(board);
  if (mine && themeKey(mine) === themeKey(t)) return null;
  const labels = boardLabels(doc);
  const name = (n) => `«${labels.get(n.id) || String(n.name || 'Доска').slice(0, 40)}»`;
  const replaced = !!mine;
  return { ops: [OPS.set(board.id, 'theme', JSON.parse(JSON.stringify(t)))], replaced,
    label: `Экран ${name(board)} — в теме экрана ${name(src)}${replaced ? ' (своя тема заменена)' : ''}` };
}
