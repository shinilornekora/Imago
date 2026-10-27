/**
 * Круг 78 (SPEC §15.15): у экрана свои и цвета, и шрифты — вернуть документу одну часть, не всю тему.
 * Одна операция `theme.colors`/`theme.type` → undefined; последняя часть — снимается вся тема.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { themePartResetOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function docWith(theme, name = 'Оплата') {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [core.ops.create({ id: 'B', type: 'frame', name, parent: base.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] })]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const apply = (doc, r) => { const x = core.applyOps(doc, r.ops); assert.equal(x.error, undefined, JSON.stringify(x.error)); return x.doc; };
const BOTH = { colors: { accent: '#c0392b' }, type: { title: { font: 'Prata' } } };

test('круг78: обе части — одна снимается, другая остаётся', () => {
  const doc = docWith(BOTH);
  const c = themePartResetOps(doc.nodes.B, 'colors');
  assert.deepEqual(c.ops.map((o) => [o.id, o.path, o.value]), [['B', 'theme.colors', undefined]]);
  assert.equal(c.label, 'Экран «Оплата»: цвета — как в документе');
  const afterC = apply(doc, c);
  assert.equal(afterC.nodes.B.theme.colors, undefined);
  assert.deepEqual(afterC.nodes.B.theme.type, BOTH.type);
  const t = themePartResetOps(doc.nodes.B, 'type');
  assert.equal(t.label, 'Экран «Оплата»: шрифты — как в документе');
  const afterT = apply(doc, t);
  assert.deepEqual(afterT.nodes.B.theme.colors, BOTH.colors);
  assert.equal(afterT.nodes.B.theme.type, undefined);
});

test('круг78: последняя часть — снимается вся тема; нечего снимать — null', () => {
  const doc = docWith({ colors: { accent: '#c0392b' } });
  const r = themePartResetOps(doc.nodes.B, 'colors');
  assert.deepEqual(r.ops.map((o) => [o.path, o.value]), [['theme', undefined]]);
  assert.equal(r.label, 'Экран «Оплата» вернулся к оформлению документа');
  assert.equal(apply(doc, r).nodes.B.theme, undefined);
  assert.equal(themePartResetOps(doc.nodes.B, 'type'), null);
  assert.equal(themePartResetOps(doc.nodes.B, 'spacing'), null);
  assert.equal(themePartResetOps(docWith(null).nodes.B, 'colors'), null);
  assert.equal(themePartResetOps(docWith({ colors: {}, type: { body: { fontWeight: 500 } } }).nodes.B, 'colors'), null, 'пустая часть — не своя');
  assert.equal(themePartResetOps(null, 'colors'), null);
  // критик: неверная тема (так её и не рисует инспектор) — не «часть», правки нет
  const bad = { id: 'X', type: 'frame', name: 'Плохой', theme: { colors: { accent: 'не цвет' }, type: { title: { font: 'Prata' } } } };
  assert.equal(core.boardTheme(bad), null);
  assert.equal(themePartResetOps(bad, 'type'), null);
});

test('круг78: после снятия одной части — отмена возвращает тему целиком', () => {
  const doc = docWith(BOTH);
  const ops = themePartResetOps(doc.nodes.B, 'type').ops;
  const inverse = core.invertOps(doc, ops);
  const back = core.applyOps(core.applyOps(doc, ops).doc, inverse).doc;
  assert.deepEqual(back.nodes.B.theme, BOTH);
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

test('круг78: в браузере — «Цвета — как в документе» снимает цвета, шрифты остаются', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.locator('#layers .layer[data-id]').first().click();
    await page.waitForFunction(() => /Тема экрана/i.test(document.getElementById('inspector').innerText), null, { timeout: 10000 });
    assert.equal(await page.locator('#inspector .theme-part-reset').count(), 0, 'своей темы нет — кнопок нет');
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => {
      const inp = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]');
      inp.value = '#c0392b';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1, null, { timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-part-reset').count(), 0, 'одна часть — кнопок частей нет');
    await page.locator('#inspector details.theme-styles summary').click();
    await page.locator('#inspector .theme-style-row[data-style="body"] select.theme-style-weight').selectOption('500');
    await page.locator('#inspector .theme-part-reset button[data-part="colors"]').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-part-reset').evaluate((r) => !!r.previousElementSibling && /Вернуть общее оформление/.test(r.previousElementSibling.textContent)), true, 'кнопки частей — под общей');
    await page.locator('#inspector .theme-part-reset button[data-part="colors"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 0, null, { timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-style-row[data-style="body"]').evaluate((e) => e.classList.contains('own')), true, 'шрифты остались');
    assert.equal(await page.locator('#inspector .theme-part-reset').count(), 0, 'осталась одна часть — кнопок нет');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
