// @ts-check
/** Тестовый upstream: HTTP-эндпоинты + echo WebSocket (ws). */
import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * @param {{port?: number}} [opts]
 */
export function startUpstream(opts = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/ping') {
      const body = JSON.stringify({ pong: true, t: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (url.pathname === '/api/echo') {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'X-Method': req.method ?? '' });
        res.end(body);
      });
      return;
    }
    if (url.pathname === '/api/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      let i = 0;
      const t = setInterval(() => {
        res.write(`chunk-${i++}\n`);
        if (i === 5) {
          clearInterval(t);
          res.end('done\n');
        }
      }, 5);
      return;
    }
    if (url.pathname === '/big') {
      const bytes = Number(url.searchParams.get('bytes') ?? 5 * 1024 * 1024);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
      const buf = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < bytes) {
          const n = Math.min(buf.length, bytes - sent);
          sent += n;
          if (!res.write(n === buf.length ? buf : buf.subarray(0, n))) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (url.pathname === '/static/index.html' || url.pathname === '/') {
      const body = '<!doctype html><title>upstream</title><p>hello';
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': 9 });
    res.end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/zero')) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: addr.port,
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
