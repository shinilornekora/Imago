/**
 * Присутствие между экземплярами Document service (SPEC §9.9): эфемерная шина
 * хранилища (pg — NOTIFY отдельного канала, память — общий слушатель), id
 * экземпляра против эха, выжимка выделения под предел NOTIFY (`truncated`),
 * `busy`/`queued` как есть, `left` при закрытии сокета, по TTL, при остановке
 * экземпляра (`bye`) и при его падении (pg: настоящий процесс, SIGKILL).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as core from '../../src/core.js';
import { createSync, memoryStorage } from '../../src/sync.js';
import { PRESENCE_SELECTION, PRESENCE_PAYLOAD_BYTES } from '../../server/document/limits.js';
import { NOTIFY_MAX_BYTES } from '../../server/document/storage/pg.js';
import { backends, startFor, startTwin, api, connect, wsUrl, waitFor, DB_URL } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Сокет к экземпляру, hello уже прочитан. */
async function open(svc, id, client, extra = {}) {
  const s = connect(wsUrl(svc, id, { client, ...extra }));
  await s.opened;
  const hello = await s.next();
  assert.equal(hello.type, 'hello');
  return s;
}
const isPresence = (client) => (m) => m.type === 'presence' && m.client === client;
const isLeft = (client) => (m) => m.type === 'left' && m.client === client;

/** Нет ли среди сообщений до тишины такого. */
async function never(sock, pred, ms = 200) {
  const until = Date.now() + ms;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) return true;
    if (await sock.silence(left)) return true;
    const m = await sock.next();
    if (pred(m)) return false;
  }
}

const list = await backends();

for (const backend of list) {
  const skip = backend.available ? false : 'нет базы (TEST_DATABASE_URL)';

  describe(`присутствие между экземплярами · ${backend.name}`, { skip }, () => {
    let i1;
    let i2;
    let http;
    before(async () => {
      i1 = await startFor(backend.name, { verifyMs: 0 });
      i2 = await startTwin(backend.name, i1, { verifyMs: 0 });
      http = api(i1.url);
    });
    after(async () => {
      await i2.close();
      await i1.close();
    });
    const fresh = async () => (await http.post('/api/projects', { name: 'Присутствие', demo: true })).body.id;

    it('presence с одного экземпляра видна на другом — та же форма, что своим; эха нет; busy/queued как есть', async () => {
      const id = await fresh();
      const A = await open(i1, id, 'A', { author: 'Аня' });
      const B = await open(i2, id, 'B');
      const C = await open(i1, id, 'C');
      A.send({ type: 'presence', selection: ['n1', 'n2'], board: 'f1', busy: true, queued: 2 });
      const atB = await B.until(isPresence('A'));
      const atC = await C.until(isPresence('A'));
      assert.equal(atB.author, 'Аня');
      assert.deepEqual(atB.selection, ['n1', 'n2']);
      assert.equal(atB.board, 'f1');
      assert.equal(atB.busy, true);
      assert.equal(atB.queued, 2);
      assert.equal(atB.truncated, undefined);
      assert.match(atB.at, /^\d{4}-/);
      assert.deepEqual(atB, atC, 'чужой экземпляр и свой видят одно и то же');
      assert.ok(await never(A, isPresence('A')), 'своё присутствие не возвращается — ни сокетом, ни шиной');

      B.send({ type: 'presence', selection: [], busy: 0 });
      const back = await A.until(isPresence('B'));
      assert.equal(back.busy, 0, 'число — тоже флаг');
      await C.until(isPresence('B'));

      // мусор вместо флагов не пропускается
      A.send({ type: 'presence', selection: ['n3'], busy: 'да', queued: { n: 1 } });
      const junk = await B.until(isPresence('A'));
      assert.deepEqual(junk.selection, ['n3']);
      assert.equal('busy' in junk, false);
      assert.equal('queued' in junk, false);
      await Promise.all([A.close(), B.close(), C.close()]);
    });

    it('выделение режется: не больше 200 id и под предел NOTIFY, обрезанное — truncated: true', async () => {
      const id = await fresh();
      const A = await open(i1, id, 'A');
      const B = await open(i2, id, 'B');
      const C = await open(i1, id, 'C');
      const many = Array.from({ length: 300 }, (_, i) => 'n' + i);
      A.send({ type: 'presence', selection: many });
      const p1 = await B.until(isPresence('A'));
      assert.equal(p1.selection.length, PRESENCE_SELECTION);
      assert.deepEqual(p1.selection, many.slice(0, PRESENCE_SELECTION));
      assert.equal(p1.truncated, true);
      assert.deepEqual(await C.until(isPresence('A')), p1);

      // длинные id: 200 штук по 120 символов — 24 КБ, в NOTIFY (< 8000 байт) не лезет
      const long = Array.from({ length: 200 }, (_, i) => 'я'.repeat(100) + '_' + String(i).padStart(5, '0'));
      A.send({ type: 'presence', selection: long, board: 'b'.repeat(128), author: 'Ж'.repeat(300) });
      const p2 = await B.until(isPresence('A'));
      assert.equal(p2.truncated, true);
      assert.ok(p2.selection.length > 10 && p2.selection.length < 200, 'взято ' + p2.selection.length);
      assert.deepEqual(p2.selection, long.slice(0, p2.selection.length), 'взято начало, по порядку');
      assert.ok(Buffer.byteLength(JSON.stringify(p2.selection)) <= PRESENCE_PAYLOAD_BYTES);
      assert.ok(PRESENCE_PAYLOAD_BYTES < NOTIFY_MAX_BYTES);
      assert.equal(p2.author.length, 200, 'имя — не длиннее 200');
      assert.deepEqual(await C.until(isPresence('A')), p2, 'своим — та же выжимка');

      // id длиннее 128 символов не пропускаются (и это тоже обрезка)
      A.send({ type: 'presence', selection: ['ok', 'x'.repeat(129), 7, 'ok2'] });
      const p3 = await B.until(isPresence('A'));
      assert.deepEqual(p3.selection, ['ok', 'ok2']);
      assert.equal(p3.truncated, true);
      await Promise.all([A.close(), B.close(), C.close()]);
    });

    it('предел частоты (10/с на сокет) действует и для чужого экземпляра', async () => {
      const id = await fresh();
      const A = await open(i1, id, 'A');
      const B = await open(i2, id, 'B');
      for (let i = 0; i < 30; i++) A.send({ type: 'presence', selection: ['n' + i] });
      let got = 0;
      for (;;) {
        if (await B.silence(250)) break;
        if ((await B.next()).type === 'presence') got++;
      }
      assert.ok(got >= 1 && got <= 10, 'дошло ' + got);
      await Promise.all([A.close(), B.close()]);
    });

    it('left при закрытии сокета — и на другом экземпляре; две вкладки одного clientId: left только после последней', async () => {
      const id = await fresh();
      const A = await open(i1, id, 'A');
      const B = await open(i2, id, 'B');
      const C = await open(i1, id, 'C');
      A.send({ type: 'presence', selection: ['n1'] });
      await B.until(isPresence('A'));
      await C.until(isPresence('A'));
      await A.close();
      assert.deepEqual(await B.until((m) => m.type === 'left'), { type: 'left', client: 'A' });
      assert.deepEqual(await C.until((m) => m.type === 'left'), { type: 'left', client: 'A' });
      await waitFor(() => i2.hub.remotePresence(id).length === 0, 'запись чужого экземпляра убрана');

      // вкладки одного браузера делят clientId: X на i1 и X на i2
      const X1 = await open(i1, id, 'X');
      const X2 = await open(i2, id, 'X');
      X1.send({ type: 'presence', selection: ['a'] });
      X2.send({ type: 'presence', selection: ['b'] });
      // порядок между своим и чужим экземпляром не задан: ждём оба в любом порядке
      const both = async (sock) => {
        const got = new Set();
        while (got.size < 2) got.add((await sock.until(isPresence('X'))).selection[0]);
      };
      await both(B);
      await both(C);
      await X1.close();
      assert.ok(await never(B, isLeft('X'), 250), 'вторая вкладка ещё здесь — left нет (B на другом экземпляре)');
      assert.ok(await never(C, isLeft('X'), 50), 'и у соседа первой вкладки тоже');
      await X2.close();
      await B.until(isLeft('X'));
      await C.until(isLeft('X'));
      await Promise.all([B.close(), C.close()]);
      assert.equal(i1.hub.roomSize(id) + i2.hub.roomSize(id), 0);
    });

    it('остановка экземпляра: его клиенты уходят у остальных сразу (bye), не дожидаясь TTL', async () => {
      const id = await fresh();
      const i3 = await startTwin(backend.name, i1, { verifyMs: 0 });
      const B = await open(i1, id, 'B');
      const D = await open(i3, id, 'D');
      const E = await open(i3, id, 'E');
      D.send({ type: 'presence', selection: ['d'] });
      E.send({ type: 'presence', selection: ['e'] });
      await B.until(isPresence('D'));
      await B.until(isPresence('E'));
      const t0 = Date.now();
      await i3.close();
      const gone = new Set();
      while (gone.size < 2) {
        const m = await B.until((x) => x.type === 'left', 3000);
        gone.add(m.client);
      }
      assert.deepEqual([...gone].sort(), ['D', 'E']);
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(i1.hub.remotePresence(id).length, 0);
      await B.close();
    });
  });

  describe(`присутствие: TTL и сердцебиение · ${backend.name}`, { skip }, () => {
    const TTL = 400;
    let i1;
    let i2;
    let http;
    before(async () => {
      i1 = await startFor(backend.name, { verifyMs: 0, presenceTtlMs: TTL });
      i2 = await startTwin(backend.name, i1, { verifyMs: 0, presenceTtlMs: TTL });
      http = api(i1.url);
    });
    after(async () => {
      await i2.close();
      await i1.close();
    });
    const fresh = async () => (await http.post('/api/projects', { name: 'TTL', demo: true })).body.id;

    it('замолчавший клиент уходит по TTL — у своих и на другом экземпляре; заговорил — вернулся', async () => {
      const id = await fresh();
      const A = await open(i1, id, 'A');
      const B = await open(i2, id, 'B');
      const C = await open(i1, id, 'C');
      A.send({ type: 'presence', selection: ['n1'] });
      await B.until(isPresence('A'));
      await C.until(isPresence('A'));
      const t0 = Date.now();
      await B.until(isLeft('A'), 3000);
      await C.until(isLeft('A'), 3000);
      assert.ok(Date.now() - t0 >= TTL * 0.5, 'не раньше TTL');
      assert.equal(i1.hub.roomSize(id), 2, 'сокет при этом открыт');
      A.send({ type: 'presence', selection: ['n2'] });
      assert.deepEqual((await B.until(isPresence('A'))).selection, ['n2']);
      await Promise.all([A.close(), B.close(), C.close()]);
    });

    it('упавший экземпляр (ни left, ни bye): его клиенты уходят по TTL записей', async () => {
      const id = await fresh();
      const B = await open(i1, id, 'B');
      const C = await open(i2, id, 'C');
      // «призрак» — экземпляр, который объявил клиента и пропал
      i1.storage.publish({ k: 'presence', p: id, i: 'ghost', c: 'G', a: 'Призрак', s: ['g1'], at: new Date().toISOString() });
      const seen = await B.until(isPresence('G'));
      assert.equal(seen.author, 'Призрак');
      await C.until(isPresence('G'));
      assert.deepEqual(i1.hub.remotePresence(id), [{ instance: 'ghost', client: 'G' }]);
      await B.until(isLeft('G'), 3000);
      await C.until(isLeft('G'), 3000);
      assert.deepEqual(i1.hub.remotePresence(id), []);
      // left от экземпляра, которого не видели, — тишина
      i1.storage.publish({ k: 'left', p: id, i: 'ghost2', c: 'Q' });
      assert.ok(await never(B, isLeft('Q'), 150));
      await Promise.all([B.close(), C.close()]);
    });

    it('реплики sync.js на разных экземплярах: сердцебиение держит присутствие дольше TTL, busy доходит; close — уход', async () => {
      const id = await fresh();
      const mk = (svc, clientId) => {
        const seen = [];
        const sync = createSync({
          core, baseUrl: svc.url, projectId: id, clientId, author: 'Имя ' + clientId, storage: memoryStorage(),
          WebSocketImpl: WebSocket, fetchImpl: (...a) => fetch(...a), reconnectMin: 20, reconnectMax: 200,
          presenceHeartbeatMs: 100, onPresence: (l) => seen.push(l)
        });
        return { sync, seen };
      };
      const R1 = mk(i1, 'R1');
      const R2 = mk(i2, 'R2');
      await Promise.all([R1.sync.open(), R2.sync.open()]);
      await waitFor(() => R1.sync.status.online && R2.sync.status.online, 'в сети');
      R1.sync.presence({ selection: ['x'], busy: true, queued: 1 });
      await waitFor(() => R2.sync.others.some((p) => p.client === 'R1' && p.busy === true && p.queued === 1), 'busy R1 у R2');
      await waitFor(() => R1.sync.others.some((p) => p.client === 'R2'), 'R2 у R1');
      // три TTL без изменений: сердцебиение не даёт уйти
      const leftSeen = () => R2.seen.some((l) => !l.some((p) => p.client === 'R1'));
      const firstSeen = R2.seen.findIndex((l) => l.some((p) => p.client === 'R1'));
      await new Promise((r) => setTimeout(r, TTL * 3));
      assert.ok(R2.sync.others.some((p) => p.client === 'R1'), 'R1 всё ещё у R2');
      assert.equal(R2.seen.slice(firstSeen).some((l) => !l.some((p) => p.client === 'R1')), false, 'ни разу не пропадал');
      // а сырой сокет без сердцебиения уходит
      const S = await open(i1, id, 'S');
      S.send({ type: 'presence', selection: [] });
      await waitFor(() => R2.sync.others.some((p) => p.client === 'S'), 'S у R2');
      await waitFor(() => !R2.sync.others.some((p) => p.client === 'S'), 'S ушёл по TTL', 4000);
      await R1.sync.close();
      await waitFor(() => !R2.sync.others.some((p) => p.client === 'R1'), 'R1 ушёл после close');
      assert.ok(leftSeen());
      await Promise.all([R2.sync.close(), S.close()]);
    });
  });
}

/* ------------------- падение настоящего процесса (pg, SIGKILL) ------------------- */

const pgUp = list.find((b) => b.name === 'pg').available;

/** Document service отдельным процессом: порт — из строки «слушаю http://…:PORT». */
function spawnService(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/document/index.js')], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d.toString();
      const m = /слушаю http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) {
        child.stdout.off('data', onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => reject(new Error('процесс сервиса вышел: ' + code + ' ' + out)));
  });
  return { child, ready };
}

describe('присутствие: экземпляр упал (SIGKILL) · pg', { skip: pgUp ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  it('клиенты упавшего процесса уходят у другого экземпляра по TTL', async () => {
    const i1 = await startFor('pg', { verifyMs: 0, presenceTtlMs: 500 });
    const { child, ready } = spawnService({ DATABASE_URL: DB_URL, PORT: '0', HOST: '127.0.0.1', PRESENCE_TTL_MS: '45000' });
    try {
      const port = await ready;
      const other = { port, url: `http://127.0.0.1:${port}` };
      const id = (await api(i1.url).post('/api/projects', { name: 'Падение', demo: true })).body.id;
      const B = await open(i1, id, 'B');
      const K = await open(other, id, 'K');
      K.send({ type: 'presence', selection: ['k1'], busy: true });
      const seen = await B.until(isPresence('K'), 5000);
      assert.equal(seen.busy, true, 'присутствие пришло из другого процесса через NOTIFY');
      B.send({ type: 'presence', selection: ['b1'] });
      await K.until(isPresence('B'), 5000);
      child.kill('SIGKILL');
      await K.closed;
      const t0 = Date.now();
      await B.until(isLeft('K'), 5000);
      assert.ok(Date.now() - t0 < 4000);
      await B.close();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await i1.close();
    }
  });
});
