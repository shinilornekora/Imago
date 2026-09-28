/**
 * HTTP-маршруты Document service (SPEC §9.2). Только `node:http`: JSON, коды
 * ответов как в таблице §9.2. CORS не нужен — nginx держит `/api` и `/ws` на
 * том же origin, что и статику; на OPTIONS отвечаем 204, чтобы preflight из
 * dev-сборки на другом порту не падал на 404.
 *
 * `STATIC_DIR` — раздача клиента (index.html, app.js, styles.css, src/*.js)
 * для прогонов без nginx. Только GET/HEAD, только внутри каталога.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createDoc, ENGINE_VERSION } from '../../src/core.js';
import { DocError, viaStorage } from './errors.js';
import { MAX_LIMIT } from './dslr.js';
import { projectSummary } from './storage/committed.js';

/** Предел тела запроса (SPEC: транзакция ≤ 4 МБ; документ проекта — тоже). */
export const MAX_BODY = 4 * 1024 * 1024;
const PROJECT_KINDS = new Set(['design', 'library']);
const MAX_PROJECT_NAME = 200;

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

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/**
 * Тело запроса как JSON: пусто → null; больше MAX_BODY → 413; не JSON → 400.
 * Слишком большое тело не дочитываем и не рвём соединение сразу: чтение
 * останавливается, ответ 413 уходит, и только потом обработчик закрывает
 * соединение (см. createRequestHandler) — иначе клиент вместо 413 видел бы
 * обрыв и не понял бы, что транзакцию надо разбить, а не повторить.
 */
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => {
      req.pause();
      reject(new DocError(413, 'too-large', `тело больше ${MAX_BODY} байт`));
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      tooLarge();
      return;
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new DocError(400, 'bad-request', 'тело не JSON'));
      }
    });
    req.on('error', (e) => reject(new DocError(400, 'bad-request', 'обрыв тела запроса: ' + e.message)));
  });
}

/** Автор из заголовка X-Author (SPEC §9: авторизации нет, имя — самоназванное). */
function authorOf(req) {
  const h = req.headers['x-author'];
  if (!h) return undefined;
  try {
    // заголовок — latin1; имя по-русски клиент шлёт как UTF-8 в percent-encoding
    return decodeURIComponent(String(h)).slice(0, 200);
  } catch (_) {
    return String(h).slice(0, 200);
  }
}

async function serveStatic(req, res, root, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (_) {
    sendJSON(res, 400, { error: 'bad-request', message: 'негодный путь' });
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(root, '.' + rel);
  // путь вне каталога (../) не раздаём — как и всё, что не файл
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendJSON(res, 404, { error: 'not-found', message: 'нет такого файла' });
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch (_) {
    sendJSON(res, 404, { error: 'not-found', message: 'нет такого файла' });
    return;
  }
  if (!info.isFile()) {
    sendJSON(res, 404, { error: 'not-found', message: 'нет такого файла' });
    return;
  }
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

/**
 * @param {{dslr: object, dslts: object, storage: object, staticDir?: string, log?: object}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ dslr, dslts, storage, staticDir, log = console }) {
  const root = staticDir ? path.resolve(staticDir) : null;

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
      throw new DocError(404, 'not-found', 'нет такого маршрута');
    }

    // GET /api/health
    if (parts.length === 2 && parts[1] === 'health' && method === 'GET') {
      sendJSON(res, 200, { ok: true, engine: ENGINE_VERSION });
      return;
    }

    if (parts[1] !== 'projects') throw new DocError(404, 'not-found', 'нет такого маршрута');

    // GET|POST /api/projects
    if (parts.length === 2) {
      if (method === 'GET') {
        const list = await viaStorage(storage.listProjects());
        sendJSON(res, 200, { projects: list.map(projectSummary) });
        return;
      }
      if (method === 'POST') {
        const body = (await readJSON(req)) || {};
        if (typeof body !== 'object' || Array.isArray(body)) throw new DocError(400, 'bad-request', 'тело должно быть объектом');
        const name = body.name === undefined || body.name === null ? '' : String(body.name).slice(0, MAX_PROJECT_NAME);
        const kind = body.kind === undefined || body.kind === null ? 'design' : body.kind;
        if (!PROJECT_KINDS.has(kind)) throw new DocError(400, 'bad-request', 'kind: design | library');
        let doc;
        if (body.doc === undefined || body.doc === null) {
          doc = createDoc();
        } else {
          const d = body.doc;
          // минимальная проверка формы; остальное приводит createDoc(seed) — тот же путь, что импорт JSON на клиенте
          if (!d || typeof d !== 'object' || Array.isArray(d) || !d.nodes || typeof d.nodes !== 'object' || typeof d.root !== 'string' || !d.nodes[d.root]) {
            throw new DocError(400, 'bad-request', 'doc: объект с nodes и root, корень должен быть среди узлов');
          }
          doc = createDoc(d);
        }
        if (name) doc.meta = { ...(doc.meta || {}), name };
        const project = await viaStorage(storage.createProject({ name, kind, doc, engine: ENGINE_VERSION }));
        sendJSON(res, 201, { id: project.id, name: project.name, kind: project.kind, head_seq: 0, engine: project.engine, created_at: project.created_at, updated_at: project.updated_at });
        return;
      }
      throw new DocError(405, 'method-not-allowed', 'метод не поддерживается');
    }

    const id = parts[2];

    // GET|PATCH /api/projects/:id
    if (parts.length === 3) {
      if (method === 'GET') {
        const { project, snapshot, tail } = await dslr.open(id);
        sendJSON(res, 200, { ...project, snapshot, tail });
        return;
      }
      if (method === 'PATCH') {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || typeof body.name !== 'string' || !body.name.trim()) throw new DocError(400, 'bad-request', 'name: непустая строка');
        const project = await viaStorage(storage.renameProject(id, body.name.trim().slice(0, MAX_PROJECT_NAME)));
        if (!project) throw new DocError(404, 'not-found', 'проект не найден');
        sendJSON(res, 200, { id: project.id, name: project.name, kind: project.kind, head_seq: project.head_seq });
        return;
      }
      throw new DocError(405, 'method-not-allowed', 'метод не поддерживается');
    }

    if (parts.length === 4) {
      // GET /api/projects/:id/ops?since=&limit=
      if (parts[3] === 'ops' && method === 'GET') {
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw === null || sinceRaw === '' ? -1 : Number(sinceRaw);
        if (!Number.isInteger(since) || since < -1) throw new DocError(400, 'bad-request', 'since: целое ≥ 0');
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) throw new DocError(400, 'bad-request', `limit: целое от 1 до ${MAX_LIMIT}`);
        const view = await dslr.since(id, since, limit);
        if (view.gone) {
          sendJSON(res, 410, { snapshot: view.snapshot, head_seq: view.head_seq });
          return;
        }
        sendJSON(res, 200, { head_seq: view.head_seq, txs: view.txs });
        return;
      }
      // POST /api/projects/:id/tx
      if (parts[3] === 'tx' && method === 'POST') {
        const body = await readJSON(req);
        const { committed, existing } = await dslts.commit(id, body, { author: authorOf(req) });
        sendJSON(res, existing ? 200 : 201, committed);
        return;
      }
    }
    throw new DocError(404, 'not-found', 'нет такого маршрута');
  }

  return (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    route(req, res, url).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof DocError) {
        sendJSON(res, e.status, e.body());
      } else {
        log.warn('[document/http] сбой:', e && e.stack ? e.stack : e);
        sendJSON(res, 500, { error: 'internal', message: 'внутренняя ошибка' });
      }
      // тело не дочитано (413): соединение дальше не годится — закрываем, когда ответ ушёл
      if (!req.complete) res.once('finish', () => req.destroy());
    });
  };
}
