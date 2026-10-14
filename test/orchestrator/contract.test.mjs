/**
 * Контракт `/agent/command` круга 24 (SPEC §10.6): `history` доходит до планировщика,
 * формы `result` без записи и `variants.items[].preview`, внешняя библиотека DUIL доходит
 * до прогона brain (в воркере) и использованный мастер переносится в документ.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core.js';
import {
  startDocument, startFakeLlm, startOrch, call, command, createProject, journal, cid, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

const text = (body) => (body.messages || []).map((m) => m.content).join('\n');
const resultOf = (r) => {
  const e = r.events.find((x) => x.event === 'result');
  assert.ok(e, JSON.stringify(r.events));
  return e.data;
};
const NO_WRITE = (res) => {
  assert.equal(res.tx_id, null);
  assert.equal(res.seq, null);
  assert.equal(res.applied, 0);
  assert.deepEqual(res.dropped, []);
};

test('history доходит до модели: переспрос без неё, ответ с опорой на неё; ≤ 5 записей по ≤ 500 символов', async (t) => {
  const document = await startDocument();
  const prompts = { plan: [], answer: [] };
  const remembers = (s) => /ПРЕДЫДУЩИЕ КОМАНДЫ/.test(s) && /перекрась кнопку «Войти»/.test(s);
  const llm = await startFakeLlm({
    plan: (body) => {
      const s = text(body);
      prompts.plan.push(s);
      return remembers(s)
        ? { intent: 'ask', title: 'Отвечаю', summary: 'Ответ по прошлой реплике.', steps: ['Ответить'], targets: [] }
        : { intent: 'clarify', title: 'Не понял', summary: 'Непонятно, что синее.', steps: ['Переспросить'], targets: [],
          clarify: 'Что сделать синим?', clarifyOptions: ['Сделай кнопку синей', 'Сделай заголовок синим', 'Сделай фон синим'] };
    },
    answer: (body) => {
      const s = text(body);
      prompts.answer.push(s);
      return remembers(s)
        ? { answer: 'Понял: кнопка «Войти» — синяя. Скажите «сделай», и я перекрашу.', followups: ['Сделай кнопку «Войти» синей'] }
        : { answer: 'Не знаю, о чём речь.' };
    },
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  // без истории — переспрос (result без записи: clarify + clarifyOptions)
  const a = resultOf(await command(orch.url, { command_id: cid(), project: p.id, text: 'синий' }));
  NO_WRITE(a);
  assert.equal(a.clarify, 'Что сделать синим?');
  assert.deepEqual(a.clarifyOptions, ['Сделай кнопку синей', 'Сделай заголовок синим', 'Сделай фон синим']);
  assert.ok(!/ПРЕДЫДУЩИЕ КОМАНДЫ/.test(prompts.plan[0]), 'истории не было, а блок в промпте есть');

  // с историей — модель видит прошлую реплику и отвечает с опорой на неё
  const history = [{ utterance: 'перекрась кнопку «Войти»', summary: 'Переспросил: в какой цвет — синий или зелёный?' }];
  const b = resultOf(await command(orch.url, { command_id: cid(), project: p.id, text: 'синий', history }));
  NO_WRITE(b);
  assert.match(b.answer, /кнопка «Войти» — синяя/);
  assert.deepEqual(b.followups, ['Сделай кнопку «Войти» синей']);
  assert.equal(b.clarify, undefined);
  const plan = prompts.plan[1];
  assert.match(plan, /ПРЕДЫДУЩИЕ КОМАНДЫ/);
  assert.match(plan, /«перекрась кнопку «Войти»» → Переспросил: в какой цвет — синий или зелёный\?/);
  assert.ok(remembers(prompts.answer[prompts.answer.length - 1]), 'и отвечающий вызов видит историю');
  assert.equal((await journal(document, p.id)).head_seq, 0, 'ничего не записано');

  // больше 5 записей — берутся последние 5; строки режутся до 500 символов
  const long = Array.from({ length: 7 }, (_, i) => ({ utterance: `реплика-${i + 1} ` + 'я'.repeat(600), summary: `итог-${i + 1}` }));
  await command(orch.url, { command_id: cid(), project: p.id, text: 'синий', history: long });
  const last = prompts.plan[prompts.plan.length - 1];
  assert.ok(!/реплика-1 |реплика-2 /.test(last), 'старше пяти — в промпт не идут');
  for (let i = 3; i <= 7; i++) assert.match(last, new RegExp(`реплика-${i} `));
  assert.ok(!last.includes('я'.repeat(501)), 'строка истории длиннее 500 символов');

  // негодная форма — 400 до потока
  const bad = await call(orch.url, 'POST', '/agent/command', { command_id: cid(), project: p.id, text: 'синий', history: 'вчера' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_request');
});

test('result без записи: cannot (отказ) и nothingToChange («уже так»)', async (t) => {
  const document = await startDocument();
  const p = await createProject(document);
  const seed = (await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${p.id}`)).body.snapshot.doc;
  const board = core.artboards(seed).find((b) => b.name === 'Маршрут дня');
  const llm = await startFakeLlm({
    plan: (body) => (/поверни/.test(text(body))
      ? { intent: 'refuse', title: 'Поворот', summary: 'Нельзя.', steps: ['Отказать'], targets: [], cannot: 'Поворачивать слои эта модель документа не умеет.' }
      : { intent: 'edit', title: 'Скругление шапки', summary: 'Ставлю скругление.', steps: ['Скругление'], targets: ['Шапка'] }),
    // у «Шапки» демо-документа скругление уже 0 (radii.0)
    patch: { edits: [{ op: 'set', target: 'Шапка', path: 'radius', value: '0' }] },
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });

  const c = resultOf(await command(orch.url, { command_id: cid(), project: p.id, text: 'поверни шапку на 15 градусов' }));
  NO_WRITE(c);
  assert.match(c.cannot, /Поворачивать слои/);
  const n = resultOf(await command(orch.url, { command_id: cid(), project: p.id, text: 'убери скругление у шапки', board: board.id }));
  NO_WRITE(n);
  assert.ok(n.nothingToChange || n.nothingChanged, JSON.stringify(n));
  assert.equal((await journal(document, p.id)).head_seq, 0);
});

test('variants: preview = {ops, summary, warnings} — без документа; id в превью глобальные', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('v'), project: p.id, text: 'собери экран тарифов', mode: 'variants', n: 2 });
  const v = r.events.find((e) => e.event === 'variants');
  assert.ok(v, JSON.stringify(r.events));
  assert.equal(v.data.base_seq, 0);
  for (const it of v.data.items) {
    assert.deepEqual(Object.keys(it).sort(), ['description', 'key', 'label', 'ops_count', 'preview']);
    assert.deepEqual(Object.keys(it.preview).sort(), ['ops', 'summary', 'warnings']);
    assert.equal(it.preview.summary, PLAN_CREATE.summary);
    assert.ok(Array.isArray(it.preview.warnings));
    for (const o of it.preview.ops.filter((x) => x.op === 'create')) assert.match(o.node.id, /^[a-z]+_[0-9a-z]{12,}$/);
  }
});

/** Проект-библиотека: демо-документ + новый компонент «Плашка» (текст). */
function libraryDoc() {
  let lib = core.createDoc();
  const board = core.artboards(lib)[0];
  const frame = { type: 'frame', id: core.uid('f'), name: 'Плашка', parent: board.id, children: [],
    layout: { mode: 'row', gap: 8, padding: { t: 8, r: 12, b: 8, l: 12 }, align: 'center', justify: 'start' },
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, fill: 'accent', radius: 8 };
  const label = { type: 'text', id: core.uid('t'), name: 'Подпись', parent: frame.id, characters: 'Новинка', style: { token: 'body' }, align: 'left', color: '#FFFFFF' };
  lib = core.applyOps(lib, [core.ops.create(frame), core.ops.create(label)]).doc;
  const made = core.applyOps(lib, core.makeComponentOps(lib, frame.id, {
    name: 'Плашка', props: [{ name: 'текст', kind: 'text', target: label.id, path: 'characters' }],
  }));
  assert.equal(made.error, undefined);
  return made.doc;
}

test('DUIL: внешняя библиотека доходит до прогона в воркере, использованный мастер переносится в документ', async (t) => {
  const document = await startDocument();
  const prompts = [];
  const llm = await startFakeLlm({
    plan: { intent: 'edit', title: 'Плашка в шапку', summary: 'Ставлю плашку.', steps: ['Плашка'], targets: ['Шапка'] },
    patch: (body) => {
      prompts.push(text(body));
      return { edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Плашка', props: [{ name: 'текст', value: 'Акция' }] } }] };
    },
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  await createProject(document, { name: 'Дизайн-система', kind: 'library', doc: libraryDoc() });
  const p = await createProject(document, { name: 'Продукт' });
  const docBase = `http://127.0.0.1:${document.port}`;
  const seed = (await call(docBase, 'GET', `/api/projects/${p.id}`)).body.snapshot.doc;
  const board = core.artboards(seed).find((b) => b.name === 'Маршрут дня');
  assert.ok(!core.components(seed).some((c) => c.name === 'Плашка'), 'в продукте плашки ещё нет');

  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'добавь в шапку плашку «Акция»', board: board.id });
  const res = resultOf(r);
  assert.equal(res.seq, 1, JSON.stringify(r.events));
  assert.deepEqual(res.libraryAdded, [{ name: 'Плашка', source: 'Дизайн-система' }]);
  assert.match(prompts[0], /Плашка\(текст\)/, 'словарь внешней библиотеки — в промпте модели');

  const j = await journal(document, p.id);
  const next = core.applyOps(seed, j.txs[0].ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const plashka = core.components(next.doc).find((c) => c.name === 'Плашка');
  assert.ok(plashka, 'мастер перенесён в библиотеку продукта');
  const inst = Object.values(next.doc.nodes).find((n) => n.type === 'instance' && n.of === plashka.id);
  assert.ok(inst);
  assert.equal(core.instanceSummary(next.doc, inst.id), 'Плашка "Акция"');
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
  const tr = orch.traces.recent().find((x) => x.tx_id === res.tx_id);
  assert.equal(tr.libraries, 1);
  assert.ok(tr.library_components >= 4, JSON.stringify(tr));

  // вторая такая же команда: «Плашка» уже своя — документ главнее, переносить нечего
  const r2 = resultOf(await command(orch.url, { command_id: cid(), project: p.id, text: 'добавь в шапку ещё плашку', board: board.id }));
  assert.equal(r2.seq, 2);
  assert.equal(r2.libraryAdded, undefined);
  const j2 = await journal(document, p.id, 1);
  assert.equal(j2.txs[0].ops.length, 1, 'одна операция — экземпляр');
  assert.equal(j2.txs[0].ops[0].node.of, plashka.id);
});
