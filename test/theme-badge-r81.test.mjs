/**
 * Круг 81 (SPEC §15.17): метка «тема» у экрана со своей темой в списке слоёв — с кружком её цвета;
 * повреждённая тема — предупреждением; библиотека, вложенные рамки и экраны без темы — без метки.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { boardThemeBadge } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function docWith(theme) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [
    core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, pos: { x: 0, y: 0 },
      size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] }),
    core.ops.create({ id: 'in', type: 'frame', name: 'Карточка', parent: 'B', children: [] }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг81: метка темы — цвет фона (или акцент), сколько своего, подсказка', () => {
  let doc = docWith({ colors: { canvas: '#101418', accent: '#ff4f6d', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } });
  let b = boardThemeBadge(doc, doc.nodes.B);
  assert.deepEqual([b.swatch, b.colors, b.styles, !!b.broken], ['#101418', 3, 1, false]);
  assert.equal(b.title, 'Своя тема экрана: 3 цвета, шрифты 1 стиля — в инспекторе, «Тема экрана»');
  doc = docWith({ colors: { accent: '#ff4f6d' } });
  assert.equal(boardThemeBadge(doc, doc.nodes.B).swatch, '#ff4f6d');
  doc = docWith({ type: { body: { fontWeight: 500 }, title: { font: 'Prata' } } });
  b = boardThemeBadge(doc, doc.nodes.B);
  assert.equal(b.swatch, null);
  assert.match(b.title, /: шрифты 2 стилей —/);
});

test('круг81: без метки — нет темы, вложенная рамка, библиотека; повреждённая — предупреждение', () => {
  const doc = docWith(null);
  assert.equal(boardThemeBadge(doc, doc.nodes.B), null);
  assert.equal(boardThemeBadge(doc, doc.nodes.in), null);
  assert.equal(boardThemeBadge(doc, { ...doc.nodes.B, role: 'library', theme: { colors: { accent: '#ff4f6d' } } }), null);
  assert.equal(boardThemeBadge(doc, null), null);
  const broken = boardThemeBadge(doc, { ...doc.nodes.B, theme: { colors: { accent: 'не цвет' } } });
  assert.equal(broken.broken, true);
  assert.match(broken.title, /повреждена/);
});

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

test('круг81: в браузере — свой цвет экрана даёт метку в списке слоёв, отмена её снимает', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const first = page.locator('#layers .layer[data-id]').first();
    const id = await first.getAttribute('data-id');
    const pill = page.locator(`#layers .layer[data-id="${id}"] .tagpill.theme`);
    assert.equal(await pill.count(), 0, 'своей темы нет — метки нет');
    await first.click();
    await page.waitForFunction(() => /Тема экрана/i.test(document.getElementById('inspector').innerText), null, { timeout: 10000 });
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => {
      const inp = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]');
      inp.value = '#c0392b';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pill.waitFor({ timeout: 5000 });
    assert.match(await pill.getAttribute('title'), /^Своя тема экрана: 1 цвет/);
    const bg = await pill.locator('.dot').evaluate((d) => getComputedStyle(d).backgroundColor);
    assert.equal(bg, 'rgb(192, 57, 43)');
    const row = await page.locator(`#layers .layer[data-id="${id}"]`).boundingBox();
    assert.ok(row.height < 30, `строка в одну линию: ${row.height}`);
    await page.keyboard.press('Escape');
    await first.click();
    await page.keyboard.press('Control+z');
    await page.waitForFunction((id) => !document.querySelector(`#layers .layer[data-id="${id}"] .tagpill.theme`), id, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
