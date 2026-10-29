/**
 * Круг 97 (SPEC §15.31): цвет палитры — переименовать (одной правкой: ключ, все ссылки слоёв и свой цвет
 * этого имени в темах экранов) и удалить, если на него никто не ссылается. Роли палитры — нельзя.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { colorTokenRefs, colorTokenUsers, renameDocColorOps, removeDocColorOps, docColorRows } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function doc0() {
  let d = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(d, [
    core.ops.setToken('colors.brand', '#7a5cff'),
    core.ops.setToken('colors.spare', '#00aa55'),
    core.ops.create({ id: 'A', type: 'frame', name: 'Оплата', parent: d.root, fill: 'brand', stroke: { color: { token: 'brand' }, width: 1 },
      states: { hover: { fill: { color: 'brand' } } }, children: [] }),
    core.ops.create({ id: 'g', type: 'frame', name: 'Градиент', parent: 'A', children: [],
      fill: { gradient: { kind: 'linear', stops: [{ at: 0, token: 'brand' }, { at: 1, color: 'brand' }] } } }),
    core.ops.create({ id: 'p', type: 'frame', name: 'Фактура', parent: 'A', children: [], fill: { pattern: { kind: 'dots', color: 'brand', bg: 'surface' } } }),
    core.ops.create({ id: 't', type: 'text', name: 'Текст', parent: 'A', characters: 'Привет', color: 'text' }),
    core.ops.create({ id: 'B', type: 'frame', name: 'Итог', parent: d.root, fill: 'surface', theme: { colors: { brand: '#ff0000' } }, children: [] }),
    core.ops.create({ id: 'C', type: 'frame', name: 'Свои', parent: d.root, fill: 'surface', theme: { colors: { brand: '#ff0000', brand2: '#00ff00' } }, children: [] }),
    core.ops.create({ id: 'c1', type: 'frame', name: 'Плитка', parent: 'C', fill: 'brand', children: [] }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const look = (doc) => Object.fromEntries(['A', 'g', 'p', 'B', 'c1'].map((id) => [id, JSON.stringify(core.resolvePaint(core.themeScope(doc)(id), doc.nodes[id].fill))]));

test('круг97: ссылки на цвет — путь до самого имени', () => {
  const refs = colorTokenRefs(doc0()).filter((r) => r.name === 'brand').map((r) => `${r.id}:${r.path}`).sort();
  assert.deepEqual(refs, ['A:fill', 'A:states.hover.fill.color', 'A:stroke.color.token', 'c1:fill', 'g:fill.gradient.stops.0.token', 'g:fill.gradient.stops.1.color', 'p:fill.pattern.color']);
});

test('круг97: переименование — ключ, ссылки и темы экранов одной правкой, вид прежний; отмена — назад', () => {
  const d = doc0();
  const r = renameDocColorOps(d, 'brand', 'brandNew');
  assert.equal(r.label, 'Цвет «brand» переименован в «brandNew» — ссылки 4 слоёв и 2 темы экранов тоже');
  const a = core.applyOps(d, r.ops);
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  const n = a.doc;
  assert.equal(n.tokens.colors.brand, undefined);
  assert.equal(n.tokens.colors.brandNew, '#7a5cff');
  assert.equal(n.nodes.A.fill, 'brandNew');
  assert.deepEqual(n.nodes.A.stroke.color, { token: 'brandNew' });
  assert.deepEqual(n.nodes.A.states.hover.fill, { color: 'brandNew' });
  assert.deepEqual(n.nodes.g.fill.gradient.stops, [{ at: 0, token: 'brandNew' }, { at: 1, color: 'brandNew' }]);
  assert.equal(n.nodes.p.fill.pattern.color, 'brandNew');
  assert.deepEqual(n.nodes.B.theme.colors, { brandNew: '#ff0000' }, 'свой цвет экрана — под новым именем');
  assert.deepEqual(n.nodes.C.theme.colors, { brand2: '#00ff00', brandNew: '#ff0000' });
  assert.deepEqual(look(n), look(d), 'вид прежний');
  assert.equal(colorTokenUsers(n).get('brandNew').size, 4);
  // отмена — одна правка
  const back = core.applyOps(n, core.invertOps(d, r.ops));
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.doc.nodes.A.fill, 'brand');
  assert.equal(back.doc.tokens.colors.brand, '#7a5cff');
});

test('круг97 (критик): перечисление по пути краски — варианты мастера и выбор экземпляра переименовываются, удалить нельзя', () => {
  let d = doc0();
  d = core.applyOps(d, [core.ops.create({ id: 'M', type: 'frame', name: 'Плашка', parent: 'A', fill: 'surface', children: [] })]).doc;
  const made = core.applyOps(d, core.makeComponentOps(d, 'M', { name: 'Плашка', props: [{ name: 'tone', kind: 'enum', target: 'M', path: 'fill', values: ['surface', 'spare'] }] }));
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  d = made.doc;
  const inst = Object.values(d.nodes).find((n) => n.type === 'instance' && n.of === 'M');
  d = core.applyOps(d, [core.ops.set(inst.id, 'props.tone', 'spare')]).doc;
  assert.ok(colorTokenUsers(d).get('spare').has(inst.id));
  assert.match(removeDocColorOps(d, 'spare').error, /ссылаются 2 слоя/);
  const r = renameDocColorOps(d, 'spare', 'spare2');
  const a = core.applyOps(d, r.ops);
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.deepEqual(a.doc.nodes.M.component.props[0].values, ['surface', 'spare2']);
  assert.equal(a.doc.nodes[inst.id].props.tone, 'spare2');
});

test('круг97 (критик): тема экрана на пределе цветов — переименование ложится (старое снимается раньше нового)', () => {
  let d = doc0();
  const full = Object.fromEntries(Array.from({ length: core.THEME_LIMITS.colors }, (_, i) => [i ? `c${i}` : 'brand', '#000000']));
  d = core.applyOps(d, [core.ops.set('B', 'theme', { colors: full })]).doc;
  const a = core.applyOps(d, renameDocColorOps(d, 'brand', 'brandX').ops);
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.equal(a.doc.nodes.B.theme.colors.brandX, '#000000');
});

test('круг97: правила имени; роли палитры не переименовать и не удалить', () => {
  const d = doc0();
  assert.equal(renameDocColorOps(d, 'brand', 'brand'), null, 'то же имя — правки нет');
  assert.match(renameDocColorOps(d, 'brand', 'Spare').error, /«spare» в документе уже есть/);
  assert.match(renameDocColorOps(d, 'brand', 'бренд').error, /латиница/);
  assert.match(renameDocColorOps(d, 'brand', 'none').error, /без цвета/);
  assert.match(renameDocColorOps(d, 'accent', 'brand2').error, /роль палитры/);
  assert.match(renameDocColorOps(d, 'nope', 'x').error, /нет/);
  // регистр своего же имени менять можно
  assert.equal(core.applyOps(d, renameDocColorOps(d, 'brand', 'Brand').ops).doc.nodes.A.fill, 'Brand');
  assert.match(removeDocColorOps(d, 'accent').error, /роль палитры/);
  assert.equal(removeDocColorOps(d, 'brand').error, 'На цвет «brand» ссылаются 4 слоя — без него они стали бы прозрачными. Сначала перекрасьте их');
  // критик: новое имя уже значит что-то у экрана или у слоя — вид поменялся бы
  assert.match(renameDocColorOps(d, 'brand', 'brand2').error, /У экрана «Свои» уже есть свой цвет «brand2»/);
  const hang = core.applyOps(d, [core.ops.create({ id: 'h', type: 'frame', name: 'Висит', parent: 'A', fill: 'ghost', children: [] })]);
  assert.equal(hang.error, undefined);
  assert.match(renameDocColorOps(hang.doc, 'brand', 'ghost').error, /уже стоит у слоя «Висит»/);
  const rm = removeDocColorOps(d, 'spare');
  assert.equal(rm.label, 'Цвет «spare» удалён из палитры');
  assert.equal(core.applyOps(d, rm.ops).doc.tokens.colors.spare, undefined);
  const rows = Object.fromEntries(docColorRows(d).map((r) => [r.name, r.role]));
  assert.equal(rows.accent, true);
  assert.equal(rows.brand, false);
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

test('круг97: в браузере — «Имя» → новое имя → ссылки за ним; «×» у неиспользуемого — удалить, у нужного — объяснение', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    await (await chooser).setFiles({ name: 'rename.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc0())) });
    await page.locator('#layers .layer[data-id="A"]').waitFor({ timeout: 10000 });
    await say('/цвета документа');
    const row = (n) => page.locator(`#sheet-body .doc-color-row[data-token="${n}"]`);
    await row('brand').waitFor({ timeout: 5000 });
    assert.equal(await row('accent').locator('.doc-color-rename').count(), 0, 'у роли палитры кнопок нет');
    // «×» у нужного цвета — объяснение, цвет остаётся
    await row('brand').locator('.doc-color-remove').click({ force: true });   // aria-disabled: Playwright считает «недоступной», человек щёлкнуть может
    await page.locator('.toast', { hasText: 'Сначала перекрасьте их' }).waitFor({ timeout: 5000 });
    assert.equal(await row('brand').count(), 1);
    // переименование на месте
    await row('brand').locator('.doc-color-rename').click();
    const inp = page.locator('#sheet-body .doc-color-name-input');
    await inp.fill('brandNew');
    await inp.press('Enter');
    await row('brandNew').waitFor({ timeout: 5000 });
    assert.equal(await row('brand').count(), 0);
    assert.equal(await row('brandNew').locator('.scale-use').innerText(), '4 слоя');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.skey), 'color-ren|brandNew', 'фокус — на «Имя» под новым именем');
    // удалить ненужный
    await row('spare').locator('.doc-color-remove').click();
    await page.waitForFunction(() => !document.querySelector('#sheet-body .doc-color-row[data-token="spare"]'), null, { timeout: 5000 });
    // отмена удаления и отмена переименования
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+z');
    await row('spare').waitFor({ timeout: 5000 });
    await page.keyboard.press('Control+z');
    await row('brand').waitFor({ timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
