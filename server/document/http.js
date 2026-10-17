/**
 * HTTP-маршруты Document service (SPEC §9.2, §9.8). Только `node:http`: JSON,
 * коды ответов как в таблице §9.2; тело любой ошибки —
 * `{error: true, code, message, retryable, detail?}` (+ `Retry-After`, когда
 * повтор имеет смысл позже). CORS не нужен — nginx держит `/api` и `/ws` на том
 * же origin, что и статику; на OPTIONS отвечаем 204, чтобы preflight из
 * dev-сборки на другом порту не падал на 404.
 *
 * `STATIC_DIR` — раздача клиента (index.html, app.js, styles.css, src/*.js)
 * для прогонов без nginx. Только GET/HEAD, только внутри каталога.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import * as core from '../../src/core.js';
import { createDoc, ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, notFound, tooLarge, internalBody, viaStorage } from './errors.js';
import { jsonBytes, projectSummary } from './storage/committed.js';
import { createSemaphore } from './dslr.js';
import {
  MAX_BODY_BYTES, MAX_LIMIT, MAX_DOC_NODES, MAX_DOC_BYTES, MAX_TRACE_BYTES, TRACES_DEFAULT, TRACES_MAX,
  HTTP_WRITE_CONCURRENCY, HTTP_WRITE_QUEUE, BUSY_RETRY_S, MAX_VALUE_DEPTH, PROJECTS_PAGE, PROJECTS_PAGE_MAX,
  WRITE_BODY_BYTES, BODY_TIMEOUT_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
  HISTORY_PAGE, HISTORY_PAGE_MAX, HEALTH_PING_MS, HEALTH_CACHE_MS,
  isCleanText, cleanText, cutText, cleanDeep, showValue
} from './limits.js';

/** Предел тела запроса (совместимость: прежде экспортировался отсюда). */
export const MAX_BODY = MAX_BODY_BYTES;
const PROJECT_KINDS = new Set(['design', 'library']);
const MAX_PROJECT_NAME = 200;
/** Значение-заглушка из примеров конфигурации: внутренним токеном не считается никогда. */
const PLACEHOLDER_TOKEN = 'change-me';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm'
};

function sendJSON(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

function sendError(res, e) {
  const headers = e.retryAfter !== undefined ? { 'Retry-After': String(e.retryAfter) } : {};
  sendJSON(res, e.status, e.body(), headers);
}

/**
 * Таймауты приёма запроса на http.Server (круг 27): заголовки — HEADERS_TIMEOUT_MS,
 * запрос целиком (с телом) — REQUEST_TIMEOUT_MS; node сам отвечает 408 и закрывает
 * соединение. Свой таймер тела (BODY_TIMEOUT_MS) в readBody — точнее: проверка node
 * идёт раз в connectionsCheckingInterval.
 * @param {import('node:http').Server} server
 */
export function applyServerTimeouts(server) {
  if (!server || typeof server !== 'object') return;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
}

/**
 * Тело запроса байтами: пусто → null; больше предела → 413; не пришло целиком за
 * `timeoutMs` → 408 (медленное тело, slowloris). Слишком большое или медленное тело
 * не дочитываем и не рвём соединение сразу: чтение останавливается, ответ уходит, и
 * только потом обработчик закрывает соединение (см. createRequestHandler) — иначе
 * клиент вместо 413 видел бы обрыв и не понял бы, что транзакцию надо разбить, а не
 * повторить.
 * @returns {Promise<Buffer|null>}
 */
function readBody(req, max = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS) {
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
    const stop = (e) => {
      req.pause();
      finish(reject, e);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      stop(tooLarge(`тело больше ${max} байт`, { detail: { limit: 'body_bytes', max } }));
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => stop(new DocError(408, 'timeout', `тело запроса не пришло за ${Math.round(timeoutMs / 1000)} с`, { retryable: true, detail: { limit: 'body_timeout', ms: timeoutMs } })), timeoutMs);
      if (timer.unref) timer.unref();
    }
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        stop(tooLarge(`тело больше ${max} байт`, { detail: { limit: 'body_bytes', max } }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      req.bodyBytes = size;
      finish(resolve, size ? Buffer.concat(chunks) : null);
    });
    req.on('error', (e) => finish(reject, badRequest('обрыв тела запроса: ' + e.message)));
    req.on('aborted', () => finish(reject, badRequest('клиент оборвал тело запроса')));
  });
}

/** Байты тела → JSON: null → null; не JSON → 400. */
function parseBody(buf) {
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw badRequest('тело не JSON');
  }
}

/** Тело запроса как JSON (чтения и внутренние маршруты). */
async function readJSON(req, max = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS) {
  return parseBody(await readBody(req, max, timeoutMs));
}

/** Автор из заголовка X-Author (SPEC §9: авторизации нет, имя — самоназванное). */
function authorOf(req) {
  const h = req.headers['x-author'];
  if (!h) return undefined;
  try {
    // заголовок — latin1; имя по-русски клиент шлёт как UTF-8 в percent-encoding
    return cutText(cleanText(decodeURIComponent(String(h))), 200);
  } catch (_) {
    return cutText(cleanText(String(h)), 200);
  }
}

/** Целое из query или undefined; не целое → 400. */
function intParam(url, name, { min = -Infinity, max = Infinity } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name}: целое${Number.isFinite(min) ? ` от ${min}` : ''}${Number.isFinite(max) ? ` до ${max}` : ''}`);
  return n;
}

/** Курсор списка проектов: непрозрачная строка (base64url JSON `[at, id]`). */
const encodeCursor = (c) => Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
/** `after=` → {at, id} | undefined; негодный — 400 (а не тихо первая страница). */
function cursorParam(raw) {
  if (raw === null || raw === '') return undefined;
  let v = null;
  try {
    if (raw.length <= 256) v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) { v = null; }
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string'
    || !Number.isFinite(Date.parse(v[0])) || !v[1] || v[1].length > 64 || !isCleanText(v[1])) {
    throw badRequest('after: курсор из поля next предыдущей страницы');
  }
  return { at: v[0], id: v[1] };
}

const flag = (url, name) => {
  const v = url.searchParams.get(name);
  return v !== null && v !== '0' && v !== 'false';
};

/** Сравнение токенов за постоянное время. */
function sameToken(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

async function serveStatic(req, res, root, pathname) {
  const missing = () => sendError(res, new DocError(404, 'not_found', 'нет такого файла', { retryable: false }));
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (_) {
    sendError(res, badRequest('негодный путь'));
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(root, '.' + rel);
  // путь вне каталога (../) не раздаём — как и всё, что не файл
  if (file !== root && !file.startsWith(root + path.sep)) return missing();
  let info;
  try {
    info = await stat(file);
  } catch (_) {
    return missing();
  }
  if (!info.isFile()) return missing();
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    // клиент без сборки: файлы правятся на месте, кеш только мешает
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/** Значение для jsonb: строки и ключи чистые (§9.10); глубже предела — 400. */
function cleanBody(v, what) {
  try {
    return cleanDeep(v);
  } catch (e) {
    if (e && e.code === 'depth') throw badRequest(`${what}: вложенность глубже ${MAX_VALUE_DEPTH}`);
    throw e;
  }
}

/** Имя проекта: чистая строка не длиннее MAX_PROJECT_NAME кодовых точек (звать только со строкой). */
const projectName = (v) => cutText(cleanText(String(v)), MAX_PROJECT_NAME);

/** Предел глубины дерева: из движка, если он его даёт, иначе — тот же, что в core (256). */
const MAX_TREE_DEPTH = Number.isInteger(core.MAX_DEPTH) && core.MAX_DEPTH > 0 ? core.MAX_DEPTH : 256;

/**
 * Глубина дерева документа от корня по `children` (у корня 0) — без рекурсии; узел,
 * встреченный второй раз, не обходится снова (цикл). Больше `limit` — сразу выход.
 * @returns {number} наибольшая глубина (или limit + 1, если предел превышен)
 */
function treeDepth(doc, limit) {
  const nodes = doc && doc.nodes ? doc.nodes : {};
  const own = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null);
  const seen = new Set();
  const stack = [doc.root, 0];
  let max = 0;
  while (stack.length) {
    const d = stack.pop();
    const id = stack.pop();
    if (seen.has(id)) continue;
    const n = own(id);
    if (!n) continue;
    seen.add(id);
    if (d > max) max = d;
    if (max > limit) return max;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c, d + 1);
  }
  return max;
}

/**
 * Ответ `core.checkImportDoc(d, {maxNodes})` (J7, круг 29) → `{message, limit?, max?}` или null.
 * Предел узлов — тот же, что у сервиса (`MAX_DOC_NODES`). Форму ответа движок выбирает
 * сам: null/undefined/true/`{ok:true}` — годен; строка, `{error}`, `{ok:false}`, `{code,
 * message}` или исключение — нет. `limit`/`max` движка (`'depth'|'nodes'`) переходят в
 * `detail` ответа 400 (круг 30); без них — `limit: 'import'`.
 */
function importDocError(d, maxNodes) {
  if (typeof core.checkImportDoc !== 'function') return null;
  let r;
  try {
    r = core.checkImportDoc(d, { maxNodes });
  } catch (e) {
    return { message: e && typeof e.message === 'string' ? e.message : 'документ не прошёл проверку' };
  }
  if (r === null || r === undefined || r === true) return null;
  if (typeof r === 'string') return r ? { message: r } : null;
  if (r === false) return { message: 'документ не прошёл проверку' };
  if (typeof r === 'object') {
    if (r.ok === true) return null;
    const err = r.error !== undefined ? r.error
      : r.ok === false ? (r.message || r.reason || true)
        : typeof r.code === 'string' ? (r.message || true) : null;
    if (err === null || err === undefined || err === false) return null;
    const out = { message: typeof err === 'string' ? err
      : err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'документ не прошёл проверку' };
    if (typeof r.limit === 'string' && /^[a-z_]{1,32}$/.test(r.limit)) out.limit = r.limit;
    if (Number.isFinite(r.max)) out.max = r.max;
    return out;
  }
  return null;
}

/** Число выпавших операций по выжимке `dropped` (`{more: N}` — ещё N). */
function droppedCount(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const d of list) n += d && typeof d.more === 'number' && d.index === undefined ? d.more : 1;
  return n;
}

/**
 * Строка «Истории» (J2, круг 29): мета транзакции без операций. `empty: true` — в
 * журнале запись без единой операции (повтор правки агента или переигранная правка, у
 * которой все операции выпали при слиянии: она получает seq ради идемпотентности).
 */
function historyItem(m) {
  const out = {
    seq: Number(m.seq), tx_id: m.tx_id,
    author: m.author ?? null, author_kind: m.author_kind || 'human', title: m.title ?? null,
    created_at: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
    client: m.client ?? null, command_id: m.command_id ?? null,
    // круг 30: кто дал команду агенту (подпись «Агент · Аня»); у человеческой и старой записи — null
    command_author: typeof m.command_author === 'string' && m.command_author ? m.command_author : null,
    ops_count: Number(m.ops_count) || 0, dropped_count: Number(m.dropped_count) || 0
  };
  if (out.ops_count === 0) out.empty = true;
  return out;
}

/**
 * @param {{dslr: object, dslts: object, storage: object, staticDir?: string, internalToken?: string, log?: object,
 *   writes?: {max?: number, queue?: number, retryAfter?: number, bodyBytes?: number, bodyTimeoutMs?: number}}} deps
 *   `writes` — запись по HTTP (`POST …/tx`, `POST /api/projects`, `PATCH`): семафор (одновременно и в
 *   очереди; сверх — 503 busy), бюджет байт читаемых тел на экземпляр, таймаут тела
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ dslr, dslts, storage, staticDir, internalToken, log = console, writes = {} }) {
  const retryAfter = writes.retryAfter || BUSY_RETRY_S;
  // запись по HTTP — под семафором (§9.10)
  const writeGate = createSemaphore({
    max: writes.max || HTTP_WRITE_CONCURRENCY,
    queue: writes.queue !== undefined ? writes.queue : HTTP_WRITE_QUEUE,
    retryAfter,
    message: 'сервер занят записью — повторите чуть позже'
  });
  const bodyBudget = writes.bodyBytes > 0 ? writes.bodyBytes : WRITE_BODY_BYTES;
  const bodyTimeoutMs = writes.bodyTimeoutMs !== undefined ? writes.bodyTimeoutMs : BODY_TIMEOUT_MS;
  let bodyBytesUsed = 0;

  /**
   * Запись (круг 27): тело читается в бюджете байт экземпляра (заявленный
   * Content-Length, без него — предел тела; бюджет занят — 503 busy, тело не читаем),
   * слот семафора записи берётся только ПОСЛЕ того, как тело дочитано: медленное тело
   * держит байты бюджета (и не дольше таймаута тела), но не слот. Разбор JSON и вся
   * работа — уже под слотом.
   * @param {(body: any) => Promise<void>} fn
   */
  async function writeRoute(req, fn, max = MAX_BODY_BYTES) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) throw tooLarge(`тело больше ${max} байт`, { detail: { limit: 'body_bytes', max } });
    const need = Number.isFinite(declared) && declared >= 0 ? declared : max;
    if (bodyBytesUsed > 0 && bodyBytesUsed + need > bodyBudget) {
      throw new DocError(503, 'busy', 'сервер принимает слишком много записей сразу — повторите чуть позже', {
        retryable: true, retryAfter, detail: { limit: 'body_bytes_total' }
      });
    }
    bodyBytesUsed += need;
    try {
      const buf = await readBody(req, max, bodyTimeoutMs);
      await writeGate.run(() => fn(parseBody(buf)));
    } finally {
      bodyBytesUsed -= need;
    }
  }
  const root = staticDir ? path.resolve(staticDir) : null;
  const token = typeof internalToken === 'string' && internalToken && internalToken !== PLACEHOLDER_TOKEN ? internalToken : null;
  if (internalToken === PLACEHOLDER_TOKEN) log.warn('[document/http] INTERNAL_TOKEN = «change-me» — это заглушка; внутренние маршруты закрыты, пока не задан настоящий токен');
  const methodNotAllowed = () => new DocError(405, 'method_not_allowed', 'метод не поддерживается', { retryable: false });

  /**
   * Хранилище отвечает? (J1) `storage.ping({timeoutMs})` (STORE; кеш 1 с — у него); нет
   * такого метода (хранилище прежней версии) — дешёвое чтение строки проекта с тем же
   * дедлайном и своим кешем на HEALTH_CACHE_MS. Пинги в полёте сливаются в один.
   */
  let pingCache = { at: 0, up: true };
  let pingInFlight = null;
  function storageUp() {
    if (typeof storage.ping === 'function') {
      return Promise.resolve().then(() => storage.ping({ timeoutMs: HEALTH_PING_MS })).then((v) => v !== false, () => false);
    }
    if (Date.now() - pingCache.at < HEALTH_CACHE_MS) return Promise.resolve(pingCache.up);
    if (pingInFlight) return pingInFlight;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_PING_MS);
      if (timer.unref) timer.unref();
    });
    pingInFlight = Promise.race([
      // id — годный uuid: pg на не-uuid отвечает «нет проекта», не спрашивая базу
      Promise.resolve().then(() => storage.getProject('00000000-0000-0000-0000-000000000000')).then(() => true, () => false),
      deadline
    ]).then((up) => {
      clearTimeout(timer);
      pingCache = { at: Date.now(), up };
      pingInFlight = null;
      return up;
    });
    return pingInFlight;
  }

  /** 410: снимок и голова — с верхнего уровня тела, как раньше. */
  function sendGone(res, view, epoch) {
    const e = new DocError(410, 'gone', 'с этого места журнал не догнать — нужен снимок', {
      retryable: false,
      compat: { snapshot: view.snapshot, head_seq: view.head_seq, epoch, tip: view.snapshot.chain || '' }
    });
    sendError(res, e);
  }

  async function route(req, res, url) {
    const { method } = req;
    const parts = url.pathname.split('/').filter(Boolean);

    if (method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, HEAD, POST, PATCH, OPTIONS' });
      res.end();
      return;
    }

    if (parts[0] !== 'api') {
      if (root && (method === 'GET' || method === 'HEAD')) {
        await serveStatic(req, res, root, url.pathname);
        return;
      }
      throw notFound('нет такого маршрута');
    }

    // GET /api/health — и хранилище (J1, круг 29): не отвечает — 503 unavailable
    if (parts.length === 2 && parts[1] === 'health') {
      if (method !== 'GET') throw methodNotAllowed();
      if (!(await storageUp())) {
        throw new DocError(503, 'unavailable', 'хранилище недоступно', { retryable: true, retryAfter: 1, detail: { storage: 'down' } });
      }
      sendJSON(res, 200, { ok: true, engine: ENGINE_VERSION, storage: 'up' });
      return;
    }

    // POST /api/internal/traces — только для Orchestrator (nginx снаружи отдаёт 403)
    if (parts[1] === 'internal') {
      if (!token || !sameToken(req.headers['x-internal-token'] || '', token)) {
        throw new DocError(403, 'forbidden', 'внутренний маршрут: нужен X-Internal-Token', { retryable: false });
      }
      if (parts.length === 3 && parts[2] === 'traces') {
        if (method !== 'POST') throw methodNotAllowed();
        const body = await readJSON(req, MAX_TRACE_BYTES, bodyTimeoutMs);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('трасса: JSON-объект');
        const projectId = body.project_id || body.project;
        const commandId = body.command_id;
        if (typeof projectId !== 'string' || !projectId) throw badRequest('project: id проекта');
        if (typeof commandId !== 'string' || !commandId || commandId.length > 128 || !isCleanText(commandId)) throw badRequest('command_id: строка до 128 символов');
        if (!isCleanText(projectId)) throw notFound();
        const saved = await viaStorage(storage.addTrace({ projectId, commandId, body: cleanBody(body, 'трасса') }));
        if (!saved) throw notFound();
        sendJSON(res, 201, { id: saved.id, created_at: saved.created_at });
        return;
      }
      throw notFound('нет такого маршрута');
    }

    if (parts[1] !== 'projects') throw notFound('нет такого маршрута');

    // GET|POST /api/projects
    if (parts.length === 2) {
      if (method === 'GET') {
        // круг 26: фильтр по виду (агент берёт только библиотеки) и страницы по ключу
        const kind = url.searchParams.get('kind') || undefined;
        if (kind !== undefined && !PROJECT_KINDS.has(kind)) throw badRequest('kind: design | library');
        const limit = intParam(url, 'limit', { min: 1, max: PROJECTS_PAGE_MAX }) || PROJECTS_PAGE;
        const after = cursorParam(url.searchParams.get('after'));
        const page = await viaStorage(storage.listProjectsPage({ kind, limit, after }));
        const body = { projects: page.projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, head_seq: p.head_seq, updated_at: p.updated_at })), more: page.more };
        if (page.more && page.next) body.next = encodeCursor(page.next);
        sendJSON(res, 200, body);
        return;
      }
      if (method === 'POST') {
        await writeRoute(req, (raw) => createProject(res, raw || {}));
        return;
      }
      throw methodNotAllowed();
    }

    const id = parts[2];

    // GET|PATCH /api/projects/:id   (?head=1 — только голова; ?lean=1[&since=] — без документа снимка)
    if (parts.length === 3) {
      if (method === 'GET') {
        if (flag(url, 'head')) {
          sendJSON(res, 200, await dslr.head(id));
          return;
        }
        const lean = flag(url, 'lean');
        const since = lean ? intParam(url, 'since', { min: 0 }) : undefined;
        if (lean && since !== undefined) {
          const p = await dslr.project(id);
          if (since > p.head_seq) {
            sendGone(res, await dslr.gone(id, p), p.epoch);
            return;
          }
        }
        const { project, snapshot, tail, more } = await dslr.open(id, { lean, since });
        sendJSON(res, 200, { ...project, snapshot, tail, more });
        return;
      }
      if (method === 'PATCH') {
        await writeRoute(req, async (body) => {
          const name = body && typeof body === 'object' && typeof body.name === 'string' ? projectName(body.name).trim() : '';
          if (!name) throw badRequest('name: непустая строка');
          const project = await viaStorage(storage.renameProject(id, name));
          if (!project) throw notFound();
          // I4: живое имя — сокетам проекта на всех экземплярах
          if (typeof dslts.projectChanged === 'function') dslts.projectChanged(projectSummary(project));
          sendJSON(res, 200, { id: project.id, name: project.name, kind: project.kind, head_seq: project.head_seq });
        }, MAX_TRACE_BYTES);
        return;
      }
      throw methodNotAllowed();
    }
    return route2(req, res, url, method, parts, id);
  }

  /** POST /api/projects: тело уже прочитано и разобрано (под слотом записи). */
  async function createProject(res, body) {
    if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('тело должно быть объектом');
    // круг 29: имя — строка (число — тоже можно, как прежде); объект в String() — TypeError и 500
    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string' && typeof body.name !== 'number') throw badRequest('name: строка');
    const name = body.name === undefined || body.name === null ? '' : projectName(body.name);
    const kind = body.kind === undefined || body.kind === null ? 'design' : body.kind;
    if (!PROJECT_KINDS.has(kind)) throw badRequest(`kind: design | library, а не «${showValue(kind)}»`);
    let doc;
    if (body.doc === undefined || body.doc === null) {
      // новый проект — пустая страница; демо-документ — только по просьбе (§9.10)
      doc = createDoc(body.demo === true ? undefined : 'empty');
    } else {
      const d = cleanBody(body.doc, 'doc');
      // минимальная проверка формы; остальное приводит createDoc(seed) — тот же путь, что импорт JSON на клиенте
      if (!d || typeof d !== 'object' || Array.isArray(d) || !d.nodes || typeof d.nodes !== 'object' || typeof d.root !== 'string' || !d.nodes[d.root]) {
        throw badRequest('doc: объект с nodes и root, корень должен быть среди узлов');
      }
      if (Object.keys(d.nodes).length > MAX_DOC_NODES) throw tooLarge(`doc: не больше ${MAX_DOC_NODES} узлов`, { detail: { limit: 'doc_nodes', max: MAX_DOC_NODES } });
      // J7 (круг 29): глубина и типы полей — проверка движка до приведения; без неё документ
      // глубже предела ложился снимком, и потом каждая операция над ним шла по краю
      const why = importDocError(d, MAX_DOC_NODES);
      if (why) {
        throw badRequest(`doc: ${why.message}`, {
          detail: { limit: why.limit || 'import', ...(why.max !== undefined ? { max: why.max } : {}) }
        });
      }
      try {
        doc = createDoc(d);
      } catch (e) {
        // документ чужой: исключение движка на нём — негодный документ (400), а не сбой сервиса
        // (круг 29: `type: {"toString":1}` у узла давал TypeError в тексте предупреждения движка)
        log.warn('[document/http] createDoc не принял документ импорта:', e && e.message);
        throw badRequest('doc: документ не разобран — проверьте типы полей узлов');
      }
      // своя проверка глубины — по приведённому дереву (движок прежней версии checkImportDoc не знает)
      if (treeDepth(doc, MAX_TREE_DEPTH) > MAX_TREE_DEPTH) {
        throw badRequest(`doc: вложенность глубже ${MAX_TREE_DEPTH} уровней`, { detail: { limit: 'depth', max: MAX_TREE_DEPTH } });
      }
    }
    if (name) doc.meta = { ...(doc.meta || {}), name };
    if (jsonBytes(doc) > MAX_DOC_BYTES) throw tooLarge('doc: больше предела документа', { detail: { limit: 'doc_bytes', max: MAX_DOC_BYTES } });
    const project = await viaStorage(storage.createProject({ name, kind, doc, engine: ENGINE_VERSION }));
    sendJSON(res, 201, { id: project.id, name: project.name, kind: project.kind, head_seq: 0, engine: project.engine, epoch: project.epoch, tip: '', created_at: project.created_at, updated_at: project.updated_at });
  }

  /**
   * Мета транзакций журнала, новые первыми, `seq < before` (без before — от головы),
   * не больше `limit`. `storage.recentTxMeta` (STORE, J2) читает без jsonb операций;
   * хранилище прежней версии — страницы `txsAfter` с конца (операции читаются, но наружу
   * идёт только их число).
   */
  async function historyPage(id, p, limit, before) {
    if (typeof storage.recentTxMeta === 'function') {
      const rows = await viaStorage(storage.recentTxMeta(id, before !== undefined ? { limit, beforeSeq: before } : { limit }));
      return (Array.isArray(rows) ? rows : [])
        .filter((r) => r && Number.isInteger(Number(r.seq)) && (before === undefined || Number(r.seq) < before))
        .sort((a, b) => Number(b.seq) - Number(a.seq))
        .slice(0, limit);
    }
    const top = Math.min(before !== undefined ? before - 1 : p.head_seq, p.head_seq);
    if (top < 1) return [];
    const from = Math.max(0, top - limit);
    const out = [];
    let seq = from;
    while (seq < top) {
      const page = await viaStorage(storage.txsAfter(id, seq, top - seq, { maxBytes: 16 * 1024 * 1024 }));
      if (!page.length) break;
      for (const tx of page) {
        if (tx.seq > top) break;
        out.push({ ...tx, ops_count: Array.isArray(tx.ops) ? tx.ops.length : 0, dropped_count: droppedCount(tx.dropped) });
      }
      seq = page[page.length - 1].seq;
    }
    return out.sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  /** Маршруты `/api/projects/:id/…`. */
  async function route2(req, res, url, method, parts, id) {
    if (parts.length === 4) {
      // GET /api/projects/:id/ops?since=&limit=[&tip=&epoch=]
      if (parts[3] === 'ops') {
        if (method !== 'GET') throw methodNotAllowed();
        const sinceQ = intParam(url, 'since', { min: -1 });
        const since = sinceQ === undefined ? -1 : sinceQ;
        const limit = intParam(url, 'limit', { min: 1, max: MAX_LIMIT });
        const tip = url.searchParams.get('tip') || undefined;
        const epoch = url.searchParams.get('epoch') || undefined;
        if ((tip && tip.length > 128) || (epoch && epoch.length > 64)) throw badRequest('tip/epoch: слишком длинные');
        if (tip || epoch) {
          const p = await dslr.project(id);
          let head = { head_seq: p.head_seq, epoch: p.epoch };
          const decision = await dslr.classify(id, { since, tip, epoch }, head);
          if (decision !== 'tail') {
            if (decision === 'evidence') head = await dslts.clientEvidence(id);
            sendGone(res, await dslr.gone(id), head.epoch);
            return;
          }
        }
        const view = await dslr.since(id, since, limit);
        if (view.gone) {
          sendGone(res, view, view.project.epoch);
          return;
        }
        sendJSON(res, 200, { head_seq: view.head_seq, epoch: view.project.epoch, tip: view.project.head_chain || '', txs: view.txs, more: view.more });
        return;
      }
      // POST /api/projects/:id/tx
      if (parts[3] === 'tx') {
        if (method !== 'POST') throw methodNotAllowed();
        await writeRoute(req, async (body) => {
          const { committed, existing } = await dslts.commit(id, body, { author: authorOf(req), bytes: req.bodyBytes });
          sendJSON(res, existing ? 200 : 201, committed);
        });
        return;
      }
      // GET /api/projects/:id/history?limit=&before= — журнал «Истории» без операций (J2)
      if (parts[3] === 'history') {
        if (method !== 'GET') throw methodNotAllowed();
        const limit = intParam(url, 'limit', { min: 1, max: HISTORY_PAGE_MAX }) || HISTORY_PAGE;
        const before = intParam(url, 'before', { min: 1 });
        const p = await dslr.project(id);
        const metas = await historyPage(id, p, limit + 1, before);
        const items = metas.slice(0, limit).map(historyItem);
        // лишняя строка пришла — дальше есть; хранилище, зажавшее limit до 200, отдаст ровно
        // limit — тогда по номеру: журнал сплошной с 1, младшая не 1 — значит, есть ещё
        const more = metas.length > limit || (items.length === limit && items[items.length - 1].seq > 1);
        sendJSON(res, 200, { items, more });
        return;
      }
      // GET /api/projects/:id/traces?limit= — последние трассы, только чтение
      if (parts[3] === 'traces') {
        if (method !== 'GET') throw methodNotAllowed();
        const limit = intParam(url, 'limit', { min: 1, max: TRACES_MAX }) || TRACES_DEFAULT;
        await dslr.project(id);
        const traces = await viaStorage(storage.listTraces(id, limit));
        sendJSON(res, 200, { traces });
        return;
      }
    }
    throw notFound('нет такого маршрута');
  }

  return (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch (_) {
      sendError(res, badRequest('негодный адрес'));
      return;
    }
    route(req, res, url).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof DocError) {
        sendError(res, e);
      } else {
        log.warn('[document/http] сбой:', e && e.stack ? e.stack : e);
        sendJSON(res, 500, internalBody());
      }
      // тело не дочитано (413): соединение дальше не годится — закрываем, когда ответ ушёл
      if (!req.complete) res.once('finish', () => req.destroy());
    });
  };
}

