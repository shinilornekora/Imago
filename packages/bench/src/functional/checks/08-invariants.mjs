// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Инварианты режимов (SPEC §4.1, §4.2).
 * И1 (F): после открытия все страницы загружены — `getLoadedPages().length == N`, `getRetained()` = все страницы/фигуры,
 *     каждая страница прочитана ровно один раз (журнал запросов), параллелизм чтений ≤ 4, каждый снимок содержит
 *     ровно ожидаемые id фигур.
 * И2 (P): маршрут переходов; после каждого — `getRetained().pages ≤ cache+1`, `getLoadedPages()` ⊆ окно
 *     (активная + `cache` последних посещённых), `retained.shapes == Σ фигур удерживаемых страниц`; вытесненные страницы
 *     действительно перечитываются: число чтений каждой страницы по журналу `/api` равно предсказанию LRU-модели.
 */
import assert from 'node:assert/strict';
import { loadedPages, maxConcurrent, retainedSettled, selectPage, snapshot, standInfo, waitInPage } from '../lib/stand.mjs';

export const fullLoad = {
  id: 'I1-full-load',
  title: () => 'И1. Инвариант F: полная загрузка всех страниц',
  applies: (cfg) => cfg.mode === 'F',
  naReason: (cfg) => `инвариант режима F; конфигурация в режиме ${cfg.mode} (окно кеша ${cfg.cache}) проверяется инвариантом И2`,
  async run(ctx) {
    const { doc } = ctx;
    const N = doc.pages.length;
    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await waitInPage(page, (n) => /** @type {any} */ (window).__stand.getLoadedPages().length === n, N, 20_000);
    const totalShapes = doc.pages.reduce((a, p) => a + doc.countOf(p.id), 0);
    // Z: getRetained() — кеш, пересчитываемый после затишья (debounce 300 мс) — даём устаканиться
    const r = await retainedSettled(page, (x) => x.pages === N && x.shapes === totalShapes);
    const info = await standInfo(page);
    assert.equal(info.loaded.length, N, `getLoadedPages().length == ${N}`);
    assert.deepEqual([...info.loaded].sort(), doc.pages.map((p) => p.id).sort());
    assert.equal(r.pages, N, 'retained.pages == число страниц');
    assert.equal(r.shapes, totalShapes, 'retained.shapes == всего фигур документа');
    for (const p of doc.pages) {
      const sn = await snapshot(page, p.id);
      assert.ok(sn, `снимок ${p.id}`);
      assert.deepEqual(sn.shapes.map((x) => x.id).sort(), doc.idsOf(p.id), `множество id ${p.id}`);
    }
    const reads = s.pageReads(doc.docId);
    if (ctx.cfg.adapter !== 'Z') {
      const perPage = Object.fromEntries(doc.pages.map((p) => [p.id, s.pageReads(doc.docId, p.id).length]));
      const wrong = Object.entries(perPage).filter(([, n]) => n !== 1);
      assert.deepEqual(wrong, [], `каждая страница читается ровно один раз: ${JSON.stringify(wrong)}`);
      const conc = maxConcurrent(reads);
      assert.ok(conc <= 4, `параллелизм чтений ${conc} > 4`);
      assert.ok(conc >= 2, `ожидалась параллельная загрузка (max одновременных = ${conc})`);
      return { summary: `все ${N} страниц загружены (${totalShapes} фигур), ${reads.length} чтений (по одному на страницу), параллелизм ≤ 4 (max ${conc})`, maxConcurrent: conc };
    }
    return { summary: `Z: все ${N} страниц материализованы (${totalShapes} фигур), retained=${info.retained.pages}/${info.retained.shapes}` };
  },
};

export const window_ = {
  id: 'I2-window',
  title: (cfg) => `И2. Инвариант P: окно кеша (cache=${cfg.cache}) и повторная загрузка вытесненных`,
  applies: (cfg) => cfg.mode === 'P',
  naReason: () => 'инвариант режима P (окно кеша); в режиме F вытеснения нет — проверяется инвариантом И1',
  async run(ctx) {
    const { doc, cfg } = ctx;
    const N = doc.pages.length;
    const route = [2, 3, 1, 4, 2, 5, 1, 6, 3, N].map((i) => doc.pid(Math.min(i, N)));
    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    // LRU-модель: окно = активная + cache последних посещённых неактивных
    const recent = [doc.pid(1)];
    let store = new Set([doc.pid(1)]);
    const expectedReads = Object.fromEntries(doc.pages.map((p) => [p.id, 0]));
    expectedReads[doc.pid(1)] = 1;
    const steps = [];
    for (const target of route) {
      const idx = recent.indexOf(target);
      if (idx >= 0) recent.splice(idx, 1);
      recent.push(target);
      const allowed = new Set([target]);
      for (let i = recent.length - 1; i >= 0 && allowed.size < cfg.cache + 1; i -= 1) allowed.add(recent[i]);
      store = new Set([...store].filter((p) => allowed.has(p)));
      const needsRead = !store.has(target);
      if (needsRead) expectedReads[target] += 1;
      store.add(target);

      const ev = await selectPage(page, target);
      assert.equal(ev.detail.shapeCount, doc.countOf(target));
      const loaded = await loadedPages(page);
      const expShapes = loaded.reduce((a, p) => a + doc.countOf(p), 0);
      // Z: строки вытесненной страницы покидают хранилище асинхронно (~0.1–0.25 с) — ждём устаканивания
      const r = await retainedSettled(page, (x) => x.pages <= cfg.cache + 1 && x.shapes === expShapes);
      const st = await standInfo(page);
      steps.push({ target, retained: r, loaded, needsRead, allowed: [...allowed] });
      assert.ok(r.pages <= cfg.cache + 1, `retained.pages=${r.pages} > cache+1=${cfg.cache + 1} после перехода на ${target}`);
      assert.ok(loaded.length <= cfg.cache + 1, `loaded=${loaded.length} > cache+1`);
      assert.ok(loaded.includes(target), 'активная страница удерживается');
      for (const p of loaded) assert.ok(allowed.has(p), `страница ${p} вне окна (${[...allowed].join(',')}) после перехода на ${target}`);
      assert.equal(r.shapes, expShapes, 'retained.shapes == сумма фигур удерживаемых страниц');
      assert.equal(st.state, 'ready');
      for (const p of doc.pages) {
        if (!loaded.includes(p.id)) assert.equal(await snapshot(page, p.id), null, `снимок вытесненной ${p.id} — null`);
      }
    }
    if (cfg.adapter !== 'Z') {
      const actual = Object.fromEntries(doc.pages.map((p) => [p.id, s.pageReads(doc.docId, p.id).length]));
      assert.deepEqual(actual, expectedReads, 'число чтений каждой страницы == предсказание LRU-модели (вытесненные перечитываются, удержанные — нет)');
    }
    const total = Object.values(expectedReads).reduce((a, b) => a + b, 0);
    const readsNote = cfg.adapter === 'Z' ? `Z: повторная материализация ${total - 1} вытесненных страниц (по LRU-модели; HTTP-чтений нет)` : `чтений ${total} (по LRU-модели)`;
    return {
      summary: `маршрут ${route.map((p) => doc.pageById.get(p).index).join('→')}: retained.pages ≤ ${cfg.cache + 1} на каждом шаге, окно LRU соблюдено, ${readsNote}`,
      steps,
      expectedReads,
    };
  },
};

export default [fullLoad, window_];
