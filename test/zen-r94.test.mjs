/**
 * Круг 94 (SPEC §24): зен-режим. Только холст, справа сверху — статус задач, справа снизу —
 * микрофон. Голос пишет в ту же строку команды и идёт тем же путём, что и печать.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as SHELL from '../src/shell.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFile(join(root, f), 'utf8');

test('круг94: зен-режим словами, голосом и «/зен» — команда оболочки, не агента', () => {
  const on = ['зен-режим', 'зен режим', 'включи зен-режим', 'дзен', 'режим зен', 'только холст', 'спрячь панели', '/зен', '/zen', '/зен вкл'];
  const off = ['выйди из зен-режима', 'выйди из зена', 'выйди из дзен режима', 'выключи зен', 'верни панели', 'покажи интерфейс', '/зен выкл'];
  for (const p of on) assert.deepEqual(SHELL.shellIntent(p, {}), { kind: 'zen', on: true }, p);
  for (const p of off) assert.deepEqual(SHELL.shellIntent(p, {}), { kind: 'zen', on: false }, p);
  // похожие слова — работа агента
  for (const p of ['зелёный фон', 'сделай зеленую кнопку', 'добавь панель навигации']) assert.equal(SHELL.shellIntent(p, {}), null, p);
  assert.equal(SHELL.commandIdOf({ kind: 'zen', on: true }), 'zen');
  const cmd = SHELL.shellCommand('zen');
  assert.equal(cmd.group, 'Вид');
  assert.equal(cmd.keys, 'Mod+\\');
  assert.equal(SHELL.keyLabel(cmd.keys, { mac: true }), '⌘\\');
  // сервер агента может прислать то же намерение
  assert.deepEqual(SHELL.shellIntentFromServer({ action: 'zen', args: { on: false } }), { kind: 'zen', on: false });
  assert.deepEqual(SHELL.shellIntentFromServer({ action: 'zen' }), { kind: 'zen', on: true });
});

test('круг94: разметка и стили — статус, микрофон, кнопка в шапке', async () => {
  const html = await read('index.html');
  assert.match(html, /id="btn-zen"[^>]*aria-pressed="false"/);
  assert.match(html, /id="zenbar"[^>]*hidden/);
  assert.match(html, /id="zen-status"[^>]*role="status"/);
  assert.match(html, /id="btn-zen-mic"[^>]*hidden/);
  const css = await read('styles.css');
  for (const k of ['.app[data-zen="on"] .topbar', '.app[data-zen="on"] .commandbar', '.app[data-zen="on"] .rail',
    '.app[data-zen="on"] .inspector', '.app[data-zen="on"] .viewbar', '.dockmsg[data-zen-quiet="on"]', '.app[data-work="on"] .zenbar']) {
    assert.ok(css.includes(k), k);
  }
});

/* ── в настоящем браузере ───────────────────────────────────────────────── */
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
/* Страница как dev.html (tools/build.mjs): заглушка модели перед разметкой, сервера нет. */
const DEV_TOP = '<script>window.IMAGO_DEFAULTS = { server: false };</script>\n<script src="tools/stub.js"></script>\n';
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/(api|ws|agent)(\/|$)/.test(path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":true,"code":"not_found"}'); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      let body = await readFile(file);
      if (path === '/') body = DEV_TOP + body;
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/* Распознавание речи браузера — подставное: тест говорит за человека через window.__say. */
const FAKE_SPEECH = () => {
  class FakeRecognition {
    start() { window.__rec = this; }
    stop() { if (window.__rec === this) window.__rec = null; if (this.onend) this.onend(); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__say = (text, isFinal = true) => {
    const r = window.__rec;
    if (!r || !r.onresult) return false;
    const res = Object.assign([{ transcript: text }], { isFinal });
    r.onresult({ resultIndex: 0, results: [res] });
    return true;
  };
};

test('круг94: в браузере — зен-режим прячет панели, микрофон ведёт команду агенту, статус показывает итог, Esc и голос выводят', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(FAKE_SPEECH);
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const shown = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    }, sel);

    assert.equal(await shown('#zenbar'), false);
    assert.equal(await shown('#btn-zen-mic'), false);
    await page.click('#btn-zen');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#app').dataset.zen), 'on');
    for (const sel of ['.topbar', '#rail', '#inspector', '#viewbar', '#commandbar', '#hints']) assert.equal(await shown(sel), false, `${sel} виден в зен-режиме`);
    assert.equal(await shown('#canvas'), true);
    assert.equal(await shown('#zenbar'), true);
    assert.equal(await shown('#btn-zen-mic'), true);
    assert.equal(await page.textContent('#zen-text'), 'Жду команду');
    // статус справа сверху, микрофон справа снизу
    const box = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
      return { st: r('#zen-status'), mic: r('#btn-zen-mic'), w: innerWidth, h: innerHeight };
    });
    assert.ok(box.st.right > box.w - 80 && box.st.top < 40, `статус: ${JSON.stringify(box.st)}`);
    assert.ok(box.mic.right > box.w - 60 && box.mic.bottom > box.h - 60, `микрофон: ${JSON.stringify(box.mic)}`);
    // переживает перезагрузку
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('imago.settings.v1')).zen), true);

    // голос: микрофон в углу → сессия → сказанное уходит агенту
    await page.click('#btn-zen-mic');
    await page.waitForTimeout(150);
    assert.equal(await shown('#voicebar'), true);
    assert.equal(await shown('#btn-zen-mic'), false, 'включённый микрофон заменяет спокойный');
    assert.equal(await page.evaluate(() => window.__say('добавь карточку оплаты', false)), true);
    assert.equal((await page.textContent('#voice-said')).trim(), 'добавь карточку оплаты');
    await page.evaluate(() => window.__say('добавь карточку оплаты', true));
    // пауза в речи — конец команды; агент работает — ход работы на месте статуса
    await page.waitForSelector('#worklog:not([hidden])', { timeout: 10000 });
    assert.equal(await shown('#zenbar'), false, 'пока агент работает, статус — это ход работы');
    await page.waitForFunction(() => document.querySelector('#worklog').hidden, null, { timeout: 60000 });
    await page.waitForTimeout(200);
    assert.equal(await shown('#zenbar'), true);
    assert.match(await page.textContent('#zen-text'), /^Готово/);
    assert.equal(await shown('#dockmsg'), false, 'итог правки — в статусе, а не карточкой внизу');
    assert.equal(await shown('#btn-zen-mic'), true, 'одна команда за нажатие: микрофон снова ждёт');

    // выйти голосом
    await page.click('#btn-zen-mic');
    await page.evaluate(() => window.__say('выйди из зен-режима', true));
    await page.waitForFunction(() => document.querySelector('#app').dataset.zen !== 'on', null, { timeout: 5000 });
    assert.equal(await shown('.topbar'), true);
    assert.equal(await shown('#commandbar'), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('imago.settings.v1')).zen), false);

    // Ctrl+\ — туда, Esc — обратно
    await page.click('#canvas', { position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Backslash');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.querySelector('#app').dataset.zen), 'on');
    await page.reload();
    await page.waitForSelector('#command', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.querySelector('#app').dataset.zen), 'on', 'после перезагрузки зен-режим на месте');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    assert.notEqual(await page.evaluate(() => document.querySelector('#app').dataset.zen), 'on');
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    srv.close();
  }
});
