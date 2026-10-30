/**
 * Круг 110 (SPEC §25): длинная задача через сервер агента — сценарий из многих экранов одной
 * транзакцией; ход «экран i из n» в событиях `stage` (progress, steps).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDocument, startFakeLlm, startOrch, command, createProject, cid, call } from './helpers.mjs';

const FLOW = {
  title: 'Регистрация', summary: 'Приветствие, телефон, код', device: 'mobile',
  screens: [
    { key: 'hello', name: 'Приветствие', purpose: 'Кнопка «Начать».' },
    { key: 'phone', name: 'Телефон', purpose: 'Поле номера и кнопка «Получить код».' },
    { key: 'code', name: 'Код из СМС', purpose: 'Четыре клетки кода.' },
  ],
  links: [
    { from: 'hello', to: 'phone', trigger: 'Нажал «Начать»' },
    { from: 'phone', to: 'code', trigger: 'Нажал «Получить код»' },
    { from: 'code', to: 'phone', trigger: 'Нажал «Изменить номер»' },
  ],
};
const lastUser = (body) => { const u = body.messages.filter((m) => m.role === 'user'); return String(u[u.length - 1].content); };
function screen(body) {
  const text = lastUser(body);
  const name = (/экраном «([^»]+)»/.exec(text) || [])[1] || 'Экран';
  const buttons = [...text.matchAll(/кнопка «([^»]+)»/g)].map((m) => m[1]);
  return {
    type: 'frame', name, layout: { mode: 'column', gap: 16, padding: 24 }, size: { w: 390, h: 844 }, fill: 'canvas',
    children: [
      { type: 'text', name: 'Заголовок', text: name, style: 'title', color: 'text' },
      ...buttons.map((b) => ({ type: 'frame', name: `Кнопка ${b}`, layout: { mode: 'row', padding: [12, 20] }, size: { w: 'fill', h: 'hug' }, fill: 'accent',
        children: [{ type: 'text', name: 'Надпись', text: b, style: 'body', color: 'onAccent' }] })),
    ],
  };
}

test('круг110: сервер — сценарий одной транзакцией, ход экранов в стадиях, стрелки в документе', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ flow: FLOW, tree: screen });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('flow'), project: p.id, text: 'сделай полный флоу регистрации', client: 'c1' });
  const res = (r.events.find((e) => e.event === 'result') || {}).data;
  assert.ok(res && res.tx_id, r.text.slice(0, 2000));
  assert.deepEqual(llm.completions().map((c) => c.schema), ['flow', 'tree', 'tree', 'tree']);
  const stages = r.events.filter((e) => e.event === 'stage').map((e) => e.data);
  const prog = stages.filter((s) => s.progress && s.progress.name).map((s) => s.progress);
  assert.deepEqual([...new Set(prog.map((x) => `${x.done}/${x.total} ${x.name}`))], ['0/3 Приветствие', '1/3 Телефон', '2/3 Код из СМС']);
  const plan = stages.find((s) => Array.isArray(s.steps));
  assert.deepEqual(plan.steps, ['Приветствие', 'Телефон', 'Код из СМС']);
  assert.ok(stages.some((s) => /^Экран 2\/3 · /.test(s.label)), 'стадии экрана — с префиксом');
  // одна транзакция агента: три доски с позициями и переходами
  const log = await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${p.id}/ops?since=0&limit=500`);
  const txs = log.body.txs.filter((x) => x && x.author === 'Агент');
  assert.equal(txs.length, 1);
  assert.match(txs[0].title || txs[0].summary || '', /Сценарий «Регистрация»: 3 экрана, 3 перехода/);
  const boards = txs[0].ops.filter((o) => o.op === 'create' && o.node && o.node.pos && Array.isArray(o.node.flow));
  assert.equal(boards.length, 3);
  const phone = boards.find((o) => o.node.name === 'Телефон');
  assert.equal(phone.node.flow.length, 1);
  assert.equal(phone.node.flow[0].label, 'Нажал «Получить код»');
  assert.ok(phone.node.flow[0].from, 'переход от кнопки');
});
