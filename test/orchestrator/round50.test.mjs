/**
 * Круг 50 (SPEC §17.2): человек выключает арт-направление, самопроверку и шрифты из сети у своей
 * команды (`art` в теле). Выключить можно, включить выключенное у сервиса — нет; мусор — 400.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../server/orchestrator/http.js';
import { startDocument, startFakeLlm, startOrch, command, createProject, cid, PLAN_CREATE, TREE_OK } from './helpers.mjs';

const DIRECTION = {
  concept: 'Утренняя кофейня: крафт, эмаль, мел', materials: [{ name: 'крафт', hex: '#c9a77c' }],
  palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' },
  fonts: { display: 'Prata', text: 'Golos Text' },
};
const resultOf = (r) => { const e = r.events.find((x) => x.event === 'result'); return e && e.data; };
const base = { command_id: 'c1', project: 'p1', text: 'собери экран' };

test('круг 50: art в теле команды — только false; прочее — 400', () => {
  assert.deepEqual(parseCommand({ ...base }).art, {});
  assert.deepEqual(parseCommand({ ...base, art: { direction: false, critic: true, webFonts: false } }).art, { direction: false, webFonts: false });
  for (const art of [[], 'off', { direction: 'нет' }, { vision: false }, { render: false }]) {
    assert.throws(() => parseCommand({ ...base, art }), (e) => e && e.status === 400, JSON.stringify(art));
  }
});

test('круг 50: человек выключил образ и самопроверку — только план и дерево', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, direction: DIRECTION, tree: TREE_OK, critique: { score: 8, generic: false, verdict: 'ok', issues: [], fixes: [] } });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const res = resultOf(await command(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов', client: 'c1', art: { direction: false, critic: false } }));
  assert.ok(res && res.tx_id);
  assert.equal(res.direction, undefined);
  assert.deepEqual(llm.completions().map((c) => c.schema), ['plan', 'tree']);
});

test('круг 50: шрифты из сети выключены — арт-директор без меню шрифтов, решение — шрифтами документа', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, direction: DIRECTION, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, art: { critic: false } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const res = resultOf(await command(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов', client: 'c1', art: { webFonts: false } }));
  assert.ok(res && res.direction, JSON.stringify(res));
  assert.notEqual(res.direction.fonts.display, 'Prata', 'шрифт модели не взят');
  const dir = llm.completions().find((c) => c.schema === 'direction');
  const sys = dir.body.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
  assert.match(sys, /ШРИФТЫ ИЗ СЕТИ ВЫКЛЮЧЕНЫ/);
  assert.doesNotMatch(sys, /ПАРЫ ШРИФТОВ/, 'меню шрифтов не показано');
});
