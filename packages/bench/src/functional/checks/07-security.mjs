// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Безопасность (SPEC §2.1, §6): чужой документ недоступен по HTTP и через клиент; выход очищает всё.
 *
 * Б1. Чужой документ: bob по HTTP → `GET /api/documents/<alice>` 403, чтение страницы 403, команда над
 *     источником alice 403 (ревизия и журнал документа не меняются), список документов bob без документа alice,
 *     без токена → 401, alice → документ bob 403. Через клиент (`?doc=<alice>&autologin=bob`) → `state:'error'`,
 *     событие `error{scope:'open'}`, ни одной страницы/фигуры в хранилище, ни одного ответа 200 на чужой документ.
 *     Контроль: bob открывает свой документ — готовность с полным числом фигур.
 * Б2. Выход: после работы (переходы, команда) `__stand.logout()` → `getRetained()` = {0,0}, `getLoadedPages()` = [],
 *     снимки null, `state:'idle'`, `localStorage`/`sessionStorage` пусты, `indexedDB.databases()` пуст, форма входа;
 *     токен исчез: `runCommand` отклоняется, после выхода нет ни одного запроса с Authorization, запрос
 *     `/api/documents` из страницы без токена → 401.
 * Б3 (только Z). Чужие данные не приходят синхронизацией:
 *     (1) endpoint synced queries `POST /api/zero/query` (его вызывает zero-cache) для bob отвергает
 *         `shapesByPage`/`docMeta` документа alice (`forbidden`) и трансформирует запрос его собственной
 *         страницы; без токена → 401;
 *     (2) через клиент (bob + doc alice) → error, в хранилище Zero 0 фигур;
 *     (3) ПРИНУДИТЕЛЬНАЯ РЕГИСТРАЦИЯ ЧУЖОГО ЗАПРОСА (ранее молча пропускалась, критик B п. 12): страница alice
 *         сначала открывается её владельцем, поэтому запрос `shapesByPage({alice, p1})` уже зарегистрирован в
 *         zero-cache (проверяется и кеш трансформаций по (name,args)). Затем клиент bob запускается с
 *         ПОДДЕЛАННЫМ ответом `GET /api/documents/<alice>` (route.fulfill в браузере) — единственной HTTP-проверкой
 *         прав на пути открытия. ZAdapter доходит до создания Zero и материализует `docMeta`+`shapesByPage`
 *         чужого документа НАСТОЯЩИМ токеном bob по WebSocket. Утверждается: за 6 с наблюдения ни одной строки
 *         (`retained.shapes==0`, реальные строки хранилища Zero 0, `getLoadedPages()==[]`, снимок `null`,
 *         `page-ready` не было) при доказанной попытке регистрации запроса;
 *     (4) дополнительно — прямой `zero.run(query,{type:'complete'})`, если клиент публикует реестр запросов.
 */
import assert from 'node:assert/strict';
import { freshColor } from '../lib/doc.mjs';
import { eventsOf, retainedSettled, runCommandExpectError, selectPage, runCommand, snapshot, standInfo, storageState } from '../lib/stand.mjs';

export const access = {
  id: 'S1-access',
  title: () => 'Б1. Безопасность: чужой документ (HTTP и клиент)',
  async run(ctx) {
    const { doc, api, db, bobDocId, bobDoc } = ctx;
    const S = doc.pickSource({ minPlainPages: 3 });
    const p1 = doc.pid(1);
    const bob = await api.login('bob');
    const alice = await api.login('alice');
    const revBefore = await db.revision(doc.docId);
    const opsBefore = (await db.operations(doc.docId)).length;

    /** @type {Record<string, number>} */
    const http = {};
    let r = await api.getDocument(bob.token, doc.docId);
    http.docAsBob = r.status;
    assert.equal(r.status, 403, `bob → GET документ alice: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, 'forbidden');
    r = await api.getPage(bob.token, doc.docId, p1);
    http.pageAsBob = r.status;
    assert.equal(r.status, 403, `bob → GET страница alice: ${r.status}`);
    r = await api.postCommand(bob.token, doc.docId, { opId: `sec-${Date.now()}-a`, type: 'setSourceFill', targetId: S.id, fill: freshColor(doc, 7), expectedRevision: revBefore });
    http.commandAsBob = r.status;
    assert.equal(r.status, 403, `bob → команда над источником alice: ${r.status} ${JSON.stringify(r.body)}`);
    r = await api.postCommand(bob.token, bobDocId, { opId: `sec-${Date.now()}-b`, type: 'setSourceFill', targetId: S.id, fill: freshColor(doc, 7), expectedRevision: 0 });
    http.commandCrossDoc = r.status;
    assert.ok([403, 404].includes(r.status), `bob → команда в своём документе над источником alice: ${r.status} (ожидалось 403/404)`);
    assert.equal(await db.revision(doc.docId), revBefore, 'ревизия документа alice не изменилась');
    assert.equal((await db.operations(doc.docId)).length, opsBefore, 'журнал операций документа alice не пополнился');
    assert.equal((await db.shape(S.id)).fill, S.fill, 'заливка источника alice не изменилась');
    r = await api.listDocuments(bob.token);
    assert.equal(r.status, 200);
    assert.ok(!r.body.some((d) => d.id === doc.docId), 'в списке bob нет документа alice');
    assert.ok(r.body.some((d) => d.id === bobDocId), 'в списке bob есть его документ');
    r = await api.getDocument(alice.token, bobDocId);
    http.bobDocAsAlice = r.status;
    assert.equal(r.status, 403, 'alice → документ bob: 403');
    r = await api.call('GET', `/api/documents/${doc.docId}`);
    http.noToken = r.status;
    assert.equal(r.status, 401, 'без токена → 401');
    r = await api.call('GET', `/api/documents/${doc.docId}/pages/${p1}`, { token: 'not-a-jwt' });
    http.badToken = r.status;
    assert.equal(r.status, 401, 'подделанный токен → 401');

    // клиент: bob открывает документ alice
    const sb = await ctx.open({ user: 'bob', docId: doc.docId, waitFor: 'error' });
    const infoB = await standInfo(sb.page);
    const errsB = await eventsOf(sb.page, 'error');
    ctx.partial.bobOnAlice = { infoB, errsB };
    assert.equal(infoB.state, 'error', 'клиент bob на документе alice: state=error');
    assert.ok(errsB.some((e) => e.detail.scope === 'open'), `событие error{scope:'open'}: ${JSON.stringify(errsB)}`);
    assert.deepEqual(infoB.loaded, [], 'ни одной загруженной страницы');
    assert.equal(infoB.retained.pages, 0);
    assert.equal(infoB.retained.shapes, 0);
    assert.ok(!infoB.drawn || infoB.drawn.shapeCount === 0, 'холст без фигур');
    assert.equal(await snapshot(sb.page, p1), null);
    assert.equal(await sb.page.getAttribute('[data-testid="state"]', 'data-state'), 'error');
    const okResponses = sb.requests.filter((q) => q.path.includes(`/api/documents/${doc.docId}`) && q.status === 200);
    assert.deepEqual(okResponses, [], `клиент bob получил 200 на документ alice: ${JSON.stringify(okResponses)}`);
    const forbidden = sb.requests.filter((q) => q.path.includes(`/api/documents/${doc.docId}`) && q.status === 403);
    assert.ok(forbidden.length >= 1, 'сервер ответил 403 клиенту bob');
    const readyB = await eventsOf(sb.page, 'page-ready');
    assert.equal(readyB.length, 0, 'page-ready не возникало');
    await sb.close();

    // контроль: bob открывает свой документ
    const sbOwn = await ctx.open({ user: 'bob', docId: bobDocId, waitFor: 'any' });
    const infoOwn = await standInfo(sbOwn.page);
    assert.equal(infoOwn.state, 'ready', `bob на своём документе: state=${infoOwn.state}`);
    const bobP1 = bobDoc ? bobDoc.pid(1) : infoOwn.activePageId;
    const expectedBob = bobDoc ? bobDoc.countOf(bobP1) : infoOwn.drawn.shapeCount;
    assert.equal(infoOwn.drawn.shapeCount, expectedBob, 'bob: первая страница отрисована полностью');
    if (bobDoc) assert.deepEqual((await snapshot(sbOwn.page, bobP1)).shapes.map((x) => x.id).sort(), bobDoc.idsOf(bobP1));
    await sbOwn.close();

    return {
      summary: `HTTP: документ ${http.docAsBob}, страница ${http.pageAsBob}, команда ${http.commandAsBob}, кросс-документ ${http.commandCrossDoc}, alice→bob ${http.bobDocAsAlice}, без токена ${http.noToken}; клиент bob на документе alice: state=error, 0 страниц, ${forbidden.length}×403; bob на своём: ready (${expectedBob} фигур)`,
      http,
      errorsBob: errsB.map((e) => e.detail),
    };
  },
};

export const logout = {
  id: 'S2-logout',
  title: () => 'Б2. Безопасность: выход (logout) очищает память и хранилища',
  async run(ctx) {
    const { doc, cfg } = ctx;
    const X = doc.pid(2);
    const shape = doc.plainShapeOn(X);
    const s = await ctx.open({ waitFor: 'ready' });
    const { page } = s;
    await selectPage(page, X);
    await selectPage(page, doc.pid(3));
    await selectPage(page, X);
    const c = await runCommand(page, { type: 'setLocalFill', targetId: shape.id, fill: freshColor(doc, 8) });
    assert.equal(c.state, 'ready');
    const beforeRetained = await retainedSettled(page, (x) => x.pages >= 1 && x.shapes >= 1);
    assert.ok(beforeRetained.pages >= 1 && beforeRetained.shapes >= 1, `до выхода в памяти есть данные (retained=${JSON.stringify(beforeRetained)})`);
    const storageBefore = await storageState(page);
    const authBefore = s.requests.filter((q) => q.hasAuth).length;
    assert.ok(authBefore >= 1, 'до выхода запросы шли с Authorization');

    const tLogout = Date.now();
    await page.evaluate(() => /** @type {any} */ (window).__stand.logout());
    const after = await standInfo(page);
    const storage = await storageState(page);
    ctx.partial.afterLogout = { after, storage };
    assert.equal(after.retained.pages, 0, 'getRetained().pages == 0');
    assert.equal(after.retained.shapes, 0, 'getRetained().shapes == 0');
    assert.equal(after.retained.bytesEstimate ?? 0, 0);
    assert.deepEqual(after.loaded, [], 'getLoadedPages() пуст');
    assert.equal(after.state, 'idle');
    assert.equal(after.activePageId, null);
    assert.equal(after.pendingCommands, 0);
    assert.equal(await snapshot(page, X), null, 'снимок после выхода — null');
    assert.equal(await snapshot(page, doc.pid(1)), null);
    assert.equal(storage.localStorage, 0, 'localStorage пуст');
    assert.equal(storage.sessionStorage, 0, 'sessionStorage пуст');
    assert.deepEqual(storage.indexedDb, [], `IndexedDB пуст: ${JSON.stringify(storage.indexedDb)}`);
    assert.equal((await eventsOf(page, 'logout')).length, 1, 'событие logout один раз');
    await page.waitForSelector('[data-testid="login-form"]', { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.cookie), '', 'cookie отсутствуют');

    // токен исчез: команда отклоняется, запросов с Authorization больше нет, прямой запрос без токена → 401
    const cmd = await runCommandExpectError(page, { type: 'setLocalFill', targetId: shape.id, fill: freshColor(doc, 9) });
    assert.equal(cmd.ok, false, 'runCommand после выхода отклонена');
    const direct = await page.evaluate(async () => {
      const r = await fetch('/api/documents', { credentials: 'include' });
      return r.status;
    });
    assert.equal(direct, 401, 'запрос из страницы без токена → 401 (ничего не сохранилось в cookie/storage)');
    await page.waitForTimeout(300);
    const authAfter = s.requests.filter((q) => q.hasAuth && q.t >= tLogout);
    assert.deepEqual(authAfter, [], `после выхода не должно быть запросов с Authorization: ${JSON.stringify(authAfter.map((q) => q.path))}`);
    const errs = (await eventsOf(page, 'error')).filter((e) => e.detail.scope === 'logout');
    assert.deepEqual(errs, [], `ошибки logout: ${JSON.stringify(errs)}`);

    return {
      summary: `до выхода retained=${beforeRetained.pages}/${beforeRetained.shapes}, IDB до: ${storageBefore.indexedDb.length}; после: retained 0/0, loaded [], state idle, storage 0/0, IDB [], форма входа; runCommand отклонена (${cmd.message}), запросов с токеном после выхода 0, прямой запрос 401${cfg.adapter === 'Z' ? ' (Z: IDB kvStore удалён)' : ''}`,
      storageBefore,
      storageAfter: storage,
      commandError: cmd.message,
    };
  },
};

export const zeroQuery = {
  id: 'S3-zero-query',
  title: () => 'Б3. Безопасность: Zero — чужие данные не приходят синхронизацией',
  applies: (cfg) => cfg.adapter === 'Z',
  naReason: (cfg) => `путь синхронизации Zero отсутствует у адаптера ${cfg.adapter}: чтение идёт по HTTP и покрыто проверкой Б1 (403/401)`,
  async run(ctx) {
    const { doc, api, bobDocId, bobDoc } = ctx;
    const p1 = doc.pid(1);
    const bob = await api.login('bob');
    const alice = await api.login('alice');
    // 1) endpoint synced queries (`POST /api/zero/query`, ZERO_QUERY_URL zero-cache): трансформация запроса bob
    //    на страницу alice обязана вернуть ошибку запроса (forbidden) — zero-cache тогда не отдаёт ни одной строки;
    //    запрос bob на свою страницу трансформируется в AST; без токена — 401.
    const bobP1 = bobDoc ? bobDoc.pid(1) : `${bobDocId}-p1`;
    const body = ['transform', [
      { id: 'q-alice', name: 'shapesByPage', args: [{ documentId: doc.docId, pageId: p1 }] },
      { id: 'q-alice-meta', name: 'docMeta', args: [{ documentId: doc.docId }] },
      { id: 'q-bob', name: 'shapesByPage', args: [{ documentId: bobDocId, pageId: bobP1 }] },
    ]];
    let r = await api.call('POST', '/api/zero/query', { token: bob.token, body });
    assert.equal(r.status, 200, `POST /api/zero/query как bob: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    const qs = r.body?.queries ?? [];
    const qa = qs.find((q) => q.id === 'q-alice');
    const qm = qs.find((q) => q.id === 'q-alice-meta');
    const qb = qs.find((q) => q.id === 'q-bob');
    assert.ok(qa && qa.error === 'app' && qa.details?.code === 'forbidden', `запрос bob на страницу alice должен быть отвергнут: ${JSON.stringify(qa)}`);
    assert.ok(qm && qm.error === 'app' && qm.details?.code === 'forbidden', `запрос bob на метаданные alice должен быть отвергнут: ${JSON.stringify(qm)}`);
    assert.ok(qb && qb.ast && !qb.error, `запрос bob на свою страницу трансформирован: ${JSON.stringify(qb).slice(0, 200)}`);
    assert.equal(r.body.userID, bob.userId);
    r = await api.call('POST', '/api/zero/query', { body });
    assert.equal(r.status, 401, 'zero/query без токена → 401');
    r = await api.call('POST', '/api/zero/query', { token: alice.token, body: ['transform', [{ id: 'q', name: 'shapesByPage', args: [{ documentId: doc.docId, pageId: p1 }] }]] });
    assert.equal(r.status, 200);
    assert.ok(r.body.queries?.[0]?.ast, 'alice получает AST своей страницы');
    // мутация bob над источником alice через push-endpoint Zero отклоняется предметным модулем (проверяется HTTP-командой в Б1)

    // 2) через клиент: bob + документ alice → error, в хранилище Zero ни одной фигуры
    const sb = await ctx.open({ user: 'bob', docId: doc.docId, waitFor: 'error' });
    const info = await standInfo(sb.page);
    assert.equal(info.state, 'error');
    const rb = await retainedSettled(sb.page, (x) => x.shapes === 0, 1000);
    assert.equal(rb.shapes, 0, 'в хранилище Zero нет чужих фигур');
    assert.equal(await snapshot(sb.page, p1), null);
    await sb.close();

    // 3) САМАЯ СИЛЬНАЯ часть: клиент bob ЗАСТАВЛЯЕТСЯ зарегистрировать synced query чужой страницы
    //    (тот же (name,args), что уже зарегистрирован клиентом alice — проверяется и кеш трансформаций
    //    zero-cache по (name,args)). Ответ `GET /api/documents/<alice>` подделывается в браузере, поэтому
    //    ZAdapter доходит до создания Zero и материализует docMeta+shapesByPage чужого документа НАСТОЯЩИМ
    //    токеном bob. Утверждается: ни одной строки чужого документа за время наблюдения.
    const sAlice = await ctx.open({ user: 'alice', docId: doc.docId, waitFor: 'ready' }); // регистрируем запрос от владельца
    const aliceSnap = await snapshot(sAlice.page, p1);
    assert.ok(aliceSnap && aliceSnap.shapes.length === doc.countOf(p1), 'контроль: alice получила свою страницу целиком');

    const fakeMeta = { id: doc.docId, name: doc.raw.document.name ?? doc.docId, revision: doc.revision, pages: doc.pages.map((p) => ({ id: p.id, index: p.index, name: p.name })) };
    const OBSERVE_MS = 6000;
    const sForce = await ctx.open({
      user: 'bob',
      docId: doc.docId,
      waitFor: 'none',
      expectErrors: true, // ошибки страницы здесь — ожидаемый исход, а не дефект
      beforeGoto: async (page) => {
        await page.route(`**/api/documents/${doc.docId}`, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeMeta) });
        });
      },
    });
    await sForce.page.waitForFunction(() => Boolean(/** @type {any} */ (window).__stand), null, { timeout: 15_000 });
    await sForce.page.waitForTimeout(OBSERVE_MS);
    const forced = await sForce.page.evaluate(async (pageId) => {
      const w = /** @type {any} */ (window);
      const st = w.__stand;
      const adapter = w.__standController?.adapter ?? null;
      let requested = [];
      try {
        requested = adapter?.pages instanceof Map ? [...adapter.pages.keys()] : [];
      } catch {
        requested = [];
      }
      let rows = -1;
      try {
        const z = typeof adapter?.getZero === 'function' ? adapter.getZero() : (adapter?.zero ?? null);
        const all = z?.inspector ? await z.inspector.client.rows('shapes') : null;
        rows = Array.isArray(all) ? all.length : -1;
      } catch {
        rows = -1;
      }
      return {
        state: st.state,
        retained: await st.getRetainedAsync(),
        loaded: st.getLoadedPages(),
        snapshot: st.getPageSnapshot(pageId),
        ready: st.events.filter((e) => e.type === 'page-ready').length,
        errors: st.events.filter((e) => e.type === 'error').map((e) => `${e.detail?.scope}: ${String(e.detail?.message ?? '').slice(0, 200)}`),
        zeroRows: rows,
        requestedPages: requested,
      };
    }, p1);
    ctx.partial.forcedForeignQuery = forced;
    await sForce.close();
    await sAlice.close();

    // доказательство, что запрос действительно ушёл (иначе «0 строк» ничего не значит)
    const attempted = forced.requestedPages.length > 0 || forced.errors.some((e) => /zero|query|forbidden/i.test(e));
    assert.ok(
      attempted,
      `клиент bob не дошёл до регистрации synced query чужой страницы (state=${forced.state}, errors=${JSON.stringify(forced.errors)}) — проверка не воспроизведена`,
    );
    assert.equal(forced.retained.shapes, 0, `bob удерживает ${forced.retained.shapes} фигур чужого документа (ожидалось 0)`);
    assert.deepEqual(forced.loaded, [], `bob получил страницы чужого документа: ${JSON.stringify(forced.loaded)}`);
    assert.equal(forced.snapshot, null, 'снимок чужой страницы у bob — null');
    assert.equal(forced.ready, 0, 'page-ready на чужом документе не возникало');
    assert.ok(forced.zeroRows <= 0, `в клиентском хранилище Zero у bob ${forced.zeroRows} строк shapes (ожидалось 0)`);
    const ok200 = sForce.requests.filter((q) => q.path.includes(`/api/documents/${doc.docId}/pages/`) && q.status === 200);
    assert.deepEqual(ok200, [], 'bob не получил ни одного HTTP-ответа 200 на страницы чужого документа');

    // 4) дополнительно: прямой synced query из клиента, если адаптер публикует реестр запросов
    const sOwn = await ctx.open({ user: 'bob', docId: bobDocId, waitFor: 'ready' });
    const res = await sOwn.page.evaluate(async (pageId) => {
      const w = /** @type {any} */ (window);
      const adapter = w.__standController?.adapter ?? null;
      const zero = (typeof adapter?.getZero === 'function' ? adapter.getZero() : adapter?.zero) ?? w.__zero ?? null;
      const queries = adapter?.queries ?? w.__zeroQueries ?? null;
      if (!zero || typeof zero.run !== 'function') return { available: false, reason: 'адаптер не публикует handle Zero (zero.run)' };
      const q = queries?.shapesByPage ?? null;
      if (!q) return { available: false, reason: 'реестр synced queries не опубликован клиентом (queries — модульный импорт)' };
      try {
        const rows = await zero.run(q({ documentId: pageId.documentId, pageId: pageId.pageId }), { type: 'complete' });
        return { available: true, rows: Array.isArray(rows) ? rows.length : -1 };
      } catch (e) {
        return { available: true, error: String(e) };
      }
    }, { documentId: doc.docId, pageId: p1 });
    await sOwn.close();
    let direct = `прямой zero.run из клиента недоступен (${res.reason ?? ''}) — покрыто пунктом 3 (принудительная регистрация запроса)`;
    if (res.available) {
      assert.equal(res.error, undefined, `ошибка synced query: ${res.error}`);
      assert.equal(res.rows, 0, `synced query страницы alice для bob вернул ${res.rows} строк (ожидалось 0, complete)`);
      direct = 'прямой synced query из клиента bob: 0 строк (complete)';
    }
    return {
      summary:
        `zero/query: bob → страница/метаданные alice = forbidden, своя страница = AST, без токена 401; ` +
        `клиент bob на документе alice: error, 0 фигур в хранилище; ` +
        `принудительная регистрация чужого запроса (подделан GET документа, запрос уже зарегистрирован alice): за ${OBSERVE_MS} мс ` +
        `0 строк, loaded=[], снимок null, ошибки клиента: ${forced.errors.slice(0, 2).join(' | ') || 'нет'}; ${direct}`,
      queries: qs,
      forced,
    };
  },
};

export default [access, logout, zeroQuery];
