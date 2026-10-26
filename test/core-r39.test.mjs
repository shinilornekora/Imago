import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, applyBatches, invertOps, rebase, solve, validate, expandDoc, expandInstance, checkImportDoc,
  expandCost, expandProblem, MAX_EXPANDED_NODES, DEGRADED_INSTANCE_NODES, EXPAND_LIMIT, libraryNode, hashDoc,
  ENGINE_VERSION, ENGINE_MIN_READ, engineReadable, duplicateOps, DUPLICATE_OFFSET, components, Stage,
  parsePath, pathBounds, fitVector, ops: OPS
} = core;

/* Круг 39, CORE.
   N1 — версия формата движка 2 (круги 36–37 расширили формат), читает записи с 1.
   N2 — предел раскрытия экземпляров (перенос непроверенной работы круга 35 с
        проверкой заново): expandCost линейно, MAX_EXPANDED_NODES, заглушки,
        validate expand-limit, отказ импорта и правки (`limit:'expand_nodes'`).
   N3 — duplicateOps: одна реализация дублирования (оболочка и Stage._duplicate).
   Критик кода: рамка пути с одиночным M; сверка parsePath/pathBounds с
   независимым эталоном на случайных путях (мутанты V01/V05/V07). */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const M = { measureText: (t, s) => String(t).length * (s && s.fontSize ? s.fontSize : 15) * 0.55 };

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)], int: (n) => Math.floor(rnd() * n) };
}

/* ============================== N1 ============================== */

test('круг39 N1: ENGINE_VERSION 2 (с круга 48 — 3), читает записи с ENGINE_MIN_READ 1; новее и мусор — нет', () => {
  assert.equal(ENGINE_VERSION, 3);
  assert.equal(ENGINE_MIN_READ, 1);
  assert.ok(ENGINE_MIN_READ <= ENGINE_VERSION);
  for (const v of [1, 2, 3, undefined, null]) assert.equal(engineReadable(v), true, `читается ${v}`);
  for (const v of [0, 4, 99, -1, 1.5, '2', '1', NaN, Infinity, {}, [2]]) assert.equal(engineReadable(v), false, `не читается ${String(v)}`);
});

test('круг39 N1: журнал движка 1 (формат до кругов 36–37) переигрывается движком 2 как раньше', () => {
  // пачки того вида, что писал движок 1: только прежние типы и поля
  const doc = createDoc('demo');
  const board = core.artboards(doc)[0].id;
  const t = 'n_v1text';
  const batches = [
    [{ op: 'create', node: { type: 'text', id: t, parent: board, characters: 'старый журнал' } }],
    [{ op: 'set', id: t, path: 'characters', value: 'правка v1' }, { op: 'setToken', path: 'colors.accent', value: '#123456' }],
    [{ op: 'move', id: t, parent: board, index: 0 }],
    [{ op: 'remove', id: t }]
  ];
  const all = applyBatches(doc, clone(batches));
  assert.ok(all.results.every((r) => r === null), 'все пачки v1 легли');
  let cur = doc;
  for (const b of batches) {
    const r = applyOps(cur, clone(b));
    assert.equal(r.error, undefined);
    cur = r.doc;
  }
  assert.equal(hashDoc(all.doc), hashDoc(cur));
  assert.equal(checkImportDoc(clone(cur)), null);
});

/* ============================== N2 ============================== */

/** Пустой документ: корень, библиотека и одна доска. */
function emptyDoc() {
  const d = clone(createDoc('empty'));
  const lib = libraryNode(d).id;
  d.nodes.b0 = { type: 'frame', id: 'b0', parent: d.root, name: 'Доска', children: [], size: { w: { mode: 'fixed', value: 800 }, h: { mode: 'fixed', value: 600 } }, layout: { mode: 'column' } };
  d.nodes[d.root].children.unshift('b0');
  return { d, lib };
}

/** Цепочка: L мастеров, в каждом W экземпляров следующего (сырой документ, как из файла). */
function chainDoc(L, W) {
  const { d, lib } = emptyDoc();
  for (let i = 0; i < L; i++) {
    const c = 'f_q' + i;
    d.nodes[c] = { type: 'frame', id: c, parent: lib, component: { name: 'K' + i, props: [] }, children: [], layout: { mode: 'column' } };
    d.nodes[lib].children.push(c);
    if (i < L - 1) {
      for (let s = 0; s < W; s++) {
        const n = 'i_q' + i + '_' + s;
        d.nodes[n] = { type: 'instance', id: n, parent: c, of: 'f_q' + (i + 1) };
        d.nodes[c].children.push(n);
      }
    }
  }
  return d;
}

/** Точная стоимость цепочки: мастер i — 1 + W·(cost(i+1) − 1) + W; экземпляры в мастерах раскрываются и сами. */
function chainCost(L, W) {
  const c = new Array(L).fill(0);
  c[L - 1] = 1;
  for (let i = L - 2; i >= 0; i--) c[i] = 1 + W + W * (c[i + 1] - 1);
  let sum = 0;
  for (let i = 0; i < L - 1; i++) sum += W * c[i + 1];
  return sum;
}

/** Раскрытые узлы без заглушек. */
const countExpanded = (doc) => {
  const ex = expandDoc(doc);
  return Object.values(ex.nodes).filter((n) => !n.stub).length;
};

test('круг39 N2: бомба критика (9 мастеров по 6) — стоимость линейно, импорт 400-причина, solve и validate — доли секунды, заглушки', () => {
  const raw = chainDoc(9, 6);
  let t = Date.now();
  const cost = expandCost(raw);
  const costMs = Date.now() - t;
  assert.equal(cost, chainCost(9, 6));
  assert.ok(cost > 1e6);
  assert.ok(costMs < 500, `счёт стоимости линеен: ${costMs} мс`);

  const bad = checkImportDoc(clone(raw));
  assert.ok(bad, 'импорт отказывает');
  assert.equal(bad.code, 'bad-doc');
  assert.equal(bad.limit, 'expand_nodes');
  assert.equal(EXPAND_LIMIT, 'expand_nodes');
  assert.equal(bad.max, MAX_EXPANDED_NODES);
  assert.match(bad.message, /слишком много вложенных экземпляров/);
  assert.match(bad.message, new RegExp(String(cost)));

  // та же цепочка поуже — в пределе, импорт проходит, стоимость = фактическому раскрытию
  const ok = chainDoc(9, 3);
  assert.equal(checkImportDoc(clone(ok)), null);
  assert.equal(expandCost(ok), countExpanded(createDoc(ok)));

  // документ из старого журнала (импорт его уже не пустит) открывается деградированно
  const doc = quiet(() => createDoc(raw));
  t = Date.now();
  const ex = quiet(() => expandDoc(doc));
  const exMs = Date.now() - t;
  const real = Object.values(ex.nodes).filter((n) => !n.stub);
  assert.ok(real.length <= MAX_EXPANDED_NODES, `раскрыто ${real.length} — не больше предела`);
  assert.ok(ex.skipped && ex.skipped.length > 0, 'дорогие экземпляры — заглушки');
  for (const id of ex.skipped) {
    const stub = ex.nodes[id];
    assert.equal(stub.stub, 'expand-limit', 'на месте экземпляра — заглушка');
    assert.equal(stub.synthetic, true);
    assert.equal(stub.instance, id, 'выделение уходит в экземпляр');
    const label = ex.nodes[stub.children[0]];
    assert.equal(label.characters, 'слишком много вложенных экземпляров');
  }
  t = Date.now();
  const geo = quiet(() => solve(doc, { selfTest: false }));
  const solveMs = Date.now() - t;
  assert.ok(exMs < 3000 && solveMs < 3000, `expandDoc ${exMs} мс, solve ${solveMs} мс — доли секунды, а не минута`);
  assert.ok(geo.rects[doc.root], 'геометрия есть');
  for (const id of ex.skipped) {
    assert.ok(geo.rects[id], `заглушка «${id}» размещена`);
    assert.ok(geo.expanded[id] && geo.expanded[id].stub, 'сцена рисует заглушку из geo.expanded');
  }
  t = Date.now();
  const v = quiet(() => validate(doc, geo)).filter((x) => x.code === 'expand-limit');
  assert.ok(Date.now() - t < 3000);
  assert.equal(v.length, 1, 'validate говорит expand-limit одной строкой');
  assert.equal(v[0].severity, 'error');
  assert.equal(v[0].nodeId, 'i_q0_0', 'на самом дорогом экземпляре');
  assert.match(v[0].message, /слишком много вложенных экземпляров/);

  const p = expandProblem(doc);
  assert.equal(p.code, 'expand-limit');
  assert.equal(p.limit, 'expand_nodes');
  assert.equal(p.cost, cost);
  assert.equal(p.max, MAX_EXPANDED_NODES);
  assert.equal(expandProblem(ok), null);

  // экземпляр-бомба по одному тоже не раскрывается целиком
  const one = quiet(() => expandInstance(doc, 'i_q0_0'));
  assert.equal(one.root, null);
  assert.equal(one.limit, 'expand_nodes');
  assert.ok(expandInstance(doc, 'i_q7_0').root, 'дешёвый экземпляр раскрывается');
  // отсоединить бомбу — нечего (а не миллион create)
  assert.deepEqual(quiet(() => core.detachInstanceOps(doc, 'i_q0_0')), []);
});

test('круг39 N2: транзакция-бомба (9 мастеров по 7) — applyOps отказывает, rebase отбрасывает лишнее с limit expand_nodes', () => {
  const base = createDoc('demo');
  const lib = libraryNode(base).id;
  const L = 9;
  const W = 7;
  const ids = Array.from({ length: L }, (_, i) => 'fK' + i);
  const list = [];
  for (let i = 0; i < L; i++) list.push({ op: 'create', node: { type: 'frame', id: ids[i], parent: lib, name: 'K' + i, component: { name: 'K' + i, props: [] }, layout: { mode: 'column' } } });
  for (let i = 0; i < L - 1; i++) for (let s = 0; s < W; s++) list.push({ op: 'create', node: { type: 'instance', id: `iK${i}_${s}`, parent: ids[i], of: ids[i + 1] } });
  assert.equal(list.length, 65);

  const t = Date.now();
  const r = quiet(() => applyOps(base, clone(list)));
  assert.ok(r.error, 'пачка целиком не ложится');
  assert.equal(r.error.limit, 'expand_nodes');
  assert.equal(r.error.code, 'bad-op');
  assert.match(r.error.message, /слишком много вложенных экземпляров/);
  assert.equal(r.doc, base, 'документ прежний');
  // переигрывание журнала предел не проверяет: журнал — источник истины
  assert.equal(quiet(() => applyOps(base, clone(list), { checkExpand: false })).error, undefined);

  const rb = quiet(() => rebase(base, clone(list)));
  const ms = Date.now() - t;
  const expandDropped = rb.dropped.filter((x) => x.limit === 'expand_nodes');
  assert.ok(expandDropped.length > 0, 'бомба отброшена');
  for (const x of expandDropped) assert.equal(x.reason, 'invalid');
  // всё, что rebase оставил, ложится строгим applyOps (как DSLTS settle) и в пределе
  const a = quiet(() => applyOps(base, rb.ops));
  assert.equal(a.error, undefined, a.error && a.error.message);
  const c = expandCost(a.doc);
  assert.ok(c <= MAX_EXPANDED_NODES, `после слияния ${c} узлов раскрытия`);
  assert.equal(countExpanded(a.doc), c);
  assert.ok(ms < 5000, `applyOps + rebase: ${ms} мс`);
  assert.equal(validate(a.doc, solve(a.doc, { selfTest: false })).filter((x) => x.code === 'expand-limit').length, 0);
});

test('круг39 N2: документ сверх предела не запирается — правки, не раздувающие раскрытие, проходят', () => {
  const doc = quiet(() => createDoc(chainDoc(9, 5)));
  const before = expandCost(doc);
  let r = quiet(() => applyOps(doc, [{ op: 'set', id: 'b0', path: 'name', value: 'Ещё доска' }]));
  assert.equal(r.error, undefined);
  r = quiet(() => applyOps(doc, [{ op: 'remove', id: 'i_q0_0' }]));
  assert.equal(r.error, undefined);
  assert.ok(expandCost(r.doc) < before);
  r = quiet(() => applyOps(doc, [{ op: 'create', node: { type: 'text', id: 't_new', parent: 'b0', characters: 'привет' } }]));
  assert.equal(r.error, undefined);
  // ещё один экземпляр тяжёлого мастера на доске — нет
  r = quiet(() => applyOps(doc, [{ op: 'create', node: { type: 'instance', id: 'i_more', parent: 'b0', of: 'f_q1' } }]));
  assert.equal(r.error && r.error.limit, 'expand_nodes');
  // предел для такого документа — его НЫНЕШНЯЯ стоимость (как doc_nodes у DSLTS)
  const rm = quiet(() => applyOps(doc, [{ op: 'remove', id: 'i_q0_1' }]));
  const back = quiet(() => applyOps(rm.doc, invertOps(doc, [{ op: 'remove', id: 'i_q0_1' }])));
  assert.equal(back.error && back.error.limit, 'expand_nodes');
  const sw = quiet(() => applyOps(doc, [{ op: 'set', id: 'i_q7_0', path: 'name', value: 'Лист' }]));
  assert.equal(sw.error, undefined);
  assert.equal(expandCost(sw.doc), before);
});

/**
 * Случайный документ без бомбы. mode:
 *   'cycles' — экземпляры любых мастеров (циклы, самовключение), без пропсов-подмен;
 *   'swap'   — экземпляры только «вперёд» и пропсы, подменяющие вложенному of (тоже вперёд);
 *   'wild'   — всё сразу, включая props.<имя> вложенному: стоимость — оценка сверху.
 */
function randomDoc(seed, mode) {
  const { rnd, pick, int } = rng(seed);
  const { d, lib } = emptyDoc();
  const K = 2 + int(5);
  const masters = Array.from({ length: K }, (_, i) => 'm' + i);
  const owner = new Map();
  let nid = 0;
  for (let i = 0; i < K; i++) {
    const id = masters[i];
    d.nodes[id] = { type: 'frame', id, parent: lib, component: { name: 'M' + i, props: [] }, children: [], layout: { mode: 'column' } };
    d.nodes[lib].children.push(id);
    const containers = [id];
    const nested = [];
    const n = 1 + int(5);
    for (let k = 0; k < n; k++) {
      const parent = pick(containers);
      const x = 'n' + (nid++);
      const r = rnd();
      const forward = masters.slice(i + 1);
      let node;
      if (r < 0.4 && (mode !== 'swap' || forward.length)) {
        let of = mode === 'swap' ? pick(forward) : pick(masters);
        if (rnd() < 0.08) of = pick(['nope', 'b0', id]);
        if (mode === 'swap' && !forward.includes(of)) of = 'nope';
        node = { type: 'instance', id: x, parent, of };
        nested.push(x);
      } else if (r < 0.6) {
        node = { type: 'frame', id: x, parent, children: [], layout: { mode: 'row' } };
        containers.push(x);
      } else {
        node = { type: 'text', id: x, parent, characters: 'т' + k };
      }
      d.nodes[x] = node;
      d.nodes[parent].children.push(x);
      owner.set(x, i);
    }
    const props = d.nodes[id].component.props;
    props.push({ name: 'label', kind: 'text', target: id, path: 'name' });
    if (mode !== 'cycles' && nested.length) {
      for (let k = 0; k < 2; k++) props.push({ name: 'sw' + k, kind: 'text', target: pick(nested), path: 'of' });
      if (mode === 'wild') props.push({ name: 'deep', kind: 'text', target: pick(nested), path: 'props.sw0' });
    }
  }
  const propsFor = (mid) => {
    const m = d.nodes[mid];
    const out = {};
    if (!m || !m.component) return out;
    for (const p of m.component.props) {
      if (rnd() < 0.5) continue;
      if (p.path === 'name') out[p.name] = 'имя';
      else if (mode === 'swap') {
        const from = owner.get(p.target);
        const fw = masters.slice(from + 1);
        out[p.name] = fw.length ? pick(fw) : 'nope';
      } else out[p.name] = pick(masters);
    }
    return out;
  };
  for (const [x, i] of owner) {
    const n = d.nodes[x];
    if (n.type === 'instance' && rnd() < 0.5) {
      const pr = propsFor(n.of);
      if (mode === 'swap') {
        for (const k of Object.keys(pr)) if (k.startsWith('sw') && masters.indexOf(pr[k]) <= i) pr[k] = 'nope';
      }
      n.props = pr;
    }
  }
  const tops = 1 + int(4);
  for (let k = 0; k < tops; k++) {
    const of = pick(masters);
    const x = 'top' + k;
    d.nodes[x] = { type: 'instance', id: x, parent: 'b0', of, props: propsFor(of) };
    d.nodes.b0.children.push(x);
  }
  return quiet(() => createDoc(d));
}

test('круг39 N2: эталон — expandCost = числу узлов expandDoc на случайных документах (циклы, подмены of)', () => {
  let checked = 0;
  let cyclic = 0;
  for (let seed = 1; seed <= 400; seed++) {
    for (const mode of ['cycles', 'swap']) {
      const doc = randomDoc(seed * 7 + (mode === 'swap' ? 1 : 0), mode);
      const cost = expandCost(doc);
      if (cost > MAX_EXPANDED_NODES) continue;
      const real = quiet(() => countExpanded(doc));
      assert.equal(cost, real, `seed ${seed} ${mode}: стоимость ${cost}, раскрыто ${real}`);
      if (mode === 'cycles' && quiet(() => validate(doc, solve(doc, { selfTest: false }))).some((v) => v.code === 'component-cycle')) cyclic++;
      checked++;
    }
  }
  assert.ok(checked > 700, `проверено ${checked}`);
  assert.ok(cyclic > 20, `документов с циклом компонентов: ${cyclic}`);
});

test('круг39 N2: стоимость — оценка сверху и при подменах props вложенным (wild)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const doc = randomDoc(seed * 13 + 5, 'wild');
    const cost = expandCost(doc);
    const real = quiet(() => countExpanded(doc));
    if (cost <= MAX_EXPANDED_NODES) assert.ok(cost >= real, `seed ${seed}: ${cost} < ${real}`);
    else assert.ok(real <= MAX_EXPANDED_NODES);
  }
});

/** Документ у предела: цепочка 6×5 в библиотеке, на досках — экземпляры её верха. */
function nearLimitDoc(boardInst) {
  const raw = chainDoc(6, 5);
  raw.nodes.b1 = { type: 'frame', id: 'b1', parent: raw.root, name: 'Доска 2', children: [], layout: { mode: 'row' } };
  raw.nodes[raw.root].children.unshift('b1');
  for (let k = 0; k < boardInst; k++) {
    const x = 'bi' + k;
    raw.nodes[x] = { type: 'instance', id: x, parent: k % 2 ? 'b1' : 'b0', of: k % 4 === 3 ? 'f_q1' : 'f_q0' };
    raw.nodes[raw.nodes[x].parent].children.push(x);
  }
  // пропс-подмена: экземпляр верхнего мастера может увести свой первый вложенный в другой мастер
  raw.nodes.f_q0.component.props.push({ name: 'sw', kind: 'text', target: 'i_q0_0', path: 'of' });
  return quiet(() => createDoc(raw));
}

function randomOps(doc, seed, n) {
  const { rnd, pick, int } = rng(seed);
  const masters = ['f_q0', 'f_q1', 'f_q2', 'f_q3', 'f_q4', 'f_q5'];
  const lib = libraryNode(doc).id;
  const live = new Set(Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'instance'));
  const list = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const anyInst = () => pick([...live]);
    if (r < 0.3) {
      const id = 'ni' + seed + '_' + (k++);
      live.add(id);
      list.push({ op: 'create', node: { type: 'instance', id, parent: pick(['b0', 'b1', 'b0', 'b1', pick(masters)]), of: pick(masters) } });
    } else if (r < 0.45) {
      list.push({ op: 'create', node: { type: 'text', id: 'nt' + seed + '_' + (k++), parent: pick(masters.concat(['b0', lib])), characters: 'x' } });
    } else if (r < 0.58 && live.size) {
      const id = anyInst();
      live.delete(id);
      list.push({ op: 'remove', id });
    } else if (r < 0.68 && live.size) {
      list.push({ op: 'set', id: anyInst(), path: 'of', value: pick(masters) });
    } else if (r < 0.76 && live.size) {
      list.push({ op: 'move', id: anyInst(), parent: pick(['b0', 'b1', pick(masters)]) });
    } else if (r < 0.82) {
      list.push({ op: 'set', id: pick(['b0', 'b1']), path: 'name', value: 'д' + i });
    } else if (r < 0.84) {
      list.push({ op: 'setToken', path: 'colors.accent', value: pick(['#ff0000', '#00ff00']) });
    } else if (r < 0.87) {
      // пропс-подмена of вложенному: на экземпляре верхнего уровня или новом
      if (live.size && rnd() < 0.5) list.push({ op: 'set', id: anyInst(), path: 'props.sw', value: pick(masters) });
      else {
        const id = 'np' + seed + '_' + (k++);
        live.add(id);
        list.push({ op: 'create', node: { type: 'instance', id, parent: pick(['b0', 'b1']), of: 'f_q0', props: { sw: pick(masters) } } });
      }
    } else if (r < 0.93) {
      const m = 'nm' + seed + '_' + (k++);
      list.push({ op: 'create', node: { type: 'frame', id: m, parent: lib, component: { name: m, props: [] }, layout: { mode: 'column' } } });
      for (let s = 0; s < 1 + int(4); s++) list.push({ op: 'create', node: { type: 'instance', id: 'ni' + seed + '_' + (k++), parent: m, of: pick(masters) } });
      masters.push(m);
    } else {
      const m = pick(masters.slice(1, 4));
      list.push({ op: 'set', id: m, path: 'component', value: rnd() < 0.5 ? undefined : { name: m, props: [] } });
    }
  }
  return list;
}

/** Наивно: каждая операция отдельно, полный пересчёт после неё. */
function referenceDecisions(doc, list) {
  const lim = Math.max(MAX_EXPANDED_NODES, expandCost(doc));
  let cur = doc;
  const expandIdx = [];
  list.forEach((op, i) => {
    const r = quiet(() => applyBatches(cur, [[clone(op)]]));
    if (r.results[0]) return;
    if (expandCost(r.doc) > lim) { expandIdx.push(i); return; }
    cur = r.doc;
  });
  return { expandIdx, final: cur };
}

test('круг39 N2: rebase — те же отказы expand_nodes, что у наивного пересчёта после каждой операции', () => {
  let refusals = 0;
  let accepted = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const doc = nearLimitDoc(8 + (seed % 5));
    const list = randomOps(doc, seed, 40);
    const ref = referenceDecisions(doc, list);
    const rb = quiet(() => rebase(doc, clone(list)));
    // круг 41: операции в мастер, чей create отброшен за предел, уходят вслед с той же
    // причиной (эталон видит их как «родителя нет») — сравниваем первичные отказы
    const lost = new Set();
    const got = [];
    for (const x of rb.dropped) {
      const o = x.op;
      const follows = o.op === 'create' ? lost.has(o.node.parent) : lost.has(o.id) || lost.has(o.parent);
      if (follows) { if (o.op === 'create') lost.add(o.node.id); continue; }
      if (x.limit === 'expand_nodes') { got.push(x.index); if (o.op === 'create') lost.add(o.node.id); }
    }
    assert.deepEqual(got, ref.expandIdx, `seed ${seed}: отказы expand_nodes`);
    const a = quiet(() => applyOps(doc, rb.ops));
    assert.equal(a.error, undefined, `seed ${seed}: оставленное ложится applyOps`);
    assert.equal(hashDoc(a.doc), hashDoc(ref.final), `seed ${seed}: итог = эталону`);
    assert.ok(expandCost(a.doc) <= Math.max(MAX_EXPANDED_NODES, expandCost(doc)));
    refusals += got.length;
    accepted += rb.ops.length;
  }
  assert.ok(refusals > 30, `отказов expand_nodes: ${refusals}`);
  assert.ok(accepted > 600, `принято: ${accepted}`);
});

test('круг39 N2: applyOps (атомарно) отказывает с limit expand_nodes ровно когда итог за пределом', () => {
  let refused = 0;
  let passed = 0;
  for (let seed = 100; seed < 220; seed++) {
    const doc = nearLimitDoc(8 + (seed % 5));
    const list = randomOps(doc, seed, 6 + (seed % 10));
    const parts = quiet(() => applyBatches(doc, [clone(list)]));
    if (parts.results[0]) continue;                       // пачка негодна по другой причине
    const lim = Math.max(MAX_EXPANDED_NODES, expandCost(doc));
    const want = expandCost(parts.doc) > lim;
    const r = quiet(() => applyOps(doc, clone(list)));
    assert.equal(!!(r.error && r.error.limit === 'expand_nodes'), want, `seed ${seed}`);
    if (!want) assert.equal(hashDoc(r.doc), hashDoc(parts.doc));
    if (want) refused++; else passed++;
  }
  assert.ok(refused > 5 && passed > 20, `отказов ${refused}, принято ${passed}`);
});

test('круг39 N2: стража не делает слияние квадратным — 3000 экземпляров и 3000 узлов в мастерах', () => {
  const { d, lib } = emptyDoc();
  for (let i = 0; i < 4000; i++) {
    const x = 'f' + i;
    d.nodes[x] = { type: 'frame', id: x, parent: 'b0', children: [] };
    d.nodes.b0.children.push(x);
  }
  for (let m = 0; m < 20; m++) {
    const id = 'm' + m;
    d.nodes[id] = { type: 'frame', id, parent: lib, component: { name: 'M' + m, props: [] }, children: [] };
    d.nodes[lib].children.push(id);
    for (let k = 0; k < 10; k++) {
      const x = id + '_' + k;
      d.nodes[x] = { type: 'text', id: x, parent: id, characters: 'т' };
      d.nodes[id].children.push(x);
    }
  }
  const doc = quiet(() => createDoc(d));
  const list = [];
  for (let i = 0; i < 3000; i++) {
    list.push({ op: 'create', node: { type: 'instance', id: 'x' + i, parent: 'f' + (i % 4000), of: 'm' + (i % 20) } });
    list.push({ op: 'create', node: { type: 'text', id: 'y' + i, parent: 'm' + (i % 20), characters: 'у' } });
  }
  let t = Date.now();
  const rb = rebase(doc, list);
  const rbMs = Date.now() - t;
  t = Date.now();
  const a = applyOps(doc, rb.ops);
  const apMs = Date.now() - t;
  assert.equal(a.error, undefined);
  const ref = expandCost(a.doc);
  assert.ok(ref <= MAX_EXPANDED_NODES, `итог ${ref}`);
  assert.ok(rb.dropped.length > 0 && rb.dropped.every((x) => x.limit === 'expand_nodes'));
  assert.ok(rbMs < 3000 && apMs < 3000, `rebase ${rbMs} мс, applyOps ${apMs} мс`);
  // стража дешёвая: та же пачка без неё — не в разы быстрее
  const kept = rb.ops;
  t = Date.now();
  for (let k = 0; k < 3; k++) applyOps(doc, kept, { checkExpand: false });
  const plain = (Date.now() - t) / 3;
  t = Date.now();
  for (let k = 0; k < 3; k++) applyOps(doc, kept);
  const guarded = (Date.now() - t) / 3;
  assert.ok(guarded < plain * 4 + 50, `со стражей ${guarded} мс, без неё ${plain} мс`);
});

test('круг39 N2: стража по приращениям = наивному пересчёту, когда экземпляры и узлы мастеров чередуются у самого предела', () => {
  let refusals = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const { rnd, pick, int } = rng(seed * 101);
    const { d, lib } = emptyDoc();
    const masters = [];
    for (let m = 0; m < 8; m++) {
      const id = 'm' + m;
      masters.push(id);
      d.nodes[id] = { type: 'frame', id, parent: lib, component: { name: 'M' + m, props: [] }, children: [] };
      d.nodes[lib].children.push(id);
      for (let k = 0; k < 9; k++) {
        const x = id + '_' + k;
        d.nodes[x] = { type: 'text', id: x, parent: id, characters: 'т' };
        d.nodes[id].children.push(x);
      }
    }
    // m7 вкладывает экземпляры m6 и m5: у вклада экземпляра есть глубина
    for (const [x, of] of [['m7_i1', 'm6'], ['m7_i2', 'm5'], ['m6_i1', 'm5']]) {
      const p = x.slice(0, 2);
      d.nodes[x] = { type: 'instance', id: x, parent: p, of };
      d.nodes[p].children.push(x);
    }
    const live = [];
    for (let i = 0; i < 4300 + int(200); i++) {
      const x = 'bx' + i;
      d.nodes[x] = { type: 'instance', id: x, parent: 'b0', of: pick(masters) };
      d.nodes.b0.children.push(x);
      live.push(x);
    }
    const doc = quiet(() => createDoc(d));
    const list = [];
    for (let i = 0; i < 120; i++) {
      const r = rnd();
      if (r < 0.35) {
        const x = 'ni' + i;
        live.push(x);
        list.push({ op: 'create', node: { type: 'instance', id: x, parent: 'b0', of: pick(masters) } });
      } else if (r < 0.6) list.push({ op: 'create', node: { type: 'text', id: 'nt' + i, parent: pick(masters), characters: 'у' } });
      else if (r < 0.75) list.push({ op: 'remove', id: live.splice(int(live.length), 1)[0] });
      else if (r < 0.9) list.push({ op: 'set', id: pick(live), path: 'of', value: pick(masters) });
      else list.push({ op: 'remove', id: pick(masters) + '_' + int(9) });
    }
    const ref = referenceDecisions(doc, list);
    const rb = quiet(() => rebase(doc, clone(list)));
    const got = rb.dropped.filter((x) => x.limit === 'expand_nodes').map((x) => x.index);
    assert.deepEqual(got, ref.expandIdx, `seed ${seed}: отказы expand_nodes`);
    assert.equal(hashDoc(quiet(() => applyOps(doc, rb.ops)).doc), hashDoc(ref.final), `seed ${seed}: итог = эталону`);
    refusals += got.length;
  }
  assert.ok(refusals > 20, `отказов: ${refusals}`);
});

test('круг39 N2: деградация раскрывает дешёвые экземпляры, заглушки стабильны по ссылке', () => {
  const raw = chainDoc(9, 5);
  const lib = libraryNode(raw).id;
  raw.nodes.btn = { type: 'frame', id: 'btn', parent: lib, component: { name: 'Кнопка', props: [] }, children: [] };
  raw.nodes[lib].children.push('btn');
  raw.nodes.ib = { type: 'instance', id: 'ib', parent: 'b0', of: 'btn' };
  raw.nodes.ih = { type: 'instance', id: 'ih', parent: 'b0', of: 'f_q0', name: 'Тяжёлый', size: { w: { mode: 'fixed', value: 120 }, h: { mode: 'fixed', value: 40 } } };
  raw.nodes.b0.children.push('ib', 'ih');
  const doc = quiet(() => createDoc(raw));
  const ex = quiet(() => expandDoc(doc));
  assert.ok(ex.nodes.ib && !ex.nodes.ib.stub, 'кнопка раскрыта');
  assert.ok(ex.nodes.ih.stub && ex.skipped.includes('ih'), 'тяжёлый — заглушка');
  assert.equal(ex.nodes.ih.name, 'Тяжёлый');
  assert.deepEqual(ex.nodes.ih.size, { w: { mode: 'fixed', value: 120 }, h: { mode: 'fixed', value: 40 } }, 'заглушка на месте и в размер экземпляра');
  const geo = quiet(() => solve(doc, { selfTest: false, ...M }));
  assert.equal(geo.rects.ih.w, 120);
  assert.equal(geo.rects.ih.h, 40);
  assert.ok(Object.values(ex.nodes).filter((n) => !n.stub).length <= MAX_EXPANDED_NODES);
  // повторное раскрытие (кеш) — то же и теми же объектами (точечная отрисовка сравнивает ссылки)
  const again = quiet(() => expandDoc(doc));
  assert.deepEqual(Object.keys(again.nodes).sort(), Object.keys(ex.nodes).sort());
  assert.equal(again.nodes.ih, ex.nodes.ih);
  assert.ok(DEGRADED_INSTANCE_NODES < MAX_EXPANDED_NODES);
});

test('круг39 N2: обычные документы — без замечаний и без заглушек; демо — стоимость = раскрытию', () => {
  for (const kind of ['demo', 'empty']) {
    const doc = createDoc(kind);
    const ex = expandDoc(doc);
    assert.equal(ex.skipped, undefined);
    assert.equal(expandCost(doc), Object.keys(ex.nodes).length);
    assert.equal(expandProblem(doc), null);
    assert.equal(validate(doc, solve(doc, M)).filter((v) => v.code === 'expand-limit').length, 0);
  }
});

/* ============================== N3 ============================== */

/** Правка легла, импортируется, отмена точна. */
function soundDup(doc, r, what) {
  assert.equal(r.error, undefined, `${what}: ${r.error}`);
  const a = quiet(() => applyOps(doc, clone(r.ops)));
  assert.equal(a.error, undefined, `${what}: ${a.error && a.error.message}`);
  assert.equal(checkImportDoc(clone(a.doc)), null, `${what}: импорт`);
  const back = applyOps(a.doc, invertOps(doc, clone(r.ops)));
  assert.equal(back.error, undefined);
  assert.equal(hashDoc(back.doc), hashDoc(doc), `${what}: отмена точна`);
  // сервер (rebase на ту же голову) принимает всё
  const rb = rebase(doc, clone(r.ops));
  assert.deepEqual(rb.dropped, [], `${what}: rebase ничего не отбросил`);
  return a.doc;
}

test('круг39 N3: копия каждого мастера демо — новый компонент «… копия», пропсы смотрят внутрь копии', () => {
  const doc = createDoc('demo');
  const masters = components(doc);
  assert.ok(masters.length >= 3);
  for (const m of masters) {
    const r = duplicateOps(doc, [m.id]);
    const after = soundDup(doc, r, m.name);
    assert.deepEqual(r.roots, [m.id]);
    assert.equal(r.ids.length, 1);
    const copy = after.nodes[r.ids[0]];
    assert.equal(copy.parent, libraryNode(doc).id, 'копия мастера — в библиотеке');
    assert.equal(copy.component.name, `${m.name} копия`);
    const inside = new Set(core.subtreeIds ? core.subtreeIds(after, copy.id) : []);
    const orig = doc.nodes[m.id].component.props;
    assert.equal(copy.component.props.length, orig.length, 'пропсы все');
    for (const p of copy.component.props) {
      assert.ok(after.nodes[p.target], `цель «${p.name}» есть`);
      let cur = after.nodes[p.target];
      while (cur && cur.id !== copy.id) cur = after.nodes[cur.parent];
      assert.ok(cur, `цель «${p.name}» внутри копии`);
      if (inside.size) assert.ok(inside.has(p.target));
    }
    // экземпляр копии ставится и раскрывается
    const inst = core.instanceOps(after, { of: copy.id, parent: core.artboards(after)[0].id });
    assert.ok(inst.length, 'экземпляр копии ставится');
    const withInst = applyOps(after, inst);
    assert.equal(withInst.error, undefined);
    assert.equal(validate(withInst.doc, solve(withInst.doc, M)).filter((v) => ['dead-instance', 'unknown-prop'].includes(v.code)).length, 0);
    // ещё одна копия того же мастера — свободное имя
    const r2 = duplicateOps(after, [m.id]);
    const after2 = soundDup(after, r2, m.name + ' 2');
    assert.equal(after2.nodes[r2.ids[0]].component.name, `${m.name} копия 2`);
  }
  // все мастера разом
  const all = duplicateOps(doc, masters.map((m) => m.id));
  const afterAll = soundDup(doc, all, 'все мастера');
  assert.equal(components(afterAll).length, masters.length * 2);
});

test('круг39 N3: «родитель + его ребёнок» копирует только родителя; страница и библиотека — честный отказ словами', () => {
  const doc = createDoc('demo');
  const board = core.artboards(doc)[0];
  const child = board.children.find((id) => (doc.nodes[id].children || []).length);
  const grand = doc.nodes[child].children[0];
  const r = duplicateOps(doc, [child, grand]);
  assert.deepEqual(r.roots, [child], 'только родитель');
  const after = soundDup(doc, r, 'родитель+ребёнок');
  const size = (d, id) => core.subtreeIds(d, id).length;
  assert.equal(size(after, r.ids[0]), size(doc, child), 'ребёнок скопирован один раз — в копии родителя');
  assert.equal(Object.keys(after.nodes).length, Object.keys(doc.nodes).length + size(doc, child));
  // порядок выделения не важен
  assert.deepEqual(duplicateOps(doc, [grand, child]).roots, [child]);

  for (const ids of [[doc.root], [libraryNode(doc).id], [board.parent === doc.root ? doc.root : board.parent], ['нет-такого'], []]) {
    const bad = duplicateOps(doc, ids);
    assert.ok(bad.error, `отказ: ${JSON.stringify(ids)}`);
    assert.deepEqual(bad.ops, []);
    assert.ok(!/[a-z]_[0-9a-z]{6,}/.test(bad.error), 'в словах нет id');
  }
});

test('круг39 N3: в свободной рамке и на холсте копия сдвинута на 16 (или шаг), в потоке — следующий сосед', () => {
  let doc = createDoc('empty');
  const root = doc.root;
  const fr = 'f_free';
  const rect = 'n_rect';
  const flow = 'f_flow';
  const item = 'n_item';
  doc = applyOps(doc, [
    { op: 'create', node: { type: 'frame', id: fr, parent: root, name: 'Свободная', layout: { mode: 'none' }, pos: { x: 100, y: 50 }, size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } } } },
    { op: 'create', node: { type: 'rect', id: rect, parent: fr, name: 'Квадрат', pos: { x: 10, y: 20 }, size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 40 } } } },
    { op: 'create', node: { type: 'frame', id: flow, parent: fr, name: 'Поток', layout: { mode: 'column' }, pos: { x: 200, y: 0 } } },
    { op: 'create', node: { type: 'text', id: item, parent: flow, characters: 'пункт' } }
  ]).doc;
  // свободная рамка: +16
  let r = duplicateOps(doc, [rect]);
  let after = soundDup(doc, r, 'свободная');
  assert.equal(DUPLICATE_OFFSET, 16);
  assert.deepEqual(after.nodes[r.ids[0]].pos, { x: 26, y: 36 }, 'копия не ложится на оригинал');
  assert.equal(after.nodes[fr].children.indexOf(r.ids[0]), after.nodes[fr].children.indexOf(rect) + 1);
  assert.equal(after.nodes[r.ids[0]].name, 'Квадрат копия');
  // шаг задаёт вызывающий
  r = duplicateOps(doc, [rect], { offset: 8 });
  assert.deepEqual(soundDup(doc, r, 'шаг 8').nodes[r.ids[0]].pos, { x: 18, y: 28 });
  // доска на холсте: тоже pos
  r = duplicateOps(doc, [fr]);
  after = soundDup(doc, r, 'доска');
  assert.deepEqual(after.nodes[r.ids[0]].pos, { x: 116, y: 66 });
  // поток: без pos, сразу после оригинала
  r = duplicateOps(doc, [item]);
  after = soundDup(doc, r, 'поток');
  assert.equal(after.nodes[r.ids[0]].pos, undefined);
  assert.deepEqual(after.nodes[flow].children, [item, r.ids[0]]);
});

test('круг39 N3: два соседа — каждая копия сразу после своего оригинала', () => {
  let doc = createDoc('empty');
  const fl = 'f_l';
  doc = applyOps(doc, [
    { op: 'create', node: { type: 'frame', id: fl, parent: doc.root, layout: { mode: 'row' }, pos: { x: 0, y: 0 } } },
    { op: 'create', node: { type: 'text', id: 'a', parent: fl, characters: 'a' } },
    { op: 'create', node: { type: 'text', id: 'b', parent: fl, characters: 'b' } },
    { op: 'create', node: { type: 'text', id: 'c', parent: fl, characters: 'c' } }
  ]).doc;
  const r = duplicateOps(doc, ['a', 'c', 'b']);
  const after = soundDup(doc, r, 'соседи');
  const [ca, cc, cb] = r.ids;
  assert.deepEqual(after.nodes[fl].children, ['a', ca, 'b', cb, 'c', cc]);
});

test('круг39 N3: Stage._duplicate (⌘/Ctrl+D) идёт через duplicateOps — копия мастера ложится', () => {
  const doc = createDoc('demo');
  const st = Object.create(Stage.prototype);
  st.doc = doc;
  st.opts = {};
  const committed = [];
  let selected = null;
  st._commit = (list, label) => committed.push({ list, label });
  st._emitSelect = (ids) => { selected = ids; };
  st._fail = (where, e) => { throw e; };
  const m = components(doc)[0];
  st._duplicate([m.id]);
  assert.equal(committed.length, 1);
  const a = applyOps(doc, committed[0].list);
  assert.equal(a.error, undefined, a.error && a.error.message);
  assert.equal(a.doc.nodes[selected[0]].component.name, `${m.name} копия`);
  assert.match(committed[0].label, /Дублировать/);
  // оболочка может забрать клавишу себе — тогда Stage не коммитит сам
  let hooked = null;
  st.opts = { onDuplicate: (ids) => { hooked = ids; } };
  st._duplicate([m.id]);
  assert.deepEqual(hooked, [m.id]);
  assert.equal(committed.length, 1);
});

/* ======================= пути: эталон и одиночный M ======================= */

/**
 * НЕЗАВИСИМЫЙ эталон разбора пути SVG (простая реализация по спецификации,
 * без кода ядра): токены регуляркой, абсолютные координаты, рамка — плотной
 * выборкой каждого сегмента (дуги — по SVG 1.1 F.6.5), правило Skia для M
 * после M. Нужен, чтобы ловить ошибки вроде «относительный h прибавляет cy»
 * (мутант V01), «S без отражения» (V05), «Z не возвращает точку» (V07).
 */
function refPath(d) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const N = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const cmds = [];
  let i = 0;
  let x = 0; let y = 0; let sx = 0; let sy = 0;
  let cmd = null;
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (up === 'Z') { cmds.push({ c: 'Z', a: [] }); x = sx; y = sy; continue; }
    const a = toks.slice(i, i + N[up]).map(Number);
    i += N[up];
    if (up === 'H') { const nx = rel ? x + a[0] : a[0]; cmds.push({ c: 'H', a: [nx] }); x = nx; continue; }
    if (up === 'V') { const ny = rel ? y + a[0] : a[0]; cmds.push({ c: 'V', a: [ny] }); y = ny; continue; }
    if (up === 'A') {
      const ex = rel ? x + a[5] : a[5];
      const ey = rel ? y + a[6] : a[6];
      cmds.push({ c: 'A', a: [a[0], a[1], a[2], a[3], a[4], ex, ey] });
      x = ex; y = ey;
      continue;
    }
    const abs = a.map((v, k) => (rel ? v + (k % 2 ? y : x) : v));
    cmds.push({ c: up, a: abs });
    x = abs[abs.length - 2]; y = abs[abs.length - 1];
    if (up === 'M') { sx = x; sy = y; }
  }
  return cmds;
}

/** Рамка эталона: выборка точек по каждому сегменту. */
function refBox(cmds) {
  const pts = [];
  let x = 0; let y = 0; let sx = 0; let sy = 0;
  let lastC = null; let lastQ = null;   // прошлые контрольные точки для S и T
  let pendingM = null;
  const S = 400;
  for (let k = 0; k < cmds.length; k++) {
    const { c, a } = cmds[k];
    if (c === 'M') { pendingM = [a[0], a[1]]; x = a[0]; y = a[1]; sx = x; sy = y; lastC = lastQ = null; continue; }
    if (pendingM) { pts.push(pendingM); pendingM = null; }
    if (c === 'Z') { x = sx; y = sy; lastC = lastQ = null; continue; }
    if (c === 'L' || c === 'H' || c === 'V') {
      const nx = c === 'V' ? x : a[0];
      const ny = c === 'H' ? y : c === 'V' ? a[0] : a[1];
      pts.push([nx, ny]); x = nx; y = ny; lastC = lastQ = null; continue;
    }
    if (c === 'C' || c === 'S') {
      const p1 = c === 'C' ? [a[0], a[1]] : lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      const p2 = c === 'C' ? [a[2], a[3]] : [a[0], a[1]];
      const p3 = c === 'C' ? [a[4], a[5]] : [a[2], a[3]];
      for (let s = 1; s <= S; s++) {
        const t = s / S; const u = 1 - t;
        pts.push([u * u * u * x + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * y + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
      lastC = p2; lastQ = null; x = p3[0]; y = p3[1]; continue;
    }
    if (c === 'Q' || c === 'T') {
      const p1 = c === 'Q' ? [a[0], a[1]] : lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
      const p2 = c === 'Q' ? [a[2], a[3]] : [a[0], a[1]];
      for (let s = 1; s <= S; s++) {
        const t = s / S; const u = 1 - t;
        pts.push([u * u * x + 2 * u * t * p1[0] + t * t * p2[0], u * u * y + 2 * u * t * p1[1] + t * t * p2[1]]);
      }
      lastQ = p1; lastC = null; x = p2[0]; y = p2[1]; continue;
    }
    if (c === 'A') {
      const [rxi, ryi, phiDeg, fa, fs, ex, ey] = a;
      lastC = lastQ = null;
      let rx = Math.abs(rxi); let ry = Math.abs(ryi);
      if ((x === ex && y === ey)) { x = ex; y = ey; continue; }
      if (rx === 0 || ry === 0) { pts.push([ex, ey]); x = ex; y = ey; continue; }
      const phi = phiDeg * Math.PI / 180;
      const co = Math.cos(phi); const si = Math.sin(phi);
      const hx = (x - ex) / 2; const hy = (y - ey) / 2;
      const x1 = co * hx + si * hy; const y1 = -si * hx + co * hy;
      const L = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (L > 1) { rx *= Math.sqrt(L); ry *= Math.sqrt(L); }
      const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
      const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
      const f = Math.sqrt(Math.max(0, num / den)) * (fa === fs ? -1 : 1);
      const cxp = f * rx * y1 / ry; const cyp = -f * ry * x1 / rx;
      const cx = co * cxp - si * cyp + (x + ex) / 2;
      const cy = si * cxp + co * cyp + (y + ey) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
      let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
      if (!fs && dth > 0) dth -= 2 * Math.PI;
      if (fs && dth < 0) dth += 2 * Math.PI;
      for (let s = 1; s <= S; s++) {
        const th = th1 + dth * s / S;
        pts.push([co * rx * Math.cos(th) - si * ry * Math.sin(th) + cx, si * rx * Math.cos(th) + co * ry * Math.sin(th) + cy]);
      }
      x = ex; y = ey;
    }
  }
  if (pendingM) pts.push(pendingM);
  if (!pts.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const [px, py] of pts) { x1 = Math.min(x1, px); y1 = Math.min(y1, py); x2 = Math.max(x2, px); y2 = Math.max(y2, py); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Случайный годный путь: все команды, относительные, неявные повторы, Z посреди. */
function randomPath(r) {
  const num = () => {
    const v = r.rnd() * 300 - 150;
    return r.pick([v.toFixed(0), v.toFixed(2), (v / 10).toFixed(3)]);
  };
  const sep = () => r.pick([' ', ',', ' , ']);
  let s = r.pick(['M', 'm']) + num() + sep() + num();
  const k = 1 + r.int(9);
  for (let i = 0; i < k; i++) {
    const c = r.pick(['L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't', 'A', 'a', 'Z', 'z', 'M', 'm', 'h', 'v', 's', 't']);
    const up = c.toUpperCase();
    const n = { L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0, M: 2 }[up];
    s += ' ' + c;
    if (up === 'Z') continue;
    const reps = 1 + r.int(2);
    for (let rep = 0; rep < reps; rep++) {
      for (let a = 0; a < n; a++) {
        let v = num();
        if (up === 'A' && a < 2) v = String(Math.abs(Number(v)) + 1);
        if (up === 'A' && (a === 3 || a === 4)) v = r.pick(['0', '1']);
        s += (a === 0 && rep === 0 ? ' ' : sep()) + v;
      }
    }
  }
  return s;
}

test('круг39: parsePath и pathBounds сверены с независимым эталоном на 3000 случайных путях (относительные H/V, S/T, Z, дуги, M после M)', () => {
  const r = rng(39);
  let withArc = 0;
  let checked = 0;
  for (let n = 0; n < 3000; n++) {
    const d = randomPath(r);
    const p = parsePath(d);
    assert.ok(p.ok, `годный путь разобран: ${d} — ${p.error}`);
    const ref = refPath(d);
    // абсолютные команды — те же, число в число
    assert.equal(p.cmds.length, ref.length, d);
    for (let k = 0; k < ref.length; k++) {
      assert.equal(p.cmds[k].c, ref[k].c, `${d}: команда ${k}`);
      for (let j = 0; j < ref[k].a.length; j++) {
        assert.ok(Math.abs(p.cmds[k].a[j] - ref[k].a[j]) < 1e-6, `${d}: команда ${k} (${ref[k].c}) аргумент ${j}: ${p.cmds[k].a[j]} ≠ ${ref[k].a[j]}`);
      }
    }
    // рамка: точна по кривым; дуги у ядра — выборкой в 48 шагов, поэтому допуск шире
    const box = pathBounds(d, { stroke: false });
    const rb = refBox(ref);
    const arc = ref.some((c) => c.c === 'A');
    if (arc) withArc++;
    const ext = Math.max(rb.w, rb.h, 1);
    const tol = arc ? 0.03 + 0.004 * Math.max(ext, ...ref.filter((c) => c.c === 'A').map((c) => Math.max(Math.abs(c.a[0]), Math.abs(c.a[1])))) : 0.03;
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.ok(Math.abs(box[k] - rb[k]) <= tol, `${d}: рамка.${k} ${box[k]} ≠ эталон ${rb[k].toFixed(3)} (допуск ${tol.toFixed(3)})`);
    }
    checked++;
  }
  assert.equal(checked, 3000);
  assert.ok(withArc > 300, `путей с дугами: ${withArc}`);
});

test('круг39: рамка пути — M сразу перед M не входит (как getBBox Chromium), M перед Z и последний M — входят; fitVector по ней', () => {
  const box = (d) => pathBounds(d, { stroke: false });
  // пример критика: был 12,12 в ширину
  assert.deepEqual(box('m11.62 -.5 M0 -175 t-.5 0'), { x: -0.5, y: -175, w: 0.5, h: 0 });
  // замеры getBBox Chromium (круг 39)
  assert.deepEqual(box('M50 50 M0 0 L10 10'), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(box('M0 0 L10 10 M100 100 M5 5 L6 6'), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(box('M100 100 m-95 -95 L6 6'), { x: 5, y: 5, w: 1, h: 1 });
  assert.deepEqual(box('M0 0 L10 10 M50 50'), { x: 0, y: 0, w: 50, h: 50 }, 'последний M входит');
  assert.deepEqual(box('M0 0 L10 10 M100 100 Z M5 5 L6 6'), { x: 0, y: 0, w: 100, h: 100 }, 'M перед Z входит');
  assert.deepEqual(box('M100 100 100 100 M0 0 L1 1'), { x: 0, y: 0, w: 100, h: 100 }, 'неявная пара после M — это L');
  assert.deepEqual(box('M0 0 L10 10 Z h5'), { x: 0, y: 0, w: 10, h: 10 }, 'Z возвращает точку');
  assert.deepEqual(box('M5 5'), { x: 5, y: 5, w: 0, h: 0 });
  const fit = fitVector([{ d: 'M300 300 M10 20 L30 60' }]);
  assert.deepEqual(fit.viewBox, { x: 10, y: 20, w: 20, h: 40 }, 'viewBox детали — по нарисованному');
});

test('круг39: кеш проверки путей ограничен по суммарной длине ключей; длинные пути — по объекту контура', () => {
  const { pathCacheStats, PATH_CACHE_CHARS } = core;
  // 600 разных путей по ~19 тыс. символов: прежний кеш держал бы их все (~11 млн символов)
  const seg = ' l1 1'.repeat(3800);
  let doc = createDoc('empty');
  doc = applyOps(doc, [{ op: 'create', node: { type: 'frame', id: 'f_a', parent: doc.root, layout: { mode: 'none' }, pos: { x: 0, y: 0 } } },
    { op: 'create', node: { type: 'vector', id: 'n_v', parent: 'f_a', viewBox: { x: 0, y: 0, w: 4000, h: 4000 }, paths: [{ d: 'M0 0 L1 1' }] } }]).doc;
  for (let i = 0; i < 600; i++) {
    const r = applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: `M${i} 0` + seg }] }]);
    assert.equal(r.error, undefined);
  }
  // и много коротких разных — вытесняются по старшинству
  for (let i = 0; i < 6000; i++) {
    assert.equal(applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: `M${i} 0 L${i + 1} 2` + ' l1 1'.repeat(i % 300) }] }]).error, undefined);
  }
  const st = pathCacheStats();
  assert.ok(st.chars <= PATH_CACHE_CHARS, `в кеше ${st.chars} символов ключей — не больше ${PATH_CACHE_CHARS}`);
  assert.ok(st.keys <= 4096);
  assert.ok(st.keys > 0);
  // поведение то же: битый длинный путь отклоняется, годный — нет; validate по документу считает контуры
  const bad = applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: 'M0 0' + seg + ' q' }] }]);
  assert.ok(bad.error);
  const ok = applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: 'M7 0' + seg }] }]);
  assert.equal(ok.error, undefined);
  const contour = ok.doc.nodes.n_v.paths[0];
  assert.equal(core.vectorSummary(ok.doc, ok.doc.nodes.n_v) !== undefined, true);
  // повторная проверка того же контура не разбирает путь заново (кеш по объекту)
  const t = Date.now();
  for (let i = 0; i < 200; i++) validate(ok.doc, solve(ok.doc, M));
  assert.ok(contour === ok.doc.nodes.n_v.paths[0]);
  assert.ok(Date.now() - t < 20000);
});

/* ===================== круг 39 (стыковка): пустая группа при слиянии ===================== */

/** Доска b0 (колонка) с тремя текстами и свободная рамка fr с двумя. */
function groupDoc() {
  const { d } = emptyDoc();
  const t = (id, parent, extra = {}) => ({ type: 'text', id, parent, characters: id, ...extra });
  d.nodes.ta = t('ta', 'b0'); d.nodes.tb = t('tb', 'b0'); d.nodes.tc = t('tc', 'b0');
  d.nodes.fr = { type: 'frame', id: 'fr', parent: 'b0', children: ['tx', 'ty'], layout: { mode: 'none' }, size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } } };
  d.nodes.tx = t('tx', 'fr', { pos: { x: 10, y: 10 } }); d.nodes.ty = t('ty', 'fr', { pos: { x: 50, y: 60 } });
  d.nodes.b0.children = ['ta', 'tb', 'tc', 'fr'];
  return quiet(() => createDoc(d));
}
/** Как SHELL.wrapOps: рамка с перечисленными детьми одной операцией (+ места детей в свободной рамке). */
const wrapLike = (id, parent, kids, index, extra = []) => [
  { op: 'create', node: { type: 'frame', id, parent, name: 'Группа', children: kids.slice(), layout: { mode: 'column' } }, index },
  ...extra,
];
const removedBy = (doc, ids) => {
  const theirs = ids.map((k) => OPS.remove(k));
  const head = applyOps(doc, theirs);
  assert.equal(head.error, undefined);
  const tomb = new Map();
  core.collectTombstones(doc, theirs, tomb);
  return { head: head.doc, tomb };
};

test('круг39 стыковка: «сгруппировать», чьих детей удалил соавтор, — dropped removed, пустой рамки нет', () => {
  const doc = groupDoc();
  const { head, tomb } = removedBy(doc, ['ta', 'tb']);
  const list = wrapLike('g1', 'b0', ['ta', 'tb'], 0);
  const before = JSON.stringify(list);
  const m = rebase(head, list, { tombstones: tomb });
  assert.equal(JSON.stringify(list), before, 'вход не меняется');
  assert.deepEqual(m.ops, []);
  assert.deepEqual(m.dropped.map((d) => [d.index, d.reason]), [[0, 'removed']]);
  assert.equal(m.dropped[0].op, list[0], 'dropped.op — исходная операция');
  // тот же вход — тот же ответ (детерминизм: DSLTS и реплика решают одинаково)
  assert.deepEqual(rebase(head, list, { tombstones: tomb }), m);

  // свободная рамка: create + места детей (set pos) — отброшено всё, транзакция пустая
  const { head: h2, tomb: t2 } = removedBy(doc, ['tx', 'ty']);
  const free = wrapLike('g2', 'fr', ['tx', 'ty'], 0, [OPS.set('tx', 'pos', { x: 0, y: 0 }), OPS.set('ty', 'pos', { x: 40, y: 50 })]);
  const m2 = rebase(h2, free, { tombstones: t2 });
  assert.deepEqual(m2.ops, []);
  assert.deepEqual(m2.dropped.map((d) => [d.index, d.reason]), [[0, 'removed'], [1, 'removed'], [2, 'removed']]);
});

test('круг39 стыковка: остался хоть один ребёнок — рамка создаётся с ним; пачка кладёт в рамку своё — рамка остаётся', () => {
  const doc = groupDoc();
  const { head, tomb } = removedBy(doc, ['ta']);
  const m = rebase(head, wrapLike('g1', 'b0', ['ta', 'tb'], 0), { tombstones: tomb });
  assert.deepEqual(m.dropped, []);
  assert.deepEqual(m.ops[0].node.children, ['tb']);
  const a = applyOps(head, m.ops);
  assert.equal(a.error, undefined);
  assert.deepEqual(a.doc.nodes.g1.children, ['tb']);

  // все дети удалены, но пачка дальше кладёт в рамку новый узел и переносит живой — рамка не пустая
  const { head: h2, tomb: t2 } = removedBy(doc, ['ta', 'tb']);
  const filled = wrapLike('g2', 'b0', ['ta', 'tb'], 0, [
    { op: 'create', node: { type: 'text', id: 'tn', parent: 'g2', characters: 'новый' } },
    OPS.move('tc', 'g2', 1),
  ]);
  const m2 = rebase(h2, filled, { tombstones: t2 });
  assert.deepEqual(m2.dropped, []);
  assert.deepEqual(m2.ops[0].node.children, []);
  const a2 = applyOps(h2, m2.ops);
  assert.equal(a2.error, undefined);
  assert.deepEqual(a2.doc.nodes.g2.children, ['tn', 'tc']);
  // в рамку кладёт операция ДО неё (не бывает в годной пачке) — не в счёт
  const early = [{ op: 'create', node: { type: 'text', id: 'tq', parent: 'g3', characters: 'x' } }, ...wrapLike('g3', 'b0', ['ta'], 0)];
  const m3 = rebase(h2, early, { tombstones: t2 });
  assert.deepEqual(m3.dropped.map((d) => [d.index, d.reason]), [[0, 'orphan'], [1, 'removed']]);
});

test('круг39 стыковка: прочие операции пачки ложатся; create без списка детей или с пустым — как прежде', () => {
  const doc = groupDoc();
  const { head, tomb } = removedBy(doc, ['ta', 'tb']);
  const list = [
    OPS.set('tc', 'name', 'Остался'),
    ...wrapLike('g1', 'b0', ['ta', 'tb'], 0),
    OPS.set('g1', 'name', 'Переименовать пустую'),   // узла нет — removed, как у удалённого
    { op: 'create', node: { type: 'frame', id: 'g_empty', parent: 'b0', children: [], layout: { mode: 'row' } } },
    { op: 'create', node: { type: 'frame', id: 'g_none', parent: 'b0', layout: { mode: 'row' } } },
  ];
  const m = rebase(head, list, { tombstones: tomb });
  assert.deepEqual(m.dropped.map((d) => [d.index, d.reason]), [[1, 'removed'], [2, 'removed']]);
  const a = applyOps(head, m.ops);
  assert.equal(a.error, undefined);
  assert.equal(a.doc.nodes.tc.name, 'Остался');
  assert.ok(a.doc.nodes.g_empty && a.doc.nodes.g_none, 'пустая рамка, заведённая пустой намеренно, — создаётся');
  assert.ok(!a.doc.nodes.g1);
  // без чужих правок «сгруппировать» ложится как есть
  const plain = rebase(doc, wrapLike('g1', 'b0', ['ta', 'tb'], 0));
  assert.deepEqual(plain.dropped, []);
  assert.deepEqual(applyOps(doc, plain.ops).doc.nodes.g1.children, ['ta', 'tb']);
});
