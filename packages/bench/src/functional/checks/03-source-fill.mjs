// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 3. Общая заливка источника (таблица 1, строка 3; SPEC §1.1, §6).
 * `setSourceFill` источника с экземплярами на ≥ 3 страницах, часть которых клиент не загружал (в P):
 * БД сверяется с эталоном (`compare-db --check-operations`), `affectedPages`/`affectedShapes`/`revision`
 * результата совпадают с ожидаемыми эталоном, снимок активной страницы равен ожидаемому (compare-snapshots),
 * переопределённые экземпляры не тронуты.
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { describeReport } from '../lib/oracle.mjs';
import { loadedPages, runCommand, selectPage, snapshot, waitInPage } from '../lib/stand.mjs';

export default {
  id: '3-source-fill',
  title: () => '3. Общая заливка источника',
  async run(ctx) {
    const { doc, cfg, oracle, db } = ctx;
    const S = doc.pickSource({ minPlainPages: 3 });
    const X = S.plainPages.find((p) => p !== doc.pid(1)) ?? S.plainPages[0];
    const FILL = freshColor(doc, 2);

    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await selectPage(page, X);
    if (cfg.mode === 'F') {
      await waitInPage(page, (n) => /** @type {any} */ (window).__stand.getLoadedPages().length === n, doc.pages.length, 20_000);
    }
    const loadedBefore = await loadedPages(page);
    const affectedExpected = doc.affectedPagesOf(S.id);
    const neverLoaded = affectedExpected.filter((p) => !loadedBefore.includes(p));
    if (cfg.mode === 'P') assert.ok(neverLoaded.length >= 2, `P: есть незагруженные затронутые страницы (${neverLoaded.length})`);

    const c = await runCommand(page, { type: 'setSourceFill', targetId: S.id, fill: FILL });
    assert.equal(c.sent.length, 1, 'одна отправка команды');
    const commands = [{ opId: c.result.opId, type: 'setSourceFill', targetId: S.id, fill: FILL, expectedRevision: c.sent[0].detail.expectedRevision }];
    assert.equal(c.result.revision, doc.revision + 1);
    assert.equal(c.acked.detail.revision, c.result.revision);
    assert.deepEqual([...c.acked.detail.affectedPages].sort(), [...c.result.affectedPages].sort());
    assert.equal(c.drawn.detail.pageId, X, 'command-drawn для активной страницы');
    assert.ok(c.drawn.detail.drawnRevision >= c.result.revision);
    assert.equal(c.state, 'ready');
    assert.equal(c.pending, 0);

    // эталон: БД + журнал операций
    const cmp = await oracle.compareDb('3-source-fill', commands, { checkOperations: true });
    ctx.partial.oracle = cmp.report?.counts;
    assert.ok(cmp.ok, `эталон compare-db: ${describeReport(cmp)}\n${cmp.commandLine}`);
    const exp = cmp.report.expectedResults[0];
    assert.deepEqual([...c.result.affectedPages].sort(), [...exp.affectedPages].sort(), 'affectedPages совпадают с эталоном');
    assert.equal(c.result.affectedShapes, exp.affectedShapes, 'affectedShapes совпадают с эталоном');
    assert.equal(c.result.revision, exp.revision, 'revision совпадает с эталоном');
    assert.deepEqual([...c.result.affectedPages].sort(), affectedExpected, 'affectedPages == страницы источника и непереопределённых экземпляров');
    assert.equal(await db.revision(doc.docId), c.result.revision);

    // снимок активной страницы против эталона
    const snapX = await snapshot(page, X);
    const cs = await oracle.compareSnapshots('3-source-fill-active', commands, [{ pageId: X, revision: snapX.revision, shapes: snapX.shapes }], { requirePages: [X] });
    assert.ok(cs.ok, `эталон compare-snapshots(${X}): ${describeReport(cs)}\n${cs.commandLine}`);
    for (const o of doc.overriddenInstancesOn(S.id, X)) {
      const sh = snapX.shapes.find((x) => x.id === o.id);
      assert.equal(sh.fill, o.fill, `переопределённый экземпляр ${o.id} не изменён`);
      assert.equal(sh.fillOverridden, true);
    }
    for (const p of doc.plainInstancesOn(S.id, X)) {
      assert.equal(snapX.shapes.find((x) => x.id === p.id).fill, FILL, `непереопределённый экземпляр ${p.id} перекрашен`);
    }

    return {
      summary: `setSourceFill(${S.id}, ${FILL}) с активной ${X}: affectedPages=${c.result.affectedPages.length} (незагруженных до команды: ${neverLoaded.length}), affectedShapes=${c.result.affectedShapes}; compare-db + operations ok; снимок ${X} = эталон`,
      source: S.id,
      activePage: X,
      neverLoaded,
      result: c.result,
      oracleReport: cmp.reportFile,
    };
  },
};
