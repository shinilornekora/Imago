/**
 * Круг 62 (SPEC §18.8): правка мастера у предела. Неизменённые узлы мастера дают те же раскрытые узлы
 * (те же объекты), общая карта памяти правится на месте, копии образца берут готовые id. Главное
 * свойство прежнее: solveAfter побитно равен полной раскладке без образцов, а раскрытие — раскрытию
 * того же документа с нуля.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, solve, solveAfter, solveCarry, hashGeometry, artboards, libraryNode, expandDoc } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const measureText = (text, style) => String(text || '').length * (style.fontSize || 16) * 0.52;
const OPTS = { measureText };
const KEPT = { ...OPTS, incremental: true };
const PLAIN = { ...OPTS, shapes: false };
const hug = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const fill = { w: { mode: 'fill' }, h: { mode: 'hug' } };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WORDS = ['Коротко', 'Заголовок карточки', 'Длинная подпись, которая переносится в узкой карточке на несколько строк', ''];

/**
 * «Плоская» карточка F (без вложенных экземпляров: заголовок с пропсом, подпись, полоса, рамка с текстом)
 * и «составная» N (колонка с вложенным экземпляром F). Сетка G из экземпляров обеих, подпись доски рядом.
 */
function cardDoc(count) {
  const d = quiet(() => createDoc());
  const board = artboards(d)[0].id;
  const lib = libraryNode(d).id;
  const list = [
    { op: 'create', node: { type: 'frame', id: 'F', parent: lib, children: [], layout: { mode: 'column', gap: 4 }, size: { w: { mode: 'fixed', value: 160 }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'text', id: 'ft', parent: 'F', characters: 'Заголовок', size: fill } },
    { op: 'create', node: { type: 'text', id: 'fs', parent: 'F', characters: 'Подпись', size: fill } },
    { op: 'create', node: { type: 'rect', id: 'fr', parent: 'F', size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 6 } } } },
    { op: 'create', node: { type: 'frame', id: 'fb', parent: 'F', children: [], layout: { mode: 'row', padding: 2 }, size: hug } },
    { op: 'create', node: { type: 'text', id: 'fi', parent: 'fb', characters: 'Метка', size: hug } },
    { op: 'set', id: 'F', path: 'component', value: { name: 'Плоская', props: [
      { name: 'заголовок', kind: 'text', target: 'ft', path: 'characters' },
      { name: 'полоса', kind: 'bool', target: 'fr', path: 'visible' },
    ] } },
    { op: 'create', node: { type: 'frame', id: 'N', parent: lib, children: [], layout: { mode: 'column', gap: 2 }, size: hug } },
    { op: 'create', node: { type: 'text', id: 'nt', parent: 'N', characters: 'Составная', size: hug } },
    { op: 'create', node: { type: 'instance', id: 'nf', parent: 'N', of: 'F' } },
    { op: 'set', id: 'N', path: 'component', value: { name: 'Составная', props: [] } },
    { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 8 }, size: { w: { mode: 'fixed', value: 900 }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'text', id: 'note', parent: board, characters: 'Подпись доски', size: hug } },
  ];
  for (let i = 0; i < count; i++) list.push({ op: 'create', node: { type: 'instance', id: 'I' + i, parent: 'G', of: i % 4 === 3 ? 'N' : 'F' } });
  const res = applyOps(d, list, { checkExpand: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.doc;
}

function randomOp(r, doc, step) {
  const insts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'instance' && doc.nodes[id].parent === 'G');
  const inst = () => insts[Math.floor(r() * insts.length)];
  const word = () => WORDS[Math.floor(r() * WORDS.length)] + step;
  const kids = doc.nodes.F ? doc.nodes.F.children : [];
  const k = r();
  // мастер: тексты, полоса, раскладка, добавить, убрать и переставить ребёнка, описание пропсов
  if (k < 0.12) return [{ op: 'set', id: ['ft', 'fs', 'fi'][Math.floor(r() * 3)], path: 'characters', value: word() }];
  if (k < 0.16) return [{ op: 'set', id: 'fr', path: 'size', value: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 2 + Math.floor(r() * 20) } } }];
  if (k < 0.19) return [{ op: 'set', id: 'F', path: 'layout', value: { mode: 'column', gap: Math.floor(r() * 12) } }];
  if (k < 0.23) return [{ op: 'create', node: { type: 'text', id: 'fx' + step, parent: 'F', characters: word(), size: fill } }];
  if (k < 0.26 && kids.length > 2) return [{ op: 'remove', id: kids[Math.floor(r() * kids.length)] }];
  if (k < 0.29 && kids.length > 1) return [{ op: 'move', id: kids[Math.floor(r() * kids.length)], parent: 'F', index: Math.floor(r() * kids.length) }];
  if (k < 0.31 && doc.nodes.fs) return [{ op: 'move', id: 'fs', parent: 'fb', index: 0 }];
  if (k < 0.33) return [{ op: 'set', id: 'F', path: 'component', value: { name: 'Плоская', props: [{ name: 'заголовок', kind: 'text', target: r() < 0.5 ? 'ft' : 'fi', path: 'characters' }] } }];
  if (k < 0.36) return [{ op: 'set', id: 'nt', path: 'characters', value: word() }];
  if (k < 0.38) return [{ op: 'set', id: 'nf', path: 'props', value: { заголовок: word() } }];
  // экземпляры
  if (k < 0.48 && insts.length) return [{ op: 'set', id: inst(), path: 'props', value: { заголовок: word(), полоса: r() < 0.5 } }];
  if (k < 0.52 && insts.length) return [{ op: 'set', id: inst(), path: 'of', value: r() < 0.5 ? 'F' : 'N' }];
  if (k < 0.56 && insts.length) return [{ op: 'set', id: inst(), path: 'size', value: { w: { mode: 'fixed', value: 100 + Math.floor(r() * 120) }, h: { mode: 'hug' } } }];
  if (k < 0.60 && insts.length) return [{ op: 'set', id: inst(), path: 'visible', value: r() < 0.5 }];
  if (k < 0.66) return [{ op: 'create', node: { type: 'instance', id: 'x' + step, parent: 'G', of: r() < 0.7 ? 'F' : 'N' } }];
  if (k < 0.70 && insts.length > 1) return [{ op: 'remove', id: inst() }];
  if (k < 0.74 && insts.length > 1) return [{ op: 'move', id: inst(), parent: 'G', index: Math.floor(r() * insts.length) }];
  // настоящие узлы
  if (k < 0.80) return [{ op: 'create', node: { type: 'text', id: 'r' + step, parent: 'G', characters: word() } }];
  if (k < 0.90) return [{ op: 'set', id: 'note', path: 'characters', value: word() }];
  return [{ op: 'set', id: 'G', path: 'size', value: { w: { mode: 'fixed', value: 500 + Math.floor(r() * 800) }, h: { mode: 'hug' } } }];
}

/** Раскрытие того же документа с нуля: копия без общих объектов — мимо всех кешей. */
const fresh = (doc) => quiet(() => expandDoc(JSON.parse(JSON.stringify(doc))).nodes);
const sameExpansion = (a, b) => {
  const keys = Object.keys(a).sort();
  assert.deepEqual(keys, Object.keys(b).sort());
  for (const id of keys) assert.equal(JSON.stringify(a[id]), JSON.stringify(b[id]), `раскрытый узел ${id}`);
};

test('круг62: правки мастера, экземпляров и слоёв — по месту та же геометрия и то же раскрытие, что с нуля', () => {
  let steps = 0;
  let kept = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed);
    let doc = cardDoc(10 + Math.floor(r() * 24));
    let geo = solve(doc, KEPT);
    let back = null;   // прежняя пара (геометрия, документ): её память уже отдана — ветка от неё
    for (let step = 0; step < 40; step++) {
      const op = randomOp(r, doc, step);
      const res = quiet(() => applyOps(doc, op, { checkExpand: false }));
      if (res.error) continue;
      const next = res.doc;
      const inc = quiet(() => solveAfter(geo, doc, next, op, OPTS));
      const full = quiet(() => solve(next, PLAIN));
      assert.equal(hashGeometry(inc), hashGeometry(full), `зерно ${seed}, шаг ${step}: ${JSON.stringify(op).slice(0, 200)}`);
      assert.deepEqual(inc.order, full.order);
      sameExpansion(inc.expanded, fresh(next));
      if (Object.keys(inc.expanded).some((id) => id.includes('/') && inc.expanded[id] === geo.expanded[id])) kept++;
      // ветка: правка от документа два шага назад, по его (уже отданной) геометрии
      if (back && step % 5 === 0) {
        const op2 = [{ op: 'set', id: 'fs', path: 'characters', value: 'Ветка ' + step }];
        const r2 = quiet(() => applyOps(back.doc, op2, { checkExpand: false }));
        if (!r2.error) {
          const g2 = quiet(() => solveAfter(back.geo, back.doc, r2.doc, op2, OPTS));
          assert.equal(hashGeometry(g2), hashGeometry(quiet(() => solve(r2.doc, PLAIN))), `ветка: зерно ${seed}, шаг ${step}`);
          sameExpansion(g2.expanded, fresh(r2.doc));
        }
      }
      steps++;
      back = { geo, doc };
      doc = next;
      geo = inc;
    }
  }
  assert.ok(kept > steps / 2, `раскрытые узлы — те же объекты на ${kept} из ${steps} шагов`);
});

test('круг62: правка одного узла мастера — остальные раскрытые узлы те же объекты, по месту только его копии', () => {
  const doc = cardDoc(40);
  const geo = solve(doc, KEPT);
  const op = [{ op: 'set', id: 'fi', path: 'characters', value: 'Другая метка' }];
  const next = applyOps(doc, op).doc;
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  const ex = expandDoc(next);
  // раскрыты заново только копии «fi»: по одной в каждом экземпляре F и во вложенном F каждого N
  // (N — с вложенным экземпляром: его раскрытие целиком новое)
  const flat = Object.keys(next.nodes).filter((id) => next.nodes[id].type === 'instance' && next.nodes[id].of === 'F' && next.nodes[id].parent === 'G');
  assert.equal(inc.expanded['I0/ft'], geo.expanded['I0/ft']);
  assert.equal(inc.expanded.I0, geo.expanded.I0, 'корень экземпляра — тот же объект');
  assert.notEqual(inc.expanded['I0/fi'], geo.expanded['I0/fi']);
  assert.equal(inc.expanded['I0/fi'].characters, 'Другая метка');
  assert.ok(ex.fresh < flat.length + 10 * 9, `заново ${ex.fresh}`);
  // прямоугольник чистого узла в экземпляре — тот же объект: экземпляры F разложены по месту
  assert.equal(inc.rects['I0/fr'] === geo.rects['I0/fr'] || inc.rects['I0/fr'].w === geo.rects['I0/fr'].w, true);
  // прежняя геометрия отдала память — повторный вызов от неё всё равно верен (полная раскладка)
  const op2 = [{ op: 'set', id: 'ft', path: 'characters', value: 'Ещё' }];
  const next2 = applyOps(doc, op2).doc;
  assert.equal(hashGeometry(solveAfter(geo, doc, next2, op2, OPTS)), hashGeometry(solve(next2, PLAIN)));
});

test('круг62: смена корня мастера и вложенные — раскрытие заново; solveCarry — обычный путь', () => {
  const doc = cardDoc(16);
  const geo = solve(doc, KEPT);
  // корень мастера (раскладка) — новый объект: раскрытые узлы экземпляров F все новые
  const op = [{ op: 'set', id: 'F', path: 'layout', value: { mode: 'row', gap: 3 } }];
  const next = applyOps(doc, op).doc;
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  assert.notEqual(inc.expanded['I0/ft'], geo.expanded['I0/ft']);
  sameExpansion(inc.expanded, fresh(next));
  // имя через solveCarry, потом правка мастера: карта памяти отстала — обычный путь, верно
  const g3 = solve(next, KEPT);
  const renamed = applyOps(next, [{ op: 'set', id: 'note', path: 'name', value: 'Подпись' }]).doc;
  solveCarry(g3, next, renamed);
  const op4 = [{ op: 'set', id: 'ft', path: 'characters', value: 'После переименования' }];
  const next4 = applyOps(renamed, op4).doc;
  const g4 = solveAfter(g3, renamed, next4, op4, OPTS);
  assert.equal(hashGeometry(g4), hashGeometry(solve(next4, PLAIN)));
  sameExpansion(g4.expanded, fresh(next4));
});
