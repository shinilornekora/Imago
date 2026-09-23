// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Конфигурация запуска функциональных проверок (аргументы CLI + переменные среды).
 *
 *   node run.mjs [--adapters H,Q,Z] [--port 3005 | --base http://127.0.0.1:3005] [--caches 1,3,10]
 *                [--configs H:P:1,Q:F:1] [--only 1-open,6-retry] [--doc data/small-10x200.json]
 *                [--bob-doc doc-bob-5x50] [--out results/functional] [--timeout 120000]
 *                [--label main] [--zero-query-api http://127.0.0.1:3000]
 *
 * Переменные среды: STAND_FUNCTIONAL_ADAPTERS (по умолчанию H,Q — Z включается явно),
 * STAND_FUNCTIONAL_BASE / STAND_PORT, STAND_DB_URL, STAND_FUNCTIONAL_SKIP_Z=1 (Z всегда пропускается).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория (packages/bench/src/functional/lib → ../../../../..). */
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..', '..');

export const DEFAULT_DB_URL = 'postgres://postgres:postgres@127.0.0.1:5432/editor';

/**
 * @typedef {{adapter:'H'|'Q'|'Z', mode:'F'|'P', cache:number}} StandConfig
 */

/** @param {StandConfig} c */
export const configLabel = (c) => `${c.adapter}/${c.mode}${c.mode === 'P' ? `/cache=${c.cache}` : ''}`;
/** @param {StandConfig} c */
export const configKey = (c) => `${c.adapter}${c.mode}${c.cache}`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i += 1;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

/**
 * @param {Record<string, string|boolean>} opts
 */
export function buildOptions(opts) {
  const env = process.env;
  const port = String(opts.port ?? env.STAND_PORT ?? '3005');
  const base = String(opts.base ?? env.STAND_FUNCTIONAL_BASE ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const adaptersRaw = String(opts.adapters ?? env.STAND_FUNCTIONAL_ADAPTERS ?? 'H,Q');
  let adapters = adaptersRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const skipZ = env.STAND_FUNCTIONAL_SKIP_Z === '1' || opts['skip-z'] === true;
  if (skipZ) adapters = adapters.filter((a) => a !== 'Z');
  for (const a of adapters) if (!['H', 'Q', 'Z'].includes(a)) throw new Error(`unknown adapter ${a}`);
  const cache3 = String(opts.cache3 ?? env.STAND_FUNCTIONAL_CACHE3 ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  // окна кеша для режима P: по умолчанию только 1; допуск серий cache3/cache10 требует 1,3,10 (критик B, п. 6)
  const caches = String(opts.caches ?? env.STAND_FUNCTIONAL_CACHES ?? '1')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (caches.length === 0) throw new Error('--caches: ожидается список целых > 0, например 1,3,10');
  const modes = String(opts.modes ?? env.STAND_FUNCTIONAL_MODES ?? 'F,P')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const m of modes) if (!['F', 'P'].includes(m)) throw new Error(`unknown mode ${m}`);

  /** @type {StandConfig[]} */
  let configs = [];
  if (opts.configs) {
    for (const spec of String(opts.configs).split(',')) {
      const [adapter, mode, cache] = spec.trim().split(':');
      if (!adapter || !mode) throw new Error(`bad --configs entry "${spec}" (ожидается A:M[:cache])`);
      configs.push({ adapter: /** @type {any} */ (adapter.toUpperCase()), mode: /** @type {any} */ (mode.toUpperCase()), cache: Number(cache ?? 1) });
    }
  } else {
    for (const adapter of adapters) {
      if (modes.includes('F')) configs.push({ adapter: /** @type {any} */ (adapter), mode: 'F', cache: 1 });
      if (modes.includes('P')) for (const c of caches) configs.push({ adapter: /** @type {any} */ (adapter), mode: 'P', cache: c });
      if (cache3.includes(adapter) && !caches.includes(3) && modes.includes('P')) configs.push({ adapter: /** @type {any} */ (adapter), mode: 'P', cache: 3 });
    }
  }
  const only = opts.only ? String(opts.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const docJson = path.resolve(REPO_ROOT, String(opts.doc ?? 'data/small-10x200.json'));
  const bobDocId = String(opts['bob-doc'] ?? 'doc-bob-5x50');
  const outRoot = path.resolve(REPO_ROOT, String(opts.out ?? 'results/functional'));
  const timeoutMs = Number(opts.timeout ?? 120_000);
  const dbUrl = String(env.STAND_DB_URL ?? DEFAULT_DB_URL);
  const headless = opts.headed !== true;
  const stamp = String(opts.stamp ?? new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19));
  // метка прогона допуска (попадает в summary.json: по ней run-all-series.sh собирает покрытие)
  const label = opts.label ? String(opts.label) : null;
  // API, который вызывает zero-cache как ZERO_QUERY_URL (обычно общий стенд :3000): туда ставится задержка
  // трансформации synced query в проверке 5 для Z. По умолчанию — тот же base.
  const zeroQueryApi = String(opts['zero-query-api'] ?? env.STAND_FUNCTIONAL_ZERO_QUERY_API ?? base).replace(/\/$/, '');
  return { base, adapters, configs, only, docJson, bobDocId, outRoot, outDir: path.join(outRoot, stamp), timeoutMs, dbUrl, headless, skipZ, label, zeroQueryApi, help: opts.help === true };
}

export const USAGE = `Функциональные проверки стенда (SPEC §6, таблица 1)
  node packages/bench/src/functional/run.mjs [опции]
    --adapters H,Q[,Z]     адаптеры (по умолчанию H,Q; Z — только явно; STAND_FUNCTIONAL_SKIP_Z=1 исключает Z)
    --port 3005            порт API (или --base http://127.0.0.1:3005)
    --modes F,P            режимы загрузки (по умолчанию оба)
    --caches 1,3,10        окна кеша для режима P (по умолчанию 1); допуск серий cache3/cache10 требует 1,3,10
    --cache3 H             (устар.) добавить P/cache=3 для перечисленных адаптеров
    --configs H:P:1,Q:F:1  явный список конфигураций вместо матрицы
    --only 1-open,6-retry  только перечисленные проверки (id) — прогон помечается как ЧАСТИЧНЫЙ набор
    --doc data/small-10x200.json   документ alice (экспорт генератора); допуск обязателен на измеряемом документе
    --bob-doc doc-bob-5x50 документ bob (для проверки безопасности)
    --out results/functional       корень результатов (создаётся <out>/<timestamp>/)
    --label main-acceptance        метка прогона допуска (пишется в summary.json)
    --zero-query-api URL   API, который zero-cache вызывает как ZERO_QUERY_URL (по умолчанию = --base):
                           туда ставится задержка трансформации synced query в проверке 5 для Z
    --timeout 120000       тайм-аут одной проверки, мс
    --headed               окно браузера (отладка)

  Код возврата: 0 — все конфигурации получили «допуск»; 1 — есть провал; 3 — провалов нет,
  но есть пропущенные проверки или частичный набор («допуск с оговоркой» / «частичный»); 2 — фатальная ошибка.
`;
