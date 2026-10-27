/**
 * Мутанты правил ядра против отпечатка формата (SPEC §8.3, §9.20). Воссоздано по отчёту критика
 * архитектуры круга 44 (`r44/mut.py`, `r44/mut2.py`) и проходам круга 45.
 *
 *   env -u NODE_OPTIONS node tools/critic/format-mutants.mjs [--only <часть имени>]
 *
 * Каждый мутант — копия `src/core.js` с заменами (каждая строка замены должна встретиться в ядре
 * ровно столько раз, сколько указано), свой файл и свой модуль. Мутант «пойман», если отпечаток
 * (`FORMAT_SIGNATURE.hash`) у него другой. Проба (если есть) показывает, что мутант меняет поведение:
 * та же пачка операций у ядра и у мутанта ложится по-разному. Выход 1 — есть непойманный мутант
 * с отличающимся поведением (дыра в отпечатке: две сборки одной версии разойдутся на одном журнале).
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const coreUrl = new URL('../../src/core.js', import.meta.url);
const src = readFileSync(coreUrl, 'utf8');

/** [имя, [[было, стало, сколько раз (1)], …], проба: (core) => строка-итог | null] */
const MUTANTS = [
  // круг 44 (Д1): правила, которых таблицы отпечатка не видели
  ['opacity узла 0..2', [
    ["opacity: { check: (v) => (isNum(v) && v >= 0 && v <= 1 ? null : 'opacity вне 0..1') },", "opacity: { check: (v) => (isNum(v) && v >= 0 && v <= 2 ? null : 'opacity вне 0..1') },"],
    ['node.opacity < 0 || node.opacity > 1)', 'node.opacity < 0 || node.opacity > 2)']
  ], (core) => setOn(core, 'opacity', 1.5)],
  ['pos — достаточно x', [
    ["pos: { check: (v) => (isObj(v) && POS_AXES.every((a) => isNum(v[a])) ? null : 'pos: нужны числа x,y') },", "pos: { check: (v) => (isObj(v) && isNum(v.x) ? null : 'pos: нужны числа x,y') },"],
    ["if (!node.pos || !isNum(node.pos.x) || !isNum(node.pos.y)) return 'pos: нужны числа x,y';", "if (!node.pos || !isNum(node.pos.x)) return 'pos: нужны числа x,y';"]
  ], (core) => setOn(core, 'pos', { x: 5 })],
  ['prototype вне PROTECTED_PATHS', [
    ["const PROTECTED_PATHS = new Set(['id', 'type', 'parent', 'children', '__proto__', 'prototype', 'constructor']);", "const PROTECTED_PATHS = new Set(['id', 'type', 'parent', 'children', '__proto__', 'constructor']);"]
  ], (core) => setOn(core, 'prototype', 1)],
  // круг 45: «сохранение формы» при set и ветви отмены (exact)
  ['строка поверх объекта заменяет объект', [["if (typeof value === 'string' && cur && typeof cur === 'object') return cur;", '']], null],
  ['radius без keepRadiusForm', [["if (field === 'radius') return keepRadiusForm(doc, node.radius, value);", '']], null],
  ['radius-массив без проверки длины', [['if (!Array.isArray(cur) || cur.length !== value.length) return value;', 'if (!Array.isArray(cur)) return value;']], null],
  ['exact всё равно сохраняет форму', [['const value = !op.exact ? keepFieldForm(node, path, op.value, draft) : op.value;', 'const value = keepFieldForm(node, path, op.value, draft);']], null],
  ['checkNode в set строгий', [['let err = checkNode(next, draft, !!op.exact);', 'let err = checkNode(next, draft, false);']], null],
  ['без «причина была и до правки»', [['if (err && !fieldProblem(next, parts[0])) {', 'if (false) {']], null]
];

/** Проба: доска демо-документа, set поля; итог — «принято» или текст отказа. */
function setOn(core, path, value) {
  const d = core.createDoc('demo');
  const board = core.artboards(d)[0].id;
  const w = console.warn;
  console.warn = () => {};
  try {
    const r = core.applyOps(d, [{ op: 'set', id: board, path, value }]);
    return r.error ? 'отказ: ' + r.error.message : 'принято';
  } finally { console.warn = w; }
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const base = await import(coreUrl.href);
const dir = mkdtempSync(join(tmpdir(), 'imago-format-mut-'));
const rows = [];
let holes = 0;
try {
  let n = 0;
  for (const [name, edits, probe] of MUTANTS) {
    if (only && !name.includes(only)) continue;
    let text = src;
    for (const [from, to, times = 1] of edits) {
      const count = text.split(from).length - 1;
      if (count !== times) throw new Error(`«${name}»: строка замены встречается ${count} раз, ждали ${times}: ${from.slice(0, 80)}`);
      text = text.split(from).join(to);
    }
    const file = join(dir, `m${n++}.mjs`);   // по номеру: кириллица в имени файла склеивала мутантов в один модуль
    writeFileSync(file, text);
    const m = await import(pathToFileURL(file).href);
    const caught = m.FORMAT_SIGNATURE.hash !== base.FORMAT_SIGNATURE.hash;
    const was = probe ? probe(base) : '';
    const now = probe ? probe(m) : '';
    const differs = probe ? was !== now : null;
    if (!caught && differs !== false) holes += 1;
    rows.push({ мутант: name, отпечаток: caught ? 'ловит' : 'НЕ ловит', ядро: was, мутант_проба: now });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.table(rows);
if (holes) { console.error(`Непойманных мутантов: ${holes}`); process.exit(1); }
