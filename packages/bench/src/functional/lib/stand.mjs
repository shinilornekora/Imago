// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Помощники Playwright вокруг контракта `window.__stand` (SPEC §4.2, packages/client/README.md).
 * Приёмы — как в дымовом тесте клиента (`packages/client/test/smoke.spec.mjs`): ожидание событий через
 * `waitFor` внутри страницы, `route.fetch()` + `route.abort()` для обрыва ответа, опрос журнала.
 */
import { TEST_PASSWORDS } from '../../test-users.mjs';

/**
 * @typedef {{id:number, t:number, endT:number|null, method:string, url:string, path:string, hasAuth:boolean,
 *   status:number|null, failed:string|null}} ReqRecord
 */

/**
 * Скрипт-зонд, устанавливаемый до загрузки приложения (addInitScript): опрашивает `getPageSnapshot(pageId)`
 * каждые ~4 мс и записывает изменения размера/ревизии (и заливки одной фигуры) — чтобы поймать
 * частичный снимок до готовности или откат к старому цвету после команды.
 * @param {{pageId:string, shapeId?:string|null}|null} auto
 */
function probeInit(auto) {
  /** @type {Record<string, any>} */
  const watches = {};
  const w = /** @type {any} */ (window);
  w.__snapProbe = {
    watch(pageId, opts = {}) {
      const rec = { pageId, shapeId: opts.shapeId ?? null, records: [], timer: null, startedAt: performance.now(), ticks: 0 };
      const tick = () => {
        const s = w.__stand;
        if (!s) return;
        rec.ticks += 1;
        let snap = null;
        try {
          snap = s.getPageSnapshot(pageId);
        } catch (e) {
          rec.records.push({ t: performance.now(), error: String(e) });
          return;
        }
        const size = snap ? snap.shapes.length : null;
        const revision = snap ? snap.revision : null;
        let fill = null;
        if (snap && rec.shapeId) {
          const sh = snap.shapes.find((x) => x.id === rec.shapeId);
          fill = sh ? sh.fill : 'missing';
        }
        const last = rec.records[rec.records.length - 1];
        if (!last || last.size !== size || last.revision !== revision || last.fill !== fill) {
          rec.records.push({ t: performance.now(), size, revision, fill });
        }
      };
      tick();
      rec.timer = setInterval(tick, 2);
      watches[pageId] = rec;
      return true;
    },
    stop(pageId) {
      const rec = watches[pageId];
      if (rec && rec.timer) {
        clearInterval(rec.timer);
        rec.timer = null;
      }
      return Boolean(rec);
    },
    report(pageId) {
      const rec = watches[pageId];
      return rec ? { pageId: rec.pageId, shapeId: rec.shapeId, records: rec.records, ticks: rec.ticks, startedAt: rec.startedAt } : null;
    },
  };
  if (auto) w.__snapProbe.watch(auto.pageId, auto);
}

/**
 * Открывает стенд в новом контексте (холодный клиент) и ждёт первую готовность или ошибку открытия.
 * @param {import('playwright').Browser} browser
 * @param {{base:string, cfg:{adapter:string,mode:string,cache:number}, docId:string, user?:'alice'|'bob',
 *   probe?: {pageId:string, shapeId?:string|null}|null, waitFor?: 'ready'|'error'|'any'|'none', timeoutMs?:number,
 *   query?: Record<string,string>, beforeGoto?: (page:import('playwright').Page, context:any) => Promise<void>}} opts
 */
export async function openStand(browser, opts) {
  const context = await browser.newContext();
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  /** @type {ReqRecord[]} */
  const requests = [];
  const byReq = new WeakMap();
  let n = 0;
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = r.url();
    if (!url.includes('/api/')) return;
    const rec = {
      id: n++,
      t: Date.now(),
      endT: null,
      method: r.method(),
      url,
      path: new URL(url).pathname,
      hasAuth: Boolean(r.headers().authorization),
      status: null,
      failed: null,
    };
    requests.push(rec);
    byReq.set(r, rec);
  });
  page.on('response', (res) => {
    const rec = byReq.get(res.request());
    if (rec) rec.status = res.status();
  });
  page.on('requestfinished', (r) => {
    const rec = byReq.get(r);
    if (rec) rec.endT = Date.now();
  });
  page.on('requestfailed', (r) => {
    const rec = byReq.get(r);
    if (rec) {
      rec.endT = Date.now();
      rec.failed = r.failure()?.errorText ?? 'failed';
    }
  });
  await page.addInitScript(probeInit, opts.probe ?? null);
  // перехваты/подмены, которые обязаны быть установлены ДО навигации (см. проверку Б3: подделка ответа
  // `GET /api/documents/<чужой>` — клиент bob заставляется запросить чужие данные через synced query)
  if (opts.beforeGoto) await opts.beforeGoto(page, context);
  const qs = new URLSearchParams({
    adapter: opts.cfg.adapter,
    mode: opts.cfg.mode,
    cache: String(opts.cfg.cache),
    doc: opts.docId,
    autologin: opts.user ?? 'alice',
    // пароль тестовой учётки в production-сборке клиента отсутствует (§1.6) — передаём явно
    ...(TEST_PASSWORDS[opts.user ?? 'alice'] ? { pass: TEST_PASSWORDS[opts.user ?? 'alice'] } : {}),
    ...(opts.query ?? {}),
  });
  const openedAt = Date.now();
  await page.goto(`${opts.base}/?${qs.toString()}`);
  const mode = opts.waitFor ?? 'any';
  if (mode !== 'none') {
    await page.waitForFunction(
      (m) => {
        const s = /** @type {any} */ (window).__stand;
        if (!s) return false;
        const ready = s.events.some((e) => e.type === 'page-ready');
        const err = s.events.some((e) => e.type === 'error' && (e.detail?.scope === 'open' || e.detail?.scope === 'login'));
        if (m === 'ready') return ready;
        if (m === 'error') return err;
        return ready || err;
      },
      mode,
      { timeout: opts.timeoutMs ?? 30_000 },
    );
  }
  return {
    context,
    page,
    errors,
    requests,
    openedAt,
    /** @param {string} docId @param {string} [pageId] */
    pageReads(docId, pageId) {
      const prefix = `/api/documents/${encodeURIComponent(docId)}/pages/`;
      return requests.filter((r) => r.method === 'GET' && r.path.startsWith(prefix) && (!pageId || r.path === prefix + encodeURIComponent(pageId)));
    },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}

/** Максимальное число одновременных запросов по записям журнала. */
export function maxConcurrent(records) {
  /** @type {Array<[number, number]>} */
  const ev = [];
  for (const r of records) {
    ev.push([r.t, 1]);
    ev.push([r.endT ?? Number.MAX_SAFE_INTEGER, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

// ------------------------------------------------------------------ обращения к window.__stand

/** @param {import('playwright').Page} page */
export const standInfo = (page) =>
  page.evaluate(() => {
    const s = /** @type {any} */ (window).__stand;
    return {
      state: s.state,
      activePageId: s.activePageId,
      activeRevision: s.activeRevision,
      drawn: s.drawn,
      pendingCommands: s.pendingCommands,
      config: s.config,
      retained: s.getRetained(),
      loaded: s.getLoadedPages(),
    };
  });

/** @param {import('playwright').Page} page @param {string} type */
export const eventsOf = (page, type) =>
  page.evaluate((t) => /** @type {any} */ (window).__stand.events.filter((e) => e.type === t), type);

/** @param {import('playwright').Page} page */
export const allEvents = (page) => page.evaluate(() => /** @type {any} */ (window).__stand.events);

/** @param {import('playwright').Page} page @param {string} pageId */
export const snapshot = (page, pageId) => page.evaluate((p) => /** @type {any} */ (window).__stand.getPageSnapshot(p), pageId);

/** @param {import('playwright').Page} page */
export const retained = (page) => page.evaluate(() => /** @type {any} */ (window).__stand.getRetained());

/** @param {import('playwright').Page} page */
export const loadedPages = (page) => page.evaluate(() => /** @type {any} */ (window).__stand.getLoadedPages());

/** @param {import('playwright').Page} page */
export const stateOf = (page) => page.evaluate(() => /** @type {any} */ (window).__stand.state);

/** @param {import('playwright').Page} page */
export const nowInPage = (page) => page.evaluate(() => performance.now());

/**
 * Переход через API `selectPage` + ожидание `page-ready` этой страницы (событие).
 * @param {import('playwright').Page} page @param {string} pageId @param {number} [timeoutMs]
 */
export function selectPage(page, pageId, timeoutMs = 20_000) {
  return page.evaluate(
    ({ id, timeout }) => {
      const s = /** @type {any} */ (window).__stand;
      s.selectPage(id);
      return s.waitFor('page-ready', (e) => e.detail.pageId === id, timeout);
    },
    { id: pageId, timeout: timeoutMs },
  );
}

/**
 * Переход кликом по кнопке списка страниц + ожидание `page-ready`.
 * @param {import('playwright').Page} page @param {string} pageId @param {number} [timeoutMs]
 */
export async function clickPage(page, pageId, timeoutMs = 20_000) {
  await page.click(`button[data-page-id="${pageId}"]`);
  return page.evaluate(
    ({ id, timeout }) => /** @type {any} */ (window).__stand.waitFor('page-ready', (e) => e.detail.pageId === id, timeout),
    { id: pageId, timeout: timeoutMs },
  );
}

/**
 * Команда через `runCommand` с ожиданием `command-acked` и `command-drawn`.
 * ПОРЯДОК этих двух событий НЕ фиксирован: `command-drawn` — момент фактической отрисовки холста (§1.8),
 * у Z он законно наступает раньше подтверждения (ack требует отдельного чтения журнала операций).
 * `waitFor` учитывает уже случившиеся события, поэтому ожидание по очереди корректно при любом порядке.
 * Дополнительно возвращаются (если клиент их публикует) `server` и `synced` — промежуточные моменты Z.
 * @param {import('playwright').Page} page
 * @param {{type:'setSourceFill'|'setLocalFill', targetId:string, fill:string, opId?:string}} cmd
 * @param {number} [timeoutMs]
 */
export function runCommand(page, cmd, timeoutMs = 20_000) {
  return page.evaluate(
    async ({ c, timeout }) => {
      const s = /** @type {any} */ (window).__stand;
      const t0 = performance.now();
      const result = await s.runCommand(c);
      const acked = await s.waitFor('command-acked', (e) => e.detail.opId === result.opId, timeout);
      const drawn = await s.waitFor('command-drawn', (e) => e.detail.opId === result.opId, timeout);
      const sent = s.events.filter((e) => e.type === 'command-sent' && e.detail.opId === result.opId);
      const server = s.events.find((e) => e.type === 'command-server' && e.detail.opId === result.opId) ?? null;
      const synced = s.events.find((e) => e.type === 'command-synced' && e.detail.opId === result.opId) ?? null;
      return { result, acked, drawn, sent, server, synced, t0, pending: s.pendingCommands, state: s.state, drawnInfo: s.drawn };
    },
    { c: cmd, timeout: timeoutMs },
  );
}

/**
 * Команда, которая должна отклониться; возвращает текст ошибки.
 * @param {import('playwright').Page} page
 */
export function runCommandExpectError(page, cmd) {
  return page.evaluate(async (c) => {
    const s = /** @type {any} */ (window).__stand;
    try {
      const r = await s.runCommand(c);
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : null };
    }
  }, cmd);
}

/** Зонд снимков: старт наблюдения, остановка, отчёт. */
export const probe = {
  /** @param {import('playwright').Page} page @param {string} pageId @param {{shapeId?:string}} [opts] */
  watch: (page, pageId, opts = {}) => page.evaluate(({ p, o }) => /** @type {any} */ (window).__snapProbe.watch(p, o), { p: pageId, o: opts }),
  /** @param {import('playwright').Page} page @param {string} pageId */
  stop: (page, pageId) => page.evaluate((p) => /** @type {any} */ (window).__snapProbe.stop(p), pageId),
  /** @param {import('playwright').Page} page @param {string} pageId */
  report: (page, pageId) => page.evaluate((p) => /** @type {any} */ (window).__snapProbe.report(p), pageId),
};

/**
 * Число различных цветов на холсте (грубая проверка «холст действительно нарисован»).
 * @param {import('playwright').Page} page
 */
export function canvasColors(page) {
  return page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement|null} */ (document.querySelector('canvas[data-testid="stage"]'));
    if (!c) return { found: false, colors: 0, width: 0, height: 0 };
    const ctx = c.getContext('2d');
    if (!ctx) return { found: true, colors: 0, width: c.width, height: c.height };
    const step = 4;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let y = 0; y < c.height; y += step) {
      for (let x = 0; x < c.width; x += step) {
        const i = (y * c.width + x) * 4;
        set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (set.size > 64) return { found: true, colors: set.size, width: c.width, height: c.height };
      }
    }
    return { found: true, colors: set.size, width: c.width, height: c.height };
  });
}

/** Состояние storage после logout. */
export function storageState(page) {
  return page.evaluate(async () => {
    let dbs = [];
    try {
      dbs = (await indexedDB.databases()).map((d) => d.name);
    } catch (e) {
      dbs = [`error: ${String(e)}`];
    }
    return { localStorage: localStorage.length, sessionStorage: sessionStorage.length, indexedDb: dbs };
  });
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `getRetained()` с ожиданием «устаканивания»: у H/Q значение синхронное (возвращается сразу), у Z — кеш,
 * пересчитываемый асинхронно (P: сразу + повторы 150/450 мс после вытеснения; F: debounce 300 мс), поэтому
 * опрашиваем до выполнения предиката, не дольше timeoutMs; возвращаем последнее значение (проверяет вызывающий).
 * @param {import('playwright').Page} page
 * @param {(r:{pages:number,shapes:number,bytesEstimate?:number}) => boolean} pred
 * @param {number} [timeoutMs]
 */
export async function retainedSettled(page, pred, timeoutMs = 2500) {
  const t0 = Date.now();
  let r = await retained(page);
  while (!pred(r) && Date.now() - t0 < timeoutMs) {
    await sleep(50);
    r = await retained(page);
  }
  return r;
}

/**
 * Ждёт выполнения предиката в странице (опрос), иначе бросает.
 * @param {import('playwright').Page} page
 * @param {(arg:any)=>boolean} fn функция, выполняемая в странице
 * @param {any} arg
 * @param {number} timeoutMs
 */
export async function waitInPage(page, fn, arg, timeoutMs) {
  await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 25 });
}
