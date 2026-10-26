/**
 * Круг 45 (UX r45 Д1) — дымовой прогон оболочки в настоящем браузере: «История» после своей
 * правки рисуется целиком и без ошибок страницы. Юнит-тесты `SHELL.historyOrder` не видели, что
 * `fillEdits` в app.js ссылался на необъявленную переменную: панель обрывалась на первой своей
 * правке. Браузера (Playwright) нет — тест пропускается.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
// Playwright — глобальный пакет стенда (require ищет и по NODE_PATH), в зависимостях проекта его нет
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Статика репозитория; /api, /ws и /agent — 404: оболочка работает без сервера (проекты в браузере). */
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/(api|ws|agent)(\/|$)/.test(path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":true,"code":"not_found"}'); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('r45: «История» после своей правки — своя строка с меткой «документ сейчас здесь», без ошибок страницы', { skip: !chromium && 'нет Playwright', timeout: 90000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command', { timeout: 30000 });
    await page.waitForTimeout(1500);
    // правка руками через таблицу команд: выделить всё на доске и скрыть
    for (const text of ['/выделить всё', '/скрыть']) {
      await page.fill('#command', text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    await page.click('#btn-history');
    await page.waitForTimeout(800);
    const items = await page.locator('#sheet-body .hitem').count();
    const now = await page.locator('#sheet-body .hnow').count();
    assert.deepEqual(errors, [], 'ошибок страницы нет');
    assert.ok(items >= 1, 'своя правка в ленте');
    assert.equal(now, 1, 'метка «документ сейчас здесь» у последней правки');
  } finally {
    await browser.close();
    srv.close();
  }
});

/* Круг 45, проход 3 (критик кода r45c, мутанты A4–A6): правки app.js — в настоящем браузере против
   настоящего Document service (память; он же раздаёт статику). */
async function withService(fn) {
  const { start } = await import('../server/document/index.js');
  const { createMemoryStorage } = await import('../server/document/storage/memory.js');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const svc = await start({ port: 0, storage: createMemoryStorage(), staticDir: root, pingInterval: 0, log: quiet });
  const browser = await chromium.launch();
  try { await fn(svc, browser); } finally { await browser.close(); await svc.close(); }
}
const post = async (svc, path, body) => {
  const r = await fetch(svc.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('r45: удаление сироты в «Проектах» — подтверждение, итог, фокус на строке списка; «есть правки» — пометка снята', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  await withService(async (svc, browser) => {
    const { createDoc } = await import('../src/core.js');
    const { CODE_ENGINE } = await import('../server/document/engine.js');
    const free = await post(svc, '/api/projects', { name: 'Спасение пустое', doc: createDoc(), create_id: 'rescue_smoke_1' });
    const busy = await post(svc, '/api/projects', { name: 'Спасение занятое', doc: createDoc(), create_id: 'rescue_smoke_2' });
    assert.equal(free.status, 201);
    // открывается последний проект — у открытого кнопки «Удалить» нет; открытым будет обычный
    assert.equal((await post(svc, '/api/projects', { name: 'Рабочий', doc: createDoc('demo') })).status, 201);
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    const now = Date.now();
    await page.addInitScript(([hints]) => { try { localStorage.setItem('imago.rescue.orphans.v1', hints); } catch {} }, [JSON.stringify([
      { name: 'Спасение пустое', since: now - 2000, keep: 'p_other', at: now + 60000, certain: true, createId: 'rescue_smoke_1' },
      { name: 'Спасение занятое', since: now - 2000, keep: 'p_other', at: now + 60000, certain: true, createId: 'rescue_smoke_2' }
    ])]);
    await page.goto(svc.url + '/');
    await page.waitForSelector('#btn-projects', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.click('#btn-projects');
    const row = (name) => page.locator('#sheet-body .pitem', { hasText: name });
    await row('Спасение пустое').waitFor({ timeout: 10000 });
    assert.match(await row('Спасение пустое').innerText(), /первая попытка/);
    // удаление: «Удалить» → подтверждение в строке → «Удалить»
    await row('Спасение пустое').getByRole('button', { name: 'Удалить' }).click();
    await row('Спасение пустое').locator('.pconfirm').getByRole('button', { name: 'Удалить' }).click();
    await page.locator('.toast', { hasText: 'Удалил пустую первую попытку «Спасение пустое»' }).waitFor({ timeout: 10000 });
    assert.equal(await row('Спасение пустое').count(), 0, 'строки нет');
    assert.equal(await page.evaluate(() => !!document.activeElement && document.activeElement.matches('.pitem .pname')), true, 'фокус — на строке списка, не на «Создать проект»');
    const left = await page.evaluate(() => JSON.parse(localStorage.getItem('imago.rescue.orphans.v1') || '[]').map((x) => x.createId));
    assert.deepEqual(left, ['rescue_smoke_2'], 'подсказка удалённой забыта');
    // «занятое»: в проект легла правка — 409 not_empty, список перечитан, пометки нет
    const snap = await (await fetch(`${svc.url}/api/projects/${busy.body.id}`)).json();
    const root2 = snap.snapshot.doc.root;
    // правка ложится ровно между подтверждением и DELETE (перехват запроса): сервер честно ответит 409
    await page.route(`**/api/projects/${busy.body.id}?*`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      assert.equal((await post(svc, `/api/projects/${busy.body.id}/tx`, { tx_id: 'tx_smoke_1', base_seq: 0, ops: [{ op: 'set', id: root2, path: 'name', value: 'z' }], engine: CODE_ENGINE })).status, 201);
      await route.continue();
    });
    await row('Спасение занятое').getByRole('button', { name: 'Удалить' }).click();
    await row('Спасение занятое').locator('.pconfirm').getByRole('button', { name: 'Удалить' }).click();
    await page.locator('.toast', { hasText: 'уже есть правки' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    assert.doesNotMatch(await row('Спасение занятое').innerText(), /первая попытка/, 'список перечитан: правка есть, сироты нет');
    assert.equal(await row('Спасение занятое').getByRole('button', { name: 'Удалить' }).count(), 0);
    assert.deepEqual(errors, []);
  });
});

test('r45: «История» соавтора — чужая правка руками подписана словами автора, вживую', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  await withService(async (svc, browser) => {
    const a = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    a.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await a.goto(svc.url + '/');
    await a.waitForFunction(() => new URL(location.href).searchParams.get('project'), null, { timeout: 30000 });
    const id = await a.evaluate(() => new URL(location.href).searchParams.get('project'));
    const b = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    b.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await b.goto(`${svc.url}/?project=${id}`);
    await b.waitForSelector('#command', { timeout: 30000 });
    await a.waitForTimeout(1500);
    await b.waitForTimeout(1500);
    // проект новый и пустой: доска руками, затем «выделить всё» и «скрыть» — правка руками с подписью автора
    await a.getByText('Пустая доска').click();
    await a.waitForTimeout(800);
    for (const text of ['/выделить всё', '/скрыть']) {
      await a.fill('#command', text);
      await a.keyboard.press('Enter');
      await a.waitForTimeout(600);
    }
    await a.click('#btn-history');
    const mine = (await a.locator('#sheet-body .hitem[data-current="true"] .what').first().innerText()).trim();
    await b.waitForTimeout(1500);
    await b.click('#btn-history');
    const theirs = b.locator('#sheet-body .hitem[data-who="other"] .what').first();
    await theirs.waitFor({ timeout: 10000 });
    assert.ok(mine, 'у автора есть строка');
    assert.equal((await theirs.innerText()).trim(), mine, 'у соавтора — те же слова, что у автора');
    assert.deepEqual(errors, []);
  });
});
