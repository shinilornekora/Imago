// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 2. Локальная заливка (таблица 1, строка 2; SPEC §1.1).
 * `setLocalFill` экземпляра → цвет изменён, `fillOverridden=true`, холст перерисован; переход туда-обратно
 * (в P — через `cache+1` других страниц, т. е. с реальным вытеснением из окна: `getLoadedPages()` без страницы
 * и повторное чтение `/api/.../pages/X`) не отменяет настройку. Затем `setSourceFill` источника тем же цветом
 * и другим цветом: переопределённый экземпляр сохраняет локальную заливку и `fillOverridden=true`, соседний
 * непереопределённый экземпляр получает цвет источника. Итог сверяется с БД и с эталоном (compare-db + operations).
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { describeReport } from '../lib/oracle.mjs';
import { loadedPages, retainedSettled, runCommand, selectPage, snapshot } from '../lib/stand.mjs';

export default {
  id: '2-local-fill',
  title: () => '2. Локальная заливка',
  async run(ctx) {
    const { doc, cfg, db, oracle } = ctx;
    const S = doc.pickSource({ minPlainPages: 3 });
    // страница с ≥ 2 непереопределёнными экземплярами источника (второй — «сосед» для наблюдения общей заливки)
    const X = S.plainPages.find((p) => doc.plainInstancesOn(S.id, p).length >= 2) ?? S.plainPages[0];
    const [inst, sibling] = doc.plainInstancesOn(S.id, X);
    assert.ok(inst, 'есть непереопределённый экземпляр');
    const LOCAL = freshColor(doc, 0);
    const OTHER = freshColor(doc, 1);
    assert.notEqual(LOCAL, OTHER);
    const commands = [];

    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await selectPage(page, X);

    // локальная заливка
    const c1 = await runCommand(page, { type: 'setLocalFill', targetId: inst.id, fill: LOCAL });
    commands.push({ opId: c1.result.opId, type: 'setLocalFill', targetId: inst.id, fill: LOCAL });
    assert.equal(c1.result.revision, doc.revision + 1);
    assert.deepEqual(c1.result.affectedPages, [X]);
    assert.equal(c1.result.affectedShapes, 1);
    assert.equal(c1.drawn.detail.pageId, X, 'command-drawn на активной странице');
    assert.ok(c1.drawn.detail.drawnRevision >= c1.result.revision);
    // порядок acked/drawn не фиксируется: `command-drawn` — момент фактической отрисовки (§1.8) и у Z
    // законно наступает РАНЬШЕ подтверждения (ack включает отдельное чтение журнала операций);
    // содержательное требование — оба момента наступили и холст на ревизии ≥ подтверждённой
    assert.ok(c1.drawn.t > 0 && c1.acked.t > 0, 'зафиксированы оба момента: command-acked и command-drawn');
    assert.ok(c1.drawnInfo && c1.drawnInfo.revision >= c1.result.revision, `холст на ревизии ${c1.drawnInfo?.revision} ≥ ${c1.result.revision}`);
    assert.equal(c1.pending, 0);
    assert.equal(c1.state, 'ready');
    let snap = await snapshot(page, X);
    let sh = snap.shapes.find((x) => x.id === inst.id);
    assert.equal(sh.fill, LOCAL, 'локальная заливка применена');
    assert.equal(sh.fillOverridden, true, 'fillOverridden=true');
    if (sibling) {
      const sb = snap.shapes.find((x) => x.id === sibling.id);
      assert.equal(sb.fill, S.fill, 'сосед не тронут');
      assert.equal(sb.fillOverridden, false);
    }
    const dbInst = await db.shape(inst.id);
    assert.equal(dbInst.fill, LOCAL);
    assert.equal(dbInst.fillOverridden, true);

    // туда-обратно: в P — через cache+1 других страниц (вытеснение), в F — данные остаются.
    // Если окно шире документа (cache+1 ≥ числа страниц — так бывает у P/cache=10 на документе из 10 страниц),
    // вытеснения по построению НЕ происходит: тогда проверяется обратное — страница осталась и не перечитывалась.
    const evicts = cfg.mode === 'P' && cfg.cache + 1 < doc.pages.length;
    const others = doc.pages.map((p) => p.id).filter((p) => p !== X).slice(0, cfg.cache + 1);
    const readsBefore = s.pageReads(doc.docId, X).length;
    for (const o of others) {
      await selectPage(page, o);
      if (cfg.mode === 'P') {
        const r = await retainedSettled(page, (x) => x.pages <= cfg.cache + 1);
        assert.ok(r.pages <= cfg.cache + 1, `P: retained.pages=${r.pages} > cache+1`);
      }
    }
    const loadedAway = await loadedPages(page);
    if (evicts) {
      assert.ok(!loadedAway.includes(X), `P: страница ${X} вытеснена из окна (loaded=${loadedAway.join(',')})`);
      assert.equal(await snapshot(page, X), null, 'P: снимок вытесненной страницы — null');
    } else {
      assert.ok(loadedAway.includes(X), `${cfg.mode}: окно (${cfg.mode === 'P' ? `cache+1=${cfg.cache + 1}` : 'весь документ'}) шире документа (${doc.pages.length} страниц) — страница остаётся загруженной`);
      assert.ok(await snapshot(page, X), 'снимок удержанной страницы доступен');
    }
    const evBack = await selectPage(page, X);
    assert.ok(evBack.detail.revision >= c1.result.revision, 'повторная готовность на ревизии ≥ команды');
    const readsAfter = s.pageReads(doc.docId, X).length;
    if (cfg.adapter !== 'Z') {
      // Z читает страницы по WebSocket (повторная материализация видна по getLoadedPages/snapshot=null выше)
      if (evicts) assert.equal(readsAfter, readsBefore + 1, 'P: вытесненная страница действительно перечитана');
      else assert.equal(readsAfter, readsBefore, 'без вытеснения повторного чтения нет');
    }
    snap = await snapshot(page, X);
    sh = snap.shapes.find((x) => x.id === inst.id);
    assert.equal(sh.fill, LOCAL, 'после перехода туда-обратно локальная заливка сохранена');
    assert.equal(sh.fillOverridden, true, 'после перехода туда-обратно переопределение сохранено');

    // общая заливка тем же цветом: переопределение не снимается
    const c2 = await runCommand(page, { type: 'setSourceFill', targetId: S.id, fill: LOCAL });
    commands.push({ opId: c2.result.opId, type: 'setSourceFill', targetId: S.id, fill: LOCAL });
    assert.equal(c2.result.revision, doc.revision + 2);
    assert.deepEqual([...c2.result.affectedPages].sort(), doc.affectedPagesOf(S.id));
    assert.equal(c2.result.affectedShapes, 1 + S.instances.filter((i) => !i.fillOverridden && i.id !== inst.id).length);
    snap = await snapshot(page, X);
    sh = snap.shapes.find((x) => x.id === inst.id);
    assert.equal(sh.fill, LOCAL);
    assert.equal(sh.fillOverridden, true, 'совпадение цвета с источником не снимает переопределение (снимок)');
    if (sibling) {
      const sb = snap.shapes.find((x) => x.id === sibling.id);
      assert.equal(sb.fill, LOCAL, 'сосед получил цвет источника');
      assert.equal(sb.fillOverridden, false);
    }
    let dbRow = await db.shape(inst.id);
    assert.equal(dbRow.fillOverridden, true, 'совпадение цвета с источником не снимает переопределение (БД)');

    // общая заливка другим цветом: переопределённый экземпляр остаётся локальным
    const c3 = await runCommand(page, { type: 'setSourceFill', targetId: S.id, fill: OTHER });
    commands.push({ opId: c3.result.opId, type: 'setSourceFill', targetId: S.id, fill: OTHER });
    assert.equal(c3.result.revision, doc.revision + 3);
    snap = await snapshot(page, X);
    sh = snap.shapes.find((x) => x.id === inst.id);
    assert.equal(sh.fill, LOCAL, 'локальная заливка пережила общую заливку другим цветом');
    assert.equal(sh.fillOverridden, true);
    if (sibling) {
      const sb = snap.shapes.find((x) => x.id === sibling.id);
      assert.equal(sb.fill, OTHER);
      assert.equal(sb.fillOverridden, false);
    }
    assert.ok(snap.revision >= c3.result.revision);
    dbRow = await db.shape(inst.id);
    assert.equal(dbRow.fill, LOCAL);
    assert.equal(dbRow.fillOverridden, true);
    const dbSrc = await db.shape(S.id);
    assert.equal(dbSrc.fill, OTHER);

    const cmp = await oracle.compareDb('2-local-fill', commands, { checkOperations: true });
    assert.ok(cmp.ok, `эталон compare-db: ${describeReport(cmp)}\n${cmp.commandLine}`);

    return {
      summary: `экземпляр ${inst.id} на ${X}: локальная ${LOCAL} сохранена после ${evicts ? 'вытеснения и перечитывания' : `перехода туда-обратно без вытеснения (окно ${cfg.mode === 'P' ? cfg.cache + 1 : doc.pages.length} ≥ ${doc.pages.length} страниц)`}, после setSourceFill(${LOCAL}) и setSourceFill(${OTHER}); compare-db ok`,
      source: S.id,
      page: X,
      instance: inst.id,
      sibling: sibling?.id ?? null,
      reads: { before: readsBefore, after: readsAfter },
      revisions: [c1.result.revision, c2.result.revision, c3.result.revision],
      oracleReport: cmp.reportFile,
    };
  },
};
