/**
 * Круг 86 (SPEC §15.22): «привяжи цвета (экрана) к палитре», «переведи цвета в токены», `/привязать цвета` —
 * то же, что кнопка «Привязать к палитре» (§15.21), словами, для активного экрана; модель не зовётся.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { shellIntent, commandIdOf, SHELL_COMMANDS as COMMANDS } from '../src/shell.js';

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

test('круг86: фразы и слэш — привязка цветов; соседние фразы — нет', () => {
  for (const u of ['привяжи цвета к палитре', 'Привяжи цвета экрана к палитре', 'переведи цвета в токены', 'привязать цвета к цветам документа',
    'привяжи все цвета этого экрана к палитре', '/привязать цвета', '/bind colors']) {
    const it = shellIntent(u, {});
    assert.equal(it && it.kind, 'bind-colors', u);
    assert.equal(commandIdOf(it), 'bind-colors', u);
  }
  for (const u of ['привяжи кнопку к палитре', 'переведи текст на английский', 'цвета экрана к палитре', 'привяжи цвета кнопки к палитре'])
    assert.notEqual((shellIntent(u, {}) || {}).kind, 'bind-colors', u);
  assert.ok(COMMANDS.some((c) => c.id === 'bind-colors' && c.edit === true));
  // критик: «к палитре документа», «в токены палитры», «к цветам палитры» — тоже привязка
  for (const u of ['привяжи цвета к палитре документа', 'переведи цвета в токены палитры', 'привяжи цвета к цветам палитры'])
    assert.equal((shellIntent(u, {}) || {}).kind, 'bind-colors', u);
});

test('круг86, критик: в занятом агенте не спрашивает, двойного сообщения нет, библиотека — отказ', async () => {
  const app = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8');
  assert.match(app, /SHELL_WHILE_BUSY = new Set\([^)]*'bind-colors'/);
  const body = app.slice(app.indexOf("case 'bind-colors':"), app.indexOf("case 'select': {", app.indexOf("case 'bind-colors':")));
  assert.match(body, /commit\(r\.ops, r\.label, 'human', \{ quiet: true \}\)/);
  assert.match(body, /res\.ok === false\) return true/);
  assert.match(body, /inLibrary\(state\.selection\[0\]\)/);
  // в группе «Правка» команда не первая
  const edits = COMMANDS.filter((c) => c.group === 'Правка').map((c) => c.id);
  assert.ok(edits.indexOf('bind-colors') > edits.indexOf('gap-less'), edits.join(','));
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

test('круг86: в браузере — «привяжи цвета к палитре» на импортированном экране, второй раз — нечего', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); };
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await say('/импорт');
    await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screen(null))) });
    await page.locator('#layers .layer[data-id="B"]').click();
    await page.locator('#inspector .theme-hex').waitFor({ timeout: 10000 });
    await say('привяжи цвета к палитре');
    await page.waitForFunction(() => !document.querySelector('#inspector .theme-hex'), null, { timeout: 5000 });
    await page.waitForFunction(() => /цвета 4 слоёв привязаны к палитре/.test(document.body.innerText), null, { timeout: 5000 });
    await page.waitForTimeout(400);   // строка не принимает два Enter подряд быстрее 250 мс
    await say('привяжи цвета к палитре');
    await page.waitForFunction(() => /нет цветов кодом, равных цветам палитры/.test(document.body.innerText), null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
