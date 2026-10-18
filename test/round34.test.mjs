import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand } from '../src/brain.js';

/* Круг 34. Имя пропса компонента — один сегмент пути `props.<имя>` у экземпляра:
   точка в имени (`a.b`, `a.`) давала пустой сегмент или лишний уровень, ключ
   прототипа — защищённый путь. Ядро такие имена не принимает (checkComponent:
   create, set, checkImportDoc; createDoc чинит, выбрасывая пропс), brain их не
   предлагает. И слова brain для человека — «слой», а не «узел». */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };

function byName(doc, name) {
  return Object.values(doc.nodes).find((n) => n && n.name === name);
}

/** Мастер компонента из демо-документа с одним текстовым пропсом. */
function master(doc) {
  return Object.values(doc.nodes).find((n) => n.component && Array.isArray(n.component.props) && n.component.props.length);
}

test('круг 34: имя пропса с точкой или ключом прототипа — отказ set, create и импорта', () => {
  const doc = core.createDoc();
  const m = master(doc);
  assert.ok(m, 'в демо есть компонент со свойствами');
  const p0 = m.component.props[0];
  for (const name of ['a.b', 'a.', '.a', '.', 'constructor', 'toString', '__proto__']) {
    const props = [{ ...p0, name }, ...m.component.props.slice(1)];
    const r = quiet(() => core.applyOps(doc, [{ op: 'set', id: m.id, path: 'component.props', value: props }]));
    assert.ok(r.error, `set с именем «${name}» должен отказать`);
    const bad = clone(doc);
    bad.nodes[m.id].component.props = props;
    const imp = core.checkImportDoc(bad);
    assert.ok(imp && imp.code === 'bad-doc', `импорт с именем «${name}»: ${JSON.stringify(imp)}`);
    // createDoc чинит: негодный пропс выброшен, прочие и сам компонент на месте
    const fixed = quiet(() => core.createDoc(clone(bad)));
    const fm = fixed.nodes[m.id];
    assert.ok(fm && fm.component, 'компонент уцелел');
    assert.ok(!fm.component.props.some((p) => p.name === name), `пропс «${name}» выброшен`);
    assert.equal(fm.component.props.length, m.component.props.length - 1);
    assert.equal(core.checkImportDoc(clone(fixed)), null, 'починенный документ импортируется');
  }
  // годное имя с пробелом и запятой — можно
  const ok = [{ ...p0, name: 'цена, руб' }, ...m.component.props.slice(1)];
  const r = quiet(() => core.applyOps(doc, [{ op: 'set', id: m.id, path: 'component.props', value: ok }]));
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(core.checkImportDoc(clone(r.doc)), null);
});

test('круг 34: create мастера с точкой в имени пропса — bad-node', () => {
  const doc = core.createDoc();
  const board = doc.nodes[doc.root].children.find((id) => doc.nodes[id] && doc.nodes[id].type === 'frame');
  assert.ok(board);
  const r = quiet(() => core.applyOps(doc, [
    { op: 'create', node: {
      id: 'm34', type: 'frame', name: 'М', parent: board, children: [],
      size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
      component: { name: 'М', props: [{ name: 'x.y', kind: 'bool', target: 'm34', path: 'visible' }] },
    } },
  ]));
  assert.ok(r.error, 'create должен отказать');
  assert.match(String(r.error.message), /точк/);
});

test('круг 34: brain предлагает имена свойств без точки — компонент ложится', async () => {
  const doc0 = core.createDoc();
  const card = byName(doc0, 'Карточка встречи');
  assert.ok(card, 'в демо есть «Карточка встречи»');
  // имена текстов внутри карточки — с точками, одно — ключ прототипа
  const texts = [];
  const walk = (id) => {
    const n = doc0.nodes[id];
    if (!n) return;
    if (n.type === 'text') texts.push(id);
    for (const k of (Array.isArray(n.children) ? n.children : [])) walk(k);
  };
  walk(card.id);
  assert.ok(texts.length >= 2, 'в карточке несколько текстов');
  const names = ['Цена, руб.', 'Итог.', 'constructor', 'a..b'];
  const renames = texts.slice(0, names.length).map((id, i) => ({ op: 'set', id, path: 'name', value: names[i] }));
  const ren = core.applyOps(doc0, renames);
  assert.equal(ren.error, undefined, JSON.stringify(ren.error));
  const doc = ren.doc;
  const made = await runCommand({ doc, selection: [card.id], utterance: 'сделай из этого компонент', provider: dead, engine: core });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(made.local, 'component');
  const next = core.applyOps(doc, made.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const comp = Object.values(next.doc.nodes).find((n) => n.component && n.component.name === 'Карточка встречи');
  assert.ok(comp, 'компонент появился');
  const propNames = comp.component.props.map((p) => p.name);
  assert.ok(propNames.length >= 2, JSON.stringify(propNames));
  for (const n of propNames) {
    assert.ok(!n.includes('.'), `в имени «${n}» нет точки`);
    assert.notEqual(n, 'constructor');
  }
  assert.ok(propNames.includes('цена, руб'), JSON.stringify(propNames));
  assert.equal(core.checkImportDoc(clone(next.doc)), null);
});

test('круг 34: слова brain для человека — «слой», а не «узел»', async () => {
  /* Предупреждения, отказы и подписи brain человеку (note, warn, ERR, cannot) — без «узла»:
     человек видит «Слои» в рельсе. Промпты модели не проверяются: там свой словарь. */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/brain.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    if (!/\b(?:note|warn|ERR|cannot)\(/.test(line)) return;
    // сам вызов и продолжение строки (`+ '…'`) до закрывающей скобки — до 4 строк
    // круг 39: только подряд идущие продолжения — чужой вызов ниже (промпт модели) не в счёт
    const tail = [];
    for (const l of lines.slice(i + 1, i + 4)) { if (!/^\s*[+:?]/.test(l)) break; tail.push(l); }
    const chunk = [line, ...tail].join(' ');
    if (/(?<![А-Яа-яЁё])[Уу]з(?:ел|л[аеуыо]\p{L}*)(?![А-Яа-яЁё])/u.test(chunk.replace(/\/\/.*$/gm, ''))) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(bad, [], bad.join('\n'));
});
