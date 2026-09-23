// @ts-check
/**
 * Маршрутизирующий HTTP/1.1 reverse-proxy поверх ShapedSocket (SPEC §7.1).
 *
 * Слушающий сокет — `net.Server`; каждое соединение оборачивается в ShapedSocket
 * (задержка + полоса в обе стороны) и передаётся `http.Server` через 'connection'.
 * Дальше — обычный Node http: маршрут по префиксу пути, `http.request` к upstream
 * (keep-alive агент на upstream), тела — потоками (chunked проходит как есть),
 * `Upgrade: websocket` — сырое двустороннее пайпирование после маршрутизации первого запроса.
 *
 * Байты: bytesIn/bytesOut — точный TCP-payload на клиентском сокете. byRoute —
 * атрибуция тех же байтов текущему маршруту соединения (браузер не пайплайнит,
 * поэтому в один момент соединение обслуживает один запрос; байты следующего
 * запроса относятся к нему при его разборе).
 */

import http from 'node:http';
import net from 'node:net';
import { Link } from './link.mjs';
import { ShapedSocket } from './shaped-socket.mjs';

/**
 * @typedef {object} Route
 * @property {string} prefix       '/api', '/zero', '/' …
 * @property {string} host
 * @property {number} port
 * @property {boolean} strip       убирать ли префикс из пути при проксировании
 */

/**
 * @typedef {object} RouteStats
 * @property {number} requests
 * @property {number} upgrades
 * @property {number} bytesIn
 * @property {number} bytesOut
 */

/**
 * @typedef {object} Stats
 * @property {number} bytesIn
 * @property {number} bytesOut
 * @property {number} connections
 * @property {number} activeConnections
 * @property {number} requests
 * @property {number} upgrades
 * @property {number} errors
 * @property {Record<string, RouteStats>} byRoute
 * @property {number} sinceMs      Date.now() последнего reset
 * @property {number} uptimeMs
 * @property {{delayMs:number, bandwidthMbit:number, bucketMs:number, segmentBytes:number, bucketBytes:number|null, handshakeRtt:boolean, handshakeRttMs:number}} config
 * @property {{in:number,out:number}} pendingBytes  ещё не доставленные байты в очередях
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

/**
 * Разбор строки маршрутов CLI: '/api=127.0.0.1:3000,/zero=127.0.0.1:4848;strip,/=127.0.0.1:3000'.
 * @param {string | Route[]} spec
 * @returns {Route[]}
 */
export function parseRoutes(spec) {
  if (Array.isArray(spec)) return spec.map((r) => ({ ...r, strip: r.strip ?? false }));
  /** @type {Route[]} */
  const routes = [];
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) throw new Error(`netshaper: bad route "${p}" (expected prefix=host:port)`);
    let prefix = p.slice(0, eq).trim();
    let target = p.slice(eq + 1).trim();
    let strip = false;
    if (target.endsWith(';strip')) {
      strip = true;
      target = target.slice(0, -';strip'.length);
    }
    target = target.replace(/^https?:\/\//, '');
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
    if (!m) throw new Error(`netshaper: bad upstream "${target}" in route "${p}"`);
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    routes.push({ prefix, host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), strip });
  }
  if (routes.length === 0) throw new Error('netshaper: no routes');
  // самый длинный префикс — первый
  routes.sort((a, b) => b.prefix.length - a.prefix.length);
  return routes;
}

/**
 * @param {Route[]} routes
 * @param {string} url
 * @returns {Route | null}
 */
export function matchRoute(routes, url) {
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  for (const r of routes) {
    if (r.prefix === '/') return r;
    if (path === r.prefix || path.startsWith(r.prefix + '/')) return r;
  }
  return null;
}

/**
 * @param {Route} route
 * @param {string} url
 */
function upstreamPath(route, url) {
  if (!route.strip || route.prefix === '/') return url;
  const rest = url.slice(route.prefix.length);
  return rest.startsWith('/') || rest.startsWith('?') || rest === '' ? rest || '/' : '/' + rest;
}

/**
 * @typedef {object} ProxyOptions
 * @property {number} listen                 порт клиентской стороны
 * @property {string} [host]                 адрес прослушивания (по умолчанию 127.0.0.1)
 * @property {string | Route[]} routes
 * @property {number} delayMs
 * @property {number} bandwidthMbit
 * @property {number} [bucketMs]
 * @property {number} [segmentBytes]
 * @property {boolean} [handshakeRtt]        эмулировать задержку TCP-рукопожатия (RTT на первый запрос соединения)
 * @property {(msg: string) => void} [log]
 */

export class ShapingProxy {
  /** @param {ProxyOptions} opts */
  constructor(opts) {
    this.opts = opts;
    this.routes = parseRoutes(opts.routes);
    this.log = opts.log ?? (() => {});
    /**
     * Эмуляция задержки установления соединения (RTT до первых байтов запроса). Держится в поле, а
     * не в `opts`, потому что меняется на лету (`POST /config {handshakeRtt}`): измерительная
     * оболочка выставляет её перед КАЖДЫМ прогоном, как delayMs и полосу.
     */
    this.handshakeRtt = Boolean(opts.handshakeRtt);
    const linkCfg = { delayMs: opts.delayMs, bandwidthMbit: opts.bandwidthMbit, bucketMs: opts.bucketMs, segmentBytes: opts.segmentBytes };
    this.inbound = new Link('inbound', linkCfg);
    this.outbound = new Link('outbound', linkCfg);
    this.startedAt = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.connections = 0;
    this.requests = 0;
    this.upgrades = 0;
    this.errors = 0;
    /** @type {Record<string, RouteStats>} */
    this.byRoute = {};
    this.sinceMs = Date.now();
    this._resetCounters();
    /** @type {Map<string, http.Agent>} */
    this.agents = new Map();
    /** @type {Set<ShapedSocket>} */
    this.sockets = new Set();

    this.httpServer = http.createServer({ keepAliveTimeout: 65_000, headersTimeout: 70_000, requestTimeout: 0 });
    this.httpServer.on('request', (req, res) => this._onRequest(req, res));
    this.httpServer.on('upgrade', (req, socket, head) => this._onUpgrade(req, /** @type {any} */ (socket), head));
    this.httpServer.on('clientError', (err, socket) => {
      this.errors++;
      if (/** @type {any} */ (err).code === 'ECONNRESET' || !socket.writable) return socket.destroy();
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    this.netServer = net.createServer({ noDelay: true }, (raw) => this._onConnection(raw));
  }

  _resetCounters() {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.connections = 0;
    this.requests = 0;
    this.upgrades = 0;
    this.errors = 0;
    this.byRoute = {};
    for (const r of this.routes) this.byRoute[r.prefix] = { requests: 0, upgrades: 0, bytesIn: 0, bytesOut: 0 };
    this.byRoute['(none)'] = { requests: 0, upgrades: 0, bytesIn: 0, bytesOut: 0 };
    this.sinceMs = Date.now();
  }

  /** @param {net.Socket} raw */
  _onConnection(raw) {
    this.connections++;
    /** @type {{route: string, unattributedIn: number}} */
    const attr = { route: '(none)', unattributedIn: 0 };
    const sink = {
      /** @param {number} n */
      onIn: (n) => {
        this.bytesIn += n;
        attr.unattributedIn += n;
      },
      /** @param {number} n */
      onOut: (n) => {
        this.bytesOut += n;
        this._routeStats(attr.route).bytesOut += n;
      },
    };
    const shaped = new ShapedSocket(raw, { inbound: this.inbound, outbound: this.outbound }, sink, {
      // один RTT (2 × односторонняя задержка) до первых байтов КАЖДОГО нового соединения
      handshakeRttMs: this.handshakeRtt ? 2 * this.inbound.delayMs : 0,
    });
    /** @type {any} */ (shaped).__attr = attr;
    this.sockets.add(shaped);
    shaped.on('close', () => {
      this.sockets.delete(shaped);
      this._attributeIn(attr, attr.route);
    });
    shaped.on('error', () => {});
    raw.on('error', () => {});
    this.httpServer.emit('connection', shaped);
  }

  /**
   * @param {{route: string, unattributedIn: number}} attr
   * @param {string} route
   */
  _attributeIn(attr, route) {
    if (attr.unattributedIn > 0) {
      this._routeStats(route).bytesIn += attr.unattributedIn;
      attr.unattributedIn = 0;
    }
  }

  /** @param {string} prefix @returns {RouteStats} */
  _routeStats(prefix) {
    let rs = this.byRoute[prefix];
    if (!rs) {
      rs = { requests: 0, upgrades: 0, bytesIn: 0, bytesOut: 0 };
      this.byRoute[prefix] = rs;
    }
    return rs;
  }

  /** @param {Route} route */
  _agentFor(route) {
    const key = `${route.host}:${route.port}`;
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 10_000, timeout: 0 });
      this.agents.set(key, agent);
    }
    return agent;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {string} [extra]
   */
  _forwardHeaders(req, extra) {
    /** @type {string[]} */
    const out = [];
    const raw = req.rawHeaders;
    const connectionTokens = new Set(
      String(req.headers.connection ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i];
      const lname = name.toLowerCase();
      if (HOP_BY_HOP.has(lname) && !(extra === 'upgrade' && (lname === 'upgrade' || lname === 'connection'))) continue;
      if (connectionTokens.has(lname) && lname !== 'upgrade') continue;
      out.push(name, raw[i + 1]);
    }
    const xff = req.headers['x-forwarded-for'];
    const addr = req.socket.remoteAddress ?? '';
    out.push('X-Forwarded-For', xff ? `${xff}, ${addr}` : addr);
    return out;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  _onRequest(req, res) {
    const attr = /** @type {any} */ (req.socket).__attr;
    const route = matchRoute(this.routes, req.url ?? '/');
    this.requests++;
    if (!route) {
      if (attr) this._attributeIn(attr, '(none)');
      this._routeStats('(none)').requests++;
      res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('netshaper: no route');
      return;
    }
    if (attr) {
      this._attributeIn(attr, route.prefix);
      attr.route = route.prefix;
    }
    this._routeStats(route.prefix).requests++;

    const headers = this._forwardHeaders(req);
    // тело с Transfer-Encoding: chunked — Node клиент перекодирует сам, если нет content-length
    if (req.headers['transfer-encoding'] && !req.headers['content-length']) headers.push('Transfer-Encoding', 'chunked');
    const upReq = http.request({
      host: route.host,
      port: route.port,
      method: req.method,
      path: upstreamPath(route, req.url ?? '/'),
      headers: /** @type {any} */ (headers),
      agent: this._agentFor(route),
      setHost: false,
    });
    let responded = false;
    upReq.on('response', (upRes) => {
      responded = true;
      /** @type {string[]} */
      const rh = [];
      const r = upRes.rawHeaders;
      for (let i = 0; i < r.length; i += 2) {
        const l = r[i].toLowerCase();
        if (HOP_BY_HOP.has(l)) continue;
        rh.push(r[i], r[i + 1]);
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, /** @type {any} */ (rh));
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    upReq.on('error', (err) => {
      this.errors++;
      this.log(`upstream error ${route.prefix} ${req.method} ${req.url}: ${err.message}`);
      if (!responded && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end(`netshaper: upstream ${route.host}:${route.port} unavailable`);
      } else res.destroy();
    });
    res.on('close', () => {
      if (attr) this._attributeIn(attr, route.prefix);
      if (!res.writableFinished) upReq.destroy();
    });
    req.on('error', () => upReq.destroy());
    req.pipe(upReq);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {ShapedSocket} socket
   * @param {Buffer} head
   */
  _onUpgrade(req, socket, head) {
    const attr = /** @type {any} */ (socket).__attr;
    const route = matchRoute(this.routes, req.url ?? '/');
    this.requests++;
    this.upgrades++;
    if (!route) {
      if (attr) this._attributeIn(attr, '(none)');
      this._routeStats('(none)').requests++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    if (attr) {
      this._attributeIn(attr, route.prefix);
      attr.route = route.prefix;
    }
    const rs = this._routeStats(route.prefix);
    rs.requests++;
    rs.upgrades++;

    const upstream = net.connect({ host: route.host, port: route.port });
    upstream.setNoDelay(true);
    const headers = this._forwardHeaders(req, 'upgrade');
    let reqText = `${req.method} ${upstreamPath(route, req.url ?? '/')} HTTP/1.1\r\n`;
    for (let i = 0; i < headers.length; i += 2) reqText += `${headers[i]}: ${headers[i + 1]}\r\n`;
    reqText += '\r\n';
    upstream.on('connect', () => {
      upstream.write(reqText);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', (err) => {
      this.errors++;
      this.log(`upgrade upstream error ${route.prefix}: ${err.message}`);
      if (socket.writable && !socket.writableEnded) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      if (!socket.destroyed) socket.destroySoon();
    });
  }

  /** @returns {Stats} */
  stats() {
    // bytesIn/bytesOut учитываются на raw-сокете сразу; byRoute для ОТКРЫТЫХ соединений
    // дополняется при разборе следующего запроса или при закрытии соединения. Поэтому в снимке
    // байты «от клиента» по ещё не закрытым соединениям (в первую очередь WebSocket синхронизации
    // Zero, который живёт весь прогон) относились бы ни к какому маршруту, и разложение НЕ
    // сходилось бы с итогом: Σ byRoute.bytesIn < bytesIn ровно на объём кадров WS (≈7.4 кБ на
    // прогон у Z). Ниже они добавляются к маршруту, который соединение обслуживает СЕЙЧАС —
    // снимок сходится с итогом, а сами счётчики не меняются (атрибуция при закрытии не двоится).
    const byRoute = structuredClone(this.byRoute);
    for (const sock of this.sockets) {
      const attr = /** @type {any} */ (sock).__attr;
      if (!attr || !(attr.unattributedIn > 0)) continue;
      const rs = (byRoute[attr.route] ??= { requests: 0, upgrades: 0, bytesIn: 0, bytesOut: 0 });
      rs.bytesIn += attr.unattributedIn;
    }
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      connections: this.connections,
      activeConnections: this.sockets.size,
      requests: this.requests,
      upgrades: this.upgrades,
      errors: this.errors,
      byRoute,
      sinceMs: this.sinceMs,
      uptimeMs: Date.now() - this.startedAt,
      config: { delayMs: this.inbound.delayMs, bandwidthMbit: this.inbound.config.bandwidthMbit, bucketMs: this.inbound.bucketMs, segmentBytes: this.inbound.segmentBytes, bucketBytes: Number.isFinite(this.inbound.bucketBytes) ? Math.round(this.inbound.bucketBytes) : null, handshakeRtt: this.handshakeRtt, handshakeRttMs: this.handshakeRtt ? 2 * this.inbound.delayMs : 0 },
      pendingBytes: { in: this.inbound.pendingBytes, out: this.outbound.pendingBytes },
    };
  }

  reset() {
    this._resetCounters();
    // сохраняем текущий маршрут открытых соединений, но обнуляем неучтённые байты
    for (const s of this.sockets) {
      const attr = /** @type {any} */ (s).__attr;
      if (attr) attr.unattributedIn = 0;
    }
  }

  /**
   * Смена параметров канала на лету. `handshakeRtt` применяется к соединениям, открытым ПОСЛЕ
   * вызова (уже открытые рукопожатие прошли).
   * @param {{delayMs?: number, bandwidthMbit?: number, bucketMs?: number, handshakeRtt?: boolean}} cfg
   */
  configure(cfg) {
    this.inbound.configure(cfg);
    this.outbound.configure(cfg);
    if (cfg.handshakeRtt !== undefined) this.handshakeRtt = Boolean(cfg.handshakeRtt);
    return this.stats().config;
  }

  /** @returns {Promise<number>} фактический порт */
  listen() {
    return new Promise((resolve, reject) => {
      this.netServer.once('error', reject);
      this.netServer.listen(this.opts.listen, this.opts.host ?? '127.0.0.1', () => {
        this.netServer.off('error', reject);
        const addr = /** @type {net.AddressInfo} */ (this.netServer.address());
        resolve(addr.port);
      });
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    await new Promise((resolve) => this.netServer.close(() => resolve(undefined)));
    for (const s of this.sockets) s.destroy();
    for (const a of this.agents.values()) a.destroy();
    this.httpServer.closeAllConnections?.();
    await new Promise((resolve) => this.httpServer.close(() => resolve(undefined)));
    this.inbound.close();
    this.outbound.close();
  }
}
