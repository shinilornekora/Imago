/**
 * Круг 89 (SPEC §15.25): правка сменила цвет палитры, а слои с кодом прежнего значения не перекрасились —
 * тост об этом и «Перекрасить и их»: привязка к токену, и они идут за новым цветом.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { staleHexRefs, staleHexPhrase } from '../src/shell.js';

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

test('круг89: тема экрана сменила акцент — слои с кодом прежнего акцента найдены; прочие экраны — нет', () => {
  const doc = screens();
  // «Итог»: свой акцент #ff4f6d → #2255ff; «Кнопка» b1 окрашена кодом #FF4F6D
  const next = core.applyOps(doc, [core.ops.set('B', 'theme.colors.accent', '#2255ff')]).doc;
  const st = staleHexRefs(doc, next);
  assert.deepEqual(st.ops.map((o) => [o.id, o.path, o.value]), [['b1', 'fill', 'accent']]);
  assert.deepEqual(st.boards.map((b) => [b.id, b.n]), [['B', 1]]);
  assert.deepEqual(st.tokens, ['accent']);
  const w = staleHexPhrase(st, { accent: 'Акцент' });
  assert.equal(w.text, '1 слой на экране «Итог» окрашен кодом прежнего цвета «Акцент» — новый цвет его не перекрасил');
  assert.equal(w.label, 'Цвета 1 слоя на экране «Итог» привязаны к палитре — пошли за новым цветом');
  // критик: об одном слое — «его / он пойдёт», о многих и о нескольких цветах — во множественном
  assert.equal(w.offer, 'Привязать его к палитре — и он пойдёт за новым цветом.');
  assert.equal(w.action, 'Перекрасить и его');
  const two = staleHexPhrase({ layers: 21, boards: [{ id: 'A', name: 'Оплата', n: 21 }], tokens: ['accent', 'text'] });
  assert.equal(two.text, '21 слой на экране «Оплата» окрашен кодами прежних цветов «accent», «text» — новые цвета их не перекрасили');
  assert.equal(two.offer, 'Привязать их к палитре — и они пойдут за новыми цветами.');
  assert.equal(two.action, 'Перекрасить и их');
  // привязали — слой взял новый акцент
  const after = core.applyOps(next, st.ops).doc;
  assert.equal(core.resolveColor(core.themeScope(after)('B'), after.nodes.b1.fill), core.resolveColor(core.themeScope(after)('B'), 'accent'));
});

test('круг89: общий акцент документа — экраны без своего акцента; правка без смены цвета — молчит', () => {
  const doc = screens();
  const r = core.applyOps(doc, [core.ops.setToken('colors.accent', '#00AA55')]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const st = staleHexRefs(doc, r.doc);
  // «Оплата» (a1 — код общего акцента); у «Итога» акцент свой — не изменился, его b2 не в счёт
  assert.deepEqual(st.ops.map((o) => o.id), ['a1']);
  assert.equal(staleHexPhrase(st).text, '1 слой на экране «Оплата» окрашен кодом прежнего цвета «accent» — новый цвет его не перекрасил');
  // правка заодно перекрасила сам слой — его не предлагаем
  const both = core.applyOps(doc, [core.ops.setToken('colors.accent', '#00AA55'), core.ops.set('a1', 'fill', '#000000')]).doc;
  assert.equal(staleHexRefs(doc, both), null);
  // правки цвета палитры нет — молчит (и без обхода)
  assert.equal(staleHexRefs(doc, core.applyOps(doc, [core.ops.set('a2', 'characters', 'Ещё')]).doc), null);
  assert.equal(staleHexRefs(doc, doc), null);
  // тот же цвет другим написанием — не смена
  assert.equal(staleHexRefs(doc, core.applyOps(doc, [core.ops.setToken('colors.accent', '#ff6b3d')]).doc), null);
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

test('круг89: в браузере — цвет экрана в инспекторе → тост «Перекрасить и его» → слой с новым цветом', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    await page.locator('#layers .layer[data-id="B"]').click();
    const row = page.locator('#inspector .theme-color-row[data-token="accent"] input.paint-color-input');
    await row.waitFor({ timeout: 10000 });
    await row.evaluate((el) => { el.value = '#2255ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const t = page.locator('.toast.stale-hex');
    await t.waitFor({ timeout: 5000 });
    assert.match(await t.innerText(), /1 слой на экране «Итог» окрашен кодом прежнего цвета «[^»]+» — новый цвет его не перекрасил/);
    assert.equal(await t.locator('button.t-action').innerText(), 'Перекрасить и его');
    // критик: отмена закрывает открытое предложение; правка снова — предложение снова
    await say('отмени');
    await page.waitForFunction(() => !document.querySelector('.toast.stale-hex'), null, { timeout: 5000 });
    await row.evaluate((el) => { el.value = '#2255ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.waitFor({ timeout: 5000 });
    await t.locator('button.t-action').click();
    await page.waitForFunction(() => /пошли за новым цветом/.test(document.body.innerText), null, { timeout: 5000 });
    assert.equal(await page.locator('.toast.stale-hex').count(), 0);
    // второй раз — нечего: тост не появляется от самой привязки
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.toast.stale-hex').count(), 0);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
