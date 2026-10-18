import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, applyOps, ops, rebase, collectTombstones, hashDoc, uid, ENGINE_VERSION
} from '../src/core.js';

/* Круг 22 (SPEC §8.3, §9.6): слияние транзакций. Каждая строка таблицы §9.6 —
   отдельный тест; после rebase строгий applyOps обязан пройти — это проверяет
   каждый тест через merge(). В конце — тест сходимости трёх реплик. */

const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const fixed = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });
const box = (id, parent, extra = {}) => ({ type: 'rect', id, name: id, parent, radius: 0, fill: '#cccccc', size: fixed(10, 10), ...extra });
const label = (id, parent, characters = id, extra = {}) => ({
  type: 'text', id, name: id, parent, characters, color: 'text', align: 'left', style: { token: 'body' }, size: HUG, ...extra
});
const frame = (id, parent, layout = {}, extra = {}) => ({
  type: 'frame', id, name: id, parent, children: [], radius: 0, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false, ...layout },
  ...extra
});

/** Строгое применение: ошибка — провал теста. @returns {object} документ после */
function strict(doc, list, why = '') {
  const res = applyOps(doc, list);
  assert.equal(res.error, undefined, (why ? why + ': ' : '') + JSON.stringify(res.error));
  return res.doc;
}

/** Пустая страница + доска «ab» + узлы из build. */
function scene(build) {
  let doc = createDoc('empty');
  doc = strict(doc, [ops.create(frame('ab', doc.root, { mode: 'none' }, { pos: { x: 0, y: 0 }, size: fixed(400, 300) }))]);
  return build ? strict(doc, build(doc), 'сцена') : doc;
}

/** JSON с отсортированными ключами — как stableJSON ядра (он не экспортируется). */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/** Надгробия, которые оставит транзакция, в виде Map (как ведёт их сервер). */
function tombsOf(doc, list, into = new Map()) {
  for (const [id, parent] of collectTombstones(doc, list)) into.set(id, parent);
  return into;
}

/**
 * Слияние + обязательная проверка контракта: строгий applyOps применённой
 * формы проходит, причины отброса — из перечня, вход не изменён.
 * @returns {{ops:object[], dropped:object[], notes:object[], doc:object}}
 */
function merge(head, list, tombstones) {
  const before = JSON.stringify(list);
  const res = rebase(head, list, { tombstones });
  assert.equal(JSON.stringify(list), before, 'rebase не меняет входные операции');
  for (const d of res.dropped) {
    assert.ok(['removed', 'exists', 'orphan', 'cycle', 'invalid'].includes(d.reason), 'причина из перечня: ' + d.reason);
    assert.equal(list[d.index], d.op, 'dropped.op — исходная операция по индексу');
  }
  for (const op of res.ops) assert.ok(!('after' in op), 'в применённой форме нет after: ' + JSON.stringify(op));
  const doc = strict(head, res.ops, 'после rebase строгий applyOps обязан пройти');
  return { ...res, doc };
}

/** Замораживает объект вглубь — любая запись в него бросит в strict-модуле. */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/* ------------------------------ §9.6: set ------------------------------ */

test('§9.6 set: узел жив — остаётся; поздняя по seq побеждает на уровне листа', () => {
  const base = scene(() => [ops.create(frame('card', 'ab', { gap: 4, padding: { t: 8, r: 8, b: 8, l: 8 } }))]);
  // голова: чужая правка padding.t прошла раньше
  const head = strict(base, [ops.set('card', 'layout.padding.t', 24)]);
  const mine = [ops.set('card', 'layout.gap', 12), ops.set('card', 'name', 'Карточка')];
  const m = merge(head, mine);
  assert.equal(m.dropped.length, 0);
  assert.equal(m.ops.length, 2);
  assert.equal(m.doc.nodes.card.layout.gap, 12, 'моя правка применилась');
  assert.equal(m.doc.nodes.card.layout.padding.t, 24, 'чужой padding цел');
  // тот же лист с двух сторон: побеждает та, что позже по seq
  const first = strict(base, [ops.set('card', 'name', 'от А')]);
  const second = merge(first, [ops.set('card', 'name', 'от Б')]);
  assert.equal(second.doc.nodes.card.name, 'от Б');
});

test('§9.6 set: keepFieldForm действует при применении, а в журнал ложится операция как прислана', () => {
  const base = scene(() => [ops.create(frame('card', 'ab', { gap: 'spacing.6' }))]);
  const m = merge(base, [ops.set('card', 'layout.gap', 16)]);
  assert.equal(m.doc.nodes.card.layout.gap, 'spacing.6', 'число, равное шагу, оставляет ссылку (§6.4)');
  assert.equal(m.ops[0].value, 16, 'применённая форма не переписана');
  // переигрывание журнала даёт тот же документ
  assert.equal(hashDoc(strict(base, m.ops)), hashDoc(m.doc));
});

test('§9.6 set: узел удалён — dropped removed (remove побеждает), остальное транзакции живёт', () => {
  const base = scene(() => [ops.create(frame('card', 'ab')), ops.create(label('t', 'card')), ops.create(box('b', 'ab'))]);
  const head = strict(base, [ops.remove('card')]);
  const tomb = tombsOf(base, [ops.remove('card')]);
  const m = merge(head, [ops.set('t', 'characters', 'новый'), ops.set('b', 'fill', '#ff0000'), ops.set('card', 'name', 'x')], tomb);
  assert.deepEqual(m.dropped.map((d) => [d.index, d.reason]), [[0, 'removed'], [2, 'removed']]);
  assert.equal(m.ops.length, 1);
  assert.equal(m.doc.nodes.b.fill, '#ff0000', 'правка живого узла из той же транзакции прошла');
});

/* ------------------------------ §9.6: setToken ------------------------------ */

test('§9.6 setToken: остаётся всегда — и когда группу правили параллельно', () => {
  const base = createDoc('empty');
  const head = strict(base, [ops.setToken('colors.surface', '#000000'), ops.setToken('spacing.6', 18)]);
  const m = merge(head, [ops.setToken('colors.accent', '#0000ff'), ops.setToken('spacing.6', 20), ops.setToken('colors.fresh', '#123456')]);
  assert.equal(m.dropped.length, 0);
  assert.equal(m.ops.length, 3);
  assert.equal(m.doc.tokens.colors.accent, '#0000ff');
  assert.equal(m.doc.tokens.colors.surface, '#000000', 'чужая правка группы цела');
  assert.equal(m.doc.tokens.spacing[6], 20, 'тот же шаг — поздний побеждает');
  assert.equal(m.doc.tokens.colors.fresh, '#123456');
});

/* ------------------------------ §9.6: create ------------------------------ */

test('§9.6 create: id занят — dropped exists (повтор той же транзакции)', () => {
  const base = scene();
  const tx = [ops.create(label('t', 'ab'))];
  const head = strict(base, tx);
  const again = merge(head, tx);
  assert.deepEqual(again.dropped.map((d) => d.reason), ['exists']);
  assert.equal(again.ops.length, 0);
  assert.equal(hashDoc(again.doc), hashDoc(head), 'повтор ничего не меняет');
});

test('§9.6 create: родитель жив — after разрешается в индекс после соседа, after уходит из применённой формы', () => {
  const base = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab')), ops.create(box('c', 'ab'))]);
  const m = merge(base, [{ ...ops.create(label('t', 'ab')), after: 'a' }]);
  assert.equal(m.dropped.length, 0);
  assert.equal(m.ops[0].index, 1);
  assert.equal('after' in m.ops[0], false);
  assert.deepEqual(m.doc.nodes.ab.children, ['a', 't', 'b', 'c']);
  // after: null — первым
  const first = merge(base, [{ ...ops.create(label('t0', 'ab')), after: null, index: 2 }]);
  assert.equal(first.ops[0].index, 0, 'after важнее index');
  assert.deepEqual(first.doc.nodes.ab.children, ['t0', 'a', 'b', 'c']);
  // after важнее index и когда сосед на месте
  const both = merge(base, [{ ...ops.create(label('t1', 'ab')), after: 'c', index: 0 }]);
  assert.deepEqual(both.doc.nodes.ab.children, ['a', 'b', 'c', 't1']);
});

test('§9.6 create: сосед из after удалён — берётся index с зажимом, без index — конец', () => {
  const base = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab')), ops.create(box('c', 'ab'))]);
  const head = strict(base, [ops.remove('b')]);
  const tomb = tombsOf(base, [ops.remove('b')]);
  const byIndex = merge(head, [{ ...ops.create(label('t', 'ab')), after: 'b', index: 1 }], tomb);
  assert.equal(byIndex.ops[0].index, 1);
  assert.deepEqual(byIndex.doc.nodes.ab.children, ['a', 't', 'c']);
  const clamped = merge(head, [{ ...ops.create(label('t2', 'ab')), after: 'b', index: 99 }], tomb);
  assert.equal(clamped.ops[0].index, 2, 'index зажат в границы');
  const toEnd = merge(head, [{ ...ops.create(label('t3', 'ab')), after: 'b' }], tomb);
  assert.deepEqual(toEnd.doc.nodes.ab.children, ['a', 'c', 't3'], 'без index — в конец');
  // сосед жив, но переехал в другой контейнер — то же, что удалён
  const moved = strict(scene(() => [ops.create(box('a', 'ab')), ops.create(frame('f', 'ab')), ops.create(box('b', 'ab'))]), [ops.move('b', 'f', 0)]);
  const m2 = merge(moved, [{ ...ops.create(label('t4', 'ab')), after: 'b', index: 0 }]);
  assert.deepEqual(m2.doc.nodes.ab.children, ['t4', 'a', 'f']);
});

test('§9.6 create: дети, которых уже нет, вычёркиваются; остальные усыновляются', () => {
  const base = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab')), ops.create(box('c', 'ab'))]);
  const head = strict(base, [ops.remove('b')]);
  const tomb = tombsOf(base, [ops.remove('b')]);
  const m = merge(head, [ops.create(frame('wrap', 'ab', {}, { children: ['a', 'b', 'призрак'] }), 0)], tomb);
  assert.equal(m.dropped.length, 0);
  assert.deepEqual(m.ops[0].node.children, ['a'], 'только живые дети');
  assert.deepEqual(m.doc.nodes.wrap.children, ['a']);
  assert.equal(m.doc.nodes.a.parent, 'wrap');
  assert.deepEqual(m.doc.nodes.ab.children, ['wrap', 'c']);
});

test('§9.6 create: ребёнок, ставший из-за чужого move предком родителя, вычёркивается — create не пропадает', () => {
  const base = scene(() => [ops.create(frame('x', 'ab')), ops.create(frame('p', 'ab')), ops.create(box('a', 'ab'))]);
  // на сервере p уехал внутрь x; клиент на старой базе группирует x и a во фрейм внутри p
  const head = strict(base, [ops.move('p', 'x', 0)]);
  const m = merge(head, [ops.create(frame('wrap', 'p', {}, { children: ['x', 'a'] }))]);
  assert.equal(m.dropped.length, 0);
  assert.deepEqual(m.ops[0].node.children, ['a'], 'x — предок p, усыновить его нельзя');
  assert.deepEqual(m.doc.nodes.wrap.children, ['a']);
  assert.equal(m.doc.nodes.a.parent, 'wrap');
  assert.equal(m.doc.nodes.x.parent, 'ab', 'x остался на месте');
  assert.deepEqual(m.doc.nodes.ab.children, ['x']);
  // сам родитель в детях — тоже вычёркивается; а раз группировать больше нечего — create
  // отброшен (круг 39: пустая группа не создаётся), причина — цикл
  const self = merge(head, [ops.create(frame('w2', 'p', {}, { children: ['p'] }))]);
  assert.deepEqual(self.dropped.map((d) => [d.index, d.reason]), [[0, 'cycle']]);
  assert.deepEqual(self.ops, []);
  assert.ok(!self.doc.nodes.w2);
});

test('§9.6 create: родитель удалён — переприкрепление к ближайшему живому предку по цепочке надгробий, в конец', () => {
  const base = scene(() => [
    ops.create(frame('g', 'ab')), ops.create(frame('p', 'g')), ops.create(box('z', 'ab'))
  ]);
  // на сервере удалили g целиком: надгробия g→ab, p→g
  const head = strict(base, [ops.remove('g')]);
  const tomb = tombsOf(base, [ops.remove('g')]);
  assert.deepEqual([...tomb.entries()], [['g', 'ab'], ['p', 'g']]);
  const m = merge(head, [{ ...ops.create(label('t', 'p')), after: null, index: 0 }], tomb);
  assert.equal(m.dropped.length, 0);
  assert.deepEqual(m.notes, [{ index: 0, note: 'reparented' }]);
  assert.equal(m.ops[0].node.parent, 'ab');
  assert.equal(m.ops[0].index, 1, 'место у старого родителя ничего не значит — в конец');
  assert.deepEqual(m.doc.nodes.ab.children, ['z', 't']);
  assert.equal(m.doc.nodes.t.parent, 'ab');
});

test('§9.6 create: живых предков нет — dropped orphan', () => {
  const base = scene();
  // родитель неизвестен и надгробий о нём нет
  const unknown = merge(base, [ops.create(label('t', 'нет-такого'))]);
  assert.deepEqual(unknown.dropped.map((d) => d.reason), ['orphan']);
  // цепочка надгробий обрывается в null
  const chain = merge(base, [ops.create(label('t2', 'p'))], new Map([['p', 'g'], ['g', null]]));
  assert.deepEqual(chain.dropped.map((d) => d.reason), ['orphan']);
  // цепочка надгробий с петлёй тоже не зацикливает
  const loop = merge(base, [ops.create(label('t3', 'p'))], new Map([['p', 'g'], ['g', 'p']]));
  assert.deepEqual(loop.dropped.map((d) => d.reason), ['orphan']);
});

/* ------------------------------ §9.6: remove ------------------------------ */

test('§9.6 remove: узел жив — остаётся (и уносит поддерево, выросшее у других)', () => {
  const base = scene(() => [ops.create(frame('card', 'ab')), ops.create(label('t', 'card'))]);
  const head = strict(base, [ops.create(label('fresh', 'card'))]);
  const m = merge(head, [ops.remove('card')]);
  assert.equal(m.dropped.length, 0);
  assert.equal(m.doc.nodes.card, undefined);
  assert.equal(m.doc.nodes.fresh, undefined, 'чужой ребёнок ушёл вместе с поддеревом');
  assert.deepEqual(m.doc.nodes.ab.children, []);
});

test('§9.6 remove: уже удалён — dropped removed (в том числе узел внутри удалённого поддерева)', () => {
  const base = scene(() => [ops.create(frame('card', 'ab')), ops.create(label('t', 'card'))]);
  const head = strict(base, [ops.remove('card')]);
  const tomb = tombsOf(base, [ops.remove('card')]);
  const m = merge(head, [ops.remove('card'), ops.remove('t')], tomb);
  assert.deepEqual(m.dropped.map((d) => d.reason), ['removed', 'removed']);
  assert.equal(m.ops.length, 0);
  assert.equal(hashDoc(m.doc), hashDoc(head));
});

/* ------------------------------ §9.6: move ------------------------------ */

test('§9.6 move: узел удалён — dropped removed', () => {
  const base = scene(() => [ops.create(frame('f', 'ab')), ops.create(box('a', 'ab'))]);
  const head = strict(base, [ops.remove('a')]);
  const m = merge(head, [ops.move('a', 'f', 0)], tombsOf(base, [ops.remove('a')]));
  assert.deepEqual(m.dropped.map((d) => d.reason), ['removed']);
});

test('§9.6 move: новый родитель удалён — ближайший живой предок (в конец, notes reparented), иначе orphan', () => {
  const base = scene(() => [
    ops.create(frame('g', 'ab')), ops.create(frame('p', 'g')), ops.create(box('a', 'ab')), ops.create(box('z', 'ab'))
  ]);
  const head = strict(base, [ops.remove('g')]);
  const tomb = tombsOf(base, [ops.remove('g')]);
  const m = merge(head, [{ ...ops.move('a', 'p', 0), after: null }], tomb);
  assert.equal(m.dropped.length, 0);
  assert.deepEqual(m.notes, [{ index: 0, note: 'reparented' }]);
  assert.equal(m.ops[0].parent, 'ab');
  assert.deepEqual(m.doc.nodes.ab.children, ['z', 'a'], 'в конец нового родителя');
  assert.equal(m.doc.nodes.a.parent, 'ab');
  const orphan = merge(head, [ops.move('a', 'нет-такого', 0)], tomb);
  assert.deepEqual(orphan.dropped.map((d) => d.reason), ['orphan']);
});

test('§9.6 move: цель внутри собственного поддерева — dropped cycle; отбрасывается только поздний', () => {
  const base = scene(() => [ops.create(frame('x', 'ab')), ops.create(frame('y', 'ab')), ops.create(frame('inner', 'x'))]);
  // прямой цикл: x внутрь своего же inner
  const direct = merge(base, [ops.move('x', 'inner', 0)]);
  assert.deepEqual(direct.dropped.map((d) => d.reason), ['cycle']);
  const self = merge(base, [ops.move('x', 'x', 0)]);
  assert.deepEqual(self.dropped.map((d) => d.reason), ['cycle']);
  // из-за чужого move цель оказалась внутри узла: на сервере x уехал в y, а
  // клиент на старой базе (x и y — соседи) двигает y в x
  const head = strict(base, [ops.move('x', 'y', 0)]);
  const late = merge(head, [ops.move('y', 'x', 0)]);
  assert.deepEqual(late.dropped.map((d) => d.reason), ['cycle']);
  assert.equal(late.doc.nodes.x.parent, 'y', 'ранний move остался');
  assert.deepEqual(late.doc.nodes.ab.children, ['y']);
});

test('§9.6 move: after → индекс без самого узла, как считает applyOps; иначе index с зажимом', () => {
  const base = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab')), ops.create(box('c', 'ab')), ops.create(box('x', 'ab'))]);
  const fwd = merge(base, [{ ...ops.move('x', 'ab'), after: 'b' }]);
  assert.equal(fwd.ops[0].index, 2);
  assert.deepEqual(fwd.doc.nodes.ab.children, ['a', 'b', 'x', 'c']);
  const back = merge(base, [{ ...ops.move('a', 'ab'), after: 'c' }]);
  assert.equal(back.ops[0].index, 2, 'сам узел в списке не считается');
  assert.deepEqual(back.doc.nodes.ab.children, ['b', 'c', 'a', 'x']);
  const first = merge(base, [{ ...ops.move('x', 'ab', 3), after: null }]);
  assert.deepEqual(first.doc.nodes.ab.children, ['x', 'a', 'b', 'c']);
  const afterSelf = merge(base, [{ ...ops.move('x', 'ab', 0), after: 'x' }]);
  assert.deepEqual(afterSelf.doc.nodes.ab.children, ['x', 'a', 'b', 'c'], 'after на себя — как отсутствующий сосед: index');
  const clamped = merge(base, [ops.move('a', 'ab', 99)]);
  assert.equal(clamped.ops[0].index, 3);
  assert.deepEqual(clamped.doc.nodes.ab.children, ['b', 'c', 'x', 'a']);
  const noIndex = merge(base, [{ op: 'move', id: 'a', parent: 'ab' }]);
  assert.deepEqual(noIndex.doc.nodes.ab.children, ['b', 'c', 'x', 'a'], 'без index и after — в конец');
});

/* ------------------------------ контракт ------------------------------ */

test('rebase не бросает на мусоре: null, объект без op, create без узла и без id — invalid', () => {
  const base = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab'))]);
  const junk = [
    null, undefined, 7, 'set', {}, { op: 'зачем' }, { op: 'create' }, { op: 'create', node: null },
    { op: 'create', node: { type: 'text', parent: 'ab', characters: 'без id', size: HUG } },
    { op: 'set', path: 'fill', value: '#000' }, { op: 'remove' }, { op: 'move', parent: 'ab' },
    { op: 'set', id: 'a', path: 'id', value: 'взлом' }, { op: 'setToken', path: 'colors' },
    ops.move('a', 'b', 0),   // родитель не контейнер — отклоняет applyOps
    ops.create({ type: 'осьминог', id: 'o', parent: 'ab', size: HUG })
  ];
  let res;
  assert.doesNotThrow(() => { res = rebase(base, junk); });
  assert.equal(res.ops.length, 0);
  assert.equal(res.dropped.length, junk.length);
  assert.ok(res.dropped.every((d) => d.reason === 'invalid'), JSON.stringify(res.dropped.map((d) => d.reason)));
  assert.deepEqual(res.dropped.map((d) => d.index), junk.map((_, i) => i));
  // и на мусоре вместо документа или списка
  assert.deepEqual(rebase(null, [ops.remove('a')]).dropped.map((d) => d.reason), ['invalid']);
  assert.deepEqual(rebase(base, null), { ops: [], dropped: [], notes: [] });
  assert.deepEqual(rebase(base, ops.remove('a')).ops.length, 1, 'одиночная операция — как список из одной');
  // живая операция среди мусора применяется
  const mixed = rebase(base, [null, ops.set('a', 'fill', '#ff0000'), { op: 'нет' }]);
  assert.equal(mixed.ops.length, 1);
  assert.deepEqual(mixed.dropped.map((d) => d.index), [0, 2]);
  strict(base, mixed.ops);
});

test('rebase детерминирован и не мутирует вход: два вызова на одинаковых (замороженных) входах равны', () => {
  const base = scene(() => [ops.create(frame('g', 'ab')), ops.create(box('a', 'g')), ops.create(box('b', 'ab'))]);
  const head = strict(base, [ops.remove('g')]);
  const tomb = tombsOf(base, [ops.remove('g')]);
  const mk = () => deepFreeze([
    ops.set('a', 'fill', '#ff0000'),
    { ...ops.create(label('t', 'g')), after: 'a' },
    { ...ops.move('b', 'g', 0), after: null },
    ops.create(frame('w', 'ab', {}, { children: ['b', 'a'] })),
    { ...ops.create(box('n', 'ab')), after: 'b' },
    ops.setToken('colors.accent', '#00ff00'),
    ops.remove('a'),
    ops.create(label('t', 'ab'))
  ]);
  const ops1 = mk();
  const ops2 = mk();
  let r1, r2;
  assert.doesNotThrow(() => { r1 = rebase(head, ops1, { tombstones: tomb }); });
  assert.doesNotThrow(() => { r2 = rebase(head, ops2, { tombstones: new Map(tomb) }); });
  assert.equal(stable(r1), stable(r2));
  assert.equal(stable(ops1), stable(ops2), 'вход не изменился');
  assert.equal(stable(strict(head, r1.ops)), stable(strict(head, r2.ops)));
  assert.equal(hashDoc(strict(head, r1.ops)), hashDoc(strict(head, r2.ops)));
  // надгробия объектом — то же, что Map
  const r3 = rebase(head, mk(), { tombstones: Object.fromEntries(tomb) });
  assert.equal(stable(r3), stable(r1));
});

test('collectTombstones: все узлы поддерева с родителями до применения, родитель раньше детей', () => {
  const base = scene(() => [ops.create(frame('g', 'ab')), ops.create(frame('p', 'g')), ops.create(label('t', 'p')), ops.create(box('z', 'ab'))]);
  // move до remove: надгробие хранит родителя НА МОМЕНТ удаления, а не исходный
  const tx = [ops.set('z', 'fill', '#000'), ops.move('z', 'p', 0), ops.remove('g')];
  assert.deepEqual(collectTombstones(base, tx), [['g', 'ab'], ['p', 'g'], ['z', 'p'], ['t', 'p']]);
  assert.deepEqual(collectTombstones(base, []), []);
  assert.deepEqual(collectTombstones(null, tx), []);
  // вход — применённая форма; неприменимая операция обрывает сбор, но не бросает
  assert.deepEqual(collectTombstones(base, [ops.remove('g'), ops.remove('g'), ops.remove('z')]), [['g', 'ab'], ['p', 'g'], ['t', 'p']]);
  assert.doesNotThrow(() => collectTombstones(base, [null, ops.remove('g')]));
  // надгробия из журнала восстанавливают живого предка через два уровня
  const head = strict(base, tx);
  const m = merge(head, [ops.create(label('n', 't'))], tombsOf(base, tx));
  assert.deepEqual(m.notes, [{ index: 0, note: 'reparented' }]);
  assert.equal(m.ops[0].node.parent, 'ab');
});

/* ------------------------------ hashDoc и uid ------------------------------ */

test('hashDoc: порядок ключей, version и meta не влияют; порядок детей — влияет', () => {
  const doc = scene(() => [ops.create(box('a', 'ab')), ops.create(box('b', 'ab'))]);
  const h = hashDoc(doc);
  assert.match(h, /^[0-9a-f]{16}-[0-9a-z]+$/);
  // те же узлы, ключи в другом порядке
  const shuffled = {
    ...doc,
    nodes: Object.fromEntries(Object.keys(doc.nodes).reverse().map((id) => {
      const n = doc.nodes[id];
      return [id, Object.fromEntries(Object.keys(n).reverse().map((k) => [k, n[k]]))];
    }))
  };
  assert.equal(hashDoc(shuffled), h, 'порядок ключей не важен');
  assert.equal(hashDoc({ ...doc, version: 999, meta: { name: 'другое', createdAt: 'вчера' } }), h, 'version и meta — не содержание');
  assert.equal(hashDoc(JSON.parse(JSON.stringify(doc))), h, 'через JSON — тот же');
  const reordered = strict(doc, [ops.move('b', 'ab', 0)]);
  assert.notEqual(hashDoc(reordered), h, 'порядок детей — содержание');
  assert.notEqual(hashDoc(strict(doc, [ops.set('a', 'fill', '#000000')])), h);
  assert.notEqual(hashDoc(strict(doc, [ops.setToken('colors.accent', '#000000')])), h, 'токены — содержание');
  assert.equal(hashDoc(null), '0');
  assert.equal(hashDoc({}), '0');
  assert.equal(typeof ENGINE_VERSION, 'number');
});

test('uid: 10 000 подряд уникальны и по форме «префикс_12+ base36»', () => {
  const seen = new Set();
  const re = /^[a-z]+_[0-9a-z]{12,}$/;
  for (let i = 0; i < 10000; i++) {
    const id = i % 3 === 0 ? uid('tx') : i % 3 === 1 ? uid() : uid('f');
    assert.match(id, re);
    assert.ok(!seen.has(id), 'повтор: ' + id);
    seen.add(id);
  }
  assert.equal(seen.size, 10000);
  assert.match(uid('tx'), /^tx_/);
  assert.match(uid(), /^n_/);
});

/* ------------------------------ сходимость ------------------------------ */

/** Линейный конгруэнтный генератор — свой, чтобы прогон был воспроизводим. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('сходимость: три реплики, случайные операции, случайный порядок доставки — один документ у всех (200 раундов)', () => {
  const rnd = lcg(220926);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const chance = (p) => rnd() < p;
  const started = Date.now();

  const seed = createDoc();
  const server = { doc: seed, seq: 0, journal: [], tomb: new Map() };
  const mkReplica = (name) => ({ name, confirmed: seed, seq: 0, tomb: new Map(), view: seed, viewTomb: new Map(), pending: [], n: 0 });
  const replicas = [mkReplica('r0'), mkReplica('r1'), mkReplica('r2')];

  /** Случайная операция относительно ВИДА реплики. */
  const genOp = (d, r) => {
    const ids = Object.keys(d.nodes);
    const containers = ids.filter((id) => d.nodes[id].type === 'frame' || d.nodes[id].type === 'page');
    const frames = ids.filter((id) => d.nodes[id].type === 'frame');
    const notRoot = ids.filter((id) => id !== d.root);
    const placement = (parent, self) => {
      const kids = (d.nodes[parent].children || []).filter((c) => c !== self);
      const out = {};
      if (chance(0.6)) out.after = chance(0.2) || !kids.length ? null : pick(kids);
      if (chance(0.5)) out.index = Math.floor(rnd() * (kids.length + 2));
      return out;
    };
    const roll = rnd();
    if (roll < 0.30) {
      const kind = rnd();
      if (kind < 0.34 && frames.length) return { op: 'set', id: pick(frames), path: 'layout.gap', value: pick([0, 4, 8, 12, 'spacing.6', 'spacing.8']) };
      if (kind < 0.67) return { op: 'set', id: pick(notRoot), path: 'fill', value: pick(['accent', 'surface', '#123456', { token: 'accentSoft' }]) };
      return { op: 'set', id: pick(ids), path: 'name', value: r.name + '·' + (r.n++) };
    }
    if (roll < 0.62) {
      const parent = pick(containers);
      const id = r.name + '_' + (r.n++);
      const node = chance(0.6)
        ? label(id, parent, 'текст ' + id)
        : frame(id, parent, { mode: pick(['row', 'column']), gap: pick([0, 'spacing.4']) });
      // «сгруппировать»: фрейм усыновляет случайный узел — на голове его может уже не быть
      if (node.type === 'frame' && chance(0.4)) node.children = [...new Set([pick(notRoot), pick(notRoot)])];
      return { op: 'create', node, ...placement(parent, null) };
    }
    if (roll < 0.72) {
      // нелистовые узлы — чтобы надгробия образовывали цепочки
      const branches = notRoot.filter((id) => (d.nodes[id].children || []).length > 0);
      return { op: 'remove', id: pick(branches.length && chance(0.7) ? branches : notRoot) };
    }
    if (roll < 0.92) {
      const id = pick(notRoot);
      const parent = pick(containers);
      return { op: 'move', id, parent, ...placement(parent, id) };
    }
    return chance(0.5)
      ? { op: 'setToken', path: 'colors.accent', value: pick(['#ff0000', '#00ff00', '#0000ff']) }
      : { op: 'setToken', path: 'spacing.6', value: pick([14, 16, 18]) };
  };

  /** view = replay(confirmed, pending): те же rebase + applyOps, что на сервере; надгробия своих
      неподтверждённых remove пополняются по ходу — как сделает сервер, принимая очередь по одной. */
  const replay = (r) => {
    let doc = r.confirmed;
    const tomb = new Map(r.tomb);
    for (const tx of r.pending) {
      const m = rebase(doc, tx.ops, { tombstones: tomb });
      for (const [id, parent] of collectTombstones(doc, m.ops)) tomb.set(id, parent);
      const res = applyOps(doc, m.ops);
      assert.equal(res.error, undefined, 'replay на клиенте: ' + JSON.stringify(res.error));
      doc = res.doc;
    }
    return { doc, tomb };
  };

  const stats = { txs: 0, ops: 0, dropped: {}, reparented: 0, predicted: 0, maxNodes: 0 };
  const REASONS = ['removed', 'exists', 'orphan', 'cycle', 'invalid'];
  let txCounter = 0;

  for (let round = 0; round < 200; round++) {
    // 1. каждая реплика строит транзакцию относительно своего вида
    for (const r of replicas) {
      const count = 1 + Math.floor(rnd() * 3);
      const tx = { id: 'tx' + (txCounter++), ops: [], baseSeq: r.seq, localOps: [] };
      for (let k = 0; k < count; k++) {
        const op = genOp(r.view, r);
        const local = rebase(r.view, [op], { tombstones: r.viewTomb });
        if (!local.ops.length) continue;   // на своём виде не применилась — не отправляем
        for (const [id, parent] of collectTombstones(r.view, local.ops)) r.viewTomb.set(id, parent);
        const res = applyOps(r.view, local.ops);
        assert.equal(res.error, undefined, 'локальное применение: ' + JSON.stringify(res.error));
        r.view = res.doc;
        tx.ops.push(op);
        tx.localOps.push(...local.ops);
      }
      if (!tx.ops.length) continue;
      tx.hashAfter = hashDoc(r.view);
      r.pending.push(tx);
    }

    // 2. сервер принимает очереди реплик в случайном порядке (внутри очереди —
    //    по порядку отправки); часть реплик в этом раунде «не дозвонилась» —
    //    их очередь ждёт следующего раунда и переигрывается поверх чужих правок
    const order = replicas.filter((r) => r.pending.length && chance(0.75));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const accepted = [];
    for (const r of order) for (const tx of r.pending) accepted.push(tx);
    for (const tx of accepted) {
      const headBefore = server.doc;
      const seqBefore = server.seq;
      const merged = rebase(headBefore, tx.ops, { tombstones: server.tomb });
      for (const [id, parent] of collectTombstones(headBefore, merged.ops)) server.tomb.set(id, parent);
      const res = applyOps(headBefore, merged.ops);
      assert.equal(res.error, undefined, 'сервер: после rebase строгий applyOps обязан пройти: ' + JSON.stringify(res.error));
      server.doc = res.doc;
      server.seq += 1;
      server.journal.push({ seq: server.seq, txId: tx.id, ops: merged.ops });
      stats.txs++;
      stats.ops += merged.ops.length;
      for (const d of merged.dropped) {
        assert.ok(REASONS.includes(d.reason));
        stats.dropped[d.reason] = (stats.dropped[d.reason] || 0) + 1;
      }
      stats.reparented += merged.notes.length;
      // между базой и головой чужих транзакций не было — клиент угадал сервер точно
      if (seqBefore === tx.baseSeq) {
        stats.predicted++;
        assert.equal(stable(merged.ops), stable(tx.localOps), 'применённая форма совпала с клиентской');
        assert.equal(hashDoc(server.doc), tx.hashAfter, 'вид клиента совпал с головой сервера');
      }
    }

    // 3. реплики догоняют журнал строгим applyOps, свои транзакции узнают по id
    for (const r of replicas) {
      for (const entry of server.journal) {
        if (entry.seq <= r.seq) continue;
        for (const [id, parent] of collectTombstones(r.confirmed, entry.ops)) r.tomb.set(id, parent);
        const res = applyOps(r.confirmed, entry.ops);
        assert.equal(res.error, undefined, 'реплика ' + r.name + ' догоняет: ' + JSON.stringify(res.error));
        r.confirmed = res.doc;
        r.seq = entry.seq;
        if (r.pending.length && r.pending[0].id === entry.txId) r.pending.shift();
      }
      const rp = replay(r);
      r.view = rp.doc;
      r.viewTomb = rp.tomb;
      stats.maxNodes = Math.max(stats.maxNodes, Object.keys(r.view.nodes).length);
    }
    if (round % 10 === 9) {
      for (const r of replicas) {
        assert.equal(hashDoc(r.confirmed), hashDoc(server.doc), 'раунд ' + round + ': подтверждённое у ' + r.name + ' = голова сервера');
        if (!r.pending.length) assert.equal(hashDoc(r.view), hashDoc(server.doc), 'без очереди вид = голова');
      }
    }
  }

  // хвост очередей — сервер принимает всё, что осталось
  for (const r of replicas) {
    while (r.pending.length) {
      const tx = r.pending.shift();
      const merged = rebase(server.doc, tx.ops, { tombstones: server.tomb });
      for (const [id, parent] of collectTombstones(server.doc, merged.ops)) server.tomb.set(id, parent);
      server.doc = strict(server.doc, merged.ops, 'хвост');
      server.seq += 1;
      server.journal.push({ seq: server.seq, txId: tx.id, ops: merged.ops });
    }
  }
  // каждая реплика переигрывает журнал с нуля — совпадает с сервером и друг с другом
  const hashes = replicas.map(() => {
    let doc = seed;
    for (const entry of server.journal) doc = strict(doc, entry.ops, 'переигрывание seq ' + entry.seq);
    return hashDoc(doc);
  });
  assert.equal(new Set(hashes).size, 1);
  assert.equal(hashes[0], hashDoc(server.doc));
  assert.equal(server.journal.length, server.seq);
  assert.equal(hashDoc(seed), hashDoc(createDoc(JSON.parse(JSON.stringify(seed)))), 'снимок через JSON — тот же документ');

  // прогон действительно упирался в конфликты, а не гладко складывал правки
  assert.ok(stats.txs >= 400, 'транзакций: ' + stats.txs);
  assert.ok((stats.dropped.removed || 0) >= 5, 'были отбросы removed: ' + JSON.stringify(stats.dropped));
  assert.ok(stats.reparented >= 1, 'были переприкрепления: ' + stats.reparented);
  assert.ok(stats.predicted >= 50, 'клиент предсказывал сервер: ' + stats.predicted);
  assert.equal(stats.dropped.invalid || undefined, undefined, 'invalid на сервере — признак расхождения клиента и сервера: ' + JSON.stringify(stats.dropped));
  // круг 29: порог с запасом — под нагрузкой соседних прогонов 2 с флапали (обычно ~1 с)
  assert.ok(Date.now() - started < 10000, 'прогон уложился в 10 с: ' + (Date.now() - started) + ' мс');
});

test('сходимость: replay(confirmed, pending) на клиенте = сервер, когда подтверждённое клиента и есть голова', () => {
  const base = scene(() => [
    ops.create(frame('card', 'ab', { gap: 4 })), ops.create(label('t', 'card')), ops.create(box('b', 'ab')), ops.create(box('c', 'ab'))
  ]);
  // чужой remove уже подтверждён: и клиент, и сервер знают одни надгробия
  const foreign = [ops.remove('card')];
  const tomb = tombsOf(base, foreign);
  const confirmed = strict(base, foreign);
  // очередь клиента строилась ещё на base: create в card и move после t — оба про удалённое
  const pending = [
    [{ ...ops.create(label('n', 'card')), after: 't' }, ops.set('t', 'characters', 'поздно'), ops.set('b', 'fill', '#ff0000')],
    [{ ...ops.move('c', 'card', 0), after: 't' }, { ...ops.move('b', 'ab', 5), after: null }, ops.setToken('colors.accent', '#000000')]
  ];
  const run = (start, tombs, collect) => {
    let doc = start;
    const applied = [];
    for (const tx of pending) {
      const m = rebase(doc, tx, { tombstones: tombs });
      if (collect) for (const [id, parent] of collectTombstones(doc, m.ops)) tombs.set(id, parent);
      applied.push(m);
      doc = strict(doc, m.ops);
    }
    return { doc, applied };
  };
  const client = run(confirmed, new Map(tomb), false);   // §9.5: те же rebase + applyOps
  const server = run(confirmed, new Map(tomb), true);    // §9.4: надгробия пополняются до применения
  assert.equal(stable(server.applied), stable(client.applied), 'применённая форма, отбросы и пометки совпали');
  assert.equal(hashDoc(client.doc), hashDoc(server.doc));
  assert.deepEqual(server.applied[0].notes, [{ index: 0, note: 'reparented' }]);
  assert.deepEqual(server.applied[0].dropped.map((d) => d.reason), ['removed']);
  assert.deepEqual(server.applied[1].notes, [{ index: 0, note: 'reparented' }]);
  assert.equal(server.doc.nodes.n.parent, 'ab');
  // n и c переприкреплены в конец доски (n раньше c), b с after:null встал первым
  assert.deepEqual(server.doc.nodes.ab.children, ['b', 'n', 'c']);
});
