/**
 * DSLR-клиент Orchestrator (SPEC §9.8, §10.6): кеш стейта с якорем своей головы,
 * дочитывание хвоста `ops?since=&tip=&epoch=` страницами по `more`, сброс кеша при откате
 * базы Document service (410, смена эпохи, чужой chain у пришедшей записи).
 *
 * Главный сценарий — откат базы под работающим Orchestrator: агент закешировал seq 3,
 * базу вернули к seq 2 и дописали новые записи дальше закешированного seq. Следующая команда
 * агента обязана строиться по НОВОМУ журналу: стейт агента = переигрывание журнала (hashDoc),
 * и модель видит в выжимке новое имя доски, а не старое.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core.js';
import { start as startDocumentService } from '../../server/document/index.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import * as docLimits from '../../server/document/limits.js';
import * as orchLimits from '../../server/orchestrator/limits.js';
import { createDslrClient, chainNext } from '../../server/orchestrator/dslr/index.js';
import { startFakeLlm, startOrch, call, command, createProject, cid, quiet, PLAN_CREATE, TREE_OK } from './helpers.mjs';

const { applyOps, hashDoc, artboards, ops, uid, ENGINE_VERSION: E } = core;

/** Журнал целиком (страницами по more) и переигрывание с затравки seq 0. */
async function journal(base, id) {
  const txs = [];
  let since = 0;
  for (;;) {
    const r = await call(base, 'GET', `/api/projects/${id}/ops?since=${since}&limit=500`);
    assert.equal(r.status, 200, r.text);
    txs.push(...r.body.txs);
    if (!r.body.more || !r.body.txs.length) break;
    since = r.body.txs[r.body.txs.length - 1].seq;
  }
  return txs;
}
function replay(doc, txs) {
  let cur = doc;
  for (const t of txs) {
    const res = applyOps(cur, t.ops);
    assert.equal(res.error, undefined, `seq ${t.seq} обязана применяться`);
    cur = res.doc;
  }
  return cur;
}
const humanTx = (base_seq, list) => ({ tx_id: uid('tx'), base_seq, engine: E, author: 'Аня', ops: list });

test('пределы транзакции агента совпадают с Document service', () => {
  assert.equal(orchLimits.DOC_MAX_OPS_PER_TX, docLimits.MAX_OPS_PER_TX);
  assert.equal(orchLimits.DOC_MAX_BODY_BYTES, docLimits.MAX_BODY_BYTES);
  assert.ok(orchLimits.DOC_PAGE_LIMIT <= docLimits.MAX_LIMIT, 'страница не больше, чем сервис отдаёт');
});

test('откат базы под Orchestrator: следующая команда агента строится по новому журналу', async (t) => {
  const storage = createMemoryStorage();
  const document = await startDocumentService({ port: 0, host: '127.0.0.1', storage, snapshotEvery: 50, pingInterval: 0, verifyMs: 0, log: quiet });
  const prompts = [];
  const llm = await startFakeLlm({
    plan: (body) => { prompts.push(body.messages.map((m) => m.content).join('\n')); return PLAN_CREATE; },
    tree: TREE_OK,
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const docBase = `http://127.0.0.1:${document.port}`;
  const p = await createProject(document, { name: 'Откат под агентом' });
  const seed = (await call(docBase, 'GET', `/api/projects/${p.id}`)).body.snapshot.doc;
  const board = artboards(seed)[0];

  // seq 1–2: общая история, которую бэкап сохранит
  for (const [i, list] of [[0, [ops.set(board.id, 'name', 'Доска один')]], [1, [ops.create({
    type: 'text', id: uid('t'), name: 'Подпись', parent: board.id, characters: 'Было', style: { token: 'body' }, align: 'left', color: '#14161C',
  })]]]) {
    const r = await call(docBase, 'POST', `/api/projects/${p.id}/tx`, humanTx(i, list));
    assert.equal(r.status, 201, r.text);
  }
  const backup = storage.backup();

  // seq 3 — пропадёт при restore; агент её закеширует
  assert.equal((await call(docBase, 'POST', `/api/projects/${p.id}/tx`, humanTx(2, [ops.set(board.id, 'name', 'Доска до отката')]))).status, 201);
  const r1 = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const res1 = r1.events.find((e) => e.event === 'result');
  assert.ok(res1, JSON.stringify(r1.events));
  assert.equal(res1.data.seq, 4);
  const cached = orch.dslr.peek(p.id);
  assert.equal(cached.seq, 3, 'агент закешировал голову, которую читал');
  assert.equal(typeof cached.chain, 'string');
  assert.ok(cached.chain.length === 64, 'кеш хранит chain своей головы');
  const epoch0 = cached.epoch;
  assert.ok(epoch0, 'и эпоху');
  assert.match(prompts[0], /Доска до отката/);

  // restore к seq 2 и новые записи ДАЛЬШЕ закешированного seq 3
  storage.restore(backup);
  let base = 2;
  for (const list of [
    [ops.set(board.id, 'name', 'Доска после отката')],
    [ops.create({ type: 'text', id: uid('t'), name: 'Новая подпись', parent: board.id, characters: 'Стало', style: { token: 'body' }, align: 'left', color: '#14161C' })],
    [ops.set(board.id, 'fill', 'surface')],
  ]) {
    const r = await call(docBase, 'POST', `/api/projects/${p.id}/tx`, humanTx(base, list));
    assert.equal(r.status, 201, r.text);
    base = r.body.seq;
  }
  assert.equal(base, 5, 'новый журнал ушёл дальше закешированного seq');
  const head = (await call(docBase, 'GET', `/api/projects/${p.id}?head=1`)).body;
  assert.notEqual(head.epoch, epoch0, 'сервис увидел откат и сменил эпоху');

  const resetsBefore = orch.dslr.stats.resets;
  const r2 = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const res2 = r2.events.find((e) => e.event === 'result');
  assert.ok(res2, JSON.stringify(r2.events));
  assert.equal(res2.data.seq, 6);
  assert.deepEqual(res2.data.dropped, [], 'правка агента легла без потерь');
  assert.ok(orch.dslr.stats.resets > resetsBefore, 'кеш выброшен');

  // модель видела новый журнал, а не закешированный
  assert.match(prompts[1], /Доска после отката/);
  assert.ok(!/Доска до отката/.test(prompts[1]), 'в промпт попал документ, которого в журнале больше нет');

  // стейт агента = переигрывание журнала с затравки
  const log = await journal(docBase, p.id);
  assert.deepEqual(log.map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
  const agentTx = log[5];
  assert.equal(agentTx.tx_id, res2.data.tx_id);
  assert.equal(agentTx.base_seq, 5, 'база записи агента — голова нового журнала');
  const truthAt5 = hashDoc(replay(seed, log.slice(0, 5)));
  const st = await orch.dslr.read(p.id);
  assert.equal(st.seq, 6);
  assert.equal(hashDoc(st.doc), hashDoc(replay(seed, log)), 'стейт агента = переигрывание журнала');
  assert.equal(st.epoch, head.epoch);
  assert.equal(st.chain, log[5].chain);
  assert.notEqual(truthAt5, hashDoc(st.doc));
});

test('хвост страницами по `more`, а не по длине: страница в одну запись, полное чтение с more:true', async (t) => {
  // страница — не больше 1 байта: сервис отдаёт по одной записи (первая — всегда)
  const document = await startDocumentService({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), snapshotEvery: 50, pingInterval: 0, verifyMs: 0, pageBytes: 1, log: quiet });
  t.after(() => document.close());
  const docBase = `http://127.0.0.1:${document.port}`;
  const p = await createProject(document);
  const seed = (await call(docBase, 'GET', `/api/projects/${p.id}`)).body.snapshot.doc;
  const board = artboards(seed)[0];
  for (let i = 0; i < 4; i++) {
    assert.equal((await call(docBase, 'POST', `/api/projects/${p.id}/tx`, humanTx(i, [ops.set(board.id, 'name', `Доска ${i}`)]))).status, 201);
  }
  const first = (await call(docBase, 'GET', `/api/projects/${p.id}`)).body;
  assert.equal(first.tail.length, 1);
  assert.equal(first.more, true, 'сервис обещает ещё');

  const { createDocClient } = await import('../../server/orchestrator/docclient.js');
  const dslr = createDslrClient({ doc: createDocClient({ baseUrl: docBase }), log: quiet });
  const st = await dslr.read(p.id);
  assert.equal(st.seq, 4, 'полное чтение дочитало хвост');
  assert.equal(st.doc.nodes[board.id].name, 'Доска 3');
  for (let i = 4; i < 7; i++) {
    assert.equal((await call(docBase, 'POST', `/api/projects/${p.id}/tx`, humanTx(i, [ops.set(board.id, 'name', `Доска ${i}`)]))).status, 201);
  }
  const pages = dslr.stats.pages;
  const st2 = await dslr.read(p.id);
  assert.equal(st2.seq, 7, 'дочитывание не остановилось на короткой странице');
  assert.equal(st2.doc.nodes[board.id].name, 'Доска 6');
  assert.ok(dslr.stats.pages - pages >= 3, 'страница за страницей');
  assert.equal(hashDoc(st2.doc), hashDoc(replay(seed, await journal(docBase, p.id))));
  assert.equal(dslr.stats.resets, 0);
});

/* ── сброс кеша: поддельный транспорт с журналом, который тест переписывает ── */

/** Журнал в памяти + ответы как у Document service §9.8. */
function fakeService(seed) {
  const s = { seed, txs: [], epoch: 'e0', calls: [], gone: false };
  const chainAt = (seq) => (seq === 0 ? '' : s.txs[seq - 1].chain);
  s.push = (list, tx_id = uid('tx')) => {
    const seq = s.txs.length + 1;
    s.txs.push({ seq, tx_id, ops: list, chain: chainNext(chainAt(seq - 1), tx_id, seq) });
  };
  s.net = {
    async get(path) {
      s.calls.push(path);
      const u = new URL(path, 'http://x');
      const head = s.txs.length;
      if (u.pathname.endsWith('/ops')) {
        const since = Number(u.searchParams.get('since'));
        const tip = u.searchParams.get('tip');
        if (s.gone || (tip && since > 0 && (since > head || chainAt(since) !== tip))) {
          return { status: 410, body: { error: true, code: 'gone' } };
        }
        return { status: 200, body: { head_seq: head, epoch: s.epoch, tip: chainAt(head), txs: s.txs.slice(since, since + 1), more: since + 1 < head } };
      }
      return {
        status: 200,
        body: { id: 'p1', name: 'П', kind: 'design', head_seq: head, epoch: s.epoch, tip: chainAt(head), snapshot: { seq: 0, doc: s.seed, chain: '' }, tail: s.txs.slice(0, 1), more: head > 1 },
      };
    },
  };
  return s;
}

test('сброс кеша: 410, смена эпохи, чужой chain у пришедшей записи — стейт читается целиком', async () => {
  const seed = core.createDoc();
  const board = artboards(seed)[0];
  const s = fakeService(seed);
  const dslr = createDslrClient({ doc: s.net, log: quiet });
  s.push([ops.set(board.id, 'name', 'А')]);
  s.push([ops.set(board.id, 'name', 'Б')]);
  let st = await dslr.read('p1');
  assert.equal(st.seq, 2);
  assert.equal(st.chain, s.txs[1].chain);

  // 1. журнал переписан с seq 2, сервис сверяет tip → 410
  s.txs.length = 1;
  s.push([ops.set(board.id, 'name', 'В')]);
  s.push([ops.set(board.id, 'name', 'Г')]);
  st = await dslr.read('p1');
  assert.equal(st.seq, 3);
  assert.equal(st.doc.nodes[board.id].name, 'Г');
  assert.equal(dslr.stats.resets, 1);
  assert.ok(s.calls.some((c) => /[?&]tip=[0-9a-f]{64}/.test(c) && /[?&]epoch=e0/.test(c)), 'tip и epoch уходят в запросе хвоста');

  // 2. сервис не сверил tip (прежний), но пришедшая запись не продолжает наш якорь
  const net = s.net;
  s.net = { get: (path) => net.get(path.replace(/&tip=[^&]*/, '')) };
  const dslr2 = createDslrClient({ doc: { get: (p) => s.net.get(p) }, log: quiet });
  await dslr2.read('p1');
  s.txs.length = 2;
  s.push([ops.set(board.id, 'name', 'Д')]);   // seq 3 с другим tx_id → другой chain
  s.push([ops.set(board.id, 'name', 'Е')]);
  st = await dslr2.read('p1');
  assert.equal(dslr2.stats.resets, 1, 'чужой chain у seq 3 — сброс');
  assert.equal(st.seq, 4);
  assert.equal(st.doc.nodes[board.id].name, 'Е');

  // 3. эпоха в ответе сменилась (номера и записи те же) — тоже сброс
  s.epoch = 'e1';
  s.push([ops.set(board.id, 'name', 'Ж')]);
  st = await dslr2.read('p1');
  assert.equal(dslr2.stats.resets, 2);
  assert.equal(st.epoch, 'e1');
  assert.equal(st.doc.nodes[board.id].name, 'Ж');

  // 4. голова позади кеша (restore без новых записей)
  s.txs.length = 3;
  st = await dslr2.read('p1');
  assert.equal(dslr2.stats.resets, 3);
  assert.equal(st.seq, 3);
  assert.equal(st.doc.nodes[board.id].name, 'Д');
});

test('журнал переписывается под каждым чтением — ограниченно, потом document_failed', async () => {
  const seed = core.createDoc();
  const s = fakeService(seed);
  s.push([ops.set(artboards(seed)[0].id, 'name', 'А')]);
  s.push([ops.set(artboards(seed)[0].id, 'name', 'Б')]);
  s.gone = true;   // каждая страница хвоста — 410
  const dslr = createDslrClient({ doc: s.net, log: quiet });
  await assert.rejects(dslr.read('p1'), (e) => e.code === 'document_failed');
  assert.equal(dslr.peek('p1'), null, 'в кеш ничего не попало');
});

test('параллельные чтения одного проекта идут по одному и не затирают кеш старым стейтом', async () => {
  const seed = core.createDoc();
  const board = artboards(seed)[0];
  const s = fakeService(seed);
  let inflight = 0;
  let peak = 0;
  const slow = {
    async get(path) {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      try { return await s.net.get(path); } finally { inflight--; }
    },
  };
  const dslr = createDslrClient({ doc: slow, log: quiet });
  s.push([ops.set(board.id, 'name', 'А')]);
  const a = dslr.read('p1');
  s.push([ops.set(board.id, 'name', 'Б')]);
  const b = dslr.read('p1');
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(peak, 1, 'чтения одного проекта не перекрываются');
  assert.ok(sb.seq >= sa.seq);
  assert.equal(dslr.peek('p1').seq, 2);
});
