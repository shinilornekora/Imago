/**
 * Круг 31 — Document service: база, восстановленная из копии до миграций 009/010 под
 * работающим экземпляром (сверка схемы, повтор запроса, /api/health 503 `storage:'schema'`),
 * числовые параметры запросов — 400 до SQL, метаданные без управляющих и bidi-символов,
 * исключение обработчика сообщения сокета не роняет процесс, части большой отмены
 * (`undo_part`, общий `undo_of`).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { createDoc, uid, ENGINE_VERSION } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createReader } from '../../server/document/dslr.js';
import { createSequencer } from '../../server/document/dslts.js';
import { createHub } from '../../server/document/hub.js';
import { createRequestHandler } from '../../server/document/http.js';
import { cleanMeta } from '../../server/document/limits.js';
import { backends, startFor, api, connect, wsUrl, waitFor, pgAvailable, pgStorage, DB_URL, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

const list = await backends();
const pgOk = await pgAvailable();

/** Схема «как в копии до 009/010» (круг 32 — и до 011): колонок и учёта миграций нет (триггер 009 — тоже). */
const DRIFT = `DROP TRIGGER IF EXISTS operations_size ON operations;
  ALTER TABLE operations DROP COLUMN IF EXISTS command_author, DROP COLUMN IF EXISTS ops_bytes, DROP COLUMN IF EXISTS ops_count, DROP COLUMN IF EXISTS undo_part;
  DELETE FROM schema_migrations WHERE name IN ('009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql')`;
const COLS_SQL = `SELECT string_agg(attname, ',' ORDER BY attname) AS c FROM pg_attribute
  WHERE attrelid = 'operations'::regclass AND attnum > 0 AND NOT attisdropped AND attname IN ('ops_bytes', 'ops_count', 'command_author', 'undo_part')`;
const ALL_COLS = 'command_author,ops_bytes,ops_count,undo_part';

describe('круг 31: база из копии до миграций 009/010 под работающим экземпляром · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  before(async () => { admin = new pg.Pool({ connectionString: DB_URL, max: 3 }); });
  after(async () => { await admin.end(); });
  const cols = async () => (await admin.query(COLS_SQL)).rows[0].c || '';

  it('commitTx, txsAfter, recentTxMeta, open — каждый после отката схемы проходит, колонки возвращаются', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    try {
      const s = svc.storage;
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'до обновления' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      let seq = 0;
      const set = (v, extra) => tx(seq, [{ op: 'set', id: root, path: 'name', value: v }], extra);
      const commit = async (v, extra) => {
        const r = await h.post(`/api/projects/${p.id}/tx`, set(v, extra));
        assert.equal(r.status, 201, r.text);
        seq = r.body.seq;
        return r.body;
      };
      await commit('a', { author_kind: 'agent', command_author: 'Аня' });
      assert.equal(await cols(), ALL_COLS);

      const steps = {
        commitTx: async () => {
          const c = await commit('b', { author_kind: 'agent', command_author: 'Борис', undo_of: 'tx_x', undo_part: { i: 0, n: 2 } });
          assert.equal(c.seq, seq);
        },
        txsAfter: async () => {
          const r = await h.get(`/api/projects/${p.id}/ops?since=0`);
          assert.equal(r.status, 200, r.text);
          assert.equal(r.body.txs.length, seq);
        },
        recentTxMeta: async () => {
          const r = await h.get(`/api/projects/${p.id}/history`);
          assert.equal(r.status, 200, r.text);
          assert.equal(r.body.items.length, seq);
          assert.ok(r.body.items.every((it) => it.ops_count === 1), 'ops_count — из jsonb, пока колонки нет');
        },
        open: async () => {
          const r = await h.get(`/api/projects/${p.id}`);
          assert.equal(r.status, 200, r.text);
          assert.equal(r.body.snapshot.doc.nodes[root].name !== undefined, true);
        }
      };
      for (const [name, step] of Object.entries(steps)) {
        await admin.query(DRIFT);
        assert.equal(await cols(), '', `${name}: схема откачена`);
        await step();
        await waitFor(async () => (await cols()) === ALL_COLS && s.schemaState === null && s.backfillState === null, `${name}: колонки вернулись`, 10000);
        assert.deepEqual(s.schemaFlags, { opsSize: true, commandAuthor: true, undoPart: true, createId: true, createHash: true });
        const applied = (await admin.query(`SELECT name FROM schema_migrations WHERE name IN ('009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql') ORDER BY name`)).rows.map((r) => r.name);
        assert.deepEqual(applied, ['009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql'], `${name}: учёт миграций догнан`);
      }
      // после сверки имя автора команды снова пишется, вес — заполнен у всех записей (009 дозаполнила)
      const c = await commit('c', { author_kind: 'agent', command_author: 'Вера' });
      assert.equal(c.command_author, 'Вера');
      const nulls = (await admin.query('SELECT count(*)::int AS n FROM operations WHERE project_id = $1 AND (ops_bytes IS NULL OR ops_count IS NULL)', [p.id])).rows[0].n;
      assert.equal(nulls, 0);
      const health = await h.get('/api/health');
      assert.equal(health.status, 200, health.text);
    } finally {
      await svc.close();
    }
  });

  it('пока миграции не догнаны (замок занят) — /api/health 503 storage:schema, запросы идут; замок отпущен — 200', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    const holder = new pg.Client({ connectionString: DB_URL });
    await holder.connect();
    try {
      const s = svc.storage;
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'замок' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      await admin.query(DRIFT);
      // другой экземпляр «мигрирует»: замок миграций занят
      await holder.query('SELECT pg_advisory_lock(728208)');
      const t0 = Date.now();
      const r = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }], { author_kind: 'agent', command_author: 'Аня' }));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.command_author, undefined, 'колонки ещё нет — без имени, без отказа');
      assert.ok(Date.now() - t0 < 5000, 'запрос не ждёт миграций дольше секунды-другой');
      const hist = await h.get(`/api/projects/${p.id}/history`);
      assert.equal(hist.status, 200, hist.text);

      const health = await h.get('/api/health');
      assert.equal(health.status, 503, health.text);
      assert.equal(health.body.code, 'unavailable');
      assert.equal(health.body.detail.storage, 'schema');
      assert.equal(health.body.detail.phase, 'migrate');
      assert.match(health.body.message, /схема базы/);
      assert.equal(await cols(), '');

      await holder.query('SELECT pg_advisory_unlock(728208)');
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'health 200 после миграций', 15000);
      assert.equal(await cols(), ALL_COLS);
      assert.equal(s.schemaState, null);
    } finally {
      await holder.end().catch(() => {});
      await svc.close();
    }
  });

  it('переподключение слушателя (восстановление рвёт соединения) — схема сверяется без единого упавшего запроса', async () => {
    const s = pgStorage({ listenRetryMs: 50 });
    await s.init();
    try {
      assert.equal(s.listening, true);
      await admin.query(DRIFT);
      const pid = s.listenerPid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await waitFor(async () => (await cols()) === ALL_COLS && s.schemaState === null && s.listenerPid && s.listenerPid !== pid, 'слушатель вернулся и миграции догнаны', 10000);
      assert.deepEqual(s.schemaFlags, { opsSize: true, commandAuthor: true, undoPart: true, createId: true, createHash: true });
    } finally {
      await s.close();
    }
  });
});

describe('круг 31: числовые параметры запросов — 400 с диапазоном до всякого SQL', () => {
  for (const b of list) {
    it(`history before/limit, ops since/limit, projects limit, lean since, сокет since, base_seq · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'числа' })).body;
        const MAX = String(Number.MAX_SAFE_INTEGER);
        const cases = [
          [`/api/projects/${p.id}/history?before=9999999999999999999999`, /^before: целое от 1 до 9007199254740991$/],
          [`/api/projects/${p.id}/history?before=0`, /^before: целое от 1 до/],
          [`/api/projects/${p.id}/history?before=-1`, /^before: целое от 1 до/],
          [`/api/projects/${p.id}/history?before=1e3`, /^before: целое/],
          [`/api/projects/${p.id}/history?before=0x10`, /^before: целое/],
          [`/api/projects/${p.id}/history?limit=201`, /^limit: целое от 1 до 200$/],
          [`/api/projects/${p.id}/history?limit=abc`, /^limit: целое/],
          [`/api/projects/${p.id}/ops?since=99999999999999999999`, /^since: целое от -1 до 9007199254740991$/],
          [`/api/projects/${p.id}/ops?since=0&limit=1e2`, /^limit: целое/],
          [`/api/projects/${p.id}?lean=1&since=1e400`, /^since: целое от 0 до/],
          ['/api/projects?limit=99999999999999999999999', /^limit: целое от 1 до 1000$/],
          [`/api/projects/${p.id}/traces?limit=9e99`, /^limit: целое/]
        ];
        for (const [path, re] of cases) {
          const r = await h.get(path);
          assert.equal(r.status, 400, `${path}: ${r.text}`);
          assert.match(r.body.message, re, path);
          assert.equal(r.body.detail && r.body.detail.sqlstate, undefined, `${path}: до SQL не дошло`);
        }
        // граница — годна
        assert.equal((await h.get(`/api/projects/${p.id}/history?before=${MAX}`)).status, 200);
        assert.equal((await h.get(`/api/projects/${p.id}/history?before=1`)).status, 200);
        // base_seq за пределом точного целого — 400 формы, не 22P02 базы
        const big = await h.post(`/api/projects/${p.id}/tx`, { tx_id: uid('tx'), base_seq: 1e22, ops: [], engine: E });
        assert.equal(big.status, 400, big.text);
        assert.match(big.body.message, /^base_seq: целое от 0 до/);
        // сокет: since=1e22 — отказ формы
        const c = connect(wsUrl(svc, p.id, { since: '9999999999999999999999' }));
        await c.opened;
        const m = await c.next();
        assert.equal(m.code, 'bad_request');
        assert.match(m.message, /^since: целое/);
        assert.equal((await c.closed).code, 4400);
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 31: метаданные — без управляющих и bidi-символов (содержимое документа не трогается)', () => {
  it('cleanMeta: BEL, RLO, LRI…PDI, C1, NUL, одиночный суррогат; \\t\\n — пробел; эмодзи с ZWJ цел', () => {
    assert.equal(cleanMeta('А\u0007ня‮'), 'Аня');
    assert.equal(cleanMeta('a⁦b⁩c‏d؜e\u0085f\u001bg'), 'abcdefg');
    assert.equal(cleanMeta('x\ty\nz\r'), 'x y z ');
    assert.equal(cleanMeta('a\u0000b\ud800'), 'ab�');
    assert.equal(cleanMeta('👨‍👩‍👧 Аня'), '👨‍👩‍👧 Аня');
    assert.equal(cleanMeta(5), 5);
  });

  for (const b of list) {
    it(`author, title, command_author, X-Author, имя проекта — в журнале, /history и списке чистые · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const created = (await h.post('/api/projects', { name: 'Про‮ект\u0007' })).body;
        assert.equal(created.name, 'Проект');
        const p = created;
        const open = (await h.get(`/api/projects/${p.id}`)).body;
        const root = open.snapshot.doc.root;
        const evilText = 'текст‮ узла\u0007';
        let r = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: evilText }], {
          author: 'Агент‮', author_kind: 'agent', title: 'Заголовок\u0007⁧x⁩\nвторая', command_author: '‮Аня\u0007'
        }));
        assert.equal(r.status, 201, r.text);
        assert.equal(r.body.author, 'Агент');
        assert.equal(r.body.title, 'Заголовокx вторая');
        assert.equal(r.body.command_author, 'Аня');
        // заголовок X-Author (percent-encoding UTF-8)
        r = await h.post(`/api/projects/${p.id}/tx`, tx(1, [{ op: 'set', id: root, path: 'name', value: 'b' }]), { 'x-author': encodeURIComponent('Бо‮рис\u0007') });
        assert.equal(r.status, 201, r.text);
        assert.equal(r.body.author, 'Борис');
        // только управляющие — поля нет
        r = await h.post(`/api/projects/${p.id}/tx`, tx(2, [], { author_kind: 'agent', command_author: '‮\u0007', title: '\u0007' }));
        assert.equal(r.body.command_author, undefined);
        assert.equal(r.body.title, undefined);

        const hist = (await h.get(`/api/projects/${p.id}/history`)).body.items;
        assert.deepEqual(hist.map((x) => x.author), [null, 'Борис', 'Агент']);
        assert.equal(hist[2].command_author, 'Аня');
        assert.equal(hist[2].title, 'Заголовокx вторая');
        // содержимое документа — как прислано (это данные, не подпись)
        const ops = (await h.get(`/api/projects/${p.id}/ops?since=0`)).body.txs;
        assert.equal(ops[0].ops[0].value, evilText);

        // переименование и список
        const ren = await h.patch(`/api/projects/${p.id}`, { name: '‮Новое\u0007 имя' });
        assert.equal(ren.status, 200, ren.text);
        assert.equal(ren.body.name, 'Новое имя');
        const listed = (await h.get('/api/projects')).body.projects.find((x) => x.id === p.id);
        assert.equal(listed.name, 'Новое имя');
      } finally {
        await svc.close();
      }
    });
  }

  it('/history и список чистят и записи, сделанные до круга 31 (прямо в хранилище) · memory', async () => {
    const svc = await startFor('memory');
    try {
      const h = api(svc.url);
      const s = svc.storage;
      const p = await s.createProject({ name: 'Ста‮рый', kind: 'design', doc: createDoc('empty'), engine: E });
      await s.commitTx(p.id, { ...tx(0, []), author: 'Ан\u0007я', author_kind: 'agent', title: 'Т‮итул', command_author: 'Бо‮рис' });
      const it0 = (await h.get(`/api/projects/${p.id}/history`)).body.items[0];
      assert.equal(it0.author, 'Аня');
      assert.equal(it0.title, 'Титул');
      assert.equal(it0.command_author, 'Борис');
      const listed = (await h.get('/api/projects')).body.projects.find((x) => x.id === p.id);
      assert.equal(listed.name, 'Старый');
    } finally {
      await svc.close();
    }
  });

  it('присутствие: имя автора без управляющих и bidi · memory', async () => {
    const svc = await startFor('memory');
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'п' })).body;
      const a = connect(wsUrl(svc, p.id, { client: 'ca', author: 'А‮ня\u0007' }));
      const b = connect(wsUrl(svc, p.id, { client: 'cb', author: 'Б' }));
      await a.opened;
      await b.opened;
      await a.until((m) => m.type === 'hello');
      await b.until((m) => m.type === 'hello');
      a.send({ type: 'presence', selection: [] });
      const pr = await b.until((m) => m.type === 'presence' && m.client === 'ca');
      assert.equal(pr.author, 'Аня');
      a.send({ type: 'presence', selection: [], author: 'В⁦ера⁩' });
      const pr2 = await b.until((m) => m.type === 'presence' && m.client === 'ca' && m.author !== 'Аня');
      assert.equal(pr2.author, 'Вера');
      await a.close();
      await b.close();
    } finally {
      await svc.close();
    }
  });
});

describe('круг 31: исключение обработчика сообщения сокета — в лог, ответ ошибкой, процесс и сокет живы', () => {
  it('send на сервере бросает посреди onMessage — warn «сообщение сокета», следующий кадр обслужен', async () => {
    const warns = [];
    const log = { info() {}, warn: (...a) => warns.push(a.map(String).join(' ')) };
    const storage = createMemoryStorage();
    const dslr = createReader({ storage });
    const dslts = createSequencer({ storage, verifyMs: 0, log: quiet });
    const server = http.createServer(createRequestHandler({ dslr, dslts, storage, log: quiet }));
    const hub = createHub({ server, dslr, dslts, pingInterval: 0, log });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const h = api(`http://127.0.0.1:${port}`);
      const p = (await h.post('/api/projects', { name: 'сокет' })).body;
      const c = connect(`ws://127.0.0.1:${port}/ws?project=${p.id}&client=c1`);
      await c.opened;
      await c.until((m) => m.type === 'hello');
      const srv = [...hub.wss.clients][0];
      assert.ok(srv, 'серверный сокет найден');
      const realSend = srv.send.bind(srv);
      let boom = 0;
      srv.send = (...a) => {
        if (boom++ < 2) throw new Error('сбой отправки (тест)');
        return realSend(...a);
      };
      c.send({ type: 'нечто' });   // неизвестный тип → send(error) → бросает внутри onMessage
      await waitFor(() => warns.some((w) => /\[document\/hub\] сообщение сокета:.*сбой отправки/s.test(w)), 'warn обработчика', 3000);
      assert.equal(boom, 2, 'и ответ об ошибке пробовали отправить (тоже бросил — проглочен)');
      // сокет жив: следующий кадр обслуживается как обычно
      c.send({ type: 'ещё' });
      const m = await c.until((x) => x.type === 'error');
      assert.equal(m.code, 'bad_request');
      assert.match(m.message, /неизвестный тип/);
      await sleep(50);
      assert.deepEqual(uncaught, [], 'необработанных исключений нет');
      await c.close();
    } finally {
      process.off('uncaughtException', onUncaught);
      // сокеты — обрывом: если обработчик всё же уронил разбор кадра (регрессия), мягкое
      // закрытие ждало бы ответа вечно, и файл тестов не завершался бы
      for (const w of hub.wss.clients) w.terminate();
      await Promise.race([hub.close(), sleep(2000)]);
      server.closeAllConnections();
      await Promise.race([new Promise((r) => server.close(() => r())), sleep(2000)]);
      await dslts.close();
    }
  });
});

describe('круг 31 (K1): части большой отмены — общий undo_of, undo_part — метаданные без ошибки', () => {
  for (const b of list) {
    it(`несколько транзакций с одним undo_of и undo_part {i, n} — все приняты; кривой undo_part не мешает · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'отмена' })).body;
        const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
        const first = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a' }]));
        assert.equal(first.status, 201);
        const undoOf = first.body.tx_id;
        const parts = [
          tx(1, [{ op: 'set', id: root, path: 'name', value: 'b' }], { undo_of: undoOf, undo_part: { i: 0, n: 3 } }),
          tx(2, [{ op: 'set', id: root, path: 'name', value: 'c' }], { undo_of: undoOf, undo_part: { i: 1, n: 3 } }),
          tx(3, [{ op: 'set', id: root, path: 'name', value: 'd' }], { undo_of: undoOf, undo_part: { toString: 1, i: 'x' } })
        ];
        for (const t of parts) {
          const r = await h.post(`/api/projects/${p.id}/tx`, t);
          assert.equal(r.status, 201, r.text);
          assert.equal(r.body.undo_of, undoOf);
        }
        // по сокету — тоже
        const c = connect(wsUrl(svc, p.id, { client: 'cu', proto: '2' }));
        await c.opened;
        await c.until((m) => m.type === 'hello');
        const t4 = tx(4, [{ op: 'set', id: root, path: 'name', value: 'e' }], { undo_of: undoOf, undo_part: { i: 2, n: 3 } });
        c.send({ type: 'tx', tx: t4 });
        const ack = await c.until((m) => (m.type === 'ack' || m.type === 'tx' || m.type === 'error') && (m.tx_id === t4.tx_id || (m.tx && m.tx.tx_id === t4.tx_id)));
        assert.notEqual(ack.type, 'error', JSON.stringify(ack));
        await c.close();
        const ops = (await h.get(`/api/projects/${p.id}/ops?since=1`)).body.txs;
        assert.deepEqual(ops.map((t) => t.undo_of), [undoOf, undoOf, undoOf, undoOf]);
        const hist = (await h.get(`/api/projects/${p.id}/history`)).body.items;
        assert.equal(hist.length, 5);
      } finally {
        await svc.close();
      }
    });
  }
});
