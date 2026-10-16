/**
 * Orchestrator (SPEC §10) поверх настоящего Document service в памяти и поддельной
 * OpenAI-совместимой модели: команда → транзакция агента в журнале, оболочка без модели,
 * очередь проекта, «стоп», разрыв потока, варианты + выбор, отказы сервисов, форма HTTP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startDocument, startFakeLlm, startOrch, call, command, commandStream, createProject, journal,
  waitFor, cid, PLAN_CREATE, TREE_OK, captureLog,
} from './helpers.mjs';
import { ENGINE_VERSION } from '../../src/core.js';

const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

/** Ворота: модель отвечает, только когда тест откроет их. */
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { promise: p, open };
}

test('команда для модели: транзакция агента в журнале и событие result', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base, apiKey: 'sk-test-key-0001' } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', client: 'c_tab1', author: 'Аня' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  const names = r.events.map((e) => e.event);
  assert.equal(names[names.length - 1], 'done', 'последним всегда done');
  const keys = r.events.filter((e) => e.event === 'stage').map((e) => e.data.key);
  for (const k of ['jev', 'read', 'library', 'llm', 'validate', 'write']) assert.ok(keys.includes(k), `стадия ${k}: ${keys}`);
  assert.ok(keys.indexOf('read') < keys.indexOf('llm') && keys.indexOf('llm') < keys.indexOf('write'));
  for (const s of r.events.filter((e) => e.event === 'stage')) {
    assert.equal(typeof s.data.label, 'string');
    assert.equal(typeof s.data.at, 'number');
  }
  const result = r.events.find((e) => e.event === 'result').data;
  assert.equal(result.seq, 1);
  assert.ok(result.applied >= 3, 'артборд и два текста');
  assert.deepEqual(result.dropped, []);
  assert.equal(result.summary, PLAN_CREATE.summary);
  assert.ok(Array.isArray(result.select) && result.select.length === 1, 'выделить новый артборд');

  const j = await journal(document, p.id);
  assert.equal(j.head_seq, 1);
  const tx = j.txs[0];
  assert.equal(tx.tx_id, result.tx_id);
  assert.match(tx.tx_id, /^tx_/);
  assert.equal(tx.author_kind, 'agent');
  assert.equal(tx.author, 'Агент');
  assert.equal(tx.client, 'c_tab1');
  assert.equal(tx.base_seq, 0);
  assert.equal(tx.engine, ENGINE_VERSION);
  // круг 27: подпись записи — что сделано (по операциям), а не заголовок плана модели
  assert.equal(tx.title, 'Добавил «Экран тарифов» новой доской');
  assert.equal(result.title, tx.title);
  assert.ok(tx.ops.some((o) => o.op === 'create' && o.node.characters === 'Выберите тариф'));
  // id созданных узлов — глобальные (core.uid), ссылки на них переписаны согласованно
  const creates = tx.ops.filter((o) => o.op === 'create');
  assert.ok(creates.every((o) => /^[a-z]+_[0-9a-z]{12,}$/.test(o.node.id)), creates.map((o) => o.node.id).join(','));
  assert.ok(creates.slice(1).every((o) => o.node.parent === creates[0].node.id), 'тексты лежат в новом артборде');
  assert.deepEqual(result.select, [creates[0].node.id]);

  const posts = llm.completions();
  assert.deepEqual(posts.map((c) => c.schema), ['plan', 'tree']);
  assert.equal(posts[0].headers.authorization, 'Bearer sk-test-key-0001');
  assert.equal(posts[0].url, '/v1/chat/completions');

  // вторая команда читает стейт с учётом первой (кеш DSLR дотягивает хвост)
  const r2 = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const res2 = r2.events.find((e) => e.event === 'result');
  assert.ok(res2, JSON.stringify(r2.events));
  assert.equal(res2.data.seq, 2);
  const j2 = await journal(document, p.id, 1);
  assert.equal(j2.txs[0].base_seq, 1, 'база — голова после первой команды');
  const ids1 = new Set(tx.ops.filter((o) => o.op === 'create').map((o) => o.node.id));
  assert.ok(j2.txs[0].ops.every((o) => o.op !== 'create' || !ids1.has(o.node.id)), 'id новых узлов не сталкиваются');
  assert.deepEqual(j2.txs[0].dropped, []);

  const tr = orch.traces.recent().filter((x) => x.project === p.id);
  assert.equal(tr.length, 2);
  assert.equal(tr[0].status, 'ok');
  assert.equal(tr[0].model_calls, 2);
  assert.equal(tr[0].tx_id, result.tx_id);
  assert.ok(tr[0].steps.some((s) => s.key === 'llm' && typeof s.ms === 'number'));
});

test('команда оболочки: событие shell, модель не зовётся, журнал не трогается', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  // и без модели, и без Document service команда оболочки работает
  const bare = await startOrch({});
  t.after(async () => { await orch.close(); await bare.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const cases = [
    ['отмени', 'undo', { times: 1 }],
    ['отмени три раза', 'undo', { times: 3 }],
    ['верни обратно', 'redo', { times: 1 }],
    ['стоп', 'stop', {}],
    ['впиши всё', 'fit', { all: true }],
    ['масштаб 150%', 'zoom', { to: 1.5 }],
    ['сними выделение', 'select', { ids: [] }],
  ];
  for (const [text, action, args] of cases) {
    const r = await command(orch.url, { command_id: cid(), project: p.id, text });
    assert.equal(r.status, 200, text);
    const shell = r.events.find((e) => e.event === 'shell');
    assert.ok(shell, `${text}: ${JSON.stringify(r.events)}`);
    assert.equal(shell.data.action, action, text);
    assert.deepEqual(shell.data.args, args, text);
    assert.equal(r.events[r.events.length - 1].event, 'done');
    assert.ok(!r.events.some((e) => e.event === 'result' || e.event === 'error'));
  }
  const r = await command(bare.url, { command_id: cid(), project: 'p1', text: 'отмени' });
  assert.equal(r.status, 200);
  assert.equal(r.events.find((e) => e.event === 'shell').data.action, 'undo');

  assert.equal(llm.completions().length, 0, 'модель не звалась');
  assert.equal((await journal(document, p.id)).head_seq, 0);
  // «повтори шапку три раза» — работа для модели, а не перемотка истории
  const busy = await command(orch.url, { command_id: cid(), project: p.id, text: 'повтори шапку три раза' });
  assert.ok(!busy.events.some((e) => e.event === 'shell'));
});

test('очередь проекта: две команды по одной, вторая видит запись первой; полна — 429', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, queueMax: 1 });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const other = await createProject(document, { name: 'Другой' });

  const a = commandStream(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1);
  const b = commandStream(orch.url, { command_id: cid('b'), project: p.id, text: 'собери экран тарифов' });
  const queued = await b.until((e) => e.event === 'queued');
  // круг 27: scope — чья очередь: проекта (команды по одной) или пула воркеров
  assert.deepEqual(queued.data, { position: 1, scope: 'project' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(llm.completions().length, 1, 'вторая не дошла до модели, пока идёт первая');

  // третья на тот же проект — очередь полна
  const c = await command(orch.url, { command_id: cid('c'), project: p.id, text: 'собери экран тарифов' });
  assert.equal(c.status, 429);
  assert.equal(c.body.error, true);
  assert.equal(c.body.code, 'busy');
  assert.equal(c.body.retryable, true);
  assert.ok(Number(c.headers.get('retry-after')) > 0);

  // другой проект очередью первого не заблокирован: он уже в модели
  const d = commandStream(orch.url, { command_id: cid('d'), project: other.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 2);
  assert.ok(!d.events.some((e) => e.event === 'queued'));

  g.open();
  const ra = await a.until((e) => e.event === 'result');
  const rb = await b.until((e) => e.event === 'result');
  await d.until((e) => e.event === 'done');
  assert.equal(ra.data.seq, 1);
  assert.equal(rb.data.seq, 2);
  const j = await journal(document, p.id);
  assert.deepEqual(j.txs.map((x) => x.base_seq), [0, 1], 'вторая строилась по стейту после первой');
  const bStages = b.events.filter((e) => e.event === 'stage').map((e) => e.at);
  assert.ok(b.events.findIndex((e) => e.event === 'queued') < b.events.findIndex((e) => e.event === 'stage'));
  assert.ok(bStages.length > 0);
});

test('стоп: прерывает команду в модели и снимает ждущую; ничего не записано', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const idA = cid('a');
  const idB = cid('b');
  const a = commandStream(orch.url, { command_id: idA, project: p.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1);
  const b = commandStream(orch.url, { command_id: idB, project: p.id, text: 'собери экран тарифов' });
  await b.until((e) => e.event === 'queued');

  const sb = await call(orch.url, 'POST', '/agent/stop', { command_id: idB });
  assert.deepEqual(sb.body, { stopped: true });
  const eb = await b.until((e) => e.event === 'error');
  assert.equal(eb.data.code, 'cancelled');
  await b.until((e) => e.event === 'done');

  const t0 = Date.now();
  const sa = await call(orch.url, 'POST', '/agent/stop', { command_id: idA });
  assert.deepEqual(sa.body, { stopped: true });
  const ea = await a.until((e) => e.event === 'error');
  assert.equal(ea.data.code, 'cancelled');
  assert.equal(ea.data.retryable, false);
  await a.until((e) => e.event === 'done');
  assert.ok(Date.now() - t0 < 5000, 'стоп не ждёт модель');
  assert.ok(!a.events.some((e) => e.event === 'result'));

  assert.deepEqual((await call(orch.url, 'POST', '/agent/stop', { command_id: 'nope' })).body, { stopped: false });
  g.open();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await journal(document, p.id)).head_seq, 0, 'ничего не записано');
  const tr = orch.traces.recent().filter((x) => x.project === p.id);
  assert.deepEqual(tr.map((x) => x.status).sort(), ['cancelled', 'cancelled']);

  // после стопа очередь проекта свободна: следующая команда проходит
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'), JSON.stringify(r.events));
});

test('разрыв SSE не отменяет команду: запись доходит до журнала', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const s = commandStream(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', client: 'c_gone' });
  await waitFor(() => llm.completions().length === 1);
  s.abort();
  await s.done();
  g.open();
  const j = await waitFor(async () => {
    const x = await journal(document, p.id);
    return x.head_seq === 1 ? x : null;
  });
  assert.equal(j.txs[0].author_kind, 'agent');
  assert.equal(j.txs[0].client, 'c_gone');
  await waitFor(() => orch.traces.recent().some((x) => x.project === p.id && x.status === 'ok'));
});

test('варианты: событие variants без записи, /agent/apply пишет выбранный', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({
    plan: PLAN_CREATE,
    tree: (body) => {
      // каждому варианту — своё дерево, чтобы отличить, какой записан
      const n = llm.completions().filter((c) => c.schema === 'tree').length;
      return { ...TREE_OK, name: `Экран тарифов ${n}` };
    },
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const id = cid('v');
  const r = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', mode: 'variants', n: 2 });
  const v = r.events.find((e) => e.event === 'variants');
  assert.ok(v, JSON.stringify(r.events));
  assert.equal(v.data.items.length, 2);
  for (const it of v.data.items) {
    assert.equal(typeof it.key, 'string');
    assert.equal(typeof it.label, 'string');
    assert.ok(it.ops_count > 0);
    assert.equal(it.preview.ops.length, it.ops_count);
  }
  assert.ok(!r.events.some((e) => e.event === 'result'));
  assert.equal(r.events[r.events.length - 1].event, 'done');
  assert.equal((await journal(document, p.id)).head_seq, 0, 'варианты ничего не пишут');

  const pick = v.data.items[1];
  const a = await call(orch.url, 'POST', '/agent/apply', { command_id: id, variant: pick.key });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.seq, 1);
  assert.equal(a.body.applied, pick.ops_count);
  const j = await journal(document, p.id);
  assert.equal(j.txs[0].author_kind, 'agent');
  assert.equal(j.txs[0].tx_id, a.body.tx_id);
  assert.equal(j.txs[0].ops[0].node.name, pick.preview.ops[0].node.name, 'записан именно выбранный');

  // повтор того же выбора — та же запись; другой — отказ; неизвестная команда — 404
  const again = await call(orch.url, 'POST', '/agent/apply', { command_id: id, variant: pick.key });
  assert.equal(again.status, 200);
  assert.equal(again.body.tx_id, a.body.tx_id);
  assert.equal((await journal(document, p.id)).head_seq, 1);
  const other = await call(orch.url, 'POST', '/agent/apply', { command_id: id, variant: 0 });
  assert.equal(other.status, 400);
  assert.equal(other.body.code, 'bad_request');
  const none = await call(orch.url, 'POST', '/agent/apply', { command_id: 'nope', variant: 0 });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, 'not_found');

  // «покажи два варианта: …» узнаётся словами, без mode
  const r2 = await command(orch.url, { command_id: cid('v'), project: p.id, text: 'покажи два варианта: собери экран тарифов' });
  const v2 = r2.events.find((e) => e.event === 'variants');
  assert.ok(v2, JSON.stringify(r2.events.map((e) => e.event)));
  assert.equal(v2.data.items.length, 2);
  assert.equal(v2.data.base_seq, 1);
});

test('ключ модели не утекает: заголовок есть, а в health, событиях, ошибках, трассах и логах — нет', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const log = captureLog();
  const KEY = 'sk-very-secret-KEY-777';
  const PASS = 'p4ss-in-url-555';
  const QKEY = 'query-secret-999';
  const base = `http://agent:${PASS}@127.0.0.1:${llm.port}/v1?api-version=2024&key=${QKEY}`;
  const orch = await startOrch({ document, llm: { baseUrl: base, apiKey: KEY }, log, internalToken: 'tok' });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const leaks = (s) => [KEY, PASS, QKEY, Buffer.from(`agent:${PASS}`).toString('base64')].filter((k) => String(s).includes(k));

  const h = await call(orch.url, 'GET', '/agent/health');
  assert.equal(h.body.llm, 'up');
  assert.deepEqual(leaks(h.text), []);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'));
  assert.deepEqual(leaks(r.text), []);
  // адрес собран через URL: путь + суффикс, query базы — после пути
  const post = llm.completions()[0];
  assert.equal(post.url, `/v1/chat/completions?api-version=2024&key=${QKEY}`);
  assert.equal(post.headers.authorization, `Bearer ${KEY}`, 'ключ — заголовком');

  // модель упала посреди работы: текст ошибки с адресом — без секретов
  await llm.close();
  const bad = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.deepEqual(leaks(bad.text), []);
  const err = bad.events.find((e) => e.event === 'error') || { data: bad.body };
  assert.equal(err.data.code, 'llm_down');
  const h2 = await call(orch.url, 'GET', '/agent/health');
  assert.deepEqual(leaks(h2.text), []);
  await orch.traces.flush();
  assert.deepEqual(leaks(JSON.stringify(orch.traces.recent())), []);
  assert.ok(!JSON.stringify(orch.traces.recent()).includes('Выберите тариф'), 'в трассе нет промптов и ответов модели');
  assert.deepEqual(leaks(log.lines.join('\n')), []);
});

test('модель лежит или не подключена — 503 llm_down; Document service лежит — 503 document_down', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  llm.state.down = true;
  const down = await startOrch({ document, llm: { baseUrl: llm.base } });
  const none = await startOrch({ document });
  const nodoc = await startOrch({ llm: { baseUrl: llm.base } });
  t.after(async () => { await down.close(); await none.close(); await nodoc.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const r1 = await command(down.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.equal(r1.status, 503);
  assert.equal(r1.body.code, 'llm_down');
  assert.equal(r1.body.error, true);
  assert.equal(r1.body.retryable, true);
  assert.match(r1.body.message, /[а-я]/);
  assert.ok(Number(r1.headers.get('retry-after')) > 0);
  assert.equal((await call(down.url, 'GET', '/agent/health')).body.llm, 'down');

  const r2 = await command(none.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.code, 'llm_down');
  assert.match(r2.body.message, /не подключена/);
  const h2 = await call(none.url, 'GET', '/agent/health');
  assert.equal(h2.body.llm, 'unconfigured');
  assert.equal(h2.body.document, 'up');
  // без модели работает то, что brain делает сам: «убери последнее» — переспрос
  const r2b = await command(none.url, { command_id: cid(), project: p.id, text: 'убери последнее' });
  assert.equal(r2b.status, 200);
  assert.ok(r2b.events.find((e) => e.event === 'result').data.clarify);

  const r3 = await command(nodoc.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.equal(r3.status, 503);
  assert.equal(r3.body.code, 'document_down');
  assert.ok(Number(r3.headers.get('retry-after')) > 0);
  const h3 = await call(nodoc.url, 'GET', '/agent/health');
  assert.equal(h3.status, 200);
  assert.equal(h3.body.document, 'down');
  assert.equal(h3.body.ok, true, 'ok — сам агент жив; состояние зависимостей — в полях');
  assert.equal(h3.body.engine, ENGINE_VERSION);

  // проекта нет — ошибка событием not_found (поток уже открыт)
  llm.state.down = false;
  const ok = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(() => ok.close());
  const r4 = await command(ok.url, { command_id: cid(), project: 'no-such-project', text: 'собери экран тарифов' });
  assert.equal(r4.status, 200);
  const e4 = r4.events.find((e) => e.event === 'error');
  assert.equal(e4.data.code, 'not_found');
  assert.equal(r4.events[r4.events.length - 1].event, 'done');
});

test('HTTP: 413, 405, 400, 404 — единое тело ошибки', async (t) => {
  const orch = await startOrch({});
  t.after(() => orch.close());
  const big = JSON.stringify({ command_id: 'x', project: 'p', text: 'a'.repeat(1024 * 1024 + 10) });
  const r413 = await call(orch.url, 'POST', '/agent/command', big);
  assert.equal(r413.status, 413);
  assert.deepEqual(Object.keys(r413.body).sort(), ['code', 'error', 'message', 'retryable']);
  assert.equal(r413.body.code, 'too_large');

  const r405 = await call(orch.url, 'GET', '/agent/command');
  assert.equal(r405.status, 405);
  assert.match(r405.headers.get('allow'), /POST/);
  assert.equal(r405.body.error, true);
  assert.equal((await call(orch.url, 'DELETE', '/agent/health')).status, 405);

  for (const body of ['не json', '[]', {}, { command_id: 'a b', project: 'p', text: 'x' }, { command_id: 'a', project: 'p' },
    { command_id: 'a', project: 'p', text: 'x', mode: 'many' }, { command_id: 'a', project: 'p', text: 'x', selection: 'n1' },
    { command_id: 'a', project: 'p', text: 'x', n: 50 }]) {
    const r = await call(orch.url, 'POST', '/agent/command', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'bad_request');
    assert.equal(r.body.retryable, false);
  }
  assert.equal((await call(orch.url, 'POST', '/agent/stop', {})).status, 400);
  assert.equal((await call(orch.url, 'POST', '/agent/apply', { command_id: 'a' })).status, 400);
  const r404 = await call(orch.url, 'GET', '/agent/nope');
  assert.equal(r404.status, 404);
  assert.equal(r404.body.code, 'not_found');
});

test('трассы: POST /api/internal/traces с X-Internal-Token; нет эндпойнта — команда не замечает', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  // перед Document service — прокладка, которая принимает трассы и пропускает остальное
  const got = [];
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === '/api/internal/traces') {
      got.push({ token: req.headers['x-internal-token'], body: JSON.parse(body.toString()) });
      res.writeHead(201).end('{}');
      return;
    }
    const up = await fetch(`http://127.0.0.1:${document.port}${req.url}`, {
      method: req.method, headers: { 'content-type': 'application/json' }, body: body.length ? body : undefined,
    });
    res.writeHead(up.status, { 'content-type': 'application/json' }).end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const viaProxy = await startOrch({ document: { port: proxy.address().port }, llm: { baseUrl: llm.base, apiKey: 'sk-trace-secret' }, internalToken: 'tok-1' });
  const log = captureLog();
  const direct = await startOrch({ document, llm: { baseUrl: llm.base }, internalToken: 'tok-2', log });
  t.after(async () => {
    await viaProxy.close(); await direct.close(); await document.close(); await llm.close();
    await new Promise((r) => { proxy.closeAllConnections(); proxy.close(r); });
  });
  const p = await createProject(document);

  const r = await command(viaProxy.url, { command_id: cid('tr'), project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'));
  await command(viaProxy.url, { command_id: cid('tr'), project: p.id, text: 'отмени' });
  await viaProxy.traces.flush();
  assert.equal(got.length, 2);
  assert.equal(got[0].token, 'tok-1');
  const tr = got[0].body;
  assert.equal(tr.project, p.id);
  assert.equal(tr.status, 'ok');
  assert.equal(tr.model_calls, 2);
  assert.ok(tr.steps.length >= 5);
  assert.equal(got[1].body.kind, 'shell');
  const text = JSON.stringify(got);
  assert.ok(!text.includes('sk-trace-secret'));
  assert.ok(!/messages|prompt"|Выберите тариф/.test(text), 'без промптов и ответов модели');

  // у настоящего Document service эндпойнта может не быть: команды идут, в логе одна строка
  for (let i = 0; i < 2; i++) {
    const x = await command(direct.url, { command_id: cid('tr'), project: p.id, text: 'собери экран тарифов' });
    assert.ok(x.events.some((e) => e.event === 'result'), JSON.stringify(x.events));
  }
  await direct.traces.flush();
  const lines = log.lines.filter((l) => /трасса не записана/.test(l));
  assert.ok(lines.length <= 1, lines.join('\n'));
});

test('останов: выполняемая команда доводится, воркеры сняты', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { g.open(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const s = commandStream(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1, 60000);
  /* Круг 26: дедлайн — с запасом под нагрузкой (три параллельных `npm test`: остаток
     команды — второй ответ модели, воркер, запись — шёл дольше прежних 5 с). Проверяем
     суть: команда, начатая до останова, доведена и записана, а не прервана; и останов
     ждёт её не дольше, чем она идёт (относительно, а не абсолютным порогом). */
  const t0 = Date.now();
  const closing = orch.close(60000);
  setTimeout(() => g.open(), 100);
  let resultAt = 0;
  s.until((e) => e.event === 'result', 60000).then(() => { resultAt = Date.now(); }, () => {});
  await closing;
  const closedAt = Date.now();
  /* поток дочитывается клиентом позже, чем сервер закрыл его: события смотрим после
     конца чтения (прежде — сразу после close(), и под нагрузкой result ещё не был разобран) */
  await s.done();
  const res = s.events.find((e) => e.event === 'result');
  assert.ok(res, JSON.stringify(s.events.map((e) => e.event)));
  assert.ok(!s.events.some((e) => e.event === 'error'), 'не прервана');
  assert.equal((await journal(document, p.id)).head_seq, 1);
  assert.equal(orch.dslv.alive, 0, 'воркеры сняты');
  if (resultAt) {
    const tail = closedAt - resultAt;
    const run = resultAt - t0;
    assert.ok(tail <= Math.max(3000, run), `после итога останов шёл ${tail} мс при команде ${run} мс`);
  }
});

test('трассы доходят до настоящего Document service с тем же INTERNAL_TOKEN', async (t) => {
  const { start } = await import('../../server/document/index.js');
  const { createMemoryStorage } = await import('../../server/document/storage/memory.js');
  const document = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), pingInterval: 0, internalToken: 'shared-tok-1', log: { info() {}, warn() {} } });
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, internalToken: 'shared-tok-1' });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const id = cid('tr');
  const r = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'));
  await orch.traces.flush();
  const got = await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${p.id}/traces`);
  if (got.status === 404) { t.skip('в этой сборке Document service нет чтения трасс'); return; }
  assert.equal(got.status, 200, got.text);
  const mine = got.body.traces.find((x) => x.command_id === id);
  assert.ok(mine, got.text);
  assert.equal(mine.body.status, 'ok');
  assert.equal(mine.body.model_calls, 2);
});
