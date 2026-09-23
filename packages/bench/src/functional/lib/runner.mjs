// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Маленький раннер: последовательно выполняет проверки для каждой конфигурации, пишет
 * `results/functional/<timestamp>/summary.{json,md}` и `<config>.json` (одна строка на (конфигурация, проверка)).
 *
 * Проверка — объект `{id, title(cfg), applies?(cfg), naReason?(cfg), run(ctx) → details}`;
 * исход строки: `pass` / `fail` / `skip` / `na`.
 * Провал — любое исключение из `run` (assert из node:assert/strict даёт понятное сообщение).
 * Проверки НЕ пропускаются при обнаружении дефекта — они падают с точным сообщением (SPEC §6: любое расхождение = провал).
 *
 * ВЕРДИКТ ДОПУСКА (§1.7 «прохождение ВСЕХ предметных проверок», критик B, п. 5).
 * Пропущенная (`skip`) или вовсе не выполненная проверка НЕ даёт допуска:
 *   `допуск`              — все применимые проверки ЗАПРОШЕННОГО набора выполнены и pass, набор полный;
 *   `допуск (частичный)`  — то же, но набор сокращён (`--only`): это не полный допуск, а подтверждение части строк;
 *   `допуск с оговоркой`  — провалов нет, но есть `skip` (перечисляются) — конфигурация допускается только с явной
 *                           записью оговорки в отчёте;
 *   `не допущено`         — есть `fail`, либо конфигурация пропущена целиком (preflight).
 * Неприменимые проверки (`applies` = false) выводятся отдельной строкой `n/a` с обоснованием, а не молча опускаются.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configKey, configLabel } from './config.mjs';

export class SkipCheck extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipCheck';
  }
}

/** Исход конфигурации. */
export const VERDICT = {
  admitted: 'допуск',
  admittedPartial: 'допуск (частичный набор)',
  admittedCaveat: 'допуск с оговоркой',
  rejected: 'не допущено',
};

/**
 * @typedef {{id:string, title:string, status:'pass'|'fail'|'skip'|'na', message:string, durationMs:number, details?:any}} CheckResult
 */

/**
 * @param {{timeoutMs:number, outDir:string, log:(s:string)=>void, partialCheckSet?:boolean, checkIds?:string[]}} opts
 */
export function createRunner(opts) {
  /** @type {Array<{config:any, key:string, label:string, checks:CheckResult[], passed:boolean, skipped?:string}>} */
  const configResults = [];
  const startedAt = new Date().toISOString();
  const partial = Boolean(opts.partialCheckSet);

  return {
    configResults,
    /**
     * @param {any} cfg
     * @param {any[]} checks
     * @param {(check:any) => Promise<any>} makeCtx — контекст на одну проверку (создаётся после сброса)
     * @param {{before?:(check:any)=>Promise<void>, after?:(check:any, ctx:any)=>Promise<void>, skipReason?:string|null}} hooks
     */
    async runConfig(cfg, checks, makeCtx, hooks = {}) {
      const label = configLabel(cfg);
      const entry = { config: cfg, key: configKey(cfg), label, checks: /** @type {CheckResult[]} */ ([]), passed: true, skipped: hooks.skipReason ?? undefined };
      configResults.push(entry);
      opts.log(`=== ${label} ===`);
      for (const check of checks) {
        const title = typeof check.title === 'function' ? check.title(cfg) : check.title;
        const t0 = Date.now();
        /** @type {CheckResult} */
        let res;
        if (check.applies && !check.applies(cfg)) {
          // неприменимая проверка — ОТДЕЛЬНАЯ строка с обоснованием (раньше пропадала из таблицы бесследно)
          const reason = typeof check.naReason === 'function' ? check.naReason(cfg) : `неприменима к конфигурации ${label}`;
          res = { id: check.id, title, status: 'na', message: reason, durationMs: 0 };
        } else if (hooks.skipReason) {
          res = { id: check.id, title, status: 'skip', message: hooks.skipReason, durationMs: 0 };
        } else {
          let ctx = null;
          try {
            if (hooks.before) await hooks.before(check);
            ctx = await makeCtx(check);
            const details = await withTimeout(check.run(ctx), opts.timeoutMs, `${check.id}: тайм-аут ${opts.timeoutMs} мс`);
            if (typeof ctx.assertNoErrors === 'function') ctx.assertNoErrors(); // pageerror / console.error страницы = провал
            res = { id: check.id, title, status: 'pass', message: details?.summary ?? 'ok', durationMs: Date.now() - t0, details };
          } catch (e) {
            const err = /** @type {any} */ (e);
            if (err instanceof SkipCheck) {
              res = { id: check.id, title, status: 'skip', message: err.message, durationMs: Date.now() - t0, details: ctx?.partial ?? null };
            } else {
              const message = err instanceof Error ? err.message : String(err);
              res = {
                id: check.id,
                title,
                status: 'fail',
                message: message.split('\n').slice(0, 6).join(' | ').slice(0, 1500),
                durationMs: Date.now() - t0,
                details: { stack: err?.stack ? String(err.stack).slice(0, 4000) : null, partial: ctx?.partial ?? null },
              };
              entry.passed = false;
            }
          } finally {
            if (hooks.after) await hooks.after(check, ctx).catch(() => undefined);
          }
        }
        entry.checks.push(res);
        const mark = res.status === 'pass' ? 'PASS' : res.status === 'fail' ? 'FAIL' : res.status === 'skip' ? 'SKIP' : ' n/a';
        opts.log(`  [${mark}] ${title} (${res.durationMs} мс) — ${res.message}`);
        writeFileSync(path.join(opts.outDir, `${entry.key}.json`), JSON.stringify({ ...entry, verdict: verdictOf(entry, partial) }, null, 2));
      }
      const v = verdictOf(entry, partial);
      opts.log(`  → ${label}: ${v.verdict}${v.caveats.length ? ` (${v.caveats.join('; ')})` : ''}`);
      return entry;
    },

    /** Итоговые summary.json и summary.md. */
    writeSummary(meta) {
      mkdirSync(opts.outDir, { recursive: true });
      const rows = [];
      let pass = 0;
      let fail = 0;
      let skip = 0;
      let na = 0;
      for (const c of configResults) {
        for (const r of c.checks) {
          rows.push({ config: c.label, configKey: c.key, adapter: c.config.adapter, mode: c.config.mode, cache: c.config.cache, id: r.id, title: r.title, status: r.status, message: r.message, durationMs: r.durationMs });
          if (r.status === 'pass') pass += 1;
          else if (r.status === 'fail') fail += 1;
          else if (r.status === 'skip') skip += 1;
          else na += 1;
        }
      }
      const verdicts = configResults.map((c) => ({ label: c.label, key: c.key, config: c.config, ...verdictOf(c, partial) }));
      const summary = {
        ...meta,
        startedAt,
        finishedAt: new Date().toISOString(),
        checkSet: opts.checkIds ?? null,
        partialCheckSet: partial,
        totals: {
          pass,
          fail,
          skip,
          na,
          configs: configResults.length,
          admitted: verdicts.filter((v) => v.verdict === VERDICT.admitted).map((v) => v.label),
          admittedPartial: verdicts.filter((v) => v.verdict === VERDICT.admittedPartial).map((v) => v.label),
          admittedWithCaveat: verdicts.filter((v) => v.verdict === VERDICT.admittedCaveat).map((v) => v.label),
          notAdmitted: verdicts.filter((v) => v.verdict === VERDICT.rejected).map((v) => v.label),
        },
        verdicts,
        configs: configResults.map((c) => ({ config: c.config, label: c.label, passed: c.passed, skipped: c.skipped ?? null, ...verdictOf(c, partial), checks: c.checks.map(({ details, ...r }) => r) })),
        rows,
      };
      writeFileSync(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
      writeFileSync(path.join(opts.outDir, 'summary.md'), renderMarkdown(summary));
      return summary;
    },
  };
}

/**
 * Вердикт конфигурации: допуск только если ВСЕ применимые проверки выполнены и пройдены.
 * @param {{checks:CheckResult[], skipped?:string}} entry
 * @param {boolean} partial набор проверок сокращён (`--only`)
 */
export function verdictOf(entry, partial) {
  const fails = entry.checks.filter((r) => r.status === 'fail');
  const skips = entry.checks.filter((r) => r.status === 'skip');
  const naRows = entry.checks.filter((r) => r.status === 'na');
  const caveats = [];
  let verdict;
  if (entry.skipped) {
    verdict = VERDICT.rejected;
    caveats.push(`конфигурация пропущена целиком: ${entry.skipped}`);
  } else if (fails.length > 0) {
    verdict = VERDICT.rejected;
    caveats.push(`провалы: ${fails.map((r) => r.id).join(', ')}`);
  } else if (entry.checks.length === 0) {
    verdict = VERDICT.rejected;
    caveats.push('не выполнено ни одной проверки');
  } else if (skips.length > 0) {
    verdict = VERDICT.admittedCaveat;
    caveats.push(...skips.map((r) => `${r.id}: n/a — ${r.message}`));
  } else if (partial) {
    verdict = VERDICT.admittedPartial;
    caveats.push(`набор сокращён: ${entry.checks.map((r) => r.id).join(', ')}`);
  } else {
    verdict = VERDICT.admitted;
  }
  return {
    verdict,
    admitted: verdict === VERDICT.admitted,
    caveats,
    failed: fails.map((r) => r.id),
    skippedChecks: skips.map((r) => ({ id: r.id, reason: r.message })),
    notApplicable: naRows.map((r) => ({ id: r.id, reason: r.message })),
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function renderMarkdown(summary) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [];
  lines.push(`# Функциональные проверки (SPEC §6, таблица 1)`);
  lines.push('');
  lines.push(`* Начало: ${summary.startedAt}, конец: ${summary.finishedAt}`);
  lines.push(`* API: ${summary.base}; документ: \`${summary.docId}\` (${summary.docJson}); документ bob: \`${summary.bobDocId}\``);
  if (summary.docProfile) lines.push(`* Профиль документа: ${summary.docProfile}`);
  lines.push(`* Набор проверок: ${summary.checkSet ? summary.checkSet.join(', ') : 'полный'}${summary.partialCheckSet ? ' — **частичный набор** (`--only`), полного допуска этот прогон не даёт' : ''}`);
  lines.push(`* Итого строк: pass ${summary.totals.pass}, fail ${summary.totals.fail}, skip ${summary.totals.skip}, n/a ${summary.totals.na}`);
  lines.push(`* **Допуск** (все применимые проверки полного набора пройдены): ${summary.totals.admitted.length ? summary.totals.admitted.join(', ') : '—'}`);
  if (summary.totals.admittedPartial.length) lines.push(`* Допуск по частичному набору: ${summary.totals.admittedPartial.join(', ')}`);
  if (summary.totals.admittedWithCaveat.length) lines.push(`* Допуск с оговоркой (есть пропущенные проверки): ${summary.totals.admittedWithCaveat.join(', ')}`);
  if (summary.totals.notAdmitted.length) lines.push(`* **Не допущены**: ${summary.totals.notAdmitted.join(', ')}`);
  lines.push('');
  lines.push('## Сводка по конфигурациям');
  lines.push('');
  const ids = [...new Set(summary.rows.map((r) => r.id))];
  lines.push(`| Конфигурация | ${ids.join(' | ')} | Вердикт |`);
  lines.push(`|---|${ids.map(() => '---').join('|')}|---|`);
  for (const c of summary.configs) {
    const cells = ids.map((id) => {
      const r = c.checks.find((x) => x.id === id);
      if (!r) return '—';
      return r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'skip' ? '⏭' : 'n/a';
    });
    lines.push(`| ${c.label} | ${cells.join(' | ')} | **${c.verdict}** |`);
  }
  lines.push('');
  lines.push('Обозначения: ✅ пройдена, ❌ провал, ⏭ пропущена (`skip` — допуска не даёт, причина ниже), `n/a` неприменима (обоснование ниже), — не запускалась.');
  lines.push('');
  const withCaveats = summary.configs.filter((c) => c.caveats.length || c.skippedChecks.length || c.notApplicable.length);
  if (withCaveats.length) {
    lines.push('## Оговорки и неприменимые проверки');
    lines.push('');
    for (const c of withCaveats) {
      lines.push(`* **${c.label}** — ${c.verdict}`);
      for (const s of c.skippedChecks) lines.push(`  * ⏭ \`${s.id}\`: ${esc(s.reason)}`);
      for (const s of c.notApplicable) lines.push(`  * n/a \`${s.id}\`: ${esc(s.reason)}`);
      if (c.verdict === 'допуск (частичный набор)') lines.push(`  * набор проверок сокращён: ${c.checks.map((r) => r.id).join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## Все строки (конфигурация × проверка)');
  lines.push('');
  lines.push('| Конфигурация | Проверка | Исход | Сообщение | мс |');
  lines.push('|---|---|---|---|---|');
  for (const r of summary.rows) {
    lines.push(`| ${r.config} | ${esc(r.title)} | ${r.status} | ${esc(r.message).slice(0, 300)} | ${r.durationMs} |`);
  }
  lines.push('');
  return lines.join('\n');
}
