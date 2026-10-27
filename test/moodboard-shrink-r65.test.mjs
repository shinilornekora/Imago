/**
 * Круг 65 (SPEC §22.2): снимок мудборда больше предела образца — вторая попытка уже (вес — как квадрат
 * ширины, с запасом), не уже MOODBOARD_SHOT_MIN_W; не влез и так — одна картинка «одна из N», как в
 * круге 60. Сервер рисует снимок шириной maxWidth (не шире снимка критика), браузер — JPEG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, REF_IMAGE_MAX_CHARS, MOODBOARD_SHOT_MIN_W } from '../src/brain.js';
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
  return { doc: core.applyOps(base, r.ops).doc, selection: r.select, images };
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
const big = (w) => ({ mime: 'image/png', data: 'A'.repeat(REF_IMAGE_MAX_CHARS + 4 * 1024), width: w, height: w });

test('круг65: снимок больше предела — второй уже, и модель видит доску', async () => {
  const { doc, selection } = moodboard(3);
  const p = fake();
  const asked = [];
  const notes = [];
  const render = async ({ artboardId, maxWidth }) => {
    asked.push({ artboardId, maxWidth });
    return maxWidth ? { mime: 'image/jpeg', data: 'U01BTEw=', width: maxWidth, height: maxWidth } : big(516);
  };
  const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false, render, onServiceNote: (m) => notes.push(m) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(asked.length, 2);
  assert.equal(asked[0].maxWidth, undefined, 'первая попытка — обычной ширины');
  assert.equal(asked[1].artboardId, 'MB');
  assert.ok(asked[1].maxWidth >= MOODBOARD_SHOT_MIN_W && asked[1].maxWidth < 516 * 0.9, `ширина второй попытки ${asked[1].maxWidth}`);
  const turn = directTurn(p);
  assert.deepEqual(turn[1], { type: 'image', mime: 'image/jpeg', data: 'U01BTEw=' });
  assert.match(turn[0].text, /снимком доски из 3 картинок/);
  assert.ok(!(res.serviceNotes || []).some((m) => /слишком большой/.test(m)), 'заметки о размере нет');
});

test('круг65: и второй не влез, узкий не уменьшается, второй негоден — одна картинка с заметкой', async () => {
  const cases = [
    // [что рисует, сколько попыток]
    [async ({ maxWidth }) => big(maxWidth || 700), 2],
    [async () => big(MOODBOARD_SHOT_MIN_W), 1],
    [async () => ({ mime: 'image/png', data: 'A'.repeat(REF_IMAGE_MAX_CHARS + 10) }), 1],   // ширина не сказана
    [async ({ maxWidth }) => (maxWidth ? { mime: 'image/png', data: 'eA==', width: maxWidth, cropped: true } : big(700)), 2],
  ];
  for (const [draw, tries] of cases) {
    const { doc, selection, images } = moodboard(2);
    const p = fake();
    let n = 0;
    const render = async (a) => { n++; return draw(a); };
    const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false, render });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.equal(n, tries, String(draw));
    const turn = directTurn(p);
    assert.match(turn[0].text, /одна из 2 картинок/);
    assert.ok(images.some((m) => m.src === `data:${turn[1].mime};base64,${turn[1].data}`), 'ушла картинка образца');
    assert.ok((res.serviceNotes || []).some((m) => /Снимок образца слишком большой/.test(m)), String(draw));
  }
});

const resvg = await import('@resvg/resvg-js').catch(() => null);
/** «Фотография»: пёстрая сетка (сжимается плохо, как фото), чтобы вес снимка зависел от ширины. */
function photo(seed) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const cells = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 30; j++) {
    cells.push(`<rect x="${i * 10}" y="${j * 10}" width="10" height="10" fill="rgb(${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)})"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">${cells.join('')}</svg>`;
  return 'data:image/png;base64,' + Buffer.from(new resvg.Resvg(svg).render().asPng()).toString('base64');
}

test('круг65: сервер рисует снимок шириной maxWidth, но не шире снимка критика', { skip: !resvg && 'нет resvg' }, async () => {
  const base = quiet(() => core.createDoc('empty'));
  const images = [1, 2, 3].map((k) => ({ src: photo(k), width: 400, height: 300, fileName: `фото${k}.png` }));
  const mb = moodboardOps(base, { images, at: { x: 0, y: 0 }, ids: { board: 'MB', images: ['m0', 'm1', 'm2'] } });
  const doc = core.applyOps(base, mb.ops).doc;
  const r = createRenderer({ fetch: async () => { throw new Error('нет сети'); }, log: { warn() {} } });
  const full = await r({ doc, artboardId: 'MB' });
  assert.ok(full && full.width > 300, JSON.stringify(full && full.width));
  const small = await r({ doc, artboardId: 'MB', maxWidth: 300 });
  const wide = await r({ doc, artboardId: 'MB', maxWidth: 5000 });
  assert.equal(small.width, 300);
  // размер самого PNG — тот, что сказан (пустой список гарнитур у resvg сбрасывал fitTo — круг 65)
  const dims = (x) => { const b = Buffer.from(x.data, 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(dims(small), [small.width, small.height]);
  assert.deepEqual(dims(full), [full.width, full.height]);
  assert.ok(Math.abs(small.height / small.width - full.height / full.width) < 0.02, 'пропорции те же');
  assert.equal(wide.width, full.width, 'шире обычного не бывает');
  assert.ok(small.data.length < full.data.length * 0.6, `вес ${small.data.length} против ${full.data.length}`);
});
