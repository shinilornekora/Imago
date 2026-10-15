/**
 * Orchestrator, круг 25: кеш DSLR по байтам, список библиотек DUIL не на каждую команду,
 * `command_id` и `client` в транзакции агента, останов по SIGTERM с командой в работе —
 * в 8 с (Docker шлёт SIGKILL через 10). Порты процессов — из диапазона круга 8700–8719.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDslrClient, estimateBytes } from '../../server/orchestrator/dslr/index.js';
import { createDuil } from '../../server/orchestrator/duil/index.js';
import { createDocClient } from '../../server/orchestrator/docclient.js';
import * as limits from '../../server/orchestrator/limits.js';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, call, cid, quiet, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

test('DSLR: кеш ограничен и по байтам — давние проекты вытесняются, только что прочитанный остаётся', async (t) => {
  const document = await startDocument();
  t.after(() => document.close());
  const net = createDocClient({ baseUrl: `http://127.0.0.1:${document.port}` });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await createProject(document, { name: 'п' + i })).id);
  const probe = createDslrClient({ doc: net, log: quiet });
  const one = estimateBytes((await probe.read(ids[0])).doc);
  assert.ok(one > 10000, 'оценка документа: ' + one);

  // предел — на два с половиной документа: в кеше не больше двух
  const dslr = createDslrClient({ doc: net, log: quiet, cacheBytes: Math.round(one * 2.5) });
  for (const id of ids) await dslr.read(id);
  const u = dslr.usage();
  assert.equal(u.projects, 2, JSON.stringify(u));
  assert.ok(u.bytes <= one * 2.5, JSON.stringify(u));
  assert.equal(dslr.peek(ids[0]), null, 'самый давний вытеснен');
  assert.ok(dslr.peek(ids[3]), 'последний прочитанный — в кеше');
  assert.equal(dslr.stats.evicted, 2);

  // документ больше предела целиком всё равно остаётся (он нужен команде сейчас)
  const tiny = createDslrClient({ doc: net, log: quiet, cacheBytes: 100 });
  await tiny.read(ids[1]);
  await tiny.read(ids[2]);
  assert.equal(tiny.usage().projects, 1);
  assert.ok(tiny.peek(ids[2]));
  // и по числу — как прежде
  const few = createDslrClient({ doc: net, log: quiet, cacheSize: 3 });
  for (const id of ids) await few.read(id);
  assert.equal(few.usage().projects, 3);
  assert.ok(limits.DSLR_CACHE_BYTES >= 32 * 1024 * 1024 && limits.DSLR_CACHE_BYTES <= 512 * 1024 * 1024);
});

test('DSLR: дочитывание хвоста — одним черновиком на страницу, стейт = журнал', async (t) => {
  const document = await startDocument();
  t.after(() => document.close());
  const base = `http://127.0.0.1:${document.port}`;
  const p = await createProject(document);
  const dslr = createDslrClient({ doc: createDocClient({ baseUrl: base }), log: quiet });
  const st0 = await dslr.read(p.id);
  const texts = Object.keys(st0.doc.nodes).filter((id) => st0.doc.nodes[id].type === 'text').slice(0, 20);
  for (let i = 0; i < 30; i++) {
    const r = await call(base, 'POST', `/api/projects/${p.id}/tx`, {
      tx_id: cid(), base_seq: i, engine: 1, ops: [{ op: 'set', id: texts[i % texts.length], path: 'name', value: 'имя ' + i }],
    });
    assert.equal(r.status, 201, r.text);
  }
  const st = await dslr.read(p.id);
  assert.equal(st.seq, 30);
  assert.equal(st.doc.nodes[texts[29 % texts.length]].name, 'имя 29');
  assert.equal(dslr.stats.incremental, 1);
  const full = await createDslrClient({ doc: createDocClient({ baseUrl: base }), log: quiet }).read(p.id);
  const core = await import('../../src/core.js');
  assert.equal(core.hashDoc(st.doc), core.hashDoc(full.doc));
});

test('DUIL: список библиотек — одно чтение на TTL и на параллельные команды; выжимка — по head_seq', async () => {
  let lists = 0;
  let reads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const core = await import('../../src/core.js');
  const libDoc = core.createDoc();
  const dslr = {
    async list(o) {
      lists++;
      assert.equal(o.query, 'kind=library', 'просим только библиотеки');
      await gate;
      return [{ id: 'L1', name: 'Кит', kind: 'library' }, { id: 'D1', name: 'Макет', kind: 'design' }];
    },
    async read(id) { reads++; return { seq: 5, doc: libDoc }; },
  };
  const duil = createDuil({ dslr, log: quiet, listTtlMs: 60000 });
  const a = duil.slice({ exclude: 'D1' });
  const b = duil.slice({ exclude: 'D1' });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(lists, 1, 'параллельные команды ждут одно чтение списка');
  assert.equal(ra.libraries.length, 1);
  assert.equal(rb.libraries[0].id, 'L1');
  for (let i = 0; i < 5; i++) await duil.slice({ exclude: 'D1' });
  assert.equal(lists, 1, 'в пределах TTL список не перечитывается');
  assert.equal(reads, 7, 'свежесть библиотеки — по её журналу, каждая команда');
  assert.equal(duil.stats.derived, 1, 'словарь и выжимка пересчитаны один раз (head_seq тот же)');
  assert.ok(limits.PROJECT_LIST_TTL_MS >= 10000, 'не чаще раза в 10 с');

  // список не прочитался — работаем по прежнему
  duil.invalidate();
  const failing = createDuil({ dslr: { ...dslr, list: async () => { throw new Error('нет связи'); } }, log: quiet });
  const r = await failing.slice({});
  assert.equal(r.libraries.length, 0);
  assert.ok(r.warnings.length);
});

test('транзакция агента несёт command_id и client автора команды', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const sent = [];
  const spy = async (url, init) => {
    if (init && init.method === 'POST' && /\/tx$/.test(new URL(String(url)).pathname)) sent.push(JSON.parse(init.body));
    return fetch(url, init);
  };
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, fetch: spy });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const id = cid();
  const r = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', client: 'tab-42' });
  assert.ok(r.events.some((e) => e.event === 'result' && e.data.seq), JSON.stringify(r.events));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command_id, id);
  assert.equal(sent[0].client, 'tab-42');
  assert.equal(sent[0].author_kind, 'agent');
  assert.ok(sent[0].title.isWellFormed());

  // command_id длиннее, чем хранит Document service (64), не шлётся — запись не ломается
  const long = 'c'.repeat(100);
  const r2 = await command(orch.url, { command_id: long, project: p.id, text: 'собери экран тарифов' });
  assert.ok(r2.events.some((e) => e.event === 'result' && e.data.seq), JSON.stringify(r2.events));
  assert.equal(sent.length, 2);
  assert.equal('command_id' in sent[1], false);
});

test('останов с командой в работе: прерывается после дедлайна, весь останов < 8 с, код 0', async (t) => {
  const document = await startDocument();
  // модель не отвечает никогда: команда висит «в модели»
  const llm = await startFakeLlm(SCRIPT, { gate: new Promise(() => {}) });
  t.after(async () => { await document.close(); await llm.close(); });
  const p = await createProject(document);
  const port = 8716;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    DOCUMENT_URL: `http://127.0.0.1:${document.port}`, LLM_BASE_URL: llm.base, LLM_MODEL: 'fake-model',
  };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['server/orchestrator/index.js'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* уже вышел */ } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !/слушаю/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /слушаю/, out);

  const s = commandStream(`http://127.0.0.1:${port}`, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  await s.until((e) => e.event === 'stage' && e.data.key === 'llm');
  for (let i = 0; i < 100 && !llm.completions().length; i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(llm.completions().length, 'команда дошла до модели');

  const t0 = Date.now();
  child.kill('SIGTERM');
  const res = await exited;
  const ms = Date.now() - t0;
  assert.equal(res.signal, null, out);
  assert.equal(res.code, 0, out);
  assert.ok(ms < limits.SHUTDOWN_HARD_MS, `останов ${ms} мс: ` + out);
  assert.ok(ms >= limits.SHUTDOWN_GRACE_MS - 200, `команде дали дедлайн (${ms} мс)`);
  assert.match(out, /не уложилась .* прерываю/);
  await s.done();
  const err = s.events.find((e) => e.event === 'error');
  assert.ok(err, JSON.stringify(s.events.map((e) => e.event)));
  assert.equal(err.data.code, 'cancelled');
  assert.equal(limits.SHUTDOWN_GRACE_MS + limits.SHUTDOWN_ABORT_WAIT_MS + limits.SHUTDOWN_FLUSH_MS <= limits.SHUTDOWN_HARD_MS, true);
});
