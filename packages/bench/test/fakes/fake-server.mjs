// @ts-check
/**
 * Тестовый двойник сервера стенда: отдаёт fake-page.html, минимальный /api
 * (login, test/reset, документы/страницы с телом заданного размера, команды),
 * /big для трафика и echo-WebSocket на /zero. Записывает вызовы хуков.
 *
 * Использование: import { startFakeServer } … либо процессом:
 *   node test/fakes/fake-server.mjs --port 0   (печатает "PORT <n>")
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{port?: number, pageFile?: string, loginDelayMs?: number}} [opts]
 */
export function startFakeServer(opts = {}) {
  const pageHtml = fs.readFileSync(opts.pageFile ?? path.join(here, 'fake-page.html'));
  /** @type {{login: Array<{login: string, ok: boolean}>, reset: Array<{docId: string, auth: string|null}>, commands: any[], pages: number[]}} */
  const calls = { login: [], reset: [], commands: [], pages: [] };
  let tokenSeq = 0;
  /** @param {http.ServerResponse} res @param {number} code @param {unknown} body */
  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
    res.end(s);
  };
  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  const readJson = (req) =>
    new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': pageHtml.length, 'Cache-Control': 'no-store' });
      return res.end(pageHtml);
    }
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = await readJson(req);
      const ok = (body.login === 'alice' && body.password === 'alice-pass') || (body.login === 'bob' && body.password === 'bob-pass');
      calls.login.push({ login: body.login, ok });
      if (opts.loginDelayMs) await new Promise((r) => setTimeout(r, opts.loginDelayMs));
      if (!ok) return json(res, 401, { error: 'unauthorized', message: 'bad credentials' });
      return json(res, 200, { token: `tok-${body.login}-${++tokenSeq}`, userId: `u-${body.login}`, expiresIn: 900 });
    }
    if (req.method === 'POST' && p === '/api/test/reset') {
      const auth = req.headers.authorization ?? null;
      const body = await readJson(req);
      calls.reset.push({ docId: body.docId, auth });
      if (!auth || !auth.startsWith('Bearer tok-')) return json(res, 401, { error: 'unauthorized', message: 'no token' });
      return json(res, 200, { ok: true, docId: body.docId, revision: 0 });
    }
    if (req.method === 'GET' && /^\/api\/documents\/[^/]+$/.test(p)) {
      const pages = [];
      for (let k = 1; k <= 50; k++) pages.push({ id: `p${k}`, index: k, name: k === 1 ? 'library' : `page ${k}` });
      return json(res, 200, { id: p.split('/').pop(), name: 'fake', revision: 7, pages });
    }
    if (req.method === 'GET' && /^\/api\/pages\/\d+$/.test(p)) {
      const k = Number(p.split('/').pop());
      calls.pages.push(k);
      const bytes = Number(url.searchParams.get('bytes') ?? 4096);
      const shapes = [];
      let s = JSON.stringify({ pageId: `p${k}`, revision: 7, shapes });
      while (s.length < bytes) {
        shapes.push({ id: `p${k}-s${shapes.length}`, kind: 'rect', x: 1, y: 2, w: 3, h: 4, z: 0, text: null, fill: '#aaaaaa', isSource: false, sourceId: null, fillOverridden: false });
        s = JSON.stringify({ pageId: `p${k}`, revision: 7, shapes });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
      return res.end(s);
    }
    if (req.method === 'POST' && /^\/api\/documents\/[^/]+\/commands$/.test(p)) {
      const body = await readJson(req);
      calls.commands.push(body);
      return json(res, 200, { opId: body.opId, revision: (body.expectedRevision ?? 0) + 1, affectedPages: ['p1', 'p2', 'p50'], affectedShapes: 100 });
    }
    if (p === '/big') {
      const bytes = Number(url.searchParams.get('bytes') ?? 1024 * 1024);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
      const buf = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < bytes) {
          const n = Math.min(buf.length, bytes - sent);
          sent += n;
          if (!res.write(n === buf.length ? buf : buf.subarray(0, n))) return void res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    json(res, 404, { error: 'not_found', message: p });
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => ws.on('message', (d, bin) => ws.send(d, { binary: bin })));
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').startsWith('/zero')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        server,
        close: () =>
          new Promise((r) => {
            wss.close();
            server.closeAllConnections();
            server.close(() => r(undefined));
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 0;
  startFakeServer({ port }).then((s) => {
    process.stdout.write(`PORT ${s.port}\n`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
