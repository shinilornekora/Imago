/**
 * Круг 99 (SPEC §15.33): цвета палитры документа словами — без модели и без шторки: завести, поменять код,
 * переименовать, удалить; «фирменный цвет» — свой цвет документа, если он один.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { shellIntent, commandIdOf, isShellCommandText } from '../src/shell.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const withColors = (colors) => {
  const d = quiet(() => core.createDoc('empty'));
  return core.applyOps(d, Object.entries(colors).map(([k, v]) => core.ops.setToken(`colors.${k}`, v))).doc;
};
const said = (text, doc) => shellIntent(text, { doc });

test('круг99: фразы — новый цвет, код, имя, удаление; имя — как в палитре, без учёта регистра', () => {
  const d = withColors({ brand: '#7a5cff' });
  assert.deepEqual(said('заведи цвет sky #0af', d), { kind: 'doc-color', act: 'new', name: 'sky', hex: '#0af' });
  assert.equal(said('добавь цвет sky #0af', d), null, '«добавь цвет X #код» без «в палитру» — может быть о слое');
  assert.deepEqual(said('Добавь в палитру новый цвет sea: #0066CC', d), { kind: 'doc-color', act: 'new', name: 'sea', hex: '#0066CC' });
  assert.deepEqual(said('поменяй цвет Brand на #5b3df5', d), { kind: 'doc-color', act: 'set', name: 'brand', hex: '#5b3df5' });
  assert.deepEqual(said('цвет brand #111111.', d), { kind: 'doc-color', act: 'set', name: 'brand', hex: '#111111' });
  assert.deepEqual(said('переименуй цвет brand в brandMain', d), { kind: 'doc-color', act: 'rename', name: 'brand', to: 'brandMain' });
  assert.deepEqual(said('удали из палитры цвет BRAND', d), { kind: 'doc-color', act: 'remove', name: 'brand' });
  assert.equal(commandIdOf(said('удали цвет brand', d)), 'color-remove');
});

test('круг99: «фирменный цвет» — свой цвет, если он один; нет своих — заводим brand; несколько — спросить имя', () => {
  const one = withColors({ brand: '#7a5cff' });
  assert.deepEqual(said('фирменный цвет #5b3df5', one), { kind: 'doc-color', act: 'set', name: 'brand', hex: '#5b3df5', brand: true });
  assert.deepEqual(said('заведи фирменный цвет #5b3df5', one), { kind: 'doc-color', act: 'set', name: 'brand', hex: '#5b3df5', brand: true }, 'уже есть — поменять');
  const none = withColors({});
  assert.deepEqual(said('заведи фирменный цвет #5b3df5', none), { kind: 'doc-color', act: 'new', name: 'brand', hex: '#5b3df5', brand: true });
  assert.match(said('удали фирменный цвет', none).say, /Своих цветов в палитре нет/);
  const two = withColors({ brand: '#7a5cff', sky: '#00aaff' });
  assert.match(said('фирменный цвет #5b3df5', two).say, /несколько \(brand, sky\)/);
  assert.match(said('переименуй фирменный цвет в main', two).say, /назовите цвет по имени/);
});

test('круг99: работа агента остаётся агенту; слэш-формы', () => {
  const d = withColors({ brand: '#7a5cff' });
  for (const t of ['добавь цвет #ff0000', 'покрась кнопку в brand', 'сделай цвет кнопки #fff', 'удали шапку', 'переименуй заголовок в Привет',
    'поменяй цвет заголовка на #333333', 'добавь цвет brand кнопке']) {
    assert.equal(said(t, d), null, `«${t}»`);
  }
  assert.deepEqual(said('/новый цвет sky #0af', d), { kind: 'doc-color', act: 'new', name: 'sky', hex: '#0af' });
  assert.deepEqual(said('/цвет brand #222222', d), { kind: 'doc-color', act: 'set', name: 'brand', hex: '#222222' });
  assert.deepEqual(said('/переименовать цвет кнопки', d), { kind: 'rename', name: 'цвет кнопки' }, 'слой «цвет кнопки» — как раньше');
  assert.deepEqual(said('/переименовать цвет палитры brand main', d), { kind: 'doc-color', act: 'rename', name: 'brand', to: 'main' });
  assert.deepEqual(said('/удалить цвет brand', d), { kind: 'doc-color', act: 'remove', name: 'brand' });
  assert.equal(said('/цвета документа', d).kind, 'sheet', '«/цвета документа» — шторка, не «/цвет»');
  assert.equal(said('/цвет brand', d).kind, 'slash-bad');
  assert.equal(isShellCommandText('заведи цвет sky #0af'), true, 'и без документа — команда оболочки');
});

test('круг99 (критик): латинское имя слоя и роль палитры без «в палитре» — агенту, и на сервере тоже', () => {
  const d = withColors({ brand: '#7a5cff' });
  for (const t of ['поменяй цвет Header на #fff', 'смени цвет CTA на #ff0000', 'сделай цвет title #333', 'цвет Button #fff',
    'удали цвет Button', 'убери цвет Header', 'сделай цвет text #333', 'поставь цвет accent #f00', 'переименуй цвет Header в Top']) {
    assert.equal(said(t, d), null, `«${t}»`);
    assert.equal(isShellCommandText(t), false, `сервер: «${t}»`);
  }
  assert.deepEqual(said('поменяй в палитре цвет accent на #f00', d), { kind: 'doc-color', act: 'set', name: 'accent', hex: '#f00' });
  assert.equal(isShellCommandText('поменяй цвет brand на #fff'), false, 'без документа голое имя — агенту');
  assert.equal(isShellCommandText('удали из палитры цвет brand'), true);
  const noColors = { ...withColors({}), tokens: {} };
  assert.equal(said('заведи фирменный цвет #abc', noColors).act, 'new', 'палитры нет вовсе — заводим');
});

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

test('круг99: в браузере — завести, поменять, переименовать, удалить словами; отмена — шагом', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };
    const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 5000 });
    await say('заведи фирменный цвет #7A5CFF');
    await toast('Новый цвет документа: brand #7A5CFF');
    await say('фирменный цвет #5B3DF5');
    await toast('#5B3DF5');
    await say('переименуй цвет brand в brandMain');
    await toast('переименован в «brandMain»');
    await say('удали из палитры цвет nope');
    await toast('Цвета «nope» в палитре нет');
    await say('/цвета документа');
    const row = (n) => page.locator(`#sheet-body .doc-color-row[data-token="${n}"]`);
    await row('brandMain').waitFor({ timeout: 5000 });
    assert.equal((await row('brandMain').locator('input[type="color"]').inputValue()).toLowerCase(), '#5b3df5');
    await say('удали цвет brandMain');
    await page.waitForFunction(() => !document.querySelector('#sheet-body .doc-color-row[data-token="brandMain"]'), null, { timeout: 5000 });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+z');
    await row('brandMain').waitFor({ timeout: 5000 });
    await page.keyboard.press('Control+z');
    await row('brand').waitFor({ timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
