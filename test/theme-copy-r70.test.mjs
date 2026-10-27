/**
 * Круг 70 (SPEC §15.8): тема другого экрана — этой доске копией, одной операцией; дальше живут порознь.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeSources, copyThemeOps, themeColorOps } from '../src/shell.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x, theme) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] });
  const r = core.applyOps(base, [
    mk('pay', 'Оплата', 0, { colors: { canvas: '#101418', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } }),
    mk('sum', 'Итог', 400, null),
    mk('twin', 'Копия', 800, { colors: { canvas: '#101418', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } }),
    mk('bad', 'Сломанная', 1200, null),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const doc = r.doc;
  return { ...doc, nodes: { ...doc.nodes, bad: { ...doc.nodes.bad, theme: { colors: { canvas: 'red' } } } } };
}

test('круг70: источники — экраны со своей годной темой, кроме себя и той же темы', () => {
  const doc = screens();
  assert.deepEqual(themeSources(doc, doc.nodes.sum).map((x) => x.id), ['pay', 'twin']);
  assert.deepEqual(themeSources(doc, doc.nodes.pay).map((x) => x.id), [], 'у «Копии» та же тема, сломанная — не источник');
  const lib = Object.values(doc.nodes).find((n) => n.role === 'library');
  assert.ok(lib && !themeSources(doc, doc.nodes.sum).some((x) => x.id === lib.id));
});

test('круг70: копия темы — одной операцией, дальше порознь; та же — null', () => {
  let doc = screens();
  const r = copyThemeOps(doc, doc.nodes.sum, 'pay');
  assert.deepEqual(r.ops.map((o) => [o.op, o.id, o.path]), [['set', 'sum', 'theme']]);
  assert.equal(r.label, 'Экран «Итог» — в теме экрана «Оплата»');
  doc = core.applyOps(doc, r.ops).doc;
  assert.deepEqual(doc.nodes.sum.theme, doc.nodes.pay.theme);
  assert.equal(copyThemeOps(doc, doc.nodes.sum, 'pay'), null);
  doc = core.applyOps(doc, themeColorOps(doc, doc.nodes.sum, 'accent', '#ff4f6d').ops).doc;
  assert.equal(doc.nodes.pay.theme.colors.accent, undefined, 'темы живут порознь');
  for (const from of ['sum', 'bad', 'nope']) assert.equal(copyThemeOps(doc, doc.nodes.sum, from), null, from);
  const start = screens();
  const copied = core.applyOps(start, r.ops).doc;
  assert.equal(core.applyOps(copied, core.invertOps(start, r.ops)).doc.nodes.sum.theme, undefined, 'отмена — экран без темы');
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

test('круг70: в браузере — «как у экрана» берёт тему другой доски, отмена — назад', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const boards = page.locator('#layers .layer[data-id]');
    await boards.first().click();
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => { const i = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]'); i.value = '#1d3557'; i.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1, null, { timeout: 5000 });
    await page.locator('#layers .layer[data-id]').filter({ hasText: 'Сводка недели' }).first().click();
    const copy = page.locator('#inspector .theme-copy-select');
    await copy.waitFor({ timeout: 5000 });
    await copy.selectOption({ label: 'Маршрут дня' });
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1
      && document.querySelector('#inspector .theme-color-row.own').dataset.token === 'accent', null, { timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-copy-select').count(), 0, 'та же тема — источника больше нет');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 0, null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
