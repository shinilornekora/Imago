/**
 * Круг 67 (SPEC §15.6): цвета экрана в инспекторе — правка ложится в тему доски одной операцией,
 * «как в документе» снимает цвет с темы, пустая тема снимается целиком; шрифты темы не трогаются;
 * контраст после правки — предупреждением.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { boardColorRows, themeColorOps } from '../src/shell.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function docWith(theme) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] })]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const apply = (doc, r) => { const x = core.applyOps(doc, r.ops); assert.equal(x.error, undefined, JSON.stringify(x.error)); return x.doc; };
const hex = (v) => String(v).toLowerCase();

test('круг67: строки — все цвета документа, каким их видит доска', () => {
  const doc = docWith({ colors: { accent: '#2f6f62', brand: '#ff0066' } });
  const rows = boardColorRows(doc, doc.nodes.B);
  const names = rows.map((r) => r.name);
  for (const k of Object.keys(doc.tokens.colors)) if (/^#/.test(doc.tokens.colors[k])) assert.ok(names.includes(k), k);
  const accent = rows.find((r) => r.name === 'accent');
  assert.deepEqual([accent.hex, accent.own, accent.docHex], ['#2f6f62', true, hex(doc.tokens.colors.accent)]);
  const brand = rows.find((r) => r.name === 'brand');
  assert.deepEqual([brand.own, brand.docHex], [true, null], 'имя темы, которого в документе нет, — тоже строка');
  assert.ok(rows.filter((r) => r.name !== 'accent' && r.name !== 'brand').every((r) => !r.own && r.hex === r.docHex));
});

test('круг67: свой цвет — тема доски; повтор — ничего; общий цвет — снят; пустая тема — снята', () => {
  let doc = docWith(null);
  const r1 = themeColorOps(doc, doc.nodes.B, 'accent', '#C0392B');
  assert.equal(r1.ops.length, 1);
  assert.deepEqual([r1.ops[0].op, r1.ops[0].path], ['set', 'theme.colors.accent'], 'правка — по пути цвета, не всей темой');
  assert.equal(r1.label, 'Свой цвет экрана «Оплата»: accent #C0392B');
  doc = apply(doc, r1);
  assert.equal(hex(core.boardTheme(doc.nodes.B).colors.accent), '#c0392b');
  assert.equal(hex(core.themedDoc(doc, doc.nodes.B).tokens.colors.accent), '#c0392b', 'доска видит свой цвет');
  assert.notEqual(hex(doc.tokens.colors.accent), '#c0392b', 'документ не тронут');
  assert.equal(themeColorOps(doc, doc.nodes.B, 'accent', '#c0392b'), null, 'тот же цвет — правки нет');

  const r2 = themeColorOps(doc, doc.nodes.B, 'canvas', '#101418');
  doc = apply(doc, r2);
  const r3 = themeColorOps(doc, doc.nodes.B, 'accent', doc.tokens.colors.accent);
  assert.equal(r3.label, 'Экран «Оплата»: accent — как в документе');
  assert.equal(themeColorOps(doc, doc.nodes.B, 'canvas', '#202020', { title: 'холст' }).label, 'Свой цвет экрана «Оплата»: холст #202020');
  doc = apply(doc, r3);
  assert.deepEqual(Object.keys(core.boardTheme(doc.nodes.B).colors), ['canvas']);
  const r4 = themeColorOps(doc, doc.nodes.B, 'canvas', null);
  assert.deepEqual(r4.ops.map((o) => [o.path, o.value]), [['theme', undefined]], 'последний цвет — снимается вся тема');
  assert.equal(r4.label, 'Экран «Оплата» вернулся к оформлению документа');
  doc = apply(doc, r4);
  assert.equal(doc.nodes.B.theme, undefined, 'пустая тема снята целиком');
  assert.equal(themeColorOps(doc, doc.nodes.B, 'canvas', null), null, 'снимать нечего');
});

test('круг67: шрифты темы остаются; отмена — прежняя тема', () => {
  let doc = docWith({ colors: { accent: '#2f6f62' }, type: { title: { font: 'Prata' } } });
  const before = doc;
  const r = themeColorOps(doc, doc.nodes.B, 'accent', null);
  assert.deepEqual(r.ops.map((o) => o.path), ['theme.colors'], 'цвета опустели, шрифты есть — снимаются только цвета');
  doc = apply(doc, r);
  assert.deepEqual(core.boardTheme(doc.nodes.B), { type: { title: { font: 'Prata' } } });
  const back = core.applyOps(doc, core.invertOps(before, r.ops)).doc;
  assert.deepEqual(back.nodes.B.theme, before.nodes.B.theme);
});

test('круг67: мусор — null; контраст после правки — предупреждение', () => {
  const doc = docWith(null);
  for (const v of ['красный', '#12', 'url(x)', 42]) assert.equal(themeColorOps(doc, doc.nodes.B, 'accent', v), null, String(v));
  assert.equal(themeColorOps(doc, null, 'accent', '#000000'), null);
  assert.equal(themeColorOps(doc, doc.nodes.B, '', '#000000'), null);
  for (const bad of ['__proto__', 'constructor', '1x', 'с пробелом']) assert.equal(themeColorOps(doc, doc.nodes.B, bad, '#000000'), null, bad);
  const dark = themeColorOps(doc, doc.nodes.B, 'canvas', doc.tokens.colors.text);
  assert.ok(dark.warnings.some((w) => /текст на фоне экрана читается плохо/.test(w)), JSON.stringify(dark.warnings));
  const fine = themeColorOps(doc, doc.nodes.B, 'line', '#000000');
  assert.deepEqual(fine.warnings, [], 'линия в проверяемые пары не входит');
  const onAccent = themeColorOps(doc, doc.nodes.B, 'accent', doc.tokens.colors.onAccent);
  assert.ok(onAccent.warnings.some((w) => /текст на акценте читается плохо/.test(w)), JSON.stringify(onAccent.warnings));
});

test('круг67: фон контраста — заливка доски; правки двух цветов с двух вкладок не затирают друг друга', () => {
  // доска залита карточкой: холст на ней не виден — о нём не предупреждаем
  let doc = core.applyOps(docWith(null), [core.ops.set('B', 'fill', 'surface')]).doc;
  assert.deepEqual(themeColorOps(doc, doc.nodes.B, 'canvas', doc.tokens.colors.text).warnings, []);
  assert.ok(themeColorOps(doc, doc.nodes.B, 'surface', doc.tokens.colors.text).warnings.some((w) => /на фоне экрана/.test(w)));
  // две вкладки от одного документа: правки по путям сходятся в одну тему
  const a = themeColorOps(doc, doc.nodes.B, 'accent', '#c0392b');
  const b = themeColorOps(doc, doc.nodes.B, 'text', '#101010');
  doc = apply(apply(doc, a), b);
  assert.deepEqual(core.boardTheme(doc.nodes.B).colors, { accent: '#c0392b', text: '#101010' });
});

test('круг67: общий цвет с прозрачностью не равен выбору; не кодом и не латиницей — без поля', () => {
  let doc = docWith(null);
  const toks = { ...doc.tokens.colors, accentSoft: '#ff000080', фон: '#123456', named: 'red' };
  doc = { ...doc, tokens: { ...doc.tokens, colors: toks } };
  const rows = boardColorRows(doc, doc.nodes.B);
  const soft = rows.find((r) => r.name === 'accentSoft');
  assert.deepEqual([soft.hex, soft.docHex, soft.alpha, soft.editable], ['#ff0000', null, true, true]);
  const r = themeColorOps(doc, doc.nodes.B, 'accentSoft', '#ff0000');
  assert.ok(r && r.ops[0].value === '#ff0000', 'непрозрачный — свой цвет, а не «как в документе»');
  assert.equal(rows.find((x) => x.name === 'фон').editable, false);
  assert.equal(rows.find((x) => x.name === 'named').hex, null);
  assert.equal(themeColorOps(doc, doc.nodes.B, 'фон', '#000000'), null);
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

test('круг67: в браузере — цвет экрана из инспектора ложится в тему доски, отмена — назад', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    // доска — первая строка верхнего уровня в слоях
    await page.locator('#layers .layer[data-id]').first().click();
    await page.waitForFunction(() => /Тема экрана/i.test(document.getElementById('inspector').innerText), null, { timeout: 10000 });
    const own = () => page.locator('#inspector .theme-color-row.own').count();
    assert.equal(await own(), 0, 'у демо-доски своей темы нет');
    await page.locator('#inspector .theme-colors > summary').click();
    const set = (name, hex) => page.evaluate(([name, hex]) => {
      const inp = document.querySelector(`#inspector .theme-color-row[data-token="${name}"] input[type=color]`);
      inp.value = hex;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, [name, hex]);
    await set('accent', '#c0392b');
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1, null, { timeout: 5000 });
    assert.match(await page.locator('#inspector .theme-colors > summary').innerText(), /своих 1/);
    assert.equal(await page.locator('#inspector .theme-colors').evaluate((d) => d.open), true, 'после правки список раскрыт');
    assert.match(await page.locator('#inspector .theme-color-row.own').innerText(), /акцент\s*своё/);
    assert.equal(await page.locator('#inspector .theme-color-row.own').getAttribute('data-token'), 'accent');
    // общий цвет фона — тексту, контраст — предупреждением
    // фон демо-доски — карточка: её и красим цветом текста
    const text = await page.locator('#inspector .theme-color-row[data-token="text"] input[type=color]').inputValue();
    await set('surface', text);
    await page.waitForFunction(() => /текст на фоне экрана читается плохо/.test(document.body.innerText), null, { timeout: 5000 });
    // свёрнутый человеком список остаётся свёрнутым после правки
    await page.locator('#inspector .theme-colors > summary').click();
    assert.equal(await page.locator('#inspector .theme-colors').evaluate((d) => d.open), false);
    await page.keyboard.press('Escape');
    await page.locator('#layers .layer[data-id]').first().click();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 0
      && !/Вернуть общее оформление/.test(document.getElementById('inspector').innerText), null, { timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-colors').evaluate((d) => d.open), false, 'выбор «свёрнуто» помнится');
    // повтор — цвет снова свой
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1, null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
