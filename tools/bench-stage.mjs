/**
 * Круг 62 (SPEC §18.8): правка мастера у предела в Chromium — раскладка по месту (solveAfter) и
 * перерисовка сцены (Stage.render) по её геометрии. Мастер из 50 узлов, экземпляры сеткой; правка —
 * текст в мастере; медиана из девяти правок подряд, мс.
 *   env -u NODE_OPTIONS node tools/bench-stage.mjs [экземпляров, 999] [корень со src/ — для сравнения с другой веткой]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[3] || app;
const req = createRequire(join(app, 'package.json'));
const { chromium } = req('playwright');
const { start } = await import('../server/document/index.js');
const { createMemoryStorage } = await import('../server/document/storage/memory.js');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const svc = await start({ port: 0, storage: createMemoryStorage(), staticDir: root, pingInterval: 0, log: quiet });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(svc.url + '/src/core.js');
  const out = await page.evaluate(async (count) => {
    const { createDoc, applyOps, solve, solveAfter, artboards, libraryNode, Stage } = await import('/src/core.js');
    const hug = { w: { mode: 'hug' }, h: { mode: 'hug' } };
    const d = createDoc(); const board = artboards(d)[0].id; const lib = libraryNode(d).id;
    const ops = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'column', gap: 4 }, size: hug } }];
    for (let i = 0; i < 49; i++) ops.push({ op: 'create', node: i % 2 ? { type: 'text', id: 'mt' + i, parent: 'M', characters: 'Строка ' + i, size: hug } : { type: 'rect', id: 'mr' + i, parent: 'M', size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 8 } } } });
    ops.push({ op: 'set', id: 'M', path: 'component', value: { name: 'К', props: [] } });
    ops.push({ op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 8 }, size: { w: { mode: 'fixed', value: 4000 }, h: { mode: 'hug' } } } });
    for (let i = 0; i < count; i++) ops.push({ op: 'create', node: { type: 'instance', id: 'I' + i, parent: 'G', of: 'M' } });
    let doc = applyOps(d, ops, { checkExpand: false }).doc;
    const host = document.createElement('div'); host.style.cssText = 'width:1200px;height:800px'; document.body.appendChild(host);
    const stage = new Stage(host, {});
    let geo = solve(doc, { incremental: true });
    stage.render(doc, geo);
    const lay = [], draw = [];
    for (let i = 0; i < 9; i++) {
      const next = applyOps(doc, [{ op: 'set', id: 'mt1', path: 'characters', value: 'Правка ' + i }], { checkExpand: false }).doc;
      let t = performance.now(); const g = solveAfter(geo, doc, next); lay.push(performance.now() - t);
      t = performance.now(); stage.render(next, g); draw.push(performance.now() - t);
      doc = next; geo = g;
    }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    return { count, layout: Math.round(med(lay)), render: Math.round(med(draw)) };
  }, Number(process.argv[2] || 999));
  console.table([out]);
} finally { await browser.close(); await svc.close(); }
