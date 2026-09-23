#!/usr/bin/env node
// @ts-check
/**
 * Сверка ИДЕНТИЧНОСТИ ОБОЛОЧКИ (дефект «оболочка менялась внутри программы»).
 *
 *   node packages/bench/src/series/harness-check.mjs [--out results] <series.json> [...]
 *
 * Для каждой серии печатает `harness_id`, который получит НОВЫЙ прогон, и сравнивает его с тем,
 * что уже записан в `results/<серия>/runs.csv` и `results/<серия>/passport.json`.
 *
 * Код возврата:
 *   0 — каталогов с прежними данными нет либо их оболочка совпадает с текущей (возобновление
 *       прерванной программы безопасно: строки сопоставимы);
 *   1 — есть каталог серии, снятый ДРУГОЙ версией оболочки (или без идентификатора вовсе).
 *       Дописывать к нему новые прогоны нельзя: в одном runs.csv оказались бы строки, снятые
 *       разными версиями сценария и разной схемой колонок — ровно то, что случилось в первой
 *       программе (100 против 115 колонок). Каталог нужно перенести в results/archive/.
 *
 * Печатается также «общая часть» идентичности (`comparableBy`): серии сопоставимы между собой
 * тогда и только тогда, когда у них совпадают версии оболочки, шейпера, эталона и набор колонок.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { harnessIdentity } from './passport.mjs';
import { COLUMNS } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(here, '../../../..');

/** @param {string} file @returns {{ids: Set<string>, rows: number, hasColumn: boolean, columns: number}} */
function csvHarnessIds(file) {
  const out = { ids: new Set(), rows: 0, hasColumn: false, columns: 0 };
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (!lines.length) return out;
  const header = lines[0].split(',');
  out.columns = header.length;
  const idx = header.indexOf('harness_id');
  out.hasColumn = idx >= 0;
  for (const l of lines.slice(1)) {
    out.rows += 1;
    if (idx >= 0) out.ids.add((l.split(',')[idx] ?? '').replace(/^"|"$/g, ''));
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, options: { out: { type: 'string' }, quiet: { type: 'boolean' } }, allowPositionals: true });
  const outRoot = path.resolve(ROOT_DIR, values.out ?? 'results');
  if (!positionals.length) {
    process.stderr.write('usage: harness-check.mjs [--out results] <series.json> [...]\n');
    return 2;
  }
  let bad = 0;
  /** @type {Record<string, string[]>} */
  const common = {};
  for (const f of positionals) {
    const series = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, f), 'utf8'));
    const h = harnessIdentity({ rootDir: ROOT_DIR, series, columns: COLUMNS });
    for (const k of h.comparableBy) (common[k] ??= []).push(String(/** @type {any} */ (h)[k]));
    const dir = path.join(outRoot, series.name);
    const csv = csvHarnessIds(path.join(dir, 'runs.csv'));
    let passportId = null;
    try {
      passportId = JSON.parse(fs.readFileSync(path.join(dir, 'passport.json'), 'utf8'))?.harness?.harnessIdShort ?? null;
    } catch {
      /* паспорта нет */
    }
    const stale = [...csv.ids].filter((id) => id !== h.harnessIdShort);
    const status = csv.rows === 0 ? 'нет прежних данных' : stale.length || !csv.hasColumn ? 'ДРУГАЯ ОБОЛОЧКА' : 'та же оболочка';
    if (csv.rows > 0 && (stale.length || !csv.hasColumn)) bad += 1;
    if (!values.quiet) {
      process.stdout.write(
        `${series.name.padEnd(22)} harness=${h.harnessIdShort}  прежних строк ${String(csv.rows).padStart(4)} (колонок ${csv.columns || '—'}, паспорт ${passportId ?? '—'})  ${status}\n` +
          (stale.length ? `  прежние идентификаторы: ${stale.join(', ')} — каталог ${path.relative(ROOT_DIR, dir)} нужно перенести в results/archive/\n` : '') +
          (csv.rows > 0 && !csv.hasColumn ? `  в runs.csv нет колонки harness_id (серия снята оболочкой до 2026-09-13) — каталог ${path.relative(ROOT_DIR, dir)} нужно перенести в results/archive/\n` : ''),
      );
    }
  }
  if (!values.quiet) {
    for (const [k, vs] of Object.entries(common)) {
      const uniq = [...new Set(vs)];
      process.stdout.write(`${k}: ${uniq.length === 1 ? String(uniq[0]).slice(0, 16) + ' (одинаково у всех серий)' : 'РАЗЛИЧАЕТСЯ: ' + uniq.map((v) => String(v).slice(0, 16)).join(', ')}\n`);
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());
