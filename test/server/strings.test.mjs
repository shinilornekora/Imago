/**
 * Строки и форма транзакции (SPEC §9.10, круг 25): U+0000 и одиночные суррогатные
 * половины в значениях чистятся (раньше запись в jsonb падала, ответ был 503
 * retryable, и очередь клиента стояла вечно), в id — 400; поля операций, которые
 * читает движок, проверяются по типу (`parent: {"toString": 1}` давал 500);
 * `command_id` проходит в журнал. Память — всегда, Postgres — когда база доступна.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { artboards, ops, uid, ENGINE_VERSION } from '../../src/core.js';
import { cleanText, cutText, cleanDeep, isCleanText } from '../../server/document/limits.js';
import { validateTx } from '../../server/document/dslts.js';
import { backends, startFor, api, connect, wsUrl } from './helpers.mjs';

const E = ENGINE_VERSION;
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const NUL = '\u0000';
const HI = '\ud83d';   // одиночная старшая половина
const LO = '\ude00';   // одиночная младшая половина

describe('строки: очистка и обрезка (limits.js)', () => {
  it('cleanText: U+0000 — вон, одиночные половины — U+FFFD, пары не трогает', () => {
    assert.equal(cleanText('a' + NUL + 'b'), 'ab');
    assert.equal(cleanText('x' + HI + 'y'), 'x�y');
    assert.equal(cleanText(LO + 'z'), '�z');
    assert.equal(cleanText('ок 😀'), 'ок 😀');
    assert.equal(isCleanText('a' + NUL), false);
    assert.equal(isCleanText('😀'), true);
  });
  it('cutText: по кодовым точкам — пара не рвётся пополам', () => {
    const s = 'a' + '😀'.repeat(3);
    assert.equal(cutText(s, 2), 'a');          // 2-я единица — старшая половина пары: отрезаем до неё
    assert.equal(cutText(s, 3), 'a😀');
    assert.ok(isCleanText(cutText('😀'.repeat(100), 121)));
  });
  it('cleanDeep: строки и ключи рекурсивно, копия — только где надо; глубже предела — исключение depth', () => {
    const clean = { a: ['x', { b: 'y' }] };
    assert.equal(cleanDeep(clean), clean, 'чистое возвращается как есть');
    const dirty = { ['k' + NUL]: ['x' + HI, { b: 'y' + NUL }], ok: 1 };
    assert.deepEqual(cleanDeep(dirty), { ok: 1, k: ['x�', { b: 'y' }] });
    let deep = 'v';
    for (let i = 0; i < 100; i++) deep = [deep];
    assert.throws(() => cleanDeep(deep), (e) => e.code === 'depth');
  });
  it('validateTx: id с U+0000 или половиной — 400; поля операций не того типа — 400; отсутствующие — дело rebase', () => {
    const ok = (t) => validateTx({ engine: E, base_seq: 0, ...t });
    const bad = (t, re) => assert.throws(() => ok(t), (e) => e.status === 400 && (!re || re.test(e.message)), JSON.stringify(t));
    bad({ tx_id: 't' + NUL, ops: [] }, /tx_id/);
    bad({ tx_id: 't' + HI, ops: [] }, /tx_id/);
    bad({ tx_id: 't1', client: 'c' + NUL, ops: [] }, /client/);
    bad({ tx_id: 't1', undo_of: 'u' + LO, ops: [] }, /undo_of/);
    bad({ tx_id: 't1', ops: [{ op: 'create', node: { id: 'n1', parent: { toString: 1 } } }] }, /node\.parent/);
    bad({ tx_id: 't1', ops: [{ op: 'create', node: { id: 5, parent: 'p' } }] }, /node\.id/);
    bad({ tx_id: 't1', ops: [{ op: 'create', node: 'n' }] }, /node/);
    bad({ tx_id: 't1', ops: [{ op: 'move', id: 'n', parent: ['p'], index: 0 }] }, /parent/);
    bad({ tx_id: 't1', ops: [{ op: 'move', id: 'n', parent: 'p', index: '3' }] }, /index/);
    bad({ tx_id: 't1', ops: [{ op: 'move', id: 'n', parent: 'p', after: 7 }] }, /after/);
    bad({ tx_id: 't1', ops: [{ op: 'remove', id: { a: 1 } }] }, /id/);
    bad({ tx_id: 't1', ops: [{ op: 'remove', id: 'n' + NUL }] }, /id/);
    bad({ tx_id: 't1', ops: [{ op: 'set', id: 'n', path: 3, value: 1 }] }, /path/);
    bad({ tx_id: 't1', ops: [{ op: 'setToken', path: { x: 1 }, value: 1 }] }, /path/);
    let deep = 1;
    for (let i = 0; i < 80; i++) deep = { d: deep };
    bad({ tx_id: 't1', ops: [{ op: 'set', id: 'n', path: 'meta', value: deep }] }, /вложенность/);
    // отсутствующее и null — не форма, а смысл: rebase отбросит как invalid
    assert.ok(ok({ tx_id: 't1', ops: [{ op: 'set', path: 'name', value: 1 }, { op: 'create', node: {} }, { op: 'move', id: 'n', parent: 'p', after: null }] }));
    // значения чистятся, id остаются
    const t = ok({ tx_id: 't1', author: 'Имя' + NUL, title: 'T' + HI, ops: [{ op: 'set', id: 'n', path: 'name', value: 'a' + NUL + 'b' + LO }] });
    assert.equal(t.author, 'Имя');
    assert.equal(t.title, 'T�');
    assert.equal(t.ops[0].value, 'ab�');
  });
  it('validateTx: command_id — строка-id проходит, негодный — просто выбрасывается (правку не губит)', () => {
    assert.equal(validateTx(tx(0, [], { command_id: 'cmd_42' })).command_id, 'cmd_42');
    assert.equal(validateTx(tx(0, [], { command_id: 'x'.repeat(200) })).command_id, undefined);
    assert.equal(validateTx(tx(0, [], { command_id: 'c' + NUL })).command_id, undefined);
    assert.equal(validateTx(tx(0, [], { command_id: 5 })).command_id, undefined);
  });
});

const list = await backends();

for (const backend of list) {
  describe(`строки и форма по HTTP и WS · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let svc;
    let http;
    before(async () => {
      svc = await startFor(backend.name, { verifyMs: 0 });
      http = api(svc.url);
    });
    after(async () => {
      await svc.close();
    });

    async function fresh(name = 'Строки') {
      const created = await http.post('/api/projects', { name, demo: true });
      assert.equal(created.status, 201);
      const doc = (await http.get('/api/projects/' + created.body.id)).body.snapshot.doc;
      return { id: created.body.id, board: artboards(doc)[0] };
    }

    it('U+0000 и одиночные половины в author, title и значениях — 201, в журнале чистые строки (а не 503 навсегда)', async () => {
      const { id, board } = await fresh();
      const node = { type: 'text', id: uid('n'), name: 'имя' + NUL, parent: board.id, characters: 'x' + HI + 'y' + NUL, style: { token: 'body' }, align: 'left', color: '#14161C' };
      const t = tx(0, [ops.create(node), ops.set(board.id, 'name', 'доска' + LO), ops.set(board.id, 'meta', { ['k' + NUL]: 'v' + HI })], { author: 'Автор' + NUL, title: 'Заголовок' + HI });
      const r = await http.post(`/api/projects/${id}/tx`, t);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.author, 'Автор');
      assert.equal(r.body.title, 'Заголовок�');
      assert.equal(r.body.ops[0].node.name, 'имя');
      assert.equal(r.body.ops[0].node.characters, 'x�y');
      assert.equal(r.body.ops[1].value, 'доска�');
      assert.deepEqual(r.body.ops[2].value, { k: 'v�' });
      // повтор того же tx_id — сохранённое, а не новая запись
      const again = await http.post(`/api/projects/${id}/tx`, t);
      assert.equal(again.status, 200);
      const log = await http.get(`/api/projects/${id}/ops?since=0`);
      assert.equal(log.body.txs.length, 1);
      assert.equal(log.body.txs[0].ops[0].node.characters, 'x�y');
    });

    it('id с U+0000 или половиной, поля не того типа — 400 (не 500 и не 503)', async () => {
      const { id, board } = await fresh();
      const cases = [
        tx(0, [ops.set(board.id, 'name', 'a')], { tx_id: 'tx_' + NUL }),
        tx(0, [{ op: 'create', node: { type: 'text', id: uid('n'), parent: { toString: 1 }, characters: 'x' } }]),
        tx(0, [{ op: 'move', id: board.id, parent: { toString: 1 }, index: 0 }]),
        tx(0, [{ op: 'remove', id: 'n' + HI }]),
        tx(0, [ops.set(board.id, 'name', 'a')], { client: 'c' + NUL })
      ];
      for (const c of cases) {
        const r = await http.post(`/api/projects/${id}/tx`, c);
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.retryable, false);
      }
      assert.equal((await http.get(`/api/projects/${id}?head=1`)).body.head_seq, 0);
    });

    it('операция, отброшенная с большим значением из пар-эмодзи, пишется (preview режется по кодовым точкам)', async () => {
      const { id } = await fresh();
      const r = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.set('нет_такого', 'characters', 'a' + '😀'.repeat(2000))]));
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.dropped[0].reason, 'removed');
      const back = await http.get(`/api/projects/${id}/ops?since=0`);
      assert.equal(back.status, 200);
    });

    it('command_id уходит в журнал и возвращается в Committed', async () => {
      const { id, board } = await fresh();
      const r = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.set(board.id, 'name', 'по команде')], { command_id: 'cmd_abc', author_kind: 'agent' }));
      assert.equal(r.status, 201);
      assert.equal(r.body.command_id, 'cmd_abc');
      const log = await http.get(`/api/projects/${id}/ops?since=0`);
      assert.equal(log.body.txs[0].command_id, 'cmd_abc');
    });

    it('имя проекта (POST, PATCH) и X-Author — чистятся', async () => {
      const c = await http.post('/api/projects', { name: 'Про' + NUL + 'ект' + HI });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.equal(c.body.name, 'Проект�');
      const p = await http.patch('/api/projects/' + c.body.id, { name: 'Новое' + LO + NUL });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.name, 'Новое�');
      const doc = (await http.get('/api/projects/' + c.body.id)).body.snapshot.doc;
      const r = await http.post(`/api/projects/${c.body.id}/tx`, tx(0, [ops.set(doc.root, 'name', 'x')]), { 'x-author': encodeURIComponent('Имя') + '%00' });
      assert.equal(r.status, 201);
      assert.equal(r.body.author, 'Имя');
      // документ проекта со строками не по правилам — тоже чистится
      const d = await http.post('/api/projects', { name: 'Документ', doc: { ...doc, nodes: { ...doc.nodes, [doc.root]: { ...doc.nodes[doc.root], name: 'стр' + NUL } } } });
      assert.equal(d.status, 201, JSON.stringify(d.body));
      const dd = (await http.get('/api/projects/' + d.body.id)).body.snapshot.doc;
      assert.equal(dd.nodes[dd.root].name, 'стр');
    });

    it('присутствие: author и выделение с U+0000 / половинами — имя чистое, негодные id не пропускаются', async () => {
      const { id } = await fresh();
      const a = connect(wsUrl(svc, id, { client: 'A', author: 'Аня' + NUL }));
      const b = connect(wsUrl(svc, id, { client: 'B' }));
      await a.until((m) => m.type === 'hello');
      await b.until((m) => m.type === 'hello');
      a.send({ type: 'presence', selection: ['ok', 'bad' + NUL, 'x' + HI], board: 'b' + NUL });
      const seen = await b.until((m) => m.type === 'presence' && m.client === 'A');
      assert.equal(seen.author, 'Аня');
      assert.deepEqual(seen.selection, ['ok']);
      assert.equal(seen.truncated, true);
      assert.equal(seen.board, undefined);
      a.send({ type: 'presence', selection: [], author: 'Аня ' + LO });
      const again = await b.until((m) => m.type === 'presence' && m.client === 'A');
      assert.equal(again.author, 'Аня �');
      await Promise.all([a.close(), b.close()]);
    });

    it('WS: транзакция с U+0000 в значении — tx, не error', async () => {
      const { id, board } = await fresh();
      const s = connect(wsUrl(svc, id, { client: 'W', since: 0, proto: 2 }));
      await s.until((m) => m.type === 'hello');
      const t = tx(0, [ops.set(board.id, 'name', 'со' + NUL + 'кет')]);
      s.send({ type: 'tx', tx: t });
      const got = await s.until((m) => m.type === 'tx' || m.type === 'error');
      assert.equal(got.type, 'tx', JSON.stringify(got));
      assert.equal(got.tx.ops[0].value, 'сокет');
      await s.close();
    });
  });
}
