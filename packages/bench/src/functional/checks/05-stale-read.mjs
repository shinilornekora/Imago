// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * 5. Ответ старого чтения (таблица 1, строка 5; SPEC §2.3, §4.1).
 *
 * Общая постановка для всех адаптеров: данные страницы X ЗАПРОШЕНЫ ДО команды, а ДОСТАВЛЕНЫ ПОСЛЕ неё;
 * итоговое состояние X — послекомандное, и после первого актуального кадра нет отката к устаревшему цвету.
 *
 * H/Q — чтение страницы X задерживается тестовым хуком `POST /api/test/delay` (задержка в onSend: сервер уже
 *   прочитал данные на СТАРОЙ ревизии, т. е. ответ действительно устаревший). Пока ответ в полёте, выполняется
 *   `setSourceFill`, затрагивающая X.
 *     P: X читается впервые при `selectPage` (запрос в полёте → команда → ответ старого чтения).
 *     F: X читается при открытии (задержка ставится ДО открытия); команда сразу после готовности первой страницы.
 *
 * Z — путь чтения страницы идёт по WebSocket, и HTTP-хук к нему неприменим. Зато РЕГИСТРАЦИЯ synced query
 *   проходит через `POST /api/zero/query` (ZERO_QUERY_URL, его вызывает zero-cache): задержка этого ответа
 *   откладывает гидратацию страницы X. Измерено (см. docs/FUNCTIONAL_FINDINGS.md): данные, подтверждения
 *   мутаций и обновления запросов у Z идут по ОДНОМУ упорядоченному соединению, поэтому такая задержка
 *   задерживает и команду того же клиента (наблюдалось: ack через 2076 мс при доставке через 1950 мс).
 *   Переупорядочить чтение и команду «изнутри» одного клиента невозможно — это свойство механизма, а не
 *   недостаток проверки. Поэтому команду подаёт ВТОРОЙ УЧАСТНИК (оболочка по HTTP от имени alice):
 *     (1) ставится правило задержки трансформации synced query на окно времени;
 *     (2) страница X ЗАПРАШИВАЕТСЯ испытуемым клиентом (P: `selectPage(X)` — новый synced query;
 *         F: правило ставится ДО открытия, все запросы страниц регистрируются в `open()`), снимок X ещё `null`;
 *     (3) `setSourceFill`, затрагивающая X, выполняется и ЗАВЕРШАЕТСЯ на сервере, пока X не доставлена;
 *     (4) трансформация отпускается, zero-cache гидратирует X — доставка происходит ПОСЛЕ команды.
 *   Утверждается: запрос X сделан до отправки команды, момент первой доставки X > момента завершения команды,
 *   итоговый снимок X — послекомандный (новая заливка у ВСЕХ непереопределённых экземпляров, переопределённые
 *   сохранены, ревизия ≥ ревизии команды), зонд снимков не видел ни отката ревизии, ни старого цвета.
 *   Если механизм НЕ создал позднюю доставку (например, задержка не попала на нужный API), проверка
 *   помечается `skip` с причиной — «допуска» она в этом случае не даёт (раньше здесь был вакуозный pass).
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { SkipCheck } from '../lib/runner.mjs';
import { eventsOf, loadedPages, nowInPage, probe, runCommand, selectPage, snapshot, standInfo, sleep, waitInPage } from '../lib/stand.mjs';

const DELAY_MS = 1500;
/** задержка ответа `POST /api/zero/query` (регистрация synced query) и ширина окна правила */
const Z_DELAY_MS = 1800;
const Z_WINDOW_MS = Z_DELAY_MS + 600;

export default {
  id: '5-stale-read',
  title: () => '5. Ответ старого чтения',
  async run(ctx) {
    const { doc, cfg, api } = ctx;
    const S = doc.pickSource({ minPlainPages: 3 });
    const isZ = cfg.adapter === 'Z';
    const FILL = freshColor(doc, 4);

    if (isZ) return runZ(ctx, S, FILL);

    const X = S.plainPages.find((p) => p !== doc.pid(1) && p !== doc.pid(2)) ?? S.plainPages[0];
    const inst = doc.plainInstancesOn(S.id, X)[0];
    const OLD = inst.fill;
    assert.notEqual(OLD, FILL);

    let s;
    let result;
    let drawnEv;
    let readyEv;
    let firstRead = null;
    let cmdPost = null;
    if (cfg.mode === 'F') {
      await api.delay({ pathPattern: `pages/${X}$`, ms: DELAY_MS, count: 1 });
      s = await ctx.open({ probe: { pageId: X, shapeId: inst.id }, waitFor: 'ready' });
      // чтение X в полёте (задержано на сервере) — команда, затрагивающая X
      const c = await runCommand(page(s), { type: 'setSourceFill', targetId: S.id, fill: FILL });
      result = c.result;
      drawnEv = c.drawn;
      firstRead = s.pageReads(doc.docId, X)[0];
      cmdPost = s.requests.find((r) => r.method === 'POST' && r.path.endsWith('/commands'));
      assert.ok(firstRead, 'первое чтение X зафиксировано');
      assert.ok(cmdPost, 'POST команды зафиксирован');
      assert.ok(firstRead.t < cmdPost.t, 'чтение X началось до команды');
      // ждём прихода задержанного ответа (или его отмены клиентом) и ещё немного
      await sleep(Math.max(0, firstRead.t + DELAY_MS + 700 - Date.now()));
      readyEv = await selectPage(page(s), X);
      await sleep(300);
    } else {
      s = await ctx.open({ waitFor: 'ready' });
      await api.delay({ pathPattern: `pages/${X}$`, ms: DELAY_MS, count: 1 });
      await probe.watch(page(s), X, { shapeId: inst.id });
      const r = await page(s).evaluate(
        async ({ x, target, fill }) => {
          const st = /** @type {any} */ (window).__stand;
          const t0 = performance.now();
          st.selectPage(x); // чтение X в полёте (задержано на сервере)
          await new Promise((res) => setTimeout(res, 120));
          const res = await st.runCommand({ type: 'setSourceFill', targetId: target, fill });
          const drawn = await st.waitFor('command-drawn', (e) => e.detail.opId === res.opId, 20000);
          const ready = await st.waitFor('page-ready', (e) => e.detail.pageId === x, 20000, t0);
          return { result: res, drawn, ready, t0 };
        },
        { x: X, target: S.id, fill: FILL },
      );
      result = r.result;
      drawnEv = r.drawn;
      readyEv = r.ready;
      firstRead = s.pageReads(doc.docId, X)[0];
      cmdPost = s.requests.find((r2) => r2.method === 'POST' && r2.path.endsWith('/commands'));
      assert.ok(firstRead && cmdPost);
      assert.ok(firstRead.t < cmdPost.t, 'чтение X началось до команды');
      await sleep(Math.max(0, firstRead.t + DELAY_MS + 700 - Date.now()));
    }

    const pg = page(s);
    const rev = result.revision;
    const rep = await stopProbe(pg, X, ctx);
    const info = await standInfo(pg);
    const snap = await snapshot(pg, X);
    ctx.partial.final = { info, snapRevision: snap?.revision };

    assert.equal(info.state, 'ready');
    assert.equal(info.activePageId, X);
    assert.ok(readyEv.detail.revision >= rev, `page-ready(${X}).revision=${readyEv.detail.revision} ≥ ${rev}`);
    assertFinalState({ drawnEv, snap, info, rev, X, S, inst, FILL, doc });
    assertNoRegression(rep, rev, FILL, OLD, X);

    const readsX = s.pageReads(doc.docId, X);
    // задержанный ответ (или его отмена клиентом) наступил ПОСЛЕ отправки команды — сценарий воспроизведён
    assert.ok(firstRead.endT !== null, 'первое чтение X завершилось (ответ пришёл или отменён)');
    assert.ok(firstRead.endT >= cmdPost.t, `исход старого чтения (${firstRead.endT}) после отправки команды (${cmdPost.t})`);
    assert.equal((await api.delayRules()).length, 0, 'правило задержки израсходовано — старое чтение прошло через хук');
    assert.ok(readsX.length >= 2, `страница X перечитана после команды (чтений: ${readsX.length})`);
    const ordering = `старое чтение: ${firstRead.failed ? `отменено клиентом (${firstRead.failed})` : `ответ ${firstRead.status}`} через ${firstRead.endT - firstRead.t} мс, команда отправлена через ${cmdPost.t - firstRead.t} мс после его начала; чтений X: ${readsX.length}`;
    const errs = await eventsOf(pg, 'error');
    assert.deepEqual(errs, [], `события error: ${JSON.stringify(errs)}`);

    return {
      summary: `${cfg.mode}: ${ordering}; итог ${X} rev=${snap.revision}, ${inst.id}=${FILL}; зонд ${rep.ticks} опросов, без отката`,
      mechanism: 'HTTP-хук POST /api/test/delay на чтение страницы X (onSend)',
      page: X,
      instance: inst.id,
      firstRead,
      cmdPost,
      probeRecords: rep.records,
      readsX: readsX.length,
    };
  },
};

/**
 * Z: путь чтения страницы — WebSocket, и HTTP-хук к нему неприменим; но РЕГИСТРАЦИЯ synced query идёт через
 * `POST /api/zero/query` (ZERO_QUERY_URL), и её задержка откладывает гидратацию страницы X.
 *
 * ВАЖНО (измерено, см. docs/FUNCTIONAL_FINDINGS.md): у Z данные, подтверждения мутаций и обновления запросов
 * идут по ОДНОМУ упорядоченному соединению, поэтому задержка чтения задерживает и команду того же клиента —
 * переупорядочить их «изнутри» одного клиента невозможно. Команду поэтому подаёт ДРУГОЙ участник (оболочка по
 * HTTP от имени alice, как это сделал бы второй клиент): сервер применяет её, пока чтение X у испытуемого
 * клиента ещё в полёте. Это и есть «ответ старого чтения» строки 5 таблицы 1 для синхронизируемого механизма.
 *
 *   P: `selectPage(X)` регистрирует новый synced query (его трансформация задержана) → команда по HTTP →
 *      X доставляется после команды.
 *   F: правило задержки ставится ДО открытия, все запросы страниц регистрируются при открытии (то есть до
 *      команды), команда подаётся, пока ни одна страница не доставлена.
 * Возвращает детали или бросает SkipCheck, если механизм не создал позднюю доставку (тогда конфигурация
 * получает «допуск с оговоркой», а не молчаливый pass).
 */
async function runZ(ctx, S, FILL) {
  const { doc, cfg, api, db } = ctx;
  const zeroApi = ctx.zeroApi ?? api;
  const alice = await api.login('alice');
  const revBefore = await db.revision(doc.docId);
  const opId = `stale-z-${Date.now()}`;
  const cmdBody = { opId, type: 'setSourceFill', targetId: S.id, fill: FILL, expectedRevision: revBefore };

  /** @type {any} */
  let s = null;
  let X = null;
  let inst = null;
  let OLD = null;
  let requestedAtNode = 0;
  let loadedAtCommand = [];
  let rule = null;
  let readyEv = null;

  try {
    await zeroApi.clearDelays().catch(() => undefined);
    if (cfg.mode === 'P') {
      s = await ctx.open({ waitFor: 'ready' });
      await s.page.waitForTimeout(300);
      const loaded = await loadedPages(s.page);
      const candidates = S.plainPages.filter((p) => p !== doc.pid(1) && !loaded.includes(p));
      X = candidates[0];
      if (!X) throw new SkipCheck(`n/a: в режиме P не нашлось затронутой страницы вне окна кеша (loaded=${loaded.join(',')})`);
      inst = doc.plainInstancesOn(S.id, X)[0];
      OLD = inst.fill;
      assert.notEqual(OLD, FILL);
      rule = await zeroApi.delay({ pathPattern: '/api/zero/query', method: 'POST', ms: Z_DELAY_MS, durationMs: Z_WINDOW_MS });
      await probe.watch(s.page, X, { shapeId: inst.id });
      assert.equal(await snapshot(s.page, X), null, `перед запросом снимок ${X} — null (страница не загружена)`);
      requestedAtNode = Date.now();
      await s.page.evaluate((x) => /** @type {any} */ (window).__stand.selectPage(x), X); // запрос X: трансформация запроса задержана
      await sleep(150);
      loadedAtCommand = await loadedPages(s.page);
      assert.ok(!loadedAtCommand.includes(X), `к моменту команды ${X} ещё не доставлена`);
    } else {
      X = S.plainPages[S.plainPages.length - 1];
      inst = doc.plainInstancesOn(S.id, X)[0];
      OLD = inst.fill;
      assert.notEqual(OLD, FILL);
      // правило ставится ДО открытия: все запросы страниц регистрируются при open(), то есть до команды
      rule = await zeroApi.delay({ pathPattern: '/api/zero/query', method: 'POST', ms: Z_DELAY_MS, durationMs: Z_WINDOW_MS });
      requestedAtNode = Date.now();
      s = await ctx.open({ probe: { pageId: X, shapeId: inst.id }, waitFor: 'none' });
      await s.page.waitForFunction(() => Boolean(/** @type {any} */ (window).__stand?.config), null, { timeout: 30_000 });
      await sleep(250);
      loadedAtCommand = await loadedPages(s.page);
      if (loadedAtCommand.includes(X)) {
        throw new SkipCheck(
          `n/a: страница ${X} была доставлена (loaded=${loadedAtCommand.length}/${doc.pages.length}) раньше, чем удалось подать команду — ` +
            'поздняя доставка для Z/F на этом документе не воспроизведена',
        );
      }
    }

    // общая шкала: performance.now() страницы → Date.now() оболочки
    const offset = Date.now() - (await nowInPage(s.page));

    const sentAtNode = Date.now();
    const res = await api.postCommand(alice.token, doc.docId, cmdBody);
    const cmdDoneNode = Date.now();
    assert.equal(res.status, 200, `команда оболочки (HTTP, alice): ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    const rev = res.body.revision;
    assert.equal(rev, revBefore + 1);
    assert.ok(res.body.affectedPages.includes(X), `команда затрагивает ${X}`);

    // ждём доставки X испытуемому клиенту
    await waitInPage(
      s.page,
      ({ x, r }) => {
        const st = /** @type {any} */ (window).__stand;
        const sn = st.getPageSnapshot(x);
        return Boolean(sn) && sn.revision >= r;
      },
      { x: X, r: rev },
      60_000,
    );
    const deliveredPollNode = Date.now();
    // поздний переход на X (в P она уже активна — берём её события готовности; в F активна первая страница)
    const activeNow = (await standInfo(s.page)).activePageId;
    readyEv = activeNow === X ? await waitReady(s.page, X) : await selectPage(s.page, X);
    // все готовности X: у испытуемого клиента нет своей команды, поэтому готовность МОГЛА наступить на
    // прежней ревизии (клиент ещё не знал о чужой команде) — это законно, требование §1.2 предъявляется к
    // итоговому состоянию (ниже) и к отсутствию отката
    const readyAll = (await eventsOf(s.page, 'page-ready')).filter((e) => e.detail.pageId === X);
    const readyBeforeCommandKnown = readyAll.filter((e) => e.detail.revision < 1 + (revBefore ?? 0));

    const rulesAfter = await zeroApi.delayRules();
    const hits = rulesAfter.find((x) => x.id === rule.id)?.hits ?? null;
    await zeroApi.clearDelays().catch(() => undefined);
    await sleep(300);

    const rep = await stopProbe(s.page, X, ctx);
    const firstRow = rep.records.find((x) => x.size !== null && x.size !== undefined);
    const deliveredNode = firstRow ? Math.round(offset + firstRow.t) : deliveredPollNode;
    ctx.partial.zTiming = {
      requestedAtNode,
      sentAtNode,
      cmdDoneNode,
      deliveredNode,
      deliveredPollNode,
      ruleHits: hits,
      loadedAtCommand,
      offset,
    };

    // «запрошено ДО команды» и «доставлено ПОСЛЕ команды»
    assert.ok(requestedAtNode < sentAtNode, `страница ${X} запрошена до отправки команды`);
    if (!(deliveredNode > cmdDoneNode)) {
      throw new SkipCheck(
        `n/a: механизм не создал позднюю доставку — ${X} доставлена через ${deliveredNode - requestedAtNode} мс после запроса, ` +
          `но раньше завершения команды (команда завершилась через ${cmdDoneNode - requestedAtNode} мс); ` +
          `задержка трансформации POST /api/zero/query (${zeroApi.base}) сработала ${hits ?? '?'} раз(а). ` +
          'Проверьте --zero-query-api (ZERO_QUERY_URL zero-cache)',
      );
    }

    const info = await standInfo(s.page);
    const snap = await snapshot(s.page, X);
    ctx.partial.final = { info, snapRevision: snap?.revision };
    assert.equal(info.state, 'ready');
    assert.equal(info.activePageId, X);
    assert.ok(readyAll.length >= 1, `зафиксирована готовность страницы ${X}`);
    assert.ok(snap && snap.revision >= rev, `итоговый снимок ${X} на ревизии ${snap?.revision} ≥ ${rev}`);
    assert.equal(snap.shapes.find((x) => x.id === inst.id).fill, FILL, `экземпляр ${inst.id}: новая заливка в итоговом снимке`);
    for (const p of doc.plainInstancesOn(S.id, X)) assert.equal(snap.shapes.find((x) => x.id === p.id).fill, FILL, `старый цвет не вернулся у ${p.id}`);
    for (const o of doc.overriddenInstancesOn(S.id, X)) assert.equal(snap.shapes.find((x) => x.id === o.id).fill, o.fill, `переопределённый ${o.id} сохранён`);
    assert.equal(info.drawn.pageId, X);
    assert.ok(info.drawn.revision >= rev, `холст на ревизии ${info.drawn.revision} ≥ ${rev}`);
    assertNoRegression(rep, rev, FILL, OLD, X);
    const errs = await eventsOf(s.page, 'error');
    assert.deepEqual(errs, [], `события error: ${JSON.stringify(errs)}`);

    return {
      summary:
        `${cfg.mode} (Z): запрос страницы ${X} сделан за ${sentAtNode - requestedAtNode} мс ДО команды; ` +
        `команда (HTTP, второй участник) завершилась через ${cmdDoneNode - requestedAtNode} мс, ` +
        `а данные ${X} доставлены через ${deliveredNode - requestedAtNode} мс — на ${deliveredNode - cmdDoneNode} мс ПОЗЖЕ команды ` +
        `(задержка трансформации synced query ${Z_DELAY_MS} мс, правило #${rule.id}, срабатываний ${hits ?? '?'}; ` +
        `страниц загружено к моменту команды: ${loadedAtCommand.length}); ` +
        `готовность ${X}: ${readyAll.map((e) => `rev=${e.detail.revision}`).join(',')}` +
        `${readyBeforeCommandKnown.length ? ' (готовность наступила на прежней ревизии — клиент ещё не знал о чужой команде; итог сошёлся)' : ''}; ` +
        `итог ${X} rev=${snap.revision}, ${inst.id}=${FILL}; зонд ${rep.ticks} опросов, без отката`,
      mechanism: `задержка POST /api/zero/query (ZERO_QUERY_URL, ${zeroApi.base}) на ${Z_DELAY_MS} мс, окно ${Z_WINDOW_MS} мс; команда подана оболочкой по HTTP`,
      page: X,
      instance: inst.id,
      command: { ...cmdBody, revision: rev, affectedPages: res.body.affectedPages, affectedShapes: res.body.affectedShapes },
      timings: {
        requestedAtNode,
        commandSentAtNode: sentAtNode,
        commandDoneAtNode: cmdDoneNode,
        deliveredAtNode: deliveredNode,
        lateByMs: deliveredNode - cmdDoneNode,
        pageReadyAtPage: readyEv.t,
        pageReadyRevisions: readyAll.map((e) => e.detail.revision),
      },
      ruleHits: hits,
      loadedAtCommand,
      probeRecords: rep.records,
    };
  } finally {
    await zeroApi.clearDelays().catch(() => undefined);
  }
}

/** Ожидание page-ready уже активной страницы (событие могло уже случиться). */
function waitReady(page, pageId, timeoutMs = 30_000) {
  return page.evaluate(
    ({ id, timeout }) => /** @type {any} */ (window).__stand.waitFor('page-ready', (e) => e.detail.pageId === id, timeout, 0),
    { id: pageId, timeout: timeoutMs },
  );
}

/** Итоговое состояние X — послекомандное (снимок, холст, все непереопределённые экземпляры). */
function assertFinalState({ drawnEv, snap, info, rev, X, S, inst, FILL, doc }) {
  assert.ok(drawnEv.detail.drawnRevision >= rev, 'command-drawn на ревизии ≥ подтверждённой');
  assert.ok(snap && snap.revision >= rev, `итоговый снимок ${X} на ревизии ${snap?.revision} ≥ ${rev}`);
  const sh = snap.shapes.find((x) => x.id === inst.id);
  assert.equal(sh.fill, FILL, `экземпляр ${inst.id}: новая заливка в итоговом снимке`);
  for (const p of doc.plainInstancesOn(S.id, X)) assert.equal(snap.shapes.find((x) => x.id === p.id).fill, FILL, `старый цвет не вернулся у ${p.id}`);
  for (const o of doc.overriddenInstancesOn(S.id, X)) assert.equal(snap.shapes.find((x) => x.id === o.id).fill, o.fill, `переопределённый ${o.id} сохранён`);
  assert.equal(info.drawn.pageId, X);
  assert.ok(info.drawn.revision >= rev, `холст на ревизии ${info.drawn.revision} ≥ ${rev}`);
}

/** Зонд: после первого актуального кадра — ни отката ревизии, ни старого цвета. */
function assertNoRegression(rep, rev, FILL, OLD, X) {
  const goodIdx = rep.records.findIndex((r) => r.revision !== null && r.revision >= rev && r.fill === FILL);
  assert.ok(goodIdx >= 0, `зонд видел актуальный снимок ${X} (rev ≥ ${rev}, ${FILL}): ${JSON.stringify(rep.records.slice(-5))}`);
  const regress = rep.records.slice(goodIdx + 1).filter((r) => r.size !== null && (r.revision < rev || r.fill === OLD));
  assert.equal(regress.length, 0, `откат к устаревшему снимку после актуального: ${JSON.stringify(regress.slice(0, 5))}`);
}

async function stopProbe(pg, X, ctx) {
  await probe.stop(pg, X);
  const rep = await probe.report(pg, X);
  ctx.partial.probe = rep;
  return rep;
}

const page = (s) => s.page;
