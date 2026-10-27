/**
 * Круг 92: привязка цветов и «Перекрасить и их» (круги 85–90) — в серверном режиме, в браузере против
 * настоящего сервиса документа (память, клиент — из корня репозитория): импорт, кнопки, тост и отмена идут
 * через serverCommit/serverStep, а не через локальную историю.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import { startFor } from './server/helpers.mjs';

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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }

test('круг92: сервер — привязка одного экрана, всех экранов, «Перекрасить и его», отмена', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  const svc = await startFor('memory', { staticDir: root });
  const port = svc.port || (svc.server && svc.server.address().port);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForFunction(() => /в сети/.test(document.body.innerText), null, { timeout: 15000 });
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };
    const toastHas = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.innerText)), re.source, { timeout: 8000 });
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await say('/импорт');
    await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screens())) });
    await page.locator('#layers .layer[data-id="A"]').waitFor({ timeout: 15000 });
    // один экран — кнопкой: тост и блок пропал
    await page.locator('#layers .layer[data-id="A"]').click();
    await page.locator('#inspector .theme-hex button').first().click();
    await toastHas(/Экран «Оплата»: цвета 3 слоёв привязаны к палитре/);
    await page.waitForFunction(() => !document.querySelector('#inspector .theme-hex'), null, { timeout: 8000 });
    // отмена на сервере — коды вернулись
    await say('отмени');
    await page.locator('#inspector .theme-hex').waitFor({ timeout: 8000 });
    // все экраны — словами
    await say('привяжи цвета всех экранов к палитре');
    await toastHas(/Цвета 4 слоёв на 2 экранах привязаны к палитре/);
    await say('отмени');
    await page.locator('#inspector .theme-hex').waitFor({ timeout: 8000 });
    // цвет темы «Итога» сменили — тост «Перекрасить и его»; нажали — слой привязан (коды «Итога» кончились)
    await page.locator('#layers .layer[data-id="B"]').click();
    const row = page.locator('#inspector .theme-color-row[data-token="accent"] input.paint-color-input');
    await row.waitFor({ timeout: 10000 });
    await row.evaluate((el) => { el.value = '#2255ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const t = page.locator('.toast.stale-hex');
    await t.waitFor({ timeout: 8000 });
    assert.match(await t.innerText(), /1 слой на экране «Итог» окрашен кодом прежнего цвета/);
    // отмена закрывает предложение и на сервере
    await say('отмени');
    await page.waitForFunction(() => !document.querySelector('.toast.stale-hex'), null, { timeout: 8000 });
    await row.evaluate((el) => { el.value = '#2255ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.waitFor({ timeout: 8000 });
    await t.locator('button.t-action').click();
    await toastHas(/пошли за новым цветом/);
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    await svc.close();
  }
});
