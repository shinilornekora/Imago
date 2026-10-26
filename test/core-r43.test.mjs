import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../src/core.js';

const { ENGINE_VERSION, ENGINE_MIN_READ, FORMAT_SIGNATURE, formatSignature, createDoc, applyOps, rebase, artboards, libraryNode, expandCost, MAX_EXPANDED_NODES } = core;

/* Круг 43, CORE.
   1. Правило SPEC §8.3 «формат документа и операций меняется только вместе с
      ENGINE_VERSION» закреплено тестом: отпечаток формата (formatSignature —
      собирается из тех же таблиц, что проверка) сверяется с таблицей
      «версия движка → отпечаток».
   2. Мутант L06: операции, зависящие от create, отброшенного по пределу
      раскрытия, уходят с reason 'invalid' и limit 'expand_nodes' (не «слой уже удалён»). */

/**
 * Версия движка → отпечаток формата. ПРАВИЛО: строки старых версий не меняются
 * никогда. Изменили формат — поднимите ENGINE_VERSION в src/core.js и добавьте
 * сюда строку новой версии со значением из сообщения теста.
 * Версия 1 (до кругов 36–37) — отпечатка тогда не было.
 */
const FORMAT_HISTORY = {
  1: null,
  // круг 45: в отпечаток добавлен поведенческий корпус (behavior.*, results — что получилось), пределы тени и
  // имени контура — таблицами (limits.shadow, vector.maxPathName); проход 2 — «одетые» поля (behavior.dressed),
  // проход 3–4 — операции отмены (behavior.exact: все пробы set и операций ещё раз с exact);
  // формат тот же, состав отпечатка шире
  2: {
    hash: '2a8b20c1e7761543-hl',
    sections: {
      enums: '3d5f4badd56fba2b-fk',
      fields: 'c19ec158ee571d7a-br',
      keys: '9d176db7128ae455-ov',
      limits: '69fee4a20d4db0c8-9l',
      nodes: '7dc93e5430fcaa92-3o',
      ops: 'ed069dfdf38ec707-17',
      paths: 'b234b2d53b1b8147-3p',
      refs: 'eec439faf7e0f954-9k',
      tokens: '64506054ac161ae6-4h',
      'behavior.dressed': 'c6092bb5cc3d0433-5o',
      'behavior.exact': 'f4b8e7e582a82bfb-3ju',
      'behavior.fields': 'b776fa05a7074603-5r28',
      'behavior.nested': '8d622e246577c17e-14s9',
      'behavior.nodes': 'f67d12ae3ab43950-1i',
      'behavior.ops': '6eeb8110c37a3706-364',
      'behavior.results': '94d78a5a6ff61864-b6u',
      'behavior.svg': '3d023ee1e6c9c4bb-2z',
      'behavior.tokens': 'cd226f5ed7cee580-25s0'
    }
  }
};

test('круг43: формат документа привязан к ENGINE_VERSION — отпечаток совпадает с таблицей версий', () => {
  const now = FORMAT_SIGNATURE;
  const want = FORMAT_HISTORY[ENGINE_VERSION];
  const show = JSON.stringify({ hash: now.hash, sections: now.sections }, null, 2);
  assert.ok(want !== undefined,
    `ENGINE_VERSION = ${ENGINE_VERSION}: в FORMAT_HISTORY (test/core-r43.test.mjs) нет строки этой версии — добавьте её:\n  ${ENGINE_VERSION}: ${show}`);
  assert.ok(want, `ENGINE_VERSION = ${ENGINE_VERSION}: отпечаток не записан`);
  if (now.hash !== want.hash) {
    const changed = Object.keys({ ...want.sections, ...now.sections }).filter((k) => want.sections[k] !== now.sections[k]);
    assert.fail(`формат изменился — поднимите ENGINE_VERSION (сейчас ${ENGINE_VERSION}). Изменились разделы: ${changed.join(', ')}. `
      + `Если изменение формата задумано: ENGINE_VERSION = ${ENGINE_VERSION + 1} в src/core.js и строка в FORMAT_HISTORY:\n  ${ENGINE_VERSION + 1}: ${show}\n`
      + 'Старые строки таблицы не меняйте: по ним видно, какой формат был у какой версии.');
  }
  // версии с записанным отпечатком различаются: подняли версию — формат и правда другой
  const seen = new Map();
  for (const [v, sig] of Object.entries(FORMAT_HISTORY)) {
    if (!sig) continue;
    assert.ok(!seen.has(sig.hash), `версии ${seen.get(sig.hash)} и ${v} с одним отпечатком`);
    seen.set(sig.hash, v);
  }
  assert.ok(Number(Object.keys(FORMAT_HISTORY).sort((a, b) => b - a)[0]) <= ENGINE_VERSION, 'в таблице версия новее движка');
  assert.ok(ENGINE_MIN_READ in FORMAT_HISTORY);
});

test('круг43: отпечаток — простые данные из таблиц проверки, детерминирован', () => {
  const a = formatSignature();
  const b = formatSignature();
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'без функций и undefined');
  assert.ok(Object.isFrozen(FORMAT_SIGNATURE));
  assert.ok(Object.isFrozen(FORMAT_SIGNATURE.sections));
  // поведенческий корпус: детерминирован, без исключений, и в нём есть и приёмы, и отказы
  const beh = core.formatBehavior();
  for (const [k, bits] of Object.entries(beh)) {
    // круг 45: results — отпечатки документов после принятых проб (по 6 знаков), не биты
    if (k === 'results') { assert.match(bits, /^[0-9a-z]+$/); assert.equal(bits.length % 6, 0); continue; }
    assert.match(bits, /^[01]+$/, `behavior.${k}: проба бросила исключение`);
    assert.ok(bits.includes('0') && bits.includes('1'), `behavior.${k}: вырожденный корпус`);
    assert.equal(FORMAT_SIGNATURE.sections['behavior.' + k] !== undefined, true);
  }
  // разделы на месте и содержательны
  for (const k of ['nodes', 'fields', 'enums', 'keys', 'refs', 'tokens', 'ops', 'paths', 'limits']) assert.ok(a[k], k);
  assert.ok(a.nodes.types.includes('vector'));
  assert.deepEqual(a.fields.rules.viewBox, { only: ['vector'] });
  assert.deepEqual(a.fields.rules.states, { not: ['page'] });
  assert.ok(a.ops.includes('setToken'));
  assert.equal(a.paths.commands.A, 7);
});

test('круг43: каждое поле узлов демо, иллюстрации и примера — в отпечатке (новое поле без таблицы не проходит мимо)', () => {
  const sig = formatSignature();
  const known = new Set([...sig.fields.struct, ...sig.fields.string, ...sig.fields.bool, ...Object.keys(sig.fields.rules)]);
  const docs = [createDoc('demo'), createDoc('empty')];
  // иллюстрация (vector, градиенты, свободная рамка) — на первую доску демо
  const demo = createDoc('demo');
  const art = applyOps(demo, core.sampleIllustration({ parent: artboards(demo)[0].id }));
  assert.equal(art.error, undefined);
  docs.push(art.doc);
  // пример страницы (состояния, движение, тени, шкалы) — как его импортирует оболочка
  const page = JSON.parse(fs.readFileSync(new URL('../examples/pechenka-kliker.json', import.meta.url), 'utf8'));
  assert.equal(core.checkImportDoc(page), null);
  docs.push(page);
  let fields = 0;
  for (const d of docs) {
    for (const n of Object.values(d.nodes)) {
      for (const k of Object.keys(n)) {
        fields++;
        assert.ok(known.has(k), `поле «${k}» узла ${n.type} не описано в таблицах формата (FIELD_RULES/STRING_FIELDS/BOOL_FIELDS)`);
      }
    }
    for (const g of Object.keys(d.tokens || {})) {
      assert.ok(sig.tokens.groups.includes(g), `группа токенов «${g}» не описана в TOKEN_RULES`);
    }
  }
  assert.ok(fields > 100);
});

test('круг43: L06 — зависимые от create, отброшенного по пределу раскрытия, — invalid/expand_nodes, а не «слой уже удалён»', () => {
  const L = 9;
  const W = 3;
  let d = createDoc();
  const lib = libraryNode(d).id;
  const b = artboards(d)[0].id;
  const list = [];
  for (let i = 0; i < L; i++) list.push({ op: 'create', node: { type: 'frame', id: 'K' + i, parent: lib, name: 'K' + i, layout: { mode: 'column' }, component: { name: 'K' + i, props: [] } } });
  for (let i = 0; i < L - 1; i++) for (let k = 0; k < W; k++) list.push({ op: 'create', node: { type: 'instance', id: `i${i}_${k}`, parent: 'K' + i, of: 'K' + (i + 1) } });
  d = applyOps(d, list).doc;
  const batch = ['big0', 'big3', 'big4', 'big1', 'big2'].map((id) => ({ op: 'create', node: { type: 'instance', id, parent: b, of: 'K0' } }))
    .concat([
      { op: 'set', id: 'big2', path: 'name', value: 'Вторая копия' },
      { op: 'move', id: 'big2', parent: b, index: 0 },
      { op: 'remove', id: 'big2' },
      { op: 'set', id: 'big1', path: 'props', value: {} }
    ]);
  const r = rebase(d, batch);
  const dropped = r.dropped.map((x) => [x.op.op, x.op.id || x.op.node.id, x.reason, x.limit]);
  assert.deepEqual(dropped, [
    ['create', 'big1', 'invalid', 'expand_nodes'],
    ['create', 'big2', 'invalid', 'expand_nodes'],
    ['set', 'big2', 'invalid', 'expand_nodes'],
    ['move', 'big2', 'invalid', 'expand_nodes'],
    ['remove', 'big2', 'invalid', 'expand_nodes'],
    ['set', 'big1', 'invalid', 'expand_nodes']
  ]);
  assert.ok(!r.dropped.some((x) => x.reason === 'removed'), 'ни одного «слой уже удалён»');
  const a = applyOps(d, r.ops);
  assert.equal(a.error, undefined);
  assert.ok(expandCost(a.doc) <= MAX_EXPANDED_NODES);
});
