#!/usr/bin/env node
// @ts-check
/**
 * Серия прогонов (SPEC §7.4).
 *
 *   node src/series/run.mjs --config series/main.json [--out ../../results] [--dry-run]
 *        [--repetitions N] [--only H:P:1[,Q:F:1]] [--no-resume] [--verbose] [--progress <file>]
 *
 * Для каждого прогона: reset документа через тестовый хук (свежий токен alice),
 * resetCommand (если задан), сброс счётчиков и параметров шейпера, НОВЫЙ процесс Chromium +
 * новый контекст (холодный клиент: пустые кеши, IDB, localStorage), сэмплеры /proc и Chromium,
 * приёмочный сценарий, статистика шейпера → results/<series>/runs/<run_id>.json и строка в
 * runs.csv (схема — src/series/csv.mjs, согласована с packages/analysis/COLUMNS.md).
 *
 * Цена «новый процесс Chromium на прогон»: запуск ≈ 0.3–0.8 с и первые ~100–150 МиБ частной
 * памяти на прогон (учитываются в chromium_private_*); зато память и кеши процесса не
 * наследуются между прогонами и конфигурациями — измерение действительно холодное.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { runAcceptanceScenario, DEFAULT_ROUTE, DEFAULT_BUDGETS } from '../scenario/acceptance.mjs';
import { startProcSampler, resolveGroups, resolveGroupPaths } from '../sampling/procs.mjs';
import { dirSizeBytes } from '../sampling/procfs.mjs';
import { startChromiumSampler, attachCdp, browserPid } from '../sampling/chromium.mjs';
import { createProbeWindows } from '../sampling/probe-windows.mjs';
import { buildPlan, filterPlan, configKey } from './plan.mjs';
import { appendCsvRow, readCsvRunIds, median, COLUMNS } from './csv.mjs';
import { buildPassport, completePassport } from './passport.mjs';
import { testHookHeaders } from '../test-secret.mjs';
import { passwordFor } from '../test-users.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../../../..');
const MIB = 1024 * 1024;

/**
 * @typedef {object} SeriesConfig
 * @property {string} name
 * @property {string} doc
 * @property {string} sourceId
 * @property {string} fill
 * @property {import('./plan.mjs').RunConfig[]} configs
 * @property {Array<{name: string, sourceId?: string, fill?: string, note?: string}>} [variants]
 *            варианты КОМАНДЫ (серия `command-shape`): каждая конфигурация измеряется с каждым
 *            вариантом; вариант задаёт свой источник `setSourceFill` (доля изменённых объектов и
 *            их размещение) и входит в run_id, ключ конфигурации и колонку `cmd_variant`
 * @property {number} repetitions
 * @property {number} seed
 * @property {{delayMs: number, bandwidthMbit: number, bucketMs?: number, handshakeRtt?: boolean, statsUrl?: string}} shaper
 * @property {string} [baseUrl]                     http://127.0.0.1:8080 (шейпер)
 * @property {{url?: string, login?: string, password?: string}} [api]   API напрямую (для хуков), http://127.0.0.1:3000
 * @property {string|null} [resetCommand]            shell-команда перед каждым прогоном (cwd — корень репозитория)
 * @property {string|null} [referenceCommand]        shell-команда после прогона (cwd — корень репозитория); код 0 → reference_ok=true.
 *                                                    Получает STAND_RUN_JSON, STAND_RUN_ID, STAND_DOC, STAND_DOC_JSON, STAND_SERIES_DIR,
 *                                                    STAND_REF_DIR (каталог для отчётов), STAND_RUN_COMMANDS (JSON команд прогона с opId),
 *                                                    STAND_RUN_SNAPSHOTS_DIR (снимки страниц клиента, по файлу на страницу),
 *                                                    STAND_REQUIRE_PAGES (pageId через запятую, снимки которых обязаны быть), STAND_API_URL
 * @property {string} [docJson]                       экспорт генератора для эталона (data/<name>.json), относительно корня репозитория
 * @property {Array<{name: string, patterns?: string[], pids?: number[], pidFile?: string, cwd?: string, exclude?: string[], dir?: string, allowSelfTree?: boolean, adapters?: string[], essential?: boolean}>} [procGroups]
 *                                                    pidFile/dir — относительно корня репозитория; `adapters` — сэмплировать группу только
 *                                                    для этих адаптеров (zero-cache считается только в прогонах Z; в H/Q столбцы = 0);
 *                                                    `essential` — пустая группа делает прогон ошибочным (по умолчанию для api/pg/zero)
 * @property {string[]} [serverDiskDirs]              каталоги для server_disk_used_bytes (по умолчанию PGDATA + каталог реплики)
 * @property {{channel?: string|null, args?: string[], headless?: boolean, viewport?: {width:number,height:number}}} [browser]
 * @property {{pauseMs?: number, stepTimeoutMs?: number, route?: number[], cmdAfterStep?: number, autologin?: string, budgets?: Partial<typeof DEFAULT_BUDGETS>, extraQuery?: Record<string,string>}} [scenario]
 * @property {number} [docPages]
 * @property {number} [docShapesPerPage]
 * @property {number} [cooldownMs]
 * @property {number} [maxConsecutiveErrors]
 * @property {string} [notes]
 */

const DEFAULT_PROC_GROUPS = [
  { name: 'api', patterns: ['node .*server'], exclude: ['netshaper', 'fake-server\\.mjs$'] },
  { name: 'pg', patterns: ['postgres'] },
  { name: 'zero', patterns: ['zero-cache'] },
];

/**
 * Разворачивает `variants` (варианты команды) в плоский список конфигураций: каждая конфигурация
 * серии × каждый вариант. Порядок — конфигурации внешним циклом, варианты внутренним; перемешивание
 * в повторении (`plan.mjs`) идёт уже по всему списку, поэтому варианты не идут подряд.
 * Без `variants` список конфигураций остаётся прежним (run_id и ключи не меняются).
 * @param {SeriesConfig} series
 * @returns {import('./plan.mjs').RunConfig[]}
 */
export function expandConfigs(series) {
  const variants = /** @type {any[]} */ (/** @type {any} */ (series).variants ?? []);
  if (!variants.length) return series.configs;
  /** @type {import('./plan.mjs').RunConfig[]} */
  const out = [];
  for (const c of series.configs) {
    for (const v of variants) {
      if (!v?.name) throw new Error('series config: variants[].name is required');
      out.push({ ...c, variant: v.name, sourceId: v.sourceId ?? series.sourceId, fill: v.fill ?? series.fill });
    }
  }
  return out;
}

/** @param {string} file @returns {SeriesConfig} */
export function loadSeriesConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['name', 'doc', 'sourceId', 'fill', 'configs', 'repetitions', 'seed', 'shaper']) {
    if (cfg[k] === undefined) throw new Error(`series config: missing "${k}"`);
  }
  return cfg;
}

/**
 * @param {string} url
 * @param {{method?: string, body?: unknown, token?: string, timeoutMs?: number, headers?: Record<string,string>}} [opts]
 */
async function httpJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    /** @type {any} */
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${url} → ${res.status} ${text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Каталог данных PostgreSQL: `series.serverDiskDirs`, иначе PGDATA / первый существующий кластер. */
const PG_DATA_CANDIDATES = ['/var/lib/postgresql/16/main', '/var/lib/postgresql/17/main', '/var/lib/postgresql/data'];

/**
 * Каталоги, занятый объём которых считается «диском серверной части» (§1.7, бюджет 40 ГиБ):
 * данные PostgreSQL + реплика zero-cache. Переопределяется `series.serverDiskDirs`.
 * @param {SeriesConfig} series
 * @param {import('../sampling/procs.mjs').ProcGroupSpec[]} groups   уже с абсолютными путями
 * @returns {string[]}
 */
export function serverDiskDirs(series, groups) {
  const declared = /** @type {any} */ (series).serverDiskDirs;
  if (Array.isArray(declared)) return declared.map((d) => path.resolve(ROOT_DIR, d));
  /** @type {string[]} */
  const out = [];
  const pgdata = process.env.PGDATA || PG_DATA_CANDIDATES.find((d) => fs.existsSync(d)) || '';
  if (pgdata) out.push(pgdata);
  const replica = groups.find((g) => g.dir)?.dir ?? path.join(ROOT_DIR, 'results', 'zero-replica');
  if (replica && !out.includes(replica)) out.push(replica);
  return out;
}

/**
 * Принудительная сборка мусора через CDP (`HeapProfiler.collectGarbage`). Сценарий вызывает её в
 * ФИКСИРОВАННЫХ точках, не зависящих ни от адаптера, ни от режима, ни от вида пробы (после каждой
 * пробы шага, после пробы вслед за командой, в момент остановки часов, после выгрузки снимков и
 * после заключительного скана). Число фактических вызовов пишется в `scenario.gc.forced`
 * (колонка `js_heap_gc_count`) и обязано совпадать у всех конфигураций — иначе `js_heap_peak_mb`
 * и `chromium_private_peak_mib` измерены при разном давлении сборщика (дефект N2).
 * @param {import('playwright').CDPSession} session
 */
function makeGc(session) {
  let enabled = false;
  return async () => {
    if (!enabled) {
      try {
        await session.send('HeapProfiler.enable');
      } catch {
        /* домен уже включён или недоступен */
      }
      enabled = true;
    }
    await session.send('HeapProfiler.collectGarbage');
  };
}

/**
 * Дождаться, пока логическая репликация доставит в zero-cache всё, что уже записано в PostgreSQL:
 * слот подтвердил (`confirmed_flush_lsn`) позицию не раньше текущей `pg_current_wal_lsn()`.
 * Проверка идёт через `psql -w` (без запроса пароля) и НИКОГДА не роняет прогон: недоступный psql,
 * отсутствующий слот или тайм-аут дают `{ok:false, reason}` в записи прогона и предупреждение.
 * Отключается переменной STAND_SKIP_REPLICA_WAIT=1.
 * @param {{timeoutMs?: number, slot?: string, log?: (m: string) => void}} [opts]
 */
export async function waitForReplica(opts = {}) {
  if (process.env.STAND_SKIP_REPLICA_WAIT === '1') return { ok: null, ms: 0, reason: 'отключено STAND_SKIP_REPLICA_WAIT=1' };
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const slot = opts.slot ?? `${process.env.STAND_ZERO_APP_ID ?? 'stand'}_0_a`;
  const t0 = performance.now();
  const query = `SELECT coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), -1)::bigint FROM pg_replication_slots WHERE slot_name = '${slot}'`;
  let polls = 0;
  let lastLag = null;
  while (performance.now() - t0 < timeoutMs) {
    polls += 1;
    let out;
    try {
      out = execSync(`psql -qtAX -w -c "${query}"`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      return { ok: null, ms: Math.round(performance.now() - t0), polls, reason: `psql недоступен (${String(/** @type {any} */ (err)?.message ?? err).slice(0, 120)}) — ожидание реплики пропущено` };
    }
    if (out === '') return { ok: null, ms: Math.round(performance.now() - t0), polls, reason: `слот ${slot} не найден — ожидание реплики пропущено` };
    lastLag = Number(out);
    if (Number.isFinite(lastLag) && lastLag <= 0) return { ok: true, ms: Math.round(performance.now() - t0), polls, slot, lagBytes: lastLag };
    await sleep(50);
  }
  opts.log?.(`  ! реплика не догнала за ${timeoutMs} мс (слот ${slot}, отставание ${lastLag} Б) — прогон продолжается`);
  return { ok: false, ms: Math.round(performance.now() - t0), polls, slot, lagBytes: lastLag, reason: 'тайм-аут ожидания подтверждения слота' };
}

/**
 * Ждать промис не дольше ms; при превышении — вернуть undefined (для закрытия браузера и т. п.).
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 */
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => undefined)]);

/**
 * Плоская строка runs.csv из записи прогона.
 * @param {any} rec
 */
export function flattenRun(rec) {
  const sc = rec.scenario ?? {};
  const g = rec.server ?? {};
  const s = rec.shaper?.stats ?? null;
  /**
   * Показатель серверной группы процессов. Случаи, которые нельзя смешивать:
   *  - группа сэмплировалась и нашла процессы (`matched`) → измеренное число (для zero-cache в
   *    прогонах H/Q это измеренный ФОН компонента, нужного только профилю Z, а не его бюджет —
   *    см. `server_zero_applicable`);
   *  - группа сэмплировалась и НЕ нашла ни одного процесса (`matched:false`) → **null** (пусто в
   *    CSV), а не 0: ноль здесь неотличим от честного нуля и означал бы «сервер ничего не делал»
   *    там, где на самом деле не было измерения (критик B, п. 15). Прогон помечается
   *    `sampling_incomplete`;
   *  - группа не объявлена в серии → null.
   * Нуля «по построению» больше нет: с 2026-09-13 сэмплируются ВСЕ группы в КАЖДОМ прогоне (A8).
   * @param {string} name @param {string} field
   */
  const grp = (name, field) => {
    const gr = g[name];
    if (!gr) return null;
    return gr.matched === false ? null : gr[field];
  };
  /** Входит ли группа в бюджет адаптера этого прогона (`procGroups[].adapters`). */
  const applicable = (/** @type {string} */ name) => {
    const spec = (rec.procGroups ?? []).find((/** @type {any} */ s2) => s2.name === name);
    if (!spec) return g[name] ? true : null;
    return !spec.adapters || spec.adapters.includes(rec.adapter);
  };
  /** Компактная сводка полноты выборки: `имя=совпало/ожидалось`. */
  const ticks = Object.entries(rec.sampling?.groups ?? {})
    .map(([name, d]) => `${name}=${/** @type {any} */ (d).matched_ticks ?? '?'}/${/** @type {any} */ (d).expected_ticks ?? '?'}`)
    .join('|');
  const toMb = (/** @type {number} */ mib) => (Number.isFinite(mib) ? (mib * MIB) / 1e6 : NaN);
  /**
   * Байты шейпера по маршруту (`stats.byRoute`): '/api' — HTTP API, '/zero' — синхронизация
   * zero-cache (в т. ч. WebSocket), '/' — статика сборки клиента, '(none)' — соединение закрылось
   * до разбора первого запроса. Маршрут, не объявленный в шейпере, даёт 0 (а не null): его байты
   * учтены в '(none)' и в итоге, поэтому сумма разложения сходится с `bytes_in`/`bytes_out`.
   * @param {string} prefix @param {'bytesIn'|'bytesOut'} field
   */
  const routeBytes = (prefix, field) => {
    if (!s?.byRoute) return null;
    return s.byRoute[prefix]?.[field] ?? 0;
  };
  /** Остаток разложения: Σ по всем маршрутам − итог. Норма — 0. @param {'bytesIn'|'bytesOut'} field @param {number|null} total */
  const routeResidual = (field, total) => {
    if (!s?.byRoute || total === null) return null;
    let sum = 0;
    for (const rs of Object.values(s.byRoute)) sum += /** @type {any} */ (rs)?.[field] ?? 0;
    return sum - total;
  };
  /** @type {Record<string, unknown>} */
  const row = {
    run_id: rec.run_id,
    series: rec.series,
    adapter: rec.adapter,
    mode: rec.mode,
    cache: rec.cache,
    doc: rec.doc,
    repetition: rec.repetition,
    order_index: rec.order_index,
    started_at: rec.started_at,
    outcome: rec.outcome,
    error_stage: rec.error_stage ?? '',
    t_first_ready_ms: sc.t_first_ready,
    t_nav_new_median_ms: median(sc.t_nav_new ?? []),
    t_nav_return_median_ms: median(sc.t_nav_return ?? []),
    t_cmd_ack_ms: sc.t_cmd_ack,
    t_cmd_drawn_ms: sc.t_cmd_drawn,
    t_scenario_ms: sc.t_scenario,
    t_scenario_wall_ms: sc.t_scenario_wall,
    probe_overrun_ms: sc.probe_overrun_ms ?? null,
    // COLUMNS.md: bytes_in — К клиенту (шейпер bytesOut), bytes_out — ОТ клиента (шейпер bytesIn)
    bytes_in: s ? s.bytesOut : null,
    bytes_out: s ? s.bytesIn : null,
    // Разложение обмена по маршрутам шейпера (`stats.byRoute`): статика сборки — ПОАДАПТЕРНАЯ
    // КОНСТАНТА (H ≈260 кБ, Q ≈291 кБ, Z ≈573 кБ), а не данные документа, поэтому отношения P/F,
    // посчитанные по полному `bytes_in`, смещены по-разному у разных адаптеров (DEVIATIONS §3.1
    // требует её вычитать). Данными является `bytes_in_api + bytes_in_zero`.
    bytes_in_api: routeBytes('/api', 'bytesOut'),
    bytes_in_zero: routeBytes('/zero', 'bytesOut'),
    bytes_in_static: routeBytes('/', 'bytesOut'),
    bytes_in_other: routeBytes('(none)', 'bytesOut'),
    bytes_out_api: routeBytes('/api', 'bytesIn'),
    bytes_out_zero: routeBytes('/zero', 'bytesIn'),
    bytes_out_static: routeBytes('/', 'bytesIn'),
    bytes_out_other: routeBytes('(none)', 'bytesIn'),
    // сходимость разложения: Σ по маршрутам − итог (обязан быть 0; иначе часть байтов не отнесена)
    bytes_in_route_residual: routeResidual('bytesOut', s ? s.bytesOut : null),
    bytes_out_route_residual: routeResidual('bytesIn', s ? s.bytesIn : null),
    cdp_bytes_in: rec.cdp?.bytesIn ?? null,
    js_heap_peak_mb: toMb(sc.js_heap_peak_mib),
    js_heap_end_mb: toMb(sc.js_heap_end_mib),
    // Пик частной памяти Chromium публикуется ДВАЖДЫ: `*_excl_probe_mib` — по выборкам вне окон
    // измерительных проб самой оболочки (сравнимая между адаптерами величина), `*_raw_mib` — сырой.
    // `chromium_private_peak_mib` оставлен как сырой ради совместимости схемы; головные таблицы
    // считаются по `chromium_private_peak_excl_probe_mib`.
    chromium_private_peak_mib: rec.chromium?.private_peak_mib ?? null,
    chromium_private_peak_raw_mib: rec.chromium?.private_peak_mib ?? null,
    chromium_private_peak_excl_probe_mib: rec.chromium?.private_peak_excl_probe_mib ?? null,
    chromium_probe_ticks: rec.chromium?.probe_ticks ?? null,
    chromium_samples: rec.chromium?.matched_ticks ?? null,
    chromium_private_end_mib: rec.chromium?.private_end_mib ?? null,
    client_storage_bytes: sc.client_storage_bytes ?? null,
    retained_pages_end: sc.retained_end?.pages ?? null,
    retained_shapes_end: sc.retained_end?.shapes ?? null,
    retained_pages_max: sc.steps?.length ? sc.retained_pages_max : null,
    retained_shapes_max: sc.steps?.length ? sc.retained_shapes_max : null,
    loaded_pages_end: sc.loaded_pages_end ?? null,
    server_api_cpu_ms: grp('api', 'cpu_ms'),
    server_api_mem_peak_mib: grp('api', 'mem_peak_mib'),
    server_api_mem_peak_excl_probe_mib: grp('api', 'mem_peak_excl_probe_mib'),
    server_api_mem_integral_mib_s: grp('api', 'mem_integral_mib_s'),
    server_pg_cpu_ms: grp('pg', 'cpu_ms'),
    server_pg_mem_peak_mib: grp('pg', 'mem_peak_mib'),
    server_pg_mem_peak_excl_probe_mib: grp('pg', 'mem_peak_excl_probe_mib'),
    server_pg_mem_integral_mib_s: grp('pg', 'mem_integral_mib_s'),
    server_zero_cpu_ms: grp('zero', 'cpu_ms'),
    server_zero_mem_peak_mib: grp('zero', 'mem_peak_mib'),
    server_zero_mem_peak_excl_probe_mib: grp('zero', 'mem_peak_excl_probe_mib'),
    server_zero_mem_integral_mib_s: grp('zero', 'mem_integral_mib_s'),
    zero_replica_bytes: g.zero ? (g.zero.disk_end_bytes ?? 0) : null,
    // «сэмплировано, но не относится к бюджету этого адаптера» ≠ «не применимо»: в прогонах H/Q
    // zero-cache работает и его расход измерен (фон), просто он не часть их серверного бюджета
    server_zero_applicable: applicable('zero'),
    within_budget_first: sc.budgets?.firstReady ?? null,
    within_budget_nav: sc.budgets?.navAll ?? null,
    within_budget_cmd: sc.budgets?.cmdDrawn ?? null,
    within_budget_scenario: sc.budgets?.scenario ?? null,
    reference_ok: rec.reference_ok ?? null,
    doc_pages: rec.doc_pages ?? null,
    doc_shapes_per_page: rec.doc_shapes_per_page ?? null,
    rtt_ms: rec.shaper?.config ? 2 * rec.shaper.config.delayMs : null,
    bandwidth_mbps: rec.shaper?.config?.bandwidthMbit ?? null,
    seed: rec.seed,
    finished_at: rec.finished_at,
    // переносы строк схлопываем: `readCsvRunIds` (resume) читает CSV построчно, и многострочная
    // ячейка дала бы лишние строки и мусорные run_id в множестве уже выполненных прогонов
    error_message: String(rec.error_message ?? '').replace(/\r?\n/g, ' | '),
    notes: rec.notes ?? '',
    // идентичность измерительной оболочки (passport.harness.harnessIdShort): серии с разным
    // значением сняты РАЗНЫМИ версиями оболочки и абсолютными величинами не сопоставимы
    harness_id: rec.harness_id ?? '',
    wall_ms: rec.wall_ms,
    browser_launch_ms: rec.browser_launch_ms,
    cdp_bytes_out: rec.cdp?.bytesOut ?? null,
    cdp_ws_bytes_in: rec.cdp?.wsIn ?? null,
    cdp_ws_bytes_out: rec.cdp?.wsOut ?? null,
    shaper_requests: s?.requests ?? null,
    shaper_connections: s?.connections ?? null,
    cmd_revision: sc.command?.result?.revision ?? null,
    cmd_affected_pages: sc.command?.result?.affectedPages?.length ?? null,
    cmd_affected_shapes: sc.command?.result?.affectedShapes ?? null,
    server_api_rss_peak_mib: grp('api', 'rss_peak_mib'),
    server_pg_rss_peak_mib: grp('pg', 'rss_peak_mib'),
    server_zero_rss_peak_mib: grp('zero', 'rss_peak_mib'),
    chromium_processes_peak: rec.chromium?.processes_peak ?? null,
    client_transfer_bytes_in: sc.transfer?.bytesIn ?? null,
    client_transfer_bytes_out: sc.transfer?.bytesOut ?? null,
    // разложение команды по моментам (§1.8): подтверждение транспорта, появление данных, цена ack
    t_cmd_server_ms: Number.isFinite(sc.t_cmd_server) ? sc.t_cmd_server : null,
    t_cmd_synced_ms: Number.isFinite(sc.t_cmd_synced) ? sc.t_cmd_synced : null,
    t_cmd_opget_ms: Number.isFinite(sc.t_cmd_opget) ? sc.t_cmd_opget : null,
    cmd_drawn_before_ack: sc.command?.drawnBeforeAck ?? null,
    t_scenario_model_ms: Number.isFinite(sc.t_scenario_model) ? sc.t_scenario_model : null,
    t_scenario_model_residual_ms: Number.isFinite(sc.t_scenario_model_residual) ? sc.t_scenario_model_residual : null,
    probe_total_ms: sc.probe_total_ms ?? null,
    retained_probe_mode: sc.retained_probe?.mode ?? null,
    retained_pages_end_exact: sc.retained_end_exact?.pages ?? null,
    retained_shapes_end_exact: sc.retained_end_exact?.shapes ?? null,
    js_heap_samples: sc.heap_sampler?.samples ?? null,
    js_heap_sample_interval_ms: sc.heap_sampler?.interval_ms ?? null,
    // паритет давления сборщика мусора (N2): одинаковое расписание → одинаковое число вызовов
    js_heap_gc_count: sc.gc?.forced ?? null,
    js_heap_post_gc_mb: toMb(sc.js_heap_post_gc_mib),
    js_heap_suspended_ms: sc.heap_sampler?.suspended_ms ?? null,
    // покрытие сэмплера кучи (samples × interval / t_scenario_wall): пик кучи сравним между
    // адаптерами только вместе с ним — окна приостановки у Z длиннее (дефект «разная длительность»)
    js_heap_sampler_coverage: sc.heap_sampler?.coverage ?? null,
    // окна измерительных проб оболочки: те же, на которых приостановлен сэмплер кучи; выборки
    // сэмплеров /proc внутри них помечены и исключены из `*_excl_probe_*`
    probe_window_count: rec.probe_windows?.count ?? null,
    probe_window_ms: rec.probe_windows?.total_ms ?? null,
    // честность сэмплирования: сэмплеры без процессов (`имя`), частично покрытые (`имя:partial`)
    // и неприменимые к адаптеру, но отсутствовавшие (`имя:absent`)
    sampling_incomplete: (rec.sampling?.unmatched ?? []).join('|'),
    sampling_ticks: ticks,
    server_disk_used_bytes: rec.server_disk?.total_bytes ?? null,
    // маршрут произвольной длины: колонок t_nav_1..10 хватает только маршруту §7.2
    route_len: Array.isArray(sc.route) ? sc.route.length : null,
    route_distinct_pages: Array.isArray(sc.route) ? new Set([1, ...sc.route]).size : null,
    t_nav_count: Array.isArray(sc.t_nav) ? sc.t_nav.length : null,
    t_nav_new_count: Array.isArray(sc.t_nav_new) ? sc.t_nav_new.length : null,
    t_nav_return_count: Array.isArray(sc.t_nav_return) ? sc.t_nav_return.length : null,
    t_nav_median_ms: median(sc.t_nav ?? []),
    t_nav_ms_list: Array.isArray(sc.t_nav) ? sc.t_nav.map((/** @type {number} */ v) => (Number.isFinite(v) ? v.toFixed(1) : '')).join('|') : null,
    // повторное чтение: промахи окна кеша (одинаково наблюдаемо у H/Q/Z) и HTTP-чтения страниц
    // (у Z их нет вовсе: страницы приходят синхронизацией — это и есть измеряемое различие)
    nav_cache_hits: sc.nav_cache_hits ?? null,
    nav_cache_misses: sc.nav_cache_misses ?? null,
    page_loads_observed: Number.isFinite(sc.nav_cache_misses) ? sc.nav_cache_misses + 1 : null,
    api_page_reads: sc.page_reads?.total ?? null,
    api_page_reads_distinct: sc.page_reads?.distinct_pages ?? null,
    api_page_read_bytes: sc.page_reads?.bytes ?? null,
    cmd_variant: rec.command?.variant ?? '',
    cmd_target_id: rec.command?.targetId ?? '',
  };
  for (let i = 1; i <= 10; i++) row[`t_nav_${i}_ms`] = sc.t_nav?.[i - 1];
  return row;
}

/**
 * @typedef {object} RunnerOptions
 * @property {string} outDir                      корень results/
 * @property {boolean} [dryRun]
 * @property {number} [repetitions]
 * @property {string|null} [only]
 * @property {boolean} [resume]                   по умолчанию true
 * @property {(msg: string) => void} [log]
 * @property {boolean} [verbose]
 * @property {(page: import('playwright').Page, opts: any) => Promise<any>} [scenarioFn]   подмена для тестов
 * @property {string|null} [progressFile]         JSON-файл прогресса (серия, прогон N/всего, ETA, последний исход) — обновляется после каждого прогона
 * @property {Record<string, unknown>} [progressExtra]   дополнительные поля в файл прогресса (например, план всех серий оркестратора)
 */

/**
 * @param {SeriesConfig} series
 * @param {RunnerOptions} opts
 */
export async function runSeries(series, opts) {
  const log = opts.log ?? ((m) => process.stderr.write(m + '\n'));
  const vlog = opts.verbose ? log : () => {};
  const baseUrl = series.baseUrl ?? 'http://127.0.0.1:8080';
  const apiUrl = series.api?.url ?? 'http://127.0.0.1:3000';
  const apiLogin = series.api?.login ?? 'alice';
  // пароль НЕ берётся из конфигурации серии (он попал бы в паспорт): только из среды/test-users.mjs.
  // Ключ `api.password` в файле серии больше не поддерживается и игнорируется.
  const apiPassword = passwordFor(apiLogin) ?? '';
  const statsUrl = series.shaper.statsUrl ?? 'http://127.0.0.1:8081';
  /** @type {{delayMs: number, bandwidthMbit: number, bucketMs?: number, handshakeRtt: boolean}} */
  const shaperCfg = {
    delayMs: series.shaper.delayMs,
    bandwidthMbit: series.shaper.bandwidthMbit,
    ...(series.shaper.bucketMs !== undefined ? { bucketMs: series.shaper.bucketMs } : {}),
    // Эмуляция TCP-рукопожатия выставляется ПЕРЕД КАЖДЫМ прогоном, как delay и полоса: без неё
    // новое соединение бесплатно, и H/Q (≈8 соединений в F) получают преимущество перед одним
    // WebSocket у Z (дефект A6/B22). Выключить можно только явным `"handshakeRtt": false` в серии.
    handshakeRtt: series.shaper.handshakeRtt ?? true,
  };
  const procGroups = resolveGroupPaths(series.procGroups ?? DEFAULT_PROC_GROUPS, ROOT_DIR);
  const docJson = series.docJson ? path.resolve(ROOT_DIR, series.docJson) : '';
  const browserCfg = { channel: 'chromium', args: ['--disable-extensions'], headless: true, viewport: { width: 1280, height: 800 }, ...(series.browser ?? {}) };
  const scenarioCfg = series.scenario ?? {};
  const cooldownMs = series.cooldownMs ?? 1000;
  const maxConsecutiveErrors = series.maxConsecutiveErrors ?? 5;
  const scenarioFn = opts.scenarioFn ?? runAcceptanceScenario;

  const seriesDir = path.join(opts.outDir, series.name);
  const runsDir = path.join(seriesDir, 'runs');
  const csvFile = path.join(seriesDir, 'runs.csv');
  const passportFile = path.join(seriesDir, 'passport.json');

  // `variants` (серия command-shape) разворачиваются в конфигурации ДО построения плана:
  // перемешивание повторения идёт по всему списку «конфигурация × вариант».
  const planSeries = { ...series, configs: expandConfigs(series) };
  const fullPlan = buildPlan(planSeries, { repetitions: opts.repetitions });
  const plan = filterPlan(fullPlan, opts.only);
  const resume = opts.resume ?? true;
  const done = resume ? readCsvRunIds(csvFile) : new Set();
  if (resume && fs.existsSync(runsDir)) for (const f of fs.readdirSync(runsDir)) if (f.endsWith('.json')) done.add(f.slice(0, -5));
  const pending = plan.filter((p) => !done.has(p.run_id));

  log(`series "${series.name}": ${fullPlan.length} runs planned (${planSeries.configs.length} configs × ${opts.repetitions ?? series.repetitions} reps, seed ${series.seed})` + (opts.only ? `, filter --only ${opts.only} → ${plan.length}` : '') + `, ${plan.length - pending.length} already done, ${pending.length} to run`);

  if (opts.dryRun) {
    for (const p of plan) log(`  ${String(p.order_index).padStart(4)}  rep ${String(p.repetition).padStart(2)}  ${configKey(p.config).padEnd(7)}  ${p.run_id}  ${done.has(p.run_id) ? 'done' : 'pending'}`);
    log('process groups matched right now (server samplers):');
    for (const [name, procs] of Object.entries(resolveGroups(procGroups))) {
      log(`  ${name}: ${procs.length ? '' : '(none)'}`);
      for (const pr of procs) log(`    ${pr.pid}  ${pr.cmdline}`);
    }
    return { plan, pending, executed: [], seriesDir };
  }

  fs.mkdirSync(runsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  if (pending.length && procGroups.length) {
    // какие процессы сейчас попадают в серверные группы — пустая группа api/pg почти наверняка означает неверный pidfile/паттерн
    for (const [name, procs] of Object.entries(resolveGroups(procGroups))) {
      const spec = procGroups.find((g) => g.name === name);
      const scoped = spec?.adapters ? ` (в бюджет входит только у ${spec.adapters.join('/')}, в остальных прогонах — измеренный фон)` : '';
      log(`  proc group ${name}: ${procs.length} process(es)${procs.length ? ` — pids ${procs.map((p) => p.pid).join(',')}${scoped}` : ' — WARNING: nothing matched, метрики группы будут пустыми (не 0)'}`);
      vlog(procs.map((p) => `    ${p.pid}  ${p.cmdline}`).join('\n'));
    }
  }

  // Параметры шейпера для паспорта берём из самого шейпера (GET /config: delayMs, bandwidthMbit, bucketMs, bucketBytes,
  // segmentBytes, handshakeRtt) ПОСЛЕ установки параметров серии; значения до серии запоминаем и восстанавливаем в конце
  // (серия rtt150 меняет delayMs; остальные — нет).
  /** @type {any} */
  let shaperInitial = null;
  /** @type {any} */
  let shaperEffective = null;
  if (pending.length) {
    try {
      shaperInitial = await httpJson(`${statsUrl}/config`);
      const r = await httpJson(`${statsUrl}/config`, { method: 'POST', body: shaperCfg });
      shaperEffective = r.config ?? null;
      log(`  shaper ${statsUrl}: delay ${shaperEffective?.delayMs} ms/way, ${shaperEffective?.bandwidthMbit} Mbit/s, bucket ${shaperEffective?.bucketMs} ms (≈${shaperEffective?.bucketBytes ?? '?'} B), handshake-rtt ${shaperEffective?.handshakeRtt}` + (shaperInitial && shaperInitial.delayMs !== shaperEffective?.delayMs ? ` — was ${shaperInitial.delayMs} ms, will be restored after the series` : ''));
    } catch (err) {
      log(`  WARNING: shaper ${statsUrl} unreachable (${/** @type {any} */ (err)?.message}); passport.shaper.effective = null`);
    }
  }
  /** @type {any} */
  let passport = buildPassport({
    rootDir: ROOT_DIR,
    series,
    shaper: { ...shaperCfg, statsUrl, effective: shaperEffective, beforeSeries: shaperInitial },
    startedAt,
    extra: { procGroups, browser: browserCfg, scenario: { route: scenarioCfg.route ?? DEFAULT_ROUTE, pauseMs: scenarioCfg.pauseMs ?? 1000, budgets: { ...DEFAULT_BUDGETS, ...(scenarioCfg.budgets ?? {}) } }, plan: fullPlan.map((p) => ({ run_id: p.run_id, order_index: p.order_index, repetition: p.repetition, ...p.config })) },
  });
  /** @type {any} */
  let prevPassport = null;
  if (fs.existsSync(passportFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(passportFile, 'utf8'));
      prevPassport = prev;
      passport = { ...passport, startedAt: prev.startedAt ?? startedAt, resumedAt: startedAt, versions: { ...passport.versions, chromium: prev.versions?.chromium ?? null } };
      if (!shaperEffective && prev.shaper?.effective) passport.shaper = { ...passport.shaper, effective: prev.shaper.effective, beforeSeries: prev.shaper.beforeSeries ?? null };
    } catch {
      /* перезапишем */
    }
  }
  const writePassport = () => fs.writeFileSync(passportFile, JSON.stringify(passport, null, 2) + '\n');
  // Ключи §2.1 docs/PASSPORT.md, требующие внешних источников: настройки адаптеров (из сборки
  // клиента), список файлов dist + buildId, logLevel API, конфигурация zero-cache, предсерийные
  // проверки, идентификатор кода. Пишутся ДО первого прогона, чтобы паспорт был полон и у
  // прерванной серии; ошибки источника дают `{available:false, reason}`, а не отсутствие ключа.
  try {
    await completePassport(passport, {
      rootDir: ROOT_DIR,
      apiUrl,
      seriesDir,
      adapters: [...new Set(series.configs.map((c) => c.adapter))],
      procGroups,
      diskDirs: serverDiskDirs(series, procGroups),
      // идентичность оболочки: sha256 по packages/bench/src/**, packages/netshaper/src/**,
      // конфигурации серии и набору колонок CSV — по нему серии проверяются на сопоставимость
      columns: COLUMNS,
    });
    if (passport.api?.logLevel && passport.api.logLevel !== 'warn') log(`  WARNING: API logLevel=${passport.api.logLevel} (серии требуют warn, DEVIATIONS 4.1) — записано в паспорт`);
    if (!passport.adapters?.available) log(`  WARNING: passport.adapters: ${passport.adapters?.reason}`);
    if (!passport.preSeriesChecks?.samplers?.ok) log('  WARNING: preSeriesChecks: есть пустая группа процессов — см. passport.preSeriesChecks');
  } catch (err) {
    log(`  WARNING: не удалось дополнить паспорт (§2.1): ${/** @type {any} */ (err)?.message}`);
  }
  writePassport();
  // тот же идентификатор — в КАЖДУЮ строку runs.csv (колонка harness_id): серия, снятая другой
  // версией оболочки, видна прямо в сырых данных, без обращения к паспорту
  const harnessIdShort = passport.harness?.harnessIdShort ?? null;
  if (harnessIdShort) log(`  harness ${harnessIdShort} (bench ${String(passport.harness.benchSrcSha256).slice(0, 8)}, columns ${passport.harness.columnCount})`);

  /** @type {any[]} */
  const executed = [];
  let consecutiveErrors = 0;
  const seriesWall0 = performance.now();
  /** @type {number[]} */
  const wallHistory = [];
  const writeProgress = (/** @type {Record<string, unknown>} */ patch) => {
    if (!opts.progressFile) return;
    const doneNow = plan.length - pending.length + executed.length;
    const avgWall = wallHistory.length ? wallHistory.reduce((a, b) => a + b, 0) / wallHistory.length : null;
    const remaining = pending.length - executed.length;
    const body = {
      updatedAt: new Date().toISOString(),
      series: series.name,
      seriesDir,
      run_done: doneNow,
      run_total: plan.length,
      run_pending: remaining,
      avg_run_wall_ms: avgWall ? Math.round(avgWall) : null,
      eta_seconds: avgWall ? Math.round((remaining * (avgWall + cooldownMs)) / 1000) : null,
      eta_at: avgWall ? new Date(Date.now() + remaining * (avgWall + cooldownMs)).toISOString() : null,
      elapsed_seconds: Math.round((performance.now() - seriesWall0) / 1000),
      ...(opts.progressExtra ?? {}),
      ...patch,
    };
    try {
      fs.mkdirSync(path.dirname(opts.progressFile), { recursive: true });
      fs.writeFileSync(opts.progressFile + '.tmp', JSON.stringify(body, null, 2) + '\n');
      fs.renameSync(opts.progressFile + '.tmp', opts.progressFile);
    } catch {
      /* прогресс — best effort */
    }
  };
  writeProgress({ status: pending.length ? 'running' : 'done', current_run: pending[0]?.run_id ?? null, last_outcome: null });

  for (const p of pending) {
    const runStartedAt = new Date().toISOString();
    const wall0 = performance.now();
    log(`▶ ${p.run_id} (rep ${p.repetition}, order ${p.order_index}, ${configKey(p.config)})`);
    writeProgress({ status: 'running', current_run: p.run_id, current_started_at: runStartedAt });
    /** @type {any} */
    const rec = {
      run_id: p.run_id,
      series: series.name,
      adapter: p.config.adapter,
      mode: p.config.mode,
      cache: p.config.cache,
      doc: series.doc,
      repetition: p.repetition,
      order_index: p.order_index,
      seed: series.seed,
      started_at: runStartedAt,
      finished_at: null,
      outcome: 'ok',
      error_stage: null,
      error_message: null,
      doc_pages: series.docPages ?? null,
      doc_shapes_per_page: series.docShapesPerPage ?? null,
      notes: series.notes ?? '',
      harness_id: harnessIdShort,
      // команда прогона: вариант серии (`variants[]`) перекрывает источник и цвет серии
      variant: p.config.variant ?? null,
      command: { type: 'setSourceFill', targetId: p.config.sourceId ?? series.sourceId, fill: p.config.fill ?? series.fill, ...(p.config.variant ? { variant: p.config.variant } : {}) },
      preflight: /** @type {any} */ ({}),
      shaper: /** @type {any} */ ({ config: shaperEffective ?? shaperCfg, stats: null }),
      browser_launch_ms: null,
      browser_version: null,
      scenario: null,
      cdp: null,
      chromium: null,
      probe_windows: null,
      server: null,
      serverGroupsConfigured: procGroups.length > 0,
      procGroups: procGroups.map((gspec) => ({ name: gspec.name, adapters: gspec.adapters ?? null })),
      reference_ok: null,
      wall_ms: null,
    };
    /** @param {string} stage @param {unknown} err */
    const fail = (stage, err) => {
      if (rec.outcome === 'ok') {
        rec.outcome = 'error';
        rec.error_stage = stage;
        rec.error_message = String(/** @type {any} */ (err)?.message ?? err).slice(0, 1000);
      }
      log(`  ✖ ${stage}: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}`);
    };

    // ---- preflight: reset документа, resetCommand, шейпер --------------------------------
    try {
      const login = await httpJson(`${apiUrl}/api/auth/login`, { method: 'POST', body: { login: apiLogin, password: apiPassword } });
      rec.preflight.login = { userId: login.userId, expiresIn: login.expiresIn };
      const reset = await httpJson(`${apiUrl}/api/test/reset`, { method: 'POST', body: { docId: series.doc }, token: login.token, timeoutMs: 60_000, headers: testHookHeaders(ROOT_DIR) });
      rec.preflight.reset = reset;
      // §1.7 / критик 3 п. 15: у конфигураций Z клиент читает РЕПЛИКУ, а сброс документа идёт в
      // PostgreSQL. Пока логическая репликация не догнала, свежесброшенный документ виден клиенту
      // в СТАРОЙ ревизии, и команда падает с revision_mismatch (артефакт воспроизводится при
      // посторонней нагрузке на кластер). Ждём подтверждения слота, а не «секунду на всякий
      // случай»; ожидание записывается в прогон и не может сделать прогон ошибочным.
      if (p.config.adapter === 'Z') rec.preflight.replicaWait = await waitForReplica({ log: vlog });
      if (series.resetCommand) {
        const t = performance.now();
        execSync(series.resetCommand, { cwd: ROOT_DIR, stdio: opts.verbose ? 'inherit' : 'ignore', env: { ...process.env, STAND_RUN_ID: p.run_id, STAND_DOC: series.doc, STAND_DOC_JSON: docJson, STAND_API_URL: apiUrl, STAND_ADAPTER: p.config.adapter, STAND_MODE: p.config.mode, STAND_CACHE: String(p.config.cache) }, timeout: 120_000 });
        rec.preflight.resetCommandMs = Math.round(performance.now() - t);
      }
      // параметры канала выставляются перед КАЖДЫМ прогоном (страховка от чужой смены), счётчики обнуляются
      const cfg = await httpJson(`${statsUrl}/config`, { method: 'POST', body: shaperCfg });
      rec.shaper.config = cfg.config ?? shaperCfg;
      await httpJson(`${statsUrl}/reset`, { method: 'POST' });
    } catch (err) {
      fail('preflight', err);
    }

    // ---- браузер + сэмплеры + сценарий -------------------------------------------------------
    /** @type {import('playwright').Browser | null} */
    let browser = null;
    /** @type {import('playwright').BrowserContext | null} */
    let context = null;
    /** @type {ReturnType<typeof startProcSampler> | null} */
    let procSampler = null;
    /** @type {ReturnType<typeof startChromiumSampler> | null} */
    let chromeSampler = null;
    /** @type {ReturnType<typeof createProbeWindows> | null} */
    let probeWindows = null;
    /** @type {Awaited<ReturnType<typeof attachCdp>> | null} */
    let cdp = null;
    /** @type {import('../sampling/procs.mjs').ProcGroupSpec[]} */
    let runGroups = [];
    if (rec.outcome === 'ok') {
      try {
        const t = performance.now();
        const marker = `--stand-run=${p.run_id}`; // уникальный ключ для поиска процесса в /proc (fallback)
        browser = await chromium.launch({ headless: browserCfg.headless, channel: browserCfg.channel ?? undefined, args: [...(browserCfg.args ?? []), marker] });
        rec.browser_launch_ms = Math.round(performance.now() - t);
        rec.browser_version = browser.version();
        if (!passport.versions.chromium) {
          passport.versions.chromium = rec.browser_version;
          writePassport();
        }
        context = await browser.newContext({ viewport: browserCfg.viewport });
        const page = await context.newPage();
        cdp = await attachCdp(page);
        const cdpRef = cdp;
        // Сэмплируются ВСЕ объявленные группы в КАЖДОМ прогоне (§1.2: серверный бюджет виден целиком).
        // zero-cache работает и в прогонах H/Q, поэтому его расход измеряется и там — как фон
        // компонента, нужного только профилю Z (`adapters` теперь означает не «сэмплировать только
        // для них», а «относится к бюджету этих адаптеров»: колонка server_zero_applicable).
        runGroups = procGroups;
        // Реестр окон измерительных проб инструмента — ОДИН на прогон и общий для всех сэмплеров
        // (сэмплер кучи в сценарии, /proc-сэмплеры Chromium и серверных групп): политика
        // «выборка внутри пробы не считается измерением адаптера» одинакова у всех адаптеров.
        probeWindows = createProbeWindows();
        if (runGroups.length) procSampler = startProcSampler({ groups: runGroups, intervalMs: 250, probeWindows });
        chromeSampler = startChromiumSampler(browser, { intervalMs: 250, marker, probeWindows });
        rec.scenario = await scenarioFn(page, {
          baseUrl,
          adapter: p.config.adapter,
          mode: p.config.mode,
          cache: p.config.cache,
          doc: series.doc,
          sourceId: p.config.sourceId ?? series.sourceId,
          fill: p.config.fill ?? series.fill,
          autologin: scenarioCfg.autologin ?? 'alice',
          route: scenarioCfg.route,
          pauseMs: scenarioCfg.pauseMs,
          cmdAfterStep: scenarioCfg.cmdAfterStep,
          stepTimeoutMs: scenarioCfg.stepTimeoutMs,
          budgets: scenarioCfg.budgets,
          extraQuery: scenarioCfg.extraQuery,
          // gc — сборка мусора по фиксированному расписанию, одинаковому для всех адаптеров (см. makeGc);
          // net — счётчики CDP (в т. ч. HTTP-чтения страниц) читаются в процессе оболочки, без обращения к странице
          probes: { heap: cdp.heap, gc: makeGc(cdp.cdp), net: () => cdpRef.network() },
          probeWindows,
          log: vlog,
        });
        if (rec.scenario.outcome !== 'ok') {
          rec.outcome = rec.scenario.outcome;
          rec.error_stage = rec.scenario.errorStage;
          rec.error_message = rec.scenario.errorMessage;
        }
      } catch (err) {
        fail('browser', err);
      }
    }
    // ---- остановка сэмплеров ДО закрытия браузера, статистика шейпера, закрытие ------------
    try {
      if (chromeSampler) rec.chromium = chromeSampler.stop();
      if (procSampler) rec.server = procSampler.stop();
      // окна проб инструмента (см. sampling/probe-windows.mjs) — в запись прогона целиком:
      // по ним и по `samples[]` пик без пробы пересчитывается извне
      if (probeWindows) rec.probe_windows = probeWindows.summary();
      if (cdp) {
        rec.cdp = cdp.network();
        await cdp.detach();
      }
    } catch (err) {
      fail('samplers', err);
    }
    // ---- честность сэмплирования (§7.3; критик B, п. 15) ----------------------------------
    // Сэмплер, не нашедший ни одного процесса, даёт не «ноль ресурсов», а ОТСУТСТВИЕ измерения:
    // такие колонки пишутся пустыми (flattenRun), прогон помечается sampling_incomplete, а если
    // не измерена существенная величина (память Chromium; API или PostgreSQL в любом прогоне;
    // zero-cache в прогоне Z) — прогон учитывается как ошибочный, а не как результат.
    if (chromeSampler || runGroups.length) {
      const unmatched = [];
      const essentialMissing = [];
      /** @type {Record<string, unknown>} */
      const detail = {};
      if (chromeSampler) {
        const ok = rec.chromium?.matched === true;
        const partial = rec.chromium?.partial === true;
        detail.chromium = { matched: ok, partial, coverage: rec.chromium?.coverage ?? null, matched_ticks: rec.chromium?.matched_ticks ?? null, expected_ticks: rec.chromium?.expected_ticks ?? null, reason: rec.chromium?.unmatched_reason ?? null };
        if (!ok) {
          unmatched.push('chromium');
          essentialMissing.push(`chromium (${rec.chromium?.unmatched_reason ?? 'нет сводки сэмплера'})`);
        } else if (partial) {
          // частичная выборка — это не измерение группы, а его огрызок: пик занижен (дефект N6)
          unmatched.push('chromium:partial');
          essentialMissing.push(`chromium (${rec.chromium?.unmatched_reason})`);
        }
      }
      for (const spec of runGroups) {
        const summary = rec.server?.[spec.name];
        const ok = summary ? summary.matched === true : false;
        const partial = summary?.partial === true;
        // Существенность: api/pg — в любом прогоне; группа с `adapters` (zero-cache) существенна
        // только там, где она входит в бюджет адаптера. В остальных прогонах она всё равно
        // СЭМПЛИРУЕТСЯ (§1.2) и публикуется как измеренный фон, а её отсутствие — не ошибка
        // прогона, но и не ноль: колонки пустые + отметка в sampling_incomplete.
        const applicable = !spec.adapters || spec.adapters.includes(p.config.adapter);
        const essential = spec.essential ?? (['api', 'pg'].includes(spec.name) || (spec.name === 'zero' && applicable));
        detail[spec.name] = { matched: ok, partial, applicable, essential, coverage: summary?.coverage ?? null, matched_ticks: summary?.matched_ticks ?? null, expected_ticks: summary?.expected_ticks ?? null, reason: summary?.unmatched_reason ?? (summary ? null : 'сэмплер не отдал сводку группы') };
        if (!ok) {
          unmatched.push(applicable ? spec.name : `${spec.name}:absent`);
          if (essential) essentialMissing.push(`${spec.name} (${summary?.unmatched_reason ?? 'сэмплер не отдал сводку группы'})`);
        } else if (partial) {
          unmatched.push(`${spec.name}:partial`);
          if (essential) essentialMissing.push(`${spec.name} (${summary?.unmatched_reason})`);
        }
      }
      rec.sampling = { groups: detail, unmatched, essentialMissing, chromium_matched: rec.chromium?.matched ?? null };
      if (essentialMissing.length) {
        fail('sampling', new Error(`не измерены обязательные ресурсы: ${essentialMissing.join('; ')} — прогон непригоден как измерение`));
      } else if (unmatched.length) {
        log(`  ! sampling_incomplete: ${unmatched.join(', ')} — соответствующие колонки пусты, а не 0`);
      }
    }
    // ---- диск серверной части (§1.7): каталог данных PostgreSQL + реплика zero-cache ---------
    try {
      const dirs = serverDiskDirs(series, procGroups);
      /** @type {Record<string, number>} */
      const per = {};
      let total = 0;
      for (const d of dirs) {
        const b = dirSizeBytes(d);
        per[d] = b;
        total += b;
      }
      rec.server_disk = { dirs: per, total_bytes: total, budget_bytes: 40 * 1024 ** 3 };
    } catch (err) {
      vlog(`  server disk: ${/** @type {any} */ (err)?.message}`);
    }
    try {
      // дать «хвосту» задержанного канала дойти (≤ RTT), затем снять счётчики
      await sleep(2 * shaperCfg.delayMs + 20);
      rec.shaper.stats = await httpJson(`${statsUrl}/stats`);
    } catch (err) {
      fail('shaper-stats', err);
    }
    try {
      if (context) await withTimeout(context.close(), 10_000);
      if (browser) await withTimeout(browser.close(), 10_000);
    } catch (err) {
      vlog(`  browser close: ${/** @type {any} */ (err)?.message}`);
    }
    if (browser && browser.isConnected()) {
      // браузер не закрылся штатно — добиваем процесс, чтобы следующий прогон был чистым
      const pid = browserPid(browser);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* уже нет */
        }
      }
    }

    // ---- запись результата + опциональная проверка эталона -------------------------------
    rec.wall_ms = Math.round(performance.now() - wall0);
    rec.finished_at = new Date().toISOString();
    const runFile = path.join(runsDir, `${p.run_id}.json`);
    // steps в корне записи — для анализа (COLUMNS.md, per-run JSON)
    rec.steps = rec.scenario?.steps ?? [];
    rec.snapshots = rec.scenario?.snapshots ?? {};
    // Снимки посещений (по 500 фигур каждый) уходят файлами эталону, а в runs/<run_id>.json не
    // кладутся: иначе запись прогона вырастала бы вдвое (≈1 МБ) без пользы для анализа.
    // Сам журнал посещений (`scenario.visits`, лёгкий) в записи остаётся.
    const visitSnapshots = rec.scenario?.visitSnapshots ?? [];
    if (rec.scenario) delete rec.scenario.visitSnapshots;
    fs.writeFileSync(runFile, JSON.stringify(rec, null, 2) + '\n');
    if (series.referenceCommand) {
      // входы эталона: команды прогона (с фактическим opId) и снимки страниц клиента — по файлу на страницу
      const refDir = path.join(seriesDir, 'reference', p.run_id);
      const refInputs = writeReferenceInputs(refDir, rec, { docPages: series.docPages ?? null, visitSnapshots });
      rec.reference = { dir: refDir, ...refInputs, ok: null, log: null };
      const refLog = path.join(refDir, 'reference.log');
      if (refInputs.problem) {
        // Сверка без обязательных снимков невозможна. Прогон, дошедший до конца, но не давший
        // снимков, — ошибочный (reference_ok=false); у уже упавшего прогона сверка просто не
        // измерялась (пусто). Молчаливый `reference_ok=true` на нуле снимков исключён.
        const alreadyFailed = rec.outcome !== 'ok';
        rec.reference_ok = alreadyFailed ? null : false;
        rec.reference.ok = rec.reference_ok;
        rec.reference.log = `reference inputs incomplete: ${refInputs.problem}`;
        fail('reference_inputs', new Error(refInputs.problem));
        fs.writeFileSync(runFile, JSON.stringify(rec, null, 2) + '\n');
        appendCsvRow(csvFile, flattenRun(rec), COLUMNS);
        executed.push(rec);
        wallHistory.push(performance.now() - wall0);
        writeProgress({ status: 'running', current_run: null, last_run: p.run_id, last_outcome: rec.outcome, last_reference_ok: rec.reference_ok, last_error_stage: rec.error_stage ?? null });
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          log(`✖ ${consecutiveErrors} consecutive failed runs — aborting the series (resume later with the same command)`);
          break;
        }
        if (cooldownMs) await sleep(cooldownMs);
        continue;
      }
      try {
        execSync(series.referenceCommand, {
          cwd: ROOT_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          env: {
            ...process.env,
            STAND_RUN_JSON: runFile,
            STAND_RUN_ID: p.run_id,
            STAND_DOC: series.doc,
            STAND_DOC_JSON: docJson,
            STAND_SERIES_DIR: seriesDir,
            STAND_REF_DIR: refDir,
            STAND_RUN_COMMANDS: refInputs.commandsFile,
            STAND_RUN_SNAPSHOTS_DIR: refInputs.snapshotsDir,
            // журнал посещений (A11): без него reference-check.sh отвечает exit 5
            STAND_RUN_VISITS: refInputs.visitsFile,
            STAND_REQUIRE_PAGES: refInputs.requiredPages.join(','),
            STAND_API_URL: apiUrl,
            STAND_ADAPTER: p.config.adapter,
            STAND_MODE: p.config.mode,
            STAND_CACHE: String(p.config.cache),
          },
          timeout: 300_000,
        });
        rec.reference_ok = true;
        rec.reference.ok = true;
        if (fs.existsSync(refLog)) rec.reference.log = fs.readFileSync(refLog, 'utf8').slice(-4000);
      } catch (err) {
        const e = /** @type {any} */ (err);
        const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
        if (out) fs.writeFileSync(path.join(refDir, 'reference.stderr.log'), out);
        rec.reference.log = (fs.existsSync(refLog) ? fs.readFileSync(refLog, 'utf8') : out).slice(-4000);
        if (typeof e?.status === 'number') {
          rec.reference_ok = false;
          rec.reference.ok = false;
          log(`  ✖ reference: exit ${e.status}${out ? ' — ' + out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : ''}`);
        } else {
          rec.reference_ok = null;
          fail('reference', err);
        }
      }
      fs.writeFileSync(runFile, JSON.stringify(rec, null, 2) + '\n');
    }
    appendCsvRow(csvFile, flattenRun(rec), COLUMNS);
    executed.push(rec);
    // полное время прогона (с эталоном) — для ETA
    wallHistory.push(performance.now() - wall0);
    const sc = rec.scenario ?? {};
    log(
      `  ${rec.outcome === 'ok' ? '✔' : '✖'} ${rec.outcome}${rec.error_stage ? ` @${rec.error_stage}` : ''}: first ${fmt(sc.t_first_ready)} ms, nav med ${fmt(median(sc.t_nav ?? []))} ms, cmd ${fmt(sc.t_cmd_ack)}/${fmt(sc.t_cmd_drawn)} ms, scenario ${fmt(sc.t_scenario)} ms, ` +
        `↓${rec.shaper.stats?.bytesOut ?? '?'} ↑${rec.shaper.stats?.bytesIn ?? '?'} B, chromium ${rec.chromium?.private_peak_mib ?? '?'} MiB, retained ${sc.retained_end?.pages ?? '?'}/${sc.retained_end?.shapes ?? '?'}, ref ${rec.reference_ok ?? '—'}, wall ${rec.wall_ms} ms`,
    );
    writeProgress({ status: 'running', current_run: null, last_run: p.run_id, last_outcome: rec.outcome, last_reference_ok: rec.reference_ok, last_error_stage: rec.error_stage ?? null });
    consecutiveErrors = rec.outcome === 'ok' ? 0 : consecutiveErrors + 1;
    if (consecutiveErrors >= maxConsecutiveErrors) {
      log(`✖ ${consecutiveErrors} consecutive failed runs — aborting the series (resume later with the same command)`);
      break;
    }
    if (cooldownMs) await sleep(cooldownMs);
  }

  if (
    shaperInitial &&
    shaperEffective &&
    (shaperInitial.delayMs !== shaperEffective.delayMs ||
      shaperInitial.bandwidthMbit !== shaperEffective.bandwidthMbit ||
      shaperInitial.bucketMs !== shaperEffective.bucketMs ||
      // без этого контрольная подсерия с выключенным рукопожатием оставляла бы шейпер выключенным
      Boolean(shaperInitial.handshakeRtt) !== Boolean(shaperEffective.handshakeRtt))
  ) {
    // серия с иными параметрами канала (rtt150) — вернуть шейперу значения, с которыми он был запущен
    try {
      await httpJson(`${statsUrl}/config`, { method: 'POST', body: { delayMs: shaperInitial.delayMs, bandwidthMbit: shaperInitial.bandwidthMbit, bucketMs: shaperInitial.bucketMs, handshakeRtt: shaperInitial.handshakeRtt } });
      log(`  shaper restored: delay ${shaperInitial.delayMs} ms/way, ${shaperInitial.bandwidthMbit} Mbit/s, bucket ${shaperInitial.bucketMs} ms, handshake-rtt ${shaperInitial.handshakeRtt}`);
    } catch (err) {
      log(`  WARNING: could not restore shaper config: ${/** @type {any} */ (err)?.message}`);
    }
  }

  passport.finishedAt = new Date().toISOString();
  passport.runsExecutedNow = executed.length;
  // накопительно по всем запускам серии (resume): выполнено / ok
  passport.runsExecutedTotal = (prevPassport?.runsExecutedTotal ?? prevPassport?.runsExecutedNow ?? 0) + executed.length;
  passport.runsOk = (prevPassport?.runsOk ?? 0) + executed.filter((r) => r.outcome === 'ok').length;
  passport.runsTotalPlanned = fullPlan.length;
  writePassport();
  const aborted = consecutiveErrors >= maxConsecutiveErrors;
  writeProgress({ status: aborted ? 'aborted' : plan.length - pending.length + executed.length >= plan.length ? 'done' : 'stopped', current_run: null });
  log(`done: ${executed.length} runs executed (${passport.runsOk} ok) → ${seriesDir}`);
  return { plan, pending, executed, seriesDir };
}

/**
 * Записать входы эталона для прогона: `commands.json` — команды прогона в формате
 * packages/reference (с фактическим opId и expectedRevision; пустой список, если команда не
 * была отправлена) и `snapshots/<pageIndex>.json` — снимки посещённых страниц
 * (`{pageId, revision, shapes}`; страницы, вытесненные из окна (null), не пишутся).
 * requiredPages: в F — все посещённые страницы (все загружены), в P — активная в конце
 * страница (в приёмочном сценарии — страница 50, на которой проверяются экземпляры).
 * Если обязательных страниц нет или их снимки не записаны, возвращается `problem`: вызывающий
 * обязан пометить прогон ошибочным, а не запускать `compare-snapshots` на нуле снимков.
 * @param {string} refDir
 * @param {any} rec
 * @param {{docPages: number|null, visitSnapshots?: any[]}} [_opts]
 */
export function writeReferenceInputs(refDir, rec, _opts) {
  const snapshotsDir = path.join(refDir, 'snapshots');
  fs.rmSync(refDir, { recursive: true, force: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const sc = rec.scenario ?? {};
  // Снимки ПОСЕЩЕНИЙ (A11): по файлу на каждое посещение страницы, снятому пока она ещё в окне
  // кеша. Без них в режиме P эталон сверял бы только последнюю страницу маршрута. Формат —
  // `v<seq:3>-<pageId>.json` + журнал `visits.json` (см. шапку scripts/reference-check.sh).
  const visitSnapshots = _opts?.visitSnapshots ?? sc.visitSnapshots ?? [];
  for (const v of visitSnapshots) {
    const name = `v${String(v.visitSeq).padStart(3, '0')}-${String(v.pageId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
    fs.writeFileSync(path.join(snapshotsDir, name), JSON.stringify(v) + '\n');
  }
  const visits = sc.visits ?? [];
  const visitsFile = path.join(refDir, 'visits.json');
  fs.writeFileSync(visitsFile, JSON.stringify({ visits }, null, 2) + '\n');
  /** @type {any[]} */
  const commands = [];
  const cmd = sc.command;
  if (cmd && cmd.opId && cmd.tSent !== undefined) {
    // последний command-sent этого opId: при повторе после revision_mismatch expectedRevision обновляется
    const sent = (sc.events ?? []).filter((/** @type {any} */ e) => e.type === 'command-sent' && e.detail?.opId === cmd.opId).pop();
    commands.push({ type: cmd.type, targetId: cmd.targetId, fill: cmd.fill, opId: cmd.opId, ...(sent?.detail?.expectedRevision !== undefined ? { expectedRevision: sent.detail.expectedRevision } : {}), ...(cmd.result ? { result: cmd.result } : {}) });
  }
  const commandsFile = path.join(refDir, 'commands.json');
  fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2) + '\n');
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {Array<{pageIndex:number, pageId:string}>} */
  const visited = [];
  for (const [k, v] of Object.entries(sc.snapshots ?? {})) {
    const pageId = v?.pageId ?? null;
    const snap = v?.snapshot;
    if (pageId) visited.push({ pageIndex: Number(k), pageId });
    if (pageId && snap && Array.isArray(snap.shapes)) {
      fs.writeFileSync(path.join(snapshotsDir, `${String(k).padStart(3, '0')}.json`), JSON.stringify({ pageId, pageIndex: Number(k), revision: snap.revision, shapes: snap.shapes }) + '\n');
      written.push(pageId);
    } else if (pageId) missing.push(pageId);
  }
  const route = /** @type {number[]} */ (sc.route ?? []);
  const lastIndex = route.length ? route[route.length - 1] : null;
  const lastPage = visited.find((v) => v.pageIndex === lastIndex)?.pageId ?? null;
  const requiredPages = rec.mode === 'F' ? visited.map((v) => v.pageId) : lastPage ? [lastPage] : [];
  // Пустой список обязательных страниц означал бы, что compare-snapshots пройдёт НА НУЛЕ снимков
  // («эталон совпал» вакуозно). Такой прогон — ошибка, а не успешная сверка.
  let problem = null;
  if (!requiredPages.length) {
    problem =
      rec.mode === 'F'
        ? 'no page snapshots were collected (F: every visited page must be present)'
        : `last route page (index ${String(lastIndex)}) has no snapshot — cannot verify the reference`;
  } else if (requiredPages.some((p) => !written.includes(p))) {
    const absent = requiredPages.filter((p) => !written.includes(p));
    problem = `snapshots missing for required pages: ${absent.join(',')}`;
  }
  // Посещение без снимка — не «пропуск», а провал прогона: именно ради этих страниц A11 и вводился
  const badVisits = (sc.visits ?? []).filter((/** @type {any} */ v) => v.error);
  if (!problem && badVisits.length) {
    problem = `visit snapshots missing: ${badVisits.map((/** @type {any} */ v) => `#${v.seq} page ${v.pageIndex} (${v.error})`).join('; ')}`;
  }
  return { commandsFile, snapshotsDir, visitsFile, visits: visits.length, snapshotPages: written, evictedPages: missing, requiredPages, problem };
}

/** @param {number|undefined|null} v */
function fmt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(0) : '—';
}

/** @param {string[]} argv */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      out: { type: 'string', default: path.join(ROOT_DIR, 'results') },
      'dry-run': { type: 'boolean', default: false },
      repetitions: { type: 'string' },
      only: { type: 'string' },
      'no-resume': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      progress: { type: 'string' },
      'progress-extra': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help || !values.config) {
    process.stdout.write(`usage: node src/series/run.mjs --config <series.json> [--out <dir>] [--dry-run] [--repetitions N] [--only H:P:1[,Q:F:1]] [--no-resume] [--verbose] [--progress results/progress.json] [--progress-extra '{"json":true}']\n`);
    process.exit(values.help ? 0 : 2);
  }
  const series = loadSeriesConfig(path.resolve(values.config));
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
  /** @type {Record<string, unknown> | undefined} */
  let progressExtra;
  if (values['progress-extra']) {
    try {
      progressExtra = JSON.parse(values['progress-extra']);
    } catch {
      progressExtra = { extra: values['progress-extra'] };
    }
  }
  await runSeries(series, {
    outDir: path.resolve(/** @type {string} */ (values.out)),
    dryRun: values['dry-run'],
    repetitions: values.repetitions ? Number(values.repetitions) : undefined,
    only: values.only ?? null,
    resume: !values['no-resume'],
    verbose: values.verbose,
    progressFile: values.progress ? path.resolve(values.progress) : null,
    progressExtra,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
