/**
 * Выжимка документа (describeDoc, шаг 3 — однотипные повторы): узел на пути к области работы — граница
 * группы. Раньше секция с выделенной карточкой сворачивалась в «… ещё N таких же узлов» вместе с соседями,
 * и модель не видела, с чем работает (большие документы от 1000 узлов — в каждом прогоне).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { describeDoc, DIGEST_LIMIT } from '../src/brain.js';

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

/** Как в пилоте диплома: доски по ~500 узлов (секции → ряды по 4 карточки → 3 текста), всего ~50 тыс. */
function hugeDoc(target) {
  let doc = quiet(() => core.createDoc('empty'));
  const ops = [];
  let n = 1;
  for (let b = 0; n < target; b++) {
    const bid = `b${b}`;
    ops.push(core.ops.create({ id: bid, type: 'frame', name: `Экран ${b + 1}`, parent: doc.root, layout: { mode: 'column', gap: 8 }, children: [] })); n++;
    let inBoard = 1;
    for (let s = 0; inBoard < 500 && n < target; s++) {
      const sec = `${bid}s${s}`;
      ops.push(core.ops.create({ id: sec, type: 'frame', name: `Секция ${s + 1}`, parent: bid, layout: { mode: 'column', gap: 8 }, children: [] })); n++; inBoard++;
      for (let r = 0; r < 6 && inBoard < 500 && n < target; r++) {
        const row = `${sec}r${r}`;
        ops.push(core.ops.create({ id: row, type: 'frame', name: `Ряд ${r + 1}`, parent: sec, layout: { mode: 'row', gap: 8 }, children: [] })); n++; inBoard++;
        for (let c = 0; c < 4 && n < target; c++) {
          const card = `${row}c${c}`;
          ops.push(core.ops.create({ id: card, type: 'frame', name: `Карточка ${s + 1}.${r + 1}.${c + 1}`, parent: row, layout: { mode: 'column', gap: 4 }, children: [] })); n++; inBoard++;
          for (let t = 0; t < 3 && n < target; t++) {
            ops.push(core.ops.create({ id: `${card}t${t}`, type: 'text', name: ['Заголовок', 'Описание', 'Цена'][t], parent: card, characters: `текст ${n}` })); n++; inBoard++;
          }
        }
      }
    }
  }
  for (let i = 0; i < ops.length; i += 5000) {
    const r = core.applyOps(doc, ops.slice(i, i + 5000));
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    doc = r.doc;
  }
  return doc;
}

test('выжимка на 50 тыс. узлов: выделенная карточка, путь к ней и её дети — в выжимке, предел соблюдён', { timeout: 120000 }, () => {
  const doc = hugeDoc(50000);
  const geo = core.solve(doc);
  const cards = Object.keys(doc.nodes).filter((id) => /^b\d+s\d+r\d+c\d$/.test(id));
  // разные места: первая доска, середина документа, последняя доска; ряды и карточки — не первые
  for (const work of [cards[1500], cards[Math.floor(cards.length / 2) + 7], cards[cards.length - 3]]) {
    const text = describeDoc(doc, [work], { engine: core, geo });
    const has = (id) => text.includes(`#${id} `);
    assert.ok(has(work), `${work}: строка выделенного`);
    for (let t = 0; t < 3; t++) assert.ok(has(`${work}t${t}`), `${work}: ребёнок t${t}`);
    const [, board, sec, row] = work.match(/^(b\d+)(s\d+)(r\d+)/);
    assert.ok(has(board) && has(board + sec) && has(board + sec + row), `${work}: путь доска → секция → ряд`);
    assert.ok(text.length <= DIGEST_LIMIT, `предел: ${text.length}`);
    assert.equal((text.match(/называй по имени/g) || []).length, 1, 'пояснение про имена — один раз');
  }
});

test('выжимка: соседние свёрнутые диапазоны одного родителя — одна заметка', () => {
  const doc = hugeDoc(10000);
  const cards = Object.keys(doc.nodes).filter((id) => /^b\d+s\d+r\d+c\d$/.test(id));
  const text = describeDoc(doc, [cards[cards.length - 3]], { engine: core });
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    const same = a.match(/^(\s*)… ещё/) && b.match(/^(\s*)… ещё/) && a.match(/^\s*/)[0] === b.match(/^\s*/)[0];
    assert.ok(!same, `две заметки подряд на одном уровне:\n${a}\n${b}`);
  }
});

test('выжимка: ничего не свёрнуто — пояснения про имена нет; тесный предел — без него, но в пределе', () => {
  const small = bigDoc();
  const whole = describeDoc(small, ['B2S4R3C2'], { engine: core, limit: 1e9 });
  assert.doesNotMatch(whole, /называй по имени/, 'всё влезло — пояснять нечего');
  for (const limit of [200, 400]) {
    const tight = describeDoc(small, ['B2S4R3C2'], { engine: core, limit });
    assert.ok(tight.length <= limit, `предел ${limit}: ${tight.length}`);
  }
});
