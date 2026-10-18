/**
 * Круг 32 — Orchestrator и brain:
 *   • `/agent/health` → `document_reason: 'schema'`, когда `/api/health` Document service отвечает
 *     503 с `detail.storage: 'schema'` (база догоняет схему после восстановления из копии); то же —
 *     `detail.document_reason` у `503 document_down` до потока, со своими словами;
 *   • brain: сводка замечаний знает код валидатора `bad-children`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startOrch, command, call, cid } from './helpers.mjs';
import { describeViolations } from '../../src/brain.js';
import { createDoc } from '../../src/core.js';
import { ENGINE_VERSION } from '../../src/core.js';

test('K2 (круг 32): /agent/health — document_reason schema, пока база сервиса догоняет схему', async (t) => {
  let state = 'schema';
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/health' && state === 'schema') {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' })
        .end(JSON.stringify({ error: true, code: 'unavailable', retryable: true, detail: { storage: 'schema', phase: 'migrate', since: new Date().toISOString() } }));
      return;
    }
    if (req.url === '/api/health' && state === 'down') {
      res.writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: true, code: 'unavailable', retryable: true, detail: { storage: 'down' } }));
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, engine: ENGINE_VERSION, storage: 'up' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const orch = await startOrch({ document: { port: fake.address().port } });
  t.after(async () => { await orch.close(); fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });

  let h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document, 'down');
  assert.equal(h.document_reason, 'schema');
  const c = await command(orch.url, { command_id: cid(), project: 'p_x', text: 'собери экран тарифов' });
  assert.equal(c.status, 503);
  assert.equal(c.body.code, 'document_down');
  assert.equal(c.body.detail.document_reason, 'schema');
  assert.match(c.body.message, /Сервер обновляет базу данных/);

  state = 'down';
  h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document_reason, 'storage');
  const d = await command(orch.url, { command_id: cid(), project: 'p_x', text: 'собери экран тарифов' });
  assert.match(d.body.message, /Сервис документов недоступен/);

  state = 'up';
  h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document, 'up');
  assert.equal('document_reason' in h, false);
});

test('brain (круг 32): сводка замечаний называет bad-children словами', () => {
  const doc = createDoc('empty');
  const list = Array.from({ length: 14 }, (_, i) => ({
    code: 'bad-children', nodeId: 'n' + i, severity: 'warn', message: `«Слой ${i}»: children не массив — поле не читается`,
  }));
  const text = describeViolations(list, doc);
  assert.match(text, /слои с негодным списком детей — всего 14/);
  assert.ok(!/bad-children/.test(text), text);
});
