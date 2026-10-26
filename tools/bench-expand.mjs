/**
 * Замер цены предела раскрытия экземпляров (docs/08-предел-раскрытия.md).
 *
 *   env -u NODE_OPTIONS node tools/bench-expand.mjs            — ядро в Node (измеритель текста по умолчанию)
 *   env -u NODE_OPTIONS node tools/bench-expand.mjs --browser  — то же в Chromium с настоящим измерением текста
 *
 * Документ: мастер из 50 узлов (рамка-колонка, тексты и прямоугольники вперемешку), экземпляры в сетке
 * с переносом на одной доске; раскрытие — 10, 20, 35 и 50 тыс. узлов. Правка — текст в мастере (её
 * видят все экземпляры) и имя сетки (экземпляров не касается). Время — лучшее из трёх. Круг 52: полная
 * раскладка с образцами экземпляров и без них (`shapes:false` — как до круга 52) и по месту правки (solveAfter).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [10000, 20000, 35000, 50000];

/** Сборка документа и замер — одна функция: в браузер она уходит текстом (page.evaluate). */
async function measure(coreUrl, sizes) {
  const { createDoc, applyOps, solve, solveAfter, expandDoc, artboards, libraryNode } = await import(coreUrl);
  const hug = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  const build = (total, perMaster = 50) => {
    const d = createDoc();
    const board = artboards(d)[0].id;
    const lib = libraryNode(d).id;
    const ops = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, name: 'Карточка', children: [], layout: { mode: 'column', gap: 4 }, size: hug } }];
    for (let i = 0; i < perMaster - 1; i++) {
      ops.push({ op: 'create', node: i % 2
        ? { type: 'text', id: 'mt' + i, parent: 'M', characters: 'Строка ' + i, size: hug }
        : { type: 'rect', id: 'mr' + i, parent: 'M', size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 8 } } } });
    }
    ops.push({ op: 'set', id: 'M', path: 'component', value: { name: 'Карточка', props: [] } });
    ops.push({ op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 8 }, size: { w: { mode: 'fixed', value: 4000 }, h: { mode: 'hug' } } } });
    for (let i = 0; i < Math.floor(total / perMaster); i++) ops.push({ op: 'create', node: { type: 'instance', id: 'I' + i, parent: 'G', of: 'M' } });
    return applyOps(d, ops, { checkExpand: false }).doc;
  };
  const best = (fn) => { let b = Infinity; let v; for (let i = 0; i < 3; i++) { const s = performance.now(); v = fn(i); b = Math.min(b, performance.now() - s); } return [Math.round(b), v]; };
  const out = [];
  for (const total of sizes) {
    const doc = build(total);
    const [expand] = best(() => expandDoc(doc));
    const [apply, r] = best((i) => applyOps(doc, [{ op: 'set', id: 'mt1', path: 'characters', value: 'Новая строка ' + i }]));
    // круг 52: каждый замер — на свежей правке (новый объект мастера): раскрытие экземпляров после
    // правки мастера считается заново, и это часть цены правки. Прежняя геометрия для solveAfter
    // готовится вне замера: она одноразовая
    let n = 0;
    const masterEdit = () => applyOps(doc, [{ op: 'set', id: 'mt1', path: 'characters', value: 'Правка ' + (n++) }]).doc;
    const otherEdit = () => applyOps(doc, [{ op: 'set', id: 'G', path: 'name', value: 'Сетка ' + (n++) }]).doc;
    const timed = (edit, run) => {
      let b = Infinity;
      for (let i = 0; i < 3; i++) {
        solve(doc);   // раскрытие прежнего документа — в кеше, как в оболочке до правки
        const prev = solve(doc, { incremental: true });
        const next = edit();
        const s = performance.now();
        run(prev, next);
        b = Math.min(b, performance.now() - s);
      }
      return Math.round(b);
    };
    const full = (opts) => (prev, next) => solve(next, opts);
    const after = (prev, next) => solveAfter(prev, doc, next);
    out.push({ nodes: total, expandDoc: expand, applyOps: apply,
      'мастер: solve без образцов': timed(masterEdit, full({ shapes: false })),
      'мастер: solve': timed(masterEdit, full()), 'мастер: solveAfter': timed(masterEdit, after),
      'вне: solve без образцов': timed(otherEdit, full({ shapes: false })),
      'вне: solve': timed(otherEdit, full()), 'вне: solveAfter': timed(otherEdit, after) });
  }
  // круг 52: смешанный документ — 1250 карточек по 4 настоящих слоя и экземпляры рядом; правка текста карточки
  for (const count of [100, 1000]) {
    const base = build(count * 50);
    const board = artboards(base)[0].id;
    const list = [{ op: 'create', node: { type: 'frame', id: 'C', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 16 }, size: { w: { mode: 'fixed', value: 1440 }, h: { mode: 'hug' } } } }];
    for (let i = 0; i < 1250; i++) list.push(
      { op: 'create', node: { type: 'frame', id: 'c' + i, parent: 'C', children: [], layout: { mode: 'column', gap: 8 }, size: { w: { mode: 'fixed', value: 220 }, h: { mode: 'hug' } } } },
      { op: 'create', node: { type: 'text', id: 'c' + i + 't', parent: 'c' + i, characters: 'Заголовок ' + i, size: { w: { mode: 'fill' }, h: { mode: 'hug' } } } },
      { op: 'create', node: { type: 'text', id: 'c' + i + 'b', parent: 'c' + i, characters: 'Подпись карточки, что переносится', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } } },
      { op: 'create', node: { type: 'rect', id: 'c' + i + 'r', parent: 'c' + i, size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 6 } } } });
    const mixed = applyOps(base, list, { checkExpand: false }).doc;
    let k = 0;
    const edit = () => applyOps(mixed, [{ op: 'set', id: 'c625b', path: 'characters', value: 'Правка ' + (k++) }]).doc;
    const timedMixed = (run) => {
      let b = Infinity;
      for (let i = 0; i < 3; i++) {
        const prev = solve(mixed, { incremental: true });
        const next = edit();
        const s = performance.now();
        run(prev, next);
        b = Math.min(b, performance.now() - s);
      }
      return Math.round(b);
    };
    out.push({ nodes: 'смешанный: 5000 слоёв + ' + count * 50, expandDoc: '', applyOps: '',
      'вне: solve без образцов': timedMixed((p, n) => solve(n, { shapes: false })),
      'вне: solve': timedMixed((p, n) => solve(n)), 'вне: solveAfter': timedMixed((p, n) => solveAfter(p, mixed, n)) });
  }
  return out;
}

const quietWarn = console.warn;
if (process.argv.includes('--browser')) {
  const req = createRequire(join(root, 'package.json'));
  const { chromium } = req('playwright');
  const { start } = await import('../server/document/index.js');
  const { createMemoryStorage } = await import('../server/document/storage/memory.js');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const svc = await start({ port: 0, storage: createMemoryStorage(), staticDir: root, pingInterval: 0, log: quiet });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(svc.url + '/');
    await page.waitForSelector('#command', { timeout: 30000 });
    const rows = await page.evaluate(`(${measure.toString()})('/src/core.js', ${JSON.stringify(SIZES)})`);
    console.table(rows);
  } finally {
    await browser.close();
    await svc.close();
  }
} else {
  console.warn = () => {};   // «N экземпляров не раскрыты» у самого предела — ожидаемо
  const rows = await measure(new URL('../src/core.js', import.meta.url).href, SIZES);
  console.warn = quietWarn;
  console.table(rows);
}
