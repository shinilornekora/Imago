/**
 * Круг 51 (SPEC §18): замер раскладки после одной правки — полная (solve) и по месту правки
 * (solveAfter), круг 57 — и отмена той же правки (solveNext). Документ: одна доска, карточки по 4 слоя (рамка, заголовок, текст, плашка),
 * сеткой с переносом; правка — текст карточки в середине. Медиана из --runs прогонов.
 *   node tools/bench-layout.mjs [--nodes 1000,5000] [--runs 30] [--json]
 */
import * as core from '../src/core.js';
import { performance } from 'node:perf_hooks';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SIZES = String(arg('nodes', '1000,5000')).split(',').map(Number).filter((n) => n > 0);
const RUNS = Number(arg('runs', 30));
const JSON_OUT = process.argv.includes('--json');
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
// измеритель без холста: приближение ширины (в браузере — canvas; здесь важна доля раскладки)
const measureText = (text, style) => String(text || '').length * (style.fontSize || 16) * 0.52;

export function boardDoc(n) {
  const base = quiet(() => core.createDoc());
  const doc = { ...base, nodes: { [base.root]: { ...base.nodes[base.root], children: [] } } };
  const list = [core.ops.create({ id: 'b', type: 'frame', name: 'Доска', parent: doc.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 1440 }, h: { mode: 'hug' } }, fill: 'canvas',
    layout: { mode: 'row', gap: 16, padding: { t: 24, r: 24, b: 24, l: 24 }, align: 'start', justify: 'start', wrap: true }, children: [] })];
  const cards = Math.max(1, Math.floor((n - 1) / 4));
  for (let i = 0; i < cards; i++) {
    const c = `c${i}`;
    list.push(
      core.ops.create({ id: c, type: 'frame', name: `Карточка ${i}`, parent: 'b', fill: 'surface', size: { w: { mode: 'fixed', value: 220 }, h: { mode: 'hug' } },
        layout: { mode: 'column', gap: 8, padding: { t: 12, r: 12, b: 12, l: 12 }, align: 'stretch', justify: 'start', wrap: false }, children: [] }),
      core.ops.create({ id: `${c}t`, type: 'text', name: 'Заголовок', parent: c, characters: `Заголовок карточки ${i}`, style: 'title', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
      core.ops.create({ id: `${c}b`, type: 'text', name: 'Текст', parent: c, characters: 'Короткое описание, которое переносится на две-три строки внутри карточки.', style: 'body', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
      core.ops.create({ id: `${c}r`, type: 'rect', name: 'Плашка', parent: c, fill: 'accent', size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 6 } } }),
    );
  }
  const r = core.applyOps(doc, list);
  if (r.error) throw new Error(JSON.stringify(r.error));
  return { doc: r.doc, mid: `c${Math.floor(cards / 2)}b`, count: Object.keys(r.doc.nodes).length };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const rows = [];
for (const n of SIZES) {
  const { doc, mid, count } = boardDoc(n);
  const opts = { measureText };
  let cur = doc;
  let geo = core.solve(cur, { ...opts, incremental: true });
  const full = [];
  const inc = [];
  const undo = [];
  for (let i = 0; i < RUNS; i++) {
    const op = [core.ops.set(mid, 'characters', `Правка ${i}: текст стал ${i % 2 ? 'короче' : 'заметно длиннее и займёт больше строк, чем раньше'}`)];
    const next = core.applyOps(cur, op).doc;
    let t = performance.now();
    const g1 = core.solve(next, opts);
    full.push(performance.now() - t);
    if (typeof core.solveAfter === 'function') {
      t = performance.now();
      const g2 = core.solveAfter(geo, cur, next, op, opts);
      inc.push(performance.now() - t);
      if (core.hashGeometry(g1) !== core.hashGeometry(g2)) throw new Error(`n=${n}: геометрия по месту правки разошлась с полной`);
      geo = g2;
    } else geo = g1;
    // круг 57: отмена той же правки — от памяти раскладки (solveNext), без прежнего документа
    if (typeof core.solveNext === 'function') {
      const back = core.applyOps(next, core.invertOps(cur, op)).doc;
      t = performance.now();
      const g3 = core.solveNext(geo, back, opts);
      undo.push(performance.now() - t);
      if (core.hashGeometry(g3) !== core.hashGeometry(core.solve(back, opts))) throw new Error(`n=${n}: отмена по месту разошлась с полной`);
      geo = core.solveNext(g3, next, opts);
    }
    cur = next;
  }
  // круг 57: кадр догона — геометрия отстала на 5 правок в разных карточках
  const catchup = [];
  if (typeof core.solveNext === 'function') {
    const cards = Math.max(1, Math.floor((n - 1) / 4));
    for (let i = 0; i < RUNS; i++) {
      let next = cur;
      for (let k = 0; k < 5; k++) {
        next = core.applyOps(next, [core.ops.set(`c${(i * 7 + k * Math.floor(cards / 5)) % cards}b`, 'characters', `Догон ${i}.${k}`)]).doc;
      }
      const t = performance.now();
      const g = core.solveNext(geo, next, opts);
      catchup.push(performance.now() - t);
      if (core.hashGeometry(g) !== core.hashGeometry(core.solve(next, opts))) throw new Error(`n=${n}: догон по месту разошёлся с полной`);
      geo = g; cur = next;
    }
  }
  rows.push({ nodes: count, fullMs: +median(full).toFixed(2), incrementalMs: inc.length ? +median(inc).toFixed(2) : null,
    undoMs: undo.length ? +median(undo).toFixed(2) : null, catchupMs: catchup.length ? +median(catchup).toFixed(2) : null });
}
if (JSON_OUT) console.log(JSON.stringify(rows));
else for (const r of rows) console.log(`${r.nodes} слоёв: полная ${r.fullMs} мс${r.incrementalMs != null ? `, по месту правки ${r.incrementalMs} мс` : ''}${r.undoMs != null ? `, отмена ${r.undoMs} мс` : ''}${r.catchupMs != null ? `, догон 5 правок ${r.catchupMs} мс` : ''}`);
