#!/usr/bin/env node
/**
 * Мок сервера стенда (SPEC §2.1–2.3) — только для разработки/проверки клиента.
 * В памяти: пользователи alice/bob, по документу у каждого; login → токен (в памяти, 15 мин);
 * чтение документов/страниц; команды с проверкой ревизии, идемпотентностью по opId и affectedPages;
 * GET /api/operations/:opId; тестовые хуки /api/test/delay и /api/test/reset; отдача статики (dist).
 *
 * Запуск:  node dev/mock-server.mjs [--port 3000] [--latency 0] [--static ../dist] [--pages 10] [--shapes 50] [--quiet]
 * Импорт:  import { createMockServer, generateDoc } from './mock-server.mjs'
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ генератор документа

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#333333'];

/**
 * Детерминированный документ: `pages` страниц × `shapesPerPage` фигур. Страница 0 — «library» с источниками.
 * Источник №1 (`<doc>-src-1`) имеет экземпляры на нескольких страницах (в т. ч. на последней), часть — переопределены.
 */
export function generateDoc({ id, ownerId, name, pages = 10, shapesPerPage = 50, sources = 3, seed = 1 }) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const pageList = [];
  for (let i = 0; i < pages; i += 1) {
    pageList.push({ id: `${id}-p${i}`, documentId: id, index: i, name: i === 0 ? 'library' : `Страница ${i}` });
  }
  const shapes = [];
  const counts = new Array(pages).fill(0);
  const mk = (pageIndex, kind, extra) => {
    const n = counts[pageIndex];
    counts[pageIndex] += 1;
    const w = 40 + Math.floor(rnd() * 120);
    const h = 30 + Math.floor(rnd() * 100);
    const s = {
      id: `${id}-p${pageIndex}-s${n}`,
      documentId: id,
      pageId: pageList[pageIndex].id,
      kind,
      x: Math.floor(rnd() * (1280 - w)),
      y: Math.floor(rnd() * (720 - h)),
      w,
      h,
      z: n,
      text: kind === 'text' ? `text ${pageIndex}/${n}` : null,
      fill: pick(PALETTE),
      isSource: false,
      sourceId: null,
      fillOverridden: false,
      ...extra,
    };
    shapes.push(s);
    return s;
  };
  // источники на library
  const sourceShapes = [];
  for (let k = 1; k <= sources; k += 1) {
    const s = mk(0, k % 2 === 0 ? 'ellipse' : 'rect', { isSource: true });
    s.id = `${id}-src-${k}`;
    sourceShapes.push(s);
  }
  // экземпляры источника 1: на страницах 2, 4, 6 и последней (если есть), по 4 штуки, четверть — переопределены
  const instancePages = [...new Set([2, 4, 6, pages - 1].filter((i) => i > 0 && i < pages))];
  const src1 = sourceShapes[0];
  for (const pi of instancePages) {
    for (let j = 0; j < 4; j += 1) {
      const overridden = j === 3;
      mk(pi, src1.kind, {
        sourceId: src1.id,
        fill: overridden ? '#123456' : src1.fill,
        fillOverridden: overridden,
      });
    }
  }
  // экземпляры остальных источников: по 2 на страницах 1 и 3
  for (let k = 1; k < sourceShapes.length; k += 1) {
    const src = sourceShapes[k];
    for (const pi of [1, 3].filter((i) => i < pages)) {
      for (let j = 0; j < 2; j += 1) mk(pi, src.kind, { sourceId: src.id, fill: src.fill });
    }
  }
  // добор обычных фигур до shapesPerPage
  const kinds = ['rect', 'ellipse', 'text'];
  for (let pi = 0; pi < pages; pi += 1) {
    while (counts[pi] < shapesPerPage) mk(pi, pick(kinds));
  }
  return { id, ownerId, name, revision: 0, pages: pageList, shapes };
}

// ------------------------------------------------------------------ состояние сервера

const USERS = [
  { id: 'u-alice', login: 'alice', password: 'alice-pass' },
  { id: 'u-bob', login: 'bob', password: 'bob-pass' },
];

export function createState({ pages = 10, shapesPerPage = 50 } = {}) {
  const docs = new Map();
  const add = (doc) => docs.set(doc.id, doc);
  add(generateDoc({ id: 'doc-alice-1', ownerId: 'u-alice', name: 'Alice doc', pages, shapesPerPage, seed: 11 }));
  add(generateDoc({ id: 'doc-alice-2', ownerId: 'u-alice', name: 'Alice small', pages: 3, shapesPerPage: 12, seed: 12 }));
  add(generateDoc({ id: 'doc-bob-1', ownerId: 'u-bob', name: 'Bob doc', pages: 4, shapesPerPage: 20, seed: 21 }));
  const initial = new Map();
  for (const d of docs.values()) {
    initial.set(d.id, { revision: d.revision, fills: d.shapes.map((s) => [s.fill, s.fillOverridden]) });
  }
  return {
    docs,
    initial,
    tokens: new Map(), // token → {userId, expiresAt}
    operations: new Map(), // opId → {documentId, paramsHash, result, createdAt}
    delays: [], // {re, ms, once}
    commandLog: [], // все успешные (неидемпотентные) применения
    reads: { inFlight: 0, max: 0, total: 0, aborted: 0 }, // проба параллелизма/отмены чтений страниц
  };
}

// ------------------------------------------------------------------ HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const HEX = /^#[0-9a-f]{6}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export function createMockServer({ latency = 0, staticDir = null, pages = 10, shapesPerPage = 50, quiet = true } = {}) {
  const state = createState({ pages, shapesPerPage });
  const log = quiet ? () => undefined : (...a) => console.log('[mock]', ...a);

  const auth = (req) => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const t = state.tokens.get(m[1]);
    if (!t || t.expiresAt < Date.now()) return null;
    return t.userId;
  };

  const applyDelays = async (pathname) => {
    for (const d of [...state.delays]) {
      if (d.re.test(pathname)) {
        if (d.once) state.delays.splice(state.delays.indexOf(d), 1);
        log('delay', pathname, d.ms);
        await sleep(d.ms);
      }
    }
  };

  const serveStatic = async (res, pathname) => {
    if (!staticDir) return json(res, 404, { error: 'not_found', message: 'no static dir' });
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'forbidden', message: 'path' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not file');
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': rel === '/index.html' ? 'no-store' : 'public, max-age=3600',
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not_found', message: 'file not found' });
    }
  };

  const handleApi = async (req, res, url) => {
    const p = url.pathname;
    const method = req.method ?? 'GET';
    log(method, p);
    const isPageRead = method === 'GET' && /^\/api\/documents\/[^/]+\/pages\/[^/]+$/.test(p);
    if (isPageRead) {
      state.reads.total += 1;
      state.reads.inFlight += 1;
      state.reads.max = Math.max(state.reads.max, state.reads.inFlight);
      res.once('finish', () => {
        state.reads.inFlight -= 1;
      });
      res.once('close', () => {
        if (!res.writableFinished) {
          state.reads.inFlight -= 1;
          state.reads.aborted += 1;
        }
      });
    }
    if (latency > 0) await sleep(latency);

    if (method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });

    if (method === 'POST' && p === '/api/auth/login') {
      const body = await readBody(req).catch(() => null);
      const u = USERS.find((x) => x.login === body?.login && x.password === body?.password);
      if (!u) return json(res, 401, { error: 'unauthorized', message: 'bad credentials' });
      const token = randomBytes(24).toString('hex');
      state.tokens.set(token, { userId: u.id, expiresAt: Date.now() + 15 * 60 * 1000 });
      return json(res, 200, { token, userId: u.id, expiresIn: 900 });
    }

    // тестовые хуки (не требуют авторизации в моке)
    if (method === 'POST' && p === '/api/test/delay') {
      const body = await readBody(req).catch(() => null);
      if (!body?.pathPattern) return json(res, 400, { error: 'bad_request', message: 'pathPattern' });
      const idx = state.delays.findIndex((d) => d.src === body.pathPattern);
      if (idx >= 0) state.delays.splice(idx, 1);
      if (body.ms > 0) state.delays.push({ src: body.pathPattern, re: new RegExp(body.pathPattern), ms: body.ms, once: Boolean(body.once) });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/test/reset') {
      const body = await readBody(req).catch(() => null);
      const doc = state.docs.get(body?.docId);
      if (!doc) return json(res, 404, { error: 'not_found', message: 'document' });
      const init = state.initial.get(doc.id);
      doc.revision = init.revision;
      doc.shapes.forEach((s, i) => {
        s.fill = init.fills[i][0];
        s.fillOverridden = init.fills[i][1];
      });
      for (const [opId, op] of state.operations) if (op.documentId === doc.id) state.operations.delete(opId);
      state.commandLog = state.commandLog.filter((c) => c.documentId !== doc.id);
      return json(res, 200, { ok: true, revision: doc.revision });
    }

    const userId = auth(req);
    if (!userId) return json(res, 401, { error: 'unauthorized', message: 'missing or invalid token' });

    if (method === 'GET' && p === '/api/documents') {
      const list = [...state.docs.values()]
        .filter((d) => d.ownerId === userId)
        .map((d) => ({ id: d.id, name: d.name, revision: d.revision, pageCount: d.pages.length, shapeCount: d.shapes.length }));
      return json(res, 200, list);
    }

    let m = /^\/api\/operations\/([^/]+)$/.exec(p);
    if (method === 'GET' && m) {
      const op = state.operations.get(decodeURIComponent(m[1]));
      if (!op) return json(res, 404, { error: 'not_found', message: 'operation' });
      const doc = state.docs.get(op.documentId);
      if (!doc || doc.ownerId !== userId) return json(res, 403, { error: 'forbidden', message: 'not your operation' });
      return json(res, 200, { opId: op.result.opId, status: 'done', result: op.result });
    }

    m = /^\/api\/documents\/([^/]+)(?:\/(pages)\/([^/]+)|\/(commands))?$/.exec(p);
    if (!m) return json(res, 404, { error: 'not_found', message: 'route' });
    const doc = state.docs.get(decodeURIComponent(m[1]));
    if (!doc) return json(res, 404, { error: 'not_found', message: 'document' });
    if (doc.ownerId !== userId) return json(res, 403, { error: 'forbidden', message: 'not your document' });

    if (method === 'GET' && !m[2] && !m[4]) {
      return json(res, 200, { id: doc.id, name: doc.name, revision: doc.revision, pages: doc.pages.map((pg) => ({ id: pg.id, index: pg.index, name: pg.name })) });
    }

    if (method === 'GET' && m[2] === 'pages') {
      const pageId = decodeURIComponent(m[3]);
      const page = doc.pages.find((pg) => pg.id === pageId);
      if (!page) return json(res, 404, { error: 'not_found', message: 'page' });
      // снимок берётся согласованно (ревизия + фигуры), задержка применяется к уже взятому снимку
      const snapshot = { documentId: doc.id, pageId, revision: doc.revision, shapes: doc.shapes.filter((s) => s.pageId === pageId).map((s) => ({ ...s })) };
      await applyDelays(p);
      return json(res, 200, snapshot);
    }

    if (method === 'POST' && m[4] === 'commands') {
      const body = await readBody(req).catch(() => undefined);
      if (body === undefined) return json(res, 400, { error: 'bad_request', message: 'invalid JSON' });
      const ok =
        body &&
        typeof body.opId === 'string' &&
        body.opId.length > 0 &&
        (body.type === 'setSourceFill' || body.type === 'setLocalFill') &&
        typeof body.targetId === 'string' &&
        typeof body.fill === 'string' &&
        HEX.test(body.fill) &&
        Number.isInteger(body.expectedRevision);
      if (!ok) return json(res, 400, { error: 'bad_request', message: 'invalid command' });
      const paramsHash = createHash('sha256')
        .update(JSON.stringify([doc.id, body.type, body.targetId, body.fill, body.expectedRevision]))
        .digest('hex');
      const existing = state.operations.get(body.opId);
      if (existing) {
        if (existing.paramsHash !== paramsHash) return json(res, 409, { error: 'op_conflict', message: 'same opId, different params' });
        log('idempotent replay', body.opId);
        return json(res, 200, existing.result);
      }
      const target = doc.shapes.find((s) => s.id === body.targetId);
      if (!target) {
        const foreign = [...state.docs.values()].some((d) => d.shapes.some((s) => s.id === body.targetId));
        return json(res, foreign ? 403 : 404, { error: foreign ? 'forbidden' : 'not_found', message: 'target' });
      }
      if (body.expectedRevision !== doc.revision) {
        return json(res, 409, { error: 'revision_mismatch', message: `expected ${body.expectedRevision}, current ${doc.revision}`, currentRevision: doc.revision });
      }
      const affectedPages = new Set();
      let affectedShapes = 0;
      if (body.type === 'setSourceFill') {
        if (!target.isSource) return json(res, 400, { error: 'bad_request', message: 'target is not a source' });
        for (const s of doc.shapes) {
          if (s.id === target.id || (s.sourceId === target.id && !s.fillOverridden)) {
            s.fill = body.fill;
            affectedPages.add(s.pageId);
            affectedShapes += 1;
          }
        }
      } else {
        if (target.isSource) return json(res, 400, { error: 'bad_request', message: 'local fill on a source' });
        target.fill = body.fill;
        target.fillOverridden = true;
        affectedPages.add(target.pageId);
        affectedShapes = 1;
      }
      doc.revision += 1;
      const result = { opId: body.opId, revision: doc.revision, affectedPages: [...affectedPages], affectedShapes };
      state.operations.set(body.opId, { documentId: doc.id, paramsHash, result, createdAt: Date.now() });
      state.commandLog.push({ documentId: doc.id, ...body, revision: doc.revision });
      await applyDelays(p);
      return json(res, 200, result);
    }
    return json(res, 404, { error: 'not_found', message: 'route' });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const run = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(res, url.pathname);
    run.catch((e) => {
      console.error('[mock] error', e);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: String(e?.message ?? e) });
    });
  });

  return {
    server,
    state,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------------------ CLI

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticArg = opt('static', null);
  const mock = createMockServer({
    latency: Number(opt('latency', process.env.MOCK_LATENCY ?? 0)),
    staticDir: staticArg ? path.resolve(here, staticArg) : null,
    pages: Number(opt('pages', 10)),
    shapesPerPage: Number(opt('shapes', 50)),
    quiet: args.includes('--quiet'),
  });
  const port = await mock.listen(Number(opt('port', 3000)));
  console.log(`[mock] listening on http://127.0.0.1:${port} latency=${opt('latency', process.env.MOCK_LATENCY ?? 0)}ms static=${staticArg ?? '-'}`);
}
