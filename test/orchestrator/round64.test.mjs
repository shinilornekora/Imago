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
// без текста нарочно: снимок критика с текстом пошёл бы за шрифтами в сеть (render.js, круг 60) —
// webFonts:false этого не отменяет, тест стал бы медленным и зависимым от сети
const TREE = { type: 'frame', name: 'Кофейня', children: [{ type: 'rect', name: 'Плашка', w: 200, h: 80, fill: '#3b2418' }] };
// цвета образца не совпадают ни с одним цветом ответа арт-директора — утечка ответа в подсказку видна
const COLORS = ['#c0392b', '#1f5fa8', '#f1c40f'];
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

/** Доля пикселей снимка, близких к цвету (снимок раскодирован тем же resvg). */
function shares(dataUrl, colors) {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="${dataUrl}" width="${w}" height="${h}"/></svg>`;
  const px = new resvg.Resvg(svg).render().pixels;
  const rgb = colors.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  const hits = colors.map(() => 0);
  for (let i = 0; i < px.length; i += 4) {
    rgb.forEach((c, k) => { if (Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]) < 24) hits[k]++; });
  }
  return { w, h, share: hits.map((n) => n / (w * h)) };
}

/** Все операции журнала: новое — только на странице или внутри нового, образца не касается ни одна. */
async function assertBoardKept(document, project, doc) {
  const j = await journal(document, project);
  const ops = j.txs.flatMap((x) => x.ops);
  const kept = new Set(['MB', ...doc.nodes.MB.children, ...doc.nodes.MB.children.flatMap((r) => doc.nodes[r].children || [])]);
  const made = new Set();
  const boards = [];
  for (const o of ops) {
    if (o.op === 'create') {
      assert.ok(o.node.parent === doc.root || made.has(o.node.parent), `создано вне страницы: ${o.node.name} → ${o.node.parent}`);
      if (o.node.parent === doc.root) boards.push(o.node.name);
      made.add(o.node.id);
    }
    const touched = JSON.stringify(o).match(/"(m\d|MB|r_[^"]*)"/g) || [];
    for (const t of touched) assert.ok(!kept.has(t.slice(1, -1)), `операция ${o.op} касается образца: ${t}`);
  }
  assert.deepEqual(boards, ['Кофейня'], 'собран один новый экран на странице');
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

async function run(t, { vision, colors = COLORS, selection = ['MB'] }) {
  const { document, llm, orch } = await setup(t, { vision });
  const { doc, images } = moodboardDoc(colors);
  const p = await createProject(document, { name: 'Мудборд', doc });
  const res = resultOf(await command(orch.url, { command_id: cid('mb'), project: p.id, text: SAID, client: 'c1', selection, art: { webFonts: false } }));
  assert.ok(res && res.tx_id, JSON.stringify(res));
  const dirs = llm.completions().filter((c) => c.schema === 'direction');
  assert.equal(dirs.length, 1, 'арт-директор спрошен один раз');
  // без зрения модель-критика не зовут (решают приметы, §14.3) — список вызовов целиком, чтобы
  // «картинок нет» не было правдой оттого, что звали меньше
  assert.deepEqual(llm.completions().map((c) => c.schema), vision ? ['plan', 'direction', 'tree', 'critique'] : ['plan', 'direction', 'tree']);
  return { document, llm, doc, images, p, dir: dirs[0] };
}

test('круг 64: мудборд через сервер — цвета пикселей и снимок всей доски модели со зрением', { skip: !resvg && 'нет resvg' }, async (t) => {
  const { document, doc, images, p, dir } = await run(t, { vision: true });
  const sys = systemOf(dir.body);
  assert.match(sys, /ЦВЕТА КАРТИНОК ДОКУМЕНТА/);
  // цвета посчитаны воркером по пикселям: все три однотонные заливки на месте
  for (const hex of COLORS) assert.ok(sys.toLowerCase().includes(hex), `цвет ${hex} в подсказке`);

  const parts = lastUser(dir.body);
  assert.ok(Array.isArray(parts), 'модели со зрением — части с картинкой');
  const imgs = parts.filter((x) => x.type === 'image_url');
  assert.equal(imgs.length, 1, JSON.stringify(parts).slice(0, 300));
  const url = imgs[0].image_url.url;
  assert.match(url, /^data:image\/png;base64,/);
  assert.ok(!images.some((m) => m.src === url), 'ушёл снимок доски, а не одна из картинок');
  assert.match(parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), /снимком доски из 3 картинок/);

  // на снимке — все три картинки (снимок одной картинки дал бы один цвет), пропорции — доски
  const shot = shares(url, COLORS);
  shot.share.forEach((v, k) => assert.ok(v > 0.05, `цвет ${COLORS[k]} на снимке: ${v.toFixed(3)}`));
  const rect = core.solve(doc).rects.MB;
  assert.ok(Math.abs(shot.w / shot.h - rect.w / rect.h) < 0.05, `пропорции снимка ${shot.w}×${shot.h} — доски ${rect.w}×${rect.h}`);

  await assertBoardKept(document, p.id, doc);
});

test('круг 64: выделена часть мудборда — снимка доски нет, одна картинка «одна из 2»', { skip: !resvg && 'нет resvg' }, async (t) => {
  const { images, dir } = await run(t, { vision: true, selection: ['m0', 'm1'] });
  const parts = lastUser(dir.body);
  const imgs = parts.filter((x) => x.type === 'image_url');
  assert.equal(imgs.length, 1);
  assert.ok(images.slice(0, 2).some((m) => m.src === imgs[0].image_url.url), 'ушла одна из выделенных картинок как есть');
  const text = parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  assert.match(text, /одна из 2 картинок/);
  assert.doesNotMatch(text, /снимком доски/);
});

test('круг 64: модель без зрения — те же цвета строкой, картинок в запросах нет', { skip: !resvg && 'нет resvg' }, async (t) => {
  const { document, llm, doc, p, dir } = await run(t, { vision: false, colors: COLORS.slice(0, 2) });
  const sys = systemOf(dir.body);
  assert.match(sys, /ЦВЕТА КАРТИНОК ДОКУМЕНТА/);
  for (const hex of COLORS.slice(0, 2)) assert.ok(sys.toLowerCase().includes(hex), `цвет ${hex} в подсказке`);
  assert.equal(typeof lastUser(dir.body), 'string');
  for (const c of llm.completions()) {
    assert.ok(!JSON.stringify(c.body.messages).includes('image_url'), `${c.schema}: без картинок`);
  }
  await assertBoardKept(document, p.id, doc);
});
