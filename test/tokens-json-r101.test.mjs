/**
 * Круг 101 (SPEC §15.35): токены документа в формате W3C Design Tokens (DTCG) — JSON для Style Dictionary
 * и Tokens Studio. Отбор — тот же, что у CSS (§15.34): только то, что видит редактор, и безопасные имена.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { tokensJson, tokensCss, shellIntent } from '../src/shell.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function doc0() {
  const d = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(d, [
    core.ops.setToken('colors.brand', '#7A5CFF'),
    core.ops.setToken('colors.brandSoft', '#EEE8FF'),
    core.ops.create({ id: 'A', type: 'frame', name: 'Оплата', parent: d.root, fill: 'surface', children: [],
      theme: { colors: { accent: '#00AA55' }, type: { display: { font: 'Exo 2', fontWeight: 700 } } } }),
    core.ops.create({ id: 'B', type: 'frame', name: 'Итог', parent: d.root, fill: 'surface', children: [] }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг101: группы DTCG — color, space, radius, font, typography со ссылкой на шрифт, screen', () => {
  const r = tokensJson(doc0(), { title: 'Касса' });
  const j = JSON.parse(r.json);
  assert.equal(j.$description, 'Токены документа Касса — Imago');
  assert.equal(j.color.$type, 'color');
  assert.deepEqual(j.color.brand, { $value: '#7a5cff', $description: 'свой цвет документа' });
  assert.equal(j.color.surfaceAlt.$value.length, 7, 'имя — как в документе, не kebab-case');
  assert.ok(Object.keys(j.color).indexOf('warn') < Object.keys(j.color).indexOf('brand'), 'роли раньше своих');
  assert.equal(j.space.$type, 'dimension');
  assert.equal(j.space['0'].$value, '0px');
  assert.equal(j.font.$type, 'fontFamily');
  assert.equal(j.typography.$type, 'typography');
  assert.equal(j.typography.body.$value.fontFamily, '{font.body}');
  assert.match(j.typography.body.$value.fontSize, /^\d+px$/);
  assert.deepEqual(j.screen['Оплата'].color, { $type: 'color', accent: { $value: '#00aa55' } });
  assert.deepEqual(j.screen['Оплата'].font, { $type: 'fontFamily', display: { $value: 'Exo 2' } });
  assert.deepEqual(j.screen['Оплата'].fontWeight, { $type: 'fontWeight', display: { $value: 700 } });
  assert.equal(j.screen['Итог'], undefined, 'экран без своей темы — нет');
  assert.equal(r.json, tokensJson(doc0(), { title: 'Касса' }).json, 'тот же документ — тот же файл');
  // CSS и JSON — из одной модели: цветов столько же
  assert.equal(r.colors, tokensCss(doc0()).colors);
});

test('круг101: интерлиньяж-множитель — числом; имя экрана без «.{}$»; негодное — пропуск', () => {
  let d = doc0();
  d = { ...d, tokens: { ...d.tokens, colors: { ...d.tokens.colors, 'evil}': '#000000', tint: 'rgba(0,0,0,.5)', veil: '#11223380' },
    spacing: [0, 'x', 8], type: { body: { font: 'Inter', fontSize: 15, lineHeight: 1.5, letterSpacing: 0 } } } };
  d = { ...d, nodes: { ...d.nodes, A: { ...d.nodes.A, name: '$Опл.ата{x}', theme: { colors: { accent: '#00AA55' } } } } };
  const j = JSON.parse(tokensJson(d).json);
  assert.equal(j.typography.body.$value.lineHeight, 1.5);
  assert.equal(j.typography.body.$value.letterSpacing, '0px');
  assert.equal(j.color['evil}'], undefined);
  assert.equal(j.color.tint, undefined);
  assert.equal(j.color.veil.$value, '#112233');
  assert.deepEqual(Object.keys(j.space).filter((k) => k !== '$type'), ['0', '2']);
  assert.deepEqual(Object.keys(j.screen), ['Опл ата x']);
  // px-интерлиньяж — множителем, вес — в пределах DTCG, совпавшие имена экранов — с номером
  let e = doc0();
  e = { ...e, tokens: { ...e.tokens, type: { body: { font: 'Inter', fontSize: 16, lineHeight: 24, fontWeight: 1200 } } } };
  e = { ...e, nodes: { ...e.nodes, A: { ...e.nodes.A, name: 'v1.2' }, B: { ...e.nodes.B, name: 'v1 2', theme: { colors: { accent: '#112233' } } } } };
  const k = JSON.parse(tokensJson(e).json);
  assert.equal(k.typography.body.$value.lineHeight, 1.5);
  assert.equal(k.typography.body.$value.fontWeight, 1000);
  assert.deepEqual(Object.keys(k.screen), ['v1 2', 'v1 2 (2)']);
  const keys = [];
  const walk = (o) => { for (const [k, v] of Object.entries(o)) { if (!k.startsWith('$')) keys.push(k); if (v && typeof v === 'object' && !k.startsWith('$')) walk(v); } };
  walk(j);
  assert.ok(keys.every((k) => !/[{}.]/.test(k) && !k.startsWith('$')), keys.join(', '));
});

test('круг101: фразы и слэш; «экспорт json» — по-прежнему документ, «экспортируй токены» — CSS', () => {
  for (const s of ['экспортируй токены в json', 'экспорт токенов json', '/экспорт tokens.json', '/экспорт токены json', 'скачай design tokens']) {
    assert.deepEqual(shellIntent(s, {}), { kind: 'export', what: 'tokens-json' }, s);
  }
  assert.deepEqual(shellIntent('экспорт json', {}), { kind: 'export', what: 'json' });
  assert.deepEqual(shellIntent('экспортируй токены', {}), { kind: 'export', what: 'css' });
});

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

test('круг101: в браузере — «Токены JSON» в окне экспорта скачивает DTCG', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await say('/импорт');
    await (await chooser).setFiles({ name: 'tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc0())) });
    await page.locator('#layers .layer[data-id="A"]').waitFor({ timeout: 10000 });
    await say('/экспорт');
    const btn = page.locator('#sheet-body button', { hasText: 'Токены JSON' });
    await btn.waitFor({ timeout: 5000 });
    assert.match(await btn.getAttribute('title'), /Пустая-страница\.tokens\.json$/);
    const got = page.waitForEvent('download', { timeout: 10000 });
    await btn.click();
    const j = JSON.parse(await readFile(await (await got).path(), 'utf8'));
    assert.equal(j.color.brand.$value, '#7a5cff');
    assert.equal(j.screen['Оплата'].color.accent.$value, '#00aa55');
    await page.locator('.toast', { hasText: '.tokens.json' }).first().waitFor({ timeout: 5000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
