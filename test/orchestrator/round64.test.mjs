/**
 * Круг 64 (SPEC §20, §22, §22.1): сквозной путь картинок через сервер — HTTP → воркер → модель.
 * Цвета картинок считает воркер по пикселям (resvg), арт-директор видит их строкой
 * «ЦВЕТА КАРТИНОК ДОКУМЕНТА»; модели со зрением уходит снимок всего мудборда настоящим
 * рисовальщиком сервера (не исходная картинка и не подставной снимок); без зрения — текст.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core.js';
import { moodboardOps } from '../../src/shell.js';
import { startDocument, startFakeLlm, startOrch, command, createProject, cid, journal, PLAN_CREATE } from './helpers.mjs';

const resvg = await import('@resvg/resvg-js').catch(() => null);

const DIRECTION = {
  concept: 'Утренняя кофейня', mood: ['тепло'], materials: [{ name: 'эспрессо', hex: '#3b2418' }],
  palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' },
  fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['штамп'], composition: 'асимметрия', avoid: ['синий'],
};
const TREE = { type: 'frame', name: 'Кофейня', children: [{ type: 'rect', name: 'Плашка', w: 200, h: 80, fill: '#3b2418' }] };
const CRIT_OK = { score: 8, generic: false, verdict: 'ok', issues: [], fixes: [] };
const SAID = 'собери экран кофейни в цветах этих картинок';
const resultOf = (r) => { const e = r.events.find((x) => x.event === 'result'); return e && e.data; };
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

/** Однотонный PNG — настоящие пиксели, чтобы цвета считались, а не подставлялись. */
function solid(hex, w = 40, h = 30) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${hex}"/></svg>`;
  return 'data:image/png;base64,' + Buffer.from(new resvg.Resvg(svg).render().asPng()).toString('base64');
}

function moodboardDoc(colors) {
  const base = quiet(() => core.createDoc('empty'));
  const images = colors.map((c, i) => ({ src: solid(c), width: 400, height: 300, fileName: `фото${i}.png` }));
  const r = moodboardOps(base, { images, at: { x: 0, y: 0 }, ids: { board: 'MB', images: images.map((_, i) => `m${i}`) } });
  return { doc: core.applyOps(base, r.ops).doc, images };
}

const systemOf = (body) => body.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
const lastUser = (body) => { const u = body.messages.filter((m) => m.role === 'user'); return u[u.length - 1].content; };

async function setup(t, { vision }) {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, direction: DIRECTION, tree: TREE, critique: CRIT_OK });
  // настоящий рисовальщик (render не выключен), без подставного снимка
  const orch = await startOrch({ document, llm: { baseUrl: llm.base, vision }, art: {} });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  return { document, llm, orch };
}

test('круг 64: мудборд через сервер — цвета пикселей и снимок всей доски модели со зрением', { skip: !resvg && 'нет resvg' }, async (t) => {
  const { document, llm, orch } = await setup(t, { vision: true });
  const { doc, images } = moodboardDoc(['#c0392b', '#2f6f62', '#f1c40f']);
  const p = await createProject(document, { name: 'Мудборд', doc });
  const res = resultOf(await command(orch.url, { command_id: cid('mb'), project: p.id, text: SAID, client: 'c1', selection: ['MB'], art: { webFonts: false } }));
  assert.ok(res && res.tx_id, JSON.stringify(res));

  const dir = llm.completions().find((c) => c.schema === 'direction');
  assert.ok(dir, 'арт-директор спрошен');
  const sys = systemOf(dir.body);
  assert.match(sys, /ЦВЕТА КАРТИНОК ДОКУМЕНТА/);
  // цвета посчитаны воркером по пикселям: все три однотонные заливки на месте
  for (const hex of ['#c0392b', '#2f6f62', '#f1c40f']) assert.ok(sys.toLowerCase().includes(hex), `цвет ${hex} в подсказке`);

  const parts = lastUser(dir.body);
  assert.ok(Array.isArray(parts), 'модели со зрением — части с картинкой');
  const img = parts.find((x) => x.type === 'image_url');
  assert.ok(img, JSON.stringify(parts).slice(0, 300));
  const url = img.image_url.url;
  assert.match(url, /^data:image\/png;base64,/);
  assert.ok(!images.some((m) => m.src === url), 'ушёл снимок доски, а не одна из картинок');
  const text = parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  assert.match(text, /снимком доски из 3 картинок/);

  // снимок — настоящий PNG ширины доски-мудборда, нарисованный resvg
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(png.readUInt32BE(16) > 100, 'ширина снимка — доска, а не значок');

  // новая доска собрана, образец не тронут
  const j = await journal(document, p.id);
  const ops = j.txs.flatMap((x) => x.ops);
  assert.ok(ops.length, JSON.stringify(j).slice(0, 300));
  const text2 = JSON.stringify(ops);
  assert.ok(text2.includes('Кофейня'), 'собран новый экран');
  assert.ok(ops.some((o) => o.op === 'create' && o.node && o.node.name === 'Кофейня' && !o.node.parent.startsWith('m')), 'доска — на странице');
  assert.ok(!ops.some((o) => o.op !== 'create' && ['MB', 'm0', 'm1', 'm2'].includes(o.id)), 'мудборд не тронут');
});

test('круг 64: модель без зрения — те же цвета строкой, картинок в запросе нет', { skip: !resvg && 'нет resvg' }, async (t) => {
  const { document, llm, orch } = await setup(t, { vision: false });
  const { doc } = moodboardDoc(['#c0392b', '#2f6f62']);
  const p = await createProject(document, { name: 'Мудборд', doc });
  const res = resultOf(await command(orch.url, { command_id: cid('mb'), project: p.id, text: SAID, client: 'c1', selection: ['MB'], art: { webFonts: false } }));
  assert.ok(res && res.tx_id, JSON.stringify(res));
  const dir = llm.completions().find((c) => c.schema === 'direction');
  const sys = systemOf(dir.body);
  assert.match(sys, /ЦВЕТА КАРТИНОК ДОКУМЕНТА/);
  for (const hex of ['#c0392b', '#2f6f62']) assert.ok(sys.toLowerCase().includes(hex), `цвет ${hex} в подсказке`);
  for (const c of llm.completions()) {
    assert.ok(!JSON.stringify(c.body.messages).includes('image_url'), `${c.schema}: без картинок`);
  }
});
