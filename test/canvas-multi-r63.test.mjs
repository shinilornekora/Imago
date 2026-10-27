/**
 * Круг 63 (SPEC §21.7): несколько картинок, брошенных на холст. Мимо досок — одной доской «Картинки»
 * (мудборд, §21.6) в точке броска, без слов в строке команды; на доску — все в неё одной правкой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { moodboardOps } from '../src/shell.js';

test('круг63: имя доски мудборда — своё или «Образец»', () => {
  const doc = (() => { const w = console.warn; console.warn = () => {}; try { return core.createDoc('empty'); } finally { console.warn = w; } })();
  const SRC = 'data:image/png;base64,iVBORw0KGgo=';
  const images = [{ src: SRC, width: 10, height: 10 }, { src: SRC + 'AAAA', width: 10, height: 10 }];
  const ids = { board: 'B', images: ['a', 'b'] };
  const named = moodboardOps(doc, { images, at: { x: 0, y: 0 }, ids, name: 'Картинки' });
  assert.equal(named.ops[0].node.name, 'Картинки');
  assert.equal(moodboardOps(doc, { images, at: { x: 0, y: 0 }, ids }).ops[0].node.name, 'Образец');
  assert.equal(moodboardOps(doc, { images, at: { x: 0, y: 0 }, ids, name: '  ' }).ops[0].node.name, 'Образец');
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

test('круг63: в браузере — две картинки мимо досок ложатся доской «Картинки», на доску — обе в неё, отмена целиком', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const drop = (where) => page.evaluate(async (where) => {
      const dt = new DataTransfer();
      for (const [name, color] of [['зал.png', '#3b2418'], ['стол.png', '#c9a77c']]) {
        const c = document.createElement('canvas'); c.width = 60; c.height = 40;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 60, 40);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        dt.items.add(new File([blob], name, { type: 'image/png' }));
      }
      const canvas = document.getElementById('canvas') || document.querySelector('canvas');
      let x; let y;
      if (where === 'board') {
        const ab = document.querySelector('.imago-ab');
        const r = ab.getBoundingClientRect();
        x = r.left + r.width / 2; y = r.top + Math.min(r.height / 2, 40);
      } else {
        const r = canvas.getBoundingClientRect();
        x = r.left + 5; y = r.bottom - 5;
      }
      const at = { clientX: x, clientY: y, bubbles: true, cancelable: true, dataTransfer: dt };
      canvas.dispatchEvent(new DragEvent('dragover', at));
      canvas.dispatchEvent(new DragEvent('drop', at));
      return !!document.querySelector('.imago-ab');
    }, where);
    const layers = () => page.locator('#layers').innerText();
    const before = await page.inputValue('#command');
    await drop('empty');
    await page.waitForFunction(() => /2 картинки легли одной доской/.test(document.body.innerText), null, { timeout: 10000 });
    assert.match(await page.evaluate(() => document.body.innerText), /в цветах этих картинок/);
    assert.equal(await page.inputValue('#command'), before, 'строку команды не трогаем');
    let tree = await layers();
    assert.ok(/Картинки/.test(tree) && /Ряд 1/.test(tree), tree);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    assert.ok(!/Ряд 1/.test(await layers()), 'отменилось целиком');
    // на доску — обе в неё
    assert.equal(await drop('board'), true, 'на холсте есть доска');
    await page.waitForFunction(() => /2 картинки на доске/.test(document.body.innerText), null, { timeout: 10000 });
    tree = await layers();
    assert.ok(/зал/.test(tree) && /стол/.test(tree) && !/Ряд 1/.test(tree), tree);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    tree = await layers();
    assert.ok(!/зал/.test(tree) && !/стол/.test(tree), 'обе ушли одной отменой');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
