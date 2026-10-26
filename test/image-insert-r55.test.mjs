/**
 * Круг 55 (SPEC §21): картинка в макет — вставкой из буфера и перетаскиванием файла. Куда ложится
 * (imageInsertOps), картинка как образец в словах команды (RE_IMAGE_REF): «собери экран в цветах этой
 * картинки» при выделенной картинке — новая доска, арт-директор видит её цвета, рисовать её не зовут,
 * мегабайты картинки в промпт не уходят. И дымовой прогон в настоящем браузере.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { runCommand, RE_IMAGE_REF, withoutImageRef, looksIllustration, classifyUtterance } from '../src/brain.js';
import { imageInsertOps, IMAGE_INSERT } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const SRC = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50000);
const ids = { board: 'B', image: 'I' };

test('круг55: куда ложится картинка — в выделенную рамку, рядом с выделенным слоем, иначе новой доской', () => {
  const doc = quiet(() => core.createDoc());
  const board = core.artboards(doc)[0];
  const into = imageInsertOps(doc, { selection: [board.id], src: SRC, width: 1200, height: 600, fileName: 'зал кофейни.jpg', at: { x: 5, y: 7 }, ids });
  assert.equal(into.into, board.id);
  assert.equal(into.ops.length, 1);
  assert.deepEqual(into.ops[0].node.size, { w: { mode: 'fixed', value: IMAGE_INSERT.maxW }, h: { mode: 'fixed', value: 240 } }, 'ширина до предела, высота по пропорции');
  assert.equal(into.ops[0].node.name, 'зал кофейни');
  assert.equal(core.applyOps(doc, into.ops).error, undefined);
  // выделен слой внутри — картинка сразу за ним в его рамке
  const leaf = board.children.find((id) => doc.nodes[id].type !== 'frame') || board.children[0];
  const next = imageInsertOps(doc, { selection: [leaf], src: SRC, width: 100, height: 50, at: { x: 0, y: 0 }, ids });
  if (doc.nodes[leaf].type !== 'frame') {
    assert.equal(next.into, board.id);
    assert.equal(next.ops[0].index, board.children.indexOf(leaf) + 1);
    assert.deepEqual(next.ops[0].node.size.w, { mode: 'fixed', value: 100 }, 'мелкая — своего размера');
  }
  // ничего не выделено — новая доска по размеру картинки на месте броска
  const fresh = imageInsertOps(doc, { selection: [], src: SRC, width: 300, height: 300, at: { x: 5.4, y: 7.6 }, ids, boards: 2 });
  assert.equal(fresh.into, null);
  assert.equal(fresh.ops[0].node.parent, doc.root);
  assert.deepEqual(fresh.ops[0].node.pos, { x: 5, y: 8 });
  assert.equal(fresh.ops[0].node.name, 'Картинка 3');
  assert.deepEqual(fresh.select, ['I']);
  const applied = core.applyOps(doc, fresh.ops);
  assert.equal(applied.error, undefined, JSON.stringify(applied.error));
  assert.equal(core.checkImportDoc(applied.doc), null);
  // не картинка, нет размера, нет документа
  assert.match(imageInsertOps(doc, { src: 'data:text/html;base64,AA', width: 1, height: 1, at: { x: 0, y: 0 }, ids }).error, /не картинка/);
  assert.match(imageInsertOps(doc, { src: SRC, width: 0, height: 1, at: { x: 0, y: 0 }, ids }).error, /размера/);
  assert.ok(imageInsertOps(null, { src: SRC }).error);
  // имя файла очищено
  assert.equal(imageInsertOps(doc, { src: SRC, width: 1, height: 1, fileName: 'a b\u0000.png', at: { x: 0, y: 0 }, ids }).ops[1].node.name, 'a b');
});

test('круг55: ширина по рамке, узкая рамка — картинка за ней, рамка без потока — в точку броска, скрытая — мимо', () => {
  const doc = quiet(() => core.createDoc());
  const board = core.artboards(doc)[0];
  const LAY = { mode: 'row', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false };
  let d = core.applyOps(doc, [
    core.ops.create({ id: 'card', type: 'frame', parent: board.id, size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }, layout: LAY, children: [] }),
    core.ops.create({ id: 'chip', type: 'frame', parent: board.id, size: { w: { mode: 'fixed', value: 80 }, h: { mode: 'hug' } }, layout: LAY, children: [] }),
    core.ops.create({ id: 'free', type: 'frame', parent: board.id, size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 300 } }, children: [] }),
    core.ops.create({ id: 'ghost', type: 'frame', parent: board.id, visible: false, size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }, layout: LAY, children: [] }),
  ]);
  assert.equal(d.error, undefined, JSON.stringify(d.error));
  d = d.doc;
  const widths = { card: 280, chip: 80, free: 300, ghost: 300 };
  const base = { src: SRC, width: 1200, height: 600, at: { x: 150, y: 260 }, ids, innerWidth: (id) => widths[id] || null, origin: (id) => (id === 'free' ? { x: 100, y: 200 } : null) };
  const card = imageInsertOps(d, { ...base, selection: ['card'] });
  assert.equal(card.into, 'card');
  assert.deepEqual(card.ops[0].node.size, { w: { mode: 'fixed', value: 280 }, h: { mode: 'fixed', value: 140 } }, 'не шире рамки');
  const chip = imageInsertOps(d, { ...base, selection: ['chip'] });
  assert.equal(chip.into, board.id, 'в узкую рамку не кладём — за ней');
  assert.equal(chip.ops[0].index, d.nodes[board.id].children.indexOf('chip') + 1);
  const free = imageInsertOps(d, { ...base, selection: ['free'] });
  assert.deepEqual(free.ops[0].node.pos, { x: 50, y: 60 }, 'рамка без потока — в точку броска');
  const ghost = imageInsertOps(d, { ...base, selection: ['ghost'] });
  assert.notEqual(ghost.into, 'ghost', 'в скрытую рамку не кладём');
  for (const r of [card, chip, free, ghost]) assert.equal(core.applyOps(d, r.ops).error, undefined);
});

test('круг55: картинка-образец в словах — не предмет рисования', () => {
  for (const s of ['собери экран в цветах этой картинки', 'сделай лендинг в стиле фото', 'экран как на картинке', 'по референсу собери онбординг',
    'в палитре вставленной картинки собери экран', 'карточка в духе этого снимка']) {
    assert.ok(new RegExp(RE_IMAGE_REF.source, 'iu').test(s), s);
    assert.equal(looksIllustration(withoutImageRef(s)), false, s);
  }
  for (const s of ['в цветах этого скриншота собери экран', 'экран как на этом скрине', 'в цветах этих картинок', 'собери экран по этой картинке',
    'используй цвета этой картинки', 'возьми цвета с картинки', 'в стиле фотографии']) {
    assert.ok(RE_IMAGE_REF.test(s), s);
  }
  for (const s of ['нарисуй картинку с котом', 'добавь картинку в шапку', 'сделай экран в стиле фотореализма', 'галерея в стиле фото-галереи', 'сделай по образцу']) {
    assert.ok(!RE_IMAGE_REF.test(s), s);
  }
  assert.equal(RE_IMAGE_REF.flags.includes('g'), false, 'без g: .test не помнит прошлый вызов');
  assert.ok(RE_IMAGE_REF.test('в цветах фото') && RE_IMAGE_REF.test('в цветах фото'));
  for (const s of ['нарисуй картинку с котом', 'добавь картинку в шапку']) assert.equal(withoutImageRef(s).trim(), s, s);
  assert.notEqual(classifyUtterance('собери экран кофейни в цветах этой картинки', { hasSelection: true }).intent, 'illustration');
  assert.ok(!classifyUtterance('собери экран кофейни в цветах этой картинки', { hasSelection: true }).art);
});

const PLAN = { intent: 'create', title: 'Экран', summary: 'Соберу экран', steps: ['Шапка'] };
const DIRECTION = { concept: 'Зал', mood: ['тепло'], materials: [{ name: 'дерево', hex: '#3b2418' }], palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' }, fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['x'], composition: 'x', avoid: ['x'] };
const TREE = { type: 'frame', name: 'Кофейня', children: [{ type: 'text', name: 'Заголовок', text: 'Утро', style: 'display' }] };
function fake() {
  const calls = [];
  return { name: 'fake', calls, async ready() { return true; },
    async complete(messages, schema) { calls.push({ schema: schema.name, messages }); const v = { plan: PLAN, direction: DIRECTION, tree: TREE }[schema.name]; if (!v) throw new Error('нет ответа ' + schema.name); return clone(v); } };
}

test('круг55: «собери экран в цветах этой картинки» при выделенной картинке — новая доска, цвета у арт-директора, без рисования и без мегабайт в промпте', async () => {
  for (const withBoard of [false, true]) {
    let doc = quiet(() => core.createDoc(withBoard ? undefined : 'empty'));
    const sel = withBoard ? [core.artboards(doc)[0].id] : [];
    const r = imageInsertOps(doc, { selection: sel, src: SRC, width: 1200, height: 800, fileName: 'зал.jpg', at: { x: 0, y: 0 }, ids });
    doc = core.applyOps(doc, r.ops).doc;
    const before = core.artboards(doc).length;
    const provider = fake();
    const res = await runCommand({ doc, selection: r.select, utterance: 'собери экран кофейни в цветах этой картинки', provider, engine: core, critic: false,
      imageColors: async (src) => src.map((x) => ({ id: x.id, colors: [{ hex: '#3b2418', share: 0.7 }, { hex: '#c9a77c', share: 0.3 }] })) });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'direction', 'tree'], 'иллюстратора не зовут');
    assert.equal(core.artboards(res.preview.doc).length, before + 1, 'новой доской, а не внутрь');
    const all = JSON.stringify(provider.calls.map((c) => c.messages));
    assert.ok(all.includes('#3b2418 70%'), 'арт-директор видит цвета картинки');
    assert.ok(!all.includes('QUJDQUJD'), 'данные картинки в промпт не уходят');
  }
});

/* ── в настоящем браузере ───────────────────────────────────────────────── */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/(api|ws|agent)(\/|$)/.test(path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":true,"code":"not_found"}'); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('круг55: в браузере — вставка из буфера и бросок файла кладут картинку, без ошибок страницы', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    // вставка: PNG 40×20, сделанный на странице, — в буфер как файл
    await page.evaluate(async () => {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      const c = document.createElement('canvas'); c.width = 40; c.height = 20;
      const g = c.getContext('2d'); g.fillStyle = '#3b2418'; g.fillRect(0, 0, 40, 12); g.fillStyle = '#c9a77c'; g.fillRect(0, 12, 40, 8);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'образец.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => /Картинка на макете/.test(document.body.innerText), null, { timeout: 10000 });
    // бросок файла на пустое место холста — новой доской
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 30; c.height = 30;
      const g = c.getContext('2d'); g.fillStyle = '#2f6f62'; g.fillRect(0, 0, 30, 30);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'брошенная.jpg', { type: 'image/jpeg' }));
      const canvas = document.getElementById('canvas') || document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const at = { clientX: rect.left + 5, clientY: rect.bottom - 5, bubbles: true, cancelable: true, dataTransfer: dt };
      canvas.dispatchEvent(new DragEvent('dragover', at));
      canvas.dispatchEvent(new DragEvent('drop', at));
    });
    await page.waitForTimeout(1500);
    await page.click('#btn-history');
    await page.waitForTimeout(600);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
    const hist = await page.locator('#sheet-body').innerText();
    assert.ok(/образец/.test(hist) && /брошенная/.test(hist), hist);
  } finally {
    await browser.close();
    srv.close();
  }
});

test('круг55: картинка на настоящем экране — место правки, а не образец', async () => {
  let doc = quiet(() => core.createDoc());
  const board = core.artboards(doc)[0];
  const r = imageInsertOps(doc, { selection: [board.id], src: SRC, width: 600, height: 400, at: { x: 0, y: 0 }, ids });
  doc = core.applyOps(doc, r.ops).doc;
  const before = core.artboards(doc).length;
  const PATCH_TREE = { type: 'frame', name: 'Кнопка', children: [{ type: 'text', name: 'Текст', text: 'Заказать', style: 'body' }] };
  const calls = [];
  const provider = { name: 'f', async ready() { return true; },
    async complete(m, sc) { calls.push(sc.name); const v = { plan: { intent: 'create', title: 'Кнопка', summary: 'Добавлю кнопку', steps: ['Кнопка'] }, tree: PATCH_TREE, direction: DIRECTION }[sc.name]; if (!v) throw new Error('нет ' + sc.name); return clone(v); } };
  const res = await runCommand({ doc, selection: r.select, utterance: 'добавь кнопку в цветах этой картинки', provider, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(core.artboards(res.preview.doc).length, before, 'кнопка — на этом же экране');
  assert.ok(!calls.includes('illustration'));
});
