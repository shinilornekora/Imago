// @ts-check
/**
 * Схема runs.csv (согласована с packages/analysis/COLUMNS.md — имена обязательных колонок
 * совпадают) и запись строк. Одна строка = один прогон. Пустое значение — метрика не измерена.
 */

import fs from 'node:fs';

/** Обязательные колонки анализа — порядок и имена как в COLUMNS.md. */
export const REQUIRED_COLUMNS = [
  'run_id',
  'series',
  'adapter',
  'mode',
  'cache',
  'doc',
  'repetition',
  'order_index',
  'started_at',
  'outcome',
  'error_stage',
  't_first_ready_ms',
  't_nav_1_ms',
  't_nav_2_ms',
  't_nav_3_ms',
  't_nav_4_ms',
  't_nav_5_ms',
  't_nav_6_ms',
  't_nav_7_ms',
  't_nav_8_ms',
  't_nav_9_ms',
  't_nav_10_ms',
  't_nav_new_median_ms',
  't_nav_return_median_ms',
  't_cmd_ack_ms',
  't_cmd_drawn_ms',
  't_scenario_ms',
  'bytes_in',
  'bytes_out',
  'cdp_bytes_in',
  'js_heap_peak_mb',
  'js_heap_end_mb',
  'chromium_private_peak_mib',
  'chromium_private_end_mib',
  'client_storage_bytes',
  'retained_pages_end',
  'retained_shapes_end',
  'retained_pages_max',
  'retained_shapes_max',
  'loaded_pages_end',
  'server_api_cpu_ms',
  'server_api_mem_peak_mib',
  'server_api_mem_integral_mib_s',
  'server_pg_cpu_ms',
  'server_pg_mem_peak_mib',
  'server_pg_mem_integral_mib_s',
  'server_zero_cpu_ms',
  'server_zero_mem_peak_mib',
  'server_zero_mem_integral_mib_s',
  'zero_replica_bytes',
  'within_budget_first',
  'within_budget_nav',
  'within_budget_cmd',
  'within_budget_scenario',
  'reference_ok',
];

/** Необязательные (COLUMNS.md) и дополнительные колонки оболочки. */
export const EXTRA_COLUMNS = [
  'doc_pages',
  'doc_shapes_per_page',
  'rtt_ms',
  'bandwidth_mbps',
  'seed',
  'finished_at',
  'error_message',
  'notes',
  // дополнительные
  'wall_ms',
  'browser_launch_ms',
  'cdp_bytes_out',
  'cdp_ws_bytes_in',
  'cdp_ws_bytes_out',
  'shaper_requests',
  'shaper_connections',
  'cmd_revision',
  'cmd_affected_pages',
  'cmd_affected_shapes',
  'server_api_rss_peak_mib',
  'server_pg_rss_peak_mib',
  'server_zero_rss_peak_mib',
  'chromium_processes_peak',
  'client_transfer_bytes_in',
  'client_transfer_bytes_out',
  // разложение команды по моментам (§1.8) и учёт накладных расходов оболочки
  't_scenario_wall_ms',
  'probe_overrun_ms',
  't_cmd_server_ms',
  't_cmd_synced_ms',
  't_cmd_opget_ms',
  'cmd_drawn_before_ack',
  't_scenario_model_ms',
  't_scenario_model_residual_ms',
  'probe_total_ms',
  'retained_probe_mode',
  // точный скан хранилища в общей для всех адаптеров точке (сравнимая величина, N4)
  'retained_pages_end_exact',
  'retained_shapes_end_exact',
  'js_heap_samples',
  'js_heap_sample_interval_ms',
  // паритет давления сборщика мусора и куча после GC в фиксированной точке (N2)
  'js_heap_gc_count',
  'js_heap_post_gc_mb',
  'js_heap_suspended_ms',
  // честность сэмплирования (критик B, п. 15; N6) и общий диск серверной части
  'sampling_incomplete',
  'sampling_ticks',
  'server_zero_applicable',
  'server_disk_used_bytes',
  // --- маршрут произвольной длины (серии route-full / route-repeat) ---------------------------
  // Колонок t_nav_1..10 хватает только маршруту §7.2; при более длинном маршруте остальные
  // переходы видны здесь и полностью — в runs/<run_id>.json (`scenario.t_nav`, `steps[]`).
  'route_len',
  'route_distinct_pages',
  't_nav_count',
  't_nav_new_count',
  't_nav_return_count',
  't_nav_median_ms',
  't_nav_ms_list',
  // --- повторное чтение: промахи окна кеша и фактические HTTP-чтения страниц -------------------
  'nav_cache_hits',
  'nav_cache_misses',
  'page_loads_observed',
  'api_page_reads',
  'api_page_reads_distinct',
  'api_page_read_bytes',
  // --- вариант команды (серия command-shape): доля изменённых объектов и их размещение ---------
  'cmd_variant',
  'cmd_target_id',
  // --- разложение обмена по маршрутам шейпера (дефект «статика в отношениях обмена») ------------
  // `bytes_in` = bytes_in_api + bytes_in_zero + bytes_in_static + bytes_in_other (остаток обязан
  // быть 0). Данные документа — это API + zero; статика сборки клиента — поадаптерная константа,
  // которая не является данными и смещает P/F по-разному у H, Q и Z.
  'bytes_in_api',
  'bytes_in_zero',
  'bytes_in_static',
  'bytes_in_other',
  'bytes_out_api',
  'bytes_out_zero',
  'bytes_out_static',
  'bytes_out_other',
  'bytes_in_route_residual',
  'bytes_out_route_residual',
  // --- пик памяти без окон измерительных проб инструмента (дефект «пик содержит пробу») ---------
  // chromium_private_peak_mib оставлен сырым ради совместимости; головная величина —
  // chromium_private_peak_excl_probe_mib (выборки внутри окон проб исключены одинаково у всех адаптеров).
  'chromium_private_peak_raw_mib',
  'chromium_private_peak_excl_probe_mib',
  'chromium_probe_ticks',
  'chromium_samples',
  'server_api_mem_peak_excl_probe_mib',
  'server_pg_mem_peak_excl_probe_mib',
  'server_zero_mem_peak_excl_probe_mib',
  'probe_window_count',
  'probe_window_ms',
  'js_heap_sampler_coverage',
  // --- идентичность измерительной оболочки (сопоставимость серий между собой) -------------------
  'harness_id',
];

export const COLUMNS = [...REQUIRED_COLUMNS, ...EXTRA_COLUMNS];

/** @param {unknown} v */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(+v.toFixed(3)) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string} file
 * @param {Record<string, unknown>} row
 * @param {string[]} [columns]
 */
export function appendCsvRow(file, row, columns = COLUMNS) {
  const line = columns.map((c) => csvCell(row[c])).join(',') + '\n';
  if (!fs.existsSync(file)) fs.writeFileSync(file, columns.join(',') + '\n' + line);
  else fs.appendFileSync(file, line);
}

/**
 * Прочитать run_id уже записанных строк (для resume).
 * @param {string} file
 * @returns {Set<string>}
 */
export function readCsvRunIds(file) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (!fs.existsSync(file)) return ids;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const header = (lines[0] ?? '').split(',');
  const idx = header.indexOf('run_id');
  if (idx < 0) return ids;
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const cell = l.split(',')[idx] ?? '';
    ids.add(cell.replace(/^"|"$/g, ''));
  }
  return ids;
}

/** @param {number[]} a */
export function median(a) {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
