/**
 * Круг 93: правка агента на сервере приходит репликой мимо commit — предложение «Перекрасить и его»
 * (§15.25, §15.26) и для неё. Браузер против сервиса документа и оркестратора с поддельной моделью;
 * между ними — маленький прокси, как nginx: /agent/ — оркестратору, остальное (и сокет) — документу.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../src/core.js';
import http from 'node:http';
import net from 'node:net';
import { startFor } from './server/helpers.mjs';
import { startFakeLlm, startOrch } from './orchestrator/helpers.mjs';

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

function proxy(docPort, orchPort) {
  const target = (url) => (url.startsWith('/agent/') ? orchPort : docPort);
  const srv = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target(req.url), path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* закрыт */ } });
    req.pipe(up);
  });
  srv.on('upgrade', (req, socket, head) => {
    const up = net.connect(target(req.url), '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('круг93: сервер — агент сменил акцент экрана, слой с кодом прежнего — «Перекрасить и его»', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  const document = await startFor('memory', { staticDir: root });
  const docPort = document.port || (document.server && document.server.address().port);
  const llm = await startFakeLlm({
    plan: { intent: 'theme', title: 'Акцент экрана', summary: 'Синий акцент у «Итога»', steps: ['Тема'], targets: [] },
    theme: { board: true, boardName: 'Итог', colors: [{ name: 'accent', value: '#2255ff' }] },
  });
  const orch = await startOrch({ document: { port: docPort }, llm: { baseUrl: llm.base, apiKey: 'sk-test-key-0001' } });
  const orchPort = orch.port || (orch.server && orch.server.address().port) || Number(new URL(orch.url).port);
  const front = await proxy(docPort, orchPort);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto(`http://127.0.0.1:${front.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForFunction(() => /в сети/.test(document.body.innerText) && !/агент недоступен/.test(document.body.innerText), null, { timeout: 20000 });
    const say = async (text) => { await page.locator('#command').fill(text); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await say('/импорт');
    await (await chooser).setFiles({ name: 'hex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(screens())) });
    await page.locator('#layers .layer[data-id="B"]').waitFor({ timeout: 15000 });
    await page.locator('#layers .layer[data-id="B"]').click();
    await say('сделай акцент экрана Итог синим');
    const t = page.locator('.toast.stale-hex');
    await t.waitFor({ timeout: 20000 });
    assert.match(await t.innerText(), /1 слой на экране «Итог» окрашен кодом прежнего цвета/);
    assert.ok(llm.completions().some((c) => c.schema === 'theme'), 'тема — от модели через оркестратор');
    await t.locator('button.t-action').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((x) => /пошли за новым цветом/.test(x.innerText)), null, { timeout: 8000 });
    assert.deepEqual(errors, [], 'ошибок страницы нет');
  } finally {
    await browser.close();
    await new Promise((r) => { front.closeAllConnections?.(); front.close(() => r()); });
    await orch.close();
    await document.close();
    await llm.close();
  }
});
