/**
 * Круг 96 (SPEC §15.30): шторка «Цвета документа» — палитра документа правится в интерфейсе
 * (`setToken colors.<имя>`), у каждого цвета — сколько слоёв на него ссылается, новый цвет — по имени
 * латиницей. Команда `/цвета документа`, «открой палитру документа», ссылка из «Цвета экрана».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { colorTokenUsers, docColorRows, docColorOps, newDocColorOps, shellIntent } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [
    core.ops.create({ id: 'A', type: 'frame', name: 'Оплата', parent: base.root, fill: 'surface', children: [] }),
    core.ops.create({ id: 'a1', type: 'frame', name: 'Кнопка', parent: 'A', fill: { token: 'accent' }, stroke: { color: 'line', width: 1 },
      states: { hover: { fill: 'accentInk' } }, children: [] }),
    core.ops.create({ id: 'a2', type: 'text', name: 'Подпись', parent: 'a1', characters: 'Оплатить', color: 'onAccent' }),
    core.ops.create({ id: 'a3', type: 'frame', name: 'Градиент', parent: 'A', children: [],
      fill: { gradient: { kind: 'linear', stops: [{ at: 0, token: 'accent' }, { at: 1, color: '#ffffff' }] } } }),
    core.ops.create({ id: 'a4', type: 'frame', name: 'Фактура', parent: 'A', children: [], fill: { pattern: { kind: 'dots', color: 'muted', bg: 'canvas' } } }),
    core.ops.create({ id: 'a5', type: 'frame', name: 'Старый акцент', parent: 'A', fill: '#ff6b3d', children: [] }),
    core.ops.create({ id: 'B', type: 'frame', name: 'Итог', parent: base.root, fill: 'surface', theme: { colors: { accent: '#ff4f6d' } }, children: [] }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг96: кто ссылается на цвет — заливка, обводка, состояния, стопы, фактура; коды — нет', () => {
  const doc = screens();
  const u = colorTokenUsers(doc);
  const ids = (n) => [...(u.get(n) || [])].sort();
  assert.deepEqual(ids('accent'), ['a1', 'a3']);
  assert.deepEqual(ids('surface'), ['A', 'B']);
  assert.deepEqual(ids('line'), ['a1']);
  assert.deepEqual(ids('accentInk'), ['a1']);
  assert.deepEqual(ids('onAccent'), ['a2']);
  assert.deepEqual(ids('muted'), ['a4']);
  assert.deepEqual(ids('canvas'), ['a4']);
  const rows = docColorRows(doc);
  const accent = rows.find((r) => r.name === 'accent');
  assert.equal(accent.hex, '#ff6b3d');
  assert.equal(accent.users, 2);
  assert.equal(rows.find((r) => r.name === 'good').users, 0);
});

test('круг96 (критик): обёртки {color}/{value}, стоп {color: имя}, пропс-цвет и экземпляры мастера — тоже ссылки', () => {
  const doc = screens();
  const lib = core.ensureLibraryOps ? null : null;
  const r = core.applyOps(doc, [
    core.ops.create({ id: 'w1', type: 'frame', name: 'Обёртка', parent: 'A', fill: { color: 'good' }, children: [] }),
    core.ops.create({ id: 'w2', type: 'frame', name: 'Стоп по имени', parent: 'A', children: [],
      fill: { gradient: { kind: 'linear', stops: [{ at: 0, color: 'warn' }, { at: 1, color: '#000000' }] } } }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const u = colorTokenUsers(r.doc);
  assert.deepEqual([...u.get('good')], ['w1']);
  assert.deepEqual([...u.get('warn')], ['w2']);
  void lib;
  // мастер с заливкой accentSoft и пропсом-цветом подписи; два экземпляра, у одного пропс — good
  let d = r.doc;
  d = core.applyOps(d, [
    core.ops.create({ id: 'm', type: 'frame', name: 'Плашка', parent: 'A', fill: 'accentSoft', children: [] }),
    core.ops.create({ id: 'mt', type: 'text', name: 'Текст', parent: 'm', characters: 'Новинка', color: 'text' }),
  ]).doc;
  const made = core.applyOps(d, core.makeComponentOps(d, 'm', { name: 'Плашка', props: [{ name: 'тон', kind: 'color', target: 'mt', path: 'color' }] }));
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  d = made.doc;
  const more = core.applyOps(d, core.instanceOps(d, { of: 'm', parent: 'B', props: { 'тон': 'good' } }));
  assert.equal(more.error, undefined, JSON.stringify(more.error));
  d = more.doc;
  const insts = Object.values(d.nodes).filter((n) => n.type === 'instance' && n.of === 'm').map((n) => n.id).sort();
  assert.equal(insts.length, 2);
  const v = colorTokenUsers(d);
  assert.deepEqual([...v.get('accentSoft')].sort(), ['m', ...insts].sort(), 'мастер и оба экземпляра');
  const withProp = insts.find((id) => d.nodes[id].props && d.nodes[id].props['тон']);
  assert.ok(v.get('good').has(withProp), 'пропс-цвет экземпляра');
});

test('круг96: правка цвета палитры — setToken; тот же код — нет; экраны со своим цветом названы; контраст', () => {
  const doc = screens();
  const r = docColorOps(doc, 'accent', '#2255FF', { title: 'акцент' });
  assert.deepEqual(r.ops, [core.ops.setToken('colors.accent', '#2255ff')]);
  assert.equal(r.label, 'Цвет документа: акцент #2255FF');
  assert.deepEqual(r.screens, ['Итог']);
  assert.equal(docColorOps(doc, 'accent', '#FF6B3D'), null, 'тот же цвет');
  assert.equal(docColorOps(doc, 'nope', '#000000'), null, 'нет такого цвета');
  assert.equal(docColorOps(doc, 'accent', 'синий'), null, 'не код');
  const dark = docColorOps(doc, 'canvas', '#111111');
  assert.ok(dark.warnings.some((w) => /текст на фоне читается плохо/.test(w)), dark.warnings.join(' | '));
  const after = core.applyOps(doc, r.ops);
  assert.equal(after.error, undefined);
  assert.equal(core.resolveColor(after.doc, 'accent'), '#2255ff');
});

test('круг96: новый цвет — имя латиницей, не занятое (и без учёта регистра), код', () => {
  const doc = screens();
  const r = newDocColorOps(doc, ' brand ', '#7A5CFF');
  assert.deepEqual(r.ops, [core.ops.setToken('colors.brand', '#7a5cff')]);
  assert.equal(r.label, 'Новый цвет документа: brand #7A5CFF');
  const after = core.applyOps(doc, r.ops);
  assert.equal(after.error, undefined);
  assert.equal(core.resolveColor(after.doc, 'brand'), '#7a5cff');
  assert.match(newDocColorOps(doc, '', '#000').error, /Назовите цвет/);
  assert.match(newDocColorOps(doc, 'бренд', '#000').error, /латиница/);
  assert.match(newDocColorOps(doc, 'Accent', '#000').error, /«accent» в документе уже есть/);
  assert.match(newDocColorOps(doc, 'brand', 'красный').error, /кодом/);
  // критик: «none» в краске — «без цвета»; токен с таким именем перекрасил бы все такие слои
  assert.match(newDocColorOps(doc, 'None', '#ff0000').error, /без цвета/);
  // тот же код, что у другого цвета, — предупреждение: привязка кодов его уже не решит
  assert.match(newDocColorOps(doc, 'brand', '#FF6B3D').warnings[0], /Тот же код у цвета «accent»/);
  assert.deepEqual(newDocColorOps(doc, 'brand', '#7A5CFF').warnings, []);
});

test('круг96: «открой палитру», «цвета документа», /палитра — шторка; «привяжи цвета к палитре» — прежнее', () => {
  for (const t of ['открой палитру документа', 'цвета документа', 'палитра документа', 'покажи цвета документа', '/палитра документа', '/цвета документа']) {
    assert.deepEqual(shellIntent(t, {}), { kind: 'sheet', what: 'colors' }, t);
  }
  // критик: «палитра» одна — палитра команд (Mod+K), не эта шторка
  for (const t of ['открой палитру', 'палитра']) assert.notDeepEqual(shellIntent(t, {}), { kind: 'sheet', what: 'colors' }, t);
  assert.deepEqual(shellIntent('привяжи цвета к палитре', {}), { kind: 'bind-colors' });
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

test('круг96: в браузере — /палитра → правка акцента → «Перекрасить и его», отмена, новый цвет', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    await (await chooser).setFiles({ name: 'colors.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screens())) });
    await page.locator('#layers .layer[data-id="A"]').waitFor({ timeout: 10000 });
    await say('открой палитру документа');
    const row = page.locator('#sheet-body .doc-color-row[data-token="accent"]');
    await row.waitFor({ timeout: 5000 });
    assert.equal(await row.locator('.scale-use').innerText(), '2 слоя');
    const hex = row.locator('input.paint-hex');
    assert.equal(await hex.inputValue(), '#FF6B3D');
    await hex.fill('#2255FF');
    await hex.press('Enter');
    // слой a5 окрашен кодом прежнего акцента — то же предложение, что после правки словами (§15.25)
    const t = page.locator('.toast.stale-hex');
    await t.waitFor({ timeout: 5000 });
    assert.match(await t.innerText(), /1 слой на экране «Оплата» окрашен кодом прежнего цвета/);
    // у «Итога» свой акцент — сказано, что правка его не коснулась
    const note = page.locator('.toast', { hasText: 'Экран «Итог» — со своим цветом, его правка не коснулась.' });
    await note.waitFor({ timeout: 5000 });
    assert.match(await note.innerText(), /текст на акценте читается плохо: контраст 3\.2:1/, 'контраст — в том же тосте');
    // шторка перерисовалась: поле — новый код; отмена — прежний
    await page.waitForFunction(() => document.querySelector('#sheet-body .doc-color-row[data-token="accent"] input.paint-hex').value === '#2255FF', null, { timeout: 5000 });
    // в поле Ctrl+Z — отмена набора самого поля; правку отменяет Ctrl+Z вне поля
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#sheet-body .doc-color-row[data-token="accent"] input.paint-hex').value === '#FF6B3D', null, { timeout: 5000 });
    // новый цвет
    const form = page.locator('#sheet-body form.doc-color-new');
    await form.locator('input.field').fill('Accent');
    await form.locator('button[type="submit"]').click();
    await page.locator('.toast', { hasText: '«accent» в документе уже есть' }).waitFor({ timeout: 5000 });
    await page.locator('#sheet-body form.doc-color-new input.field').fill('brand');
    await page.locator('#sheet-body form.doc-color-new input[type="color"]').evaluate((el) => { el.value = '#7a5cff'; });
    await page.locator('#sheet-body form.doc-color-new button[type="submit"]').click();
    const brand = page.locator('#sheet-body .doc-color-row[data-token="brand"]');
    await brand.waitFor({ timeout: 5000 });
    assert.equal(await brand.locator('input.paint-hex').inputValue(), '#7A5CFF');
    assert.equal(await brand.locator('.scale-use').innerText(), 'не используется');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
