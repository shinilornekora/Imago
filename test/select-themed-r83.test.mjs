/**
 * Круг 83 (SPEC §15.19): «выдели экраны со своей темой» (и «/свои темы», «какие экраны в своей теме») —
 * оболочка выделяет все экраны со своим оформлением и называет их; ни одного — выделение не трогает.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { shellIntent, themedBoardsIntent } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens(themes) {
  const base = quiet(() => core.createDoc('empty'));
  const ops = Object.entries(themes).map(([name, theme], i) => core.ops.create({ id: `b${i}`, type: 'frame', name, parent: base.root, pos: { x: i * 400, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] }));
  const r = core.applyOps(base, ops);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const DARK = { colors: { canvas: '#101418' } };

test('круг83: фразы и слэш — выделение экранов со своей темой', () => {
  const doc = screens({ 'Оплата': DARK, 'Итог': null, 'Профиль': { type: { title: { font: 'Prata' } } } });
  for (const u of ['выдели экраны со своей темой', 'Выдели все экраны со своим оформлением', 'какие экраны в своей теме?',
    'у каких экранов своя тема', 'покажи экраны с отдельной темой', 'выбери доски со своими цветами', '/свои темы']) {
    const it = shellIntent(u, { doc });
    assert.deepEqual([it && it.kind, it && it.themed, it && it.ids], ['select', true, ['b0', 'b2']], u);
  }
  assert.equal(shellIntent('выдели экраны со своей темой', { doc }).say, 'Своя тема у экранов «Оплата», «Профиль»');
  // соседние фразы — как были
  assert.notEqual((shellIntent('выдели экран Итог', { doc }) || {}).themed, true);
  assert.equal(shellIntent('сделай экраны со своей темой тёмными', { doc }), null);
});

test('круг83: ни одного — выделение не трогаем; один; больше трёх; повреждённая тема', () => {
  const none = themedBoardsIntent(screens({ 'Оплата': null }));
  assert.deepEqual([none.ids, none.keep, none.say], [[], true, 'Своей темы нет ни у одного экрана — все в оформлении документа']);
  assert.equal(themedBoardsIntent(screens({ 'Оплата': DARK, 'Итог': null })).say, 'Своя тема у экрана «Оплата»');
  const many = themedBoardsIntent(screens({ A: DARK, B: DARK, C: DARK, D: DARK, E: DARK }));
  assert.equal(many.say, 'Своя тема у экранов «A», «B», «C» и ещё 2');
  const doc = structuredClone(screens({ 'Оплата': DARK, 'Итог': null }));
  doc.nodes.b1.theme = { colors: { canvas: 'не цвет' } };
  assert.equal(themedBoardsIntent(doc).say, 'Своя тема у экранов «Оплата», «Итог» (повреждена у 1)');
  assert.equal(themedBoardsIntent(null).ids.length, 0);
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

test('круг83: в браузере — команда выделяет экран со своей темой и говорит об этом', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const boards = await page.evaluate(() => [...document.querySelectorAll('#layers .layer[data-id][aria-level="1"]')].map((r) => r.dataset.id));
    const [a, b] = boards;
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); };
    // своей темы ни у кого — выделение второго экрана остаётся
    await page.locator(`#layers .layer[data-id="${b}"]`).click();
    await say('выдели экраны со своей темой');
    await page.waitForFunction(() => /Своей темы нет ни у одного экрана/.test(document.body.innerText), null, { timeout: 5000 });
    assert.equal(await page.locator(`#layers .layer[data-id="${b}"]`).getAttribute('aria-selected'), 'true');
    await page.locator(`#layers .layer[data-id="${a}"]`).click();
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => {
      const inp = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]');
      inp.value = '#c0392b';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator(`#layers .layer[data-id="${a}"] .tagpill.theme`).waitFor({ timeout: 5000 });
    await page.locator(`#layers .layer[data-id="${b}"]`).click();
    await say('выдели экраны со своей темой');
    await page.waitForFunction((a) => document.querySelector(`#layers .layer[data-id="${a}"]`).getAttribute('aria-selected') === 'true', a, { timeout: 5000 });
    assert.equal(await page.locator(`#layers .layer[data-id="${b}"]`).getAttribute('aria-selected'), 'false');
    await page.waitForFunction(() => /Своя тема у экрана «/.test(document.body.innerText), null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
