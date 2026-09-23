// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 4. Поздний переход (таблица 1, строка 4).
 * После `setSourceFill` открывается страница Y, которую клиент ещё не показывал: `page-ready` с ревизией ≥
 * подтверждённой, снимок Y равен эталону (compare-snapshots), непереопределённые экземпляры перекрашены,
 * переопределённые сохранены. В F данные Y были загружены ДО команды — проверяется, что все затронутые
 * страницы перечитаны/обновлены (снимки на ревизии ≥ команды и равны эталону; по журналу запросов — повторное
 * чтение каждой затронутой страницы), а незатронутые «подняты» до новой ревизии без запросов (информационно).
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { describeReport } from '../lib/oracle.mjs';
import { loadedPages, runCommand, selectPage, snapshot, standInfo, waitInPage } from '../lib/stand.mjs';

export default {
  id: '4-late-nav',
  title: () => '4. Поздний переход',
  async run(ctx) {
    const { doc, cfg, oracle } = ctx;
    const S = doc.pickSource({ minPlainPages: 3 });
    const X = S.plainPages.find((p) => p !== doc.pid(1)) ?? S.plainPages[0];
    const candidates = S.plainPages.filter((p) => p !== X && p !== doc.pid(1));
    const Y = candidates[candidates.length - 1];
    assert.ok(Y, 'есть непосещённая страница с экземплярами источника');
    const FILL = freshColor(doc, 3);

    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await selectPage(page, X);
    if (cfg.mode === 'F') {
      await waitInPage(page, (n) => /** @type {any} */ (window).__stand.getLoadedPages().length === n, doc.pages.length, 20_000);
    }
    const loadedBefore = await loadedPages(page);
    if (cfg.mode === 'P') assert.ok(!loadedBefore.includes(Y), `P: страница ${Y} не загружена до команды`);
    else assert.ok(loadedBefore.includes(Y), `F: страница ${Y} загружена до команды`);
    const readsBefore = Object.fromEntries(doc.pages.map((p) => [p.id, s.pageReads(doc.docId, p.id).length]));

    const c = await runCommand(page, { type: 'setSourceFill', targetId: S.id, fill: FILL });
    const rev = c.result.revision;
    const commands = [{ opId: c.result.opId, type: 'setSourceFill', targetId: S.id, fill: FILL }];
    assert.equal(c.drawn.detail.pageId, X);
    const affected = [...c.result.affectedPages].sort();
    assert.ok(affected.includes(Y), 'Y затронута командой');

    /** @type {Record<string, any>} */
    const fInfo = {};
    if (cfg.mode === 'F') {
      // все затронутые страницы должны обновиться (перечитывание в фоне), незатронутые — подняться до новой ревизии
      await waitInPage(
        page,
        ({ pages, r }) => pages.every((p) => (/** @type {any} */ (window).__stand.getPageSnapshot(p)?.revision ?? -1) >= r),
        { pages: doc.pages.map((p) => p.id), r: rev },
        20_000,
      );
      // фоновые перечитывания могли ещё не завершиться (пришёл снимок, но запрос ещё в журнале) — короткая пауза
      await page.waitForTimeout(200);
      const snaps = [];
      for (const p of doc.pages) {
        const sn = await snapshot(page, p.id);
        snaps.push({ pageId: p.id, revision: sn.revision, shapes: sn.shapes });
      }
      const cs = await oracle.compareSnapshots('4-late-nav-F-all', commands, snaps, { requirePages: doc.pages.map((p) => p.id) });
      assert.ok(cs.ok, `F: снимки всех страниц после команды против эталона: ${describeReport(cs)}\n${cs.commandLine}`);
      if (cfg.adapter !== 'Z') {
        const refetched = affected.filter((p) => s.pageReads(doc.docId, p).length > readsBefore[p]);
        const notRefetched = affected.filter((p) => s.pageReads(doc.docId, p).length === readsBefore[p]);
        assert.deepEqual(notRefetched, [], `F: затронутые страницы без повторного чтения после команды: ${notRefetched.join(',')}`);
        const unaffectedReads = doc.pages.map((p) => p.id).filter((p) => !affected.includes(p) && s.pageReads(doc.docId, p).length > readsBefore[p]);
        fInfo.refetched = refetched.length;
        fInfo.unaffectedRefetched = unaffectedReads; // информационно: поднятие ревизии без запроса
      } else {
        fInfo.note = 'Z: обновление затронутых страниц приходит синхронизацией (HTTP-чтений нет)';
      }
    }

    const readsYBefore = s.pageReads(doc.docId, Y).length;
    const ev = await selectPage(page, Y);
    assert.equal(ev.detail.pageId, Y);
    assert.ok(ev.detail.revision >= rev, `page-ready(${Y}).revision=${ev.detail.revision} ≥ ${rev}`);
    assert.equal(ev.detail.shapeCount, doc.countOf(Y));
    const info = await standInfo(page);
    assert.equal(info.state, 'ready');
    assert.equal(info.drawn.pageId, Y);
    assert.equal(info.drawn.shapeCount, doc.countOf(Y));
    assert.ok(info.drawn.revision >= rev);
    const snapY = await snapshot(page, Y);
    assert.ok(snapY.revision >= rev, `снимок ${Y} на ревизии ${snapY.revision} ≥ ${rev}`);
    const cs = await oracle.compareSnapshots('4-late-nav-Y', commands, [{ pageId: Y, revision: snapY.revision, shapes: snapY.shapes }], { requirePages: [Y] });
    assert.ok(cs.ok, `снимок ${Y} против эталона: ${describeReport(cs)}\n${cs.commandLine}`);
    for (const p of doc.plainInstancesOn(S.id, Y)) assert.equal(snapY.shapes.find((x) => x.id === p.id).fill, FILL, `экземпляр ${p.id} на ${Y} перекрашен`);
    for (const o of doc.overriddenInstancesOn(S.id, Y)) {
      const sh = snapY.shapes.find((x) => x.id === o.id);
      assert.equal(sh.fill, o.fill, `переопределённый ${o.id} сохранён`);
      assert.equal(sh.fillOverridden, true);
    }
    const readsY = s.pageReads(doc.docId, Y).length - readsYBefore;
    if (cfg.mode === 'P' && cfg.adapter !== 'Z') assert.equal(readsY, 1, 'P: поздний переход читает страницу один раз');

    return {
      summary: `после setSourceFill(${S.id}) rev=${rev} открыта ${Y}: page-ready rev=${ev.detail.revision}, снимок = эталон${cfg.mode === 'F' ? `; F: все ${affected.length} затронутых страниц ${cfg.adapter === 'Z' ? 'обновлены синхронизацией' : 'перечитаны'}, снимки всех ${doc.pages.length} страниц = эталон` : ''}`,
      source: S.id,
      activePage: X,
      latePage: Y,
      affected,
      readsY,
      ...fInfo,
    };
  },
};
