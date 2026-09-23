/**
 * Дымовые проверки клиента против мока (packages/client/dev/mock-server.mjs) на production‑сборке.
 * Запуск: npm run build -w packages/client && npm test -w packages/client
 * (Playwright 1.56.0, Chromium из PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers; `playwright install` не нужен).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMockServer } from '../dev/mock-server.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const distDir = path.join(clientRoot, 'dist');
const DOC = 'doc-alice-1';
// Пароли тестовых учёток в production-сборку клиента не входят (§1.6, packages/client/src/config.ts):
// открывающий передаёт их параметром ?pass=.
const PASSWORDS = { alice: 'alice-pass', bob: 'bob-pass' };
const PAGES = 10;
const pid = (i) => `${DOC}-p${i}`;
const SRC1 = `${DOC}-src-1`;
/** страницы с экземплярами источника 1 (см. generateDoc): library + 2, 4, 6, последняя */
const SRC1_PAGES = [pid(0), pid(2), pid(4), pid(6), pid(9)];
const LATENCY_MS = 20;

let mock;
let base;
let browser;

before(async () => {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    execFileSync('npx', ['vite', 'build'], { cwd: clientRoot, stdio: 'inherit' });
  }
  mock = createMockServer({ latency: LATENCY_MS, staticDir: distDir, pages: PAGES, shapesPerPage: 50, quiet: true });
  const port = await mock.listen(0);
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await mock?.close();
});

// ------------------------------------------------------------------ helpers

async function openStand(params) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // «Failed to load resource» печатает сам браузер для ожидаемых 409/оборванных ответов — это не ошибки приложения
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  const qs = new URLSearchParams({ doc: DOC, autologin: 'alice', pass: PASSWORDS.alice, ...params });
  await page.goto(`${base}/?${qs.toString()}`);
  await page.waitForFunction(
    () =>
      window.__stand &&
      window.__stand.events.some((e) => e.type === 'page-ready' || (e.type === 'error' && e.detail?.scope === 'open')),
    null,
    { timeout: 20000 },
  );
  return { context, page, errors };
}

const evalStand = (page, fn, arg) => page.evaluate(fn, arg);

async function clickPage(page, pageId) {
  await page.click(`button[data-page-id="${pageId}"]`);
  return evalStand(
    page,
    (id) => window.__stand.waitFor('page-ready', (e) => e.detail.pageId === id, 15000),
    pageId,
  );
}

async function selectPage(page, pageId) {
  return evalStand(page, (id) => {
    window.__stand.selectPage(id);
    return window.__stand.waitFor('page-ready', (e) => e.detail.pageId === id, 15000);
  }, pageId);
}

const retained = (page) => evalStand(page, () => window.__stand.getRetained());
const loaded = (page) => evalStand(page, () => window.__stand.getLoadedPages());
const snapshot = (page, id) => evalStand(page, (p) => window.__stand.getPageSnapshot(p), id);
const stateOf = (page) => evalStand(page, () => window.__stand.state);
const events = (page, type) => evalStand(page, (t) => window.__stand.events.filter((e) => e.type === t), type);

async function runCommand(page, cmd) {
  return evalStand(page, async (c) => {
    const result = await window.__stand.runCommand(c);
    const acked = await window.__stand.waitFor('command-acked', (e) => e.detail.opId === result.opId, 15000);
    const drawn = await window.__stand.waitFor('command-drawn', (e) => e.detail.opId === result.opId, 15000);
    return { result, acked, drawn, pending: window.__stand.pendingCommands, state: window.__stand.state };
  }, cmd);
}

function assertSourceFillApplied(snap, fill) {
  const instances = snap.shapes.filter((s) => s.id.includes('-p') && !s.id.includes('src'));
  assert.ok(instances.length > 0);
  const changed = snap.shapes.filter((s) => s.fill === fill);
  assert.ok(changed.length >= 3, `ожидались перекрашенные экземпляры на странице, найдено ${changed.length}`);
  const overridden = snap.shapes.filter((s) => s.fillOverridden);
  for (const s of overridden) assert.notEqual(s.fill, fill, 'переопределённый экземпляр не должен меняться');
}

// ------------------------------------------------------------------ сценарий для каждой конфигурации

function scenario(adapter, mode, cache) {
  const label = `${adapter}/${mode}${mode === 'P' ? `/cache=${cache}` : ''}`;
  it(`${label}: открытие, 3 перехода, команда, поздний переход, LRU/полная загрузка, повтор, logout`, async () => {
    // сброс документа между конфигурациями
    await fetch(`${base}/api/test/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: DOC }) });
    const opsBefore = mock.state.operations.size;
    mock.state.reads = { inFlight: 0, max: 0, total: 0 };
    const { context, page, errors } = await openStand({ adapter, mode, cache: String(cache) });
    try {
      // 1. открытие: первая страница готова и отрисована
      const first = await evalStand(page, () => ({
        state: window.__stand.state,
        active: window.__stand.activePageId,
        drawn: window.__stand.drawn,
        config: window.__stand.config,
        ready: window.__stand.events.filter((e) => e.type === 'page-ready'),
      }));
      assert.equal(first.state, 'ready');
      assert.equal(first.active, pid(0));
      assert.equal(first.drawn.pageId, pid(0));
      assert.equal(first.drawn.shapeCount, 50);
      assert.equal(first.ready.length, 1);
      assert.equal(first.config.adapter, adapter);
      assert.equal(first.config.mode, mode);
      assert.equal(await page.getAttribute('[data-testid="state"]', 'data-state'), 'ready');
      assert.equal(await page.getAttribute('[data-testid="adapter-badge"]', 'data-adapter'), adapter);

      // 2. три перехода кликами по списку страниц
      for (const i of [1, 2, 3]) {
        const ev = await clickPage(page, pid(i));
        assert.equal(ev.detail.pageId, pid(i));
        assert.equal(ev.detail.shapeCount, 50);
        assert.equal(await stateOf(page), 'ready');
        assert.equal(await evalStand(page, () => window.__stand.activePageId), pid(i));
        if (mode === 'P') {
          const r = await retained(page);
          assert.ok(r.pages <= cache + 1, `${label}: retained.pages=${r.pages} > cache+1`);
          assert.ok(r.pages >= 1);
          assert.equal(r.shapes, r.pages * 50);
        }
      }
      if (mode === 'F') {
        await page.waitForFunction((n) => window.__stand.getLoadedPages().length === n, PAGES, { timeout: 15000 });
        const r = await retained(page);
        assert.equal(r.pages, PAGES, 'в режиме F удерживаются все страницы');
        assert.equal(r.shapes, PAGES * 50);
        assert.ok(mock.state.reads.max >= 2, `F: ожидалась параллельная загрузка, max=${mock.state.reads.max}`);
        assert.ok(mock.state.reads.max <= 4, `F: параллелизм чтений ${mock.state.reads.max} > 4`);
        assert.equal(mock.state.reads.total, PAGES, 'F: каждая страница прочитана ровно один раз');
      } else {
        const l = await loaded(page);
        assert.ok(l.includes(pid(3)));
        assert.ok(l.length <= cache + 1);
      }

      // 3. команда «общая заливка источника» с неактивной для источника страницы 3
      const FILL = '#00aa00';
      const c1 = await runCommand(page, { type: 'setSourceFill', targetId: SRC1, fill: FILL });
      assert.equal(c1.result.revision, 1);
      assert.deepEqual([...c1.result.affectedPages].sort(), [...SRC1_PAGES].sort());
      assert.equal(c1.acked.detail.revision, 1);
      assert.equal(c1.drawn.detail.pageId, pid(3));
      assert.ok(c1.drawn.detail.drawnRevision >= 1);
      assert.ok(c1.drawn.t >= c1.acked.t);
      assert.equal(c1.pending, 0);
      assert.equal(c1.state, 'ready');
      const sent = await events(page, 'command-sent');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].detail.expectedRevision, 0);

      // 4. страница 2 уже посещалась и затронута: после перехода видны новые заливки
      const ev2 = await clickPage(page, pid(2));
      assert.ok(ev2.detail.revision >= 1, `ревизия готовности ${ev2.detail.revision}`);
      assertSourceFillApplied(await snapshot(page, pid(2)), FILL);

      // 5. поздний переход на страницу 9 (не посещалась) — команда учтена
      const ev9 = await clickPage(page, pid(9));
      assert.ok(ev9.detail.revision >= 1);
      const snap9 = await snapshot(page, pid(9));
      assertSourceFillApplied(snap9, FILL);
      if (mode === 'F') {
        // затронутая неактивная библиотека перечитана в фоне (тот же ограничитель параллелизма)
        await page.waitForFunction(
          ({ p0, src, fill }) => window.__stand.getPageSnapshot(p0)?.shapes.find((s) => s.id === src)?.fill === fill,
          { p0: pid(0), src: SRC1, fill: FILL },
          { timeout: 5000 },
        );
      }

      // 6. локальная заливка экземпляра на странице 9; переопределение переживает вытеснение из окна
      const inst = snap9.shapes.find((s) => s.fill === FILL);
      const LOCAL = '#112233';
      const c2 = await runCommand(page, { type: 'setLocalFill', targetId: inst.id, fill: LOCAL });
      assert.equal(c2.result.revision, 2);
      assert.deepEqual(c2.result.affectedPages, [pid(9)]);
      assert.equal(c2.drawn.detail.pageId, pid(9));
      let s9 = (await snapshot(page, pid(9))).shapes.find((s) => s.id === inst.id);
      assert.equal(s9.fill, LOCAL);
      assert.equal(s9.fillOverridden, true);
      await clickPage(page, pid(1));
      await clickPage(page, pid(5));
      if (mode === 'P') {
        const l = await loaded(page);
        assert.ok(!l.includes(pid(9)) || cache >= 2, 'P: страница 9 вытеснена из окна');
        assert.ok((await retained(page)).pages <= cache + 1);
      }
      await clickPage(page, pid(9));
      s9 = (await snapshot(page, pid(9))).shapes.find((s) => s.id === inst.id);
      assert.equal(s9.fill, LOCAL);
      assert.equal(s9.fillOverridden, true);

      // 7. общая заливка не снимает локальное переопределение
      const FILL2 = '#0000aa';
      const c3 = await runCommand(page, { type: 'setSourceFill', targetId: SRC1, fill: FILL2 });
      assert.equal(c3.result.revision, 3);
      const after3 = await snapshot(page, pid(9));
      assert.equal(after3.shapes.find((s) => s.id === inst.id).fill, LOCAL);
      assert.ok(after3.shapes.some((s) => s.fill === FILL2));

      // 8. повтор команды при обрыве ответа: сервер обработал, клиент получил ошибку → опрос операции, тот же opId
      let aborted = 0;
      await page.route('**/api/documents/*/commands', async (route) => {
        if (aborted === 0) {
          aborted += 1;
          await route.fetch(); // сервер выполняет команду…
          await route.abort('connectionreset'); // …но ответ до клиента не доходит
          return;
        }
        await route.continue();
      });
      const logBefore = mock.state.commandLog.length;
      const c4 = await runCommand(page, { type: 'setLocalFill', targetId: `${DOC}-p9-s10`, fill: '#445566' });
      await page.unroute('**/api/documents/*/commands');
      assert.equal(aborted, 1);
      assert.equal(c4.result.revision, 4);
      const retries = await events(page, 'command-retry');
      assert.ok(retries.some((e) => e.detail.opId === c4.result.opId && e.detail.via === 'poll'), 'ожидалось command-retry via poll');
      assert.equal(mock.state.commandLog.length, logBefore + 1, 'в журнале одна операция');
      assert.equal(mock.state.operations.size - opsBefore, 4);
      assert.equal(mock.state.docs.get(DOC).revision, 4);
      assert.equal((await snapshot(page, pid(9))).shapes.find((s) => s.id === `${DOC}-p9-s10`).fill, '#445566');

      // 9. ответ старого чтения: задержанный ответ, пришедший после команды, не восстанавливает старый цвет
      await fetch(`${base}/api/test/delay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPattern: `pages/${pid(4)}$`, ms: 600, once: true }),
      });
      const FILL3 = '#aa00aa';
      const late = await evalStand(page, async ({ p4, target, fill }) => {
        const t0 = performance.now();
        window.__stand.selectPage(p4); // в P чтение p4 задержано на сервере; в F страница уже есть
        await new Promise((r) => setTimeout(r, 50));
        const result = await window.__stand.runCommand({ type: 'setSourceFill', targetId: target, fill });
        const drawn = await window.__stand.waitFor('command-drawn', (e) => e.detail.opId === result.opId, 15000);
        const ready = await window.__stand.waitFor('page-ready', (e) => e.detail.pageId === p4, 15000, t0);
        await new Promise((r) => setTimeout(r, 900)); // даём задержанному ответу прийти
        return { result, drawn, ready, snap: window.__stand.getPageSnapshot(p4), state: window.__stand.state };
      }, { p4: pid(4), target: SRC1, fill: FILL3 });
      assert.equal(late.result.revision, 5);
      // P: страница читалась впервые → готовность только на ревизии ≥ 5 (старый ответ отброшен);
      // F: страница была готова до команды (rev 4), актуальность после команды фиксирует command-drawn
      assert.ok(late.ready.detail.revision >= (mode === 'F' ? 4 : 5), `page-ready p4 rev=${late.ready.detail.revision}`);
      assert.ok(late.drawn.detail.drawnRevision >= 5);
      assert.equal(late.drawn.detail.pageId, pid(4));
      assert.equal(late.state, 'ready');
      assertSourceFillApplied(late.snap, FILL3);
      assert.ok(!late.snap.shapes.some((s) => s.fill === FILL2), 'старый цвет не вернулся');
      assert.ok(late.snap.revision >= 5);

      // 10. rAF‑семантика: drawn.at после page-ready/command-drawn всегда позже команды
      const cd = await events(page, 'command-drawn');
      assert.equal(cd.length, 5);
      for (const e of cd) assert.ok(e.detail.sinceSent > 0);
      assert.ok(mock.state.reads.max <= 4, `параллелизм чтений ${mock.state.reads.max} > 4`);

      // 11. logout: хранилище адаптера пусто, storage чист, форма входа
      await evalStand(page, () => window.__stand.logout());
      const afterLogout = await evalStand(page, () => ({
        retained: window.__stand.getRetained(),
        loaded: window.__stand.getLoadedPages(),
        state: window.__stand.state,
        ls: localStorage.length,
        ss: sessionStorage.length,
        logout: window.__stand.events.filter((e) => e.type === 'logout').length,
      }));
      assert.deepEqual(afterLogout.retained, { pages: 0, shapes: 0, bytesEstimate: 0 });
      assert.deepEqual(afterLogout.loaded, []);
      assert.equal(afterLogout.state, 'idle');
      assert.equal(afterLogout.ls, 0);
      assert.equal(afterLogout.ss, 0);
      assert.equal(afterLogout.logout, 1);
      await page.waitForSelector('[data-testid="login-form"]', { timeout: 5000 });
      const dbs = await evalStand(page, () => indexedDB.databases().then((d) => d.length));
      assert.equal(dbs, 0);

      assert.deepEqual(errors, [], `ошибки в консоли: ${errors.join('\n')}`);
    } finally {
      await context.close();
    }
  });
}

describe('client smoke', () => {
  scenario('H', 'P', 1);
  scenario('Q', 'P', 1);
  scenario('H', 'F', 1);
  scenario('Q', 'F', 1);
  scenario('H', 'P', 3);
  scenario('Q', 'P', 3);

  for (const adapter of ['H', 'Q']) {
    it(`${adapter}/P: смена страницы отменяет незавершённое чтение прежней`, async () => {
      const slow = createMockServer({ latency: 400, staticDir: distDir, pages: 4, shapesPerPage: 20, quiet: true });
      const port = await slow.listen(0);
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${port}/?adapter=${adapter}&mode=P&cache=1&doc=${DOC}&autologin=alice&pass=${PASSWORDS.alice}`);
        await page.waitForFunction(() => window.__stand?.events.some((e) => e.type === 'page-ready'), null, { timeout: 15000 });
        slow.state.reads = { inFlight: 0, max: 0, total: 0, aborted: 0 };
        const r = await evalStand(page, async ({ p1, p2 }) => {
          window.__stand.selectPage(p1);
          await new Promise((res) => setTimeout(res, 100)); // запрос p1 в полёте (latency 400)
          window.__stand.selectPage(p2);
          const ready = await window.__stand.waitFor('page-ready', (e) => e.detail.pageId === p2, 15000);
          await new Promise((res) => setTimeout(res, 500)); // даём прежнему ответу (если бы он был) прийти
          return { ready, loaded: window.__stand.getLoadedPages(), readyEvents: window.__stand.events.filter((e) => e.type === 'page-ready').length };
        }, { p1: pid(1), p2: pid(2) });
        assert.equal(r.ready.detail.pageId, pid(2));
        assert.equal(slow.state.reads.aborted, 1, 'чтение p1 должно быть отменено');
        assert.ok(!r.loaded.includes(pid(1)), 'отменённая страница не удерживается');
        assert.equal(r.readyEvents, 2, 'page-ready только для открытия и для p2');
      } finally {
        await context.close();
        await slow.close();
      }
    });
  }

  for (const adapter of ['H', 'Q']) {
    it(`${adapter}/P: revision_mismatch → перечитывание метаданных и один повтор`, async () => {
      await fetch(`${base}/api/test/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: DOC }) });
      const { context, page, errors } = await openStand({ adapter, mode: 'P', cache: '1' });
      try {
        await clickPage(page, pid(2));
        // внешнее изменение документа (другой клиент): ревизия 0 → 1
        const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'alice', password: 'alice-pass' }) })).json();
        const ext = await (await fetch(`${base}/api/documents/${DOC}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
          body: JSON.stringify({ opId: `ext-${Date.now()}`, type: 'setLocalFill', targetId: `${DOC}-p2-s20`, fill: '#777777', expectedRevision: 0 }),
        })).json();
        assert.equal(ext.revision, 1);
        const c = await runCommand(page, { type: 'setLocalFill', targetId: `${DOC}-p2-s21`, fill: '#888888' });
        assert.equal(c.result.revision, 2);
        const sent = await events(page, 'command-sent');
        assert.deepEqual(sent.map((e) => e.detail.expectedRevision), [0, 1]);
        assert.equal(sent[0].detail.opId, sent[1].detail.opId, 'повтор с тем же opId');
        const retries = await events(page, 'command-retry');
        assert.ok(retries.some((e) => e.detail.via === 'revision_mismatch'));
        const snap = await snapshot(page, pid(2));
        assert.equal(snap.revision, 2);
        assert.equal(snap.shapes.find((s) => s.id === `${DOC}-p2-s20`).fill, '#777777', 'внешнее изменение подхвачено');
        assert.equal(snap.shapes.find((s) => s.id === `${DOC}-p2-s21`).fill, '#888888');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  // Адаптер Z (@rocicorp/zero) требует реальных zero-cache + API: его поведение проверяет test/z.spec.mjs
  // (STAND_Z_E2E=1). Здесь, против мока (нет /zero), проверяется то, что от Z зависит у ВСЕХ адаптеров:
  // разделение bundle по адаптерам (H/Q не грузят chunk Zero, Z не грузит chunk TanStack Query) и единый
  // контракт getRetainedAsync().
  it('bundle разделён по адаптерам: H/Q не загружают chunk Zero, Z — chunk Query; Z против мока ждёт /zero', async () => {
    /** @param {Record<string,string>} params */
    const loaded = async (params) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const urls = [];
      page.on('response', (r) => urls.push(new URL(r.url()).pathname));
      const qs = new URLSearchParams({ doc: DOC, autologin: 'alice', pass: PASSWORDS.alice, ...params });
      await page.goto(`${base}/?${qs.toString()}`);
      // H/Q: готовность страницы; Z: адаптер создан (chunk загружен), но /zero у мока нет → остаётся 'loading'
      await page.waitForFunction(
        (adapter) => window.__stand && (adapter === 'Z' ? window.__stand.state === 'loading' : window.__stand.state === 'ready'),
        params.adapter,
        { timeout: 20000 },
      );
      const chunks = urls.filter((u) => /\/assets\/.*\.js$/.test(u)).map((u) => u.replace(/^.*\/assets\//, '').replace(/-[\w-]+\.js$/, ''));
      const state = await evalStand(page, () => window.__stand.state);
      await context.close();
      return { chunks: new Set(chunks), state };
    };
    const h = await loaded({ adapter: 'H', mode: 'P', cache: '1' });
    const q = await loaded({ adapter: 'Q', mode: 'P', cache: '1' });
    const z = await loaded({ adapter: 'Z', mode: 'P', cache: '1' });
    assert.ok(h.chunks.has('index') && h.chunks.has('h') && !h.chunks.has('q') && !h.chunks.has('z'), `H загрузил ${[...h.chunks]}`);
    assert.ok(q.chunks.has('q') && !q.chunks.has('h') && !q.chunks.has('z'), `Q загрузил ${[...q.chunks]}`);
    assert.ok(z.chunks.has('z') && !z.chunks.has('q') && !z.chunks.has('h'), `Z загрузил ${[...z.chunks]}`);
    assert.equal(h.state, 'ready');
    assert.equal(q.state, 'ready');
    assert.equal(z.state, 'loading', 'Z без zero-cache не считает страницу готовой (частичный/отсутствующий набор ≠ готовность)');
  });

  for (const adapter of ['H', 'Q']) {
    it(`${adapter}: getRetainedAsync() есть в window.__stand и совпадает с getRetained()`, async () => {
      const { context, page, errors } = await openStand({ adapter, mode: 'P', cache: '1' });
      try {
        await clickPage(page, pid(2));
        const r = await evalStand(page, async () => ({ sync: window.__stand.getRetained(), async: await window.__stand.getRetainedAsync() }));
        assert.deepEqual(r.async, r.sync);
        assert.equal(r.sync.pages, 2);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  it('без autologin показывается форма входа; токен не попадает в storage', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?adapter=H&mode=P&cache=1&doc=${DOC}`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.fill('input[name="login"]', 'alice');
      await page.fill('input[name="password"]', 'alice-pass');
      await page.click('button[data-action="login"]');
      await page.waitForFunction(() => window.__stand.events.some((e) => e.type === 'page-ready'), null, { timeout: 15000 });
      const st = await evalStand(page, () => ({ ls: localStorage.length, ss: sessionStorage.length, state: window.__stand.state }));
      assert.equal(st.state, 'ready');
      assert.equal(st.ls, 0);
      assert.equal(st.ss, 0);
    } finally {
      await context.close();
    }
  });

  it('чужой документ → 403 → состояние error', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?adapter=H&mode=P&cache=1&doc=doc-bob-1&autologin=alice&pass=${PASSWORDS.alice}`);
      await page.waitForFunction(() => window.__stand?.state === 'error', null, { timeout: 15000 });
      const errs = await events(page, 'error');
      assert.ok(errs.some((e) => e.detail.scope === 'open'));
    } finally {
      await context.close();
    }
  });

  it('страница из 1000 фигур рисуется быстрее 50 мс', async () => {
    const big = createMockServer({ latency: 0, staticDir: distDir, pages: 3, shapesPerPage: 1000, quiet: true });
    const port = await big.listen(0);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/?adapter=H&mode=P&cache=1&doc=${DOC}&autologin=alice&pass=${PASSWORDS.alice}`);
      await page.waitForFunction(() => window.__stand?.events.some((e) => e.type === 'page-ready'), null, { timeout: 15000 });
      const r = await evalStand(page, () => ({
        drawn: window.__stand.drawn,
        ms: window.__standController.renderer.lastDrawMs,
      }));
      assert.equal(r.drawn.shapeCount, 1000);
      assert.ok(r.ms < 50, `draw took ${r.ms} ms`);
    } finally {
      await context.close();
      await big.close();
    }
  });
});
