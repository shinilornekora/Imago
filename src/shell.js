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
// круг 25: cutText/cleanText появляются в core параллельно — берём оттуда, если уже есть
import * as CORE_NS from './core.js';
import { recognizeAction } from './brain.js';

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
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ')
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

/** Подробности о режиме — для подсказки у строки состояния. */
export function agentModeTitle(mode, health, providerWords = '') {
  const h = health && health.ok === true ? health : null;
  if (mode === 'server') {
    if (h && h.document !== 'up' && storageReason(h)) return 'Команды агента выполняет сервер, но база данных сервера сейчас недоступна — команды не выполняются, правки руками ждут в очереди';
    if (h && h.document !== 'up') return 'Команды агента выполняет сервер, но сейчас он не видит документ — правки руками сохраняются';
    if (h && h.llm === 'unconfigured') return 'Команды агента выполняет сервер, но модель на нём не настроена — это забота администратора';
    if (h && h.llm !== 'up') return 'Команды агента выполняет сервер, но модель на нём сейчас не отвечает — попробуйте позже';
    return 'Команды агента выполняет сервер';
  }
  if (mode === 'browser') {
    const why = h ? 'модель на сервере сейчас не отвечает' : 'сервер агента не отвечает';
    return `Команды агента выполняются в этом браузере${providerWords ? ` (${providerWords})` : ''}: ${why}`;
  }
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
export function agentHealthNotice(prev, next, { hasProvider = false } = {}) {
  if (!prev || !next) return null;
  const was = prev.ok === true ? (prev.document !== 'up' ? 'nodoc' : prev.llm !== 'up' ? 'nollm' : 'up') : 'down';
  const now = next.ok === true ? (next.document !== 'up' ? 'nodoc' : next.llm !== 'up' ? 'nollm' : 'up') : 'down';
  if (was === now) return null;
  const local = hasProvider ? ' Команды пока выполняются в браузере.' : '';
  if (now === 'up') {
    const text = { down: 'Сервер агента снова на связи.', nodoc: 'Сервер документа снова на связи — агент работает.', nollm: 'Модель на сервере снова отвечает.' }[was];
    return { text, kind: 'plain', back: true };
  }
  if (now === 'down') return { text: `Сервер агента не отвечает.${local || ' Правки руками сохраняются.'}`, kind: 'plain' };
  if (now === 'nodoc') {
    // K2: причина — база данных, а не сервис документа
    const why = storageReason(next) ? 'база данных сервера недоступна' : 'сервер документа не отвечает';
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

/**
 * Событие `queued` словами. `ahead` — имена тех, чья команда впереди (из присутствия:
 * у них `busy`/`queued`, §9.9), если оболочка их знает. `scope` (круг 27, §10.8):
 * `'project'` — очередь проекта (по одной команде на проект), `'workers'` — команда
 * принята и ждёт свободного исполнителя (воркера) агента: очередь проекта ни при чём,
 * впереди — команды любых проектов, их имён оболочка не знает.
 * @param {number} position
 * @param {string[]} [ahead]
 * @param {'project'|'workers'} [scope]
 */
export function queuedLabel(position, ahead = [], scope = 'project') {
  if (scope === 'workers') return 'Ждёт свободного исполнителя агента…';
  const n = Number(position);
  const names = (Array.isArray(ahead) ? ahead : []).map((a) => cutText(cleanText(a), 40, { ellipsis: true })).filter(Boolean);
  const whose = names.length
    ? ` (${names.slice(0, 2).join(', ')}${names.length > 2 ? ` и ещё ${names.length - 2}` : ''})`
    : '';
  if (!Number.isFinite(n) || n <= 0) return names.length ? `В очереди проекта: впереди команда${whose}` : 'В очереди проекта';
  return `В очереди проекта: впереди ${n} ${plural(n, 'команда', 'команды', 'команд')}${whose}`;
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
  too_large: ['Команда слишком большая для агента', 'Скажите короче или выделите узел поменьше.'],
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
  engine: ['Версия редактора устарела', 'Обновите страницу.'],
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

/** Какой правки касалась отброшенная операция: существительное и согласованный глагол. */
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
      return { noun: `Добавление${n ? ` «${n}»` : ' слоя'}`, failed: 'не применилось' };
    }
    case 'remove': return { noun: `Удаление${nm(o.id)}`, failed: 'не применилось' };
    case 'setToken': return { noun: 'Правка шкалы', failed: 'не применилась' };
    default: return { noun: 'Правка', failed: 'не применилась' };
  }
}

/** Причина отказа словами; who — кто помешал (для removed/orphan). */
function droppedReason(d, who, many) {
  const reason = d && (d.limit || d.reason);
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
        : 'она сделана до восстановления базы из резервной копии, а документ с тех пор другой';
    case 'doc_nodes': return 'документ упёрся в предел числа слоёв';
    case 'doc_bytes': return 'документ упёрся в предел размера';
    case 'merge_budget': return 'сервер не успел её разобрать';
    case 'ops_per_tx': return 'в ней слишком много операций';
    case 'tx_bytes': return 'она слишком большая';
    default: return 'она не подошла к документу';
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
    // круг 29, п.7: кнопка стоит справа от текста на широком экране и под ним на узком —
    // «кнопкой ниже» было неправдой на половине экранов; называем её саму
    note: short ? `«${short}» уже на холсте. Отменить — кнопкой «Отменить» или Ctrl+Z.` : 'Отменить — кнопкой «Отменить» или Ctrl+Z.',
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
  return `Файл слишком большой: ${num(count)} ${plural(count, 'узел', 'узла', 'узлов')}, предел ${num(max)}`;
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
