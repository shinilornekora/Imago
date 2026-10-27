/**
 * Круг 84 (SPEC §15.20): экспорт SVG экрана со своей темой — в файле его цвета и шрифты, а не
 * документа (как на холсте). Проверка в браузере: свой акцент и свой шрифт заголовков → «экспорт svg».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

test('круг84: в браузере — SVG экрана со своей темой несёт её акцент и шрифт', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.locator('#layers .layer[data-id]').first().click();
    const before = await page.evaluate(() => document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]')?.value);
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => {
      const inp = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]');
      inp.value = '#c0392b';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#inspector .theme-color-row.own').length === 1, null, { timeout: 5000 });
    await page.locator('#inspector details.theme-styles summary').click();
    await page.locator('#inspector .theme-style-row[data-style="title"] select.theme-style-font').selectOption('Lora');
    await page.waitForFunction(() => document.querySelector('#inspector .theme-style-row[data-style="title"]').classList.contains('own'), null, { timeout: 5000 });
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#command').fill('экспорт svg');
    await page.keyboard.press('Enter');
    const svg = await readFile(await (await dl).path(), 'utf8');
    assert.match(svg, /#c0392b/i, 'свой акцент экрана — в файле');
    assert.ok(before && !new RegExp(before, 'i').test(svg), `акцент документа ${before} в файле не остался`);
    assert.match(svg, /font-family="Lora,/, 'свой шрифт заголовков — в файле');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
