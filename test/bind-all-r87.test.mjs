/**
 * Круг 87 (SPEC §15.23): «привяжи цвета всех экранов к палитре», `/привязать все цвета` — привязка §15.21
 * на каждом экране документа одной правкой: у каждого экрана — его палитра (с темой), библиотека — не экран.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { shellIntent, commandIdOf, bindAllColorsOps, SHELL_COMMANDS as COMMANDS } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const lib = base.nodes[base.root].children.find((id) => base.nodes[id].role === 'library');
  const r = core.applyOps(base, [
    core.ops.create({ id: 'A', type: 'frame', name: 'Оплата', parent: base.root, fill: '#FFFFFF', children: [] }),
    core.ops.create({ id: 'a1', type: 'frame', name: 'Кнопка', parent: 'A', fill: '#ff6b3d', children: [] }),
    core.ops.create({ id: 'a2', type: 'text', name: 'Подпись', parent: 'A', characters: 'Итого', color: '#5B6270' }),
    core.ops.create({ id: 'B', type: 'frame', name: 'Итог', parent: base.root, fill: 'surface', theme: { colors: { accent: '#ff4f6d' } }, children: [] }),
    core.ops.create({ id: 'b1', type: 'frame', name: 'Кнопка', parent: 'B', fill: '#FF4F6D', children: [] }),
    core.ops.create({ id: 'b2', type: 'frame', name: 'Старый акцент', parent: 'B', fill: '#ff6b3d', children: [] }),
    core.ops.create({ id: 'C', type: 'frame', name: 'Профиль', parent: base.root, fill: 'canvas', children: [] }),
    core.ops.create({ id: 'L1', type: 'frame', name: 'Мастер', parent: lib, fill: '#ff6b3d', children: [] }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг87: все экраны одной правкой — у каждого своя палитра, библиотека не тронута', () => {
  const doc = screens();
  const r = bindAllColorsOps(doc);
  assert.deepEqual(r.ops.map((o) => [o.id, o.path, o.value]).sort(), [
    ['A', 'fill', 'surface'], ['a1', 'fill', 'accent'], ['a2', 'color', 'muted'], ['b1', 'fill', 'accent'],
  ].sort());
  assert.deepEqual(r.boards.map((b) => [b.id, b.n]), [['A', 3], ['B', 1]]);
  assert.equal(r.label, 'Цвета 4 слоёв на 2 экранах привязаны к палитре: «Оплата», «Итог»');
  // вид прежний: «Старый акцент» на «Итоге» — код, не токен (у экрана акцент другой)
  const after = core.applyOps(doc, r.ops).doc;
  assert.equal(after.nodes.b2.fill, '#ff6b3d');
  assert.equal(after.nodes.L1.fill, '#ff6b3d', 'мастер библиотеки не тронут');
  // второй раз — нечего; одна отмена возвращает всё
  assert.equal(bindAllColorsOps(after).ops.length, 0);
  const back = core.applyOps(after, core.invertOps(doc, r.ops)).doc;
  for (const id of ['A', 'a1', 'a2', 'b1']) assert.deepEqual(back.nodes[id], doc.nodes[id], id);
  // один экран — фраза одного экрана
  const one = bindAllColorsOps(core.applyOps(doc, [core.ops.set('b1', 'fill', 'accent')]).doc);
  assert.equal(one.label, 'Экран «Оплата»: цвета 3 слоёв привязаны к палитре');
});

test('круг87: фразы и слэш — все экраны; фразы одного экрана — по-прежнему один', () => {
  for (const u of ['привяжи цвета всех экранов к палитре', 'Привяжи цвета на всех экранах к палитре', 'переведи цвета документа в токены',
    'привяжи все цвета во всём документе к палитре', 'привязать цвета всех досок к палитре документа', '/привязать все цвета', '/bind all colors']) {
    const it = shellIntent(u, {});
    assert.deepEqual(it, { kind: 'bind-colors', all: true }, u);
    assert.equal(commandIdOf(it), 'bind-colors-all', u);
  }
  for (const u of ['привяжи цвета к палитре', 'привяжи цвета экрана к палитре', '/привязать цвета'])
    assert.equal(commandIdOf(shellIntent(u, {})), 'bind-colors', u);
  for (const u of ['привяжи цвета всех кнопок к палитре', 'цвета всех экранов к палитре'])
    assert.equal(shellIntent(u, {}), null, u);
  assert.ok(COMMANDS.some((c) => c.id === 'bind-colors-all' && c.edit === true && c.group === 'Правка'));
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

test('круг87: в браузере — все экраны разом, одна отмена', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await say('/импорт');
    await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screens())) });
    await page.locator('#layers .layer[data-id="A"]').waitFor({ timeout: 10000 });
    await say('привяжи цвета всех экранов к палитре');
    await page.waitForFunction(() => /Цвета 4 слоёв на 2 экранах привязаны к палитре/.test(document.body.innerText), null, { timeout: 5000 });
    await page.locator('#layers .layer[data-id="B"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#inspector .theme-hex').count(), 0, 'на «Итоге» кодов, равных палитре, не осталось');
    await say('отмени');
    await page.locator('#inspector .theme-hex').waitFor({ timeout: 5000 });
    await page.locator('#layers .layer[data-id="A"]').click();
    await page.locator('#inspector .theme-hex').waitFor({ timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
