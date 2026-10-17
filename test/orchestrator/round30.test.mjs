/**
 * Круг 30, Orchestrator: транзакция агента несёт имя автора команды (`command_author`) —
 * «Агент · Аня» в «Истории» у любого браузера, а не только у видевшего Аню в сети.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDocument, startFakeLlm, startOrch, command, createProject, journal, call, cid, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

test('command_author: команда и выбранный вариант пишутся с именем автора; без имени — без поля', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', client: 'c_ann', author: '  Аня  ' });
  const result = r.events.find((e) => e.event === 'result');
  assert.ok(result, JSON.stringify(r.events.map((e) => e.event)));
  let j = await journal(document, p.id);
  assert.equal(j.txs[0].author, 'Агент');
  assert.equal(j.txs[0].author_kind, 'agent');
  assert.equal(j.txs[0].command_author, 'Аня', 'имя автора команды — в записи, без пробелов по краям');

  // история отдаёт имя (J2 + круг 30)
  const h = await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${p.id}/history`);
  assert.equal(h.body.items[0].command_author, 'Аня');

  // варианты: автор запоминается с набором и пишется при /agent/apply
  const id = cid('v');
  const v = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', mode: 'variants', n: 2, author: 'Борис' });
  const items = v.events.find((e) => e.event === 'variants').data.items;
  const a = await call(orch.url, 'POST', '/agent/apply', { command_id: id, variant: items[0].key });
  assert.equal(a.status, 200, a.text);
  j = await journal(document, p.id);
  assert.equal(j.txs[1].command_author, 'Борис');

  // без имени — поля нет вовсе
  await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  j = await journal(document, p.id);
  assert.equal(j.txs.length, 3);
  assert.equal('command_author' in j.txs[2], false);
});
