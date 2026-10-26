/**
 * Круг 45 (UX r45 Д1) — дымовой прогон оболочки в настоящем браузере: «История» после своей
 * правки рисуется целиком и без ошибок страницы. Юнит-тесты `SHELL.historyOrder` не видели, что
 * `fillEdits` в app.js ссылался на необъявленную переменную: панель обрывалась на первой своей
 * правке. Браузера (Playwright) нет — тест пропускается.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
// Playwright — глобальный пакет стенда (require ищет и по NODE_PATH), в зависимостях проекта его нет
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Статика репозитория; /api, /ws и /agent — 404: оболочка работает без сервера (проекты в браузере). */
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/(api|ws|agent)(\/|$)/.test(path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":true,"code":"not_found"}'); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('r45: «История» после своей правки — своя строка с меткой «документ сейчас здесь», без ошибок страницы', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1500);
    // правка руками через таблицу команд: выделить всё на доске и скрыть
    for (const text of ['/выделить всё', '/скрыть']) {
      await page.fill('#command', text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    await page.click('#btn-history');
    await page.waitForTimeout(800);
    const items = await page.locator('#sheet-body .hitem').count();
    const now = await page.locator('#sheet-body .hnow').count();
    assert.deepEqual(errors, [], 'ошибок страницы нет');
    assert.ok(items >= 1, 'своя правка в ленте');
    assert.equal(now, 1, 'метка «документ сейчас здесь» у последней правки');
  } finally {
    await browser.close();
    srv.close();
  }
});
