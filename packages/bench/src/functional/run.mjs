#!/usr/bin/env node
// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Функциональные проверки стенда (SPEC §6, таблица 1 + безопасность) против РЕАЛЬНОГО стека
 * (API + PostgreSQL [+ zero-cache]) для каждой конфигурации адаптер × режим (× cache).
 *
 *   export PATH=/opt/node24/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/bench/src/functional/run.mjs --adapters H,Q --port 3005
 *
 * Результат: results/functional/<timestamp>/summary.{json,md}, <config>.json, artifacts/<config>/<check>-*.json
 * (команды для эталона, отчёты compare-db / compare-snapshots). Код возврата 1, если есть провалы.
 * Обёртка с запуском собственного API: scripts/run-functional.sh.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Api } from './lib/api.mjs';
import { buildOptions, configKey, configLabel, parseArgs, REPO_ROOT, USAGE } from './lib/config.mjs';
import { Db } from './lib/db.mjs';
import { loadDoc } from './lib/doc.mjs';
import { describeReport, Oracle } from './lib/oracle.mjs';
import { createRunner } from './lib/runner.mjs';
import { openStand } from './lib/stand.mjs';
import { CHECKS } from './checks/index.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const log = (s) => process.stderr.write(`[functional ${new Date().toISOString().slice(11, 19)}] ${s}\n`);

async function main() {
  const opts = buildOptions(parseArgs(process.argv.slice(2)));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  mkdirSync(opts.outDir, { recursive: true });
  const api = new Api(opts.base);
  const db = new Db(opts.dbUrl);
  const doc = loadDoc(opts.docJson);
  const bobJson = path.join(REPO_ROOT, 'data', `${opts.bobDocId.replace(/^doc-/, '')}.json`);
  const bobDoc = existsSync(bobJson) ? loadDoc(bobJson) : null;
  const zeroUrl = process.env.STAND_FUNCTIONAL_ZERO_URL ?? null;

  // ---- предварительные условия: API с хуками, документ в БД, исходное состояние = экспорт генератора
  const health = await api.health().catch((e) => ({ status: 0, body: String(e) }));
  if (health.status !== 200) throw new Error(`API ${opts.base} недоступен: ${health.status} ${JSON.stringify(health.body)}`);
  if (!health.body?.testHooks) throw new Error(`API ${opts.base} запущен без STAND_TEST_HOOKS=1`);
  log(`API ${opts.base}: ${JSON.stringify(health.body)}`);
  const dbRev = await db.revision(doc.docId);
  const dist = await db.instanceDistribution(doc.docId);
  log(`документ ${doc.docId}: ${doc.pages.length} страниц, ${doc.raw.shapes.length} фигур, ревизия в БД ${dbRev}; источники с экземплярами: ${new Set(dist.map((r) => r.sourceId)).size}`);
  await api.resetAll(doc.docId);
  const oracle0 = new Oracle({ docJson: opts.docJson, dbUrl: opts.dbUrl, artifactsDir: path.join(opts.outDir, 'artifacts', 'preflight') });
  const baseline = await oracle0.compareDb('baseline', [], { checkOperations: true });
  if (!baseline.ok) throw new Error(`БД после сброса не совпадает с экспортом генератора: ${describeReport(baseline)}`);
  log(`эталон: БД после сброса == ${path.relative(REPO_ROOT, opts.docJson)} (ревизия ${baseline.report.actualRevision})`);
  const S = doc.pickSource({ minPlainPages: 3 });
  log(`источник для проверок: ${S.id} (экземпляров ${S.instances.length}, непереопределённые на страницах ${S.plainPages.map((p) => doc.pageById.get(p).index).join(',')})`);

  const browser = await chromium.launch({ headless: opts.headless });
  const checks = opts.only ? CHECKS.filter((c) => opts.only.includes(c.id)) : CHECKS;
  if (checks.length === 0) throw new Error(`--only: ни одна проверка не выбрана (доступны: ${CHECKS.map((c) => c.id).join(', ')})`);
  if (opts.only) {
    const unknown = opts.only.filter((id) => !CHECKS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`--only: неизвестные проверки ${unknown.join(', ')} (доступны: ${CHECKS.map((c) => c.id).join(', ')})`);
  }
  const runner = createRunner({
    timeoutMs: opts.timeoutMs,
    outDir: opts.outDir,
    log,
    partialCheckSet: checks.length < CHECKS.length,
    checkIds: checks.map((c) => c.id),
  });

  try {
    for (const cfg of opts.configs) {
      const key = configKey(cfg);
      let skipReason = null;
      if (cfg.adapter === 'Z') skipReason = await zeroPreflight(browser, opts, doc, zeroUrl);
      /** @type {any[]} */
      let sessions = [];
      await runner.runConfig(
        cfg,
        checks,
        async (check) => {
          const artifactsDir = path.join(opts.outDir, 'artifacts', key);
          const ctx = {
            cfg,
            base: opts.base,
            zeroQueryApi: opts.zeroQueryApi,
            zeroApi: new Api(opts.zeroQueryApi),
            browser,
            doc,
            bobDoc,
            bobDocId: opts.bobDocId,
            api,
            db,
            oracle: new Oracle({ docJson: opts.docJson, dbUrl: opts.dbUrl, artifactsDir }),
            artifactsDir,
            log,
            partial: {},
            /** @param {any} o */
            async open(o = {}) {
              const s = await openStand(browser, {
                base: opts.base,
                cfg,
                docId: o.docId ?? doc.docId,
                user: o.user ?? 'alice',
                probe: o.probe ?? null,
                waitFor: o.waitFor ?? 'any',
                timeoutMs: o.timeoutMs,
                beforeGoto: o.beforeGoto ?? null,
                query: { ...(zeroUrl && cfg.adapter === 'Z' ? { zero: zeroUrl } : {}), ...(o.query ?? {}) },
              });
              // сессии, где ошибки страницы ОЖИДАЕМЫ по построению проверки (например, клиент bob,
              // намеренно заставленный запросить чужой документ) — их консоль не участвует в assertNoErrors
              s.expectErrors = o.expectErrors === true;
              sessions.push(s);
              return s;
            },
            assertNoErrors() {
              const errs = sessions.filter((s) => !s.expectErrors).flatMap((s) => s.errors);
              if (errs.length) throw new Error(`ошибки в консоли страницы: ${errs.slice(0, 5).join(' | ')}`);
            },
          };
          return ctx;
        },
        {
          skipReason,
          before: async () => {
            sessions = [];
            await api.resetAll(doc.docId);
          },
          after: async (check, ctx) => {
            for (const s of sessions) await s.close();
            sessions = [];
            if (ctx) writeFileSync(path.join(ctx.artifactsDir, `${check.id}-partial.json`), JSON.stringify(ctx.partial ?? {}, null, 2));
            await api.clearDelays().catch(() => undefined);
          },
        },
      );
    }
  } finally {
    await browser.close().catch(() => undefined);
    await api.resetAll(doc.docId).catch(() => undefined);
  }

  const summary = runner.writeSummary({
    base: opts.base,
    label: opts.label,
    docId: doc.docId,
    docJson: path.relative(REPO_ROOT, opts.docJson),
    docPages: doc.pages.length,
    docShapes: doc.raw.shapes.length,
    docProfile: `${doc.docId}: ${doc.pages.length} страниц × ${Math.round(doc.raw.shapes.length / doc.pages.length)} фигур; источник проверок ${S.id} (${S.instances.length} экземпляров на ${S.pages.length} страницах, непереопределённые на ${S.plainPages.length}); библиотечная страница ${doc.libraryPageId ?? '—'}`,
    bobDocId: opts.bobDocId,
    adapters: opts.adapters,
    zeroUrl,
    zeroQueryApi: opts.zeroQueryApi,
  });
  log(`summary: ${path.relative(REPO_ROOT, path.join(opts.outDir, 'summary.md'))} — pass ${summary.totals.pass}, fail ${summary.totals.fail}, skip ${summary.totals.skip}, n/a ${summary.totals.na}`);
  log(`допуск: ${summary.totals.admitted.join(', ') || '—'}; с оговоркой: ${summary.totals.admittedWithCaveat.join(', ') || '—'}; частичный набор: ${summary.totals.admittedPartial.join(', ') || '—'}; не допущены: ${summary.totals.notAdmitted.join(', ') || '—'}`);
  process.stdout.write(renderTable(summary));
  if (summary.totals.fail > 0 || summary.totals.notAdmitted.length > 0) return 1;
  if (summary.totals.admittedWithCaveat.length > 0 || summary.totals.admittedPartial.length > 0) return 3;
  return 0;
}

/** Z: проверяем, что адаптер реально работает (иначе вся конфигурация пропускается с причиной). */
async function zeroPreflight(browser, opts, doc, zeroUrl) {
  if (opts.skipZ) return 'Z пропущен по STAND_FUNCTIONAL_SKIP_Z=1';
  let s = null;
  try {
    s = await openStand(browser, { base: opts.base, cfg: { adapter: 'Z', mode: 'P', cache: 1 }, docId: doc.docId, user: 'alice', waitFor: 'any', timeoutMs: 45_000, query: zeroUrl ? { zero: zeroUrl } : {} });
    const r = await s.page.evaluate(() => {
      const st = /** @type {any} */ (window).__stand;
      return { state: st.state, errors: st.events.filter((e) => e.type === 'error').map((e) => e.detail?.message ?? '') };
    });
    if (r.state === 'ready') return null;
    return `Z недоступен: state=${r.state}; ${r.errors.join('; ').slice(0, 300)}`;
  } catch (e) {
    return `Z недоступен: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
  } finally {
    if (s) await s.close();
  }
}

function renderTable(summary) {
  const ids = [...new Set(summary.rows.map((r) => r.id))];
  const lines = [];
  lines.push(['config', ...ids, 'verdict'].join('\t'));
  for (const c of summary.configs) {
    lines.push([configLabel(c.config), ...ids.map((id) => c.checks.find((x) => x.id === id)?.status ?? '-'), c.verdict].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(2);
  },
);
