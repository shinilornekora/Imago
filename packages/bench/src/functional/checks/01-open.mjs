// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 1. Открытие страницы (таблица 1, строка 1; SPEC §4.2).
 * После `page-ready` страницы k: `getPageSnapshot(k)` содержит ровно ожидаемые id фигур (из data/<doc>.json),
 * заливки равны исходным, холст отрисован (`drawn.pageId == k`, `drawn.shapeCount == N`, на холсте > 1 цвета);
 * зонд опрашивает `getPageSnapshot` каждые ~4 мс с момента загрузки скрипта: ни один снимок с числом фигур < N
 * не должен быть виден (частичный набор готовностью не считается). В P дополнительно: чтение второй страницы
 * задерживается тестовым хуком — во время загрузки снимок равен null, состояние `loading`, готовность наступает
 * только после прихода полного набора.
 */
import assert from 'node:assert/strict';
import { canvasColors, eventsOf, probe, selectPage, snapshot, standInfo, loadedPages } from '../lib/stand.mjs';

export default {
  id: '1-open',
  title: () => '1. Открытие страницы',
  async run(ctx) {
    const { doc, cfg, api } = ctx;
    const p1 = doc.pid(1);
    const expected1 = doc.idsOf(p1);
    const n1 = expected1.length;
    const alice = await api.login('alice');
    const meta = await api.getDocument(alice.token, doc.docId);
    assert.equal(meta.status, 200);
    const docRev = meta.body.revision;

    const s = await ctx.open({ probe: { pageId: p1 }, waitFor: 'ready' });
    const { page } = s;
    const readyEvents = await eventsOf(page, 'page-ready');
    assert.equal(readyEvents.length, 1, 'ровно одно page-ready после открытия');
    const ready = readyEvents[0];
    assert.equal(ready.detail.pageId, p1, 'page-ready для первой страницы (наименьший index)');
    assert.equal(ready.detail.shapeCount, n1, `page-ready.shapeCount == ${n1}`);
    assert.equal(ready.detail.revision, docRev, `page-ready.revision == ревизии документа ${docRev}`);

    const info = await standInfo(page);
    ctx.partial.info = info;
    assert.equal(info.state, 'ready');
    assert.equal(info.activePageId, p1);
    assert.equal(info.config.adapter, cfg.adapter);
    assert.equal(info.config.mode, cfg.mode);
    assert.ok(info.drawn, 'drawn заполнен');
    assert.equal(info.drawn.pageId, p1, 'drawn.pageId == активной странице');
    assert.equal(info.drawn.shapeCount, n1, 'drawn.shapeCount == числу фигур страницы');
    assert.equal(info.drawn.revision, ready.detail.revision);
    assert.equal(await page.getAttribute('[data-testid="state"]', 'data-state'), 'ready');

    const snap1 = await snapshot(page, p1);
    assert.ok(snap1, 'снимок первой страницы доступен');
    assert.deepEqual(snap1.shapes.map((x) => x.id).sort(), expected1, 'множество id фигур страницы 1 совпадает с документом');
    assert.equal(snap1.revision, docRev);
    for (const sh of snap1.shapes) {
      const orig = doc.shapeById.get(sh.id);
      assert.equal(sh.fill, orig.fill, `исходная заливка ${sh.id}`);
      assert.equal(sh.fillOverridden, orig.fillOverridden, `исходное переопределение ${sh.id}`);
    }
    const colors = await canvasColors(page);
    assert.ok(colors.found, 'canvas[data-testid=stage] найден');
    assert.ok(colors.colors > 1, `на холсте больше одного цвета (найдено ${colors.colors})`);

    await probe.stop(page, p1);
    const rep1 = await probe.report(page, p1);
    ctx.partial.probe1 = { ticks: rep1.ticks, records: rep1.records };
    const partial1 = rep1.records.filter((r) => r.size !== null && r.size !== undefined && r.size !== n1);
    assert.equal(partial1.length, 0, `зонд видел частичные снимки страницы 1: ${JSON.stringify(partial1.slice(0, 5))}`);
    const beforeReady = rep1.records.filter((r) => r.size !== null && r.t < ready.t);
    for (const r of beforeReady) assert.equal(r.size, n1, 'снимок до page-ready возможен только полный');

    // вторая страница: в P — с задержкой чтения (снимок null до полного набора), в F — уже загружена/загружается
    const p2 = doc.pid(2);
    const expected2 = doc.idsOf(p2);
    const n2 = expected2.length;
    await probe.watch(page, p2);
    const delayMs = 700;
    // H/Q читают страницу по HTTP — задерживается ответ чтения; Z читает по WebSocket, но РЕГИСТРАЦИЯ
    // synced query идёт через POST /api/zero/query (ZERO_QUERY_URL) — задерживается она (тот же механизм,
    // что в проверке 5), поэтому «снимок null и state=loading во время загрузки» проверяется с измеримой
    // задержкой у всех трёх адаптеров, а не только у H/Q
    const useDelay = cfg.mode === 'P';
    const zeroApi = ctx.zeroApi ?? api;
    if (useDelay && cfg.adapter !== 'Z') await api.delay({ pathPattern: `pages/${p2}$`, ms: delayMs, count: 1 });
    if (useDelay && cfg.adapter === 'Z') await zeroApi.delay({ pathPattern: '/api/zero/query', method: 'POST', ms: delayMs, durationMs: delayMs + 400 });
    const t0 = Date.now();
    const immediate = await page.evaluate((id) => {
      const st = /** @type {any} */ (window).__stand;
      st.selectPage(id);
      return { state: st.state, snap: st.getPageSnapshot(id), loaded: st.getLoadedPages() };
    }, p2);
    const ev2 = await page.evaluate(
      (id) => /** @type {any} */ (window).__stand.waitFor('page-ready', (e) => e.detail.pageId === id, 20000),
      p2,
    );
    const dt = Date.now() - t0;
    await probe.stop(page, p2);
    const rep2 = await probe.report(page, p2);
    ctx.partial.probe2 = { ticks: rep2.ticks, records: rep2.records, immediate, dt };
    assert.equal(ev2.detail.pageId, p2);
    assert.equal(ev2.detail.shapeCount, n2);
    const snap2 = await snapshot(page, p2);
    assert.deepEqual(snap2.shapes.map((x) => x.id).sort(), expected2, 'множество id фигур страницы 2 совпадает');
    const info2 = await standInfo(page);
    assert.equal(info2.drawn.pageId, p2);
    assert.equal(info2.drawn.shapeCount, n2);
    assert.equal(info2.state, 'ready');
    const partial2 = rep2.records.filter((r) => r.size !== null && r.size !== undefined && r.size !== n2);
    assert.equal(partial2.length, 0, `зонд видел частичные снимки страницы 2: ${JSON.stringify(partial2.slice(0, 5))}`);
    let delayNote = '';
    if (cfg.mode === 'P') {
      assert.equal(immediate.snap, null, 'P: сразу после selectPage снимок незагруженной страницы — null');
      assert.equal(immediate.state, 'loading', 'P: состояние loading во время чтения');
      const nullTicks = rep2.records.filter((r) => r.size === null).length;
      assert.ok(nullTicks >= 1, 'во время загрузки снимок был null');
      if (useDelay && cfg.adapter !== 'Z') {
        assert.ok(dt >= delayMs - 50, `P: задержанное чтение действительно задержано (готовность через ${dt} мс)`);
        const rules = await api.delayRules();
        assert.equal(rules.length, 0, 'правило задержки израсходовано (чтение прошло через хук)');
        delayNote = `; P: снимок null во время задержанного чтения (${dt} мс), state=loading`;
      } else if (useDelay) {
        const hits = (await zeroApi.delayRules()).reduce((a, r) => a + (r.hits ?? 0), 0);
        await zeroApi.clearDelays().catch(() => undefined);
        assert.ok(dt >= delayMs - 50, `P (Z): регистрация synced query страницы задержана (готовность через ${dt} мс при задержке ${delayMs} мс)`);
        assert.ok(hits >= 1, `правило задержки POST /api/zero/query сработало (${hits}); проверьте --zero-query-api (${zeroApi.base})`);
        delayNote = `; P (Z): снимок null и state=loading во время задержанной (${delayMs} мс, срабатываний ${hits}) регистрации synced query, готовность через ${dt} мс`;
      } else {
        delayNote = '';
      }
    } else {
      const loaded = await loadedPages(page);
      assert.ok(loaded.includes(p1) && loaded.includes(p2));
    }
    return {
      summary: `p1: ${n1} фигур, ревизия ${docRev}, зонд ${rep1.ticks} опросов без частичных снимков; p2: ${n2} фигур, зонд ${rep2.ticks} опросов${delayNote}; холст: ${colors.colors} цветов`,
      probe1: { ticks: rep1.ticks, records: rep1.records.length },
      probe2: { ticks: rep2.ticks, records: rep2.records.length, immediate: { state: immediate.state, snapNull: immediate.snap === null }, dt },
      canvas: colors,
      consoleErrors: s.errors,
    };
  },
};
