/**
 * HTTP-транспорт Orchestrator (SPEC §10.2) на node:http, без фреймворков.
 *
 *   GET  /agent/health    {ok, engine, llm, document, document_reason?, model?} (document_reason — круг 31: storage|unreachable; круг 32: schema)
 *   POST /agent/command   SSE §10.3 (ошибки до старта потока — JSON с кодом); круг 41: `engine`
 *                         тела или `X-Engine` ≠ версии агента — 426 engine (так же у apply)
 *   POST /agent/stop      {command_id, client?} → {stopped}
 *   POST /agent/apply     {command_id, variant, client?} → событие result одним JSON
 *
 * Ошибки — `{error: true, code, message, retryable, detail?}`; 503 и 429 — с `Retry-After`.
 * Тело больше 1 МБ — 413; не тот метод — 405 с `Allow`; не JSON / не та форма — 400;
 * тело не пришло за 30 с — 408 timeout (круг 33).
 *
 * Круг 33: stop и apply сверяют `client` с тем, что пришёл с командой (нет поля — null,
 * и сверяется с null): чужая команда неотличима от неизвестной — `{stopped: false}` и 404.
 */

import { OrchError, badRequest, toOrchError } from './errors.js';
import { cutText, ENGINE_VERSION } from '../../src/core.js';
import {
  MAX_BODY_BYTES, MAX_TEXT, MAX_ID, MAX_SELECTION, MAX_HISTORY, MAX_HISTORY_CHARS, MAX_AUTHOR,
  MAX_VARIANTS, SSE_PING_MS, BODY_TIMEOUT_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
} from './limits.js';

const ROUTES = {
  '/agent/health': 'GET',
  '/agent/command': 'POST',
  '/agent/stop': 'POST',
  '/agent/apply': 'POST',
};

function sendJSON(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendError(res, err, redact) {
  const e = toOrchError(err);
  const body = e.body();
  body.message = redact(body.message);
  const headers = {};
  if (e.retryAfter) headers['retry-after'] = String(e.retryAfter);
  if (e.status === 405 && e.allow) headers.allow = e.allow;
  sendJSON(res, e.status === 499 ? 409 : e.status, body, headers);
}

/**
 * Тело запроса с потолком: больше — 413 без дочитывания; круг 33: не пришло целиком за
 * `timeoutMs` — 408 timeout (медленное тело). Чтение останавливается, ответ уходит, потом
 * обработчик закрывает соединение (тело не дочитано).
 */
function readBody(req, limit = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    const stop = (e) => { req.pause(); finish(reject, e); };
    const tooLarge = () => new OrchError(413, 'too_large', `Тело запроса больше ${Math.round(limit / 1024)} КБ`, { retryable: false });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { stop(tooLarge()); return; }
    if (timeoutMs > 0) {
      timer = setTimeout(() => stop(new OrchError(408, 'timeout', `Тело запроса не пришло за ${Math.round(timeoutMs / 1000)} с`,
        { retryable: true, detail: { limit: 'body_timeout', ms: timeoutMs } })), timeoutMs);
      if (timer.unref) timer.unref();
    }
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { stop(tooLarge()); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(reject, badRequest('Обрыв тела запроса')));
    req.on('aborted', () => finish(reject, badRequest('Клиент оборвал тело запроса')));
  });
}

async function readJSON(req, timeoutMs) {
  const text = await readBody(req, MAX_BODY_BYTES, timeoutMs);
  if (!text.trim()) throw badRequest('Пустое тело: нужен JSON-объект');
  let body;
  try { body = JSON.parse(text); } catch { throw badRequest('Тело — не JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Тело должно быть JSON-объектом');
  return body;
}

/**
 * Круг 33: таймауты приёма запроса на http.Server (как у Document service): заголовки и
 * запрос целиком. Без них — умолчания node (запрос — 300 с).
 * @param {import('node:http').Server} server
 * @param {{headersTimeoutMs?: number, requestTimeoutMs?: number}} [o]
 */
export function applyServerTimeouts(server, o = {}) {
  if (!server || typeof server !== 'object') return;
  const request = o.requestTimeoutMs > 0 ? o.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  // headersTimeout не может быть больше requestTimeout (node требует headers ≤ request)
  server.headersTimeout = Math.min(o.headersTimeoutMs > 0 ? o.headersTimeoutMs : HEADERS_TIMEOUT_MS, request);
  server.requestTimeout = request;
}

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && /^[A-Za-z0-9_.:\-]+$/.test(v);
const optStr = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

/** Проверка и нормализация тела команды (§10.2). */
export function parseCommand(body, { testHooks = false } = {}) {
  if (!isId(body.command_id)) throw badRequest('command_id: строка 1–128 символов [A-Za-z0-9_.:-]');
  if (!isId(body.project)) throw badRequest('project: id проекта');
  if (typeof body.text !== 'string') throw badRequest('text: строка');
  if (body.text.length > MAX_TEXT) throw badRequest(`text: не длиннее ${MAX_TEXT} символов`);
  if (body.selection !== undefined && body.selection !== null) {
    if (!Array.isArray(body.selection) || body.selection.length > MAX_SELECTION || !body.selection.every(isId)) {
      throw badRequest(`selection: массив id узлов (до ${MAX_SELECTION})`);
    }
  }
  if (body.board !== undefined && body.board !== null && !isId(body.board)) throw badRequest('board: id доски');
  if (body.base_seq !== undefined && body.base_seq !== null && (!Number.isInteger(body.base_seq) || body.base_seq < 0)) {
    throw badRequest('base_seq: целое ≥ 0');
  }
  if (!optStr(body.client, MAX_ID)) throw badRequest('client: строка до 128 символов');
  // круг 27 (I6): кто поставил текущее выделение — человек или агент (оболочка после правки
  // сама выделяет задетое); brain не считает выделение агента границей, назначенной человеком
  if (body.selection_by !== undefined && body.selection_by !== null && body.selection_by !== 'human' && body.selection_by !== 'agent') {
    throw badRequest("selection_by: 'human' | 'agent'");
  }
  if (!optStr(body.author, MAX_AUTHOR)) throw badRequest('author: строка до 200 символов');
  const mode = body.mode === undefined || body.mode === null ? 'run' : body.mode;
  if (mode !== 'run' && mode !== 'variants') throw badRequest("mode: 'run' | 'variants'");
  if (body.n !== undefined && body.n !== null && (!Number.isInteger(body.n) || body.n < 1 || body.n > MAX_VARIANTS)) {
    throw badRequest(`n: целое от 1 до ${MAX_VARIANTS}`);
  }
  let history = [];
  if (body.history !== undefined && body.history !== null) {
    if (!Array.isArray(body.history)) throw badRequest('history: массив {utterance, summary}');
    history = body.history.slice(-MAX_HISTORY).filter((h) => h && typeof h.utterance === 'string').map((h) => ({
      utterance: cutText(h.utterance, MAX_HISTORY_CHARS),
      summary: typeof h.summary === 'string' ? cutText(h.summary, MAX_HISTORY_CHARS) : '',
    }));
  }
  return {
    command_id: body.command_id,
    project: body.project,
    text: body.text,
    selection: body.selection ? [...new Set(body.selection)] : [],
    selection_by: body.selection_by === 'agent' ? 'agent' : 'human',
    board: body.board || null,
    base_seq: body.base_seq == null ? null : body.base_seq,
    client: body.client || null,
    author: body.author || null,
    mode,
    n: body.n == null ? null : body.n,
    history,
    ...(testHooks && (body.__test === 'oom' || body.__test === 'spin' || body.__test === 'env' || body.__test === 'throw') ? { test: body.__test } : {}),
  };
}

/** SSE-поток: запись после разрыва — молча в никуда (команда идёт дальше). */
function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  let open = true;
  const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, SSE_PING_MS);
  ping.unref();
  const closeIt = () => { open = false; clearInterval(ping); };
  res.on('close', closeIt);
  req.on('aborted', closeIt);
  return {
    get open() { return open; },
    send(event, data) {
      if (!open || res.writableEnded || res.destroyed) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { open = false; }
    },
    end() {
      clearInterval(ping);
      if (open && !res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
      open = false;
    },
    destroy() {
      clearInterval(ping);
      open = false;
      if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
    },
  };
}

/**
 * Круг 41: версия движка клиента — поле `engine` тела или заголовок `X-Engine`. Не та, что у
 * агента, — 426 `engine`, как у Document service: вкладка прежней версии не должна выполнять
 * команды агента над документом, который её движок не понимает (и наоборот — новая вкладка
 * у агента, который ещё не обновился). Нет ни поля, ни заголовка — как прежде (внешний вызов API).
 * Круг 43: поле и заголовок вместе, но разные — 400.
 * Остановка (`/agent/stop`) версию не сверяет: остановить можно всегда.
 */
export function checkClientEngine(req, body) {
  const fromBody = body && body.engine !== undefined && body.engine !== null ? body.engine : undefined;
  const h = req.headers['x-engine'];
  const fromHeader = typeof h === 'string' && h.trim() ? (/^\d{1,6}$/.test(h.trim()) ? Number(h.trim()) : h) : undefined;
  // круг 43: поле тела и заголовок говорят разное — это ошибка клиента, а не «побеждает тело»
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader) {
    throw badRequest('engine: поле тела и заголовок X-Engine расходятся — укажите версию движка один раз');
  }
  const raw = fromBody !== undefined ? fromBody : fromHeader;
  if (raw === undefined) return;
  if (!Number.isInteger(raw) || raw < 1) throw badRequest('engine: целое ≥ 1 — версия движка клиента');
  if (raw === ENGINE_VERSION) return;
  const clientOld = raw < ENGINE_VERSION;
  throw new OrchError(426, 'engine', clientOld
    ? 'Вышла новая версия редактора — обновите страницу. Команда агенту не выполнена.'
    : 'Сервер агента ещё не обновился до этой версии редактора — команда не выполнена. Повторите чуть позже.', {
    retryable: !clientOld,
    ...(clientOld ? {} : { retryAfter: 30 }),
    detail: { engine: ENGINE_VERSION, found: raw, cause: clientOld ? 'client_old' : 'server_old' },
  });
}

/**
 * @param {{pipeline: ReturnType<import('./pipeline.js').createPipeline>, redact: (s:string)=>string, log?: object, testHooks?: boolean}} deps
 */
export function createRequestHandler({ pipeline, redact, log = console, testHooks = false, bodyTimeoutMs = BODY_TIMEOUT_MS }) {
  const streams = new Set();

  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = ROUTES[path];
    if (!method) throw new OrchError(404, 'not_found', 'Нет такого маршрута', { retryable: false });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: `${method}, OPTIONS` });
      res.end();
      return;
    }
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
      throw Object.assign(new OrchError(405, 'method_not_allowed', `Метод ${req.method} здесь не поддерживается`, { retryable: false }), { allow: `${method}, OPTIONS` });
    }

    if (path === '/agent/health') {
      sendJSON(res, 200, await pipeline.health());
      return;
    }

    const body = await readJSON(req, bodyTimeoutMs);

    if (path === '/agent/stop') {
      if (!isId(body.command_id)) throw badRequest('command_id: строка');
      if (!optStr(body.client, MAX_ID)) throw badRequest('client: строка до 128 символов');
      // круг 33: остановить можно только свою команду — client тот же, что пришёл с ней;
      // чужая — тот же ответ, что неизвестная ({stopped: false}): существование не раскрываем
      sendJSON(res, 200, { stopped: pipeline.stop(body.command_id, { client: body.client || null }) });
      return;
    }

    if (path === '/agent/apply') {
      if (!isId(body.command_id)) throw badRequest('command_id: строка');
      checkClientEngine(req, body);
      if (!optStr(body.client, MAX_ID)) throw badRequest('client: строка до 128 символов');
      const v = body.variant;
      if (!((typeof v === 'string' && v.length > 0 && v.length <= MAX_ID) || (Number.isInteger(v) && v >= 0 && v < 100))) {
        throw badRequest('variant: ключ варианта или его номер с 0');
      }
      // круг 33: варианты чужой команды — 404, как неизвестной
      sendJSON(res, 200, await pipeline.apply(body.command_id, v, { client: body.client || null }));
      return;
    }

    // /agent/command
    const cmd = parseCommand(body, { testHooks });
    checkClientEngine(req, body);
    let sink = null;
    await pipeline.command(cmd, () => {
      sink = openSse(req, res);
      streams.add(sink);
      res.on('close', () => streams.delete(sink));
      return sink;
    });
  }

  const handler = (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { url = new URL('http://localhost/'); }
    route(req, res, url).catch((e) => {
      if (!(e instanceof OrchError)) log.warn(`[orchestrator/http] сбой: ${redact(e && e.stack ? e.stack : String(e))}`);
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      sendError(res, e, redact);
      // тело не дочитано (413): соединение дальше не годится — закрываем после ответа
      if (!req.complete) res.once('finish', () => req.destroy());
    });
  };
  /** Закрыть открытые потоки (останов). */
  handler.closeStreams = () => { for (const s of streams) s.destroy(); streams.clear(); };
  return handler;
}
