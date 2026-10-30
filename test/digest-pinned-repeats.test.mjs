/**
 * Выжимка документа (describeDoc, шаг 3 — однотипные повторы): узел на пути к области работы — граница
 * группы. Раньше секция с выделенной карточкой сворачивалась в «… ещё N таких же узлов» вместе с соседями,
 * и модель не видела, с чем работает (большие документы от 1000 узлов — в каждом прогоне).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { describeDoc } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

/** 2 доски × 8 секций × 4 ряда × 5 карточек × (заголовок + текст) ≈ 1000 узлов, всё однотипное. */
function bigDoc() {
  const d = quiet(() => core.createDoc('empty'));
  const ops = [];
  let n = 0;
  for (let b = 1; b <= 2; b++) {
    const bid = `B${b}`;
    ops.push(core.ops.create({ id: bid, type: 'frame', name: `Экран ${b}`, parent: d.root, layout: { mode: 'column', gap: 16 }, children: [] }));
    for (let s = 1; s <= 8; s++) {
      const sid = `${bid}S${s}`;
      ops.push(core.ops.create({ id: sid, type: 'frame', name: `Секция ${s}`, parent: bid, layout: { mode: 'column', gap: 8 }, children: [] }));
      for (let r = 1; r <= 4; r++) {
        const rid = `${sid}R${r}`;
        ops.push(core.ops.create({ id: rid, type: 'frame', name: `Ряд ${r}`, parent: sid, layout: { mode: 'row', gap: 8 }, children: [] }));
        for (let c = 1; c <= 5; c++) {
          const cid = `${rid}C${c}`;
          ops.push(core.ops.create({ id: cid, type: 'frame', name: `Карточка ${c}`, parent: rid, layout: { mode: 'column', gap: 4 }, children: [] }));
          ops.push(core.ops.create({ id: `${cid}h`, type: 'text', name: 'Заголовок', parent: cid, characters: `Товар ${++n}` }));
          ops.push(core.ops.create({ id: `${cid}t`, type: 'text', name: 'Цена', parent: cid, characters: `${n * 10} ₽` }));
        }
      }
    }
  }
  const r = core.applyOps(d, ops);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.ok(Object.keys(r.doc.nodes).length >= 1000, `узлов ${Object.keys(r.doc.nodes).length}`);
  return r.doc;
}

test('выжимка: выделенная карточка в 4-й секции второй доски не сворачивается с однотипными соседями', () => {
  const doc = bigDoc();
  const target = 'B2S4R3C2';
  // тесная выжимка: шаг 3 (однотипные повторы) доходит до пути к выделенному
  for (const limit of [1600, 2400, 4000]) {
    const text = describeDoc(doc, [target], { engine: core, limit });
    // строка «РАБОТАЕМ С:» называет id всегда — проверяем саму строку узла в дереве
    assert.match(text, /#B2S4R3C2 frame "Карточка 2".*◀ ВЫДЕЛЕНО/, `строка выделенной карточки есть (предел ${limit})`);
    assert.doesNotMatch(text, /таких же узлов свёрнуто \(«[^»]*» … «Секция 4»\)/, `секцию с выделенным не прячем (предел ${limit})`);
    assert.ok(text.length <= limit, `предел выжимки соблюдён (${text.length} > ${limit})`);
  }
});

test('выжимка: однотипные соседи вокруг пути всё равно сворачиваются (экономия не потеряна)', () => {
  const text = describeDoc(bigDoc(), ['B2S4R3C2'], { engine: core, limit: 4000 });
  assert.match(text, /свёрнуто/);
});
