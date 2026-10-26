/**
 * Круг 58 (SPEC §21.5): картинка, вставленная или брошенная в строку команды, — образец для этой
 * команды: отдельной доской на макете, выделена, а в строке — слова об образце (без них §21 образца
 * не берёт). Текст из буфера вставляется в строку как обычно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { RE_IMAGE_REF } from '../src/brain.js';
import { referenceCommandText, REFERENCE_WORDS } from '../src/shell.js';

test('круг58: слова об образце — дописываются, если их нет; пустая строка — курсор в начало', () => {
  assert.deepEqual(referenceCommandText(''), { value: ` ${REFERENCE_WORDS}`, caret: 0 });
  assert.deepEqual(referenceCommandText('   '), { value: ` ${REFERENCE_WORDS}`, caret: 0 });
  assert.deepEqual(referenceCommandText(null), { value: ` ${REFERENCE_WORDS}`, caret: 0 });
  const a = referenceCommandText('собери экран кофейни');
  assert.equal(a.value, `собери экран кофейни ${REFERENCE_WORDS}`);
  assert.equal(a.caret, a.value.length);
  assert.equal(referenceCommandText('собери экран, ').value, `собери экран ${REFERENCE_WORDS}`);
  // слова уже есть — не трогаем
  for (const said of ['сделай как на картинке', 'собери экран в стиле этого фото', 'возьми цвета с картинки']) {
    assert.equal(referenceCommandText(said).value, said);
  }
  // то, что получится, когда человек допишет начало, — образец по §21
  for (const typed of ['собери экран кофейни', 'лендинг студии йоги']) {
    const r = referenceCommandText('');
    const full = (typed + r.value.slice(r.caret)).trim();
    assert.ok(RE_IMAGE_REF.test(full), full);
    assert.ok(RE_IMAGE_REF.test(referenceCommandText(typed).value));
  }
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

test('круг58: в браузере — картинка в строку команды ложится образцом, текст из буфера — в строку', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.fill('#command', 'собери экран кофейни');
    await page.focus('#command');
    const paste = (withText) => page.evaluate(async (withText) => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 20;
      const g = c.getContext('2d'); g.fillStyle = '#3b2418'; g.fillRect(0, 0, 40, 20);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      if (withText) dt.setData('text/plain', 'просто текст');
      dt.items.add(new File([blob], 'образец.png', { type: 'image/png' }));
      const el = document.getElementById('command');
      return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, withText);
    // текст и картинка вместе (скопировано со страницы) — вставка текста, образца нет
    assert.equal(await paste(true), true, 'вставку текста не перехватываем');
    await page.waitForTimeout(400);
    assert.ok(!/Образец на макете/.test(await page.evaluate(() => document.body.innerText)));
    // одна картинка — образец
    assert.equal(await paste(false), false, 'картинку перехватили');
    await page.waitForFunction(() => /Образец на макете/.test(document.body.innerText), null, { timeout: 10000 });
    assert.equal(await page.inputValue('#command'), 'собери экран кофейни в цветах этой картинки');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'command');
    // не картинка на строку — понятный отказ, браузер файл не открывает
    const dropped = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'заметка.txt', { type: 'text/plain' }));
      const el = document.getElementById('command');
      const at = { bubbles: true, cancelable: true, dataTransfer: dt };
      el.dispatchEvent(new DragEvent('dragover', at));
      return el.dispatchEvent(new DragEvent('drop', at));
    });
    assert.equal(dropped, false);
    await page.waitForFunction(() => /образцом не станет/.test(document.body.innerText), null, { timeout: 5000 });
    await page.click('#btn-history');
    await page.waitForTimeout(600);
    const hist = await page.locator('#sheet-body').innerText();
    assert.ok(/образец/.test(hist), hist);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
