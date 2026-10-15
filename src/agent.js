/**
 * Imago Studio — клиент Orchestrator (SPEC §10, стрелки 3 и 7b).
 *
 * Оболочка отправляет команду агента на сервер (`POST /agent/command`) и читает поток
 * событий SSE: `queued`, `stage`, `shell`, `variants`, `result`, `error`, `done`.
 * EventSource не годится — ему нужен GET, а команда уходит телом POST; поэтому поток
 * разбирается вручную из `fetch` + `ReadableStream`.
 *
 * Правила устойчивости (§10.3):
 *  * Разрыв потока — не провал команды. Orchestrator доводит её до конца, а транзакцию
 *    клиент получает по сокету Hub, как любую чужую. Исход тогда `detached`: оболочка
 *    говорит «ответ придёт по синхронизации» и ничего не применяет сама.
 *  * Команда, которую сервер НЕ принял (сеть, апстрим лежит, 4xx/5xx до потока), —
 *    исключение `AgentError` с `accepted: false`: такую безопасно выполнить в браузере.
 *  * Ошибки — единого вида `{error: true, code, message, retryable, detail?}` (§10.2), его
 *    же nginx отдаёт за упавший апстрим (с полем `upstream` и заголовком `X-Imago-Upstream`).
 *  * `429 busy` и `503 …_down` с `Retry-After` повторяются сами, если пауза короткая;
 *    иначе пауза уходит в ошибку (`retryAfterMs`), и решает оболочка.
 *  * «Стоп» (сигнал прерывания) — `POST /agent/stop` и исключение с `code: 'cancelled'`.
 *
 * Модуль не знает о DOM и работает в node так же, как в браузере (тесты — test/agent.test.mjs).
 */

/** Типы событий потока §10.3 — остальные игнорируются (вперёд совместимо). */
export const AGENT_EVENTS = Object.freeze(['queued', 'stage', 'shell', 'variants', 'result', 'error', 'done']);

/** Ключи стадий §10.3 — по порядку конвейера. */
export const STAGE_KEYS = Object.freeze(['jev', 'read', 'library', 'llm', 'validate', 'repair', 'write']);

/** Сколько ждём `/agent/health`: дольше — считаем, что агента на сервере нет. */
const HEALTH_TIMEOUT_MS = 3000;
/** Сколько ждём ответа на «стоп» и на выбор варианта, прежде чем сдаться. */
const STOP_TIMEOUT_MS = 4000;
const APPLY_TIMEOUT_MS = 60000;
/** Тишина в потоке, после которой считаем его оборванным (сервер шлёт стадии и комментарии). */
const IDLE_MS = 180000;
/** Самая длинная пауза Retry-After, которую клиент выжидает сам. */
const RETRY_WAIT_MAX_MS = 8000;

export class AgentError extends Error {
  /**
   * @param {{code?: string, message?: string, retryable?: boolean, status?: number,
   *   retryAfterMs?: number|null, upstream?: string, detail?: any, accepted?: boolean,
   *   cause?: any}} info
   */
  constructor(info = {}) {
    super(String(info.message || info.code || 'ошибка агента'));
    this.name = info.code === 'cancelled' ? 'AbortError' : 'AgentError';
    this.code = String(info.code || 'agent_error');
    this.kind = info.code === 'cancelled' ? 'cancelled' : (info.kind || 'agent');
    this.retryable = info.retryable !== undefined ? !!info.retryable : false;
    this.status = Number.isFinite(info.status) ? info.status : 0;
    this.retryAfterMs = Number.isFinite(info.retryAfterMs) ? info.retryAfterMs : null;
    this.upstream = info.upstream ? String(info.upstream) : '';
    this.accepted = !!info.accepted;
    if (info.detail !== undefined) this.detail = info.detail;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

/** id команды: генерирует клиент, как id транзакций (12 знаков base36 после префикса). */
export function newCommandId() {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(12);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += abc[b % 36];
  return `cmd_${s}`;
}

/**
 * `Retry-After` → миллисекунды: число секунд или HTTP-дата. Негодное — null.
 * @param {string|null|undefined} value
 * @param {number} [now]
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t - now);
}

/**
 * Разбор SSE по спецификации WHATWG: строки `field: value`, событие кончается пустой
 * строкой, `data` из нескольких строк склеивается через `\n`, строки с `:` в начале —
 * комментарии (пульс). Концы строк — `\n`, `\r\n` и `\r`; куски приходят как угодно.
 *
 * @param {(ev: {event: string, data: string, id?: string}) => void} onEvent
 */
export function createSSEParser(onEvent) {
  let buf = '';
  let event = '';
  let data = [];
  let id;
  let pendingCR = false;

  const dispatch = () => {
    if (!data.length && !event) return;
    const ev = { event: event || 'message', data: data.join('\n') };
    if (id !== undefined) ev.id = id;
    event = '';
    data = [];
    onEvent(ev);
  };

  const line = (l) => {
    if (l === '') { dispatch(); return; }
    if (l[0] === ':') return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    // retry и прочее клиенту не нужно: переподключения у POST-потока нет
  };

  return {
    push(chunk) {
      let s = String(chunk || '');
      if (!s) return;
      // «\r» в конце прошлого куска и «\n» в начале этого — один перевод строки
      if (pendingCR && s[0] === '\n') s = s.slice(1);
      pendingCR = false;
      buf += s;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch !== '\n' && ch !== '\r') continue;
        line(buf.slice(start, i));
        if (ch === '\r') {
          if (i + 1 < buf.length) { if (buf[i + 1] === '\n') i += 1; }
          else pendingCR = true;
        }
        start = i + 1;
      }
      buf = buf.slice(start);
    },
    /** Конец потока: недописанное событие без пустой строки по спецификации отбрасывается. */
    end() { buf = ''; event = ''; data = []; },
  };
}

/** Тело ошибки → AgentError. Понимает единый формат §10.2, ответ nginx и голый текст. */
export async function readError(res, { accepted = false } = {}) {
  let body = null;
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const header = (name) => {
    try { return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null; } catch { return null; }
  };
  const upstreamHdr = String(header('x-imago-upstream') || '').toLowerCase();
  const b = body && typeof body === 'object' ? body : {};
  const status = Number(res.status) || 0;
  const code = typeof b.code === 'string' && b.code
    ? b.code
    : (typeof b.error === 'string' && b.error ? b.error : defaultCode(status));
  const upstream = typeof b.upstream === 'string' && b.upstream
    ? b.upstream
    : (upstreamHdr === 'down' ? 'orchestrator' : '');
  return new AgentError({
    code,
    message: typeof b.message === 'string' && b.message ? b.message : (text && !body ? text.slice(0, 200) : `сервер агента ответил ${status}`),
    retryable: typeof b.retryable === 'boolean' ? b.retryable : status === 429 || status >= 500,
    status,
    // заголовок главнее; без него — поле тела `retry_after` (с), круг 26
    retryAfterMs: parseRetryAfter(header('retry-after')) ?? secondsMs(b.retry_after),
    upstream,
    detail: b.detail,
    accepted,
  });
}

/** `retry_after` тела или события (секунды) → мс; не число или ≤ 0 — null. */
function secondsMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
}

function defaultCode(status) {
  return ({ 400: 'bad_request', 404: 'not_found', 405: 'method_not_allowed', 413: 'too_large', 429: 'busy', 502: 'bad_gateway', 503: 'unavailable', 504: 'timeout' })[status]
    || (status >= 500 ? 'server_error' : 'bad_request');
}

/**
 * Апстрим лежит: ответ nginx, а не Orchestrator, или нет связи вовсе. Такая команда сервером
 * не принята — её можно выполнить в браузере. Таймаут (504) сюда не входит: команда могла
 * дойти, и второй прогон в браузере сделал бы правку дважды.
 */
export function isUpstreamDown(err) {
  if (!err || err.code === 'upstream_timeout') return false;
  return err.upstream === 'orchestrator' || err.code === 'upstream_down' || err.code === 'network';
}

function cancelledError(accepted) {
  return new AgentError({ code: 'cancelled', message: 'Команда остановлена', retryable: false, accepted });
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}${path}`;
}

function headersFor(author, extra = {}) {
  const h = { 'content-type': 'application/json', ...extra };
  // заголовки — latin1: имя по-русски уходит процентно закодированным, как в /api (§9.7)
  if (author) h['x-author'] = encodeURIComponent(String(author));
  return h;
}

/** Сон с прерыванием. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelledError(false)); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(cancelledError(false)); };
    if (signal) signal.addEventListener('abort', on, { once: true });
  });
}

/** Контроллер с таймаутом, привязанный к внешнему сигналу. */
function linked(signal, ms) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms ? setTimeout(() => ctrl.abort(), ms) : null;
  return {
    signal: ctrl.signal,
    done() { if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); },
  };
}

function fetchOf(opts) {
  const f = (opts && opts.fetch) || globalThis.fetch;
  if (typeof f !== 'function') throw new AgentError({ code: 'network', message: 'fetch недоступен', retryable: false });
  return f;
}

/**
 * `GET /agent/health`. Никогда не бросает: `{ok: true, engine, llm, document, model?}`
 * или `{ok: false, reason, status?}` — оболочка решает по нему, где работает агент.
 */
export async function health(opts = {}) {
  let f;
  try { f = fetchOf(opts); } catch { return { ok: false, reason: 'no-fetch' }; }
  const t = linked(opts.signal, opts.timeoutMs || HEALTH_TIMEOUT_MS);
  try {
    const res = await f(joinUrl(opts.baseUrl, '/agent/health'), { cache: 'no-store', signal: t.signal });
    if (!res.ok) {
      const e = await readError(res);
      return { ok: false, reason: e.upstream ? 'upstream-down' : 'status', status: res.status, code: e.code };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    // хост, который на любой путь отдаёт свою страницу, сюда не пройдёт: нужен именно JSON с ok
    if (!body || body.ok !== true) return { ok: false, reason: 'not-agent', status: res.status };
    return {
      ok: true,
      engine: body.engine,
      llm: ['up', 'down', 'unconfigured'].includes(body.llm) ? body.llm : 'down',
      document: body.document === 'up' ? 'up' : 'down',
      ...(body.model ? { model: String(body.model) } : {}),
      // круг 26: id процесса Orchestrator и время старта — смена instance значит «перезапустился»
      ...(typeof body.instance === 'string' && body.instance ? { instance: body.instance.slice(0, 64) } : {}),
      ...(typeof body.started_at === 'string' ? { started_at: body.started_at.slice(0, 40) } : {}),
    };
  } catch (e) {
    return { ok: false, reason: t.signal.aborted ? 'timeout' : 'network', message: String((e && e.message) || e) };
  } finally { t.done(); }
}

/** `POST /agent/stop`. Не бросает: `{stopped: bool}`; сбой связи — `{stopped: false, error}`. */
export async function stop(commandId, opts = {}) {
  let f;
  try { f = fetchOf(opts); } catch (e) { return { stopped: false, error: e }; }
  const t = linked(null, opts.timeoutMs || STOP_TIMEOUT_MS);
  try {
    const res = await f(joinUrl(opts.baseUrl, '/agent/stop'), {
      method: 'POST', headers: headersFor(opts.author), body: JSON.stringify({ command_id: commandId }),
      cache: 'no-store', signal: t.signal,
    });
    if (!res.ok) return { stopped: false, error: await readError(res) };
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { stopped: !!(body && body.stopped) };
  } catch (e) {
    return { stopped: false, error: new AgentError({ code: 'network', message: String((e && e.message) || e), retryable: true }) };
  } finally { t.done(); }
}

/** Ответ `/agent/apply` бывает голым `result`, обёрнутым `{event, data}` или `{result}`. */
function unwrapResult(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.event === 'result' && body.data && typeof body.data === 'object') return body.data;
  if (body.type === 'result' && body.data && typeof body.data === 'object') return body.data;
  if (body.result && typeof body.result === 'object' && !Array.isArray(body.result)) return body.result;
  return body;
}

/**
 * `POST /agent/apply` — выбранный вариант становится транзакцией. Возвращает `result`
 * (§10.3); транзакция придёт по сокету Hub — применять её второй раз нельзя.
 * Бросает AgentError: вариант не записан.
 */
export async function apply(commandId, variant, opts = {}) {
  const f = fetchOf(opts);
  const t = linked(opts.signal, opts.timeoutMs || APPLY_TIMEOUT_MS);
  let res;
  try {
    res = await f(joinUrl(opts.baseUrl, '/agent/apply'), {
      method: 'POST', headers: headersFor(opts.author),
      body: JSON.stringify({ command_id: commandId, variant }),
      cache: 'no-store', signal: t.signal,
    });
  } catch (e) {
    t.done();
    if (opts.signal && opts.signal.aborted) throw cancelledError(false);
    throw new AgentError({ code: 'network', message: 'Сервер агента не ответил', retryable: true, cause: e });
  }
  try {
    if (!res.ok) throw await readError(res);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (body && body.error === true) {
      throw new AgentError({ code: body.code, message: body.message, retryable: body.retryable, status: res.status, detail: body.detail, accepted: true });
    }
    const out = unwrapResult(body);
    if (!out) throw new AgentError({ code: 'bad_response', message: 'Сервер агента прислал непонятный ответ', retryable: true, status: res.status });
    return out;
  } finally { t.done(); }
}

function parseData(raw) {
  if (raw === '' || raw == null) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { value: v };
  } catch { return { raw: String(raw) }; }
}

/**
 * Команда агенту на сервере.
 *
 * @param {{
 *   project: string, text: string, selection?: string[], board?: string|null,
 *   base_seq?: number, client?: string, author?: string,
 *   mode?: 'run'|'variants', n?: number, command_id?: string,
 *   history?: {utterance: string, summary?: string}[],
 *   signal?: AbortSignal, onEvent?: (ev: {type: string, data: object}) => void,
 *   baseUrl?: string, fetch?: typeof fetch, retries?: number, maxRetryWaitMs?: number,
 *   idleMs?: number
 * }} p
 * @returns {Promise<{command_id: string, status: 'done'|'detached'|'error',
 *   result: object|null, variants: object[]|null, shell: object|null,
 *   error: AgentError|null, stages: object[], queued: number|null, sawDone: boolean}>}
 *
 * Бросает AgentError только когда команда сервером НЕ принята (`accepted: false`) или
 * остановлена (`code: 'cancelled'`); всё, что случилось после принятия, — в исходе.
 */
export async function runServerCommand(p = {}) {
  const f = fetchOf(p);
  const commandId = p.command_id || newCommandId();
  const signal = p.signal || null;
  const onEvent = typeof p.onEvent === 'function' ? p.onEvent : () => {};
  const emit = (type, data) => { try { onEvent({ type, data, command_id: commandId }); } catch { /* оболочка не роняет поток */ } };
  const retries = Number.isFinite(p.retries) ? Math.max(0, p.retries) : 1;
  const maxWait = Number.isFinite(p.maxRetryWaitMs) ? p.maxRetryWaitMs : RETRY_WAIT_MAX_MS;
  const idleMs = Number.isFinite(p.idleMs) ? p.idleMs : IDLE_MS;

  const body = { command_id: commandId, project: p.project, text: p.text };
  if (Array.isArray(p.selection)) body.selection = p.selection.slice();
  if (p.board) body.board = p.board;
  if (Number.isFinite(p.base_seq)) body.base_seq = p.base_seq;
  if (p.client) body.client = p.client;
  if (p.author) body.author = p.author;
  if (p.mode) body.mode = p.mode;
  if (Number.isFinite(p.n)) body.n = p.n;
  // память разговора (§10.5): до пяти пар, строки не длиннее 500 символов — сервер
  // отверг бы больше (400), а планировщику хватает и этого
  if (Array.isArray(p.history) && p.history.length) {
    const cut = (v) => { const t = String(v == null ? '' : v); return t.length > 500 ? t.slice(0, 500) : t; };
    const list = p.history
      .filter((h) => h && typeof h.utterance === 'string' && h.utterance.trim())
      .slice(-5)
      .map((h) => ({ utterance: cut(h.utterance), summary: cut(h.summary) }));
    if (list.length) body.history = list;
  }

  const stopQuietly = () => stop(commandId, { baseUrl: p.baseUrl, fetch: p.fetch, author: p.author });

  if (signal && signal.aborted) throw cancelledError(false);

  // 1) отправка — с повтором по Retry-After, пока сервер команду не принял
  let res = null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const release = () => { if (signal) signal.removeEventListener('abort', onAbort); };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        res = await f(joinUrl(p.baseUrl, '/agent/command'), {
          method: 'POST',
          headers: headersFor(p.author, { accept: 'text/event-stream' }),
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: ctrl.signal,
        });
      } catch (e) {
        if (signal && signal.aborted) {
          // запрос мог дойти: «стоп» шлём всё равно, он идемпотентен
          stopQuietly();
          throw cancelledError(false);
        }
        throw new AgentError({ code: 'network', message: 'Сервер агента недоступен', retryable: true, upstream: 'orchestrator', cause: e });
      }
      if (res.ok) break;
      const err = await readError(res);
      const own = !err.upstream;   // ошибка самого Orchestrator, а не nginx за ним
      const wait = err.retryAfterMs;
      const canRetry = own && attempt < retries && (res.status === 429 || res.status === 503)
        && wait != null && wait <= maxWait;
      if (!canRetry) throw err;
      emit('retry', { attempt: attempt + 1, wait_ms: wait, code: err.code, message: err.message });
      await sleep(wait, signal);
    }
  } catch (e) {
    release();
    throw e;
  }

  // 2) поток событий: с этого места команда принята сервером
  const out = {
    command_id: commandId, status: 'detached', result: null, variants: null, shell: null,
    error: null, stages: [], queued: null, sawDone: false,
  };
  let terminal = false;   // пришёл итог: result, variants, shell или error
  const handle = ({ event, data: raw }) => {
    if (!AGENT_EVENTS.includes(event)) return;
    const data = parseData(raw);
    switch (event) {
      case 'queued': out.queued = Number.isFinite(data.position) ? data.position : 0; break;
      case 'stage': out.stages.push(data); break;
      case 'shell': out.shell = data; terminal = true; break;
      case 'variants': out.variants = Array.isArray(data.items) ? data.items : []; terminal = true; break;
      case 'result': out.result = data; terminal = true; break;
      case 'error':
        out.error = new AgentError({
          code: data.code, message: data.message, retryable: data.retryable, detail: data.detail, accepted: true,
          // круг 26: срок повтора и в событии потока — кнопка «Повторить» считает его так же, как у 503
          retryAfterMs: secondsMs(data.retry_after),
        });
        terminal = true;
        break;
      case 'done': out.sawDone = true; break;
      default: break;
    }
    emit(event, data);
  };

  const parser = createSSEParser(handle);
  const finish = () => {
    if (out.error) out.status = 'error';
    else if (terminal) out.status = 'done';
    else if (out.sawDone) out.status = 'done';   // поток кончился штатно, но без итога
    else out.status = 'detached';
    return out;
  };

  const stream = res.body;
  if (!stream || typeof stream.getReader !== 'function') {
    // окружение без потоков: читаем целиком — стадии придут разом, итог тот же
    try {
      const text = await res.text();
      parser.push(text);
      parser.push('\n\n');
    } catch {
      if (signal && signal.aborted) { release(); await stopQuietly(); throw cancelledError(true); }
    }
    release();
    return finish();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let idleTimer = null;
  // долгая тишина — тот же разрыв: команда на сервере идёт дальше, итог придёт по сокету
  const arm = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { try { reader.cancel(); } catch { /* уже закрыт */ } }, idleMs);
  };
  arm();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      if (value) parser.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
      if (out.sawDone) break;
    }
    parser.push(decoder.decode());
  } catch {
    // разрыв: команда на сервере идёт дальше, результат — по сокету
  } finally {
    clearTimeout(idleTimer);
    release();
    if (out.sawDone) { try { await reader.cancel(); } catch { /* закрыт */ } }
  }
  parser.end();
  if (signal && signal.aborted && !out.sawDone && !terminal) {
    await stopQuietly();
    throw cancelledError(true);
  }
  return finish();
}

/**
 * Клиент с общими параметрами — чтобы оболочка не передавала адрес и автора каждый раз.
 * @param {{baseUrl?: string, fetch?: typeof fetch, author?: string | (() => string)}} [defaults]
 */
export function createAgentClient(defaults = {}) {
  const base = () => ({
    baseUrl: defaults.baseUrl || '',
    fetch: defaults.fetch,
    author: typeof defaults.author === 'function' ? defaults.author() : defaults.author,
  });
  return {
    health: (o = {}) => health({ ...base(), ...o }),
    run: (o = {}) => runServerCommand({ ...base(), ...o }),
    stop: (id, o = {}) => stop(id, { ...base(), ...o }),
    apply: (id, variant, o = {}) => apply(id, variant, { ...base(), ...o }),
  };
}
