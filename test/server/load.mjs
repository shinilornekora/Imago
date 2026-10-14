/**
 * Нагрузочный самотест Document service (SPEC §9.9) — НЕ входит в `npm test`
 * (без суффикса .test): запускается руками.
 *
 *   env -u NODE_OPTIONS node test/server/load.mjs
 *
 * Сценарий: отдельная база (создаётся и удаляется), два экземпляра сервиса
 * отдельными процессами (порты LOAD_PORT и LOAD_PORT+1, по умолчанию 8740/8741),
 * 30 реплик src/sync.js (по 15 на экземпляр) в одном проекте, 2000 транзакций
 * вперемешку: create / set / move / remove — чужие удаления дают dropped, перемещения —
 * встречные слияния. Каждая реплика работает «закрытым циклом»: правка → ждёт своё
 * подтверждение → пауза 0–20 мс → следующая. Плюс присутствие (выделение раз в
 * несколько правок) — оно идёт через NOTIFY между экземплярами.
 *
 * Проверка: у всех 30 реплик и у обоих экземпляров hashDoc одинаковый и равен
 * переигрыванию журнала с затравки; номера без дыр; ни одна транзакция не записана
 * дважды; каждая видит присутствие всех остальных 29. Цифры: задержка подтверждения
 * (commit → своя tx в рассылке) p50/p95/p99/max, пропускная способность.
 *
 * Окружение: LOAD_DATABASE_URL (или TEST_DATABASE_URL) — сервер Postgres, где
 * можно создать базу; LOAD_PORT; LOAD_CLIENTS (30); LOAD_TXS (2000); LOAD_PHASES
 * (replicas,raw); LOAD_VERBOSE=1 — stderr экземпляров в консоль.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import WebSocket from 'ws';
import * as core from '../../src/core.js';
import { createSync, memoryStorage } from '../../src/sync.js';

const { artboards, ops, uid, hashDoc, applyOps } = core;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.LOAD_DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://imago:imago@127.0.0.1:5432/imago_test';
const PORT = Number(process.env.LOAD_PORT || 8740);
const CLIENTS = Number(process.env.LOAD_CLIENTS || 30);
const TOTAL = Number(process.env.LOAD_TXS || 2000);
/** Фазы через запятую: replicas (реплики sync.js), raw (сырые сокеты). */
const PHASES = (process.env.LOAD_PHASES || 'replicas,raw').split(',');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function dbUrl(name) {
  const u = new URL(BASE_URL);
  u.pathname = '/' + name;
  return u.toString();
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
}

/** Процессорное время процесса (с), Linux /proc; нет — NaN. */
function cpuOf(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch (_) {
    return NaN;
  }
}

function spawnService(port, databaseUrl) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server/document/index.js')], {
    env: { ...env, DATABASE_URL: databaseUrl, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', (d) => { errors += d.toString(); if (process.env.LOAD_VERBOSE) process.stderr.write(d); });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (/слушаю/.test(out)) resolve();
    });
    child.once('exit', (code) => reject(new Error(`экземпляр :${port} вышел (${code}): ${out}${errors}`)));
  });
  return { child, ready, errors: () => errors, url: `http://127.0.0.1:${port}` };
}

async function waitFor(fn, what, ms = 60000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error('не дождались: ' + what);
    await delay(25);
  }
}

/**
 * Вторая фаза: те же 30 клиентов × 2 экземпляра × 2000 транзакций, но клиент — сырой
 * WebSocket без реплики (не переигрывает документ): задержку меряет сервис, а не
 * процессор процесса-клиента. Каждый копит весь поток tx; сходимость — поток каждого
 * клиента совпадает с журналом (seq, tx_id, chain), журнал переигрывается с затравки.
 */
async function rawPhase(services) {
  const created = await (await fetch(services[0].url + '/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Нагрузка · сырые' })
  })).json();
  const id = created.id;
  const seed = (await (await fetch(`${services[0].url}/api/projects/${id}`)).json()).snapshot.doc;
  const board = artboards(seed)[0];
  const clients = [];
  for (let c = 0; c < CLIENTS; c++) {
    const svc = services[c % 2];
    const ws = new WebSocket(`${svc.url.replace('http', 'ws')}/ws?project=${id}&since=0&client=R${c}&proto=2`);
    const cl = { ws, stream: [], waiters: new Map(), hello: null, own: [] };
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'hello') { cl.hello = m; return; }
      if (m.type === 'tx') {
        cl.stream.push(m.tx);
        const w = cl.waiters.get(m.tx.tx_id);
        if (w) { cl.waiters.delete(m.tx.tx_id); w(); }
      } else if (m.type === 'error' && m.tx_id) {
        const w = cl.waiters.get(m.tx_id);
        if (w) { cl.waiters.delete(m.tx_id); w(m); }
      }
    });
    clients.push(cl);
  }
  await waitFor(() => clients.every((c) => c.hello), 'hello у всех');
  const quota = clients.map((_, i) => Math.floor(TOTAL / CLIENTS) + (i < TOTAL % CLIENTS ? 1 : 0));
  const latencies = [];
  const errors = [];
  let retries = 0;
  const started = performance.now();
  const cpu0 = { s0: cpuOf(services[0].child.pid), s1: cpuOf(services[1].child.pid) };
  await Promise.all(clients.map(async (cl, i) => {
    for (let k = 0; k < quota[i]; k++) {
      const base = cl.stream.length ? cl.stream[cl.stream.length - 1].seq : 0;
      let list;
      if (cl.own.length < 3 || Math.random() < 0.3) {
        const nid = uid('n');
        cl.own.push(nid);
        list = [ops.create({ type: 'text', id: nid, name: 'R' + i, parent: board.id, characters: `R${i}·${k}`, style: { token: 'body' }, align: 'left', color: '#14161C' })];
      } else if (Math.random() < 0.85) {
        list = [ops.set(cl.own[Math.floor(Math.random() * cl.own.length)], 'characters', `R${i} правит ${k}`)];
      } else {
        list = [ops.move(cl.own[Math.floor(Math.random() * cl.own.length)], board.id, 0)];
      }
      const t = { tx_id: uid('tx'), base_seq: base, ops: list, engine: core.ENGINE_VERSION, client: 'R' + i };
      const t0 = performance.now();
      for (let attempt = 0; ; attempt++) {
        const done = new Promise((resolve) => cl.waiters.set(t.tx_id, resolve));
        cl.ws.send(JSON.stringify({ type: 'tx', tx: t }));
        const err = await done;
        if (!err) { latencies.push(performance.now() - t0); break; }
        // повторяемое (503: голову двигает другой экземпляр) — как реплика: тот же tx_id позже
        if (err.retryable && attempt < 20) { retries++; await delay(20 + Math.random() * 50); continue; }
        errors.push(err.code);
        break;
      }
      await delay(Math.random() * 20);
    }
  }));
  const elapsed = (performance.now() - started) / 1000;
  const cpu = {
    instance_1: Math.round((cpuOf(services[0].child.pid) - cpu0.s0) * 100) / 100,
    instance_2: Math.round((cpuOf(services[1].child.pid) - cpu0.s1) * 100) / 100
  };
  const head = (await (await fetch(`${services[0].url}/api/projects/${id}?head=1`)).json()).head_seq;
  await waitFor(() => clients.every((c) => c.stream.length >= head), 'весь поток у всех');
  const txs = [];
  for (let since = 0; ;) {
    const page = await (await fetch(`${services[1].url}/api/projects/${id}/ops?since=${since}&limit=5000`)).json();
    txs.push(...page.txs);
    if (!page.more || !page.txs.length) break;
    since = page.txs[page.txs.length - 1].seq;
  }
  let doc = seed;
  for (const t of txs) {
    const res = applyOps(doc, t.ops);
    if (res.error) throw new Error(`seq ${t.seq} не применяется: ${res.error.message}`);
    doc = res.doc;
  }
  const key = (list) => list.map((t) => `${t.seq}:${t.tx_id}:${t.chain}`).join('|');
  const truth = key(txs);
  for (const c of clients) c.ws.close();
  latencies.sort((a, b) => a - b);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    clients: CLIENTS, instances: 2, transactions: txs.length, errors, retries_503: retries,
    seconds: round(elapsed), tx_per_s: round(txs.length / elapsed),
    latency_ms: { p50: round(pct(latencies, 50)), p95: round(pct(latencies, 95)), p99: round(pct(latencies, 99)), max: round(latencies[latencies.length - 1]) },
    cpu_seconds: cpu,
    streams_equal_journal: clients.every((c) => key(c.stream) === truth),
    no_gaps: txs.every((t, i) => t.seq === i + 1),
    no_duplicates: new Set(txs.map((t) => t.tx_id)).size === txs.length,
    doc_nodes: Object.keys(doc.nodes).length
  };
}

async function main() {
  const dbName = 'imago_load_' + process.pid;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = dbUrl(dbName);
  const services = [];
  const replicas = [];
  try {
    // первый поднимается один — он мигрирует пустую базу
    services.push(spawnService(PORT, url));
    await services[0].ready;
    services.push(spawnService(PORT + 1, url));
    await services[1].ready;

    if (PHASES.includes('replicas')) await replicaPhase(services, replicas);
    if (PHASES.includes('raw')) {
      const raw = await rawPhase(services);
      console.log('лёгкие клиенты (сырой WebSocket):', JSON.stringify(raw, null, 2));
      if (!raw.streams_equal_journal || !raw.no_gaps || !raw.no_duplicates || raw.transactions !== TOTAL) {
        process.exitCode = 1;
        console.error('НЕ СОШЛОСЬ (сырые клиенты)');
      }
    }
  } finally {
    await Promise.all(replicas.map((r) => r.sync.close().catch(() => {})));
    for (const s of services) {
      s.child.kill('SIGTERM');
      await new Promise((r) => (s.child.exitCode !== null ? r() : s.child.once('exit', r)));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error('базу не удалить:', e.message));
    await admin.end();
  }
}

/** Первая фаза: 30 настоящих реплик src/sync.js. */
async function replicaPhase(services, replicas) {
  {
    const created = await (await fetch(services[0].url + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Нагрузка' })
    })).json();
    const id = created.id;
    const seed = (await (await fetch(`${services[0].url}/api/projects/${id}`)).json()).snapshot.doc;
    const board = artboards(seed)[0];

    const latencies = [];
    const sentAt = new Map();
    let confirmedCount = 0;
    let droppedOps = 0;
    let timeouts = 0;
    for (let c = 0; c < CLIENTS; c++) {
      const svc = services[c % 2];
      const waiters = new Map();
      const r = {
        id: 'L' + c, waiters, others: 0,
        sync: createSync({
          core, baseUrl: svc.url, projectId: id, clientId: 'L' + c, author: 'Клиент ' + c, storage: memoryStorage(),
          WebSocketImpl: WebSocket, fetchImpl: (...a) => fetch(...a), reconnectMin: 50, reconnectMax: 1000,
          onChange: (_, info) => {
            if ((info.reason === 'confirmed' || info.reason === 'ack') && info.tx) {
              const t0 = sentAt.get(info.tx.tx_id);
              if (t0 !== undefined) {
                latencies.push(performance.now() - t0);
                sentAt.delete(info.tx.tx_id);
                confirmedCount++;
              }
              if (info.tx.dropped) droppedOps += info.tx.dropped.length;
              const w = waiters.get(info.tx.tx_id);
              if (w) { waiters.delete(info.tx.tx_id); w(); }
            }
          },
          onPresence: (list) => { r.others = list.length; }
        })
      };
      replicas.push(r);
    }
    await Promise.all(replicas.map((r) => r.sync.open()));
    await waitFor(() => replicas.every((r) => r.sync.status.online), 'все в сети');

    // поровну на клиента, остаток — первым
    const quota = replicas.map((_, i) => Math.floor(TOTAL / CLIENTS) + (i < TOTAL % CLIENTS ? 1 : 0));
    const texts = () => Object.values(replicas[0].sync.view.nodes).filter((n) => n.type === 'text');
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const started = performance.now();
    const cpu0 = { main: process.cpuUsage(), s0: cpuOf(services[0].child.pid), s1: cpuOf(services[1].child.pid) };

    async function worker(r, n) {
      for (let k = 0; k < n; k++) {
        const view = r.sync.view;
        const mine = Object.values(view.nodes).filter((x) => x.type === 'text' && x.parent === board.id);
        const roll = Math.random();
        let list;
        if (mine.length < 5 || roll < 0.3) {
          list = [ops.create({ type: 'text', id: uid('n'), name: r.id, parent: board.id, characters: `${r.id}·${k}`, style: { token: 'body' }, align: 'left', color: '#14161C' })];
        } else if (roll < 0.8) {
          const t = pick(mine);
          list = [ops.set(t.id, 'characters', `${r.id} правит ${k}`)];
        } else if (roll < 0.9) {
          const t = pick(mine);
          list = [ops.move(t.id, board.id, Math.floor(Math.random() * mine.length))];
        } else {
          list = [ops.remove(pick(mine).id)];
        }
        const res = r.sync.commit(list);
        if (!res.tx) continue;
        sentAt.set(res.tx.tx_id, performance.now());
        const ok = await Promise.race([
          new Promise((resolve) => r.waiters.set(res.tx.tx_id, () => resolve(true))),
          delay(30000).then(() => false)
        ]);
        if (!ok) { timeouts++; r.waiters.delete(res.tx.tx_id); }
        if (k % 5 === 0) r.sync.presence({ selection: mine.slice(0, 3).map((x) => x.id), board: board.id, busy: k % 10 === 0 });
        await delay(Math.random() * 20);
      }
    }
    await Promise.all(replicas.map((r, i) => worker(r, quota[i])));
    const elapsed = (performance.now() - started) / 1000;
    const mainCpu = process.cpuUsage(cpu0.main);
    const cpu = {
      clients_process: Math.round((mainCpu.user + mainCpu.system) / 1e4) / 100,
      instance_1: Math.round((cpuOf(services[0].child.pid) - cpu0.s0) * 100) / 100,
      instance_2: Math.round((cpuOf(services[1].child.pid) - cpu0.s1) * 100) / 100
    };

    // сходимость
    let head = 0;
    await waitFor(async () => {
      head = (await (await fetch(`${services[0].url}/api/projects/${id}?head=1`)).json()).head_seq;
      return replicas.every((r) => r.sync.status.pending === 0 && r.sync.confirmed.seq === head);
    }, 'все реплики догнали голову');
    const txs = [];
    for (let since = 0; ;) {
      const page = await (await fetch(`${services[1].url}/api/projects/${id}/ops?since=${since}&limit=5000`)).json();
      txs.push(...page.txs);
      if (!page.more || !page.txs.length) break;
      since = page.txs[page.txs.length - 1].seq;
    }
    let doc = seed;
    for (const t of txs) {
      const res = applyOps(doc, t.ops);
      if (res.error) throw new Error(`seq ${t.seq} не применяется: ${res.error.message}`);
      doc = res.doc;
    }
    const truth = hashDoc(doc);
    const hashes = new Set(replicas.map((r) => hashDoc(r.sync.view)));
    const ids = txs.map((t) => t.tx_id);
    const okSeq = txs.every((t, i) => t.seq === i + 1);
    await waitFor(() => replicas.every((r) => r.others >= CLIENTS - 1), 'присутствие всех у всех', 20000).catch(() => {});
    const presenceOk = replicas.every((r) => r.others >= CLIENTS - 1);

    latencies.sort((a, b) => a - b);
    const round = (v) => Math.round(v * 10) / 10;
    const report = {
      clients: CLIENTS, instances: 2, transactions: txs.length, confirmed: confirmedCount,
      head_seq: head, seconds: round(elapsed), tx_per_s: round(txs.length / elapsed),
      latency_ms: { p50: round(pct(latencies, 50)), p95: round(pct(latencies, 95)), p99: round(pct(latencies, 99)), max: round(latencies[latencies.length - 1]) },
      cpu_seconds: cpu,
      dropped_ops: droppedOps, confirm_timeouts: timeouts,
      converged: hashes.size === 1 && hashes.has(truth),
      no_gaps: okSeq, no_duplicates: new Set(ids).size === ids.length,
      presence_all_visible: presenceOk
    };
    console.log('реплики src/sync.js:', JSON.stringify(report, null, 2));
    if (!report.converged || !report.no_gaps || !report.no_duplicates || txs.length !== TOTAL) {
      process.exitCode = 1;
      console.error('НЕ СОШЛОСЬ');
    }
    await Promise.all(replicas.map((r) => r.sync.close().catch(() => {})));
    replicas.length = 0;
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
