/**
 * Круг 39 (стыковка N2): правило «документ, уже бывший сверх предела раскрытия экземпляров
 * (прежним журналом), можно править, но не раздувать» — одно и то же у ядра (applyOps/rebase),
 * Document service (DSLTS mergeIntoHead; запасной путь expand.js для движка без стражи) и
 * Orchestrator (DSLV: brain expandOverflow после applyOps ядра). Формула у всех трёх:
 * отказ ⇔ стоимость после > MAX_EXPANDED_NODES и стоимость после > стоимости до.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core.js';
import { uid, ENGINE_VERSION } from '../../src/core.js';
import { mergeIntoHead } from '../../server/document/dslts.js';
import { expandGrowthOver, mayGrowExpand } from '../../server/document/expand.js';
import { CODE_ENGINE } from '../../server/document/engine.js';
import { expandOverflow, runCommand } from '../../src/brain.js';
import { startFor, api, quiet as quietLog } from './helpers.mjs';

const MAX = core.MAX_EXPANDED_NODES;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

/** Цепочка: L мастеров, в каждом W экземпляров следующего; доска b0 с текстом и экземпляром. */
function legacyDoc(L = 9, W = 5) {
  const d = JSON.parse(JSON.stringify(core.createDoc('empty')));
  const lib = core.libraryNode(d).id;
  d.nodes.b0 = { type: 'frame', id: 'b0', parent: d.root, name: 'Доска', children: ['t0', 'i_b0'], size: { w: { mode: 'fixed', value: 800 }, h: { mode: 'fixed', value: 600 } }, layout: { mode: 'column' } };
  d.nodes.t0 = { type: 'text', id: 't0', parent: 'b0', name: 'Заголовок', characters: 'Заголовок' };
  d.nodes.i_b0 = { type: 'instance', id: 'i_b0', parent: 'b0', of: 'f_q2', name: 'Тяжёлый блок' };
  d.nodes[d.root].children.unshift('b0');
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
  return quiet(() => core.createDoc(d));
}

/** Транзакции и ожидаемое решение: null — принимается, иначе индексы отброшенных за предел. */
const CASES = [
  { name: 'удаление экземпляра', ops: [{ op: 'remove', id: 'i_q0_0' }], refused: [] },
  { name: 'удаление экземпляра на доске', ops: [{ op: 'remove', id: 'i_b0' }], refused: [] },
  { name: 'цвет узла доски', ops: [{ op: 'set', id: 't0', path: 'fill', value: '#e5484d' }], refused: [] },
  { name: 'цвет мастера в библиотеке', ops: [{ op: 'set', id: 'f_q3', path: 'fill', value: '#30a46c' }], refused: [] },
  { name: 'новый текст (не экземпляр)', ops: [{ op: 'create', node: { type: 'text', id: 't_new', parent: 'b0', characters: 'ещё' } }], refused: [] },
  { name: 'экземпляр тяжёлого мастера', ops: [{ op: 'create', node: { type: 'instance', id: 'i_more', parent: 'b0', of: 'f_q1' } }], refused: [0] },
  { name: 'цвет + экземпляр', ops: [{ op: 'set', id: 't0', path: 'fill', value: '#e5484d' }, { op: 'create', node: { type: 'instance', id: 'i_more2', parent: 'b0', of: 'f_q2' } }], refused: [1] },
  { name: 'удалил дорогой, добавил такой же (не растёт)', ops: [{ op: 'remove', id: 'i_b0' }, { op: 'create', node: { type: 'instance', id: 'i_same', parent: 'b0', of: 'f_q2' } }], refused: [] },
];

describe('круг 39: документ сверх предела раскрытия — править можно, раздувать нельзя (ядро = DSLTS = DSLV)', () => {
  const doc = legacyDoc();
  const before = core.expandCost(doc);

  it('исходный документ — сверх предела (как из прежнего журнала)', () => {
    assert.ok(before > MAX, `стоимость ${before} > ${MAX}`);
    assert.ok(core.expandProblem(doc));
    assert.ok(core.checkImportDoc(JSON.parse(JSON.stringify(doc))), 'импортом такой не завести');
  });

  for (const c of CASES) {
    it(`${c.name}: ${c.refused.length ? 'отказ expand_nodes' : 'принимается'} — у всех трёх`, () => {
      const ops = JSON.parse(JSON.stringify(c.ops));
      const okAll = !c.refused.length;
      // ядро: applyOps (атомарно — пачка целиком) и rebase (по операции)
      const a = quiet(() => core.applyOps(doc, ops));
      if (okAll) assert.equal(a.error, undefined, a.error && a.error.message);
      else assert.equal(a.error && a.error.limit, 'expand_nodes');
      const rb = quiet(() => core.rebase(doc, ops));
      assert.deepEqual(rb.dropped.map((d) => [d.index, d.reason, d.limit]), c.refused.map((i) => [i, 'invalid', 'expand_nodes']));
      // Document service: слияние секвенсора — те же отброшенные, документ головы — без них
      const m = quiet(() => mergeIntoHead({ doc, tombstones: new Map() }, { ops }));
      assert.deepEqual(m.dropped.map((d) => [d.index, d.reason, d.limit]), c.refused.map((i) => [i, 'invalid', 'expand_nodes']));
      const after = m.doc;
      assert.ok(core.expandCost(after) <= Math.max(MAX, before), 'голова не раздулась');
      // запасной путь сервиса (движок без стражи): та же формула по пачке целиком
      const raw = quiet(() => core.applyOps(doc, ops, { checkExpand: false }));
      assert.equal(raw.error, undefined);
      const grew = mayGrowExpand(ops) ? expandGrowthOver(doc, raw.doc) : null;
      assert.equal(!!grew, !okAll, 'expand.js: ' + JSON.stringify(grew));
      // Orchestrator (DSLV): materialize — applyOps ядра, затем expandOverflow(до, после)
      const over = expandOverflow(core, doc, raw.doc);
      assert.equal(!!over, !okAll, 'brain.expandOverflow: ' + JSON.stringify(over));
      if (okAll) assert.equal(expandOverflow(core, doc, a.doc), null);
      else assert.equal(over.limit, 'expand_nodes');
    });
  }

  it('DSLV целиком (brain runCommand, модель поддельная): удаление и цвет — без круга починки и без «Проверки макета»; копия тяжёлого — not_applied', async () => {
    const fake = (script) => {
      const calls = [];
      return {
        name: 'fake', calls, async ready() { return true; },
        async complete(messages, schema) {
          calls.push(schema && schema.name);
          const v = script[schema && schema.name];
          if (v === undefined) throw new Error('нет ответа для схемы ' + (schema && schema.name));
          return JSON.parse(JSON.stringify(v));
        },
      };
    };
    const go = async (utterance, edits) => {
      const provider = fake({ plan: { intent: 'edit', title: utterance, summary: utterance, steps: [utterance] }, patch: { edits } });
      const res = await quiet(() => runCommand({ doc, selection: [], utterance, provider, engine: core, activeArtboardId: 'b0' }));
      return { res, calls: provider.calls };
    };
    for (const [utterance, edits, want] of [
      ['удали тяжёлый блок', [{ op: 'remove', target: 'Тяжёлый блок' }], [{ op: 'remove', id: 'i_b0' }]],
      ['покрась доску в красный', [{ op: 'set', target: 'Доска', path: 'fill', value: '#e5484d' }], [{ op: 'set', id: 'b0', path: 'fill', value: '#e5484d' }]],
    ]) {
      const { res, calls } = await go(utterance, edits);
      assert.equal(res.error, undefined, utterance + ': ' + JSON.stringify(res.error));
      assert.deepEqual(res.ops, want, utterance);
      assert.deepEqual(calls, ['plan', 'patch'], utterance + ': без круга починки — прежнее превышение не вина правки');
      assert.ok(!(res.warnings || []).some((w) => /вложенных экземпляров/.test(w)), utterance + ': ' + JSON.stringify(res.warnings));
    }
    const { res, calls } = await go('добавь ещё такой же тяжёлый блок', [{ op: 'duplicate', target: 'Тяжёлый блок' }]);
    assert.deepEqual(res.ops, []);
    assert.equal(res.error && res.error.code, 'not_applied', JSON.stringify(res.error));
    assert.match(res.error.message, /вложенных экземпляров/);
    assert.deepEqual(calls, ['plan', 'patch', 'patch'], 'раздувание — нарушение для круга починки');
  });

  it('сервис целиком: проект сверх предела из прежнего журнала — удаление и цвет 201 без dropped, экземпляр — dropped expand_nodes · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0, log: quietLog });
    try {
      // прежний журнал: документ лёг в хранилище мимо импорта (сегодня импорт его не пустит)
      const P = (await svc.storage.createProject({ name: 'легаси', doc, engine: CODE_ENGINE })).id;
      const h = api(svc.url);
      const tx = (base_seq, ops) => ({ tx_id: uid('tx'), base_seq, ops, engine: ENGINE_VERSION });
      const opened = await h.get(`/api/projects/${P}`);
      assert.equal(opened.status, 200, opened.text);
      assert.equal(core.expandCost(opened.body.snapshot.doc), before, 'читается как есть');
      const rm = await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'remove', id: 'i_q0_0' }]));
      assert.equal(rm.status, 201, rm.text);
      assert.deepEqual(rm.body.dropped || [], []);
      const color = await h.post(`/api/projects/${P}/tx`, tx(1, [{ op: 'set', id: 't0', path: 'fill', value: '#e5484d' }]));
      assert.equal(color.status, 201, color.text);
      assert.deepEqual(color.body.dropped || [], []);
      const head = (await svc.dslts.headOf(P)).doc;
      const now = core.expandCost(head);
      assert.ok(now > MAX && now < before, `после удаления — меньше, но всё ещё сверх предела: ${now}`);
      assert.equal(head.nodes.t0.fill, '#e5484d');
      const inst = await h.post(`/api/projects/${P}/tx`, tx(2, [{ op: 'create', node: { type: 'instance', id: 'i_more', parent: 'b0', of: 'f_q1' } }]));
      assert.equal(inst.status, 201, inst.text);
      assert.deepEqual((inst.body.dropped || []).map((d) => [d.index, d.reason, d.limit]), [[0, 'invalid', 'expand_nodes']]);
      assert.ok(!(await svc.dslts.headOf(P)).doc.nodes.i_more);
    } finally {
      await svc.close();
    }
  });
});
