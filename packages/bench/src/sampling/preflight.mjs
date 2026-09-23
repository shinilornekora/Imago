#!/usr/bin/env node
// @ts-check
/**
 * Предполётная проверка сэмплеров серверных ресурсов (SPEC §7.3; критик B, п. 15).
 *
 *   node packages/bench/src/sampling/preflight.mjs packages/bench/series/main.json [ещё файлы серий…]
 *
 * Для каждой серии разрешает объявленные `procGroups` в множества pid ПРЯМО СЕЙЧАС и завершается с кодом 1,
 * если хотя бы одна группа, нужная этой серии (без фильтра `adapters` или с адаптером из её конфигураций),
 * не сопоставлена ни одному процессу. Иначе прогоны молча записали бы `server_<группа>_*` = 0
 * («серия молча даёт неверные числа»), и это невозможно отличить от честного нуля.
 *
 * Код возврата: 0 — все нужные группы непусты; 1 — есть пустая нужная группа; 2 — ошибка чтения конфигурации.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSpec, resolveGroupPaths, resolveGroups } from './procs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');

/**
 * @param {string[]} files
 * @returns {{ok:boolean, lines:string[]}}
 */
export function checkSeriesFiles(files) {
  const lines = [];
  let ok = true;
  for (const file of files) {
    const abs = path.resolve(REPO_ROOT, file);
    const series = JSON.parse(readFileSync(abs, 'utf8'));
    const specs = resolveGroupPaths(series.procGroups ?? [], REPO_ROOT);
    if (specs.length === 0) {
      lines.push(`${series.name ?? path.basename(file)}: procGroups не объявлены — серверные ресурсы не измеряются`);
      continue;
    }
    const adapters = new Set((series.configs ?? []).map((/** @type {any} */ c) => c.adapter));
    const resolved = resolveGroups(specs);
    for (const spec of specs) {
      const needed = !spec.adapters || spec.adapters.some((a) => adapters.has(a));
      const procs = resolved[spec.name] ?? [];
      const mark = !needed ? 'skip' : procs.length ? ' ok ' : 'FAIL';
      lines.push(
        `[${mark}] ${series.name ?? path.basename(file)}/${spec.name}: ${procs.length} процесс(ов)` +
          (procs.length ? ` — pids ${procs.map((p) => p.pid).join(',')}` : needed ? ` — НИЧЕГО НЕ СОПОСТАВЛЕНО (${describeSpec(spec)})` : ' (не нужна этой серии)'),
      );
      if (needed && procs.length === 0) ok = false;
    }
  }
  return { ok, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('usage: node packages/bench/src/sampling/preflight.mjs <series.json> [...]\n');
    process.exit(2);
  }
  let res;
  try {
    res = checkSeriesFiles(files);
  } catch (e) {
    process.stderr.write(`preflight: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  for (const l of res.lines) process.stdout.write(`${l}\n`);
  if (!res.ok) {
    process.stderr.write('preflight сэмплеров: есть обязательная группа процессов без совпадений — серия записала бы нули вместо измерений\n');
    process.exit(1);
  }
  process.exit(0);
}
