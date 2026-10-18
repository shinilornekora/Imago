/**
 * Круг 39 — brain (N2, N5б, N5в, N5г):
 *   • распознавание отмены/компонентов линейно — длинная реплика не держит главный поток;
 *   • вывод brain на шкалах: свежий рисунок, дерево, правка — `ensureScaleRefsOps` пуст
 *     (никакой «миграции формата» у документа, созданного этой же версией);
 *   • детали рисунка: одно имя — один слой (никаких двух соседних «Крошки»);
 *   • предел раскрытия экземпляров — нарушение для круга починки, легаси-документ не запирается.
 * Модель поддельная, движок — настоящий core.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import {
  runCommand, SCHEMAS, compileIllustration, recognizeAction, recognizeUndoDoubt, recognizeComponentIntent,
  recognizeVariants, expandOverflow,
} from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function fake(script) {
  const calls = [];
  return {
    name: 'fake', calls,
    async ready() { return true; },
    async complete(messages, schema) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages });
      let v = script[name];
      if (Array.isArray(v)) v = v.length > 1 ? v.shift() : v[0];
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

const boardOf = (doc) => Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
function demo() {
  const doc = quiet(() => core.createDoc());
  return { doc, board: boardOf(doc).id };
}

/* ── N5б: линейное распознавание ───────────────────────────────────────── */

test('круг 39 N5б: отмена, переспрос и компоненты на 5000 знаков — быстро; короткие фразы — как прежде', () => {
  const long = ['а '.repeat(2500), 'ну '.repeat(1200) + 'отмени ' + 'же '.repeat(1200), 'а '.repeat(1200) + 'x ' + 'а '.repeat(1200)];
  for (const s of long) {
    for (const f of [recognizeAction, recognizeUndoDoubt, recognizeComponentIntent]) f(s);   // прогрев
    for (const f of [recognizeAction, recognizeUndoDoubt, recognizeComponentIntent]) {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        f(s);
        best = Math.min(best, performance.now() - t);
      }
      assert.ok(best < 15, `${f.name} на ${s.length} зн.: ${best.toFixed(1)} мс`);
    }
  }
  assert.equal(recognizeAction('ну отмени, пожалуйста'), 'undo');
  assert.equal(recognizeAction('всё не так'), 'undo');
  assert.equal(recognizeAction('давай верни обратно же'), 'redo');
  assert.equal(recognizeAction('отмени скидку в подписи'), null);
  assert.equal(recognizeAction('ну '.repeat(30) + 'отмени'), 'undo', 'затычки слева снимаются и в длинной реплике');
  assert.equal(recognizeAction('а '.repeat(2500)), null);
  assert.match(String(recognizeUndoDoubt('ну убери последнее')), /отменить последнюю правку или удалить/);
  const comp = recognizeComponentIntent('сделай карточку компонентом');
  assert.equal(comp && comp.kind, 'make');
  assert.deepEqual(recognizeVariants('покажи три варианта, пожалуйста'), { variantsOf: '' });
});

/* ── N5в: вывод brain — на шкалах ──────────────────────────────────────── */

const COOKIE = {
  name: 'Печенька', canvas: { w: 400, h: 400 },
  parts: [
    { name: 'Печенье', kind: 'ellipse', x: 70, y: 56, w: 260, h: 260, fill: '#e3a85f' },
    { name: 'Крошка 1', kind: 'ellipse', x: 318, y: 318, w: 12, h: 9, fill: '#5b3a1e', rotate: 30, group: 'Крошки' },
    { name: 'Крошка 2', kind: 'ellipse', x: 92, y: 322, w: 9, h: 7, fill: '#5b3a1e', group: 'Крошки' },
    { name: 'Крошка 3', kind: 'ellipse', x: 292, y: 338, w: 7, h: 6, fill: '#5b3a1e', group: 'Крошки' },
  ],
};
const PLAN_ART = { intent: 'illustration', title: 'Печенька', summary: 'Рисую печеньку', steps: ['Нарисовать'] };

async function run(doc, board, script, utterance, selection = []) {
  const res = await runCommand({ doc, selection, utterance, provider: fake(script), engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.ops.length, 'правка не пустая');
  return res;
}

test('круг 39 N5в: вывод brain не требует миграции шкал — рисунок новой доской, в блоке, дерево, правка с нулём', async () => {
  const cases = [
    ['рисунок новой доской', (d, b) => run(d, b, { plan: PLAN_ART, illustration: SCHEMAS.illustration.example }, 'нарисуй милого 2D-монстра')],
    ['рисунок в блоке', (d, b) => {
      const card = Object.values(d.nodes).find((n) => n.type === 'frame' && n.parent === b);
      return run(d, b, { plan: PLAN_ART, illustration: COOKIE }, 'нарисуй печеньку', [card.id]);
    }],
    ['дерево (образец схемы)', (d, b) => run(d, b, { plan: { intent: 'create', title: 'Экран заказа', summary: 'Соберу экран', steps: [] }, tree: SCHEMAS.tree.example }, 'собери экран заказа')],
    ['дерево числами', (d, b) => run(d, b, {
      plan: { intent: 'create', title: 'Карточка', summary: 'Соберу', steps: [] },
      tree: { type: 'frame', name: 'Карточка', layout: { mode: 'column', gap: 0, padding: [0, 16] }, radius: 0, children: [{ type: 'text', name: 'Т', text: 'Привет' }] },
    }, 'собери карточку')],
    ['правка: зазор 0 и скругление 0', (d, b) => {
      const card = Object.values(d.nodes).find((n) => n.name === 'Карточка встречи');
      return run(d, b, {
        plan: { intent: 'edit', title: 'Плотнее', summary: 'Уберу зазор', steps: [] },
        patch: { edits: [{ op: 'set', target: card.name, path: 'layout.gap', value: 0 }, { op: 'set', target: card.name, path: 'radius', value: 0 }] },
      }, 'убери зазор и скругление у карточки встречи');
    }],
  ];
  for (const [what, go] of cases) {
    const { doc, board } = demo();
    assert.deepEqual(core.ensureScaleRefsOps(doc), [], 'демо — на ссылках');
    const res = await go(doc, board);
    const after = res.preview.doc;
    assert.deepEqual(core.ensureScaleRefsOps(after), [], `${what}: ${JSON.stringify(core.ensureScaleRefsOps(after))}`);
    // и то же — для документа, собранного из самих операций (как его увидит журнал)
    const replay = core.applyOps(doc, res.ops);
    assert.equal(replay.error, undefined);
    assert.deepEqual(core.ensureScaleRefsOps(replay.doc), [], what);
  }
});

test('круг 39 N5в: рамка рисунка — ссылки на нулевые шаги; без шкал в документе — числа', () => {
  const doc = quiet(() => core.createDoc());
  const got = compileIllustration(COOKIE, { doc, engine: core });
  assert.equal(got.spec.layout.gap, 'spacing.0');
  assert.deepEqual(got.spec.layout.padding, { t: 'spacing.0', r: 'spacing.0', b: 'spacing.0', l: 'spacing.0' });
  assert.equal(got.spec.radius, 'radii.0');
  const bare = compileIllustration(COOKIE, {});
  assert.equal(bare.spec.layout.gap, 0);
  assert.equal(bare.spec.radius, 0);
});

/* ── N5г: одно имя — один слой ─────────────────────────────────────────── */

test('круг 39 N5г: группа «Крошки» с повёрнутой деталью — не два соседних слоя с одним именем', () => {
  const doc = quiet(() => core.createDoc());
  const names = (art) => compileIllustration(art, { doc, engine: core }).spec.children.map((c) => c.name);
  const a = names(COOKIE);
  assert.deepEqual(a, ['Печенье', 'Крошка 1', 'Крошки']);
  // группа вперемешку с чужой деталью и повёрнутая середина — все имена разные
  const mixed = clone(COOKIE);
  mixed.parts = [
    { ...COOKIE.parts[2] }, { ...COOKIE.parts[0] }, { ...COOKIE.parts[3] },
    { name: 'Крошка 4', kind: 'ellipse', x: 200, y: 340, w: 6, h: 6, fill: '#5b3a1e', group: 'Крошки', rotate: 15 },
    { name: 'Крошка 5', kind: 'ellipse', x: 210, y: 300, w: 6, h: 6, fill: '#5b3a1e', group: 'Крошки' },
    { name: 'Крошка 6', kind: 'ellipse', x: 230, y: 300, w: 6, h: 6, fill: '#5b3a1e', group: 'Крошки' },
  ];
  const b = names(mixed);
  assert.equal(new Set(b.map((n) => n.toLowerCase())).size, b.length, b.join(', '));
  // одиночные детали группы — своими именами, многодетальный кусок — именем группы
  assert.deepEqual(b, ['Крошка 2', 'Печенье', 'Крошка 3', 'Крошка 4', 'Крошки']);
  // группа без совпадений имён — как прежде
  assert.deepEqual(names({ ...COOKIE, parts: COOKIE.parts.map((p) => ({ ...p, rotate: undefined })) }), ['Печенье', 'Крошки']);
});

/* ── N2: предел раскрытия ──────────────────────────────────────────────── */

test('круг 39 N2: expandOverflow — нарушение после правки; легаси сверх предела без роста — не запирается; движок без проверки — null', () => {
  const eng = (costs) => ({
    MAX_EXPANDED_NODES: 100,
    expandCost: (d) => costs[d.k],
    expandProblem: (d) => (costs[d.k] > 100 ? { code: 'expand-limit', limit: 'expand_nodes', cost: costs[d.k], max: 100, message: `раскрытие дало бы ${costs[d.k]}` } : null),
  });
  const before = { k: 'a' };
  const after = { k: 'b' };
  assert.equal(expandOverflow(eng({ a: 10, b: 50 }), before, after), null);
  const over = expandOverflow(eng({ a: 10, b: 500 }), before, after);
  assert.equal(over.max, 100);
  assert.equal(over.cost, 500);
  assert.match(over.message, /500/);
  assert.equal(expandOverflow(eng({ a: 900, b: 800 }), before, after), null, 'легаси: стало меньше — можно');
  assert.ok(expandOverflow(eng({ a: 900, b: 901 }), before, after), 'легаси: раздувать нельзя');
  assert.equal(expandOverflow({ ...core, expandProblem: undefined }, before, after), null);
});
