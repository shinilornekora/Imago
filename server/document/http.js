/**
 * HTTP-маршруты Document service (SPEC §9.2, §9.8). Только `node:http`: JSON,
 * коды ответов как в таблице §9.2; тело любой ошибки —
 * `{error: true, code, message, retryable, detail?}` (+ `Retry-After`, когда
 * повтор имеет смысл позже). CORS не нужен — nginx держит `/api` и `/ws` на том
 * же origin, что и статику; на OPTIONS отвечаем 204, чтобы preflight из
 * dev-сборки на другом порту не падал на 404.
 *
 * `STATIC_DIR` — раздача клиента (index.html, app.js, styles.css, src/*.js)
 * для прогонов без nginx. Только GET/HEAD, только эти файлы (белый список, круг 33).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, notFound, tooLarge, internalBody, viaStorage } from './errors.js';
import { projectSummary } from './storage/committed.js';
import { createSemaphore } from './dslr.js';
import { cleanBody as cleanBodyOf, projectName as projectNameOf, prepareProject } from './importer.js';
import {
  MAX_BODY_BYTES, MAX_LIMIT, MAX_DOC_NODES, MAX_DOC_BYTES, MAX_TRACE_BYTES, TRACES_DEFAULT, TRACES_MAX,
  HTTP_WRITE_CONCURRENCY, HTTP_WRITE_QUEUE, BUSY_RETRY_S, MAX_VALUE_DEPTH, PROJECTS_PAGE, PROJECTS_PAGE_MAX,
  WRITE_BODY_BYTES, BODY_TIMEOUT_MS, BODY_FIRST_BYTE_MS, BODY_IDLE_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
  HISTORY_PAGE, HISTORY_PAGE_MAX, HEALTH_PING_MS, HEALTH_CACHE_MS,
  isCleanText, cleanText, cleanMeta, cutText, cleanDeep, showValue, undoPartOf
} from './limits.js';

/** Предел тела запроса (совместимость: прежде экспортировался отсюда). */
export const MAX_BODY = MAX_BODY_BYTES;
const PROJECT_KINDS = new Set(['design', 'library']);
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
function readBody(req, max = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS, onChunk = null, firstByteMs = 0, idleMs = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;
    let idle = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
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
    // круг 39: тело объявлено, а первый байт не пришёл за firstByteMs — 408 сразу (молчащее
    // соединение не держит запрос и место до общего срока тела)
    let first = null;
    const expectBody = (Number.isFinite(declared) && declared > 0) || /chunked/i.test(String(req.headers['transfer-encoding'] || ''));
    if (firstByteMs > 0 && expectBody && (!(timeoutMs > 0) || firstByteMs < timeoutMs)) {
      first = setTimeout(() => {
        if (size === 0) stop(new DocError(408, 'timeout', `тело запроса не начало приходить за ${Math.round(firstByteMs / 1000)} с`, { retryable: true, detail: { limit: 'body_first_byte', ms: firstByteMs } }));
      }, firstByteMs);
      if (first.unref) first.unref();
      const clear = () => clearTimeout(first);
      req.once('data', clear);
      req.once('end', clear);
      req.once('close', clear);
    }
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        stop(tooLarge(`тело больше ${max} байт`, { detail: { limit: 'body_bytes', max } }));
        return;
      }
      // круг 35: бюджет байт тел записи — по прочитанному (onChunk бросает — отказ, чтение стоп)
      if (onChunk) {
        try {
          onChunk(chunk.length);
        } catch (e) {
          stop(e);
          return;
        }
      }
      chunks.push(chunk);
      // круг 41: тело начало приходить и замолчало посреди — 408 через idleMs без байтов (прочитанное
      // освобождает бюджет тел сразу, а не через общий срок тела: 16 соединений по 4 МБ − 1 байт
      // держали бы бюджет все 30 с)
      if (idleMs > 0 && (!(timeoutMs > 0) || idleMs < timeoutMs)) {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => stop(new DocError(408, 'timeout', `тело запроса замолчало посреди: ${Math.round(idleMs / 1000)} с без данных`, { retryable: true, detail: { limit: 'body_idle', ms: idleMs } })), idleMs);
        if (idle.unref) idle.unref();
      }
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
    return cutText(cleanMeta(decodeURIComponent(String(h))), 200);
  } catch (_) {
    return cutText(cleanMeta(String(h)), 200);
  }
}

/**
 * Целое из query или undefined; не целое или вне [min, max] → 400 до всякого SQL (круг 31:
 * `before=9999999999999999999999` доходил до базы как 1e+22 и возвращался 400 с SQLSTATE
 * 22P02 про «половинку суррогатной пары»). Только десятичные цифры (без `1e3`, `0x10`,
 * пробелов); верхняя граница по умолчанию — Number.MAX_SAFE_INTEGER (bigint seq до неё точен).
 */
function intParam(url, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = /^-?\d{1,17}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`${name}: целое от ${min} до ${max}`, { detail: { param: name, min, max } });
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

/**
 * Что раздаёт STATIC_DIR (круг 33): только файлы клиента — те, что tools/build.mjs кладёт в
 * dist/web (index.html, app.js, styles.css, src/<модуль>.js). Прежде каталог раздавался
 * целиком: `STATIC_DIR=.` из корня репозитория отдавал `.env`, `.git/config`, исходники
 * сервера и node_modules. Сегмент, начинающийся с точки, — 404 всегда (до белого списка).
 */
const STATIC_FILES = new Set(['/index.html', '/app.js', '/styles.css']);
const STATIC_SRC_RE = /^\/src\/[A-Za-z0-9_-]+\.js$/;
export function staticAllowed(rel) {
  if (typeof rel !== 'string' || !rel.startsWith('/')) return false;
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return false;
  return STATIC_FILES.has(rel) || STATIC_SRC_RE.test(rel);
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
  // только файлы клиента: ни `.env`, ни `.git`, ни server/, ни node_modules (круг 33)
  if (rel.includes('\\') || rel.includes('\u0000') || !staticAllowed(rel)) return missing();
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

/** Значение для jsonb (трассы): строки и ключи чистые (§9.10); глубже предела — 400. Импорт — importer.js. */
const cleanBody = cleanBodyOf;

/** Имя проекта — метаданные (круг 31): без управляющих и bidi-символов (PATCH; создание — importer.js). */
const projectName = projectNameOf;

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
  // круг 31: подписи — без управляющих и bidi-символов и у записей, сделанных до чистки
  const meta = (v) => (typeof v === 'string' && v ? cleanMeta(v) || null : null);
  const out = {
    seq: Number(m.seq), tx_id: m.tx_id,
    author: meta(m.author), author_kind: m.author_kind || 'human', title: meta(m.title),
    created_at: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
    client: m.client ?? null, command_id: m.command_id ?? null,
    // круг 30: кто дал команду агенту (подпись «Агент · Аня»); у человеческой и старой записи — null
    command_author: meta(m.command_author),
    // круг 32: отмена/повтор (`undo_of`/`redo_of`) и часть большой правки (`undo_part`) — оболочка
    // сводит части одной правки в одну строку точно, а не по подписи
    undo_of: typeof m.undo_of === 'string' && m.undo_of ? m.undo_of : null,
    redo_of: typeof m.redo_of === 'string' && m.redo_of ? m.redo_of : null,
    undo_part: undoPartOf(m.undo_part),
    ops_count: Number(m.ops_count) || 0, dropped_count: Number(m.dropped_count) || 0
  };
  if (out.ops_count === 0) out.empty = true;
  return out;
}

/**
 * @param {{dslr: object, dslts: object, storage: object, staticDir?: string, internalToken?: string, log?: object,
 *   writes?: {max?: number, queue?: number, retryAfter?: number, bodyBytes?: number, bodyTimeoutMs?: number, firstByteMs?: number, idleMs?: number}}} deps
 *   `writes` — запись по HTTP (`POST …/tx`, `POST /api/projects`, `PATCH`): семафор (одновременно и в
 *   очереди; сверх — 503 busy), бюджет байт читаемых тел на экземпляр, таймаут тела;
 *   `importer` — пул подготовки импорта (import-pool.js, круг 33); нет — подготовка здесь же
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ dslr, dslts, storage, staticDir, internalToken, log = console, writes = {}, importer = null }) {
  /** Версия движка экземпляра (круг 39: секвенсор знает её; прежний — версия кода). */
  const instanceEngine = dslts && Number.isInteger(dslts.engine) ? dslts.engine : ENGINE_VERSION;
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
  const firstByteMs = writes.firstByteMs !== undefined ? writes.firstByteMs : BODY_FIRST_BYTE_MS;
  const bodyIdleMs = writes.idleMs !== undefined ? writes.idleMs : BODY_IDLE_MS;
  let bodyBytesUsed = 0;

  /**
   * Запись (круг 27): тело читается в бюджете байт экземпляра, слот семафора записи берётся
   * только ПОСЛЕ того, как тело дочитано: медленное тело держит байты бюджета (и не дольше
   * таймаута тела), но не слот. Разбор JSON и вся работа — уже под слотом.
   * Круг 35: бюджет занимают ПРОЧИТАННЫЕ байты, а не заявленный Content-Length: прежде 16
   * соединений, объявивших по 4 МБ и шлющих по байту в секунду, держали весь бюджет пустыми
   * обещаниями — честная запись получала 503 до таймаута тела. Теперь сверх бюджета — 503 busy
   * тому, чей очередной кусок тела не влез (тело одно больше бюджета — читается, если других нет).
   * @param {(body: any) => Promise<void>} fn
   */
  async function writeRoute(req, fn, max = MAX_BODY_BYTES, prepare = null) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) throw tooLarge(`тело больше ${max} байт`, { detail: { limit: 'body_bytes', max } });
    let held = 0;
    const take = (n) => {
      if (bodyBytesUsed - held > 0 && bodyBytesUsed + n > bodyBudget) {
        throw new DocError(503, 'busy', 'сервер принимает слишком много записей сразу — повторите чуть позже', {
          retryable: true, retryAfter, detail: { limit: 'body_bytes_total' }
        });
      }
      bodyBytesUsed += n;
      held += n;
    };
    try {
      const buf = await readBody(req, max, bodyTimeoutMs, take, firstByteMs, bodyIdleMs);
      // круг 33: тяжёлая подготовка тела (импорт) — до слота записи: слот держит только запись
      if (prepare) {
        const prep = await prepare(buf);
        await writeGate.run(() => fn(prep));
      } else {
        await writeGate.run(() => fn(parseBody(buf)));
      }
    } finally {
      bodyBytesUsed -= held;
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
      res.writeHead(204, { Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS' });
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
      // круг 31: база жива, но её схема отстала от кода (восстановили из копии, снятой до
      // миграций) — хранилище догоняет миграции; пока не догнало — не здоров
      const schema = storage.schemaState || null;
      if (schema) {
        const waiting = schema.phase === 'empty' || schema.phase === 'restore';
        throw new DocError(503, 'unavailable', waiting
          // круг 33: базу пересоздают и восстанавливают под работающим сервисом — DDL не трогаем, ждём
          ? 'схема базы не согласована с кодом: база пуста или в неё идёт восстановление — сервис ждёт его конца и не запускает миграции'
          : 'схема базы не согласована с кодом (базу восстановили из старой копии?) — сервис догоняет миграции', {
          retryable: true, retryAfter: 5,
          detail: { storage: 'schema', phase: schema.phase, ...(schema.migration ? { migration: schema.migration } : {}), since: schema.since }
        });
      }
      // круг 33: схема годна, а долгое дозаполнение миграции (009) идёт фоном — сервис рабочий
      const backfill = storage.backfillState || null;
      sendJSON(res, 200, { ok: true, engine: instanceEngine, storage: 'up', ...(backfill ? { detail: { backfill } } : {}) });
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
        const body = { projects: page.projects.map((p) => projectSummary(p)), more: page.more };
        if (page.more && page.next) body.next = encodeCursor(page.next);
        sendJSON(res, 200, body);
        return;
      }
      if (method === 'POST') {
        await createProjectRoute(req, res);
        return;
      }
      throw methodNotAllowed();
    }

    const id = parts[2];

    // GET|PATCH|DELETE /api/projects/:id   (?head=1 — только голова; ?lean=1[&since=] — без документа снимка)
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
        const view = await dslr.open(id, { lean, since });
        const { project, tail, more } = view;
        if (typeof view.snapshotJson === 'string') {
          // круг 33: снимок — уже строкой (кеш DSLR): в ответ вставляется как есть, без второй сериализации
          const head = JSON.stringify(project);
          const text = `${head.length > 2 ? head.slice(0, -1) + ',' : '{'}"snapshot":${view.snapshotJson},"tail":${JSON.stringify(tail)},"more":${more ? 'true' : 'false'}}`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
          res.end(text);
          return;
        }
        sendJSON(res, 200, { ...project, snapshot: view.snapshot, tail, more });
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
      if (method === 'DELETE') {
        // круг 45 (§9.19): удалить можно только пустую сироту спасения — тело {create_id} того
        // создания, без единой записи журнала; любой другой проект этим путём не удаляется
        await writeRoute(req, async (body) => {
          // ключ — в теле или в `?create_id=` (часть прокси режет тело у DELETE); оба — должны совпасть
          if (body && typeof body === 'object' && body.create_id !== undefined && typeof body.create_id !== 'string') {
            throw badRequest('create_id: строка', { detail: { param: 'create_id' } });
          }
          const fromBody = body && typeof body === 'object' && typeof body.create_id === 'string' ? body.create_id : '';
          const fromQuery = url.searchParams.get('create_id') || '';
          if (fromBody && fromQuery && fromBody !== fromQuery) throw badRequest('create_id в теле и в адресе разные', { detail: { param: 'create_id' } });
          const cid = fromBody || fromQuery;
          if (!cid) throw badRequest('create_id: строка — удаляется только пустой проект своего создания', { detail: { param: 'create_id' } });
          const r = await viaStorage(dslts.deleteEmpty(id, cid));
          if (r.status === 'not_found') throw notFound();
          if (r.status === 'create_id') throw new DocError(409, 'conflict', 'проект создан не этим create_id — удалить его так нельзя', { retryable: false, detail: { cause: 'create_id', param: 'create_id' } });
          if (r.status === 'not_empty') throw new DocError(409, 'conflict', 'в проекте уже есть правки — пустым он не считается и не удаляется', { retryable: false, detail: { cause: 'not_empty' } });
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
        }, MAX_TRACE_BYTES);
        return;
      }
      throw methodNotAllowed();
    }
    return route2(req, res, url, method, parts, id);
  }

  /**
   * POST /api/projects (круг 33): тело готовится (разбор, проверка и приведение документа) ДО
   * слота записи — большое в потоке импорта (`importer`), маленькое здесь же; слот записи
   * берётся только на запись в хранилище. `create_id` (L1): проект с ним уже есть — 200 и он же.
   */
  async function createProjectRoute(req, res) {
    await writeRoute(req, async (prep) => {
      const project = await viaStorage(storage.createProject({
        name: prep.name, kind: prep.kind, docJson: prep.docJson, engine: instanceEngine,
        ...(prep.createId ? { createId: prep.createId, createHash: prep.createHash } : {})
      }));
      const existing = project.existing === true;
      // круг 39 (N4г): тот же create_id, а тело другое (имя, вид, документ, demo) — не «тот же
      // проект»: 409. Отпечаток неизвестен (проект создан до 013 или прежним экземпляром) — сверка по виду
      if (existing && createConflict(project, prep)) {
        throw new DocError(409, 'conflict', 'create_id уже занят проектом, созданным другим телом запроса — для нового проекта нужен новый create_id', {
          retryable: false, detail: { cause: 'create_id', param: 'create_id' }
        });
      }
      sendJSON(res, existing ? 200 : 201, {
        id: project.id, name: existing ? cleanMeta(project.name) : project.name, kind: project.kind,
        head_seq: existing ? project.head_seq : 0, engine: project.engine, epoch: project.epoch,
        tip: existing ? project.head_chain || '' : '', created_at: project.created_at, updated_at: project.updated_at,
        ...(existing ? { existing: true } : {})
      });
    }, MAX_BODY_BYTES, (buf) => (importer ? importer.run(buf) : prepareInline(buf)));
  }

  /** Повтор create_id с другим телом? (круг 39: отпечаток нормализованного тела, importer.createHashOf) */
  function createConflict(project, prep) {
    const stored = typeof project.create_hash === 'string' && project.create_hash ? project.create_hash : null;
    if (stored && typeof prep.createHash === 'string' && prep.createHash) return stored !== prep.createHash;
    return project.kind !== prep.kind;
  }

  /** Подготовка без пула потоков (обработчик собран без него — тесты прежних кругов). */
  function prepareInline(buf) {
    const body = parseBody(buf);
    return prepareProject(body || {}, { onWarn: (w) => log.warn(w) });
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

