/**
 * Круг 68 (SPEC §15.7): шрифт заголовков и текста у одного экрана из инспектора — тема доски по путям
 * стилей, насыщенность — ближайшая у семейства, «как в документе» снимает, пустая тема снимается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { boardFontRows, themeFontOps, fontChoices, themeColorOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function docWith(theme) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] })]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const apply = (doc, r) => { const x = core.applyOps(doc, r.ops); assert.equal(x.error, undefined, JSON.stringify(x.error)); return x.doc; };

test('круг68: роли — заголовки и текст, моно не входит', () => {
  const doc = docWith(null);
  const rows = boardFontRows(doc, doc.nodes.B);
  assert.deepEqual(rows.map((r) => r.role), ['display', 'text']);
  const [d, t] = rows;
  assert.ok(d.styles.includes('display') && d.styles.includes('title'), d.styles.join());
  assert.ok(t.styles.includes('body') && t.styles.includes('caption') && !t.styles.some((n) => /mono/i.test(n)), t.styles.join());
  assert.deepEqual([d.font, d.own, d.docFont], ['IBM Plex Sans', false, 'IBM Plex Sans']);
  assert.ok(fontChoices().every((g) => g.families.length) && !fontChoices().some((g) => /Моно/.test(g.title)));
});

test('круг68: шрифт заголовков — по стилю на путь, насыщенность ближайшая; как в документе — снято', () => {
  let doc = docWith(null);
  const r = themeFontOps(doc, doc.nodes.B, 'display', 'Prata');
  assert.ok(r.ops.every((o) => /^theme\.type\./.test(o.path)), r.ops.map((o) => o.path).join());
  assert.equal(r.label, 'Шрифт заголовков экрана «Оплата»: Prata');
  doc = apply(doc, r);
  const tt = core.boardTheme(doc.nodes.B).type;
  assert.equal(tt.display.font, 'Prata');
  assert.equal(tt.display.fontWeight, 400, 'у Prata только 400 — насыщенность ближайшая');
  assert.equal(tt.body, undefined, 'текст не тронут');
  assert.equal(core.themedDoc(doc, doc.nodes.B).tokens.type.display.font, 'Prata');
  assert.equal(doc.tokens.type.display.font, 'IBM Plex Sans', 'документ не тронут');
  const rows = boardFontRows(doc, doc.nodes.B);
  assert.deepEqual([rows[0].font, rows[0].own], ['Prata', true]);
  assert.equal(themeFontOps(doc, doc.nodes.B, 'display', 'Prata'), null, 'тот же шрифт — правки нет');
  // цвет рядом — шрифт снимается, цвет остаётся
  doc = apply(doc, themeColorOps(doc, doc.nodes.B, 'accent', '#c0392b'));
  const back = themeFontOps(doc, doc.nodes.B, 'display', null);
  assert.deepEqual(back.ops.map((o) => o.path), ['theme.type']);
  assert.equal(back.label, 'Экран «Оплата»: шрифт заголовков — как в документе');
  doc = apply(doc, back);
  assert.deepEqual(Object.keys(core.boardTheme(doc.nodes.B)), ['colors']);
});

test('круг68: шрифт документа — запись снята; пустая тема — снята; мусор — null', () => {
  let doc = docWith(null);
  doc = apply(doc, themeFontOps(doc, doc.nodes.B, 'text', 'Manrope'));
  const same = themeFontOps(doc, doc.nodes.B, 'text', 'IBM Plex Sans');
  assert.equal(same.label, 'Экран «Оплата» вернулся к оформлению документа');
  doc = apply(doc, same);
  assert.equal(doc.nodes.B.theme, undefined);
  for (const [role, fam] of [['display', 'Comic Sans'], ['quote', 'Prata'], ['display', 42]]) assert.equal(themeFontOps(doc, doc.nodes.B, role, fam), null, `${role} ${fam}`);
  assert.equal(themeFontOps(doc, doc.nodes.B, 'display', null), null, 'снимать нечего');
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

test('круг68: в браузере — шрифт заголовков экрана из инспектора, отмена — назад', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const sel = page.locator('#inspector .theme-font-row[data-role="display"] select');
    await sel.waitFor({ timeout: 10000 });
    assert.equal(await sel.inputValue(), '');
    await sel.selectOption('Prata');
    await page.waitForFunction(() => document.querySelector('#inspector .theme-font-row[data-role="display"]').classList.contains('own'), null, { timeout: 5000 });
    assert.equal(await sel.inputValue(), 'Prata');
    assert.equal(await page.locator('#inspector .theme-font-row[data-role="text"] select').inputValue(), '', 'текст не тронут');
    await page.keyboard.press('Escape');
    await page.locator('#layers .layer[data-id]').first().click();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !document.querySelector('#inspector .theme-font-row[data-role="display"]').classList.contains('own'), null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});

test('круг68: насыщенность темы своя — шрифт её не стирает; heading в тексте — не тоньше 600; разные', () => {
  let doc = docWith({ type: { heading: { fontWeight: 800 } } });
  const r = themeFontOps(doc, doc.nodes.B, 'text', 'Manrope');
  doc = apply(doc, r);
  assert.deepEqual(core.boardTheme(doc.nodes.B).type.heading, { font: 'Manrope', fontWeight: 800 });
  doc = apply(doc, themeFontOps(doc, doc.nodes.B, 'text', null));
  assert.deepEqual(core.boardTheme(doc.nodes.B).type, { heading: { fontWeight: 800 } }, '«как в документе» снимает шрифт, насыщенность остаётся');
  // heading документа 500 — в роли текста не тоньше 600, как у арт-директора
  let d2 = docWith(null);
  d2 = { ...d2, tokens: { ...d2.tokens, type: { ...d2.tokens.type, heading: { ...d2.tokens.type.heading, fontWeight: 500 } } } };
  d2 = apply(d2, themeFontOps(d2, d2.nodes.B, 'text', 'Manrope'));
  assert.equal(core.boardTheme(d2.nodes.B).type.heading.fontWeight, 600);
  // разные шрифты у стилей роли — font null
  const d3 = docWith({ type: { display: { font: 'Prata' } } });
  const row = boardFontRows(d3, d3.nodes.B).find((x) => x.role === 'display');
  assert.deepEqual([row.font, row.own], [null, true]);
});

test('круг68: шрифт темы вне набора — свой, и «как в документе» его снимает', () => {
  let doc = docWith({ type: { display: { font: 'Foo Sans' }, title: { font: 'Foo Sans' } } });
  const row = boardFontRows(doc, doc.nodes.B)[0];
  assert.deepEqual([row.font, row.own], ['Foo Sans', true]);
  doc = apply(doc, themeFontOps(doc, doc.nodes.B, 'display', null));
  assert.equal(doc.nodes.B.theme, undefined);
});
