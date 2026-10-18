/**
 * Круг 41 — Document service:
 *   Н3) «наследная» запись (движка не новее своего, принята прежними кругами, нынешнее ядро её строже
 *       отвергает — `set layout..gap` круга 32) снимков не блокирует: снимок с такой головы равен
 *       переигрыванию журнала, хвост от снимка не растёт без предела; голова «с пропуском» — только
 *       при неизвестной версии записи;
 *   B01) бюджет тел записи — отказ именно бюджета (`body_bytes_total`), а не очереди семафора;
 *   B02) срок первого байта по умолчанию — BODY_FIRST_BYTE_MS; тело, замолчавшее посреди, — 408
 *       `body_idle` (по умолчанию BODY_IDLE_MS), прочитанное освобождает бюджет;
 *   HW2) вес головы в бюджете HEADS_BYTES считает надгробия;
 *   мелочи) `detail.cost` в отказе импорта за предел раскрытия; пробелы по краям имени не делают тело
 *       создания «другим» (create_id).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import * as core from '../../src/core.js';
import { uid, createDoc } from '../../src/core.js';
import { CODE_ENGINE, ENGINE_MIN_READ } from '../../server/document/engine.js';
import { BODY_FIRST_BYTE_MS, BODY_IDLE_MS } from '../../server/document/limits.js';
import { backends, startFor, api } from './helpers.mjs';

const E = CODE_ENGINE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const list = await backends();

/** Лог, собирающий предупреждения строкой. */
function logBox() {
  const lines = [];
  return { lines, log: { info() {}, warn: (...a) => lines.push(a.map(String).join(' ')) } };
}

/** Весь журнал проекта (страницами ops?since=). */
async function journal(h, P) {
  const out = [];
  let since = 0;
  for (;;) {
    const r = await h.get(`/api/projects/${P}/ops?since=${since}&limit=500`);
    assert.equal(r.status, 200, r.text);
    out.push(...r.body.txs);
    if (!r.body.txs.length || !r.body.more) break;
    since = r.body.txs[r.body.txs.length - 1].seq;
  }
  return out;
}

/* ------------------------------ Н3. наследная запись ------------------------------ */

describe('круг 41 (Н3): наследная негодная запись не блокирует снимки', () => {
  const engines = [...new Set([E, Math.max(ENGINE_MIN_READ, E - 1)])];
  for (const b of list) {
    for (const recEngine of engines) {
      it(`журнал «круга 32» с \`set layout..gap\` (движок ${recEngine}) + 120 правок — снимки 50 и 100 есть, открытие от снимка = переигрыванию с seq 0 · ${b.name}`, { skip: !b.available, timeout: 60000 }, async () => {
        const box = logBox();
        const svc = await startFor(b.name, { verifyMs: 0, snapshotEvery: 50, log: box.log });
        try {
          const h = api(svc.url);
          const P = (await h.post('/api/projects', { name: 'наследие', demo: true })).body.id;
          const doc0 = (await h.get(`/api/projects/${P}`)).body.snapshot.doc;
          const board = core.artboards(doc0)[0];
          const t = board.children[0];
          const legacy = [{ op: 'set', id: t, path: 'layout..gap', value: 8 }];
          assert.ok(core.applyOps(doc0, legacy).error, 'нынешнее ядро запись отвергает');
          // запись, принятая прежним кругом, — прямо в журнал
          const rec = await svc.storage.commitTx(P, { tx_id: uid('tx'), base_seq: 0, ops: legacy, dropped: [], notes: [], engine: recEngine, author_kind: 'human' });
          assert.equal(rec.status, 'committed');
          await svc.dslts.unload(P);
          for (let i = 1; i <= 120; i++) {
            const r = await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: board.id, path: 'name', value: 'имя ' + i }]));
            assert.equal(r.status, 201, r.text);
          }
          await svc.dslts.flush();
          assert.equal(svc.dslts.isHoley(P), false, 'голова не «с пропуском»');
          assert.equal(svc.dslts.legacySkipsOf(P), 1);
          const seqs = await svc.storage.snapshotSeqs(P);
          assert.ok(seqs.includes(50) && seqs.includes(100), 'снимки пишутся: ' + seqs);
          // хвост от снимка не растёт без предела
          const opened = (await h.get(`/api/projects/${P}`)).body;
          assert.equal(opened.snapshot.seq, 100);
          assert.equal(opened.tail.length, 21);
          let fromSnap = opened.snapshot.doc;
          for (const x of opened.tail) fromSnap = core.applyOps(fromSnap, x.ops, { checkExpand: false }).doc;
          // переигрывание всего журнала от seq 0 — та же голова
          const all = await journal(h, P);
          assert.equal(all.length, 121);
          const replay = core.applyBatches(doc0, all.map((x) => x.ops)).doc;
          assert.equal(core.hashDoc(fromSnap), core.hashDoc(replay), 'снимок равен переигрыванию');
          assert.equal(core.hashDoc((await svc.dslts.headOf(P)).doc), core.hashDoc(replay), 'голова равна переигрыванию');
          assert.ok(box.lines.some((l) => /наследная запись/.test(l) && /снимки пишутся/.test(l)), box.lines.join(' | '));
          assert.ok(!box.lines.some((l) => /голова с пропуском/.test(l)));
          // голова, поднятая заново (снимок 100 + хвост), — та же
          await svc.dslts.unload(P);
          assert.equal(core.hashDoc((await svc.dslts.headOf(P)).doc), core.hashDoc(replay));
        } finally {
          await svc.close();
        }
      });
    }
  }

  it('запись неизвестной версии, которую движок не применяет, — голова «с пропуском», снимков нет · memory', async () => {
    const box = logBox();
    const svc = await startFor('memory', { verifyMs: 0, snapshotEvery: 4, log: box.log });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'неизвестная' })).body.id;
      const d = (await h.get(`/api/projects/${P}`)).body.snapshot.doc;
      const page = d.nodes[d.root].children[0];
      // хранилище прежней версии без колонки engine: версия записи неизвестна
      const bad = await svc.storage.commitTx(P, { tx_id: uid('tx'), base_seq: 0, ops: [{ op: 'create', node: { type: 'нет_такого', id: 'z_bad', parent: page } }], dropped: [], notes: [], author_kind: 'human' });
      assert.equal(bad.status, 'committed');
      for (let i = 1; i < 10; i++) assert.equal((await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: d.root, path: 'name', value: 'v' + i }]))).status, 201);
      await svc.dslts.flush();
      assert.equal(svc.dslts.isHoley(P), true);
      assert.deepEqual(await svc.storage.snapshotSeqs(P), [0]);
      assert.ok(box.lines.some((l) => /голова с пропуском/.test(l)));
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ тела записи: бюджет, первый байт, простой ------------------------------ */

/** Сырой POST: заголовки и начало тела; ответ (текст) и время до него. */
function rawPost(port, path, contentLength, bodyPart, waitMs = 15000) {
  const t0 = Date.now();
  const s = net.connect(port, '127.0.0.1');
  const done = new Promise((resolve) => {
    let out = '';
    const fin = () => resolve({ text: out, ms: Date.now() - t0 });
    s.on('data', (d) => { out += d; });
    s.on('close', fin);
    s.on('error', fin);
    setTimeout(() => s.destroy(), waitMs).unref();
  });
  s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n` + bodyPart);
  return { socket: s, done };
}

describe('круг 41: тела записи — бюджет байт, первый байт и простой посреди тела', () => {
  it('B01: тело держит бюджет прочитанными байтами — соседу 503 body_bytes_total (не очередь семафора); замолчало — 408 body_idle, бюджет свободен · memory', async () => {
    const budget = 64 * 1024;
    const svc = await startFor('memory', { verifyMs: 0, writes: { bodyBytes: budget, max: 64, queue: 64, idleMs: 800, firstByteMs: 5000, bodyTimeoutMs: 20000 } });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'бюджет' })).body.id;
      const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
      // держит 50 КБ прочитанных байт и молчит
      const held = rawPost(svc.port, `/api/projects/${P}/tx`, 100000, 'x'.repeat(50000));
      await sleep(150);
      const body = (i) => ({ ...tx(i, [{ op: 'set', id: root, path: 'name', value: 'n' + i }]), pad: 'p'.repeat(30000) });
      const r1 = await h.post(`/api/projects/${P}/tx`, body(0));
      assert.equal(r1.status, 503, r1.text);
      assert.equal(r1.body.code, 'busy');
      assert.equal(r1.body.detail.limit, 'body_bytes_total', 'отказ бюджета тел, а не семафора');
      // молчащее посреди тело — 408 body_idle; бюджет освобождён
      const res = await held.done;
      assert.match(res.text, /^HTTP\/1\.1 408/, res.text.slice(0, 200));
      assert.match(res.text, /body_idle/);
      assert.ok(res.ms < 5000, `по простою, а не по сроку тела: ${res.ms} мс`);
      const r2 = await h.post(`/api/projects/${P}/tx`, body(0));
      assert.equal(r2.status, 201, r2.text);
      // одно тело больше бюджета, когда других нет, — читается
      const big = await h.post(`/api/projects/${P}/tx`, { ...tx(1, [{ op: 'set', id: root, path: 'name', value: 'big' }]), pad: 'b'.repeat(budget + 1000) });
      assert.equal(big.status, 201, big.text);
    } finally {
      await svc.close();
    }
  });

  it(`B02: сроки по умолчанию — первый байт ${BODY_FIRST_BYTE_MS} мс (body_first_byte), простой ${BODY_IDLE_MS} мс (body_idle) · memory`, { timeout: 40000 }, async () => {
    const svc = await startFor('memory', { verifyMs: 0 });
    try {
      const P = (await api(svc.url).post('/api/projects', { name: 'сроки' })).body.id;
      const silent = rawPost(svc.port, `/api/projects/${P}/tx`, 100, '', 30000);
      const stalled = rawPost(svc.port, `/api/projects/${P}/tx`, 100, '{', 30000);
      const [a, b] = await Promise.all([silent.done, stalled.done]);
      assert.match(a.text, /^HTTP\/1\.1 408/, a.text.slice(0, 200));
      assert.match(a.text, /body_first_byte/);
      assert.ok(a.ms >= BODY_FIRST_BYTE_MS - 200 && a.ms < BODY_FIRST_BYTE_MS + 4000, `первый байт: ${a.ms} мс`);
      assert.match(b.text, /^HTTP\/1\.1 408/, b.text.slice(0, 200));
      assert.match(b.text, /body_idle/);
      assert.ok(b.ms >= BODY_IDLE_MS - 200 && b.ms < BODY_IDLE_MS + 5000, `простой: ${b.ms} мс`);
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ HW2. надгробия в весе головы ------------------------------ */

describe('круг 41 (HW2): вес головы считает надгробия', () => {
  it('документы и выжимки малы, надгробий много — сверх бюджета давние выгружаются; вес под бюджетом · memory', async () => {
    let doc = createDoc('empty');
    const page = doc.nodes[doc.root].children[0];
    const board = uid('f');
    const ids = [];
    const ops = [{ op: 'create', node: { type: 'frame', id: board, parent: page, name: 'B', role: 'artboard', layout: { mode: 'column' } } }];
    for (let i = 0; i < 1500; i++) {
      const id = uid('t');
      ids.push(id);
      ops.push({ op: 'create', node: { type: 'text', id, parent: board, characters: 'x' } });
    }
    doc = core.applyOps(doc, ops).doc;
    // 1500 надгробий по 160 Б — 240 КБ на голову; бюджет — на три такие головы
    const budget = 3 * 1500 * 160;
    const svc = await startFor('memory', { headsBytes: budget, recentTxs: 1, verifyMs: 0, snapshotEvery: 0 });
    try {
      const h = api(svc.url);
      const projects = [];
      for (let p = 0; p < 6; p++) {
        const id = (await h.post('/api/projects', { name: 'надгробия ' + p, doc })).body.id;
        projects.push(id);
        const r = await h.post(`/api/projects/${id}/tx`, tx(0, ids.map((n) => ({ op: 'remove', id: n }))));
        assert.equal(r.status, 201, r.text);
      }
      const st = svc.dslts.stats();
      assert.ok(st.headsDocBytes * 2 < budget, 'по документам бюджет не кончился бы: ' + JSON.stringify(st));
      assert.ok(st.evicted >= 1, 'надгробия в бюджете — давние выгружены: ' + JSON.stringify(st));
      assert.ok(st.headsBytes <= budget, `вес голов под бюджетом: ${JSON.stringify(st)} при ${budget}`);
      assert.equal(svc.dslts.isLoaded(projects[5]), true);
      assert.equal(svc.dslts.isLoaded(projects[0]), false);
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ мелочи ------------------------------ */

describe('круг 41: мелочи импорта и create_id', () => {
  it('отказ импорта за предел раскрытия называет стоимость (detail.cost > max) · memory', { skip: typeof core.libraryNode === 'function' && typeof core.expandCost === 'function' ? false : 'движок без expandCost' }, async () => {
    const svc = await startFor('memory', { verifyMs: 0 });
    try {
      const d = JSON.parse(JSON.stringify(createDoc('empty')));
      const lib = core.libraryNode(d).id;
      for (let i = 0; i < 9; i++) {
        const c = 'f_q' + i;
        d.nodes[c] = { type: 'frame', id: c, parent: lib, component: { name: 'K' + i, props: [] }, children: [], layout: { mode: 'column' } };
        d.nodes[lib].children.push(c);
        if (i < 8) {
          for (let s = 0; s < 5; s++) {
            const n = 'i_q' + i + '_' + s;
            d.nodes[n] = { type: 'instance', id: n, parent: c, of: 'f_q' + (i + 1) };
            d.nodes[c].children.push(n);
          }
        }
      }
      const r = await api(svc.url).post('/api/projects', { name: 'бомба', doc: d });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.detail.limit, 'expand_nodes');
      assert.ok(Number.isInteger(r.body.detail.cost) && r.body.detail.cost > r.body.detail.max, JSON.stringify(r.body.detail));
    } finally {
      await svc.close();
    }
  });

  for (const b of list) {
    it(`create_id: имя с пробелами по краям — то же тело (200 existing), другое имя — 409 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name, { verifyMs: 0 });
      try {
        const h = api(svc.url);
        const cid = 'trim_' + Math.random().toString(36).slice(2, 12);
        const r1 = await h.post('/api/projects', { name: 'Первый', create_id: cid });
        assert.equal(r1.status, 201, r1.text);
        for (const name of ['Первый ', '  Первый', '\tПервый\n']) {
          const r = await h.post('/api/projects', { name, create_id: cid });
          assert.equal(r.status, 200, JSON.stringify(name) + ' ' + r.text);
          assert.equal(r.body.id, r1.body.id);
        }
        assert.equal((await h.post('/api/projects', { name: 'Второй', create_id: cid })).status, 409);
      } finally {
        await svc.close();
      }
    });
  }
});
