/**
 * Проверки адаптера Z (@rocicorp/zero 1.9.0) против РЕАЛЬНЫХ сервисов: API с тестовыми хуками,
 * zero-cache и (необязательно) netshaper. Без переменной STAND_Z_E2E=1 набор пропускается, чтобы
 * `npm test` проходил без поднятого стенда.
 *
 *   STAND_Z_E2E=1 node --test test/z.spec.mjs         (или npm run test:z -w packages/client)
 *
 * Переменные: STAND_Z_API (http://127.0.0.1:3002 — API со STAND_TEST_HOOKS=1, отдаёт dist клиента),
 * STAND_Z_CACHE (http://127.0.0.1:4848 — zero-cache; проверка готовности; при STAND_Z_CACHE_DIRECT=1 передаётся
 * клиенту как ?zero= вместо прокси /zero самого API),
 * STAND_Z_SHAPER (http://127.0.0.1:8082 — origin шейпера с маршрутами /api, /zero, /; пусто — пропустить),
 * STAND_Z_SHAPER_STATS (http://127.0.0.1:8083), STAND_Z_DOC (doc-acc-50x500), STAND_Z_SRC (doc-acc-50x500-src-1),
 * STAND_Z_PAGES (50), STAND_Z_SHAPES (500).
 * Документ сбрасывается хуком POST /api/test/reset перед каждой конфигурацией и в конце.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const ENABLED = process.env.STAND_Z_E2E === '1';
const API = process.env.STAND_Z_API ?? 'http://127.0.0.1:3002';
const CACHE = process.env.STAND_Z_CACHE ?? 'http://127.0.0.1:4848';
const SHAPER = process.env.STAND_Z_SHAPER ?? '';
const SHAPER_STATS = process.env.STAND_Z_SHAPER_STATS ?? 'http://127.0.0.1:8083';
const DOC = process.env.STAND_Z_DOC ?? 'doc-acc-50x500';
// пароли тестовых учёток передаются клиенту параметром ?pass= (в сборку они не входят, §1.6)
const PASSWORDS = { alice: 'alice-pass', bob: 'bob-pass' };
const SRC = process.env.STAND_Z_SRC ?? `${DOC}-src-1`;
const PAGES = Number(process.env.STAND_Z_PAGES ?? 50);
const SHAPES = Number(process.env.STAND_Z_SHAPES ?? 500);
const NEW_FILL = '#00aa77';
const LOCAL_FILL = '#ff3366';
const pid = (i) => `${DOC}-p${i}`;

const describeZ = ENABLED ? describe : describe.skip;

// Пропуск набора обязан быть ВИДЕН в счётчиках: `describe.skip` не увеличивает `skipped`, поэтому
// `npm test --workspaces` печатал «pass 16 / skipped 0» при том, что 403 строки проверок адаптера Z
// против реального стека не выполнялись вовсе (критик 3, дефект 7). Отдельный пропущенный тест
// даёт `skipped 1` и строку с причиной, а предупреждение в stderr видно и без разбора счётчиков.
if (!ENABLED) {
  process.stderr.write(
    '\n  ВНИМАНИЕ: набор проверок адаптера Z (test/z.spec.mjs) ПРОПУЩЕН: нужен STAND_Z_E2E=1 и поднятый стенд.\n' +
      '  Без него самый сложный адаптер (packages/client/src/adapters/z.ts) этой командой не проверен.\n' +
      '  Полная проверка: npm run test:z -w packages/client\n\n',
  );
  it('адаптер Z против реального стека (STAND_Z_E2E=1, npm run test:z -w packages/client)', { skip: 'STAND_Z_E2E != 1 — набор не выполнялся' }, () => {});
}

let browser;
const resetDoc = () =>
  fetch(`${API}/api/test/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: DOC }) });

async function login(user = 'alice', pass = 'alice-pass') {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: user, password: pass }) });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}

async function readPageHttp(token, pageId) {
  const r = await fetch(`${API}/api/documents/${DOC}/pages/${pageId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return r.json();
}

// ------------------------------------------------------------------ helpers (в браузере)

async function openStand(base, params) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // ожидаемая ошибка: клиент Zero логирует app error мутатора (проверка revision_mismatch ниже)
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource') && !/app error on server .*revision_mismatch/.test(m.text())) {
      errors.push(`console: ${m.text().slice(0, 300)}`);
    }
  });
  const qs = new URLSearchParams({ adapter: 'Z', doc: DOC, autologin: 'alice', pass: PASSWORDS.alice, ...params });
  const t0 = Date.now();
  await page.goto(`${base}/?${qs.toString()}`);
  await page.waitForFunction(
    () => window.__stand && window.__stand.events.some((e) => e.type === 'page-ready' || (e.type === 'error' && e.detail?.scope === 'open')),
    null,
    { timeout: 30000 },
  );
  return { context, page, errors, openedAt: t0 };
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);

async function selectPage(page, pageId) {
  return ev(
    page,
    async (id) => {
      const s = window.__stand;
      const t = performance.now();
      s.selectPage(id);
      const e = await s.waitFor('page-ready', (x) => x.detail.pageId === id, 20000);
      return { ms: e.t - t, detail: e.detail, state: s.state, retainedAtReady: s.getRetained() };
    },
    pageId,
  );
}

const retained = (page) => ev(page, () => window.__stand.getRetained());
const retainedAsync = (page) => ev(page, () => window.__standController.adapter.getRetainedAsync());
const loaded = (page) => ev(page, () => window.__stand.getLoadedPages());
const snapshot = (page, id) => ev(page, (p) => window.__stand.getPageSnapshot(p), id);
/** полный снимок адаптера (с sourceId/isSource) */
const fullSnapshot = (page, id) => ev(page, (p) => window.__standController.adapter.getPageSnapshot(p), id);
const stateOf = (page) => ev(page, () => window.__stand.state);

async function runCommand(page, cmd) {
  return ev(
    page,
    async (c) => {
      const s = window.__stand;
      const t = performance.now();
      const result = await s.runCommand(c);
      const acked = await s.waitFor('command-acked', (e) => e.detail.opId === result.opId, 20000);
      const drawn = await s.waitFor('command-drawn', (e) => e.detail.opId === result.opId, 20000);
      const timing = window.__standController.adapter.commandTimings.find((x) => x.opId === result.opId);
      return {
        result,
        acked,
        drawn,
        pending: s.pendingCommands,
        state: s.state,
        sentAt: t,
        zero: timing
          ? {
              clientMs: timing.clientAt ? timing.clientAt - timing.sentAt : null,
              serverMs: timing.serverAt ? timing.serverAt - timing.sentAt : null,
              ackedMs: timing.ackedAt ? timing.ackedAt - timing.sentAt : null,
              syncedMs: timing.syncedAt ? timing.syncedAt - timing.sentAt : null,
            }
          : null,
      };
    },
    cmd,
  );
}

function checkSourceFillOnPage(snap, before) {
  // экземпляры S1 на странице: непереопределённые — новый цвет, переопределённые — прежний
  const inst = snap.shapes.filter((s) => s.sourceId === SRC);
  assert.ok(inst.length > 0, 'на странице есть экземпляры источника');
  for (const s of inst) {
    const prev = before.get(s.id);
    if (s.fillOverridden) assert.notEqual(s.fill, NEW_FILL, `переопределённый ${s.id} не должен меняться`);
    else assert.equal(s.fill, NEW_FILL, `непереопределённый ${s.id} должен получить новый цвет (было ${prev})`);
  }
  for (const s of snap.shapes) {
    if (s.sourceId !== SRC && s.id !== SRC && before.has(s.id)) assert.equal(s.fill, before.get(s.id), `посторонняя фигура ${s.id} не меняется`);
  }
}

async function compareWithDb(token, page, pageId) {
  const db = await readPageHttp(token, pageId);
  const snap = await snapshot(page, pageId);
  assert.ok(snap, `снимок ${pageId} есть`);
  assert.equal(snap.revision, db.revision, 'ревизия снимка = ревизия БД');
  assert.equal(snap.shapes.length, db.shapes.length);
  const byId = new Map(snap.shapes.map((s) => [s.id, s]));
  for (const s of db.shapes) {
    const c = byId.get(s.id);
    assert.ok(c, `фигура ${s.id} есть в снимке`);
    assert.equal(c.fill, s.fill, `fill ${s.id}`);
    assert.equal(c.fillOverridden, s.fillOverridden, `fillOverridden ${s.id}`);
  }
}

// ------------------------------------------------------------------ сценарий

function scenario(base, mode, cache, { viaShaper = false } = {}) {
  const label = `Z/${mode}${mode === 'P' ? `/cache=${cache}` : ''}${viaShaper ? ' через шейпер' : ' напрямую'}`;
  it(label, async () => {
    await resetDoc();
    const token = await login();
    if (viaShaper) await fetch(`${SHAPER_STATS}/reset`, { method: 'POST' }).catch(() => undefined);
    const params = { mode, cache: String(cache) };
    // прямой режим: WebSocket через прокси /zero API (по умолчанию) либо сразу на zero-cache (?zero=)
    if (!viaShaper && process.env.STAND_Z_CACHE_DIRECT === '1') params.zero = CACHE;
    const { context, page, errors } = await openStand(base, params);
    try {
      const openErr = await ev(page, () => window.__stand.events.find((e) => e.type === 'error'));
      assert.equal(openErr, undefined, `ошибок при открытии нет: ${JSON.stringify(openErr)}`);
      const first = await ev(page, () => {
        const e = window.__stand.events.find((x) => x.type === 'page-ready');
        return { t: e.t, detail: e.detail, state: window.__stand.state };
      });
      assert.equal(first.detail.pageId, pid(1));
      assert.equal(first.detail.shapeCount, SHAPES, 'страница 1 — полный набор фигур');
      assert.equal(first.detail.revision, 0);
      assert.equal(first.state, 'ready');
      const timings = { firstReadyMs: first.t, nav: {} };

      if (mode === 'F') {
        await page.waitForFunction((n) => window.__stand.getLoadedPages().length === n, PAGES, { timeout: 90000 });
        const r = await retainedAsync(page);
        assert.equal(r.pages, PAGES, 'F: все страницы удерживаются');
        assert.equal(r.shapes, PAGES * SHAPES, 'F: все фигуры в хранилище Zero');
      }

      // переходы 2, 3, 1
      for (const i of [2, 3, 1]) {
        const r = await selectPage(page, pid(i));
        assert.equal(r.detail.shapeCount, SHAPES, `страница ${i}: полный набор`);
        assert.equal(r.state, 'ready');
        timings.nav[i] = Math.round(r.ms);
        if (mode === 'P') {
          const rr = await retainedAsync(page);
          assert.ok(rr.pages <= cache + 1, `P: retained.pages=${rr.pages} ≤ cache+1=${cache + 1}`);
          assert.ok(rr.shapes <= (cache + 1) * SHAPES, `P: retained.shapes=${rr.shapes}`);
          assert.equal((await loaded(page)).length, rr.pages, 'loadedPages согласуется с retained');
        }
      }
      if (mode === 'P') {
        // после 3 переходов при cache=1 в окне ровно 2 страницы (активная + 1)
        const rr = await retainedAsync(page);
        assert.equal(rr.pages, Math.min(cache + 1, 3), 'окно заполнено');
      }

      // локальная заливка непереопределённого экземпляра S1 на странице 2; вытеснение из окна не отменяет её
      await selectPage(page, pid(2));
      const p2 = await fullSnapshot(page, pid(2));
      const inst = p2.shapes.find((s) => s.sourceId === SRC && !s.fillOverridden);
      assert.ok(inst, 'на странице 2 есть непереопределённый экземпляр S1');
      const local = await runCommand(page, { type: 'setLocalFill', targetId: inst.id, fill: LOCAL_FILL });
      assert.equal(local.result.revision, 1);
      assert.deepEqual(local.result.affectedPages, [pid(2)]);
      assert.equal(local.result.affectedShapes, 1);
      assert.deepEqual([...local.acked.detail.affectedPages], [pid(2)]);
      assert.equal(local.drawn.detail.pageId, pid(2));
      assert.ok(local.drawn.detail.drawnRevision >= 1);
      assert.equal(local.pending, 0);
      assert.equal(local.state, 'ready');
      timings.localFill = { ackMs: Math.round(local.acked.t - local.sentAt), drawnMs: Math.round(local.drawn.t - local.sentAt), zero: local.zero };
      const p2after = await fullSnapshot(page, pid(2));
      const changed = p2after.shapes.find((s) => s.id === inst.id);
      assert.equal(changed.fill, LOCAL_FILL);
      assert.equal(changed.fillOverridden, true);
      // уходим за пределы окна (cache+1 других страниц) и возвращаемся
      for (let k = 0; k <= cache; k += 1) await selectPage(page, pid(3 + k));
      if (mode === 'P') {
        assert.ok(!(await loaded(page)).includes(pid(2)), 'P: страница 2 вытеснена из окна');
        const rr = await retainedAsync(page);
        assert.equal(rr.pages, cache + 1, 'P: окно = активная + cache');
        assert.equal(rr.shapes, (cache + 1) * SHAPES, 'P: строки вытесненных страниц ушли из хранилища');
      }
      await selectPage(page, pid(2));
      const p2back = await fullSnapshot(page, pid(2)).then((s) => s.shapes.find((x) => x.id === inst.id));
      assert.equal(p2back.fill, LOCAL_FILL, 'локальная заливка пережила вытеснение');
      assert.equal(p2back.fillOverridden, true);

      // общая заливка источника с активной страницы 1 (не затронута) — команда завершена по ревизии
      await selectPage(page, pid(1));
      const before = new Map();
      for (const i of [1, 2, 50]) {
        const s = await fullSnapshot(page, pid(i));
        if (s) for (const sh of s.shapes) before.set(sh.id, sh.fill);
      }
      const p1Before = await fullSnapshot(page, pid(1));
      const cmd = await runCommand(page, { type: 'setSourceFill', targetId: SRC, fill: NEW_FILL });
      assert.equal(cmd.result.revision, 2);
      assert.ok(cmd.result.affectedPages.length >= 2, 'затронуто несколько страниц');
      assert.ok(cmd.result.affectedShapes > 1);
      assert.equal(cmd.acked.detail.revision, 2);
      assert.deepEqual([...cmd.acked.detail.affectedPages].sort(), [...cmd.result.affectedPages].sort());
      assert.equal(cmd.acked.detail.affectedShapes, cmd.result.affectedShapes);
      assert.equal(cmd.drawn.detail.pageId, pid(1), 'command-drawn для активной страницы');
      assert.ok(cmd.drawn.detail.drawnRevision >= 2);
      // §1.8: drawn фиксируется по ФАКТИЧЕСКОЙ отрисовке и не ждёт подтверждения. У Z ack требует
      // отдельного GET /api/operations/:opId, поэтому drawn может быть и раньше acked — это
      // законный результат, а не ошибка (порядок зависит от RTT: напрямую ack обгоняет отрисовку,
      // через шейпер отрисовка обгоняет ack). Проверяем только, что drawn не раньше синхронизации.
      assert.ok(cmd.zero && cmd.zero.syncedMs !== null, 'момент синхронизации записан');
      assert.ok(cmd.drawn.t - cmd.sentAt >= cmd.zero.syncedMs - 1, 'drawn не раньше прихода серверных данных');
      assert.equal(cmd.pending, 0);
      assert.equal(cmd.state, 'ready');
      assert.ok(cmd.zero && cmd.zero.serverMs !== null && cmd.zero.serverMs <= cmd.zero.ackedMs + 1, 'ack после .server');
      timings.sourceFill = { ackMs: Math.round(cmd.acked.t - cmd.sentAt), drawnMs: Math.round(cmd.drawn.t - cmd.sentAt), zero: cmd.zero };
      // активная страница 1: если S1 там не представлен — снимок «поднят» до новой ревизии без изменений
      const p1After = await fullSnapshot(page, pid(1));
      assert.equal(p1After.revision, 2);
      if (!p1Before.shapes.some((s) => s.sourceId === SRC)) {
        assert.deepEqual(p1After.shapes.map((s) => s.fill), p1Before.shapes.map((s) => s.fill), 'незатронутая страница не изменилась');
      }

      // поздний переход на страницу 50: непереопределённые экземпляры — новый цвет, переопределённые — нет; = БД
      const r50 = await selectPage(page, pid(50));
      timings.nav[50] = Math.round(r50.ms);
      const p50 = await fullSnapshot(page, pid(50));
      assert.equal(p50.revision, 2);
      checkSourceFillOnPage(p50, before);
      assert.ok(p50.shapes.some((s) => s.sourceId === SRC && s.fillOverridden), 'на странице 50 есть переопределённые экземпляры');
      await compareWithDb(token, page, pid(50));
      // страница 2: локально залитый экземпляр не перекрашен общей заливкой
      await selectPage(page, pid(2));
      const p2final = await fullSnapshot(page, pid(2));
      const kept = p2final.shapes.find((s) => s.id === inst.id);
      assert.equal(kept.fill, LOCAL_FILL, 'общая заливка не снимает локальное переопределение');
      checkSourceFillOnPage(p2final, before);
      await compareWithDb(token, page, pid(2));

      // revision_mismatch: мутатор с устаревшей ревизией → та же ошибка, что у HTTP (код + currentRevision)
      const mismatch = await ev(page, async ({ src }) => {
        const a = window.__standController.adapter;
        try {
          await a.runCommand({ opId: crypto.randomUUID(), type: 'setSourceFill', targetId: src, fill: '#123456', expectedRevision: 0 });
          return { ok: true };
        } catch (e) {
          return { ok: false, name: e.name, code: e.code, status: e.status, currentRevision: e.currentRevision };
        }
      }, { src: SRC });
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.code, 'revision_mismatch');
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.currentRevision, 2);
      // повтор через контроллер с той же логикой, что у H/Q (refreshMeta + один повтор с тем же opId) проходит
      const retry = await ev(page, async ({ src }) => {
        const s = window.__stand;
        // сбиваем известную ревизию, чтобы первый POST дал revision_mismatch
        window.__standController.adapter.doc.noteRevision(0);
        window.__standController.adapter.doc.revisionValue = 0;
        const opId = crypto.randomUUID();
        const r = await s.runCommand({ opId, type: 'setSourceFill', targetId: src, fill: '#00aa78' });
        const retries = s.events.filter((e) => e.type === 'command-retry' && e.detail.opId === opId).map((e) => e.detail.via);
        const sent = s.events.filter((e) => e.type === 'command-sent' && e.detail.opId === opId).map((e) => e.detail.expectedRevision);
        return { revision: r.revision, retries, sent };
      }, { src: SRC });
      assert.equal(retry.revision, 3);
      assert.deepEqual(retry.retries, ['revision_mismatch']);
      assert.deepEqual(retry.sent, [0, 2]);

      // удержание в F — по-прежнему все страницы; в P — окно
      const rFinal = await retainedAsync(page);
      if (mode === 'F') assert.equal(rFinal.pages, PAGES);
      else assert.ok(rFinal.pages <= cache + 1);
      const est = await ev(page, async () => (await navigator.storage.estimate()).usage);
      timings.retained = rFinal;
      timings.storageBytes = est;

      // logout: хранилище адаптера пусто, IndexedDB/localStorage/sessionStorage очищены
      await ev(page, () => window.__stand.logout());
      const after = await ev(page, async () => ({
        retained: window.__stand.getRetained(),
        idb: (await indexedDB.databases()).map((d) => d.name),
        ls: localStorage.length,
        ss: sessionStorage.length,
        state: window.__stand.state,
        login: !!document.querySelector('form'),
      }));
      assert.deepEqual(after.retained, { pages: 0, shapes: 0, bytesEstimate: 0 });
      assert.deepEqual(after.idb, []);
      assert.equal(after.ls, 0);
      assert.equal(after.ss, 0);
      assert.equal(after.state, 'idle');

      if (viaShaper) {
        const stats = await (await fetch(`${SHAPER_STATS}/stats`)).json();
        assert.ok(stats.byRoute?.['/zero']?.upgrades >= 1, 'WebSocket zero-cache прошёл через шейпер (/zero upgrade)');
        assert.ok(stats.byRoute['/zero'].bytesOut > 100_000, 'данные страниц пришли через шейпер');
        timings.shaper = { zero: stats.byRoute['/zero'], api: stats.byRoute['/api'] };
      }
      assert.deepEqual(errors, [], 'нет ошибок в консоли/страницы');
      console.log(`  ${label}: ${JSON.stringify(timings)}`);
    } finally {
      await context.close();
    }
  });
}

describeZ('адаптер Z (zero-cache + API с тестовыми хуками)', () => {
  before(async () => {
    const h = await fetch(`${API}/api/health`).then((r) => r.json());
    assert.equal(h.testHooks, true, `API ${API} должен быть запущен со STAND_TEST_HOOKS=1`);
    const z = await fetch(`${CACHE}/`).then((r) => r.text());
    assert.equal(z.trim(), 'OK', `zero-cache ${CACHE} не готов`);
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    await resetDoc();
  });

  scenario(API, 'P', 1);
  scenario(API, 'P', 3);
  scenario(API, 'F', 1);

  it('чужой документ: bob не получает данных alice (open → 403, synced query → forbidden)', async () => {
    const { context, page } = await openStand(API, { mode: 'P', cache: '1', autologin: 'bob', pass: PASSWORDS.bob });
    try {
      const err = await ev(page, () => window.__stand.events.find((e) => e.type === 'error' && e.detail.scope === 'open'));
      assert.ok(err, 'ошибка открытия чужого документа');
      assert.match(String(err.detail.message), /403|another user|forbidden/i);
      assert.equal(await stateOf(page), 'error');
    } finally {
      await context.close();
    }
  });

  if (SHAPER) {
    describe('через netshaper', () => {
      before(async () => {
        const h = await fetch(`${SHAPER_STATS}/health`).then((r) => r.ok).catch(() => false);
        assert.ok(h, `шейпер ${SHAPER} (stats ${SHAPER_STATS}) не запущен`);
      });
      scenario(SHAPER, 'P', 1, { viaShaper: true });
      scenario(SHAPER, 'F', 1, { viaShaper: true });
    });
  }
});
