/**
 * DSLTS-клиент Orchestrator (SPEC §9.8, §10.6): запись транзакции агента и ответы
 * Document service — 503 с Retry-After (ждём срок, повтор с тем же tx_id, ограниченно),
 * 413 (в том числе «больше 5000 операций» — до сети, без частичной записи), 426.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDocClient, parseRetryAfter } from '../../server/orchestrator/docclient.js';
import { createDsltsClient, checkTx } from '../../server/orchestrator/dslts/index.js';
import { DOC_MAX_OPS_PER_TX } from '../../server/orchestrator/limits.js';
import { ENGINE_VERSION, uid } from '../../src/core.js';
import { quiet } from './helpers.mjs';

/** Сервис-заглушка: ответы на POST …/tx по очереди из script (последний повторяется). */
async function fakeDoc(script) {
  const posts = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    posts.push({ at: Date.now(), body });
    const step = script.length > 1 ? script.shift() : script[0];
    const { status, headers = {}, json } = typeof step === 'function' ? step(body) : step;
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    posts,
    net: createDocClient({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const tx = (n = 1) => ({
  tx_id: uid('tx'), base_seq: 0, author: 'Агент', author_kind: 'agent', engine: ENGINE_VERSION,
  ops: Array.from({ length: n }, (_, i) => ({ op: 'set', id: 'n1', path: 'name', value: `v${i}` })),
});
const committed = (body) => ({ status: 201, json: { ...body, seq: 1, dropped: [], created_at: new Date().toISOString() } });

test('Retry-After: секунды, HTTP-дата, поле retry_after тела', () => {
  assert.equal(parseRetryAfter('3'), 3);
  assert.equal(parseRetryAfter(null, { retry_after: 2 }), 2);
  const at = parseRetryAfter(new Date(Date.now() + 4000).toUTCString());
  assert.ok(at >= 3 && at <= 5, String(at));
  assert.equal(parseRetryAfter('чушь'), null);
});

test('503 с Retry-After: ждёт указанный срок и повторяет с тем же tx_id', async (t) => {
  const svc = await fakeDoc([
    { status: 503, headers: { 'Retry-After': '1' }, json: { error: true, code: 'busy', message: 'очередь полна', retryable: true, retry_after: 1 } },
    committed,
  ]);
  t.after(() => svc.close());
  const dslts = createDsltsClient({ doc: svc.net, log: quiet, backoffMs: 10 });
  const one = tx();
  const out = await dslts.commit('p1', one);
  assert.equal(out.seq, 1);
  assert.equal(svc.posts.length, 2);
  assert.deepEqual(svc.posts.map((p) => p.body.tx_id), [one.tx_id, one.tx_id], 'повтор — тот же tx_id');
  const gap = svc.posts[1].at - svc.posts[0].at;
  assert.ok(gap >= 900, `повтор раньше Retry-After: ${gap} мс`);
  assert.equal(dslts.stats.retries, 1);
});

test('503 без конца: ожидание ограничено (потолок срока и бюджет), потом document_down с Retry-After', async (t) => {
  const svc = await fakeDoc([{ status: 503, headers: { 'Retry-After': '3600' }, json: { error: true, code: 'unavailable', message: 'база недоступна', retryable: true } }]);
  t.after(() => svc.close());
  const dslts = createDsltsClient({ doc: svc.net, log: quiet, retryAfterMaxS: 1, waitBudgetMs: 1500 });
  const t0 = Date.now();
  await assert.rejects(dslts.commit('p1', tx()), (e) => {
    assert.equal(e.code, 'document_down');
    assert.equal(e.status, 503);
    assert.equal(e.retryable, true);
    assert.ok(e.retryAfter >= 1, 'Retry-After доходит до ответа агента');
    assert.ok(!/3600|база недоступна/.test(e.message), 'внутренности сервиса человеку не нужны');
    return true;
  });
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `ждали слишком долго: ${ms}`);
  assert.equal(svc.posts.length, 3, 'попыток — ограниченно');
  assert.equal(new Set(svc.posts.map((p) => p.body.tx_id)).size, 1);
});

test('больше 5000 операций — too_large до сети, ничего не записано и не порезано', async (t) => {
  const svc = await fakeDoc([committed]);
  t.after(() => svc.close());
  const dslts = createDsltsClient({ doc: svc.net, log: quiet });
  await assert.rejects(dslts.commit('p1', tx(DOC_MAX_OPS_PER_TX + 1)), (e) => {
    assert.equal(e.code, 'too_large');
    assert.equal(e.status, 413);
    assert.equal(e.retryable, false);
    assert.match(e.message, /5001 операция при пределе 5000/);
    assert.match(e.message, /Ничего не записано/);
    assert.equal(e.detail.limit, 'ops_per_tx');
    return true;
  });
  // тело больше 4 МБ — тоже до сети
  const fat = tx(1);
  fat.ops[0].value = 'ы'.repeat(2.2 * 1024 * 1024);
  await assert.rejects(dslts.commit('p1', fat), (e) => e.code === 'too_large' && e.detail.limit === 'body_bytes' && /КБ при пределе/.test(e.message));
  assert.equal(svc.posts.length, 0, 'в сервис ничего не ушло');
  assert.equal(checkTx(tx(DOC_MAX_OPS_PER_TX)), null, 'ровно предел — можно');
});

test('413 от сервиса — too_large без повтора; 426 — engine без повтора', async (t) => {
  const big = await fakeDoc([{ status: 413, json: { error: true, code: 'too_large', message: 'тело больше 4194304 байт', retryable: false, detail: { limit: 'body_bytes', max: 4194304 } } }]);
  const old = await fakeDoc([{ status: 426, json: { error: true, code: 'engine', message: 'версия движка', retryable: false, engine: ENGINE_VERSION + 1 } }]);
  t.after(async () => { await big.close(); await old.close(); });
  await assert.rejects(createDsltsClient({ doc: big.net, log: quiet }).commit('p1', tx()), (e) => {
    assert.equal(e.code, 'too_large');
    assert.equal(e.retryable, false);
    assert.match(e.message, /Правка слишком большая/);
    return true;
  });
  assert.equal(big.posts.length, 1);
  await assert.rejects(createDsltsClient({ doc: old.net, log: quiet }).commit('p1', tx()), (e) => {
    assert.equal(e.code, 'engine');
    assert.equal(e.status, 426);
    assert.equal(e.retryable, false);
    assert.equal(e.detail.engine, ENGINE_VERSION + 1);
    return true;
  });
  assert.equal(old.posts.length, 1);
});
