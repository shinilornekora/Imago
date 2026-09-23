#!/usr/bin/env node
// @ts-nocheck
/**
 * Ворота допуска (§1.7, §1.8): сопоставляют КОНФИГУРАЦИИ, которые будут измеряться сериями, с фактическими
 * результатами функциональных проверок и решают, можно ли запускать измерения.
 *
 *   node packages/bench/src/functional/admission-gate.mjs \
 *        --series packages/bench/series/main.json,packages/bench/series/cache3.json \
 *        --summaries results/functional/<ts1>/summary.json,results/functional/<ts2>/summary.json \
 *        [--out results/functional/admission.md] [--allow-caveat]
 *
 * Правила (критик A п. 12, критик B пп. 3, 5, 6):
 *   * каждая конфигурация (адаптер × режим × окно кеша) каждой серии обязана иметь допуск НА ТОМ ЖЕ ДОКУМЕНТЕ,
 *     который эта серия измеряет (иначе масштабозависимое поведение не проверено);
 *   * дополнительно требуется допуск по ПОЛНОМУ набору проверок хотя бы на одном документе (быстрая матрица
 *     на малом документе) — иначе строки таблицы 1, не вошедшие в сокращённый набор, не проверены вовсе;
 *   * `не допущено` где-либо → жёсткий отказ; `допуск с оговоркой` (есть `skip`) → отказ, если не задан
 *     `--allow-caveat`; при `--allow-caveat` оговорки печатаются и попадают в отчёт.
 * Код возврата: 0 — можно измерять; 1 — есть конфигурация без допуска; 2 — ошибка входных данных.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');

const key = (c) => `${c.adapter}/${c.mode}${c.mode === 'P' ? `/cache=${c.cache}` : ''}`;

/**
 * @param {{series:string[], summaries:string[], allowCaveat?:boolean}} opts
 */
export function gate(opts) {
  const summaries = opts.summaries.map((f) => {
    const abs = path.resolve(REPO_ROOT, f);
    const s = JSON.parse(readFileSync(abs, 'utf8'));
    return { file: path.relative(REPO_ROOT, abs), ...s };
  });
  const rows = [];
  const problems = [];
  const caveats = [];

  for (const f of opts.series) {
    const abs = path.resolve(REPO_ROOT, f);
    const series = JSON.parse(readFileSync(abs, 'utf8'));
    const docJson = path.posix.normalize(series.docJson ?? '');
    for (const cfg of series.configs ?? []) {
      const label = key(cfg);
      // 1) допуск на ИЗМЕРЯЕМОМ документе
      const onDoc = summaries
        .filter((s) => path.posix.normalize(String(s.docJson ?? '')) === docJson)
        .flatMap((s) => (s.verdicts ?? []).filter((v) => key(v.config) === label).map((v) => ({ ...v, summary: s })));
      // 2) допуск по полному набору проверок (любой документ)
      const full = summaries
        .filter((s) => !s.partialCheckSet)
        .flatMap((s) => (s.verdicts ?? []).filter((v) => key(v.config) === label).map((v) => ({ ...v, summary: s })));

      const rejected = [...onDoc, ...full].filter((v) => v.verdict === 'не допущено');
      const bestOnDoc = pick(onDoc);
      const bestFull = pick(full);
      let status = 'ok';
      const notes = [];
      if (rejected.length) {
        status = 'FAIL';
        notes.push(`не допущено: ${[...new Set(rejected.map((v) => `${v.summary.docId} (${v.caveats.join('; ')})`))].join(' | ')}`);
      }
      if (!bestOnDoc) {
        status = 'FAIL';
        notes.push(`нет функционального допуска на измеряемом документе ${series.doc ?? docJson}`);
      }
      if (!bestFull) {
        status = 'FAIL';
        notes.push('нет допуска по полному набору проверок ни на одном документе');
      }
      for (const v of [bestOnDoc, bestFull]) {
        if (v && v.verdict === 'допуск с оговоркой') {
          caveats.push(`${series.name}/${label} @ ${v.summary.docId}: ${v.caveats.join('; ')}`);
          if (status === 'ok') status = opts.allowCaveat ? 'CAVEAT' : 'FAIL';
          if (!opts.allowCaveat) notes.push(`допуск с оговоркой (${v.caveats.join('; ')}) — требуется --allow-caveat`);
          else notes.push(`оговорка: ${v.caveats.join('; ')}`);
        }
      }
      rows.push({
        series: series.name,
        doc: series.doc ?? docJson,
        config: label,
        status,
        onDoc: bestOnDoc ? `${bestOnDoc.verdict} (${bestOnDoc.summary.checkSet ? bestOnDoc.summary.checkSet.length : 'полный'} проверок, ${bestOnDoc.summary.file})` : '—',
        full: bestFull ? `${bestFull.verdict} @ ${bestFull.summary.docId} (${bestFull.summary.file})` : '—',
        notes: notes.join('; '),
      });
      if (status === 'FAIL') problems.push(`${series.name}/${label}: ${notes.join('; ')}`);
    }
  }
  return { rows, problems, caveats, summaries: summaries.map((s) => ({ file: s.file, docId: s.docId, label: s.label ?? null, partial: Boolean(s.partialCheckSet), checkSet: s.checkSet })) };
}

/** Лучший вердикт из списка: допуск > частичный > с оговоркой > не допущено. */
function pick(list) {
  const order = ['допуск', 'допуск (частичный набор)', 'допуск с оговоркой', 'не допущено'];
  const sorted = [...list].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  return sorted[0] ?? null;
}

export function renderGate(res) {
  const lines = [];
  lines.push('# Допуск конфигураций к измерениям (§1.7, §1.8)');
  lines.push('');
  lines.push('Источники — прогоны функциональных проверок:');
  for (const s of res.summaries) lines.push(`* \`${s.file}\` — документ \`${s.docId}\`${s.label ? ` (метка: ${s.label})` : ''}, набор: ${s.partial ? s.checkSet.join(', ') : 'полный'}`);
  lines.push('');
  lines.push('| Серия | Документ | Конфигурация | Допуск на измеряемом документе | Полный набор проверок | Итог | Примечания |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of res.rows) {
    lines.push(`| ${r.series} | ${r.doc} | ${r.config} | ${r.onDoc} | ${r.full} | ${r.status === 'ok' ? '✅ допущена' : r.status === 'CAVEAT' ? '⚠️ с оговоркой' : '❌ НЕ допущена'} | ${r.notes || ''} |`);
  }
  lines.push('');
  if (res.caveats.length) {
    lines.push('## Оговорки');
    lines.push('');
    for (const c of res.caveats) lines.push(`* ${c}`);
    lines.push('');
  }
  if (res.problems.length) {
    lines.push('## Конфигурации без допуска (измерять нельзя)');
    lines.push('');
    for (const p of res.problems) lines.push(`* ${p}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i >= 0) return args[i + 1];
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : null;
  };
  const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
  const series = list(get('series'));
  const sums = list(get('summaries'));
  const allowCaveat = args.includes('--allow-caveat');
  const out = get('out');
  if (!series.length || !sums.length) {
    process.stderr.write('usage: admission-gate.mjs --series a.json,b.json --summaries r1/summary.json,... [--out file.md] [--allow-caveat]\n');
    process.exit(2);
  }
  let res;
  try {
    res = gate({ series, summaries: sums, allowCaveat });
  } catch (e) {
    process.stderr.write(`admission-gate: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const md = renderGate(res);
  if (out) {
    const abs = path.resolve(REPO_ROOT, out);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `${md}\n`);
    writeFileSync(abs.replace(/\.md$/, '.json'), `${JSON.stringify(res, null, 2)}\n`);
  }
  process.stdout.write(`${md}\n`);
  if (res.problems.length) {
    process.stderr.write(`admission-gate: ${res.problems.length} конфигураций без допуска — измерения запускать нельзя (§1.7)\n`);
    process.exit(1);
  }
  process.exit(0);
}
