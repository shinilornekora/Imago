/**
 * Круг 85 (SPEC §15.21): цвета экрана кодом (#hex) тема не перекрашивает. Те, что совпадают ровно с одним
 * цветом палитры (какой её видит экран), привязываются к токену одной правкой — вид экрана прежний.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { boardHexRefs, bindBoardColorsOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screen(theme, extra = []) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [
    core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, fill: '#FFFFFF', ...(theme ? { theme } : {}), children: [] }),
    core.ops.create({ id: 'btn', type: 'frame', name: 'Кнопка', parent: 'B', fill: '#ff6b3d', stroke: { color: '#E2DED6', width: 1 },
      states: { hover: { fill: '#B03A12' } }, children: [] }),
    core.ops.create({ id: 'bt', type: 'text', name: 'Подпись', parent: 'btn', characters: 'Оплатить', color: '#14161C' }),
    core.ops.create({ id: 'h', type: 'text', name: 'Заголовок', parent: 'B', characters: 'Итого', color: { color: '#14161c' } }),
    core.ops.create({ id: 'odd', type: 'frame', name: 'Свой', parent: 'B', fill: '#123456', children: [] }),
    core.ops.create({ id: 'g', type: 'frame', name: 'Градиент', parent: 'B', fill: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#FF6B3D' }, { at: 1, color: '#FFFFFF' }] } }, children: [] }),
    core.ops.create({ id: 'tok', type: 'frame', name: 'Токен', parent: 'B', fill: 'surfaceAlt', children: [] }),
    ...extra,
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const paint = (doc, id, path) => { const d = core.themeScope(doc)(id); const n = doc.nodes[id];
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), n); return core.resolveColor(d, v); };

test('круг85: коды, совпавшие с палитрой, — к токену; текст на акценте — «на акценте»; вид прежний', () => {
  const doc = screen(null);
  const { refs, ambiguous } = boardHexRefs(doc, doc.nodes.B);
  const by = Object.fromEntries(refs.map((r) => [`${r.id}:${r.path}`, r.token]));
  assert.deepEqual(by, { 'B:fill': 'surface', 'btn:fill': 'accent', 'btn:stroke.color': 'line', 'btn:states.hover.fill': 'accentInk', 'bt:color': 'onAccent', 'h:color': 'text' });
  assert.equal(ambiguous, 0);
  const r = bindBoardColorsOps(doc, doc.nodes.B);
  assert.equal(r.label, 'Экран «Оплата»: цвета 4 слоёв привязаны к палитре');
  const after = core.applyOps(doc, r.ops);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  for (const [k] of Object.entries(by)) {
    const [id, path] = k.split(':');
    assert.equal(paint(after.doc, id, path), paint(doc, id, path), `${k}: вид прежний`);
  }
  assert.deepEqual(after.doc.nodes.h.color, { token: 'text' }, 'форма {color} → {token}');
  assert.equal(after.doc.nodes.odd.fill, '#123456', 'цвета вне палитры — как были');
  assert.deepEqual(after.doc.nodes.g.fill, doc.nodes.g.fill, 'градиент не трогаем');
  assert.equal(bindBoardColorsOps(after.doc, after.doc.nodes.B), null, 'второй раз — нечего');
});

test('круг85: палитра — какой её видит экран: свой акцент темы — к токену, акцент документа под темой — нет', () => {
  const doc = screen({ colors: { accent: '#c0392b' } }, [core.ops.create({ id: 'own', type: 'frame', name: 'Свой акцент', parent: 'B', fill: '#C0392B', children: [] })]);
  const by = Object.fromEntries(boardHexRefs(doc, doc.nodes.B).refs.map((r) => [r.id + ':' + r.path, r.token]));
  assert.equal(by['own:fill'], 'accent');
  assert.equal(by['btn:fill'], undefined, '#ff6b3d под темой экрана — уже не «акцент»');
  // и после привязки тема перекрашивает слой
  const after = core.applyOps(doc, bindBoardColorsOps(doc, doc.nodes.B).ops).doc;
  const re = core.applyOps(after, [core.ops.set('B', 'theme.colors.accent', '#2266dd')]).doc;
  assert.equal(paint(re, 'own', 'fill'), '#2266dd');
});

test('круг85: неоднозначный код не трогаем; экземпляр и библиотека — мимо', () => {
  const doc = screen(null);
  const d2 = core.applyOps(doc, [core.ops.setToken('colors.brand', '#FF6B3D')]).doc;
  const res = boardHexRefs(d2, d2.nodes.B);
  assert.equal(res.refs.some((r) => r.id === 'btn' && r.path === 'fill'), false);
  assert.ok(res.ambiguous >= 1);
  assert.deepEqual(boardHexRefs(doc, doc.nodes.btn).refs, [], 'не доска — пусто');
  assert.equal(bindBoardColorsOps(doc, null), null);
});

test('круг85, критик: токен только из темы — нет; #rrggbbaa — нет; контуры вектора — да; обводка не «текст»', () => {
  const doc = screen({ colors: { brand: '#123456' } }, [
    core.ops.create({ id: 'semi', type: 'frame', name: 'Полупрозрачный', parent: 'B', fill: '#FF6B3DCC', children: [] }),
    core.ops.create({ id: 'opaque', type: 'frame', name: 'Непрозрачный', parent: 'B', fill: '#FFE7DEFF', children: [] }),
    core.ops.create({ id: 'v', type: 'vector', name: 'Значок', parent: 'B', viewBox: { w: 10, h: 10 }, paths: [{ d: 'M0 0L10 10', fill: '#FF6B3D' }] }),
    core.ops.create({ id: 'ln', type: 'frame', name: 'Рамка', parent: 'B', stroke: { color: '#14161C', width: 1 }, children: [] }),
  ]);
  const by = Object.fromEntries(boardHexRefs(doc, doc.nodes.B).refs.map((r) => [r.id + ':' + r.path, r.token]));
  assert.equal(by['odd:fill'], undefined, '#123456 = brand только в теме — не привязываем');
  assert.equal(by['semi:fill'], undefined);
  assert.equal(by['opaque:fill'], 'accentSoft');
  assert.equal(by['v:paths.0.fill'], 'accent');
  assert.equal(by['ln:stroke.color'], undefined, 'обводка цвета текста — неоднозначна, не «текст»');
  const after = core.applyOps(doc, bindBoardColorsOps(doc, doc.nodes.B).ops);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.equal(after.doc.nodes.v.paths[0].fill, 'accent');
  // тот же документ — тот же ответ (память на перерисовки инспектора)
  assert.equal(boardHexRefs(doc, doc.nodes.B), boardHexRefs(doc, doc.nodes.B));
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

test('круг85: в браузере — экран с цветами кодом: «Привязать к палитре» в теме экрана, отмена', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    // документ со слоями, окрашенными кодом (как собирали доски круга 47), — импортом файла
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.locator('#command').fill('/импорт');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screen(null))) });
    await page.locator('#layers .layer[data-id="B"]').waitFor({ timeout: 10000 });
    await page.locator('#layers .layer[data-id="B"]').click();
    const btn = page.locator('#inspector .theme-hex button');
    await btn.waitFor({ timeout: 5000 });
    assert.match(await page.locator('#inspector .theme-hex .note').innerText(), /^4 слоя окрашены кодом цвета/);
    await btn.click();
    await page.waitForFunction(() => !document.querySelector('#inspector .theme-hex'), null, { timeout: 5000 });
    await page.keyboard.press('Control+z');
    await page.locator('#inspector .theme-hex button').waitFor({ timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
