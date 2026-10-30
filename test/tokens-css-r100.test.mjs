/**
 * Круг 100 (SPEC §15.34): токены документа в CSS — переменные палитры, шкал и шрифтов, классы стилей
 * текста, экраны со своей темой — `[data-screen]`. Значения из документа в CSS попадают только безопасные.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { tokensCss, shellIntent } from '../src/shell.js';

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

test('круг100: :root — роли палитры, затем свои; шкалы; шрифты; классы стилей; экран со своей темой', () => {
  const r = tokensCss(doc0(), { title: 'Касса' });
  const css = r.css;
  assert.match(css, /^\/\* Токены документа Касса — Imago\. \*\/\n:root \{/);
  assert.ok(css.indexOf('--color-warn:') < css.indexOf('/* Свои цвета */'), 'роли раньше своих');
  assert.match(css, /--color-surface-alt: #[0-9a-f]{6};/, 'camelCase → kebab-case');
  assert.match(css, /--color-brand: #7a5cff;\n  --color-brand-soft: #eee8ff;/);
  assert.match(css, /--space-0: 0px;/);
  assert.match(css, /--radius-\d+: \d+px;/);
  assert.match(css, /--font-mono: "[^"]+", ui-monospace, monospace;/);
  assert.match(css, /\.text-body \{\n  font-family: var\(--font-body\);\n  font-size: \d+px;/);
  assert.match(css, /\[data-screen="Оплата"\] \{\n  --color-accent: #00aa55;\n  --font-display: "Exo 2", system-ui, sans-serif;\n\}/);
  assert.match(css, /\[data-screen="Оплата"\] \.text-display \{ font-weight: 700; \}/);
  assert.doesNotMatch(css, /Итог/, 'экран без своей темы — не пишем');
  assert.equal(r.screens, 1);
  assert.equal(r.css, tokensCss(doc0(), { title: 'Касса' }).css, 'тот же документ — тот же файл');
});

test('круг100: из документа в CSS — только безопасное: шрифт, имя экрана, значение и имя цвета', () => {
  let d = doc0();
  d = { ...d, tokens: { ...d.tokens, colors: { ...d.tokens.colors, 'evil}': '#000000', bad: 'red;} body{display:none', цвет: '#111111', tint: 'rgba(0, 0, 0, .5)', veil: '#11223380' },
    type: { ...d.tokens.type, body: { ...d.tokens.type.body, font: 'X"; } body { color: red; } /*' } } } };
  d = { ...d, nodes: { ...d.nodes, A: { ...d.nodes.A, name: 'О"плата\\ */ x' } }, meta: { ...(d.meta || {}), name: 'a */ b' } };
  const css = tokensCss(d).css;
  assert.doesNotMatch(css, /evil|display:none|цвет:/);
  assert.doesNotMatch(css, /--color-tint/, 'rgba() редактор не рисует — и в файле нет');
  assert.match(css, /--color-veil: #112233;/, '8-значный — без прозрачности, как в редакторе');
  assert.match(css, /--font-body: "X\\"; } body { color: red; } \/\*", system-ui, sans-serif;/, 'кавычка экранирована — всё внутри строки');
  assert.match(css, /\[data-screen="О\\"плата\\\\ \*\/ x"\]/);
  // вне строк — ни одного лишнего конца комментария
  const outside = css.replace(/"(?:\\.|[^"\\])*"/g, '""');
  assert.equal((outside.match(/\*\//g) || []).length, (outside.match(/\/\*/g) || []).length, 'комментарии сбалансированы');
});

test('круг100 (критик): интерлиньяж-множитель, длинный шрифт, совпавшие имена, дыры в шкале, стиль только темы, моно, «<» в имени экрана', () => {
  let d = doc0();
  const long = `${'a'.repeat(150)}"x`;
  d = { ...d, tokens: { ...d.tokens,
    colors: { ...d.tokens.colors, accentSoft2: '#010101', 'accent-soft2': '#020202' },
    spacing: [0, 'x', 8], radii: [4],
    type: { body: { font: 'Inter', fontSize: 15, fontWeight: 400, lineHeight: 1.5 }, caption: { fontSize: 13, lineHeight: 18 },
      monoLg: { font: 'Inter', fontSize: 15 }, code: { font: 'JetBrains Mono', fontSize: 13 }, sign: { font: long, fontSize: 20 } } } };
  d = { ...d, nodes: { ...d.nodes, A: { ...d.nodes.A, name: 'A<B', theme: { type: { caption: { font: 'Exo 2' }, fancy: { font: 'Lobster' } } } } } };
  const r = tokensCss(d);
  const css = r.css;
  assert.match(css, /\.text-body \{[^}]*line-height: 1\.5;/, 'множитель — без единиц');
  assert.match(css, /\.text-caption \{[^}]*line-height: 18px;/);
  assert.match(css, /--color-accent-soft2: #010101;/);
  assert.doesNotMatch(css, /#020202/, 'второе имя в то же имя CSS — пропуск');
  assert.ok(r.skipped >= 1);
  assert.match(css, /--space-0: 0px;\n  --space-2: 8px;/, 'номер — место в шкале');
  assert.match(css, /\.text-caption \{\n  font-family: var\(--font-caption\);/, 'шрифт только у темы — класс берёт переменную');
  assert.match(css, /\[data-screen="A\\3c B"\] \{\n  --font-caption: "Exo 2"/, '«<» — кодом, селектор совпадёт с «A<B»');
  assert.doesNotMatch(css, /fancy|Lobster/, 'стиля нет в документе — переменная не нужна');
  assert.match(css, /--font-mono-lg: "Inter", system-ui, sans-serif;/, 'моно — по шрифту, не по имени стиля');
  assert.match(css, /--font-code: "JetBrains Mono", ui-monospace, monospace;/);
  const sign = css.split('\n').find((l) => l.startsWith('  --font-sign:'));
  assert.match(sign, /^  --font-sign: "a+\\"x", system-ui, sans-serif;$/, 'длинное имя целиком, строка закрыта');
});

test('круг100: фразы и слэш', () => {
  for (const s of ['экспортируй токены', 'экспорт токенов', 'экспорт css', '/экспорт css', 'скачай css-переменные', 'сохрани токены документа']) {
    assert.deepEqual(shellIntent(s, {}), { kind: 'export', what: 'css' }, s);
  }
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

test('круг100: в браузере — «экспортируй токены» скачивает CSS с палитрой документа', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
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
    const got = page.waitForEvent('download', { timeout: 10000 });
    await say('экспортируй токены');
    const dl = await got;
    // имя файла не проверяем: безголовый Chromium отдаёт кириллическое имя blob-загрузки как «download»
    const text = await readFile(await dl.path(), 'utf8');
    assert.match(text, /--color-brand: #7a5cff;/);
    assert.match(text, /\[data-screen="Оплата"\]/);
    await page.locator('.toast', { hasText: '-tokens.css' }).first().waitFor({ timeout: 5000 });
    // кнопка в окне экспорта
    await say('/экспорт');
    const btn = page.locator('#sheet-body button', { hasText: 'CSS-токены' });
    await btn.waitFor({ timeout: 5000 });
    assert.match(await btn.getAttribute('title'), /Пустая-страница-tokens\.css$/);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
