// @ts-check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startNetshaper } from '@stand/netshaper';
import { buildPlan, filterPlan, shuffle, mulberry32 } from '../src/series/plan.mjs';
import { runSeries, flattenRun, writeReferenceInputs } from '../src/series/run.mjs';
import { COLUMNS, REQUIRED_COLUMNS, readCsvRunIds } from '../src/series/csv.mjs';
import { buildPassport, harnessIdentity, redactSecrets } from '../src/series/passport.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const here = path.dirname(fileURLToPath(import.meta.url));

const CONFIGS = [
  { adapter: 'H', mode: 'F', cache: 1 },
  { adapter: 'H', mode: 'P', cache: 1 },
  { adapter: 'Q', mode: 'F', cache: 1 },
  { adapter: 'Q', mode: 'P', cache: 1 },
  { adapter: 'Z', mode: 'F', cache: 1 },
  { adapter: 'Z', mode: 'P', cache: 1 },
];

test('plan: seeded shuffle is deterministic, differs between repetitions, stable under --only', () => {
  const a = buildPlan({ name: 's', configs: CONFIGS, repetitions: 3, seed: 42 });
  const b = buildPlan({ name: 's', configs: CONFIGS, repetitions: 3, seed: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 18);
  assert.deepEqual(a.map((p) => p.order_index), [...Array(18).keys()]);
  const rep = (/** @type {number} */ r) => a.filter((p) => p.repetition === r).map((p) => `${p.config.adapter}${p.config.mode}`);
  for (let r = 0; r < 3; r++) assert.deepEqual([...rep(r)].sort(), ['HF', 'HP', 'QF', 'QP', 'ZF', 'ZP'], 'each repetition is a permutation');
  assert.notDeepEqual(rep(0), rep(1), 'repetitions are shuffled differently');
  const c = buildPlan({ name: 's', configs: CONFIGS, repetitions: 3, seed: 7 });
  assert.notDeepEqual(c.map((p) => p.run_id), a.map((p) => p.run_id), 'another seed → another order');
  assert.match(a[0].run_id, /^s-0000-[HQZ][FP]1$/);
  const only = filterPlan(a, 'H:P:1');
  assert.equal(only.length, 3);
  assert.ok(only.every((p) => p.config.adapter === 'H' && p.config.mode === 'P'));
  assert.deepEqual(only.map((p) => p.order_index), a.filter((p) => p.config.adapter === 'H' && p.config.mode === 'P').map((p) => p.order_index));
  assert.equal(filterPlan(a, 'Q').length, 6);
  assert.equal(filterPlan(a, 'H:F,Z:P').length, 6);
  // известная перестановка для seed=42, rep=0 (регрессия детерминизма)
  const rng = mulberry32(12345);
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], rng), shuffle([1, 2, 3, 4, 5], mulberry32(12345)));
});

test('csv schema contains every required column from packages/analysis/COLUMNS.md', () => {
  const md = fs.readFileSync(path.resolve(here, '../../analysis/COLUMNS.md'), 'utf8');
  const required = md.split('## Необязательные')[0];
  /** @type {string[]} */
  const names = [];
  for (const m of required.matchAll(/^\| `([^`]+)`/gm)) names.push(m[1]);
  const expanded = names.flatMap((n) => (n.startsWith('t_nav_1_ms') ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `t_nav_${i}_ms`) : [n])).filter((n) => n !== 'Колонка');
  assert.ok(expanded.length >= 50, `parsed ${expanded.length} names`);
  for (const n of expanded) assert.ok(COLUMNS.includes(n), `missing column ${n}`);
  assert.deepEqual(REQUIRED_COLUMNS.filter((c) => !expanded.includes(c)), [], 'no stray required columns');
});

test('flattenRun maps a record to a row (bytes orientation, MB heap, budgets)', () => {
  const row = flattenRun({
    run_id: 'x-0000-HP1',
    series: 'x',
    adapter: 'H',
    mode: 'P',
    cache: 1,
    doc: 'd',
    repetition: 0,
    order_index: 0,
    started_at: 't',
    outcome: 'ok',
    scenario: { t_first_ready: 500, t_nav: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], t_nav_new: [1, 2, 4, 6, 8, 10], t_nav_return: [3, 5, 7, 9], t_cmd_ack: 80, t_cmd_drawn: 140, t_scenario: 12000, js_heap_peak_mib: 10, js_heap_end_mib: 8, retained_end: { pages: 2, shapes: 1000 }, retained_pages_max: 2, retained_shapes_max: 1000, loaded_pages_end: 2, steps: [{}], budgets: { firstReady: true, navAll: true, cmdDrawn: true, scenario: true } },
    shaper: { config: { delayMs: 25, bandwidthMbit: 20 }, stats: { bytesIn: 1000, bytesOut: 50000 } },
    server: { api: { cpu_ms: 10, mem_peak_mib: 1, mem_integral_mib_s: 2, matched: true } },
    serverGroupsConfigured: true,
    procGroups: [
      { name: 'api', adapters: null },
      { name: 'pg', adapters: null },
      { name: 'zero', adapters: ['Z'] },
    ],
  });
  assert.equal(row.bytes_in, 50000, 'bytes_in = к клиенту = shaper bytesOut');
  assert.equal(row.bytes_out, 1000);
  assert.equal(row.js_heap_peak_mb, (10 * 1048576) / 1e6);
  assert.equal(row.t_nav_new_median_ms, 5);
  assert.equal(row.t_nav_return_median_ms, 6);
  assert.equal(row.t_nav_10_ms, 10);
  // Группа без сводки сэмплера — ОТСУТСТВИЕ измерения, а не ноль ресурсов: в CSV пусто (A8/N6).
  // Тихий 0 означал бы «сервер ничего не делал» там, где ничего не измеряли.
  assert.equal(row.server_pg_cpu_ms, null, 'группа без измерения → пусто, а не 0');
  assert.equal(row.zero_replica_bytes, null, 'реплика без измерения → пусто, а не 0');
  // zero-cache сэмплируется в КАЖДОМ прогоне, но в бюджет H/Q не входит: «фон», а не «неприменимо»
  assert.equal(row.server_zero_applicable, false, 'в прогоне H группа zero — измеренный фон, не бюджет');
  assert.equal(row.rtt_ms, 50);
  assert.equal(row.within_budget_nav, true);
});

test('writeReferenceInputs: нет снимка последней страницы маршрута → problem (прогон станет error)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ref-'));
  try {
    // P-прогон дошёл до конца, но снимок последней страницы маршрута (50) не снят: lastPage === null.
    // Сверка эталона была бы вакуозной, поэтому writeReferenceInputs обязан вернуть problem —
    // runSeries по нему помечает прогон fail('reference_inputs') → outcome 'error', reference_ok=false
    // (а reference-check.sh на пустом STAND_REQUIRE_PAGES выходит с кодом 3).
    const rec = { mode: 'P', outcome: 'ok', scenario: { route: [2, 3, 50], snapshots: { 2: { pageId: 'p2', snapshot: { revision: 1, shapes: [] } } }, command: null, events: [] } };
    const out = writeReferenceInputs(path.join(dir, 'ref'), rec, { docPages: 50 });
    assert.deepEqual(out.requiredPages, []);
    assert.match(String(out.problem), /last route page \(index 50\) has no snapshot/);
    // F-прогон вообще без снимков — тоже problem, с другой формулировкой
    const recF = { mode: 'F', outcome: 'ok', scenario: { route: [2, 50], snapshots: {}, command: null, events: [] } };
    const outF = writeReferenceInputs(path.join(dir, 'refF'), recF, { docPages: 50 });
    assert.match(String(outF.problem), /no page snapshots were collected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- интеграционный прогон серии на фейках: сервер процессом (для сэмплера), шейпер в процессе ----
/** @type {import('node:child_process').ChildProcess} */
let fakeProc;
let fakePort = 0;
/** @type {Awaited<ReturnType<typeof startNetshaper>>} */
let shaper;
let outDir = '';

before(async () => {
  fakeProc = spawn(process.execPath, [path.join(here, 'fakes/fake-server.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  fakePort = await new Promise((resolve, reject) => {
    let buf = '';
    fakeProc.stdout?.on('data', (d) => {
      buf += d.toString();
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    fakeProc.on('exit', (code) => reject(new Error(`fake server exited ${code}`)));
  });
  shaper = await startNetshaper({ listen: 0, routes: `/api=127.0.0.1:${fakePort},/zero=127.0.0.1:${fakePort},/=127.0.0.1:${fakePort}`, delayMs: 25, bandwidthMbit: 20, statsPort: 0 });
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-'));
});

after(async () => {
  await shaper?.close();
  fakeProc?.kill('SIGTERM');
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

const seriesConfig = () => ({
  name: 'fake-main',
  doc: 'doc-fake',
  sourceId: 'S1',
  fill: '#ff8800',
  configs: [
    { adapter: 'H', mode: 'P', cache: 1 },
    { adapter: 'Q', mode: 'F', cache: 1 },
  ],
  repetitions: 2,
  seed: 42,
  shaper: { delayMs: 25, bandwidthMbit: 20, statsUrl: `http://127.0.0.1:${shaper.statsPort}` },
  baseUrl: `http://127.0.0.1:${shaper.listenPort}`,
  api: { url: `http://127.0.0.1:${fakePort}`, login: 'alice', password: 'alice-pass' },
  procGroups: [
    { name: 'api', patterns: ['fake-server\\.mjs'], allowSelfTree: true },
    // Эти две группы заведомо ни с чем не совпадают: в фейковом прогоне нет ни PostgreSQL, ни
    // zero-cache. `essential:false` говорит, что отсутствие совпадений здесь не делает прогон
    // ошибочным (в настоящей серии api/pg/zero существенны по умолчанию), но колонки всё равно
    // остаются ПУСТЫМИ, а прогон помечается sampling_incomplete — это и проверяется ниже.
    { name: 'pg', patterns: ['no-such-postgres-zzz'], essential: false },
    { name: 'zero', patterns: ['no-such-zero-zzz'], dir: path.join(outDir, 'zero-replica-empty'), essential: false },
  ],
  scenario: { pauseMs: 50, stepTimeoutMs: 5000, extraQuery: { navMs: '60', readyMs: '80', ackMs: '30', drawnMs: '50', fetchBytes: '20000' } },
  docPages: 50,
  docShapesPerPage: 500,
  cooldownMs: 0,
  notes: 'fake',
});

test('dry-run prints the plan and writes nothing', async () => {
  /** @type {string[]} */
  const lines = [];
  const r = await runSeries(seriesConfig(), { outDir, dryRun: true, log: (m) => lines.push(m) });
  assert.equal(r.plan.length, 4);
  assert.equal(r.executed.length, 0);
  assert.ok(!fs.existsSync(path.join(outDir, 'fake-main')));
  assert.ok(lines.some((l) => /pending/.test(l)));
});

test('series run on fakes: files, csv, passport, resume, --only, --repetitions', async () => {
  const cfg = seriesConfig();
  /** @type {string[]} */
  const lines = [];
  const r1 = await runSeries(cfg, { outDir, repetitions: 1, log: (m) => lines.push(m) });
  assert.equal(r1.executed.length, 2);
  for (const rec of r1.executed) assert.equal(rec.outcome, 'ok', `${rec.run_id}: ${rec.error_stage} ${rec.error_message}`);
  const dir = path.join(outDir, 'fake-main');
  const csv = fs.readFileSync(path.join(dir, 'runs.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 3);
  assert.equal(csv[0], COLUMNS.join(','));
  const header = csv[0].split(',');
  const row = Object.fromEntries(csv[1].split(',').map((v, i) => [header[i], v]));
  assert.equal(row.series, 'fake-main');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.repetition, '0');
  assert.ok(Number(row.t_first_ready_ms) > 80 && Number(row.t_first_ready_ms) < 2000, row.t_first_ready_ms);
  assert.ok(Math.abs(Number(row.t_nav_1_ms) - 60) < 25);
  assert.ok(Math.abs(Number(row.t_cmd_ack_ms) - 30) < 25);
  assert.ok(Number(row.bytes_in) > 10 * 20000, `bytes_in=${row.bytes_in} (к клиенту, ≥ 11 страниц по 20 КБ)`);
  assert.ok(Number(row.bytes_out) > 1000 && Number(row.bytes_out) < Number(row.bytes_in));
  assert.ok(Number(row.cdp_bytes_in) > 10 * 20000);
  assert.ok(Number(row.js_heap_peak_mb) > 0);
  assert.ok(Number(row.chromium_private_peak_mib) > 50);
  assert.ok(Number(row.server_api_cpu_ms) >= 0 && row.server_api_cpu_ms !== '');
  assert.ok(Number(row.server_api_mem_peak_mib) > 10, `api mem ${row.server_api_mem_peak_mib}`);
  // группа сэмплировалась и НЕ нашла процессов → пусто (не 0: ноль был бы неотличим от честного нуля)
  assert.equal(row.server_pg_cpu_ms, '');
  assert.equal(row.server_zero_cpu_ms, '');
  assert.equal(row.sampling_incomplete, 'pg|zero');
  assert.ok(Number(row.server_disk_used_bytes) >= 0 && row.server_disk_used_bytes !== '');
  assert.equal(row.zero_replica_bytes, '0', 'размер каталога измерен независимо от процессов');
  assert.equal(row.within_budget_scenario, 'true');
  assert.equal(row.reference_ok, '', 'no reference command configured → empty');
  assert.equal(row.rtt_ms, '50');
  assert.equal(row.doc_pages, '50');
  assert.equal(row.retained_shapes_max, row.mode === 'P' ? '1000' : '25000');
  assert.ok(Number(row.browser_launch_ms) > 0);
  // per-run json
  const files = fs.readdirSync(path.join(dir, 'runs')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'runs', files[0]), 'utf8'));
  assert.equal(rec.steps.length, 11);
  assert.ok(rec.steps.every((s) => typeof s.retained_pages === 'number' && typeof s.loaded_pages === 'number' && typeof s.t_ms === 'number'));
  assert.ok(rec.snapshots['50'].snapshot.shapes.length > 0);
  assert.equal(rec.preflight.login.userId, 'u-alice');
  assert.equal(rec.preflight.reset.docId, 'doc-fake');
  assert.ok(rec.server.api.samples.length > 3);
  assert.equal(rec.sampling.groups.api.matched, true);
  assert.equal(rec.sampling.groups.pg.matched, false);
  assert.deepEqual(rec.sampling.essentialMissing, []);

  assert.ok(rec.chromium.samples.length > 3);
  assert.equal(rec.shaper.config.delayMs, 25);
  // passport
  const passport = JSON.parse(fs.readFileSync(path.join(dir, 'passport.json'), 'utf8'));
  assert.equal(passport.series, 'fake-main');
  assert.ok(passport.host.cpuModel && passport.host.kernel);
  assert.equal(passport.versions.node, process.version);
  assert.equal(passport.versions.playwright, '1.56.0');
  assert.match(passport.versions.chromium, /^\d+\.\d+/);
  assert.equal(passport.shaper.delayMs, 25);
  assert.equal(passport.seed, 42);
  assert.ok(passport.finishedAt);
  assert.ok(passport.packages['ws']);
  // resume: те же 2 прогона пропускаются, добавляется 2-е повторение
  const r2 = await runSeries(cfg, { outDir, log: () => {} });
  assert.equal(r2.pending.length, 2);
  assert.equal(r2.executed.length, 2);
  assert.ok(r2.executed.every((x) => x.repetition === 1));
  assert.equal(readCsvRunIds(path.join(dir, 'runs.csv')).size, 4);
  // --only с уже выполненными → нечего делать
  const r3 = await runSeries(cfg, { outDir, only: 'H:P:1', log: () => {} });
  assert.equal(r3.plan.length, 2);
  assert.equal(r3.pending.length, 0);
});

test('series run: hook failure → outcome error @preflight, run still recorded; hang → timeout stage', async () => {
  const cfg = { ...seriesConfig(), name: 'fake-errors', api: { url: 'http://127.0.0.1:1' }, maxConsecutiveErrors: 1 };
  const r = await runSeries(cfg, { outDir, repetitions: 1, log: () => {} });
  assert.equal(r.executed.length, 1, 'aborted after maxConsecutiveErrors');
  assert.equal(r.executed[0].outcome, 'error');
  assert.equal(r.executed[0].error_stage, 'preflight');
  const csv = fs.readFileSync(path.join(outDir, 'fake-errors', 'runs.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 2);
  const cfg2 = { ...seriesConfig(), name: 'fake-hang', configs: [{ adapter: 'Z', mode: 'P', cache: 1 }], scenario: { pauseMs: 30, stepTimeoutMs: 400, extraQuery: { hangAt: 'nav_2', navMs: '30', readyMs: '30' } } };
  const r2 = await runSeries(cfg2, { outDir, repetitions: 1, log: () => {} });
  assert.equal(r2.executed[0].outcome, 'timeout');
  assert.equal(r2.executed[0].error_stage, 'nav_2');
  assert.ok(r2.executed[0].chromium.private_peak_mib > 0, 'samplers still collected');
  assert.ok(r2.executed[0].shaper.stats.bytesOut > 0);
});

// ---------------------------------------------------------------------------------------------
// Паспорт: секреты, идентичность оболочки (дефекты «пароль в паспорте» и «оболочка менялась»)
// ---------------------------------------------------------------------------------------------

test('паспорт: пароль тестовой учётки не попадает НИ В ОДНО поле (redactSecrets)', () => {
  const series = {
    name: 's',
    seed: 1,
    repetitions: 2,
    configs: [{ adapter: 'H', mode: 'P', cache: 1 }],
    api: { url: 'http://127.0.0.1:3000', login: 'alice', password: 'alice-pass' },
    nested: { deep: [{ zeroAdminPassword: 'admin-pass', token: 'tok', ok: 'visible' }] },
  };
  const passport = buildPassport({ rootDir: path.resolve(here, '../../..'), series, shaper: { delayMs: 25, bandwidthMbit: 20 } });
  const text = JSON.stringify(passport);
  assert.ok(!text.includes('alice-pass'), 'пароль тестовой учётки в паспорте');
  assert.ok(!text.includes('admin-pass'), 'пароль администратора в паспорте');
  assert.ok(!text.includes('"tok"'), 'токен в паспорте');
  assert.equal(passport.seriesConfig.api.login, 'alice', 'несекретные поля сохраняются как есть');
  assert.equal(passport.seriesConfig.api.password, '(задан, не записывается)');
  assert.equal(passport.seriesConfig.nested.deep[0].ok, 'visible');
  // редактор не зависит от регистра и от вложенности
  assert.deepEqual(redactSecrets({ SECRET: 'x', a: { b: { apiKey: 'y' } } }), { SECRET: '(задан, не записывается)', a: { b: { apiKey: '(задан, не записывается)' } } });
  assert.deepEqual(redactSecrets({ password: '' }), { password: '(пусто)' }, 'пустой секрет отличим от заданного');
});

test('конфигурации серий не содержат пароля вовсе (источник, а не только редакция)', () => {
  const dir = path.resolve(here, '../series');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/"password"/.test(text), `${f}: ключ password в конфигурации серии`);
    assert.ok(!/alice-pass|bob-pass/.test(text), `${f}: пароль тестовой учётки в конфигурации серии`);
  }
});

test('harnessIdentity: различает версию оболочки, набор колонок и конфигурацию серии', () => {
  const rootDir = path.resolve(here, '../../..');
  const series = { name: 's', configs: [{ adapter: 'H', mode: 'P', cache: 1 }], seed: 1 };
  const a = harnessIdentity({ rootDir, series, columns: COLUMNS });
  const b = harnessIdentity({ rootDir, series: { ...series, configs: [...series.configs] }, columns: COLUMNS });
  assert.equal(a.harnessId, b.harnessId, 'один и тот же вход → один и тот же идентификатор');
  assert.equal(a.harnessIdShort, a.harnessId.slice(0, 16));
  assert.equal(a.columnCount, COLUMNS.length);
  assert.notEqual(a.harnessId, harnessIdentity({ rootDir, series, columns: [...COLUMNS, 'extra'] }).harnessId, 'смена набора колонок → другой идентификатор');
  assert.notEqual(a.harnessId, harnessIdentity({ rootDir, series: { ...series, seed: 2 }, columns: COLUMNS }).harnessId, 'другая конфигурация серии → другой идентификатор');
  // секрет в конфигурации не влияет на хеш (иначе идентификатор зависел бы от значения пароля)
  assert.equal(harnessIdentity({ rootDir, series: { ...series, api: { password: 'p1' } }, columns: COLUMNS }).harnessId, harnessIdentity({ rootDir, series: { ...series, api: { password: 'p2' } }, columns: COLUMNS }).harnessId);
  // порядок ключей не влияет, порядок конфигураций — влияет (это порядок измерения)
  assert.equal(harnessIdentity({ rootDir, series: { configs: series.configs, seed: 1, name: 's' }, columns: COLUMNS }).harnessId, a.harnessId);
  for (const k of a.comparableBy) assert.ok(a[k], `comparableBy: поле ${k} пустое`);
});

test('flattenRun: разложение обмена по маршрутам и пик памяти без окна пробы', () => {
  const row = flattenRun({
    run_id: 'x-0000-ZF1',
    series: 'x',
    adapter: 'Z',
    mode: 'F',
    cache: 1,
    doc: 'd',
    harness_id: 'abcdef0123456789',
    scenario: { steps: [], heap_sampler: { suspended_ms: 3146, coverage: 0.88 } },
    probe_windows: { count: 14, total_ms: 4202.2 },
    chromium: { private_peak_mib: 259.4, private_peak_excl_probe_mib: 232.8, probe_ticks: 19, matched_ticks: 64, private_end_mib: 200 },
    shaper: {
      config: { delayMs: 25, bandwidthMbit: 20 },
      stats: {
        bytesIn: 16809,
        bytesOut: 7667914,
        byRoute: {
          '/api': { bytesIn: 2303, bytesOut: 4122 },
          '/zero': { bytesIn: 10363, bytesOut: 7091230 },
          '/': { bytesIn: 4143, bytesOut: 572562 },
          '(none)': { bytesIn: 0, bytesOut: 0 },
        },
      },
    },
    serverGroupsConfigured: false,
    procGroups: [],
  });
  assert.equal(row.bytes_in_api + row.bytes_in_zero + row.bytes_in_static + row.bytes_in_other, row.bytes_in, 'разложение bytes_in сходится с итогом');
  assert.equal(row.bytes_out_api + row.bytes_out_zero + row.bytes_out_static + row.bytes_out_other, row.bytes_out, 'разложение bytes_out сходится с итогом');
  assert.equal(row.bytes_in_route_residual, 0);
  assert.equal(row.bytes_out_route_residual, 0);
  assert.equal(row.bytes_in_static, 572562, 'статика сборки выделена отдельно — она не данные');
  // головная величина пика — БЕЗ окна измерительной пробы; сырая остаётся рядом
  assert.equal(row.chromium_private_peak_excl_probe_mib, 232.8);
  assert.equal(row.chromium_private_peak_raw_mib, 259.4);
  assert.equal(row.chromium_private_peak_mib, 259.4);
  assert.equal(row.chromium_probe_ticks, 19);
  assert.equal(row.probe_window_count, 14);
  assert.equal(row.probe_window_ms, 4202.2);
  assert.equal(row.js_heap_sampler_coverage, 0.88);
  assert.equal(row.harness_id, 'abcdef0123456789');
});
