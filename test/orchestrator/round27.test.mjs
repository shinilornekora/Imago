/**
 * Круг 27, Orchestrator:
 *   • воркер ведёт несколько заданий, пока они ждут модель: шесть команд в шесть проектов
 *     при двух воркерах идут разом, а не парами; очередь пула — с пределом по числу и
 *     сроку, и клиент узнаёт о ней событием `queued {scope:'workers'}`;
 *   • останов процесса: идущая и ждущие команды получают `shutting_down` (повторяемо);
 *   • `/agent/command` принимает `selection_by` и передаёт его brain (`selectionBy`);
 *   • запись переживает перезапуск Document service (отказ соединения — повторы до бюджета);
 *   • подпись записи в истории — что сделано, у варианта — «Вариант «…»: …».
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, journal, call, cid, waitFor,
  PLAN_CREATE, TREE_OK, quiet,
} from './helpers.mjs';
import { createDocClient } from '../../server/orchestrator/docclient.js';
import { createDsltsClient } from '../../server/orchestrator/dslts/index.js';
import { parseCommand } from '../../server/orchestrator/http.js';
import { ENGINE_VERSION, uid } from '../../src/core.js';

const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

test('воркер не простаивает, пока модель думает: 6 команд в 6 проектов при 2 воркерах идут разом', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT, { delayMs: 1200 });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 2 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const projects = [];
  for (let i = 0; i < 6; i++) projects.push(await createProject(document, { name: 'п' + i }));

  // прогрев и мерка одной команды (два вызова модели по 1,2 с)
  let t0 = Date.now();
  const one = await command(orch.url, { command_id: cid(), project: projects[0].id, text: 'собери экран тарифов' });
  assert.ok(one.events.some((e) => e.event === 'result'), one.text);
  const single = Date.now() - t0;

  t0 = Date.now();
  const all = await Promise.all(projects.map((p) => command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' })
    .then((r) => ({ r, ms: Date.now() - t0 }))));
  const total = Date.now() - t0;
  for (const { r } of all) assert.ok(r.events.some((e) => e.event === 'result'), r.text);
  // прежде — три волны по два (≈ 3 × single); теперь — одна волна
  assert.ok(total < single * 2, `6 команд шли ${total} мс при одной ${single} мс`);
  assert.ok(orch.dslv.stats.peakJobs >= 3, `заданий на воркерах одновременно: ${orch.dslv.stats.peakJobs}`);
  assert.equal(orch.dslv.alive, 2, 'воркеров не больше пула');
  /* Мгновенное ожидание воркера (пока соседнее задание дойдёт до модели) человеку не
     показывается. Круг 29: флапало под нагрузкой — второй воркер создаётся лениво, и шестая
     команда ждала его старта дольше порога извещения (старт под нагрузкой — до секунды).
     Ожидание старта теперь не очередь (часы извещения ждут прогрева воркера); здесь —
     заодно и цифры старта, если что-то всё же объявилось. */
  const queued = all.filter(({ r }) => r.events.some((e) => e.event === 'queued')).length;
  const s = orch.dslv.stats;
  assert.equal(queued, 0, `о коротком ожидании воркера не сообщаем: объявлено ${queued}, `
    + `старт воркера ${s.lastWarmMs} мс (наибольший ${s.maxWarmMs}), отложено стартом ${s.noticeDeferred}`);
  assert.ok(s.maxWarmMs > 0, 'старт воркера измерен');
});

test('очередь пула: событие queued {scope:workers}, предел по числу (busy) и по сроку', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerJobs: 1, poolQueueMax: 1 });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const [pa, pb, pc] = [await createProject(document), await createProject(document), await createProject(document)];

  const a = commandStream(orch.url, { command_id: cid('a'), project: pa.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1);
  const b = commandStream(orch.url, { command_id: cid('b'), project: pb.id, text: 'собери экран тарифов' });
  const q = await b.until((e) => e.event === 'queued');
  assert.deepEqual(q.data, { position: 1, scope: 'workers' });
  // третья — очередь пула полна: сразу отказ, повторяемый
  const c = await command(orch.url, { command_id: cid('c'), project: pc.id, text: 'собери экран тарифов' });
  const ce = c.events.find((e) => e.event === 'error');
  assert.ok(ce, c.text);
  assert.equal(ce.data.code, 'busy');
  assert.equal(ce.data.retryable, true);
  assert.ok(ce.data.retry_after > 0);

  g.open();
  assert.ok(await a.until((e) => e.event === 'result'));
  assert.ok(await b.until((e) => e.event === 'result'));

  // срок ожидания в очереди пула
  const g2 = gate();
  llm.state.gate = g2.promise;
  const orch2 = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerJobs: 1, poolQueueWaitMs: 900 });
  t.after(async () => { g2.open(); await orch2.close(); });
  const before = llm.completions().length;
  const a2 = commandStream(orch2.url, { command_id: cid('a2'), project: pa.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === before + 1);
  const late = await command(orch2.url, { command_id: cid('b2'), project: pb.id, text: 'собери экран тарифов' });
  const le = late.events.find((e) => e.event === 'error');
  assert.ok(le, late.text);
  assert.equal(le.data.code, 'busy');
  assert.match(le.data.message, /ждала расчёта/);
  // круг 45 (arch-r44): причина — в detail, как у очереди чтений
  assert.deepEqual(le.data.detail, { cause: 'agent', queue: 'workers' });
  assert.ok(late.events.some((e) => e.event === 'queued' && e.data.scope === 'workers'));
  g2.open();
  await a2.until((e) => e.event === 'done');
});

test('I6: останов — идущая и ждущие команды получают shutting_down, а не cancelled', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { g.open(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const a = commandStream(orch.url, { command_id: cid('a'), project: p.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1);
  const b = commandStream(orch.url, { command_id: cid('b'), project: p.id, text: 'собери экран тарифов' });
  await b.until((e) => e.event === 'queued');
  await orch.close(300);
  await a.done();
  await b.done();
  for (const s of [a, b]) {
    const err = s.events.find((e) => e.event === 'error');
    assert.ok(err, JSON.stringify(s.events.map((e) => e.event)));
    assert.equal(err.data.code, 'shutting_down');
    assert.equal(err.data.retryable, true);
    assert.equal(err.data.retry_after, 5);
    assert.match(err.data.message, /перезапускается/);
    assert.equal(s.events[s.events.length - 1].event, 'done');
  }
  const tr = orch.traces.recent ? orch.traces.recent() : [];
  if (tr.length) assert.ok(!tr.some((x) => x.code === 'cancelled'), JSON.stringify(tr.map((x) => x.code)));
  assert.equal((await journal(document, p.id)).head_seq, 0, 'ничего не записано');
});

test('I6: selection_by — проверка формы и передача в brain', async (t) => {
  const base = { command_id: 'c1', project: 'p1', text: 'т' };
  assert.equal(parseCommand(base).selection_by, 'human');
  assert.equal(parseCommand({ ...base, selection_by: 'agent' }).selection_by, 'agent');
  assert.throws(() => parseCommand({ ...base, selection_by: 'robot' }), (e) => e.code === 'bad_request');

  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const { doc } = await orch.dslr.read(p.id);
  const board = doc.nodes[doc.root].children[0];
  // выделение поставил агент (оболочка выделила созданное) — «собери экран» идёт новой доской
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', selection: [board], selection_by: 'agent', board });
  assert.ok(r.events.some((e) => e.event === 'result'), r.text);
  const tx = (await journal(document, p.id)).txs[0];
  const top = tx.ops.find((o) => o.op === 'create');
  assert.equal(top.node.parent, doc.root, 'новой доской, а не внутрь выделенной');
  // то же выделение человека — внутрь
  const h = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', selection: [board], selection_by: 'human', board });
  assert.ok(h.events.some((e) => e.event === 'result'), h.text);
  const tx2 = (await journal(document, p.id)).txs[1];
  assert.equal(tx2.ops.find((o) => o.op === 'create').node.parent, board);
  const bad = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран', selection_by: 1 });
  assert.equal(bad.status, 400);
});

test('запись переживает перезапуск Document service: отказ соединения — повторы с тем же tx_id до бюджета', async (t) => {
  // настоящий сокет: сервис «лежит» ~1,5 с (порт закрыт), потом поднимается на том же порту
  const posts = [];
  const handler = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    posts.push(body.tx_id);
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ ...body, seq: 1, dropped: [] }));
  };
  const probe = http.createServer(handler);
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  let server = null;
  const up = setTimeout(() => { server = http.createServer(handler); server.listen(port, '127.0.0.1'); }, 1500);
  t.after(() => { clearTimeout(up); if (server) { server.closeAllConnections(); server.close(); } });

  const waits = [];
  const dslts = createDsltsClient({ doc: createDocClient({ baseUrl: `http://127.0.0.1:${port}` }), log: quiet });
  const tx = { tx_id: uid('tx'), base_seq: 0, author: 'Агент', author_kind: 'agent', engine: ENGINE_VERSION, ops: [{ op: 'set', id: 'n1', path: 'name', value: 'v' }] };
  const t0 = Date.now();
  const out = await dslts.commit('p1', tx, { onWait: (w) => waits.push(w) });
  assert.equal(out.seq, 1);
  assert.ok(Date.now() - t0 >= 1400, 'дождались подъёма');
  assert.deepEqual(posts, [tx.tx_id], 'записано один раз, тем же tx_id');
  assert.ok(waits.length >= 3 && waits.every((w) => w.restarting), JSON.stringify(waits));
  assert.ok(dslts.stats.retries >= 3, 'повторы шли, пока сервис не поднялся');

  // сервис так и не поднялся — document_down по исчерпании бюджета, а не через 0,9 с
  const dead = createDsltsClient({ doc: createDocClient({ baseUrl: 'http://127.0.0.1:9' }), log: quiet, waitBudgetMs: 1200 });
  const t1 = Date.now();
  await assert.rejects(dead.commit('p1', { ...tx, tx_id: uid('tx') }), (e) => e.code === 'document_down' && /не отвечал/.test(e.message));
  const ms = Date.now() - t1;
  assert.ok(ms >= 1100 && ms < 4000, `ждали ${ms} мс`);
});

test('история: подпись записи агента — что сделано; вариант — «Вариант «…»: …»', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ ...SCRIPT, plan: { ...PLAN_CREATE, summary: 'Ставлю стиль h1.' } });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const res = r.events.find((e) => e.event === 'result').data;
  const tx = (await journal(document, p.id)).txs[0];
  assert.equal(tx.title, 'Добавил «Экран тарифов» новой доской');
  assert.equal(res.title, tx.title);

  const id = cid('v');
  const v = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', mode: 'variants', n: 2 });
  const items = v.events.find((e) => e.event === 'variants');
  assert.ok(items, v.text);
  const applied = await call(orch.url, 'POST', '/agent/apply', { command_id: id, variant: 0 });
  assert.equal(applied.status, 200, applied.text);
  const tx2 = (await journal(document, p.id)).txs[1];
  assert.match(tx2.title, /^Вариант «[^»]+»: Добавил «Экран тарифов» новой доской$/);
  assert.equal(applied.body.title, tx2.title);
});
