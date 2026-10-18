/**
 * Пределы Document service из окружения (круг 26): `WS_INFLIGHT`, `HTTP_WRITE_*`,
 * `QUEUE_*`, `PRESENCE_TTL_MS`, `SNAPSHOT_*`, `DB_TIMEOUT_MS` — с умолчаниями из
 * limits.js; опция start() главнее окружения; негодное — предупреждение и умолчание.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitsFrom, ENV_LIMITS, start } from '../../server/document/index.js';
import * as L from '../../server/document/limits.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { uid, ENGINE_VERSION } from '../../src/core.js';

const quietLog = () => {
  const warns = [];
  return { warns, log: { info() {}, warn: (m) => warns.push(String(m)) } };
};

test('умолчания — из limits.js', () => {
  const { log, warns } = quietLog();
  const c = limitsFrom({}, {}, log);
  assert.deepEqual(c, {
    snapshotEvery: L.SNAPSHOT_EVERY, snapshotKeep: L.SNAPSHOT_KEEP, presenceTtlMs: L.PRESENCE_TTL_MS,
    dbTimeoutMs: L.DB_TIMEOUT_MS, maxInflight: L.WS_INFLIGHT, maxConnecting: L.WS_CONNECTING, writesMax: L.HTTP_WRITE_CONCURRENCY,
    writesQueue: L.HTTP_WRITE_QUEUE, queueProjectBytes: L.QUEUE_PROJECT_BYTES, queueProjectTxs: L.QUEUE_PROJECT_TXS,
    queueTotalBytes: L.QUEUE_TOTAL_BYTES,
    tombKeepSeq: L.TOMB_KEEP_SEQ, tombPruneEvery: L.TOMB_PRUNE_EVERY, tombMax: L.TOMB_MAX,
    recentTxs: L.RECENT_TXS, recentBytes: L.RECENT_BYTES,
    writesBodyBytes: L.WRITE_BODY_BYTES, writesBodyTimeoutMs: L.BODY_TIMEOUT_MS,
    headsBytes: L.HEADS_BYTES, importConcurrency: L.IMPORT_CONCURRENCY, importQueue: L.IMPORT_QUEUE,
    importTaskMs: L.IMPORT_TASK_MS, snapshotCacheBytes: L.SNAPSHOT_CACHE_BYTES,
  });
  assert.equal(warns.length, 0);
});

test('окружение задаёт, опция главнее, негодное — в лог и умолчание', () => {
  const { log, warns } = quietLog();
  const env = {
    WS_INFLIGHT: '4', HTTP_WRITE_CONCURRENCY: '3', HTTP_WRITE_QUEUE: '0', QUEUE_PROJECT_BYTES: '1048576',
    QUEUE_PROJECT_TXS: ' 16 ', QUEUE_TOTAL_BYTES: '2e6', PRESENCE_TTL_MS: '60000', SNAPSHOT_EVERY: '0',
    SNAPSHOT_KEEP: 'много', DB_TIMEOUT_MS: '-5',
  };
  const c = limitsFrom({ queueProjectTxs: 7, writes: { max: 9 } }, env, log);
  assert.equal(c.maxInflight, 4);
  assert.equal(c.writesMax, 9, 'опция главнее окружения');
  assert.equal(c.writesQueue, 0, '0 — допустимое значение');
  assert.equal(c.queueProjectBytes, 1048576);
  assert.equal(c.queueProjectTxs, 7);
  assert.equal(c.queueTotalBytes, 2000000);
  assert.equal(c.presenceTtlMs, 60000);
  assert.equal(c.snapshotEvery, 0);
  assert.equal(c.snapshotKeep, L.SNAPSHOT_KEEP);
  assert.equal(c.dbTimeoutMs, L.DB_TIMEOUT_MS);
  assert.equal(warns.length, 2, warns.join('\n'));
  assert.ok(warns.some((w) => w.includes('SNAPSHOT_KEEP')) && warns.some((w) => w.includes('DB_TIMEOUT_MS')));
});

test('сервис берёт пределы из окружения: svc.config, семафор записи и очередь проекта', async () => {
  const keep = {};
  const set = { WS_INFLIGHT: '1', HTTP_WRITE_CONCURRENCY: '2', QUEUE_PROJECT_TXS: '5', PRESENCE_TTL_MS: '30000' };
  for (const k of Object.keys(set)) { keep[k] = process.env[k]; process.env[k] = set[k]; }
  let svc;
  try {
    svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), pingInterval: 0, log: { info() {}, warn() {} } });
  } finally {
    for (const k of Object.keys(set)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
  try {
    assert.equal(svc.config.maxInflight, 1);
    assert.equal(svc.config.writesMax, 2);
    assert.equal(svc.config.queueProjectTxs, 5);
    assert.equal(svc.config.presenceTtlMs, 30000);
    const r = await fetch(svc.url + '/api/health');
    assert.equal(r.status, 200);
  } finally {
    await svc.close();
  }
});

test('круг 27: надгробия, память головы и тела записи — из окружения до секвенсора и HTTP', async () => {
  const { log, warns } = quietLog();
  const c = limitsFrom({ writes: { bodyTimeoutMs: 0 } }, {
    TOMB_KEEP_SEQ: '0', TOMB_PRUNE_EVERY: '0', TOMB_MAX: '7', RECENT_TXS: '3', RECENT_BYTES: '4096',
    WRITE_BODY_BYTES: '1048576', BODY_TIMEOUT_MS: '500',
  }, log);
  assert.equal(c.tombKeepSeq, 0);
  assert.equal(c.tombPruneEvery, L.TOMB_PRUNE_EVERY, '0 — негодно (граница делится на него)');
  assert.equal(c.tombMax, 7);
  assert.equal(c.recentTxs, 3);
  assert.equal(c.recentBytes, 4096);
  assert.equal(c.writesBodyBytes, 1048576);
  assert.equal(c.writesBodyTimeoutMs, 0, 'опция writes.bodyTimeoutMs главнее окружения');
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.ok(warns[0].includes('TOMB_PRUNE_EVERY'));
  assert.equal(limitsFrom({}, { BODY_TIMEOUT_MS: '500' }, log).writesBodyTimeoutMs, L.BODY_TIMEOUT_MS, 'меньше секунды — умолчание');

  // сервис: окружение доходит до секвенсора (надгробия, выжимки) и до HTTP (таймаут тела)
  const set = { TOMB_KEEP_SEQ: '0', TOMB_PRUNE_EVERY: '1', TOMB_MAX: '1', RECENT_TXS: '2', BODY_TIMEOUT_MS: '1000' };
  const keep = {};
  for (const k of Object.keys(set)) { keep[k] = process.env[k]; process.env[k] = set[k]; }
  let svc;
  try {
    svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), pingInterval: 0, verifyMs: 0, log: { info() {}, warn() {} } });
  } finally {
    for (const k of Object.keys(set)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
  try {
    assert.equal(svc.config.tombMax, 1);
    assert.equal(svc.config.writesBodyTimeoutMs, 1000);
    const post = (path, body) => fetch(svc.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    const p = await post('/api/projects', { name: 'Пределы' });
    assert.equal(p.status, 201);
    const id = p.body.id;
    const doc = (await (await fetch(`${svc.url}/api/projects/${id}`)).json()).snapshot.doc;
    const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
    let base = 0;
    for (let k = 0; k < 3; k++) {
      const n = uid('n');
      const node = { type: 'text', id: n, name: 't', parent: doc.root, characters: 'x', style: { token: 'body' }, align: 'left', color: '#14161C', size: HUG };
      const a = await post(`/api/projects/${id}/tx`, { tx_id: uid('tx'), base_seq: base, engine: ENGINE_VERSION, ops: [{ op: 'create', node }] });
      const b = await post(`/api/projects/${id}/tx`, { tx_id: uid('tx'), base_seq: a.body.seq, engine: ENGINE_VERSION, ops: [{ op: 'remove', id: n }] });
      assert.equal(b.status, 201, JSON.stringify(b.body));
      base = b.body.seq;
    }
    const head = await svc.dslts.headOf(id);
    assert.ok(head.tombSeq.size <= 1, `TOMB_MAX=1 — надгробий ${head.tombSeq.size}`);
    assert.ok(head.recent.length <= 2, `RECENT_TXS=2 — выжимок ${head.recent.length}`);

    // медленное тело: 408 по BODY_TIMEOUT_MS из окружения (1 с), а не через 30 с
    const sock = net.connect(svc.port, '127.0.0.1');
    sock.on('error', () => {});
    let reply = '';
    sock.on('data', (d) => { reply += d.toString(); });
    const t0 = Date.now();
    sock.write(`POST /api/projects/${id}/tx HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    while (!reply && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    assert.match(reply, /^HTTP\/1\.1 408/, reply.slice(0, 80));
    assert.ok(Date.now() - t0 < 8000, `408 через ${Date.now() - t0} мс`);
  } finally {
    await svc.close();
  }
});

test('README Document service называет все переменные пределов', () => {
  const readme = readFileSync(new URL('../../server/document/README.md', import.meta.url), 'utf8');
  for (const name of Object.keys(ENV_LIMITS)) assert.ok(readme.includes('`' + name + '`'), name);
});
