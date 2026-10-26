/**
 * «Потеря правки при скользящем обновлении» (критик архитектуры круга 44, `r44/fmtloss.mjs`;
 * SPEC §9.18, §9.20). Два экземпляра Document service на одном хранилище: A — нынешний код,
 * N — «будущий круг», который расширил правило (opacity до 2) БЕЗ подъёма ENGINE_VERSION.
 *
 *   env -u NODE_OPTIONS node tools/critic/fmtloss.mjs                 — хранилище в памяти (общий объект)
 *   TEST_DATABASE_URL=postgres://… env -u NODE_OPTIONS node tools/critic/fmtloss.mjs   — одна база pg
 *
 * N записывает `set opacity 1.5`, затем через A идут ещё 55 правок. До круга 45 A считал такую запись
 * «наследной», пропускал её и писал снимки — правка терялась у всех. Ждём (круг 45): A пишет в лог
 * громкую строку «запись СВОЕЙ версии движка … отвергнута», голова «с пропуском» и снимков нет.
 * Выход 1 — снимок записан (потеря возможна).
 */

import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'imago-fmtloss-'));
for (const p of ['src', 'server', 'package.json']) cpSync(join(root, p), join(dir, p), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
const corePath = join(dir, 'src', 'core.js');
const from = ["opacity: { check: (v) => (isNum(v) && v >= 0 && v <= 1 ? null : 'opacity вне 0..1') },", 'node.opacity < 0 || node.opacity > 1)'];
const to = ["opacity: { check: (v) => (isNum(v) && v >= 0 && v <= 2 ? null : 'opacity вне 0..1') },", 'node.opacity < 0 || node.opacity > 2)'];
let core = readFileSync(corePath, 'utf8');
from.forEach((f, i) => { if (core.split(f).length !== 2) throw new Error('строка мутации не найдена: ' + f); core = core.replace(f, to[i]); });
writeFileSync(corePath, core);

const loud = [];
const logA = { info() {}, debug() {}, error() {}, warn: (...a) => loud.push(a.join(' ')) };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DB = process.env.TEST_DATABASE_URL || '';

const { start } = await import(pathToFileURL(join(root, 'server/document/index.js')).href);
const startN = (await import(pathToFileURL(join(dir, 'server/document/index.js')).href)).start;
const { createMemoryStorage } = await import(pathToFileURL(join(root, 'server/document/storage/memory.js')).href);
const { CODE_ENGINE } = await import(pathToFileURL(join(root, 'server/document/engine.js')).href);
let storageA;
let storageN;
if (DB) {
  const pg = await import(pathToFileURL(join(root, 'server/document/storage/pg.js')).href);
  const make = pg.createPgStorage || pg.default;
  storageA = make({ connectionString: DB, log: quiet });
  storageN = make({ connectionString: DB, log: quiet });
} else {
  storageA = createMemoryStorage();
  storageN = storageA;
}
const a = await start({ port: 0, storage: storageA, snapshotEvery: 50, pingInterval: 0, log: logA });
const n = await startN({ port: 0, storage: storageN, snapshotEvery: 50, pingInterval: 0, log: quiet });
const call = async (svc, method, path, body) => {
  const r = await fetch(svc.url + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let code = 0;
try {
  const made = await call(a, 'POST', '/api/projects', { name: 'fmtloss', demo: true });
  const id = made.body.id;
  const doc = (await call(a, 'GET', `/api/projects/${id}`)).body.snapshot.doc;
  const board = doc.nodes[doc.root].children.find((c) => doc.nodes[c] && doc.nodes[c].type === 'frame');
  const tx = (seq, ops) => ({ tx_id: 'tx_' + Math.random().toString(36).slice(2), base_seq: seq, ops, engine: CODE_ENGINE });
  const w = await call(n, 'POST', `/api/projects/${id}/tx`, tx(0, [{ op: 'set', id: board, path: 'opacity', value: 1.5 }]));
  console.log('N: set opacity 1.5 →', w.status, 'seq', w.body && w.body.seq);
  let seq = 1;
  for (let i = 0; i < 55; i++) {
    const r = await call(a, 'POST', `/api/projects/${id}/tx`, tx(seq, [{ op: 'set', id: board, path: 'name', value: 'Доска ' + i }]));
    if (r.status !== 201) { console.log('A: правка', i, '→', r.status, JSON.stringify(r.body)); break; }
    seq = r.body.seq;
  }
  await a.dslts.flush?.();
  const meta = await storageA.latestSnapshotMeta(id);
  const snapSeq = meta ? meta.seq : null;
  const said = loud.find((l) => /СВОЕЙ версии/.test(l));
  console.log('A: голова', seq, '· последний снимок', snapSeq, '· громкая строка:', said ? 'есть' : 'НЕТ');
  if (snapSeq !== null && snapSeq > 0) { console.error('ПОТЕРЯ ВОЗМОЖНА: снимок записан поверх отвергнутой записи своей версии'); code = 1; }
  if (!said) { console.error('нет громкой строки в логе'); code = 1; }
  if (!code) console.log('OK: снимков поверх отвергнутой записи нет, журнал хранит правку');
} finally {
  await n.close();
  await a.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
