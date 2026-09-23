// @ts-check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { startNetshaper } from '../src/index.mjs';
import { startUpstream } from './upstream.mjs';

/** @type {Awaited<ReturnType<typeof startUpstream>>} */
let up;
/** @type {Awaited<ReturnType<typeof startNetshaper>>} */
let sh;
let base = '';
let statsBase = '';

const DELAY = 25;
const MBIT = 20;

before(async () => {
  up = await startUpstream();
  sh = await startNetshaper({
    listen: 0,
    routes: `/api=127.0.0.1:${up.port},/zero=127.0.0.1:${up.port},/=127.0.0.1:${up.port}`,
    delayMs: DELAY,
    bandwidthMbit: MBIT,
    statsPort: 0,
  });
  base = `http://127.0.0.1:${sh.listenPort}`;
  statsBase = `http://127.0.0.1:${sh.statsPort}`;
});

after(async () => {
  await sh.close();
  await up.close();
});

/**
 * HTTP-запрос с точным подсчётом байтов на клиентском сокете.
 * @param {string} url
 * @param {{method?: string, body?: Buffer|string, agent?: http.Agent, headers?: Record<string,string>}} [opts]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer, ms: number, socketRead: number, socketWritten: number}>}
 */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    /** @type {import('node:net').Socket} */
    let sock;
    const req = http.request(url, { method: opts.method ?? 'GET', agent: opts.agent, headers: opts.headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          ms: performance.now() - t0,
          socketRead: sock.bytesRead,
          socketWritten: sock.bytesWritten,
        });
      });
      res.on('error', reject);
    });
    req.on('socket', (s) => {
      sock = s;
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** @param {number[]} a */
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

test('routing: prefix match, static and api go to upstream, unknown prefix 404 from upstream', async () => {
  const r1 = await request(`${base}/`);
  assert.equal(r1.status, 200);
  assert.match(r1.body.toString(), /upstream/);
  const r2 = await request(`${base}/api/ping`);
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body.toString()).pong, true);
  const r3 = await request(`${base}/nope`);
  assert.equal(r3.status, 404);
});

test('RTT through the shaper ≈ 2×delay (+ local overhead)', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await request(`${base}/api/ping`, { agent }); // прогрев соединения
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < 7; i++) samples.push((await request(`${base}/api/ping`, { agent })).ms);
  agent.destroy();
  const med = median(samples);
  console.log(`  RTT samples (ms): ${samples.map((x) => x.toFixed(1)).join(' ')} → median ${med.toFixed(1)}`);
  assert.ok(med >= 2 * DELAY - 2, `median ${med} < ${2 * DELAY}`);
  assert.ok(med <= 2 * DELAY + 20, `median ${med} too high`);
});

test('POST body passes through (echo) with method preserved; chunked response passes through', async () => {
  const body = Buffer.alloc(100_000, 0x7a);
  const r = await request(`${base}/api/echo`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-method'], 'POST');
  assert.equal(r.body.length, body.length);
  assert.ok(r.body.equals(body));
  const c = await request(`${base}/api/chunked`);
  assert.equal(c.status, 200);
  assert.equal(c.body.toString(), 'chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\ndone\n');
});

test('throughput of a 5 MB download ≈ bandwidth (±15 %)', async () => {
  const bytes = 5 * 1024 * 1024;
  const r = await request(`${base}/big?bytes=${bytes}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, bytes);
  // из времени вычитаем RTT (запрос + первый байт), остальное — сериализация
  const transferMs = r.ms - 2 * DELAY;
  const mbit = (bytes * 8) / (transferMs / 1000) / 1e6;
  console.log(`  5 MB in ${r.ms.toFixed(0)} ms → ${mbit.toFixed(2)} Mbit/s (target ${MBIT})`);
  assert.ok(Math.abs(mbit - MBIT) / MBIT <= 0.15, `throughput ${mbit.toFixed(2)} Mbit/s outside ±15 % of ${MBIT}`);
});

test('WebSocket echo through the shaper works; round-trip ≈ 2×delay', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${sh.listenPort}/zero/sync?x=1`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const msg = `ping-${i}-${'x'.repeat(200)}`;
    const t0 = performance.now();
    const echoed = await new Promise((resolve) => {
      ws.once('message', (d) => resolve(d.toString()));
      ws.send(msg);
    });
    assert.equal(echoed, msg);
    samples.push(performance.now() - t0);
  }
  // бинарное сообщение больше одного сегмента
  const big = Buffer.alloc(50_000, 7);
  const echoedBig = await new Promise((resolve) => {
    ws.once('message', (d) => resolve(/** @type {Buffer} */ (d)));
    ws.send(big);
  });
  assert.ok(Buffer.isBuffer(echoedBig) && echoedBig.equals(big));
  ws.close();
  await new Promise((r) => ws.once('close', r));
  const med = median(samples.slice(1));
  console.log(`  WS RTT samples (ms): ${samples.map((x) => x.toFixed(1)).join(' ')} → median ${med.toFixed(1)}`);
  assert.ok(med >= 2 * DELAY - 2 && med <= 2 * DELAY + 20, `WS RTT median ${med}`);
});

test('byte counters are exact for a known payload and attributed by route', async () => {
  // отдельное соединение, чтобы счётчики сокета соответствовали ровно одному запросу
  await fetch(`${statsBase}/reset`, { method: 'POST' });
  const s0 = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  assert.equal(s0.bytesIn, 0);
  assert.equal(s0.bytesOut, 0);
  const agent = new http.Agent({ keepAlive: false });
  const r = await request(`${base}/api/echo`, { method: 'POST', body: Buffer.alloc(12345, 1), agent });
  assert.equal(r.status, 200);
  // ждём закрытия соединения на шейпере (FIN идёт через задержанный канал)
  await new Promise((res) => setTimeout(res, 4 * DELAY + 50));
  const s1 = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  assert.equal(s1.bytesIn, r.socketWritten, 'bytesIn must equal bytes written by the client socket');
  assert.equal(s1.bytesOut, r.socketRead, 'bytesOut must equal bytes read by the client socket');
  assert.equal(s1.requests, 1);
  assert.equal(s1.connections, 1);
  assert.equal(s1.byRoute['/api'].requests, 1);
  assert.equal(s1.byRoute['/api'].bytesIn, s1.bytesIn);
  assert.equal(s1.byRoute['/api'].bytesOut, s1.bytesOut);
  assert.equal(s1.byRoute['/'].bytesOut, 0);
  console.log(`  bytesIn=${s1.bytesIn} bytesOut=${s1.bytesOut}`);
});

test('keep-alive connection serving several routes attributes bytes per route', async () => {
  await fetch(`${statsBase}/reset`, { method: 'POST' });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const a = await request(`${base}/api/ping`, { agent });
  const b = await request(`${base}/`, { agent });
  const c = await request(`${base}/api/ping`, { agent });
  agent.destroy();
  await new Promise((res) => setTimeout(res, 4 * DELAY + 50));
  const s = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  assert.equal(s.connections, 1);
  assert.equal(s.requests, 3);
  assert.equal(s.byRoute['/api'].requests, 2);
  assert.equal(s.byRoute['/'].requests, 1);
  assert.equal(s.byRoute['/api'].bytesOut + s.byRoute['/'].bytesOut, s.bytesOut);
  assert.equal(s.byRoute['/api'].bytesIn + s.byRoute['/'].bytesIn, s.bytesIn);
  assert.equal(s.bytesOut, c.socketRead, 'sum of all responses on the socket');
  assert.equal(s.bytesIn, c.socketWritten);
  assert.ok(s.byRoute['/'].bytesOut >= b.body.length);
  assert.ok(s.byRoute['/api'].bytesOut >= a.body.length + c.body.length);
});

test('снимок stats сходится по маршрутам даже при ОТКРЫТОМ WebSocket (байты не теряются)', async () => {
  // Раньше байты «от клиента» по ещё не закрытому соединению не относились ни к какому маршруту
  // (атрибуция шла при разборе следующего запроса или при закрытии), поэтому у конфигураций Z,
  // держащих WebSocket весь прогон, Σ byRoute.bytesIn была МЕНЬШЕ bytesIn ровно на объём кадров:
  // разложение обмена по маршрутам (bytes_in_api / _zero / _static) не сходилось с итогом.
  await fetch(`${statsBase}/reset`, { method: 'POST' });
  const ws = new WebSocket(`ws://127.0.0.1:${sh.listenPort}/zero/sync?x=1`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const payload = 'y'.repeat(4000);
  const echoed = await new Promise((resolve) => {
    ws.once('message', (d) => resolve(d.toString()));
    ws.send(payload);
  });
  assert.equal(echoed, payload);
  await new Promise((res) => setTimeout(res, 4 * DELAY + 50));
  // соединение ЕЩЁ ОТКРЫТО — именно так снимает счётчики оболочка измерений
  const s = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  assert.equal(s.activeConnections >= 1, true, 'WebSocket должен быть ещё открыт');
  const sumIn = Object.values(s.byRoute).reduce((a, r) => a + /** @type {any} */ (r).bytesIn, 0);
  const sumOut = Object.values(s.byRoute).reduce((a, r) => a + /** @type {any} */ (r).bytesOut, 0);
  assert.equal(sumIn, s.bytesIn, 'Σ byRoute.bytesIn = bytesIn при открытом соединении');
  assert.equal(sumOut, s.bytesOut, 'Σ byRoute.bytesOut = bytesOut при открытом соединении');
  assert.ok(s.byRoute['/zero'].bytesIn >= payload.length, 'кадры WS отнесены маршруту /zero');
  ws.close();
  await new Promise((res) => setTimeout(res, 4 * DELAY + 50));
  // после закрытия атрибуция НЕ удваивается
  const s2 = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  const sumIn2 = Object.values(s2.byRoute).reduce((a, r) => a + /** @type {any} */ (r).bytesIn, 0);
  assert.equal(sumIn2, s2.bytesIn, 'после закрытия соединения сумма по маршрутам не удвоилась');
});

test('POST /config changes shaping live; GET /config reflects it', async () => {
  const r0 = await fetch(`${statsBase}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delayMs: 0, bandwidthMbit: 0 }) });
  assert.equal((/** @type {any} */ (await r0.json())).config.delayMs, 0);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await request(`${base}/api/ping`, { agent });
  /** @type {number[]} */
  const fast = [];
  for (let i = 0; i < 5; i++) fast.push((await request(`${base}/api/ping`, { agent })).ms);
  agent.destroy();
  console.log(`  RTT with delay 0 (ms): ${fast.map((x) => x.toFixed(1)).join(' ')}`);
  assert.ok(median(fast) < 15, `median ${median(fast)} with zero delay`);
  await fetch(`${statsBase}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delayMs: DELAY, bandwidthMbit: MBIT }) });
  const cfg = /** @type {any} */ (await (await fetch(`${statsBase}/config`)).json());
  assert.equal(cfg.delayMs, DELAY);
  assert.equal(cfg.bandwidthMbit, MBIT);
});

test('token bucket: default 20 ms (≈50 KB at 20 Mbit/s), exposed in /stats.config and /config, changeable via POST /config', async () => {
  const stats = /** @type {any} */ (await (await fetch(`${statsBase}/stats`)).json());
  assert.equal(stats.config.bucketMs, 20);
  assert.equal(stats.config.bucketBytes, Math.round(((MBIT * 1e6) / 8 / 1000) * 20));
  assert.equal(stats.config.segmentBytes, 4096);
  assert.equal(stats.config.handshakeRtt, false);
  const { parseCli } = await import('../src/cli.mjs');
  assert.equal(parseCli([]).bucketMs, 20);
  assert.equal(parseCli(['--bucket-ms', '40']).bucketMs, 40);
  // одиночная страница 117 КБ при ведре 50 КБ не проходит всплеском: ≥ (117−50) КБ / 2.5 КБ/мс ≈ 27 мс сверх RTT
  const bytes = 117 * 1024;
  const r = await request(`${base}/big?bytes=${bytes}`);
  assert.equal(r.body.length, bytes);
  const paced = r.ms - 2 * DELAY;
  console.log(`  117 KB page with 20 ms bucket: ${r.ms.toFixed(0)} ms total, ${paced.toFixed(0)} ms above RTT`);
  assert.ok(paced >= 20, `expected pacing ≥ 20 ms above RTT, got ${paced.toFixed(1)}`);
  const r1 = await fetch(`${statsBase}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucketMs: 40 }) });
  assert.equal((/** @type {any} */ (await r1.json())).config.bucketMs, 40);
  await fetch(`${statsBase}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucketMs: 20 }) });
  assert.equal((/** @type {any} */ (await (await fetch(`${statsBase}/config`)).json())).bucketMs, 20);
});

test('handshake RTT: ON by default in the CLI; new connection costs +RTT for HTTP and for WebSocket, reuse does not', async () => {
  const { parseCli } = await import('../src/cli.mjs');
  assert.equal(parseCli([]).handshakeRtt, true, 'CLI default must emulate the TCP handshake (SPEC §7.1, defect A6/B22)');
  assert.equal(parseCli(['--no-handshake-rtt']).handshakeRtt, false);

  const hs = await startNetshaper({
    listen: 0,
    routes: `/api=127.0.0.1:${up.port},/zero=127.0.0.1:${up.port},/=127.0.0.1:${up.port}`,
    delayMs: DELAY,
    bandwidthMbit: MBIT,
    handshakeRtt: true,
    statsPort: 0,
  });
  try {
    const hsBase = `http://127.0.0.1:${hs.listenPort}`;
    const cfg = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${hs.statsPort}/config`)).json());
    assert.equal(cfg.handshakeRtt, true);
    assert.equal(cfg.handshakeRttMs, 2 * DELAY);

    // HTTP: каждое НОВОЕ соединение платит RTT, повторные запросы по нему — нет
    /** @type {number[]} */
    const fresh = [];
    for (let i = 0; i < 5; i++) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      fresh.push((await request(`${hsBase}/api/ping`, { agent })).ms);
      agent.destroy();
    }
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await request(`${hsBase}/api/ping`, { agent });
    /** @type {number[]} */
    const reused = [];
    for (let i = 0; i < 5; i++) reused.push((await request(`${hsBase}/api/ping`, { agent })).ms);
    agent.destroy();
    const medFresh = median(fresh);
    const medReused = median(reused);
    console.log(`  HTTP first request on a new connection ${medFresh.toFixed(1)} ms vs reused ${medReused.toFixed(1)} ms (delay ${DELAY} ms/way)`);
    assert.ok(medFresh >= 4 * DELAY - 5, `new connection ${medFresh.toFixed(1)} ms must include handshake RTT (≈${4 * DELAY} ms)`);
    assert.ok(medReused <= 2 * DELAY + 20, `reused connection ${medReused.toFixed(1)} ms must not pay it again`);
    assert.ok(medFresh - medReused >= 2 * DELAY - 10, `difference ${(medFresh - medReused).toFixed(1)} ms ≈ one RTT expected`);

    // WebSocket: то же для upgrade-соединения (Z держит одно на прогон)
    const t0 = performance.now();
    const ws = new WebSocket(`ws://127.0.0.1:${hs.listenPort}/zero/sync?x=1`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const openMs = performance.now() - t0;
    const t1 = performance.now();
    const echoed = await new Promise((resolve) => {
      ws.once('message', (d) => resolve(d.toString()));
      ws.send('ping');
    });
    const frameMs = performance.now() - t1;
    assert.equal(echoed, 'ping');
    ws.close();
    await new Promise((r) => ws.once('close', r));
    console.log(`  WS open (handshake+upgrade) ${openMs.toFixed(1)} ms, frame round-trip ${frameMs.toFixed(1)} ms`);
    assert.ok(openMs >= 4 * DELAY - 5, `WS open ${openMs.toFixed(1)} ms must include handshake RTT`);
    assert.ok(frameMs <= 2 * DELAY + 20, `frames on an established WS must not pay it: ${frameMs.toFixed(1)} ms`);

    // переключение на лету (оболочка выставляет флаг перед каждым прогоном)
    const off = /** @type {any} */ (
      await (await fetch(`http://127.0.0.1:${hs.statsPort}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handshakeRtt: false }) })).json()
    );
    assert.equal(off.config.handshakeRtt, false);
    const a2 = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const afterOff = (await request(`${hsBase}/api/ping`, { agent: a2 })).ms;
    a2.destroy();
    assert.ok(afterOff <= 2 * DELAY + 20, `handshake must be off after POST /config: ${afterOff.toFixed(1)} ms`);
  } finally {
    await hs.close();
  }
});

test('upstream unavailable → 502, error counted, proxy keeps serving', async () => {
  const dead = await startNetshaper({ listen: 0, routes: '/=127.0.0.1:1', delayMs: 0, bandwidthMbit: 0, statsPort: null });
  try {
    const r = await request(`http://127.0.0.1:${dead.listenPort}/x`);
    assert.equal(r.status, 502);
    assert.equal(dead.stats().errors, 1);
  } finally {
    await dead.close();
  }
});

test('parallel connections share the link: total throughput stays ≈ bandwidth', async () => {
  const bytes = 1024 * 1024;
  const t0 = performance.now();
  const rs = await Promise.all([0, 1, 2].map(() => request(`${base}/big?bytes=${bytes}`)));
  const ms = performance.now() - t0 - 2 * DELAY;
  for (const r of rs) assert.equal(r.body.length, bytes);
  const mbit = (3 * bytes * 8) / (ms / 1000) / 1e6;
  console.log(`  3×1 MB parallel in ${ms.toFixed(0)} ms → ${mbit.toFixed(2)} Mbit/s aggregate`);
  assert.ok(Math.abs(mbit - MBIT) / MBIT <= 0.15, `aggregate ${mbit.toFixed(2)}`);
});
