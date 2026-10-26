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
import { runCommand, RE_IMAGE_REF } from '../src/brain.js';
import { moodboardOps, referenceCommandText, MOODBOARD, REFERENCE_WORDS_MANY } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const SRC = `data:image/png;base64,${DATA}`;
const pics = (n) => Array.from({ length: n }, (_, i) => ({ src: SRC + 'AAAA'.repeat(i), width: 800, height: 400 + i * 200, fileName: `фото${i}.png` }));
const ids = (n) => ({ board: 'MB', images: Array.from({ length: n }, (_, i) => `m${i}`) });

test('круг59: мудборд — одна доска, картинки по две в ряд, лишние отброшены, одна картинка — как раньше', () => {
  const doc = quiet(() => core.createDoc('empty'));
  const r = moodboardOps(doc, { images: pics(6), at: { x: 100, y: 50 }, ids: ids(6) });
  assert.equal(r.error, undefined);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.select, ['MB']);
  const next = core.applyOps(doc, r.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const board = next.doc.nodes.MB;
  assert.equal(board.name, 'Образец');
  assert.equal(board.children.length, MOODBOARD.max);
  const geo = core.solve(next.doc);
  const [a, b, c] = ['m0', 'm1', 'm2'].map((id) => geo.rects[id]);
  assert.equal(a.w, MOODBOARD.cell);
  assert.equal(a.y, b.y, 'первые две — в ряд');
  assert.ok(c.y > a.y, 'третья — ниже');
  assert.equal(a.h, Math.round((MOODBOARD.cell * 400) / 800), 'высота по пропорции');
  assert.deepEqual(geo.rects.MB.x, 100);
  const one = moodboardOps(doc, { images: pics(1), at: { x: 0, y: 0 }, ids: ids(1) });
  assert.deepEqual(one.select, ['m0'], 'одна картинка — та же доска по размеру картинки, что в круге 55');
  assert.ok(moodboardOps(doc, { images: [], at: { x: 0, y: 0 }, ids: ids(0) }).error);
  assert.ok(moodboardOps(doc, { images: [{ src: 'https://x/a.png', width: 1, height: 1 }, ...pics(1)], at: { x: 0, y: 0 }, ids: ids(2) }).error);
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

test('круг59: в браузере — две картинки в строку команды ложатся одной доской-образцом', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const prevented = await page.evaluate(async () => {
      const dt = new DataTransfer();
      for (const [name, color] of [['зал.png', '#3b2418'], ['стол.png', '#c9a77c']]) {
        const c = document.createElement('canvas'); c.width = 40; c.height = 30;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 40, 30);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        dt.items.add(new File([blob], name, { type: 'image/png' }));
      }
      return !document.getElementById('command').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(prevented, true);
    await page.waitForFunction(() => /2 картинки легли одной доской/.test(document.body.innerText), null, { timeout: 10000 });
    assert.equal(await page.inputValue('#command'), 'собери экран в цветах этих картинок');
    await page.click('#btn-history');
    await page.waitForTimeout(600);
    const hist = await page.locator('#sheet-body').innerText();
    assert.ok(/Образец/.test(hist), hist);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
