/**
 * Круг 90: сквозная проверка кругов 81–89 вместе — предложение §15.25 и у правки агента на сервере,
 * закрывается заменой документа; кнопка «Привязать к палитре» говорит тостом, как команда; слэш
 * «/выделить экраны со своей темой» — то же, что словами (§15.19).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { shellIntent } from '../src/shell.js';

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

test('круг90: слэш «/выделить экраны со своей темой» — экраны со своей темой, а не слой по имени', () => {
  const doc = screens();
  const it = shellIntent('/выделить экраны со своей темой', { doc });
  assert.equal(it.kind, 'select');
  assert.equal(it.themed, true);
  assert.deepEqual(it.ids, ['B']);
  assert.equal(shellIntent('/выделить кнопка', { doc }).kind !== 'select' || !shellIntent('/выделить кнопка', { doc }).themed, true);
});

test('круг90: исходник — предложение и у правки агента с сервера, замена документа его закрывает', async () => {
  const app = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8');
  assert.match(app, /onAgentTx\(info\.tx, prevDoc, diff, !!info\.mine\);\s*\/\/[^\n]*\n\s*if \(info\.mine && !backlog\) offerStaleHex\(prevDoc\);/);
  assert.match(app, /if \(extra\.system \|\| extra\.doc\) \{ dropStaleHexToast\(\); return; \}/);
  assert.match(app, /async function loadSoloProject\([^)]*\) \{\s*dropStaleHexToast\(\);/);
  assert.match(app, /case 'open': \{\s*dropStaleHexToast\(\);/);
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

test('круг90: в браузере — кнопка одного экрана говорит тостом; импорт закрывает предложение перекрасить', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const load = async () => {
      const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
      await say('/импорт');
      await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screens())) });
    };
    await load();
    await page.locator('#layers .layer[data-id="A"]').click();
    await page.locator('#inspector .theme-hex button').first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Экран «Оплата»: цвета 3 слоёв привязаны к палитре/.test(t.innerText)), null, { timeout: 5000 });
    // предложение перекрасить — и импорт другого документа его закрывает
    await page.locator('#layers .layer[data-id="B"]').click();
    const row = page.locator('#inspector .theme-color-row[data-token="accent"] input.paint-color-input');
    await row.waitFor({ timeout: 10000 });
    await row.evaluate((el) => { el.value = '#2255ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('.toast.stale-hex').waitFor({ timeout: 5000 });
    await load();
    await page.waitForFunction(() => !document.querySelector('.toast.stale-hex'), null, { timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
