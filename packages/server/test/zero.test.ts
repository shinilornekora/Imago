/**
 * Проверки Zero-интеграции (SPEC §2.4) против реальной PostgreSQL:
 *  1) серверный мутатор `serverFillImpl` над транзакцией postgres.js — та же предметная логика, что у HTTP
 *     (права, идемпотентность по opId, expectedRevision, revision+1, запись в operations), ошибки → ApplicationError;
 *  2) `POST /api/zero/query` — 401 без токена; трансформация synced query с проверкой владельца (чужой → forbidden);
 *  3) `POST /api/zero/mutate` — полный push через PushProcessor; требует схемы zero-cache (`<app>_0.clients`),
 *     иначе пропускается (zero-cache создаёт её при первом запуске: scripts/start-zero.sh).
 * Свой маленький документ doc-ztest (не зависит от генератора).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { isApplicationError } from '@rocicorp/zero/server';
import { buildApp, type StandApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { beginReadWrite, createSql, type Sql } from '../src/db/sql.js';
import { serverFillImpl } from '../src/zero/mutators.js';
import type { FillArgs } from '../src/zero/schema.js';

const DOC = 'doc-ztest';
const P1 = `${DOC}-p1`;
const LIB = `${DOC}-p2`;
const SRC = `${DOC}-src`;
const APP_ID = process.env.STAND_ZERO_APP_ID ?? 'stand';

let sql: Sql;
let stand: StandApp;
let base = '';
let alice = '';
let bob = '';

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM operations WHERE document_id = ${DOC}`;
    await tx`DELETE FROM shapes_baseline WHERE document_id = ${DOC}`;
    await tx`DELETE FROM documents WHERE id = ${DOC}`;
    await tx`INSERT INTO documents (id, owner_id, name, revision) VALUES (${DOC}, 'u-alice', 'ztest', 0)`;
    await tx`INSERT INTO pages (id, document_id, "index", name) VALUES (${P1}, ${DOC}, 1, 'Page 1'), (${LIB}, ${DOC}, 2, 'library')`;
    const rows = [
      { id: SRC, page_id: LIB, is_source: true, source_id: null, fill: '#111111', fill_overridden: false, z: 0 },
      { id: `${DOC}-i1`, page_id: P1, is_source: false, source_id: SRC, fill: '#111111', fill_overridden: false, z: 1 },
      { id: `${DOC}-i2`, page_id: P1, is_source: false, source_id: SRC, fill: '#abcdef', fill_overridden: true, z: 0 },
      { id: `${DOC}-i3`, page_id: LIB, is_source: false, source_id: SRC, fill: '#111111', fill_overridden: false, z: 1 },
      { id: `${DOC}-plain`, page_id: P1, is_source: false, source_id: null, fill: '#222222', fill_overridden: false, z: 2 },
    ].map((r) => ({ ...r, document_id: DOC, kind: 'rect', x: 1, y: 2, w: 3, h: 4, text: null }));
    await tx`INSERT INTO shapes ${tx(rows, 'id', 'document_id', 'page_id', 'kind', 'x', 'y', 'w', 'h', 'z', 'text', 'fill', 'is_source', 'source_id', 'fill_overridden')}`;
  });
}

/** Вызов серверной реализации мутатора так, как её вызывает PushProcessor: внутри sql.begin(...). */
function runMutator(type: 'setSourceFill' | 'setLocalFill', args: FillArgs, userID: string): Promise<void> {
  return beginReadWrite(sql, (tx) =>
    serverFillImpl(type, { location: 'server', reason: 'authoritative', dbTransaction: { wrappedTransaction: tx } } as never, args, { userID }),
  );
}

async function expectAppError(p: Promise<unknown>, code: string, status: number): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    assert.ok(isApplicationError(err), `expected ApplicationError, got ${String(err)}`);
    const details = err.details as Record<string, unknown>;
    assert.equal(err.message, code);
    assert.equal(details.code, code);
    assert.equal(details.status, status);
    return details;
  }
  assert.fail(`expected ApplicationError ${code}`);
}

const fill = (over: Partial<FillArgs> = {}): FillArgs => ({
  opId: randomUUID(),
  documentId: DOC,
  targetId: SRC,
  fill: '#ff0000',
  expectedRevision: 0,
  ...over,
});

async function api<T>(path: string, token: string | null, body: unknown, query = ''): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function login(user: string, pass: string): Promise<string> {
  const r = await api<{ token: string }>('/api/auth/login', null, { login: user, password: pass });
  assert.equal(r.status, 200);
  return r.body.token;
}

before(async () => {
  sql = createSql(process.env.STAND_DB_URL || 'postgres://postgres:postgres@127.0.0.1:5432/editor', { max: 4, applicationName: 'stand-ztest' });
  await migrate(sql);
  await seed();
  stand = await buildApp({ sql, config: { testHooks: false, logLevel: 'warn', clientDist: '/nonexistent-client-dist' }, operationsCleanup: false });
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
  await sql`DELETE FROM operations WHERE document_id = ${DOC}`;
  await sql.end({ timeout: 5 });
});

describe('zero: серверный мутатор над транзакцией postgres.js', () => {
  it('setSourceFill: источник + непереопределённые экземпляры, revision+1, запись в operations', async () => {
    await seed();
    const args = fill();
    await runMutator('setSourceFill', args, 'u-alice');
    const shapes = await sql<{ id: string; fill: string; fill_overridden: boolean }[]>`SELECT id, fill, fill_overridden FROM shapes WHERE document_id = ${DOC} ORDER BY id`;
    const byId = new Map(shapes.map((s) => [s.id, s]));
    assert.equal(byId.get(SRC)?.fill, '#ff0000');
    assert.equal(byId.get(`${DOC}-i1`)?.fill, '#ff0000');
    assert.equal(byId.get(`${DOC}-i3`)?.fill, '#ff0000');
    assert.equal(byId.get(`${DOC}-i2`)?.fill, '#abcdef', 'переопределённый не меняется');
    assert.equal(byId.get(`${DOC}-plain`)?.fill, '#222222');
    const [doc] = await sql<{ revision: number }[]>`SELECT revision FROM documents WHERE id = ${DOC}`;
    assert.equal(doc?.revision, 1);
    const [op] = await sql<{ result: { revision: number; affectedPages: string[]; affectedShapes: number } }[]>`SELECT result FROM operations WHERE op_id = ${args.opId}`;
    assert.ok(op);
    assert.equal(op.result.revision, 1);
    assert.deepEqual(op.result.affectedPages, [P1, LIB]);
    assert.equal(op.result.affectedShapes, 3);
    // тот же результат доступен по HTTP — GET /api/operations/:opId (его читает клиент Z для command-acked)
    const res = await fetch(`${base}/api/operations/${args.opId}`, { headers: { authorization: `Bearer ${alice}` } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).result, op.result);
  });

  it('идемпотентность: тот же opId и параметры — без второго изменения; другие параметры — op_conflict', async () => {
    await seed();
    const args = fill();
    await runMutator('setSourceFill', args, 'u-alice');
    await runMutator('setSourceFill', args, 'u-alice'); // повтор — тот же результат, ревизия не растёт
    const [doc] = await sql<{ revision: number }[]>`SELECT revision FROM documents WHERE id = ${DOC}`;
    assert.equal(doc?.revision, 1);
    assert.equal((await sql`SELECT 1 FROM operations WHERE op_id = ${args.opId}`).length, 1);
    await expectAppError(runMutator('setSourceFill', { ...args, fill: '#00ff00' }, 'u-alice'), 'op_conflict', 409);
  });

  it('revision_mismatch: details.currentRevision; откат — без записи в operations', async () => {
    await seed();
    await runMutator('setSourceFill', fill(), 'u-alice');
    const stale = fill({ expectedRevision: 0, fill: '#00ff00' });
    const details = await expectAppError(runMutator('setSourceFill', stale, 'u-alice'), 'revision_mismatch', 409);
    assert.equal(details.currentRevision, 1);
    assert.equal((await sql`SELECT 1 FROM operations WHERE op_id = ${stale.opId}`).length, 0);
    const [s] = await sql<{ fill: string }[]>`SELECT fill FROM shapes WHERE id = ${SRC}`;
    assert.equal(s?.fill, '#ff0000');
  });

  it('права: чужой пользователь → forbidden (403); неизвестный документ → not_found', async () => {
    await seed();
    await expectAppError(runMutator('setSourceFill', fill(), 'u-bob'), 'forbidden', 403);
    await expectAppError(runMutator('setSourceFill', fill({ documentId: 'doc-nope' }), 'u-alice'), 'not_found', 404);
    await expectAppError(runMutator('setLocalFill', fill({ targetId: SRC }), 'u-alice'), 'bad_request', 400);
  });

  it('setLocalFill: fill + fill_overridden, affectedPages = [страница]', async () => {
    await seed();
    const args = fill({ targetId: `${DOC}-i1`, fill: '#123456' });
    await runMutator('setLocalFill', args, 'u-alice');
    const [s] = await sql<{ fill: string; fill_overridden: boolean }[]>`SELECT fill, fill_overridden FROM shapes WHERE id = ${args.targetId}`;
    assert.equal(s?.fill, '#123456');
    assert.equal(s?.fill_overridden, true);
    const [op] = await sql<{ result: { affectedPages: string[]; affectedShapes: number } }[]>`SELECT result FROM operations WHERE op_id = ${args.opId}`;
    assert.deepEqual(op?.result.affectedPages, [P1]);
    assert.equal(op?.result.affectedShapes, 1);
  });
});

describe('zero: POST /api/zero/query (synced queries)', () => {
  const body = (name: string, args: unknown) => ['transform', [{ id: 'q1', name, args: [args] }]];
  const qs = `?schema=${APP_ID}_0&appID=${APP_ID}`;

  it('без токена → 401', async () => {
    const r = await api<{ error: string }>('/api/zero/query', null, body('shapesByPage', { documentId: DOC, pageId: P1 }), qs);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  });

  it('свой документ → AST без join, с фильтрами document_id/page_id; userID в ответе', async () => {
    const r = await api<{ kind: string; userID: string; queries: Array<{ id: string; name: string; ast?: unknown; error?: string }> }>(
      '/api/zero/query', alice, body('shapesByPage', { documentId: DOC, pageId: P1 }), qs);
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'QueryResponse');
    assert.equal(r.body.userID, 'u-alice');
    const q = r.body.queries[0];
    assert.ok(q && q.ast, `ast expected, got ${JSON.stringify(q)}`);
    const ast = JSON.stringify(q.ast);
    assert.match(ast, /"table":"shapes"/);
    assert.match(ast, /"document_id"/);
    assert.match(ast, /"page_id"/);
    assert.doesNotMatch(ast, /"exists"|correlatedSubquery/i, 'без подзапроса по владельцу');
  });

  it('чужой документ → ошибка запроса forbidden (строк не будет); несуществующий → not_found', async () => {
    const r = await api<{ queries: Array<{ error?: string; message?: string; details?: { code: string; status: number } }> }>(
      '/api/zero/query', bob, body('shapesByPage', { documentId: DOC, pageId: P1 }), qs);
    assert.equal(r.status, 200);
    const q = r.body.queries[0];
    assert.equal(q?.error, 'app');
    assert.equal(q?.details?.code, 'forbidden');
    assert.equal(q?.details?.status, 403);
    const r2 = await api<{ queries: Array<{ details?: { code: string } }> }>('/api/zero/query', alice, body('docMeta', { documentId: 'doc-nope' }), qs);
    assert.equal(r2.body.queries[0]?.details?.code, 'not_found');
  });
});

describe('zero: POST /api/zero/mutate (push через PushProcessor)', () => {
  const qs = `?schema=${APP_ID}_0&appID=${APP_ID}`;
  let hasZeroSchema = false;
  before(async () => {
    const rows = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = ${`${APP_ID}_0`} AND table_name = 'clients'`;
    hasZeroSchema = rows.length > 0;
  });

  const push = (clientID: string, id: number, args: FillArgs, name = 'setSourceFill') => ({
    clientGroupID: `cg-ztest-${clientID}`,
    mutations: [{ type: 'custom', id, clientID, name, args: [args], timestamp: Date.now() }],
    pushVersion: 1,
    timestamp: Date.now(),
    requestID: randomUUID(),
  });

  it('без токена → 401', async () => {
    const r = await api<{ error: string }>('/api/zero/mutate', null, push('c0', 1, fill()), qs);
    assert.equal(r.status, 401);
  });

  it('успех: мутация применена в одной транзакции с учётом lastMutationID; ошибка домена — как app error', async (t) => {
    if (!hasZeroSchema) {
      t.skip(`нет схемы ${APP_ID}_0 (zero-cache не инициализировал upstream) — запустите scripts/start-zero.sh`);
      return;
    }
    await seed();
    const clientID = `zt${randomUUID().slice(0, 8)}`;
    const args = fill();
    const r = await api<{ kind: string; userID: string; mutations: Array<{ id: { id: number; clientID: string }; result: Record<string, unknown> }> }>(
      '/api/zero/mutate', alice, push(clientID, 1, args), qs);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'MutateResponse');
    assert.equal(r.body.userID, 'u-alice');
    assert.deepEqual(r.body.mutations[0]?.result, {});
    const [doc] = await sql<{ revision: number }[]>`SELECT revision FROM documents WHERE id = ${DOC}`;
    assert.equal(doc?.revision, 1);
    const [lm] = await sql<{ lastMutationID: string | number }[]>`SELECT "lastMutationID" FROM ${sql(`${APP_ID}_0`)}.clients WHERE "clientID" = ${clientID}`;
    assert.equal(Number(lm?.lastMutationID), 1);
    // вторая мутация того же клиента с устаревшей ревизией → app error revision_mismatch, ревизия не меняется
    const r2 = await api<{ mutations: Array<{ result: { error?: string; message?: string; details?: { code: string; currentRevision: number } } }> }>(
      '/api/zero/mutate', alice, push(clientID, 2, fill({ fill: '#00ff00' })), qs);
    assert.equal(r2.status, 200);
    const res2 = r2.body.mutations[0]?.result;
    assert.equal(res2?.error, 'app');
    assert.equal(res2?.details?.code, 'revision_mismatch');
    assert.equal(res2?.details?.currentRevision, 1);
    // мутация с тем же id уже обработана → alreadyProcessed, изменений нет
    const r3 = await api<{ mutations: Array<{ result: { error?: string } }> }>('/api/zero/mutate', alice, push(clientID, 1, args), qs);
    assert.equal(r3.body.mutations[0]?.result.error, 'alreadyProcessed');
    // чужой пользователь (bob) → forbidden
    const r4 = await api<{ mutations: Array<{ result: { error?: string; details?: { code: string } } }> }>(
      '/api/zero/mutate', bob, push(`zb${randomUUID().slice(0, 8)}`, 1, fill({ expectedRevision: 1 })), qs);
    assert.equal(r4.body.mutations[0]?.result.details?.code, 'forbidden');
    const [doc2] = await sql<{ revision: number }[]>`SELECT revision FROM documents WHERE id = ${DOC}`;
    assert.equal(doc2?.revision, 1);
    // уборка служебных строк zero-cache этого теста
    await sql`DELETE FROM ${sql(`${APP_ID}_0`)}.mutations WHERE "clientGroupID" LIKE 'cg-ztest-%'`.catch(() => undefined);
    await sql`DELETE FROM ${sql(`${APP_ID}_0`)}.clients WHERE "clientGroupID" LIKE 'cg-ztest-%'`.catch(() => undefined);
  });
});
