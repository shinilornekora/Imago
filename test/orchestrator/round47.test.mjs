/**
 * Круг 47 (SPEC §14) — Orchestrator:
 *   • арт-направление и критик идут в воркере: решение и вердикт — в событии `result`, стадии —
 *     прежними ключами (`llm`, `validate`, `repair`);
 *   • снимок доски уходит модели картинкой (image_url) через посредника воркера;
 *   • модель отвергла запрос со снимком — дальше без картинок (и в следующих командах);
 *   • AGENT_DIRECTION/AGENT_CRITIC = 0 — ни арт-директора, ни критика;
 *   • рендер PNG: без resvg и без шрифтов при тексте — null, доска без текста — PNG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core.js';
import { SCHEMAS } from '../../src/brain.js';
import { createRenderer } from '../../server/orchestrator/render.js';
import {
  startDocument, startFakeLlm, startOrch, command, createProject, cid, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

const DIRECTION = SCHEMAS.direction.example;
const CRIT_OK = { score: 8, generic: false, verdict: 'ok', issues: [], fixes: [], praise: 'Палитра держится' };
const CRIT_BAD = { score: 4, generic: true, verdict: 'revise', issues: ['Всё по центру'], fixes: ['Заголовок влево, крупнее'] };
const SHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const resultOf = (r) => { const e = r.events.find((x) => x.event === 'result'); return e && e.data; };
const userParts = (body) => {
  const u = body.messages.filter((m) => m.role === 'user');
  return u[u.length - 1].content;
};

test('круг 47: образ и вердикт — в result; стадии прежними ключами; снимок — картинкой модели', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, direction: DIRECTION, tree: [TREE_OK, TREE_OK], critique: CRIT_BAD });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base, vision: true }, art: { fakeShot: SHOT } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов', client: 'c1' });
  const res = resultOf(r);
  assert.ok(res, r.text);
  assert.equal(res.direction.concept, DIRECTION.concept);
  assert.deepEqual(res.direction.fonts, { display: 'Prata', text: 'Golos Text' });
  assert.equal(res.critique.score, 4);
  assert.equal(res.critique.seen, 'image');
  assert.equal(res.critique.revised, true, 'доработка легла');
  const names = llm.completions().map((c) => c.schema);
  assert.deepEqual(names, ['plan', 'direction', 'tree', 'critique', 'tree']);
  const crit = llm.completions().find((c) => c.schema === 'critique');
  const parts = userParts(crit.body);
  assert.ok(Array.isArray(parts), 'реплика критика — частями');
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${SHOT}` } });
  const keys = new Set(r.events.filter((e) => e.event === 'stage').map((e) => e.data.key));
  for (const k of keys) assert.ok(['intent', 'read', 'library', 'llm', 'validate', 'repair', 'write'].includes(k), k);
  assert.ok(r.events.some((e) => e.event === 'stage' && /Ищу образ/.test(e.data.label || '')), 'стадия образа видна');
});

test('круг 47: зрение не заявлено (LLM_VISION пусто) — снимок не шлётся; заявлено и модель отвергла — по приметам', async (t) => {
  const document = await startDocument();
  let withImage = 0;
  const llm = await startFakeLlm({
    plan: PLAN_CREATE, direction: DIRECTION, tree: TREE_OK,
    critique: (body) => {
      if (Array.isArray(userParts(body))) { withImage++; return undefined; }   // 400 — «не умею картинки»
      return CRIT_OK;
    },
  });
  const warns = [];
  const plain = await startOrch({ document, llm: { baseUrl: llm.base }, art: { fakeShot: SHOT } });
  const seeing = await startOrch({ document, llm: { baseUrl: llm.base, vision: true }, art: { fakeShot: SHOT }, log: { info() {}, warn: (m) => warns.push(String(m)) } });
  t.after(async () => { await plain.close(); await seeing.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r1 = resultOf(await command(plain.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов', client: 'c1' }));
  assert.equal(r1.critique.seen, 'signals');
  assert.equal(withImage, 0, 'модели без заявленного зрения картинку не шлём');
  const r2 = resultOf(await command(seeing.url, { command_id: cid('b'), project: p.id, text: 'собери экран тарифов', client: 'c1' }));
  assert.equal(withImage, 1);
  assert.equal(r2.critique.seen, 'signals', 'отказ — самопроверка по приметам');
  assert.ok(warns.some((w) => /отвергла запрос со снимком доски/.test(w)), 'администратору — одна строка в лог');
});

test('круг 47: арт-направление и критик выключены — только план и дерево', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, art: { direction: false, critic: false } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const res = resultOf(await command(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов', client: 'c1' }));
  assert.ok(res && res.tx_id);
  assert.equal(res.direction, undefined);
  assert.equal(res.critique, undefined);
  assert.deepEqual(llm.completions().map((c) => c.schema), ['plan', 'tree']);
});

/* ── рендер PNG ────────────────────────────────────────────────────────── */

function boardDoc(withText) {
  const doc = core.createDoc();
  const base = doc.nodes[doc.root];
  let cur = core.applyOps({ ...doc, nodes: { [doc.root]: { ...base, children: [] } } }, [
    core.ops.create({ id: 'b1', type: 'frame', name: 'Доска', parent: doc.root, pos: { x: 0, y: 0 },
      size: { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 120 } }, fill: '#f4ead8',
      layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false }, children: [] }),
    core.ops.create({ id: 'r1', type: 'rect', name: 'Плашка', parent: 'b1', size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 40 } }, fill: '#2f6f62' }),
  ]).doc;
  if (withText) {
    cur = core.applyOps(cur, [core.ops.create({ id: 't1', type: 'text', name: 'Т', parent: 'b1', characters: 'Утро 🍪', style: { token: 'body', font: 'Prata' },
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, align: 'left' })]).doc;
  }
  return cur;
}

test('круг 47: рендер — без resvg null; текст без шрифтов null; доска без текста — PNG', async () => {
  const doc = boardDoc(false);
  assert.equal(await createRenderer({ resvg: null })({ doc, artboardId: 'b1' }), null);
  let mod = null;
  try { mod = await import('@resvg/resvg-js'); } catch { mod = null; }
  if (!mod) return;   // необязательная зависимость не стоит — дальше проверять нечего
  const offline = async () => { throw new Error('нет сети'); };
  const warns = [];
  const r = createRenderer({ fetch: offline, log: { warn: (m) => warns.push(m) } });
  assert.equal(await r({ doc: boardDoc(true), artboardId: 'b1' }), null, 'текст нечем нарисовать — пусть критик смотрит выжимку');
  assert.equal(warns.length, 1, 'одно предупреждение, а не на каждый шрифт');
  // неудача помнится: вторая команда в сеть не идёт и срок не ждёт
  let asked2 = 0;
  const r3 = createRenderer({ fetch: async () => { asked2++; throw new Error('нет сети'); }, log: { warn() {} } });
  await r3({ doc: boardDoc(true), artboardId: 'b1' });
  const once = asked2;
  await r3({ doc: boardDoc(true), artboardId: 'b1' });
  assert.equal(asked2, once);
  // общий срок: зависшая сеть не держит снимок дольше deadlineMs
  const hang = createRenderer({ fetch: () => new Promise(() => {}), deadlineMs: 50, log: { warn() {} } });
  const t0 = Date.now();
  assert.equal(await hang({ doc: boardDoc(true), artboardId: 'b1' }), null);
  assert.ok(Date.now() - t0 < 1000);
  // эмодзи убираются, а ©, ™ и стрелки — нет
  const { EMOJI_RE } = await import('../../server/orchestrator/render.js');
  assert.equal('15 🍪 © ™ → ☀'.replace(EMOJI_RE, ''), '15  © ™ → ☀');
  const png = await r({ doc, artboardId: 'b1', geo: core.solve(doc) });
  assert.ok(png, 'доска без текста рисуется и без шрифтов');
  assert.equal(png.mime, 'image/png');
  assert.equal(png.width, 200);
  assert.equal(png.height, 120);
  assert.equal(png.approxText, true, 'критику сказано: переносы строк на сервере приблизительные');
  assert.equal(Buffer.from(png.data, 'base64').subarray(1, 4).toString(), 'PNG');
  // ходит только за семействами набора и только к Google Fonts
  const asked = [];
  const r2 = createRenderer({ fetch: async (u) => { asked.push(String(u)); throw new Error('нет'); } });
  const odd = core.applyOps(boardDoc(true), [core.ops.set('t1', 'style', { token: 'body', font: 'Evil Font' })]).doc;
  await r2({ doc: odd, artboardId: 'b1' });
  assert.ok(asked.length && asked.every((u) => u.startsWith('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans')), asked.join(' '));
});
