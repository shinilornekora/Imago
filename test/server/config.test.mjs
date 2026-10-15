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

const quietLog = () => {
  const warns = [];
  return { warns, log: { info() {}, warn: (m) => warns.push(String(m)) } };
};

test('умолчания — из limits.js', () => {
  const { log, warns } = quietLog();
  const c = limitsFrom({}, {}, log);
  assert.deepEqual(c, {
    snapshotEvery: L.SNAPSHOT_EVERY, snapshotKeep: L.SNAPSHOT_KEEP, presenceTtlMs: L.PRESENCE_TTL_MS,
    dbTimeoutMs: L.DB_TIMEOUT_MS, maxInflight: L.WS_INFLIGHT, writesMax: L.HTTP_WRITE_CONCURRENCY,
    writesQueue: L.HTTP_WRITE_QUEUE, queueProjectBytes: L.QUEUE_PROJECT_BYTES, queueProjectTxs: L.QUEUE_PROJECT_TXS,
    queueTotalBytes: L.QUEUE_TOTAL_BYTES,
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

test('README Document service называет все переменные пределов', () => {
  const readme = readFileSync(new URL('../../server/document/README.md', import.meta.url), 'utf8');
  for (const name of Object.keys(ENV_LIMITS)) assert.ok(readme.includes('`' + name + '`'), name);
});
