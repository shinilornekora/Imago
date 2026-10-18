/**
 * Круг 38: JEV исключён из архитектуры. Команды оболочки — открытая таблица в клиенте
 * (src/shell.js); Orchestrator их не исполняет и события `shell` не шлёт. Первая стадия
 * потока 7b — `intent` («Разбираю запрос», деталь — вид работы). Явная команда редактора,
 * пришедшая агенту (старый клиент, внешний вызов API), — `result` без записи с честным
 * текстом, без модели, без чтения документа и без очереди.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startDocument, startFakeLlm, startOrch, command, createProject, journal, cid, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';
import { intentOf, isEditorCommand, EDITOR_COMMAND_TEXT } from '../../server/orchestrator/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORCH = path.join(ROOT, 'server/orchestrator');
const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

/** Все .js Orchestrator (без node_modules). */
function orchSources(dir = ORCH) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...orchSources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('круг 38: каталога jev нет, ни один модуль Orchestrator его не импортирует и не шлёт shell', () => {
  assert.equal(fs.existsSync(path.join(ORCH, 'jev')), false, 'server/orchestrator/jev удалён');
  for (const f of orchSources()) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/from\s+['"][^'"]*jev[^'"]*['"]/.test(src), `${path.relative(ROOT, f)} импортирует jev`);
    assert.ok(!/send\(\s*['"]shell['"]/.test(src), `${path.relative(ROOT, f)} шлёт событие shell`);
    assert.ok(!/\bjev\s*[.:]/.test(src), `${path.relative(ROOT, f)}: зависимость jev`);
  }
  const readme = fs.readFileSync(path.join(ORCH, 'README.md'), 'utf8');
  assert.match(readme, /intent → read → library → llm\/validate → write/);
  assert.ok(!/^\s+jev\//m.test(readme), 'в списке модулей README нет jev/');
});

test('круг 38: intentOf — команда редактора, варианты, работа агента', () => {
  // явные команды редактора: отмена/возврат, слэш-форма, фразы таблицы оболочки
  for (const t of ['отмени', 'отмени три раза', 'верни обратно', 'стоп', 'впиши всё', 'масштаб 150%', 'сними выделение', '/zoom 100', '/тема тёмная', '/масштаб 150']) {
    assert.deepEqual(intentOf(t), { kind: 'editor' }, t);
    assert.equal(isEditorCommand(t), true, t);
  }
  // режим вариантов не делает из отмены или «впиши всё» три макета
  assert.deepEqual(intentOf('отмени', { mode: 'variants', n: 3 }), { kind: 'editor' });
  assert.deepEqual(intentOf('впиши всё', { mode: 'variants', n: 3 }), { kind: 'editor' });
  // варианты — как были
  assert.deepEqual(intentOf('покажи три варианта'), { kind: 'variants', n: 3, of: '' });
  assert.deepEqual(intentOf('покажи два варианта: собери экран тарифов'), { kind: 'variants', n: 2, of: 'собери экран тарифов' });
  assert.deepEqual(intentOf('собери экран тарифов', { mode: 'variants', n: 2 }), { kind: 'variants', n: 2, of: '' });
  // работа агента: вид работы — для детали стадии и выбора промпта
  const edit = intentOf('сделай заголовок крупнее', { hasSelection: true });
  assert.equal(edit.kind, 'model');
  assert.equal(edit.needsModel, true);
  assert.equal(typeof edit.intent, 'string');
  for (const t of ['собери экран тарифов', 'повтори шапку три раза', 'сделай фон синим', 'удали заголовок']) {
    const v = intentOf(t);
    assert.equal(v.kind, 'model', t);
    assert.equal(v.needsModel, true, t);
    assert.equal(isEditorCommand(t), false, t);
  }
  // местные ответы brain без модели: проверка модели перед стартом не нужна
  for (const t of ['', '   ', '???', 'убери последнее']) {
    const v = intentOf(t);
    assert.equal(v.kind, 'model', JSON.stringify(t));
    assert.equal(v.needsModel, false, JSON.stringify(t));
  }
  assert.equal(isEditorCommand(''), false);
  assert.equal(isEditorCommand('1/2 ширины'), false);
});

test('круг 38: «отмени», «впиши всё», «/zoom 100» агенту — честный result без записи, без модели и чтения', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  for (const [text, mode] of [['отмени', 'run'], ['впиши всё', 'run'], ['/zoom 100', 'run'], ['отмени', 'variants'], ['/тема тёмная', 'variants']]) {
    const id = cid('ed');
    const r = await command(orch.url, { command_id: id, project: p.id, text, mode, n: 3 });
    assert.equal(r.status, 200, text);
    assert.deepEqual(r.events.map((e) => e.event), ['stage', 'result', 'done'], `${text}/${mode}: ${JSON.stringify(r.events)}`);
    const [stage, res] = r.events;
    assert.equal(stage.data.key, 'intent');
    assert.equal(stage.data.label, 'Разбираю запрос');
    assert.equal(stage.data.detail, 'команда редактора');
    assert.deepEqual(res.data, {
      tx_id: null, seq: null, applied: 0, dropped: [], summary: EDITOR_COMMAND_TEXT, warnings: [], editorCommand: true,
    });
    const tr = orch.traces.recent().find((x) => x.command_id === id);
    assert.equal(tr.kind, 'editor');
    assert.equal(tr.status, 'ok');
    assert.deepEqual(tr.steps.map((s) => s.key), ['intent']);
    assert.equal(tr.model_calls, 0);
  }
  assert.equal(llm.completions().length, 0, 'модель не звалась');
  assert.equal((await journal(document, p.id)).head_seq, 0, 'журнал не тронут');
});

test('круг 38: команда агента — стадии intent → read → library → llm → validate → write, деталь intent — вид работы', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const id = cid('run');
  const r = await command(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result' && e.data.seq === 1), JSON.stringify(r.events));
  assert.ok(!r.events.some((e) => e.event === 'shell'));
  const stages = r.events.filter((e) => e.event === 'stage');
  assert.equal(stages[0].data.key, 'intent', 'первая стадия — intent');
  assert.equal(stages[0].data.label, 'Разбираю запрос');
  assert.equal(stages[0].data.detail, 'создание');
  const keys = [...new Set(stages.map((e) => e.data.key))];
  for (const k of ['intent', 'read', 'library', 'llm', 'validate', 'write']) assert.ok(keys.includes(k), `${k}: ${keys}`);
  assert.ok(!keys.includes('jev'));
  assert.ok(keys.indexOf('intent') < keys.indexOf('read') && keys.indexOf('read') < keys.indexOf('library')
    && keys.indexOf('library') < keys.indexOf('llm') && keys.indexOf('llm') < keys.indexOf('write'), keys.join(','));
  const tr = orch.traces.recent().find((x) => x.command_id === id);
  assert.equal(tr.steps[0].key, 'intent');
  assert.ok(!tr.steps.some((s) => s.key === 'jev'));

  // варианты словами — стадия intent с деталью «варианты», событие variants
  const v = await command(orch.url, { command_id: cid('v'), project: p.id, text: 'покажи два варианта: собери экран тарифов' });
  const vs = v.events.filter((e) => e.event === 'stage');
  assert.equal(vs[0].data.key, 'intent');
  assert.equal(vs[0].data.detail, 'варианты');
  const items = v.events.find((e) => e.event === 'variants');
  assert.ok(items, JSON.stringify(v.events));
  assert.equal(items.data.items.length, 2);
  assert.ok(!v.events.some((e) => e.event === 'shell'));
});

test('круг 38: варианты по имени слоя («покажи варианты шапки») — режим вариантов сам, без события shell', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document); // демо: есть доска «Шапка»

  // без документа это не просьба о вариантах — узнать её можно только после чтения
  assert.equal(intentOf('покажи варианты шапки').kind, 'model');
  const id = cid('vs');
  const r = await command(orch.url, { command_id: id, project: p.id, text: 'покажи варианты шапки' });
  assert.equal(r.status, 200);
  assert.ok(!r.events.some((e) => e.event === 'shell'), JSON.stringify(r.events));
  const v = r.events.find((e) => e.event === 'variants');
  assert.ok(v, JSON.stringify(r.events.map((e) => e.event)));
  assert.equal(v.data.items.length, 3, 'по умолчанию — три варианта');
  assert.ok(!r.events.some((e) => e.event === 'result' && e.data.tx_id), 'в режиме вариантов ничего не записано');
  const tr = orch.traces.recent().find((x) => x.command_id === id);
  assert.equal(tr.mode, 'variants');
  assert.equal(tr.kind, 'variants');
  assert.equal((await journal(document, p.id)).head_seq, 0);
});
