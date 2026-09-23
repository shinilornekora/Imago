// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 6. Повтор команды (таблица 1, строка 6; SPEC §2.3 идемпотентность, §6 п. 6).
 * Вариант А (ответ потерян ПОСЛЕ обработки сервером): `page.route` → `route.fetch()` (сервер выполняет команду),
 *   затем `route.abort('connectionreset')` — клиент получает сетевую ошибку, опрашивает `GET /api/operations/:opId`
 *   (`command-retry via 'poll'`) и получает тот же результат: в `operations` одна строка с этим opId,
 *   `documents.revision` +1, `command-acked` один раз, `command-sent` один раз (без повторного POST).
 * Вариант Б (запрос потерян ДО сервера): `route.abort()` без `fetch` — опрос даёт 404 → повторный POST с ТЕМ ЖЕ
 *   `opId` (`command-retry via 'repost'`; по журналу `page.route` — два POST с одним и тем же телом): одна строка,
 *   ревизия +1, один результат. Затем прямой повтор того же opId по HTTP → тот же результат, `x-stand-replayed: 1`,
 *   ревизия не меняется; тот же opId с иными параметрами → 409 `op_conflict`.
 * Затем эталон `compare-db --check-operations` по обеим логическим операциям.
 * Z: команда идёт мутатором по WebSocket — обрыв моделируется `context.setOffline(true)`: (А) до отправки
 *   (мутация в очереди клиента, доставка после переподключения), (Б) сразу после `command-sent` на 700 мс;
 *   проверяются те же инварианты БД (одна строка operations на opId, ревизия +1) — см. runZ.
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { describeReport } from '../lib/oracle.mjs';
import { eventsOf, runCommand, snapshot, selectPage } from '../lib/stand.mjs';

export default {
  id: '6-retry',
  title: () => '6. Повтор команды',
  async run(ctx) {
    const { doc, cfg, db, oracle } = ctx;
    const X = doc.pid(2);
    const shapeA = doc.plainShapeOn(X);
    const shapeB = (doc.shapesByPage.get(X) ?? []).find((x) => !x.isSource && !x.sourceId && x.id !== shapeA.id);
    assert.ok(shapeB, 'вторая обычная фигура на странице');
    const FILL_A = freshColor(doc, 5);
    const FILL_B = freshColor(doc, 6);
    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await selectPage(page, X);
    const revBefore = await db.revision(doc.docId);
    assert.equal((await db.operations(doc.docId)).length, 0, 'журнал операций пуст после сброса');
    const commands = [];

    if (cfg.adapter === 'Z') return runZ(ctx, s, { X, shapeA, FILL_A, revBefore });

    // ---- вариант А: сервер обработал, ответ оборван
    let abortedA = 0;
    const postsA = [];
    await page.route('**/api/documents/*/commands', async (route) => {
      postsA.push(route.request().postDataJSON());
      if (abortedA === 0) {
        abortedA += 1;
        await route.fetch(); // сервер выполняет команду…
        await route.abort('connectionreset'); // …но ответ до клиента не доходит
        return;
      }
      await route.continue();
    });
    const cA = await runCommand(page, { type: 'setLocalFill', targetId: shapeA.id, fill: FILL_A });
    await page.unroute('**/api/documents/*/commands');
    commands.push({ opId: cA.result.opId, type: 'setLocalFill', targetId: shapeA.id, fill: FILL_A });
    assert.equal(abortedA, 1, 'ответ первого POST оборван');
    assert.equal(cA.result.revision, revBefore + 1, 'ревизия +1');
    assert.equal(cA.sent.length, 1, 'вариант А: одна отправка (результат получен опросом операции)');
    assert.equal(postsA.length, 1, `вариант А: один POST, повторного нет (получено ${postsA.length})`);
    assert.equal(postsA[0].opId, cA.result.opId);
    const retriesA = (await eventsOf(page, 'command-retry')).filter((e) => e.detail.opId === cA.result.opId);
    assert.ok(retriesA.some((e) => e.detail.via === 'poll'), `ожидалось command-retry via poll: ${JSON.stringify(retriesA)}`);
    assert.ok(!retriesA.some((e) => e.detail.via === 'repost'), 'вариант А: без повторного POST');
    const ackedA = (await eventsOf(page, 'command-acked')).filter((e) => e.detail.opId === cA.result.opId);
    assert.equal(ackedA.length, 1, 'command-acked один раз');
    const drawnA = (await eventsOf(page, 'command-drawn')).filter((e) => e.detail.opId === cA.result.opId);
    assert.equal(drawnA.length, 1, 'command-drawn один раз');
    let rows = await db.operation(cA.result.opId);
    assert.equal(rows.length, 1, 'в operations ровно одна строка с opId');
    assert.equal(rows[0].result.revision, cA.result.revision);
    assert.deepEqual(rows[0].result.affectedPages, cA.result.affectedPages);
    assert.equal(rows[0].result.affectedShapes, cA.result.affectedShapes);
    assert.equal(await db.revision(doc.docId), revBefore + 1, 'documents.revision увеличилась ровно на 1');
    assert.equal((await db.operations(doc.docId)).length, 1, 'всего одна операция документа');
    let sh = (await snapshot(page, X)).shapes.find((x) => x.id === shapeA.id);
    assert.equal(sh.fill, FILL_A, 'новая заливка отрисована/в снимке');
    assert.equal(sh.fillOverridden, true);
    assert.equal(cA.pending, 0);
    assert.equal(cA.state, 'ready');

    // ---- вариант Б: запрос оборван до сервера → опрос 404 → повторный POST с тем же opId
    let abortedB = 0;
    /** тела всех POST /commands (opId каждого) — повтор обязан идти с тем же opId */
    const postsB = [];
    await page.route('**/api/documents/*/commands', async (route) => {
      postsB.push(route.request().postDataJSON());
      if (abortedB === 0) {
        abortedB += 1;
        await route.abort('connectionreset'); // сервер запрос не видел
        return;
      }
      await route.continue();
    });
    const cB = await runCommand(page, { type: 'setLocalFill', targetId: shapeB.id, fill: FILL_B });
    await page.unroute('**/api/documents/*/commands');
    commands.push({ opId: cB.result.opId, type: 'setLocalFill', targetId: shapeB.id, fill: FILL_B });
    assert.equal(abortedB, 1);
    assert.equal(cB.result.revision, revBefore + 2);
    assert.equal(postsB.length, 2, `вариант Б: два POST (оборванный и повторный), получено ${postsB.length}`);
    assert.equal(postsB[0].opId, postsB[1].opId, 'повторный POST с тем же opId');
    assert.equal(postsB[0].opId, cB.result.opId);
    assert.deepEqual(postsB[0], postsB[1], 'повторный POST с теми же параметрами');
    // по контракту клиента command-sent пишется один раз на попытку с данной expectedRevision; повтор фиксирует command-retry
    assert.equal(cB.sent.length, 1, 'command-sent один раз (повтор политики отражён в command-retry)');
    const retriesB = (await eventsOf(page, 'command-retry')).filter((e) => e.detail.opId === cB.result.opId);
    assert.ok(retriesB.some((e) => e.detail.via === 'poll'), 'опрос операции перед повтором');
    assert.ok(retriesB.some((e) => e.detail.via === 'repost'), `ожидалось command-retry via repost: ${JSON.stringify(retriesB)}`);
    const ackedB = (await eventsOf(page, 'command-acked')).filter((e) => e.detail.opId === cB.result.opId);
    assert.equal(ackedB.length, 1);
    rows = await db.operation(cB.result.opId);
    assert.equal(rows.length, 1, 'одна строка operations для повторённого opId');
    assert.equal(rows[0].result.revision, cB.result.revision);
    assert.equal(await db.revision(doc.docId), revBefore + 2);
    assert.equal((await db.operations(doc.docId)).length, 2);
    sh = (await snapshot(page, X)).shapes.find((x) => x.id === shapeB.id);
    assert.equal(sh.fill, FILL_B);

    // ---- прямой повтор того же opId по HTTP: тот же результат, без второго изменения (x-stand-replayed)
    const alice = await ctx.api.login('alice');
    const replay = await ctx.api.postCommand(alice.token, doc.docId, { ...postsB[1] }); // тот же opId и те же параметры (в т. ч. expectedRevision)
    assert.equal(replay.status, 200, `повтор opId по HTTP: ${replay.status} ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.revision, cB.result.revision, 'повтор возвращает тот же результат');
    assert.equal(replay.headers.get('x-stand-replayed'), '1', 'повтор помечен x-stand-replayed');
    assert.equal(await db.revision(doc.docId), revBefore + 2, 'повтор не меняет ревизию');
    const conflict = await ctx.api.postCommand(alice.token, doc.docId, { ...postsB[1], fill: FILL_A }); // тот же opId, иные параметры
    assert.equal(conflict.status, 409, 'тот же opId с иными параметрами → 409 op_conflict');
    assert.equal(conflict.body?.error, 'op_conflict');

    const cmp = await oracle.compareDb('6-retry', commands, { checkOperations: true });
    assert.ok(cmp.ok, `эталон compare-db/operations: ${describeReport(cmp)}\n${cmp.commandLine}`);

    return {
      summary: `А: ответ оборван после обработки → poll, 1 POST, 1 строка, rev ${revBefore}→${revBefore + 1}; Б: запрос оборван до сервера → poll(404)+repost с тем же opId, 1 строка, rev → ${revBefore + 2}; повтор по HTTP replayed, конфликт параметров 409; compare-db ok`,
      opIds: [cA.result.opId, cB.result.opId],
      retries: { A: retriesA.map((e) => e.detail.via), B: retriesB.map((e) => e.detail.via) },
      oracleReport: cmp.reportFile,
    };
  },
};

/**
 * Z: команда идёт мутатором по WebSocket (push с mutationID; результат — из журнала операций по HTTP).
 * Вариант А: сеть отключена (`context.setOffline(true)`) ДО отправки — мутация ставится в очередь клиента Zero,
 *   через 700 мс сеть возвращается → переподключение, push доставляется один раз: `.server` подтверждён после
 *   восстановления (`commandTimings.serverAt`), в `operations` одна строка, ревизия +1.
 * Вариант Б: сеть отключается сразу после `command-sent` на 700 мс (push мог быть отправлен, а ответ потерян):
 *   после восстановления результат получен, строка одна, ревизия +1 — повторная доставка (если была) идемпотентна.
 */
async function runZ(ctx, s, { X, shapeA, FILL_A, revBefore }) {
  const { doc, db, oracle } = ctx;
  const { page, context } = s;
  const shapeB = (doc.shapesByPage.get(X) ?? []).find((x) => !x.isSource && !x.sourceId && x.id !== shapeA.id);
  const FILL_B = freshColor(doc, 6);
  // момент подтверждения мутации сервером: предпочтительно событие `command-server` (контракт window.__stand),
  // с запасным вариантом — диагностика адаптера `commandTimings` (её имена может менять клиент)
  const timings = () =>
    page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const fromEvents = w.__stand.events
        .filter((e) => e.type === 'command-server' || e.type === 'command-sent')
        .reduce((acc, e) => {
          const t = (acc[e.detail.opId] ??= { opId: e.detail.opId, sentAt: null, serverAt: null, source: 'events' });
          if (e.type === 'command-sent') t.sentAt = e.t;
          else t.serverAt = e.t;
          return acc;
        }, {});
      const list = Object.values(fromEvents).filter((t) => t.sentAt !== null && t.serverAt !== null);
      if (list.length) return list.slice(-2);
      return (w.__standController?.adapter?.commandTimings ?? []).slice(-2).map((t) => ({ ...t, source: 'commandTimings' }));
    });

  // ---- вариант А: офлайн до отправки
  await context.setOffline(true);
  const tOff = Date.now();
  const cmdA = runCommand(page, { type: 'setLocalFill', targetId: shapeA.id, fill: FILL_A }, 40_000);
  await new Promise((r) => setTimeout(r, 700));
  await context.setOffline(false);
  const tOn = Date.now();
  const cA = await cmdA;
  const tA = (await timings()).find((t) => t.opId === cA.result.opId);
  assert.equal(cA.result.revision, revBefore + 1, 'ревизия +1');
  assert.ok(tA, 'commandTimings содержит команду');
  assert.ok(tA.serverAt !== null && tA.serverAt - tA.sentAt >= (tOn - tOff) - 50, `подтверждение .server после восстановления сети (serverAt-sentAt=${Math.round(tA.serverAt - tA.sentAt)} мс, офлайн ${tOn - tOff} мс)`);
  let rows = await db.operation(cA.result.opId);
  assert.equal(rows.length, 1, 'одна строка operations после переподключения');
  assert.equal(rows[0].result.revision, cA.result.revision);
  assert.equal(await db.revision(doc.docId), revBefore + 1);
  assert.equal((await db.operations(doc.docId)).length, 1);
  let sh = (await snapshot(page, X)).shapes.find((x) => x.id === shapeA.id);
  assert.equal(sh.fill, FILL_A);
  assert.equal(cA.state, 'ready');
  assert.equal(cA.pending, 0);
  const ackedA = (await eventsOf(page, 'command-acked')).filter((e) => e.detail.opId === cA.result.opId);
  assert.equal(ackedA.length, 1, 'command-acked один раз');

  // ---- вариант Б: офлайн сразу после command-sent
  const sentP = page.evaluate(async () => {
    const st = /** @type {any} */ (window).__stand;
    const e = await st.waitFor('command-sent', undefined, 20000, performance.now());
    return e.t;
  });
  const cmdB = runCommand(page, { type: 'setLocalFill', targetId: shapeB.id, fill: FILL_B }, 40_000);
  await sentP;
  await context.setOffline(true);
  await new Promise((r) => setTimeout(r, 700));
  await context.setOffline(false);
  const cB = await cmdB;
  const tB = (await timings()).find((t) => t.opId === cB.result.opId);
  assert.equal(cB.result.revision, revBefore + 2);
  rows = await db.operation(cB.result.opId);
  assert.equal(rows.length, 1, 'одна строка operations (повторная доставка идемпотентна)');
  assert.equal(await db.revision(doc.docId), revBefore + 2);
  assert.equal((await db.operations(doc.docId)).length, 2);
  sh = (await snapshot(page, X)).shapes.find((x) => x.id === shapeB.id);
  assert.equal(sh.fill, FILL_B);

  const cmp = await oracle.compareDb('6-retry-Z', [
    { opId: cA.result.opId, type: 'setLocalFill', targetId: shapeA.id, fill: FILL_A },
    { opId: cB.result.opId, type: 'setLocalFill', targetId: shapeB.id, fill: FILL_B },
  ], { checkOperations: true });
  assert.ok(cmp.ok, `эталон: ${describeReport(cmp)}`);
  const retries = (await eventsOf(page, 'command-retry')).map((e) => e.detail.via);
  return {
    summary: `Z А: офлайн ${tOn - tOff} мс до отправки → доставлено после восстановления (.server через ${Math.round(tA.serverAt - tA.sentAt)} мс), 1 строка, rev ${revBefore}→${revBefore + 1}; Б: офлайн 700 мс после command-sent → .server через ${Math.round((tB?.serverAt ?? 0) - (tB?.sentAt ?? 0))} мс, 1 строка, rev → ${revBefore + 2}; compare-db ok; retry-события: ${retries.join(',') || 'нет'}`,
    opIds: [cA.result.opId, cB.result.opId],
    timings: [tA, tB],
    oracleReport: cmp.reportFile,
  };
}
