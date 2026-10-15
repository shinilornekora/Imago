/**
 * Предел входящих записей (SPEC §9.10, круг 25): на сокет — не больше двух
 * необработанных транзакций (сверх — пауза чтения и `error busy`), очередь мьютекса
 * проекта и экземпляра ограничена байтами (сверх — 503 `busy` + Retry-After по HTTP,
 * `error busy` по WS), HTTP-запись — под семафором. Раньше каждое сообщение сокета
 * сразу шло в очередь, и три сокета с транзакциями по 4 МБ роняли процесс по памяти.
 *
 * Стек собирается здесь из модулей (а не через start()), чтобы задать пределы
 * маленькими и замедлить запись — так очередь копится за миллисекунды.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import { artboards, uid, ENGINE_VERSION } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createReader } from '../../server/document/dslr.js';
import { createSequencer } from '../../server/document/dslts.js';
import { createHub } from '../../server/document/hub.js';
import { createRequestHandler } from '../../server/document/http.js';
import { WS_INFLIGHT } from '../../server/document/limits.js';
import { api, connect, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Транзакция примерно `bytes` байт: set на несуществующий узел (слияние отбросит дёшево). */
function bigTx(bytes, ops = 1) {
  const per = Math.max(1, Math.floor(bytes / ops) - 64);
  const list = [];
  for (let i = 0; i < ops; i++) list.push({ op: 'set', id: 'нет_' + i, path: 'name', value: 'v'.repeat(per) });
  return { tx_id: uid('tx'), base_seq: 0, engine: E, ops: list };
}

/** Стек Document service над памятью с замедленной записью и своими пределами. */
async function stack({ seq = {}, hub = {}, writes = {}, delayMs = 0 } = {}) {
  const storage = createMemoryStorage();
  await storage.init();
  // замедлить запись: очередь мьютекса успевает накопиться; заодно — сколько записей одновременно в очереди
  const commitTx = storage.commitTx.bind(storage);
  storage.commitTx = async (...a) => {
    if (delayMs) await sleep(delayMs);
    return commitTx(...a);
  };
  const dslr = createReader({ storage });
  const dslts = createSequencer({ storage, verifyMs: 0, log: quiet, ...seq });
  const server = http.createServer(createRequestHandler({ dslr, dslts, storage, log: quiet, writes }));
  const h = createHub({ server, dslr, dslts, pingInterval: 0, log: quiet, ...hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  // пики очереди — опросом
  const peaks = { txs: 0, bytes: 0, total: 0 };
  let watching = null;
  const watch = (id) => {
    watching = setInterval(() => {
      const q = dslts.queueStats(id);
      peaks.txs = Math.max(peaks.txs, q.txs);
      peaks.bytes = Math.max(peaks.bytes, q.bytes);
      peaks.total = Math.max(peaks.total, q.totalBytes);
    }, 1);
  };
  return {
    storage, dslts, hub: h, url, port, peaks, watch,
    async project() {
      const p = await storage.createProject({ name: 'Поток', kind: 'design', doc: (await import('../../src/core.js')).createDoc(), engine: E });
      return p.id;
    },
    ws: (id, client) => connect(`ws://127.0.0.1:${port}/ws?project=${id}&client=${client}&proto=2`),
    async close() {
      if (watching) clearInterval(watching);
      await h.close();
      await new Promise((r) => server.close(() => r()));
      await dslts.close();
      await storage.close();
    }
  };
}

/** Ответы на каждую отправленную транзакцию: tx (своя) или error с её tx_id. */
async function outcomes(sock, ids, ms = 20000) {
  const want = new Set(ids);
  const got = new Map();
  const until = Date.now() + ms;
  while (got.size < want.size && Date.now() < until) {
    const m = await sock.next(Math.max(1, until - Date.now()));
    if (m.type === 'tx' && want.has(m.tx.tx_id)) got.set(m.tx.tx_id, { ok: true });
    else if (m.type === 'error' && want.has(m.tx_id)) got.set(m.tx_id, { ok: false, code: m.code, retryable: m.retryable, limit: m.detail && m.detail.limit });
  }
  return got;
}

describe('предел входящих записей (§9.10)', () => {
  it(`сокет: не больше ${WS_INFLIGHT} транзакций в полёте — остальное busy (retryable), записанное — по порядку`, async () => {
    const s = await stack({ delayMs: 30 });
    try {
      const id = await s.project();
      s.watch(id);
      const sock = s.ws(id, 'F');
      await sock.until((m) => m.type === 'hello');
      // мелкие — приходят одним куском TCP и разбираются разом: пауза чтения их уже не остановит
      const txs = Array.from({ length: 30 }, () => bigTx(1024));
      for (const t of txs) sock.send({ type: 'tx', tx: t });
      const res = await outcomes(sock, txs.map((t) => t.tx_id));
      assert.equal(res.size, 30, 'ответ на каждую');
      const ok = [...res.values()].filter((r) => r.ok).length;
      const busy = [...res.values()].filter((r) => !r.ok);
      assert.ok(ok >= WS_INFLIGHT, `записано ${ok}`);
      assert.ok(busy.length >= 1, 'сверх предела — busy');
      for (const b of busy) {
        assert.equal(b.code, 'busy');
        assert.equal(b.retryable, true);
        assert.equal(b.limit, 'socket_inflight');
      }
      assert.ok(s.peaks.txs <= WS_INFLIGHT, `в очереди проекта одновременно ${s.peaks.txs}`);
      assert.equal(s.hub.busyRefused(), busy.length);
      // повтор отказанных проходит: сокет снова читает
      const retry = txs.filter((t) => !res.get(t.tx_id).ok).slice(0, 1);
      for (const t of retry) sock.send({ type: 'tx', tx: t });
      const again = await outcomes(sock, retry.map((t) => t.tx_id));
      for (const r of again.values()) assert.equal(r.ok, true);
      await sock.close();
    } finally {
      await s.close();
    }
  });

  it('очередь проекта ограничена байтами: много сокетов → busy queue_project, в очереди не больше предела', async () => {
    const s = await stack({ delayMs: 40, seq: { queueProjectBytes: 3 * MB } });
    try {
      const id = await s.project();
      s.watch(id);
      const socks = await Promise.all(Array.from({ length: 5 }, async (_, k) => {
        const sock = s.ws(id, 'S' + k);
        await sock.until((m) => m.type === 'hello');
        return sock;
      }));
      const sent = socks.map((sock) => {
        const txs = [bigTx(MB), bigTx(MB)];
        for (const t of txs) sock.send({ type: 'tx', tx: t });
        return txs.map((t) => t.tx_id);
      });
      const all = await Promise.all(socks.map((sock, k) => outcomes(sock, sent[k])));
      const flat = all.flatMap((m) => [...m.values()]);
      assert.equal(flat.length, 10);
      const byQueue = flat.filter((r) => !r.ok && r.limit === 'queue_project');
      assert.ok(byQueue.length >= 1, JSON.stringify(flat));
      assert.ok(flat.filter((r) => r.ok).length >= 2);
      assert.ok(s.peaks.bytes <= 3 * MB + 64 * 1024, `пик очереди ${s.peaks.bytes}`);
      await Promise.all(socks.map((x) => x.close()));
    } finally {
      await s.close();
    }
  });

  it('очередь экземпляра ограничена байтами по всем проектам: сверх — 503 busy queue_total', async () => {
    const s = await stack({ delayMs: 40, seq: { queueProjectBytes: 64 * MB, queueTotalBytes: 5 * MB } });
    try {
      const p1 = await s.project();
      const p2 = await s.project();
      const calls = [];
      for (let k = 0; k < 4; k++) {
        for (const id of [p1, p2]) calls.push(s.dslts.commit(id, bigTx(16), { bytes: MB }).then(() => 'ok', (e) => `${e.status}:${e.code}:${e.detail && e.detail.limit}:${e.retryAfter}`));
      }
      const res = await Promise.all(calls);
      assert.equal(res.filter((r) => r === 'ok').length, 5, JSON.stringify(res));
      assert.deepEqual([...new Set(res.filter((r) => r !== 'ok'))], ['503:busy:queue_total:1']);
      assert.equal(s.dslts.queueStats().totalBytes, 0, 'очередь опустела');
    } finally {
      await s.close();
    }
  });

  it('HTTP-запись — под семафором: сверх очереди — 503 busy с Retry-After, тело не читается', async () => {
    const s = await stack({ delayMs: 60, writes: { max: 1, queue: 1 } });
    try {
      const id = await s.project();
      const h = api(s.url);
      const res = await Promise.all(Array.from({ length: 5 }, () => h.post(`/api/projects/${id}/tx`, bigTx(1024))));
      const codes = res.map((r) => r.status).sort();
      assert.equal(codes.filter((c) => c === 201).length, 2, JSON.stringify(codes));
      const busy = res.filter((r) => r.status === 503);
      assert.equal(busy.length, 3);
      for (const b of busy) {
        assert.equal(b.body.code, 'busy');
        assert.equal(b.body.retryable, true);
        assert.ok(Number(b.headers.get('retry-after')) >= 1);
      }
    } finally {
      await s.close();
    }
  });

  it('поток больших транзакций с трёх сокетов: память ограничена, процесс жив, лишнее — busy', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const s = await stack({ delayMs: 20 });
    try {
      const id = await s.project();
      s.watch(id);
      gc();
      const base = process.memoryUsage().heapUsed;
      let peak = base;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
      // как у критика: 5000 мелких операций — объектов в куче много больше, чем байт в сообщении
      const socks = await Promise.all([0, 1, 2].map(async (k) => {
        const sock = s.ws(id, 'H' + k);
        await sock.until((m) => m.type === 'hello');
        return sock;
      }));
      const N = 10;
      const sent = socks.map((sock) => {
        const ids = [];
        for (let i = 0; i < N; i++) {
          const t = bigTx(3.8 * MB, 5000);
          ids.push(t.tx_id);
          sock.send({ type: 'tx', tx: t });
        }
        return ids;
      });
      const all = await Promise.all(socks.map((sock, k) => outcomes(sock, sent[k], 120000)));
      clearInterval(sampler);
      const flat = all.flatMap((m) => [...m.values()]);
      assert.equal(flat.length, 3 * N, 'ответ на каждую');
      // большие сообщения идут кусками TCP: пауза чтения держит их у клиента — отказов может и не быть
      for (const r of flat) if (!r.ok) assert.equal(r.code, 'busy');
      assert.ok(flat.filter((r) => r.ok).length >= 3);
      assert.ok(s.peaks.txs <= 3 * WS_INFLIGHT, `в очереди одновременно ${s.peaks.txs}`);
      const grew = (peak - base) / MB;
      // без предела 30 разобранных транзакций по 3,8 МБ (5000 объектов каждая) — это гигабайты кучи
      assert.ok(grew < 500, `куча выросла на ${grew.toFixed(0)} МБ`);
      await Promise.all(socks.map((x) => x.close()));
    } finally {
      await s.close();
    }
  });
});
