/**
 * Круг 60 (SPEC §22.1): образец — мудборд (§21.6), модель со зрением: арт-директору показывается снимок
 * всей доски тем же рисовальщиком, что у критика. Нет снимка (нет рисовальщика, не успел, обрезан,
 * с плашками, ошибка) — одна картинка с пометкой «одна из N», как в круге 59.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand } from '../src/brain.js';
import { moodboardOps } from '../src/shell.js';
import { createRenderer } from '../server/orchestrator/render.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const PLAN = { intent: 'create', title: 'Экран', summary: 'Соберу экран', steps: ['Шапка'] };
const DIRECTION = { concept: 'Зал', mood: ['тепло'], materials: [{ name: 'дерево', hex: '#3b2418' }], palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' }, fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['x'], composition: 'x', avoid: ['x'] };
const TREE = { type: 'frame', name: 'Кофейня', children: [{ type: 'text', name: 'Заголовок', text: 'Утро', style: 'display' }] };
const SAID = 'собери экран кофейни в цветах этих картинок';

function moodboard(n = 3) {
  const base = quiet(() => core.createDoc('empty'));
  const images = Array.from({ length: n }, (_, i) => ({ src: `data:image/png;base64,${DATA}${'AAAA'.repeat(i)}`, width: 400, height: 300, fileName: `фото${i}.png` }));
  const r = moodboardOps(base, { images, at: { x: 0, y: 0 }, ids: { board: 'MB', images: images.map((_, i) => `m${i}`) } });
  return { doc: core.applyOps(base, r.ops).doc, selection: r.select };
}
function fake() {
  const calls = [];
  return { name: 'fake', calls, vision: true, async ready() { return true; },
    async complete(messages, schema) {
      calls.push({ schema: schema.name, messages });
      const v = { plan: PLAN, direction: DIRECTION, tree: TREE }[schema.name];
      if (!v) throw new Error('нет ответа ' + schema.name);
      return JSON.parse(JSON.stringify(v));
    } };
}
const directTurn = (p) => p.calls.find((c) => c.schema === 'direction').messages.find((m) => m.role === 'user').content;

test('круг60: мудборд — модели со зрением снимок всей доски', async () => {
  const { doc, selection } = moodboard(3);
  const p = fake();
  const asked = [];
  const stages = [];
  const render = async ({ artboardId }) => { asked.push(artboardId); return { mime: 'image/png', data: 'U05BUFNIT1Q=' }; };
  const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false, render, onStage: (s) => stages.push(s) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(asked, ['MB'], 'снимают доску-образец');
  const turn = directTurn(p);
  assert.ok(Array.isArray(turn));
  assert.deepEqual(turn[1], { type: 'image', mime: 'image/png', data: 'U05BUFNIT1Q=' });
  assert.match(turn[0].text, /снимком доски из 3 картинок/);
  assert.ok(stages.some((s) => /Смотрю на мудборд/.test(s.detail || s.label || '')));
});

test('круг60: снимка нет — одна картинка «одна из N»; ошибка рисовальщика — с заметкой', async () => {
  const cases = [
    [null, false],
    [async () => null, false],
    [async () => ({ mime: 'image/png', data: 'eA==', cropped: true }), false],
    [async () => ({ mime: 'image/png', data: 'eA==', placeholders: 2 }), false],
    [async () => ({ mime: 'image/png', data: 'A'.repeat(1200 * 1024) }), false],
    [async () => { throw new Error('холст сломался'); }, true],
  ];
  for (const [render, noted] of cases) {
    const { doc, selection } = moodboard(2);
    const p = fake();
    const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false, render });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const turn = directTurn(p);
    assert.ok(Array.isArray(turn));
    assert.match(turn[0].text, /одна из 2 картинок образца/);
    assert.equal(turn[1].data.startsWith(DATA), true, 'сама картинка, а не снимок');
    const notes = res.serviceNotes || [];
    assert.equal(notes.some((n) => /Снимок образца не получился/.test(n)), noted, notes.join(' | '));
  }
});

test('круг60: одна картинка-образец — снимок не нужен, рисовальщика не зовут', async () => {
  const { doc, selection } = moodboard(1);
  const p = fake();
  let asked = 0;
  await runCommand({ doc, selection, utterance: 'собери экран в цветах этой картинки', provider: p, engine: core, critic: false, render: async () => { asked++; return null; } });
  assert.equal(asked, 0);
  const turn = directTurn(p);
  assert.ok(Array.isArray(turn) && !/одна из/.test(turn[0].text));
});

test('круг60: сервер рисует мудборд встроенными картинками, без плашек и без сети', async () => {
  let mod = null;
  try { mod = await import('@resvg/resvg-js'); } catch { mod = null; }
  if (!mod) return;   // необязательная зависимость не стоит
  const { doc } = moodboard(3);
  const r = createRenderer({ fetch: async () => { throw new Error('нет сети'); }, log: { warn() {} } });
  const shot = await r({ doc, artboardId: 'MB' });
  assert.ok(shot && shot.mime === 'image/png' && shot.data.length > 0, 'снимок есть');
  assert.ok(!shot.placeholders && !shot.cropped);
});
