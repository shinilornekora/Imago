/**
 * Круг 82 (SPEC §15.18): щелчок по метке своей темы в списке слоёв — экран выделен, его «Тема экрана»
 * в инспекторе раскрыта (свои цвета, а при одних шрифтах — «Шрифты по стилям») и прокручена в вид.
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

test('круг82: в браузере — щелчок по метке темы выделяет экран и раскрывает его тему', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    assert.ok(boards.length >= 2, boards.join());
    const [a, b] = boards;
    await page.locator(`#layers .layer[data-id="${a}"]`).click();
    await page.locator('#inspector .theme-colors > summary').click();
    await page.evaluate(() => {
      const inp = document.querySelector('#inspector .theme-color-row[data-token="accent"] input[type=color]');
      inp.value = '#c0392b';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const pill = page.locator(`#layers .layer[data-id="${a}"] .tagpill.theme`);
    await pill.waitFor({ timeout: 5000 });
    // человек свернул список и ушёл на другой экран
    await page.locator('#inspector .theme-colors > summary').click();
    assert.equal(await page.locator('#inspector .theme-colors').evaluate((d) => d.open), false);
    await page.locator(`#layers .layer[data-id="${b}"]`).click();
    await page.waitForFunction((b) => document.querySelector(`#layers .layer[data-id="${b}"]`).getAttribute('aria-selected') === 'true', b);
    await page.evaluate(() => { document.getElementById('inspector').scrollTop = 0; });
    await pill.click();
    await page.waitForFunction((a) => document.querySelector(`#layers .layer[data-id="${a}"]`).getAttribute('aria-selected') === 'true', a, { timeout: 5000 });
    assert.equal(await page.locator('#inspector .theme-colors').evaluate((d) => d.open), true, 'метка раскрывает свои цвета');
    assert.equal(await page.locator('#inspector [data-group="theme"]').count(), 1);
    await page.waitForFunction(() => {
      const box = document.getElementById('inspector').getBoundingClientRect();
      const g = document.querySelector('#inspector [data-group="theme"]').getBoundingClientRect();
      return g.top < box.bottom && g.bottom > box.top;
    }, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.closest('#layers') !== null), true, 'фокус — в рельсе, на строке экрана');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
