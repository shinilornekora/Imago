// @ts-check
/**
 * Служебный HTTP-сервер статистики шейпера (только для измерительной оболочки):
 *   GET  /stats            → счётчики
 *   POST /reset            → обнулить счётчики
 *   POST /config {delayMs, bandwidthMbit, bucketMs?} → сменить параметры канала на лету
 *   GET  /config           → текущие параметры
 *   GET  /health
 */

import http from 'node:http';

/**
 * @param {import('./proxy.mjs').ShapingProxy} proxy
 * @param {{port: number, host?: string}} opts
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>}
 */
export function startStatsServer(proxy, opts) {
  const server = http.createServer((req, res) => {
    /** @param {number} code @param {unknown} body */
    const json = (code, body) => {
      const s = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
      res.end(s);
    };
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/stats') return json(200, proxy.stats());
    if (req.method === 'GET' && url === '/config') return json(200, proxy.stats().config);
    if (req.method === 'GET' && url === '/health') return json(200, { ok: true });
    if (req.method === 'POST' && url === '/reset') {
      proxy.reset();
      return json(200, { ok: true, stats: proxy.stats() });
    }
    if (req.method === 'POST' && url === '/config') {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          const cfg = proxy.configure(body);
          json(200, { ok: true, config: cfg });
        } catch (err) {
          json(400, { ok: false, error: String(/** @type {Error} */ (err)?.message ?? err) });
        }
      });
      return;
    }
    json(404, { ok: false, error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r(undefined));
          }),
      });
    });
  });
}
