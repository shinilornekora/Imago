/**
 * Imago Studio — словарь оболочки для серверного агента (SPEC §10, круг 23).
 *
 * Чистые функции без DOM: где работает агент, как назвать стадию, ошибку, вариант,
 * команду оболочки, которую узнал JEV. Оболочка (app.js) берёт отсюда слова и решения,
 * а тесты проверяют их в node (test/agent.test.mjs).
 */

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
      return { kind: 'fit', all: a.all == null ? null : !!a.all };
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
      return { kind: 'export', ...(a.what || a.format ? { what: String(a.what || a.format).toLowerCase() } : {}) };
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
      return { kind: 'theme', mode: ['dark', 'light', 'cycle', 'ask'].includes(a.mode) ? a.mode : 'cycle' };
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
