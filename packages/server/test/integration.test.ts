/**
 * Интеграционный тест против реальной PostgreSQL: поднимает приложение на случайном порту,
 * создаёт свой маленький документ (не зависит от генератора), гоняет HTTP-контракт (SPEC §2).
 * Требует мигрированную БД (STAND_DB_URL или по умолчанию 127.0.0.1:5432/editor).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { CommandResult, DocumentMeta, PageResponse } from '@stand/shared';
import { buildApp, type StandApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { createSql, type Sql } from '../src/db/sql.js';

const DOC = 'doc-itest';
const LIB = `${DOC}-p2`;
const P1 = `${DOC}-p1`;
const SRC = `${DOC}-src`;

let stand: StandApp;
let sql: Sql;
let base = '';
let alice = '';
let bob = '';

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM shapes_baseline WHERE document_id = ${DOC}`;
    await tx`DELETE FROM operations WHERE document_id = ${DOC}`;
    await tx`DELETE FROM documents WHERE id = ${DOC}`;
    await tx`INSERT INTO documents (id, owner_id, name, revision) VALUES (${DOC}, 'u-alice', 'itest', 0)`;
    await tx`INSERT INTO pages (id, document_id, "index", name) VALUES (${P1}, ${DOC}, 1, 'Page 1'), (${LIB}, ${DOC}, 2, 'library')`;
    const rows = [
      { id: SRC, page_id: LIB, is_source: true, source_id: null, fill: '#111111', fill_overridden: false, z: 0 },
      { id: `${DOC}-i1`, page_id: P1, is_source: false, source_id: SRC, fill: '#111111', fill_overridden: false, z: 1 },
      { id: `${DOC}-i2`, page_id: P1, is_source: false, source_id: SRC, fill: '#abcdef', fill_overridden: true, z: 0 },
      { id: `${DOC}-i3`, page_id: LIB, is_source: false, source_id: SRC, fill: '#111111', fill_overridden: false, z: 1 },
      { id: `${DOC}-plain`, page_id: P1, is_source: false, source_id: null, fill: '#222222', fill_overridden: false, z: 2 },
    ].map((r) => ({ ...r, document_id: DOC, kind: 'rect', x: 1, y: 2, w: 3, h: 4, text: null }));
    await tx`INSERT INTO shapes ${tx(rows, 'id', 'document_id', 'page_id', 'kind', 'x', 'y', 'w', 'h', 'z', 'text', 'fill', 'is_source', 'source_id', 'fill_overridden')}`;
    await tx`INSERT INTO shapes_baseline (shape_id, document_id, fill, fill_overridden)
             SELECT id, document_id, fill, fill_overridden FROM shapes WHERE document_id = ${DOC}`;
  });
}

async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

async function login(user: string, pass: string): Promise<string> {
  const r = await api<{ token: string; userId: string; expiresIn: number }>('POST', '/api/auth/login', null, { login: user, password: pass });
  assert.equal(r.status, 200);
  assert.equal(r.body.expiresIn, 900);
  return r.body.token;
}

before(async () => {
  sql = createSql(process.env.STAND_DB_URL || 'postgres://postgres:postgres@127.0.0.1:5432/editor', { max: 4, applicationName: 'stand-itest' });
  await migrate(sql);
  await seed();
  stand = await buildApp({ sql, config: { testHooks: true, logLevel: 'warn', clientDist: '/nonexistent-client-dist' }, operationsCleanup: false });
  await stand.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = stand.app.server.address();
  assert.ok(addr && typeof addr === 'object');
  base = `http://127.0.0.1:${addr.port}`;
  alice = await login('alice', 'alice-pass');
  bob = await login('bob', 'bob-pass');
});

after(async () => {
  await stand.close();
  await sql`DELETE FROM documents WHERE id = ${DOC}`;
  await sql`DELETE FROM shapes_baseline WHERE document_id = ${DOC}`;
  await sql`DELETE FROM operations WHERE document_id = ${DOC}`;
  await sql.end({ timeout: 5 });
});

describe('auth', () => {
  it('login с неверным паролем → 401; без токена → 401; мусорный токен → 401', async () => {
    const r = await api('POST', '/api/auth/login', null, { login: 'alice', password: 'nope' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'unauthorized', message: 'invalid login or password' });
    assert.equal((await api('GET', '/api/documents', null)).status, 401);
    assert.equal((await api('GET', '/api/documents', 'garbage')).status, 401);
  });

  it('health без токена', async () => {
    const r = await api<{ status: string; db: string }>('GET', '/api/health', null);
    assert.equal(r.status, 200);
    assert.equal(r.body.db, 'ok');
  });
});

describe('чтение', () => {
  it('список документов содержит тестовый документ со счётчиками', async () => {
    const r = await api<Array<{ id: string; pageCount: number; shapeCount: number; revision: number }>>('GET', '/api/documents', alice);
    assert.equal(r.status, 200);
    const d = r.body.find((x) => x.id === DOC);
    assert.ok(d);
    assert.equal(d.pageCount, 2);
    assert.equal(d.shapeCount, 5);
  });

  it('метаданные документа: страницы по index', async () => {
    const r = await api<DocumentMeta>('GET', `/api/documents/${DOC}`, alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.pages.map((p) => [p.index, p.name]), [[1, 'Page 1'], [2, 'library']]);
  });

  it('страница: ревизия + фигуры, порядок z,id', async () => {
    const r = await api<PageResponse>('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 0);
    assert.deepEqual(r.body.shapes.map((s) => s.id), [`${DOC}-i2`, `${DOC}-i1`, `${DOC}-plain`]);
    const i2 = r.body.shapes[0]!;
    assert.equal(i2.fillOverridden, true);
    assert.equal(i2.sourceId, SRC);
    assert.equal(typeof i2.x, 'number');
    assert.equal(i2.text, null);
  });

  it('чужой документ → 403 (bob), несуществующий → 404, чужая страница → 403', async () => {
    assert.equal((await api('GET', `/api/documents/${DOC}`, bob)).status, 403);
    assert.equal((await api('GET', `/api/documents/${DOC}/pages/${P1}`, bob)).status, 403);
    assert.equal((await api('GET', `/api/documents/nope`, alice)).status, 404);
    assert.equal((await api('GET', `/api/documents/${DOC}/pages/nope`, alice)).status, 404);
  });
});

describe('команды', () => {
  const opId = 'itest-op-1';
  const body = { opId, type: 'setSourceFill', targetId: SRC, fill: '#ff0000', expectedRevision: 0 };

  it('setSourceFill: 200, revision 1, affectedPages, запись в operations', async () => {
    const r = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { opId, revision: 1, affectedPages: [P1, LIB].sort(), affectedShapes: 3 });
    const ops = await sql`SELECT op_id, document_id, result FROM operations WHERE op_id = ${opId}`;
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.document_id, DOC);
    assert.deepEqual(ops[0]!.result, r.body);
    const page = await api<PageResponse>('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    assert.equal(page.body.revision, 1);
    const fills = Object.fromEntries(page.body.shapes.map((s) => [s.id, s.fill]));
    assert.equal(fills[`${DOC}-i1`], '#ff0000');
    assert.equal(fills[`${DOC}-i2`], '#abcdef');
    assert.equal(fills[`${DOC}-plain`], '#222222');
  });

  it('повтор с тем же opId → тот же результат, ревизия не растёт, одна запись', async () => {
    const r = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, body);
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 1);
    assert.equal(r.headers.get('x-stand-replayed'), '1');
    const ops = await sql`SELECT count(*)::int AS n FROM operations WHERE document_id = ${DOC}`;
    assert.equal(ops[0]!.n, 1);
    const st = await api<{ status: string; result: CommandResult }>('GET', `/api/operations/${opId}`, alice);
    assert.equal(st.status, 200);
    assert.equal(st.body.status, 'done');
    assert.equal(st.body.result.revision, 1);
  });

  it('тот же opId с другими параметрами → 409 op_conflict', async () => {
    const r = await api<{ error: string }>('POST', `/api/documents/${DOC}/commands`, alice, { ...body, fill: '#00ff00' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'op_conflict');
  });

  it('устаревшая ревизия → 409 revision_mismatch с currentRevision', async () => {
    const r = await api<{ error: string; currentRevision: number }>('POST', `/api/documents/${DOC}/commands`, alice, { ...body, opId: 'itest-op-stale' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'revision_mismatch');
    assert.equal(r.body.currentRevision, 1);
  });

  it('setLocalFill: fillOverridden=true, страница фигуры', async () => {
    const r = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, {
      opId: 'itest-op-2', type: 'setLocalFill', targetId: `${DOC}-i1`, fill: '#0000ff', expectedRevision: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { opId: 'itest-op-2', revision: 2, affectedPages: [P1], affectedShapes: 1 });
    const rows = await sql`SELECT fill, fill_overridden FROM shapes WHERE id = ${`${DOC}-i1`}`;
    assert.deepEqual(rows[0], { fill: '#0000ff', fill_overridden: true });
  });

  it('bob: команда над чужим источником → 403; чужая операция → 403', async () => {
    const r = await api<{ error: string }>('POST', `/api/documents/${DOC}/commands`, bob, { ...body, opId: 'itest-bob' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'forbidden');
    assert.equal((await api('GET', `/api/operations/${opId}`, bob)).status, 403);
    assert.equal((await api('GET', `/api/operations/nope`, alice)).status, 404);
  });

  it('валидация: плохой цвет / лишнее поле / нет тела → 400 bad_request', async () => {
    let r = await api<{ error: string }>('POST', `/api/documents/${DOC}/commands`, alice, { ...body, fill: 'red' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_request');
    r = await api('POST', `/api/documents/${DOC}/commands`, alice, { ...body, extra: 1 });
    assert.equal(r.status, 400);
    r = await api('POST', `/api/documents/${DOC}/commands`, alice, { opId: 'x' });
    assert.equal(r.status, 400);
  });

  it('параллельные команды с одной expectedRevision: ровно одна проходит', async () => {
    const meta = await api<DocumentMeta>('GET', `/api/documents/${DOC}`, alice);
    const rev = meta.body.revision;
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        api<{ error?: string; revision?: number }>('POST', `/api/documents/${DOC}/commands`, alice, {
          opId: `itest-par-${i}`, type: 'setLocalFill', targetId: `${DOC}-plain`, fill: `#00000${i}`, expectedRevision: rev,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409 && r.body.error === 'revision_mismatch');
    assert.equal(ok.length, 1);
    assert.equal(conflicts.length, 3);
    assert.equal(ok[0]!.body.revision, rev + 1);
  });
});

describe('тестовые хуки', () => {
  it('delay задерживает подходящий GET, reset восстанавливает заливки и ревизию, clear-operations чистит журнал', async () => {
    const d = await api<{ id: number }>('POST', '/api/test/delay', null, { pathPattern: `/pages/${P1}$`, ms: 300, count: 1 });
    assert.equal(d.status, 200);
    const t0 = performance.now();
    await api('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    const dt = performance.now() - t0;
    assert.ok(dt >= 280, `delayed request took ${dt} ms`);
    const t1 = performance.now();
    await api('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    assert.ok(performance.now() - t1 < 250, 'second request must not be delayed (count=1)');

    const reset = await api<{ shapesRestored: number; revision: number; ms: number }>('POST', '/api/test/reset', null, { docId: DOC });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.revision, 0);
    assert.ok(reset.body.shapesRestored >= 3);
    const page = await api<PageResponse>('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    assert.equal(page.body.revision, 0);
    const i1 = page.body.shapes.find((s) => s.id === `${DOC}-i1`)!;
    assert.equal(i1.fill, '#111111');
    assert.equal(i1.fillOverridden, false);
    const ops = await sql`SELECT count(*)::int AS n FROM operations WHERE document_id = ${DOC}`;
    assert.equal(ops[0]!.n, 0);

    const unknown = await api('POST', '/api/test/reset', null, { docId: 'nope' });
    assert.equal(unknown.status, 404);
    const cleared = await api<{ deleted: number }>('POST', '/api/test/clear-operations', null, { docId: DOC });
    assert.equal(cleared.status, 200);
  });
});

// --- A14: кеширование ответов API -------------------------------------------------------------
// Методика §1.2/§1.8: каждое чтение страницы обязано быть реальным сетевым чтением. Без явного
// запрета отсутствие переиспользования держалось бы только на отсутствии валидаторов.
describe('кеширование (A14)', () => {
  it('все ответы /api/** несут cache-control: no-store и не несут валидаторов', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['GET', '/api/health', null],
      ['GET', '/api/documents', alice],
      ['GET', `/api/documents/${DOC}`, alice],
      ['GET', `/api/documents/${DOC}/pages/${P1}`, alice],
      ['GET', `/api/documents/${DOC}/pages/${LIB}`, alice],
      ['GET', '/api/documents/no-such-doc', alice], // 404 — заголовок обязан быть и на ошибке
      ['GET', `/api/documents/${DOC}`, null], // 401 от authenticate
      ['GET', '/api/no-such-route', null], // 404 от setNotFoundHandler
    ];
    for (const [method, path, token] of cases) {
      const r = await api<unknown>(method, path, token);
      assert.equal(r.headers.get('cache-control'), 'no-store', `${method} ${path} (${r.status})`);
      assert.equal(r.headers.get('etag'), null, `${method} ${path}: ETag сделал бы повторное чтение кешируемым`);
      assert.equal(r.headers.get('last-modified'), null, `${method} ${path}: Last-Modified даёт эвристическую свежесть`);
      assert.equal(r.headers.get('expires'), null, `${method} ${path}`);
    }
  });

  it('повторное чтение той же страницы отдаёт полное тело (нет 304 и пустого ответа)', async () => {
    const a = await api<PageResponse>('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    const b = await api<PageResponse>('GET', `/api/documents/${DOC}/pages/${P1}`, alice);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.body.shapes.length, a.body.shapes.length);
    assert.ok(b.body.shapes.length > 0);
  });
});

// --- B16: ключ идемпотентности не включает expectedRevision -------------------------------------
describe('идемпотентность по HTTP (B16)', () => {
  const opId = 'itest-op-b16';
  const cmdBody = { opId, type: 'setLocalFill' as const, targetId: `${DOC}-plain`, fill: '#0a0b0c' };

  it('повтор той же команды после сдвига ревизии → 200 с сохранённым результатом', async () => {
    const meta = await api<DocumentMeta>('GET', `/api/documents/${DOC}`, alice);
    const rev0 = meta.body.revision;
    const first = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, { ...cmdBody, expectedRevision: rev0 });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, rev0 + 1);
    // чужая (другая) команда двигает ревизию ещё раз
    const other = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, {
      opId: `${opId}-other`, type: 'setLocalFill', targetId: `${DOC}-i1`, fill: '#0d0e0f', expectedRevision: rev0 + 1,
    });
    assert.equal(other.status, 200);
    // клиент перечитал метаданные и повторил ПЕРВУЮ команду с новой ревизией — это повтор, не конфликт
    const retry = await api<CommandResult>('POST', `/api/documents/${DOC}/commands`, alice, { ...cmdBody, expectedRevision: rev0 + 2 });
    assert.equal(retry.status, 200, 'повтор логической команды не должен давать op_conflict');
    assert.equal(retry.headers.get('x-stand-replayed'), '1');
    assert.deepEqual(retry.body, first.body);
    const ops = await sql`SELECT count(*)::int AS n FROM operations WHERE op_id = ${opId}`;
    assert.equal(ops[0]!.n, 1);
    const doc = await api<DocumentMeta>('GET', `/api/documents/${DOC}`, alice);
    assert.equal(doc.body.revision, rev0 + 2, 'повтор не создаёт третьего изменения');
  });

  it('тот же opId с иным логическим параметром по-прежнему → 409 op_conflict', async () => {
    const meta = await api<DocumentMeta>('GET', `/api/documents/${DOC}`, alice);
    const r = await api<{ error: string }>('POST', `/api/documents/${DOC}/commands`, alice, {
      ...cmdBody, fill: '#010203', expectedRevision: meta.body.revision,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'op_conflict');
    const cleared = await api<{ deleted: number }>('POST', '/api/test/clear-operations', null, { docId: DOC });
    assert.equal(cleared.status, 200);
  });
});

describe('статика', () => {
  it('неизвестный не-API маршрут без клиентской сборки → 404 JSON', async () => {
    const r = await api<{ error: string }>('GET', '/some/spa/route', null);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });
});
