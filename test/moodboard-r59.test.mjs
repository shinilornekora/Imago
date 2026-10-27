/**
 * Круг 59 (SPEC §21.6): несколько картинок разом в строку команды — мудборд: одна доска-образец,
 * картинки рядами, арт-директор видит цвета всех; слова «в цветах этих картинок».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { runCommand, RE_IMAGE_REF, referenceImage } from '../src/brain.js';
import { moodboardOps, moodboardLeftover, referenceCommandText, clipboardTextIsLabel, MOODBOARD, REFERENCE_WORDS_MANY } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const SRC = `data:image/png;base64,${DATA}`;
const pics = (n) => Array.from({ length: n }, (_, i) => ({ src: SRC + 'AAAA'.repeat(i), width: 800, height: 400 + i * 200, fileName: `фото${i}.png` }));
const ids = (n) => ({ board: 'MB', images: Array.from({ length: n }, (_, i) => `m${i}`) });

test('круг59: мудборд — одна доска, ряды по две, каждая вписана в клетку, лишние отброшены', () => {
  const doc = quiet(() => core.createDoc('empty'));
  // мелкая иконка, высокая полоска, широкая, обычная, лишние
  const images = [
    { src: SRC, width: 40, height: 30, fileName: 'иконка.gif' },
    { src: SRC + 'AAAA', width: 100, height: 960, fileName: 'полоска.png' },
    { src: SRC + 'AAAAAAAA', width: 960, height: 300, fileName: 'панорама.png' },
    { src: SRC + 'AAAAAAAAAAAA', width: 800, height: 600, fileName: 'зал.png' },
    ...pics(2),
  ];
  const r = moodboardOps(doc, { images, at: { x: 100, y: 50 }, ids: ids(6) });
  assert.equal(r.error, undefined);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.select, ['MB']);
  const next = core.applyOps(doc, r.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const board = next.doc.nodes.MB;
  assert.equal(board.name, 'Образец');
  assert.equal(board.children.length, 2, 'два ряда');
  assert.deepEqual(board.children.map((id) => next.doc.nodes[id].children.length), [2, 2]);
  const geo = core.solve(next.doc);
  const R = (id) => geo.rects[id];
  const cellH = MOODBOARD.cell * MOODBOARD.tall;
  assert.equal(R('m0').w, MOODBOARD.cell, 'мелкая — во всю клетку');
  assert.equal(R('m0').h, Math.round((MOODBOARD.cell * 30) / 40));
  assert.equal(R('m1').h, cellH, 'высокая — по высоте клетки');
  assert.equal(R('m1').w, Math.round(cellH / (960 / 100)));
  assert.equal(R('m2').w, MOODBOARD.cell);
  // ряды — свои рамки; картинки ряда выровнены по центру ряда
  const [r0, r1] = [R('MB_r0'), R('MB_r1')];
  for (const id of ['m2', 'm3']) assert.ok(R(id).y >= r1.y && R(id).y + R(id).h <= r1.y + r1.h + 0.01, `${id} — во втором ряду`);
  assert.ok(r1.y >= r0.y + r0.h, 'второй ряд ниже первого');
  assert.equal(r0.h, R('m1').h, 'ряд — по самой высокой');
  for (const id of ['m0', 'm1', 'm2', 'm3']) assert.ok(R(id).h <= cellH && R(id).w <= MOODBOARD.cell, id);
  assert.equal(R('MB').x, 100);
  assert.equal(R('MB').w, 2 * MOODBOARD.cell + MOODBOARD.gap + 2 * MOODBOARD.pad);
  // одна картинка — как imageInsertOps без выделения; ошибки
  const one = moodboardOps(doc, { images: pics(1), at: { x: 0, y: 0 }, ids: ids(1) });
  assert.deepEqual(one.select, ['m0']);
  assert.ok(moodboardOps(doc, { images: [], at: { x: 0, y: 0 }, ids: ids(0) }).error);
  assert.ok(moodboardOps(doc, { images: [{ src: 'https://x/a.png', width: 1, height: 1 }, ...pics(1)], at: { x: 0, y: 0 }, ids: ids(2) }).error);
});

test('круг59: что не легло — у каждой причины свои слова; имена нескольких файлов в буфере — не текст', () => {
  assert.equal(moodboardLeftover({ images: 2, taken: 2 }), '');
  assert.equal(moodboardLeftover({ images: 3, taken: 3, failed: 1 }), '1 картинка не открылась.');
  assert.equal(moodboardLeftover({ images: 6, taken: 4 }), 'Ещё 2 картинки не вошли: в образец идёт до 4.');
  assert.equal(moodboardLeftover({ images: 5, taken: 4, failed: 2, other: 5 }),
    'Ещё 1 картинка не вошла: в образец идёт до 4. 2 картинки не открылись. 5 файлов — не картинки.');
  assert.ok(clipboardTextIsLabel('зал.png\nстол.jpg\r\nокно.webp'));
  assert.ok(!clipboardTextIsLabel('зал.png\nсобери экран'));
});

test('круг59: модели со зрением говорят, что она видит одну картинку из нескольких', () => {
  const base = quiet(() => core.createDoc('empty'));
  const r = moodboardOps(base, { images: pics(3), at: { x: 0, y: 0 }, ids: ids(3) });
  const doc = core.applyOps(base, r.ops).doc;
  const seen = referenceImage(doc, r.select, core.solve(doc), 'собери экран в цветах этих картинок');
  assert.equal(seen.of, 3);
  assert.equal(seen.mime, 'image/png');
});

test('круг59: «в цветах этих картинок» — образец; цвета всех картинок у арт-директора, новая доска', async () => {
  const r0 = referenceCommandText('собери экран кофейни', { many: true });
  assert.equal(r0.value, `собери экран кофейни ${REFERENCE_WORDS_MANY}`);
  assert.ok(RE_IMAGE_REF.test(r0.value));
  const base = quiet(() => core.createDoc());
  const r = moodboardOps(base, { images: pics(3), at: { x: 3000, y: 0 }, ids: ids(3) });
  const doc = core.applyOps(base, r.ops).doc;
  const before = core.artboards(doc).length;
  const calls = [];
  let seen = null;
  const provider = { name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      calls.push(schema.name);
      const v = {
        plan: { intent: 'edit', title: 'Экран', summary: 'Соберу', steps: ['Шапка'] },
        direction: { concept: 'Зал', mood: ['тепло'], materials: [{ name: 'дерево', hex: '#3b2418' }], palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' }, fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['x'], composition: 'x', avoid: ['x'] },
        tree: { type: 'frame', name: 'Кофейня', children: [{ type: 'text', name: 'Заголовок', text: 'Утро', style: 'display' }] },
      }[schema.name];
      if (!v) throw new Error('нет ответа ' + schema.name);
      return JSON.parse(JSON.stringify(v));
    } };
  const res = await runCommand({ doc, selection: r.select, utterance: r0.value, provider, engine: core, critic: false,
    imageColors: async (src) => { seen = src.map((x) => x.id); return src.map((x, i) => ({ id: x.id, colors: [{ hex: ['#3b2418', '#c9a77c', '#2f6f62'][i % 3], share: 1 }] })); } });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(calls, ['plan', 'direction', 'tree']);
  assert.equal(core.artboards(res.preview.doc).length, before + 1);
  assert.deepEqual([...(seen || [])].sort(), ['m0', 'm1', 'm2']);
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

test('круг59: в браузере — несколько картинок в строку команды ложатся одной доской-образцом, лишнее сказано словами, отмена целиком', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.fill('#command', '');
    await page.focus('#command');
    const layers = () => page.locator('#layers').innerText();
    // бросок на полосу команды: три картинки (одна битая), PDF; ещё три картинки сверх предела
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      const png = async (color, w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
        return new Promise((r) => c.toBlob(r, 'image/png'));
      };
      dt.items.add(new File([await png('#3b2418', 400, 300)], 'зал.png', { type: 'image/png' }));
      dt.items.add(new File(['не картинка'], 'битая.png', { type: 'image/png' }));
      dt.items.add(new File([await png('#c9a77c', 60, 40)], 'стол.png', { type: 'image/png' }));
      dt.items.add(new File(['%PDF'], 'меню.pdf', { type: 'application/pdf' }));
      for (const n of ['а', 'б', 'в']) dt.items.add(new File([await png('#2f6f62', 50, 50)], `${n}.png`, { type: 'image/png' }));
      const bar = document.getElementById('commandbar');
      const at = { bubbles: true, cancelable: true, dataTransfer: dt };
      bar.dispatchEvent(new DragEvent('dragover', at));
      bar.dispatchEvent(new DragEvent('drop', at));
    });
    await page.waitForFunction(() => /картинки легли одной доской/.test(document.body.innerText), null, { timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /3 картинки легли одной доской и выделены/);
    assert.match(text, /Ещё 2 картинки не вошли: в образец идёт до 4\. 1 картинка не открылась\. 1 файл — не картинка\./);
    assert.equal(await page.inputValue('#command'), 'собери экран в цветах этих картинок');
    const tree = await layers();
    assert.ok(/Образец/.test(tree) && /Ряд 1/.test(tree) && /Ряд 2/.test(tree), tree);
    assert.ok(/зал/.test(tree) && /стол/.test(tree) && !/битая/.test(tree), tree);
    // Ctrl+Z — мудборд уходит одной отменой
    await page.evaluate(() => document.getElementById('command').blur());
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    assert.ok(!/Ряд 1/.test(await layers()), 'отменилось целиком');
    // вставка двух картинок с именами файлов в буфере — тоже мудборд
    await page.focus('#command');
    await page.fill('#command', 'собери экран кофейни');
    const prevented = await page.evaluate(async () => {
      const dt = new DataTransfer();
      for (const [name, color] of [['зал.png', '#3b2418'], ['стол.png', '#c9a77c']]) {
        const c = document.createElement('canvas'); c.width = 40; c.height = 30;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 40, 30);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        dt.items.add(new File([blob], name, { type: 'image/png' }));
      }
      dt.setData('text/plain', 'зал.png\nстол.png');
      return !document.getElementById('command').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(prevented, true);
    await page.waitForFunction(() => /2 картинки легли одной доской/.test(document.body.innerText), null, { timeout: 10000 });
    assert.equal(await page.inputValue('#command'), 'собери экран кофейни в цветах этих картинок');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
