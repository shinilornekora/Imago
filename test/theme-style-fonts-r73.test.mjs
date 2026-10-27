/**
 * Круг 73 (SPEC §15.10): шрифт и насыщенность ОДНОГО стиля у экрана из инспектора — одна операция
 * `theme.type.<стиль>`; новый шрифт берёт ближайшую насыщенность; «как в документе» снимает своё.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { boardStyleFontRows, themeStyleFontOps, themeFontOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function docWith(theme) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] })]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const apply = (doc, r) => { const x = core.applyOps(doc, r.ops); assert.equal(x.error, undefined, JSON.stringify(x.error)); return x.doc; };


test('круг73: строки по стилям — все стили ролей, видимое и документа, насыщенности шрифта', () => {
  const doc = docWith({ type: { title: { font: 'Prata' }, body: { fontWeight: 500 } } });
  const rows = boardStyleFontRows(doc, doc.nodes.B);
  const by = Object.fromEntries(rows.map((r) => [r.style, r]));
  assert.ok(by.display && by.title && by.body && by.caption && !by.mono, Object.keys(by).join());
  assert.deepEqual([by.title.font, by.title.ownFont, by.title.weights, by.title.docFont], ['Prata', true, [400], 'IBM Plex Sans']);
  assert.deepEqual([by.body.weight, by.body.ownWeight, by.body.ownFont, by.body.docWeight], [500, true, false, 400]);
  assert.match(by.title.title, /\S/);
});

test('круг73: шрифт одного стиля — одна операция, насыщенность ближайшая; соседние стили не тронуты', () => {
  let doc = docWith(null);
  const r = themeStyleFontOps(doc, doc.nodes.B, 'title', { font: 'Prata' });
  assert.deepEqual(r.ops.map((o) => [o.path, o.value]), [['theme.type.title', { font: 'Prata', fontWeight: 400 }]]);
  assert.match(r.label, /^Экран «Оплата», стиль «.+»: Prata 400$/);
  doc = apply(doc, r);
  assert.equal(doc.nodes.B.theme.type.display, undefined, 'display не тронут');
  // насыщенность отдельно — у Prata только 400: ближайшая 400; у Golos — 700
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'title', { fontWeight: 700 }), null, 'у Prata 700 нет — уже 400');
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'title', { font: 'Golos Text' }));
  assert.deepEqual(doc.nodes.B.theme.type.title, { font: 'Golos Text' }, 'вес документа (600) есть у Golos — не пишется');
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'title', { fontWeight: 800 }));
  assert.deepEqual(doc.nodes.B.theme.type.title, { font: 'Golos Text', fontWeight: 800 });
  // насыщенность — как в документе: шрифт остаётся
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'title', { fontWeight: null }));
  assert.deepEqual(doc.nodes.B.theme.type.title, { font: 'Golos Text' });
  // шрифт — как в документе: запись снята, тема опустела — снята целиком
  const back = themeStyleFontOps(doc, doc.nodes.B, 'title', { font: null });
  assert.deepEqual(back.ops.map((o) => [o.path, o.value]), [['theme', undefined]]);
  assert.match(back.label, /вернулся к оформлению документа/);
});

test('круг73: насыщенность без своего шрифта, своя насыщенность переживает смену шрифта; цвета держат тему', () => {
  let doc = docWith({ colors: { accent: '#ff4f6d' } });
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'body', { fontWeight: 500 }));
  assert.deepEqual(doc.nodes.B.theme.type.body, { fontWeight: 500 });
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'body', { font: 'Golos Text' }));
  assert.deepEqual(doc.nodes.B.theme.type.body, { font: 'Golos Text', fontWeight: 500 }, 'своя 500 — образец для нового шрифта');
  const off = themeStyleFontOps(doc, doc.nodes.B, 'body', { font: null, fontWeight: null });
  assert.deepEqual(off.ops.map((o) => [o.path, o.value]), [['theme.type', undefined]], 'цвета остались — снят только type');
  assert.match(off.label, /стиль «.+» — как в документе$/);
  // мусор и «без изменений» — null
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'mono', { font: 'Prata' }), null, 'моно не в ролях');
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'body', { font: 'Нет Такого' }), null);
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'body', { fontWeight: 1200 }), null);
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'body', { font: 'Golos Text' }), null);
  // шрифт документа выбран явно — своё снимается
  const same = themeStyleFontOps(doc, doc.nodes.B, 'body', { font: 'IBM Plex Sans' });
  assert.deepEqual(same.ops[0].value, { fontWeight: 500 });
});

test('круг73: правка роли (круг 68) поверх своего у стиля — насыщенность стиля своя, не стирается', () => {
  let doc = docWith(null);
  // у IBM Plex Sans насыщенности до 700: 800 — ближайшая 700
  doc = apply(doc, themeStyleFontOps(doc, doc.nodes.B, 'title', { fontWeight: 800 }));
  assert.deepEqual(doc.nodes.B.theme.type.title, { fontWeight: 700 });
  doc = apply(doc, themeFontOps(doc, doc.nodes.B, 'display', 'Golos Text'));
  assert.equal(doc.nodes.B.theme.type.title.fontWeight, 700);
  assert.equal(doc.nodes.B.theme.type.title.font, 'Golos Text');
});
test('круг73, критики: подобранная насыщенность не своя; сброс шрифта вне набора; «как в документе» у Prata; heading в тексте', () => {
  // роль заголовков → Prata: 400 подобрана, не своя
  let doc = docWith(null);
  doc = apply(doc, themeFontOps(doc, doc.nodes.B, 'display', 'Prata'));
  const t = boardStyleFontRows(doc, doc.nodes.B).find((r) => r.style === 'title');
  assert.deepEqual([t.ownFont, t.ownWeight, t.autoWeight], [true, false, 400]);
  assert.match(t.title, /^\p{Lu}/u, 'имя стиля с прописной');
  // насыщенность «как в документе» у Prata — 400 остаётся, подпись не врёт
  assert.equal(themeStyleFontOps(doc, doc.nodes.B, 'title', { fontWeight: null }), null, 'и так подобранная');
  // шрифт документа вне набора: Prata → как в документе — насыщенность документа
  let odd = docWith(null);
  odd = { ...odd, tokens: { ...odd.tokens, type: { ...odd.tokens.type, title: { ...odd.tokens.type.title, font: 'Helvetica Neue', fontWeight: 600 } } } };
  odd = apply(odd, themeStyleFontOps(odd, odd.nodes.B, 'title', { font: 'Prata' }));
  const back = themeStyleFontOps(odd, odd.nodes.B, 'title', { font: null });
  assert.deepEqual(back.ops.map((o) => [o.path, o.value]), [['theme', undefined]], JSON.stringify(back.ops));
  // heading в роли текста при документе 400 — как у роли: не тоньше 600
  let h = docWith(null);
  h = { ...h, tokens: { ...h.tokens, type: { ...h.tokens.type, heading: { ...h.tokens.type.heading, fontWeight: 400 } } } };
  const byRole = themeFontOps(h, h.nodes.B, 'text', 'Golos Text').ops.find((o) => o.path === 'theme.type.heading').value;
  const byStyle = themeStyleFontOps(h, h.nodes.B, 'heading', { font: 'Golos Text' }).ops[0].value;
  assert.deepEqual(byStyle, byRole);
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


test('круг73: в браузере — насыщенность стиля экрана из «Шрифты по стилям», отмена — назад', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const box = page.locator('#inspector details.theme-styles');
    await box.waitFor({ timeout: 10000 });
    assert.equal(await box.evaluate((d) => d.open), false, 'своего нет — свёрнуто');
    await box.locator('summary').click();
    const row = box.locator('.theme-style-row[data-style="body"]');
    await row.locator('select.theme-style-weight').selectOption('500');
    await page.waitForFunction(() => document.querySelector('#inspector .theme-style-row[data-style="body"]').classList.contains('own'), null, { timeout: 5000 });
    assert.equal(await page.locator('#inspector details.theme-styles').evaluate((d) => d.open), true, 'раскрытое переживает перерисовку');
    assert.equal(await page.locator('#inspector .theme-style-row[data-style="body"] select.theme-style-weight').inputValue(), '500');
    assert.equal(await page.locator('#inspector .theme-style-row[data-style="caption"]').evaluate((e) => e.classList.contains('own')), false);
    await page.keyboard.press('Escape');
    await page.locator('#layers .layer[data-id]').first().click();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !document.querySelector('#inspector .theme-style-row[data-style="body"]').classList.contains('own'), null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
