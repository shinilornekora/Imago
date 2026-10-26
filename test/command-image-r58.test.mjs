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
import * as core from '../src/core.js';
import { RE_IMAGE_REF, runCommand } from '../src/brain.js';
import { referenceCommandText, clipboardTextIsLabel, imageInsertOps, REFERENCE_WORDS } from '../src/shell.js';

test('круг58: слова об образце — дописываются, если их нет; пустая строка — готовая команда с выделенным «экран»', () => {
  for (const empty of ['', '   ', null]) {
    const r = referenceCommandText(empty);
    assert.equal(r.value, `собери экран ${REFERENCE_WORDS}`);
    assert.equal(r.value.slice(r.caret, r.caretEnd), 'экран');
  }
  const a = referenceCommandText('собери экран кофейни');
  assert.equal(a.value, `собери экран кофейни ${REFERENCE_WORDS}`);
  assert.equal(a.caret, a.value.length);
  assert.equal(referenceCommandText('собери экран, ').value, `собери экран ${REFERENCE_WORDS}`);
  // слова уже есть или это команда оболочки — не трогаем
  for (const said of ['сделай как на картинке', 'собери экран в стиле этого фото', 'возьми цвета с картинки', '/экспорт', ' /тема']) {
    assert.equal(referenceCommandText(said).value, said);
  }
});

test('круг58: имя файла или адрес рядом с картинкой в буфере — не текст человека', () => {
  for (const t of ['IMG_0042.PNG', 'Снимок экрана 2026-10-26 в 23.10.png', 'https://example.com/a.jpg', 'file:///Users/me/a.heic']) assert.ok(clipboardTextIsLabel(t), t);
  for (const t of ['', 'собери экран', 'строка\nвторая.png']) assert.ok(!clipboardTextIsLabel(t), t);
});

/* выделенный образец на своей доске, план модели — как у настоящей, которой подсказали «правку» */
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const DIRECTION = { concept: 'Зал', mood: ['тепло'], materials: [{ name: 'дерево', hex: '#3b2418' }], palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' }, fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['x'], composition: 'x', avoid: ['x'] };
const TREE = { type: 'frame', name: 'Студия', children: [{ type: 'text', name: 'Заголовок', text: 'Йога', style: 'display' }] };
function fake(plan) {
  const calls = [];
  return { name: 'fake', calls, async ready() { return true; },
    async complete(messages, schema) {
      calls.push(schema.name);
      const v = { plan, direction: DIRECTION, tree: TREE, patch: { ops: [] } }[schema.name];
      if (!v) throw new Error('нет ответа ' + schema.name);
      return JSON.parse(JSON.stringify(v));
    } };
}
function withReference(doc) {
  const r = imageInsertOps(doc, { selection: [], src: `data:image/png;base64,${DATA}`, width: 300, height: 200, fileName: 'фото.png', at: { x: 2000, y: 0 }, ids: { board: 'REF', image: 'REFI' } });
  return { doc: core.applyOps(doc, r.ops).doc, selection: r.select };
}

test('круг58: команда без глагола об образце — новый экран по нему, даже если план сказал «правка»', async () => {
  for (const typed of ['лендинг студии йоги', 'экран входа', 'сделай карточку товара', 'собери экран']) {
    for (const planned of ['edit', 'create']) {
      const base = (() => { const w = console.warn; console.warn = () => {}; try { return core.createDoc(); } finally { console.warn = w; } })();
      const { doc, selection } = withReference(base);
      const before = core.artboards(doc).length;
      const p = fake({ intent: planned, title: 'Экран', summary: 'Соберу экран', steps: ['Шапка'] });
      const said = referenceCommandText(typed).value;
      const res = await runCommand({ doc, selection, utterance: said, provider: p, engine: core, critic: false });
      assert.equal(res.error, undefined, `${said}: ${JSON.stringify(res.error)}`);
      assert.ok(p.calls.includes('direction') && p.calls.includes('tree'), `${said} / ${planned}: ${p.calls}`);
      assert.ok(!p.calls.includes('patch'), 'картинку не правят');
      assert.equal(core.artboards(res.preview.doc).length, before + 1, `${said}: новой доской`);
    }
  }
});

test('круг58: явная правка, вопрос — остаются собой и при выделенном образце', async () => {
  const { doc, selection } = withReference((() => { const w = console.warn; console.warn = () => {}; try { return core.createDoc('empty'); } finally { console.warn = w; } })());
  const p = fake({ intent: 'edit', title: 'Правка', summary: 'Поменяю', steps: ['Фон'] });
  const res = await runCommand({ doc, selection, utterance: 'поменяй фон доски в цветах этой картинки', provider: p, engine: core, critic: false });
  assert.ok(!p.calls.includes('tree'), `правка, а не новый экран: ${p.calls}`);
  assert.ok(res);
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
    const paste = (withText, name = 'фото.png') => page.evaluate(async ([withText, name]) => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 20;
      const g = c.getContext('2d'); g.fillStyle = '#3b2418'; g.fillRect(0, 0, 40, 20);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      if (withText) dt.setData('text/plain', withText);
      dt.items.add(new File([blob], name, { type: 'image/png' }));
      const el = document.getElementById('command');
      return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [withText, name]);
    const msg = () => page.evaluate(() => document.body.innerText);
    // пустая строка: готовая команда, «экран» выделено — впечатать предмет поверх
    await page.fill('#command', '');
    await page.focus('#command');
    // текст человека вместе с картинкой (скопировано со страницы) — вставка текста, образца нет
    assert.equal(await paste('просто текст'), true, 'вставку текста не перехватываем');
    await page.waitForTimeout(400);
    assert.ok(!/Образец на макете/.test(await msg()));
    // картинка с именем файла (так кладёт буфер ОС) — образец
    assert.equal(await paste('фото.png'), false, 'картинку перехватили');
    await page.waitForFunction(() => /Образец на макете/.test(document.body.innerText), null, { timeout: 10000 });
    assert.equal(await page.inputValue('#command'), 'собери экран в цветах этой картинки');
    assert.equal(await page.evaluate(() => { const el = document.getElementById('command'); return el.value.slice(el.selectionStart, el.selectionEnd); }), 'экран');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'command');
    await page.keyboard.type('лендинг студии йоги');
    assert.equal(await page.inputValue('#command'), 'собери лендинг студии йоги в цветах этой картинки');
    // выделение ушло (Esc на холсте) — при отправке образец выделяется снова
    await page.evaluate(() => { document.getElementById('command').blur(); });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.focus('#command');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Образец снова выделен/.test(document.body.innerText), null, { timeout: 5000 });
    // картинка, брошенная на полосу команды (на кнопку, не в поле), — тоже образец
    await page.fill('#command', 'собери экран кофейни');
    const droppedImage = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 30; c.height = 30;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'второе.png', { type: 'image/png' }));
      const el = document.querySelector('#commandbar button') || document.getElementById('commandbar');
      const at = { bubbles: true, cancelable: true, dataTransfer: dt };
      el.dispatchEvent(new DragEvent('dragover', at));
      const ready = document.getElementById('commandbar').classList.contains('drop-ready');
      return [el.dispatchEvent(new DragEvent('drop', at)), ready];
    });
    assert.deepEqual(droppedImage, [false, true]);
    await page.waitForFunction(() => document.getElementById('command').value === 'собери экран кофейни в цветах этой картинки', null, { timeout: 10000 });
    assert.match(await msg(), /Команда готова/);
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
    // и мимо холста и строки браузер файл не открывает
    const elsewhere = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'заметка.txt', { type: 'text/plain' }));
      return document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    assert.equal(elsewhere, false);
    await page.click('#btn-history');
    await page.waitForTimeout(600);
    const hist = await page.locator('#sheet-body').innerText();
    assert.ok(/«фото»/.test(hist) && /«второе»/.test(hist), hist);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
