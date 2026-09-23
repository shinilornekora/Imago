// @ts-check
/**
 * Приёмочный сценарий (SPEC §7.2–7.3) поверх контракта `window.__stand` (SPEC §4.2).
 *
 * Открыть документ на странице 1 → готовность (t_first_ready от navigationStart);
 * десять переходов по маршруту [2,3,1,4,2,5,1,6,3,50]; после 5-го перехода — `setSourceFill`
 * источника (t_cmd_ack, t_cmd_drawn, t_cmd_server, t_cmd_synced от момента отправки).
 * В конце — снимки посещённых страниц для эталона.
 *
 * МАРШРУТ — ПАРАМЕТР ПРОИЗВОЛЬНОЙ ДЛИНЫ. `route` может быть любой длины и любого состава
 * (серия `route-full` — все 50 страниц подряд, `route-repeat` — 18 переходов с возвратами);
 * номер шага команды (`cmdAfterStep`) отсчитывается от начала маршрута. Все величины,
 * зависящие от длины (число пауз, расписание сборок мусора, число снимков посещений),
 * считаются от `route.length`, а не от «десяти переходов».
 *
 * ПОВТОРНОЕ ЧТЕНИЕ. Каждый переход классифицируется дважды: `is_return` — страница уже
 * посещалась по МАРШРУТУ; `was_loaded` — страница ещё удерживалась клиентом ПЕРЕД кликом
 * (состояние окна кеша по итогам прошлого шага, `getLoadedPages()`). Промах (`was_loaded=false`)
 * означает загрузку заново — у H и Q это видно и прямым счётчиком HTTP-чтений страниц
 * (`page_reads`, CDP), у Z чтений по HTTP нет вовсе (страницы приходят синхронизацией), и
 * промах окна — единственная наблюдаемая мера повторной материализации.
 *
 * Все моменты времени берутся из журнала событий страницы (`performance.now()` в
 * контексте страницы), а не из часов оболочки: точность не зависит от задержек CDP.
 *
 * ЧАСЫ СЦЕНАРИЯ И ИЗМЕРИТЕЛЬНЫЕ ПРОБЫ (§1.2 «между действиями выдерживается одна секунда»).
 * Объявленная пауза отсчитывается ОТ ГОТОВНОСТИ предыдущего действия, а не от конца пробы:
 * следующее действие (клик или отправка команды) выполняется в контексте страницы ровно в момент
 * `t_ready(предыдущего) + pauseMs` (ожидание идёт в тех же часах, что и события). Проба
 * выполняется внутри этой паузы и клик не сдвигает. Если проба всё же превысила паузу, превышение
 * пишется в `steps[].probe_overrun_ms`, суммируется в `probe_overrun_ms` и ВЫЧИТАЕТСЯ из
 * `t_scenario_ms`; сырое значение остаётся в `t_scenario_wall_ms`.
 *   `t_scenario_wall_ms` = navigationStart → последняя готовность (сырое, с накладными расходами);
 *   `t_scenario_ms`      = `t_scenario_wall_ms − probe_overrun_ms` — время пользовательского пути
 *                          с объявленными паузами, свободное от инструмента; по нему считается
 *                          бюджет 30 с. НЕЗАВИСИМАЯ сверка — `t_scenario_model_ms`: та же сумма,
 *                          собранная по ЖУРНАЛУ СОБЫТИЙ страницы (`scenarioModelFromJournal`),
 *                          а не из бухгалтерии оболочки; остаток отличен от нуля и осмыслен.
 *
 * ПРОБЫ. Политика ОДИНАКОВА для всех адаптеров и не зависит от стоимости скана (иначе показатели
 * кучи и retained сравнивались бы при разном давлении сборщика — дефекты N2/N4):
 *   - на КАЖДОМ шаге — только ДЕШЁВАЯ проба: `getRetained()` (собственное значение адаптера),
 *     `getLoadedPages().length`, `drawn`, `state`; она ничего не сканирует и не аллоцирует;
 *   - точный скан клиентского хранилища (`getRetainedAsync()`; у Z — материализация всех строк,
 *     ≈0.3 с и ≈25 000 объектов на 50×500 в F) выполняется РОВНО В ДВУХ фиксированных точках:
 *     сразу после команды и в конце, уже ПОСЛЕ остановки часов сценария.
 * Поэтому сравнимы между адаптерами `retained_*_end` / `retained_*_end_exact` (точный скан в общей
 * точке); шаговые `retained_*_max` — это дешёвые значения адаптеров, снятые по одному расписанию,
 * и сравнивать их следует как «что адаптер сам считает удержанным», а не как результат скана.
 *
 * JS-КУЧА И СБОРКА МУСОРА. Куча опрашивается по таймеру (`heapIntervalMs`, по умолчанию 250 мс —
 * как частная память), поэтому `js_heap_peak_mib` — настоящий пик выборки. Принудительная сборка
 * мусора (`probes.gc`) вызывается в ФИКСИРОВАННЫХ точках, одинаковых для любого адаптера, режима
 * и пробы: после каждой шаговой пробы (11), после пробы вслед за командой (1), в момент остановки
 * часов сценария (1, после неё снимается `js_heap_post_gc_mib`), после выгрузки снимков (1) и
 * после заключительного скана (1), а также после снимка КАЖДОГО посещения (11) — итого 26 на
 * прогон при штатном маршруте; фактическое число пишется в `gc.forced` (колонка
 * `js_heap_gc_count`) и обязано совпадать у всех конфигураций.
 * Сэмплер кучи приостанавливается на время двух точных сканов, выгрузки снимков посещений (11) и
 * заключительной выгрузки. ТОЧКИ приостановки одни и те же у всех адаптеров, а ДЛИТЕЛЬНОСТЬ — нет:
 * скан у Z стоит на порядок дороже (медианы `js_heap_suspended_ms` в `main`: H/F 1 110, Q/F 1 100,
 * Z/F 3 146 мс), поэтому рядом с пиком кучи публикуется покрытие сэмплера
 * (`js_heap_samples × js_heap_sample_interval_ms / t_scenario_ms`).
 * ТЕ ЖЕ окна отдаются сэмплерам процессов (`sampling/probe-windows.mjs`): выборки Chromium и
 * серверных групп, попавшие внутрь окна, помечаются и не входят в `*_excl_probe_*`-пики. Без этого
 * пик частной памяти Chromium содержал бы материализацию строк, сделанную самим инструментом, и
 * притом по-разному у разных адаптеров (дефект «пик содержит пробу»).
 * Шаговая проба кучи снимается ДО обращения к странице и ДО сборки мусора.
 *
 * СНИМКИ ПОСЕЩЕНИЙ (A11). На каждое посещение страницы, дошедшее до `page-ready`, снимается её
 * снимок, ПОКА она ещё удерживается клиентом, и ведётся журнал `visits[]`; эталон сверяет каждое
 * посещение (в режиме P к концу прогона в окне остаётся только последняя страница маршрута, и без
 * этих снимков промежуточные переходы не проверялись бы вовсе). Формат — в шапке
 * `scripts/reference-check.sh`; файлы пишет `packages/bench/src/series/run.mjs`.
 *
 * Бюджеты (§7.4) записываются булевыми полями, но не навязываются. Любой тайм-аут или
 * исключение → outcome 'error' со стадией; функция никогда не бросает.
 */

import { performance } from 'node:perf_hooks';
import { passwordFor } from '../test-users.mjs';

export const DEFAULT_ROUTE = [2, 3, 1, 4, 2, 5, 1, 6, 3, 50];

export const DEFAULT_BUDGETS = { firstReadyMs: 2000, navMs: 1000, cmdDrawnMs: 2000, scenarioMs: 30_000 };

/** Сколько ждать `getRetainedAsync()` (скан хранилища Z: ≈40 мс на 1000 строк, ≈0.3 с на 25 000) до отката к `getRetained()`. */
export const RETAINED_ASYNC_TIMEOUT_MS = 3000;

/** Интервал опроса JS-кучи по умолчанию (как у `chromium_private_*`). */
export const DEFAULT_HEAP_INTERVAL_MS = 250;

/**
 * Точки точного скана хранилища — одинаковые для всех адаптеров и режимов (см. шапку файла).
 * Шаговые пробы точного скана не делают НИКОГДА, поэтому политика не зависит от его стоимости.
 */
export const EXACT_RETAINED_POINTS = /** @type {const} */ (['after-command', 'end']);

/** Название политики проб (пишется в `retained_probe_mode`). */
export const RETAINED_PROBE_POLICY = 'cached-steps+exact-after-cmd-and-end';

/**
 * @typedef {object} ScenarioOptions
 * @property {string} baseUrl                 http://127.0.0.1:<shaperPort>
 * @property {'H'|'Q'|'Z'|string} adapter
 * @property {'F'|'P'|string} mode
 * @property {number} cache
 * @property {string} doc
 * @property {string} sourceId                источник для setSourceFill
 * @property {string} fill                    новый цвет #rrggbb
 * @property {string} [autologin]             'alice'
 * @property {string} [autologinPassword]     пароль тестовой учётки (по умолчанию — из test-users.mjs);
 *                                            передаётся в КОНТЕКСТ СТРАНИЦЫ (addInitScript), не в URL
 * @property {number[]} [route]
 * @property {number} [pauseMs]               пауза между действиями (1000)
 * @property {number} [cmdAfterStep]          после какого перехода команда (5)
 * @property {number} [stepTimeoutMs]         тайм-аут ожидания одного события (20000)
 * @property {Partial<typeof DEFAULT_BUDGETS>} [budgets]
 * @property {Record<string,string>} [extraQuery]
 * @property {{heap?: () => Promise<{usedMib:number,totalMib:number,source:string}>, gc?: () => Promise<void>, net?: () => any}} [probes]
 *            `net` — счётчики CDP (`sampling/chromium.mjs`), читаются в процессе оболочки без
 *            обращения к странице: по ним считаются HTTP-чтения страниц на шаг и за прогон
 * @property {number} [heapIntervalMs]        период опроса JS-кучи (250)
 * @property {import('../sampling/probe-windows.mjs').ProbeWindows} [probeWindows]
 *            реестр окон измерительных проб инструмента: те же окна, на которых приостанавливается
 *            сэмплер кучи, помечаются в выборках сэмплеров /proc (см. sampling/probe-windows.mjs)
 * @property {string|number} [initialPage]    начальная страница (`?page=`; по умолчанию 1 — явно, а не «первая по индексу»)
 * @property {(msg: string) => void} [log]
 * @property {boolean} [keepEvents]           сохранять полный журнал событий в записи (true)
 */

/**
 * Запись шага (форма согласована с packages/analysis/COLUMNS.md: step/action/page_id/t_ms/
 * retained_pages/retained_shapes/loaded_pages + объект retained).
 * @typedef {object} StepRecord
 * @property {number} step                    0 — открытие, 1..N — переходы
 * @property {'open'|'nav'} action
 * @property {number} page_index
 * @property {string|null} page_id
 * @property {boolean} is_return              страница уже посещалась
 * @property {number} t_click                 performance.now() клика (для open — 0)
 * @property {number|null} t_select           t события page-select (или null)
 * @property {number} t_ready                 t события page-ready
 * @property {number} t_ms                    t_ready − t_click
 * @property {boolean} budget_ok
 * @property {{pages:number,shapes:number,bytesEstimate?:number}|null} retained
 * @property {string|null} [retained_source]   'async' (getRetainedAsync), 'sync' (getRetained) или 'sync-after-timeout'
 * @property {number|null} retained_pages
 * @property {number|null} retained_shapes
 * @property {number|null} [retained_bytes_synthetic]  СИНТЕТИЧЕСКАЯ оценка 200 Б/фигуру, не измерение памяти
 * @property {number|null} loaded_pages
 * @property {string[]|null} [loaded_page_ids]  какие страницы удерживает клиент ПОСЛЕ этого шага
 * @property {boolean|null} [was_loaded]        страница шага удерживалась клиентом ДО клика (попадание в окно кеша)
 * @property {number|null} [page_reads_total]   накопленное число HTTP-чтений страниц (CDP) на конец шага
 * @property {number|null} [page_reads_delta]   сколько HTTP-чтений страниц пришлось на этот шаг
 * @property {number} [visit_seq]           номер посещения (A11): снимок этой страницы — v<seq>-<pageId>.json
 * @property {number|null} js_heap_mb         usedJSHeapSize, МБ (10⁶) — снимается ДО пробы страницы
 * @property {{usedMib:number,totalMib:number,source:string}|null} heap
 * @property {number} [probe_ms]              длительность измерительной пробы шага
 * @property {number} [probe_overrun_ms]      насколько клик следующего шага вышел за объявленную паузу
 * @property {unknown} drawn
 */

// Паузы сценария выдерживаются в контексте страницы (`actAt`), а не часами оболочки — см. шапку файла.

/**
 * Ожидание события журнала `window.__stand` (сначала — поиск в прошлом, затем waitFor +
 * страховочный опрос журнала). Возвращает событие.
 * @param {import('playwright').Page} page
 * @param {{type: string, sinceT: number, pageIndex?: number|null, pageId?: string|null, opId?: string|null, timeoutMs: number}} spec
 */
export async function waitForStandEvent(page, spec) {
  return page.evaluate(async (spec) => {
    const s = /** @type {any} */ (window).__stand;
    if (!s) throw new Error('window.__stand is missing');
    /** @param {any} e */
    const matches = (e) => {
      if (!e || e.type !== spec.type) return false;
      if (typeof e.t === 'number' && e.t < spec.sinceT) return false;
      const d = e.detail ?? {};
      if (spec.opId && d.opId !== undefined && d.opId !== null && d.opId !== spec.opId) return false;
      if (spec.pageId || spec.pageIndex != null) {
        const idx = d.pageIndex ?? d.index;
        const pid = d.pageId ?? d.id;
        if (spec.pageId && pid !== undefined && pid !== null) return pid === spec.pageId;
        if (spec.pageIndex != null && idx !== undefined && idx !== null) return Number(idx) === spec.pageIndex;
        // деталь без идентификаторов страницы — считаем событием активной страницы
      }
      return true;
    };
    const past = Array.isArray(s.events) ? s.events.find(matches) : undefined;
    if (past) return past;
    return await new Promise((resolve, reject) => {
      let done = false;
      /** @param {any} e */
      const finish = (e) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(e);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        clearInterval(poll);
        reject(new Error(`timeout ${spec.timeoutMs} ms waiting for ${spec.type}` + (spec.pageIndex != null ? ` (page ${spec.pageIndex})` : '')));
      }, spec.timeoutMs);
      const poll = setInterval(() => {
        const e = Array.isArray(s.events) ? s.events.find(matches) : undefined;
        if (e) finish(e);
      }, 25);
      if (typeof s.waitFor === 'function') {
        try {
          Promise.resolve(s.waitFor(spec.type, matches, spec.timeoutMs + 1000)).then(
            (e) => {
              if (e && matches(e)) finish(e);
            },
            () => {
              /* отказ waitFor — остаёмся на опросе журнала до нашего тайм-аута */
            },
          );
        } catch {
          /* то же */
        }
      }
    });
  }, spec);
}

/**
 * Идентификатор страницы по индексу из DOM (кнопка `[data-page-index=k]` c `data-page-id`).
 * @param {import('playwright').Page} page
 * @param {number} index
 * @returns {Promise<string|null>}
 */
async function pageIdFromDom(page, index) {
  try {
    return await page.evaluate((k) => {
      const el = document.querySelector(`[data-page-index="${k}"]`);
      return el?.getAttribute('data-page-id') ?? null;
    }, index);
  } catch {
    return null;
  }
}

/**
 * Активная страница по `window.__stand.activePageId` (fallback, когда ни DOM, ни detail
 * события не содержат идентификатора: сразу после page-ready активна именно эта страница).
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
async function activePageId(page) {
  try {
    const v = await page.evaluate(() => /** @type {any} */ (window).__stand?.activePageId ?? null);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Периодический опрос JS-кучи через CDP (`Runtime.getHeapUsage`) — «пик» по выборке с фиксированным
 * шагом, а не максимум по границам шагов (SPEC §7.3). На время точных сканов клиентского хранилища
 * сэмплер приостанавливается: копия строк, созданная инструментом, не должна попадать в пик.
 * @param {ScenarioOptions['probes']} probes
 * @param {number} intervalMs
 * @param {import('../sampling/probe-windows.mjs').ProbeWindows|null} [probeWindows]
 *        реестр окон: те же приостановки объявляются сэмплерам процессов
 */
function startHeapSampler(probes, intervalMs, probeWindows = null) {
  let max = NaN;
  let count = 0;
  let suspendDepth = 0;
  let suspendGen = 0;
  let suspendedMs = 0;
  let suspendStart = 0;
  let suspendCount = 0;
  let busy = false;
  /** @param {{usedMib:number}|null} h */
  const note = (h) => {
    if (h && Number.isFinite(h.usedMib)) {
      count += 1;
      max = Math.max(Number.isFinite(max) ? max : 0, h.usedMib);
    }
  };
  const tick = async () => {
    if (!probes?.heap || busy || suspendDepth > 0) return;
    busy = true;
    const gen = suspendGen;
    try {
      const h = await probes.heap();
      // если во время опроса началась (или прошла) приостановка — сэмпл отбрасываем
      if (suspendDepth === 0 && gen === suspendGen) note(h);
    } catch {
      /* CDP недоступен */
    } finally {
      busy = false;
    }
  };
  const timer = probes?.heap ? setInterval(() => void tick(), intervalMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    note,
    /** @param {string} [label] метка окна для сэмплеров процессов */
    suspend(label = 'probe') {
      suspendGen += 1;
      suspendCount += 1;
      probeWindows?.begin(label);
      if (suspendDepth++ === 0) suspendStart = performance.now();
    },
    resume() {
      suspendGen += 1;
      probeWindows?.end();
      if (--suspendDepth === 0) suspendedMs += performance.now() - suspendStart;
      if (suspendDepth < 0) suspendDepth = 0;
    },
    get peakMib() {
      return max;
    },
    stop() {
      if (timer) clearInterval(timer);
      return { peak_mib: max, samples: count, interval_ms: intervalMs, suspended_ms: Math.round(suspendedMs), suspends: suspendCount };
    },
  };
}

/**
 * Снять показатели шага.
 *  - `exact:false` — дешёвая проба: `getRetained()` (кеш адаптера), `getLoadedPages().length`,
 *    `drawn`, `state`; ничего не сканирует и не аллоцирует (так снимается КАЖДЫЙ шаг);
 *  - `exact:true` — точный подсчёт через `getRetainedAsync()` (у Z — скан клиентского хранилища);
 *    выполняется только в двух фиксированных точках (`EXACT_RETAINED_POINTS`), на это время
 *    сэмплер кучи приостанавливается.
 * Сборка мусора запрашивается ПОСЛЕ любой пробы — и дешёвой, и точной, — т. е. по одинаковому
 * для всех адаптеров расписанию (дефект N2). Проба кучи снимается ПЕРВОЙ, до обращения к
 * странице и до сборки мусора, поэтому пик остаётся пиком фактической выборки.
 * @param {import('playwright').Page} page
 * @param {ScenarioOptions['probes']} probes
 * @param {{exact?: boolean, heapSampler?: ReturnType<typeof startHeapSampler>|null, heap?: boolean}} [opts]
 */
async function probe(page, probes, opts = {}) {
  const exact = opts.exact ?? false;
  const sampler = opts.heapSampler ?? null;
  const t0 = performance.now();
  // счётчик чтений страниц по HTTP (CDP, см. sampling/chromium.mjs) — снимок ДО обращения к
  // странице; это локальный вызов в процессе оболочки, он ничего не стоит и одинаков у всех
  // адаптеров (у Z чтения идут синхронизацией, и счётчик остаётся нулевым — это и есть результат)
  let net = null;
  try {
    net = probes?.net ? probes.net() : null;
  } catch {
    net = null;
  }
  let heap = null;
  if (probes?.heap && opts.heap !== false) {
    try {
      heap = await probes.heap();
      sampler?.note(heap);
    } catch {
      heap = null;
    }
  }
  /** @type {{retained: any, retained_source: string|null, loadedPages: number|null, loadedPageIds: string[]|null, drawn: unknown, state: string|null, activePageId: string|null, activeRevision: number|null}} */
  let inPage = { retained: null, retained_source: null, loadedPages: null, loadedPageIds: null, drawn: null, state: null, activePageId: null, activeRevision: null };
  if (exact) sampler?.suspend('exact-retained');
  try {
    inPage = await page.evaluate(
      async ({ timeoutMs, exact }) => {
        const s = /** @type {any} */ (window).__stand;
        /** @param {() => any} f */
        const safe = (f) => {
          try {
            return f();
          } catch {
            return null;
          }
        };
        /** @type {{value: any, source: string}} */
        let retained = { value: null, source: 'none' };
        // точный подсчёт: getRetainedAsync (у Z кеш getRetained() обновляется асинхронно —
        // docs/FUNCTIONAL_FINDINGS.md п. 2); ждём не дольше timeoutMs, иначе — синхронное значение
        const asyncFn = exact
          ? (s.getRetainedAsync ?? /** @type {any} */ (window).__standController?.adapter?.getRetainedAsync?.bind(/** @type {any} */ (window).__standController?.adapter))
          : null;
        if (typeof asyncFn === 'function') {
          try {
            const v = await Promise.race([
              Promise.resolve(asyncFn()).then((r) => ({ value: r, source: 'async' })),
              new Promise((resolve) => setTimeout(() => resolve({ value: null, source: 'timeout' }), timeoutMs)),
            ]);
            retained = /** @type {{value: any, source: string}} */ (v);
          } catch {
            retained = { value: null, source: 'async-error' };
          }
        }
        if (!retained.value) {
          retained = { value: safe(() => s.getRetained()), source: retained.source === 'none' ? (exact ? 'sync' : 'cached') : `sync-after-${retained.source}` };
        }
        return {
          retained: retained.value,
          retained_source: retained.source,
          loadedPages: safe(() => (Array.isArray(s.getLoadedPages()) ? s.getLoadedPages().length : null)),
          // СПИСОК загруженных страниц (а не только их число): по нему следующий переход
          // классифицируется как попадание в окно кеша или промах — одинаково у H, Q и Z,
          // в том числе там, где перечитывание идёт не по HTTP (Z: повторная материализация).
          // Стоимость одинакова у всех адаптеров (массив ≤ числа страниц документа) и ничего
          // не сканирует, поэтому политика проб (см. шапку файла) не меняется.
          loadedPageIds: safe(() => (Array.isArray(s.getLoadedPages()) ? s.getLoadedPages().slice(0, 1000) : null)),
          drawn: safe(() => s.drawn),
          state: safe(() => s.state),
          activePageId: safe(() => s.activePageId),
          activeRevision: safe(() => s.activeRevision),
        };
      },
      { timeoutMs: RETAINED_ASYNC_TIMEOUT_MS, exact },
    );
  } catch {
    /* страница недоступна */
  }
  // сборка мусора — в фиксированной точке после КАЖДОЙ пробы (одинаково для всех адаптеров):
  // при точной пробе она вдобавок выбрасывает копию строк, созданную самим инструментом
  if (probes?.gc) {
    try {
      await probes.gc();
    } catch {
      /* HeapProfiler недоступен */
    }
  }
  if (exact) sampler?.resume();
  return { ...inPage, heap, net, probe_ms: +(performance.now() - t0).toFixed(1), exact };
}

/**
 * Снимок страницы в момент ПОСЕЩЕНИЯ (сразу после `page-ready`, пока страница ещё удерживается
 * клиентом) — вход эталона по дефекту A11: иначе в режиме P промежуточные переходы не сверяются
 * вовсе (к концу прогона все страницы, кроме последней, вытеснены из окна кеша).
 * Формат снимка и журнала посещений задан в шапке `scripts/reference-check.sh`.
 *
 * Копия 500 фигур в контексте оболочки — это аллокация, созданная ИНСТРУМЕНТОМ: на время выгрузки
 * опрос кучи приостанавливается, после — принудительная сборка мусора (та же пара suspend/gc, что
 * у точных сканов, и одинаковое число раз у всех адаптеров, см. шапку файла).
 * @param {import('playwright').Page} page
 * @param {string|null} pageId
 * @param {ScenarioOptions['probes']} probes
 * @param {ReturnType<typeof startHeapSampler>|null} sampler
 */
async function captureVisitSnapshot(page, pageId, probes, sampler) {
  if (!pageId) return /** @type {any} */ ({ error: 'pageId unknown (no data-page-id and no pageId in page-ready detail)' });
  sampler?.suspend('visit-snapshot');
  try {
    return await page.evaluate((pid) => {
      const s = /** @type {any} */ (window).__stand;
      try {
        const snap = s.getPageSnapshot(pid);
        if (!snap) return { error: 'getPageSnapshot returned null (страница не удерживается клиентом в момент посещения)' };
        return { revision: snap.revision, shapes: snap.shapes };
      } catch (e) {
        return { error: String(/** @type {any} */ (e)?.message ?? e) };
      }
    }, pageId);
  } catch (e) {
    return { error: String(/** @type {any} */ (e)?.message ?? e) };
  } finally {
    if (probes?.gc) {
      try {
        await probes.gc();
      } catch {
        /* HeapProfiler недоступен */
      }
    }
    sampler?.resume();
  }
}

/**
 * Действие в контексте страницы РОВНО в момент `notBeforeT` (часы страницы) — т. е. через
 * объявленную паузу после готовности предыдущего действия, независимо от длительности пробы и
 * задержек CDP (§1.2). Возвращает фактический момент и превышение паузы, если проба не уложилась.
 * @param {import('playwright').Page} page
 * @param {number} notBeforeT
 * @param {{k?: number, command?: {targetId: string, fill: string}}} what
 * @returns {Promise<{t: number, pageId: string|null, opId: string|null, overrun: number}>}
 */
async function actAt(page, notBeforeT, what) {
  return page.evaluate(async ({ notBeforeT, k, command }) => {
    const waitMs = notBeforeT - performance.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    // setTimeout может вернуться на доли миллисекунды раньше срока — добираем остаток
    while (performance.now() < notBeforeT) await new Promise((r) => setTimeout(r, 0));
    if (command) {
      const s = /** @type {any} */ (window).__stand;
      const opId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : null;
      const t = performance.now();
      const p = Promise.resolve().then(() => s.runCommand({ type: 'setSourceFill', targetId: command.targetId, fill: command.fill, ...(opId ? { opId } : {}) }));
      /** @type {any} */ (window).__benchCmd = p.then(
        (r) => ({ ok: true, result: r }),
        (e) => ({ ok: false, error: String(e?.message ?? e) }),
      );
      return { t, pageId: null, opId, overrun: Math.max(0, t - notBeforeT) };
    }
    const el = /** @type {HTMLElement|null} */ (document.querySelector(`[data-page-index="${k}"]`));
    if (!el) throw new Error(`no element [data-page-index="${k}"]`);
    const t = performance.now();
    el.click();
    return { t, pageId: el.getAttribute('data-page-id'), opId: null, overrun: Math.max(0, t - notBeforeT) };
  }, { notBeforeT, k: what.k ?? null, command: what.command ?? null });
}

/**
 * НЕЗАВИСИМАЯ модель времени сценария — по журналу событий страницы, а не по бухгалтерии оболочки
 * (дефект N5: прежняя «сверка» была тождеством, её остаток не мог отличаться от нуля).
 *
 * Модель = t(первый `page-ready`) + Σ по переходам (t(`page-ready`) − t(`page-select`))
 *        + (число объявленных пауз)·pauseMs + (max(`command-acked`, `command-drawn`) − `command-sent`).
 *
 * Все слагаемые взяты ИЗ ЖУРНАЛА: события выбирает сам разбор, а не измеренные оболочкой `t_nav`.
 * Поэтому остаток `t_scenario − model` — настоящая величина: в него входит только время от клика
 * до `page-select` (диспетчеризация в странице, единицы мс) и любое РАСХОЖДЕНИЕ в сопоставлении
 * событий: пропущенный шаг, лишний `page-select`, не та страница, не та команда — всё это сдвигает
 * остаток на десятки-сотни мс. Нулевым по построению он больше не является.
 *
 * @param {any[]} events        журнал `window.__stand.events`
 * @param {{pauses: number, pauseMs: number}} p
 */
export function scenarioModelFromJournal(events, p) {
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.t === 'number').slice().sort((a, b) => a.t - b.t);
  const firstReady = evs.find((e) => e.type === 'page-ready');
  if (!firstReady) return { model: NaN, navs: 0, navSum: 0, firstReady: NaN, cmdMs: NaN, source: 'event-journal' };
  let navSum = 0;
  let navs = 0;
  // пары «page-select → ближайший следующий page-ready»
  for (let i = 0; i < evs.length; i += 1) {
    if (evs[i].type !== 'page-select') continue;
    const ready = evs.slice(i + 1).find((e) => e.type === 'page-ready');
    if (!ready) continue;
    // выбор страницы 0 (открытие документа) не считается переходом: он внутри t_first_ready
    if (ready.t <= firstReady.t) continue;
    navSum += ready.t - evs[i].t;
    navs += 1;
  }
  const sent = evs.find((e) => e.type === 'command-sent');
  const acked = sent ? evs.find((e) => e.type === 'command-acked' && e.t >= sent.t) : undefined;
  const drawn = sent ? evs.find((e) => e.type === 'command-drawn' && e.t >= sent.t) : undefined;
  const cmdEnd = Math.max(acked?.t ?? 0, drawn?.t ?? 0);
  const cmdMs = sent && cmdEnd > 0 ? cmdEnd - sent.t : 0;
  return {
    model: +(firstReady.t + navSum + p.pauses * p.pauseMs + cmdMs).toFixed(3),
    navs,
    navSum: +navSum.toFixed(3),
    firstReady: +firstReady.t.toFixed(3),
    cmdMs: +cmdMs.toFixed(3),
    source: 'event-journal',
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {ScenarioOptions} opts
 */
export async function runAcceptanceScenario(page, opts) {
  const route = opts.route ?? DEFAULT_ROUTE;
  const pauseMs = opts.pauseMs ?? 1000;
  const cmdAfterStep = opts.cmdAfterStep ?? 5;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 20_000;
  const budgets = { ...DEFAULT_BUDGETS, ...(opts.budgets ?? {}) };
  const log = opts.log ?? (() => {});
  const heapIntervalMs = opts.heapIntervalMs ?? DEFAULT_HEAP_INTERVAL_MS;
  const wall0 = performance.now();
  // Принудительная сборка мусора считается: расписание обязано совпадать у всех адаптеров (N2).
  let gcForced = 0;
  let gcFailed = 0;
  const probes = opts.probes?.gc
    ? {
        ...opts.probes,
        gc: async () => {
          try {
            await /** @type {() => Promise<void>} */ (opts.probes?.gc)();
            gcForced += 1;
          } catch (e) {
            gcFailed += 1;
            throw e;
          }
        },
      }
    : (opts.probes ?? {});
  const startedAt = new Date().toISOString();

  const q = new URLSearchParams({ adapter: String(opts.adapter), mode: String(opts.mode), cache: String(opts.cache), doc: opts.doc });
  // Начальная страница задаётся ЯВНО (`?page=`), а не подразумевается «первой по индексу»:
  // в режиме F именно она получает приоритет загрузки (критик A, п. 16).
  const initialPage = opts.initialPage ?? 1;
  q.set('page', String(initialPage));
  /** @type {'page-context'|'query'|'none'} */
  let credentialsVia = 'none';
  if (opts.autologin) {
    q.set('autologin', opts.autologin);
    // Пароль тестовой учётки в production-сборку клиента не входит (§1.6). Передаём его В КОНТЕКСТ
    // СТРАНИЦЫ до загрузки документа (`addInitScript` → `window.__standCredentials`), а НЕ в строке
    // запроса: иначе секрет попадает в журналы доступа, в `Referer`, в счётчики шейпера и в запись
    // прогона (дефект N9). Вход выполняет сама страница тем же POST /api/auth/login.
    const pw = opts.autologinPassword ?? passwordFor(opts.autologin);
    if (pw) {
      try {
        await page.addInitScript(
          (c) => {
            Object.defineProperty(window, '__standCredentials', { value: c, configurable: true, enumerable: false });
          },
          { login: opts.autologin, password: pw },
        );
        credentialsVia = 'page-context';
      } catch {
        // страница не поддерживает addInitScript (фейки в тестах) — запасной канал прежний
        q.set('pass', pw);
        credentialsVia = 'query';
      }
    }
  }
  for (const [k, v] of Object.entries(opts.extraQuery ?? {})) q.set(k, v);
  const url = `${opts.baseUrl.replace(/\/$/, '')}/?${q.toString()}`;

  /** @type {StepRecord[]} */
  const steps = [];
  /** @type {Array<{type: string, text: string}>} */
  const consoleErrors = [];
  /** @type {Map<number, string|null>} */
  const pageIds = new Map();
  const visited = new Set([1]);

  /** @type {any} */
  const rec = {
    outcome: 'ok',
    errorStage: null,
    errorMessage: null,
    url,
    startedAt,
    route,
    pauseMs,
    t_first_ready: NaN,
    /** @type {number[]} */
    t_nav: [],
    /** @type {number[]} */
    t_nav_new: [],
    /** @type {number[]} */
    t_nav_return: [],
    /** переходы, при которых страница УЖЕ удерживалась клиентом (окно кеша сработало) */
    nav_cache_hits: 0,
    /** переходы, потребовавшие загрузки страницы заново (промах окна или устаревшая страница) */
    nav_cache_misses: 0,
    /** HTTP-чтения страниц документа за прогон (CDP; у Z — 0, страницы приходят синхронизацией) */
    page_reads: /** @type {any} */ (null),
    t_cmd_ack: NaN,
    t_cmd_drawn: NaN,
    t_cmd_server: NaN,
    t_cmd_synced: NaN,
    t_cmd_opget: NaN,
    /** инструмент-free: t_scenario_wall − probe_overrun (см. шапку файла) */
    t_scenario: NaN,
    /** сырое: navigationStart → последняя готовность */
    t_scenario_wall: NaN,
    /** сверка: t_first_ready + Σt_nav + пауз·pauseMs + max(t_cmd_ack, t_cmd_drawn) */
    t_scenario_model: NaN,
    t_scenario_model_residual: NaN,
    /** суммарное превышение объявленных пауз измерительной пробой */
    probe_overrun_ms: 0,
    probe_total_ms: 0,
    pauses_declared: 0,
    pauses_declared_ms: 0,
    // политика проб (одинакова для всех адаптеров, см. шапку файла)
    retained_probe: /** @type {any} */ ({ mode: RETAINED_PROBE_POLICY, stepSource: 'cached', exactPoints: [...EXACT_RETAINED_POINTS], downgradedAtStep: null }),
    retained_end_exact: /** @type {any} */ (null),
    heap_sampler: /** @type {any} */ (null),
    /** принудительная сборка мусора: расписание одинаково у всех адаптеров (N2) */
    // Расписание принудительных сборок зависит только от ДЛИНЫ МАРШРУТА (одинаковой у всех
    // конфигураций серии), а не от адаптера: (route+1) шаговых проб + проба после команды +
    // (route+1) снимков посещений + остановка часов + после выгрузки снимков.
    gc: /** @type {any} */ ({
      forced: 0,
      failed: 0,
      available: Boolean(opts.probes?.gc),
      points: `after-every-probe(${route.length + 1} steps + after-command + end) + after-every-visit-snapshot(${route.length + 1}) + scenario-stop + after-final-snapshots`,
      expected: 2 * (route.length + 1) + 4,
    }),
    js_heap_post_gc_mib: NaN,
    initialPage,
    credentialsVia,
    command_timings: /** @type {any[]} */ ([]),
    wall_ms: NaN,
    budgets: { firstReady: null, navAll: null, navEach: /** @type {boolean[]} */ ([]), cmdDrawn: null, scenario: null },
    command: /** @type {any} */ (null),
    steps,
    /** журнал посещений страниц (A11): по записи на каждое посещение, дошедшее до page-ready */
    visits: /** @type {any[]} */ ([]),
    /** снимки посещений (тяжёлые; оболочка пишет их файлами эталону и в runs/<id>.json не кладёт) */
    visitSnapshots: /** @type {any[]} */ ([]),
    snapshots: /** @type {Record<string, any>} */ ({}),
    pageIds: /** @type {Record<string, string|null>} */ ({}),
    retained_end: null,
    retained_end_source: null,
    loaded_pages_end: null,
    retained_pages_max: 0,
    retained_shapes_max: 0,
    js_heap_peak_mib: NaN,
    js_heap_end_mib: NaN,
    client_storage_bytes: null,
    transfer: null,
    events: /** @type {any[]} */ ([]),
    consoleErrors,
    finalState: null,
  };

  page.on('console', (msg) => {
    const t = msg.type();
    if ((t === 'error' || t === 'warning') && consoleErrors.length < 100) consoleErrors.push({ type: t, text: msg.text().slice(0, 500) });
  });
  page.on('pageerror', (err) => {
    if (consoleErrors.length < 100) consoleErrors.push({ type: 'pageerror', text: String(err?.message ?? err).slice(0, 500) });
  });

  const heapSampler = startHeapSampler(probes, heapIntervalMs, opts.probeWindows ?? null);
  /** сколько команд прогона ЗАВЕРШИЛОСЬ (ack + drawn) к текущему моменту — для снимков посещений */
  let commandsCompleted = 0;
  /** страницы, удерживаемые клиентом по итогам ПРЕДЫДУЩЕГО шага (состояние перед следующим кликом) */
  let loadedAfterLastStep = /** @type {Set<string>|null} */ (null);
  /** накопленное число HTTP-чтений страниц на конец предыдущего шага (CDP) */
  let pageReadsSoFar = 0;

  /** @param {any} p */
  const foldProbe = (p) => {
    if (p.retained) {
      rec.retained_pages_max = Math.max(rec.retained_pages_max, Number(p.retained.pages) || 0);
      rec.retained_shapes_max = Math.max(rec.retained_shapes_max, Number(p.retained.shapes) || 0);
    }
    if (p.heap && Number.isFinite(p.heap.usedMib)) rec.js_heap_peak_mib = Math.max(rec.js_heap_peak_mib || 0, p.heap.usedMib);
    rec.probe_total_ms = +(rec.probe_total_ms + (p.probe_ms ?? 0)).toFixed(1);
  };

  /** @param {StepRecord} st */
  const noteStep = async (st) => {
    // шаговая проба — ВСЕГДА дешёвая, у любого адаптера и режима (N2/N4): стоимость точного скана
    // зависит от адаптера, и решение «сканировать или нет» не должно от неё зависеть
    const p = await probe(page, probes, { exact: false, heapSampler });
    st.retained = p.retained;
    st.retained_source = p.retained_source;
    st.retained_pages = p.retained ? Number(p.retained.pages) : null;
    st.retained_shapes = p.retained ? Number(p.retained.shapes) : null;
    st.retained_bytes_synthetic = p.retained && p.retained.bytesEstimate !== undefined ? Number(p.retained.bytesEstimate) : null;
    st.loaded_pages = p.loadedPages;
    st.loaded_page_ids = Array.isArray(p.loadedPageIds) ? p.loadedPageIds : null;
    if (Array.isArray(p.loadedPageIds)) loadedAfterLastStep = new Set(p.loadedPageIds);
    if (p.net && Number.isFinite(p.net.pageReads)) {
      st.page_reads_total = p.net.pageReads;
      st.page_reads_delta = p.net.pageReads - pageReadsSoFar;
      pageReadsSoFar = p.net.pageReads;
    }
    st.drawn = p.drawn;
    st.heap = p.heap;
    st.probe_ms = p.probe_ms;
    st.js_heap_mb = p.heap && Number.isFinite(p.heap.usedMib) ? +((p.heap.usedMib * 1024 * 1024) / 1e6).toFixed(2) : null;
    foldProbe(p);
    steps.push(st);
    // снимок ЭТОГО посещения — пока страница ещё в окне кеша (A11); `afterCommands` фиксирует
    // момент: посещения до команды сверяются с состоянием до неё, после — после
    const seq = rec.visits.length;
    const afterCommands = commandsCompleted;
    const vs = /** @type {{revision?: number, shapes?: any[], error?: string}} */ (await captureVisitSnapshot(page, st.page_id, probes, heapSampler));
    rec.visits.push({ seq, step: st.step, pageIndex: st.page_index, pageId: st.page_id, afterCommands, revision: vs.revision ?? null, shapeCount: Array.isArray(vs.shapes) ? vs.shapes.length : null, error: vs.error ?? null });
    rec.visitSnapshots.push(vs.error ? { pageId: st.page_id, visitSeq: seq, afterCommands, error: vs.error } : { pageId: st.page_id, visitSeq: seq, afterCommands, revision: vs.revision, shapes: vs.shapes });
    st.visit_seq = seq;
  };

  /**
   * Превышение объявленной паузы (проба не уложилась) — в шаг и в сумму прогона.
   * Накапливается: после шага команды к последнему шагу относятся ДВЕ паузы (перед командой и
   * перед следующим переходом), и вторая не должна затирать первую.
   */
  const noteOverrun = (/** @type {number} */ overrun) => {
    const ms = Math.max(0, Number(overrun) || 0);
    const last = steps[steps.length - 1];
    if (last) last.probe_overrun_ms = +((last.probe_overrun_ms ?? 0) + ms).toFixed(1);
    rec.probe_overrun_ms = +(rec.probe_overrun_ms + ms).toFixed(1);
  };

  /** @param {string} stage @param {unknown} err */
  const fail = (stage, err) => {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    rec.outcome = /timeout|Timeout/.test(msg) ? 'timeout' : 'error';
    rec.errorStage = stage;
    rec.errorMessage = msg.slice(0, 1000);
    log(`  ✖ ${stage}: ${rec.errorMessage}`);
  };

  /** Заключительные пробы, доступные и при ошибке. Выполняются ПОСЛЕ остановки часов сценария. */
  const finalize = async () => {
    // JS-куча «в конце сценария» — до заключительного скана хранилища и до выгрузки снимков,
    // чтобы в неё не попали копии, созданные инструментом
    if (probes.heap && !Number.isFinite(rec.js_heap_end_mib)) {
      try {
        const h = await probes.heap();
        rec.js_heap_end_mib = h.usedMib;
        heapSampler.note(h);
      } catch {
        /* нет CDP */
      }
    }
    rec.heap_sampler = heapSampler.stop();
    if (Number.isFinite(rec.heap_sampler.peak_mib)) rec.js_heap_peak_mib = Math.max(rec.js_heap_peak_mib || 0, rec.heap_sampler.peak_mib);
    // покрытие сэмплера кучи: доля времени сценария, реально попавшая в выборку (окна приостановки
    // у адаптеров разной длительности, поэтому пик кучи сравним только вместе с этой долей)
    if (Number.isFinite(rec.t_scenario_wall) && rec.t_scenario_wall > 0) {
      rec.heap_sampler.coverage = +Math.min(1, (rec.heap_sampler.samples * rec.heap_sampler.interval_ms) / rec.t_scenario_wall).toFixed(4);
    } else {
      rec.heap_sampler.coverage = null;
    }
    // конечный retained — ВСЕГДА точный скан (getRetainedAsync), часы сценария уже остановлены
    const endProbe = await probe(page, probes, { exact: true, heapSampler, heap: false });
    if (endProbe.retained) {
      // точный скан в общей для всех адаптеров точке — сравнимая величина (в отличие от шаговых)
      if (endProbe.retained_source === 'async') rec.retained_end_exact = { pages: Number(endProbe.retained.pages), shapes: Number(endProbe.retained.shapes) };
      rec.retained_pages_max = Math.max(rec.retained_pages_max, Number(endProbe.retained.pages) || 0);
      rec.retained_shapes_max = Math.max(rec.retained_shapes_max, Number(endProbe.retained.shapes) || 0);
    }
    try {
      rec.command_timings = await page.evaluate(() => {
        const s = /** @type {any} */ (window).__stand;
        try {
          return typeof s?.getCommandTimings === 'function' ? s.getCommandTimings() : [];
        } catch {
          return [];
        }
      });
    } catch {
      /* страница мертва */
    }
    try {
      const tail = await page.evaluate(async () => {
        const s = /** @type {any} */ (window).__stand;
        /** @param {() => any} f */
        const safe = (f) => {
          try {
            return f();
          } catch {
            return null;
          }
        };
        let storage = null;
        try {
          let ls = 0;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) ?? '';
            ls += k.length + (localStorage.getItem(k)?.length ?? 0);
          }
          let ss = 0;
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i) ?? '';
            ss += k.length + (sessionStorage.getItem(k)?.length ?? 0);
          }
          let idb = null;
          try {
            const est = await navigator.storage?.estimate?.();
            idb = est?.usage ?? null;
          } catch {
            idb = null;
          }
          storage = { localStorageChars: ls, sessionStorageChars: ss, storageEstimateBytes: idb, total: (idb ?? 0) + 2 * (ls + ss) };
        } catch {
          storage = null;
        }
        return {
          events: safe(() => (Array.isArray(s?.events) ? s.events.slice(0, 5000) : [])),
          state: safe(() => s?.state),
          retained: safe(() => s?.getRetained()),
          loadedPages: safe(() => (Array.isArray(s?.getLoadedPages()) ? s.getLoadedPages().length : null)),
          transfer: safe(() => s?.transfer ?? null),
          pendingCommands: safe(() => s?.pendingCommands),
          storage,
        };
      });
      // независимая модель времени сценария — по журналу страницы (см. scenarioModelFromJournal)
      const m = scenarioModelFromJournal(tail.events ?? [], { pauses: rec.pauses_declared, pauseMs });
      rec.t_scenario_model = m.model;
      rec.t_scenario_model_detail = m;
      rec.t_scenario_model_residual = Number.isFinite(rec.t_scenario) && Number.isFinite(m.model) ? +(rec.t_scenario - m.model).toFixed(3) : NaN;
      rec.events = opts.keepEvents === false ? [] : tail.events;
      rec.finalState = { state: tail.state, pendingCommands: tail.pendingCommands };
      rec.retained_end = endProbe.retained ?? tail.retained;
      rec.retained_end_source = endProbe.retained ? endProbe.retained_source : 'sync';
      rec.loaded_pages_end = tail.loadedPages;
      rec.transfer = tail.transfer;
      rec.client_storage_bytes = tail.storage?.total ?? null;
      rec.client_storage = tail.storage;
    } catch {
      /* страница мертва */
    }
    rec.wall_ms = Math.round(performance.now() - wall0);
    // итог по чтениям страниц (CDP): сколько раз и какие страницы читались по HTTP за прогон
    try {
      const net = probes?.net ? probes.net() : null;
      if (net && Number.isFinite(net.pageReads)) {
        rec.page_reads = {
          total: net.pageReads,
          distinct_pages: net.pageReadsDistinct ?? null,
          bytes: net.pageReadBytes ?? null,
          by_page: net.pageReadsByPage ?? null,
        };
      }
    } catch {
      /* CDP отсоединён */
    }
    rec.pageIds = Object.fromEntries([...pageIds.entries()].map(([k, v]) => [String(k), v]));
    // итог по сборке мусора: число вызовов обязано совпадать у всех адаптеров (проверяется в анализе)
    rec.gc.forced = gcForced;
    rec.gc.failed = gcFailed;
    return rec;
  };

  // ---- 0. открытие документа -------------------------------------------------------
  try {
    log(`  open ${url}`);
    await page.goto(url, { waitUntil: 'commit', timeout: stepTimeoutMs });
    await page.waitForFunction(() => !!(/** @type {any} */ (window).__stand), null, { timeout: stepTimeoutMs });
  } catch (err) {
    fail('open', err);
    return finalize();
  }
  try {
    const ev = await waitForStandEvent(page, { type: 'page-ready', sinceT: 0, pageIndex: 1, timeoutMs: stepTimeoutMs });
    const pid = ev.detail?.pageId ?? (await pageIdFromDom(page, 1)) ?? (await activePageId(page));
    pageIds.set(1, pid);
    rec.t_first_ready = ev.t;
    rec.budgets.firstReady = ev.t <= budgets.firstReadyMs;
    log(`  first-ready ${ev.t.toFixed(0)} ms`);
    await noteStep({ step: 0, action: 'open', page_index: 1, page_id: pid, is_return: false, t_click: 0, t_select: null, t_ready: ev.t, t_ms: ev.t, budget_ok: ev.t <= budgets.firstReadyMs, retained: null, retained_pages: null, retained_shapes: null, loaded_pages: null, js_heap_mb: null, heap: null, drawn: null });
  } catch (err) {
    fail('first_ready', err);
    return finalize();
  }

  // ---- 1..N. переходы (+ команда после cmdAfterStep) -------------------------------
  // `anchorT` — момент готовности предыдущего действия в часах страницы; следующее действие
  // выполняется ровно в `anchorT + pauseMs` (§1.2), сколько бы ни заняла измерительная проба.
  let lastReadyT = rec.t_first_ready;
  let anchorT = rec.t_first_ready;
  for (let i = 0; i < route.length; i++) {
    const k = route[i];
    const stepNo = i + 1;
    const isReturn = visited.has(k);
    /** @type {{t: number, pageId: string|null, overrun: number}} */
    let click;
    try {
      rec.pauses_declared += 1;
      click = await actAt(page, anchorT + pauseMs, { k });
      noteOverrun(click.overrun);
    } catch (err) {
      fail(`nav_${stepNo}_click`, err);
      return finalize();
    }
    const knownId = click.pageId ?? pageIds.get(k) ?? null;
    try {
      const ev = await waitForStandEvent(page, { type: 'page-ready', sinceT: click.t, pageIndex: k, pageId: knownId, timeoutMs: stepTimeoutMs });
      const pid = knownId ?? ev.detail?.pageId ?? (await activePageId(page));
      pageIds.set(k, pid);
      visited.add(k);
      let tSelect = NaN;
      try {
        const sel = await page.evaluate(
          ({ since, k, pid }) => {
            const s = /** @type {any} */ (window).__stand;
            const e = (s.events ?? []).find(
              (/** @type {any} */ e) => e.type === 'page-select' && e.t >= since - 1 && (e.detail?.pageId === pid || Number(e.detail?.pageIndex ?? e.detail?.index) === k || (!e.detail?.pageId && e.detail?.pageIndex === undefined)),
            );
            return e ? e.t : null;
          },
          { since: click.t, k, pid },
        );
        if (typeof sel === 'number') tSelect = sel;
      } catch {
        /* необязательно */
      }
      const ms = ev.t - click.t;
      const ok = ms <= budgets.navMs;
      rec.t_nav.push(ms);
      (isReturn ? rec.t_nav_return : rec.t_nav_new).push(ms);
      rec.budgets.navEach.push(ok);
      // Попадание в окно кеша: удерживал ли клиент страницу ПО ИТОГАМ ПРОШЛОГО ШАГА (состояние
      // до клика; сам клик его задним числом не меняет). `is_return` — свойство маршрута,
      // `was_loaded` — свойство кеша; их расхождение и есть повторное чтение. У H/Q то же самое
      // видно прямым счётчиком HTTP-чтений (`page_reads_delta`), у Z — только так.
      const wasLoaded = loadedAfterLastStep && pid ? loadedAfterLastStep.has(pid) : null;
      if (wasLoaded === true) rec.nav_cache_hits += 1;
      else if (wasLoaded === false) rec.nav_cache_misses += 1;
      lastReadyT = ev.t;
      anchorT = ev.t;
      log(`  nav[${stepNo}] page ${k}${isReturn ? ' (return)' : ''}${wasLoaded === true ? ' [cached]' : wasLoaded === false ? ' [load]' : ''}: ${ms.toFixed(0)} ms`);
      await noteStep({ step: stepNo, action: 'nav', page_index: k, page_id: pid, is_return: isReturn, was_loaded: wasLoaded, t_click: click.t, t_select: Number.isFinite(tSelect) ? tSelect : null, t_ready: ev.t, t_ms: ms, budget_ok: ok, retained: null, retained_pages: null, retained_shapes: null, loaded_pages: null, js_heap_mb: null, heap: null, drawn: null });
    } catch (err) {
      fail(`nav_${stepNo}`, err);
      return finalize();
    }

    if (stepNo === cmdAfterStep) {
      /** @type {{t: number, opId: string|null, overrun: number}} */
      let sent;
      try {
        rec.pauses_declared += 1;
        sent = await actAt(page, anchorT + pauseMs, { command: { targetId: opts.sourceId, fill: opts.fill } });
        noteOverrun(sent.overrun);
      } catch (err) {
        fail('cmd_send', err);
        return finalize();
      }
      rec.command = { type: 'setSourceFill', targetId: opts.sourceId, fill: opts.fill, opId: sent.opId, tSent: sent.t, afterStep: cmdAfterStep, result: null, error: null };
      // command-drawn фиксируется по ФАКТИЧЕСКОЙ отрисовке и может опередить подтверждение сервера
      // (у Z — обычный случай: ack включает чтение журнала операций). Порядок не навязывается:
      // оба момента ждутся ПАРАЛЛЕЛЬНО, и наступивший записывается, даже если второй не наступил.
      // Последовательное ожидание теряло бы уже измеренный момент (например, ack при зависшей
      // отрисовке) и молча отдавало бы пустую колонку вместо имеющегося измерения.
      const [drawnRes, ackRes] = await Promise.allSettled([
        waitForStandEvent(page, { type: 'command-drawn', sinceT: sent.t, opId: sent.opId, timeoutMs: stepTimeoutMs }),
        waitForStandEvent(page, { type: 'command-acked', sinceT: sent.t, opId: sent.opId, timeoutMs: stepTimeoutMs }),
      ]);
      if (drawnRes.status === 'fulfilled') {
        const drawn = drawnRes.value;
        rec.t_cmd_drawn = drawn.t - sent.t;
        rec.command.tDrawn = drawn.t;
        rec.command.drawnBeforeAck = drawn.detail?.beforeAck ?? null;
        rec.command.drawnRevision = drawn.detail?.drawnRevision ?? null;
        rec.budgets.cmdDrawn = rec.t_cmd_drawn <= budgets.cmdDrawnMs;
        log(`  cmd drawn ${rec.t_cmd_drawn.toFixed(0)} ms${drawn.detail?.beforeAck ? ' (до ack)' : ''}`);
      }
      if (ackRes.status === 'fulfilled') {
        const ack = ackRes.value;
        rec.t_cmd_ack = ack.t - sent.t;
        rec.command.tAcked = ack.t;
        log(`  cmd acked ${rec.t_cmd_ack.toFixed(0)} ms`);
      }
      if (drawnRes.status === 'rejected') {
        fail('cmd_drawn', drawnRes.reason);
        return finalize();
      }
      if (ackRes.status === 'rejected') {
        fail('cmd_ack', ackRes.reason);
        return finalize();
      }
      // подтверждение транспорта (Z — `.server`, H/Q — ответ POST) и появление данных в хранилище:
      // необязательные моменты, их отсутствие не делает прогон ошибочным
      try {
        const srv = await waitForStandEvent(page, { type: 'command-server', sinceT: sent.t, opId: sent.opId, timeoutMs: 1000 });
        rec.t_cmd_server = srv.t - sent.t;
        rec.command.tServer = srv.t;
        rec.t_cmd_opget = +(rec.t_cmd_ack - rec.t_cmd_server).toFixed(3);
      } catch {
        /* адаптер не сообщает этот момент */
      }
      try {
        const syn = await waitForStandEvent(page, { type: 'command-synced', sinceT: sent.t, opId: sent.opId, timeoutMs: 1000 });
        rec.t_cmd_synced = syn.t - sent.t;
        rec.command.tSynced = syn.t;
      } catch {
        /* адаптер не сообщает этот момент */
      }
      // «действие завершено» = подтверждение сервера И актуальный холст (SPEC §4.2) —
      // от этого момента отсчитывается объявленная пауза перед следующим переходом
      commandsCompleted += 1;
      const cmdDoneT = Math.max(rec.command.tAcked ?? 0, rec.command.tDrawn ?? 0);
      lastReadyT = Math.max(lastReadyT, cmdDoneT);
      anchorT = cmdDoneT;
      try {
        const res = await page.evaluate(
          (timeoutMs) =>
            Promise.race([
              /** @type {any} */ (window).__benchCmd,
              new Promise((_, rej) => setTimeout(() => rej(new Error(`runCommand promise not settled in ${timeoutMs} ms`)), timeoutMs)),
            ]),
          stepTimeoutMs,
        );
        if (res.ok) rec.command.result = res.result;
        else {
          rec.command.error = res.error;
          fail('cmd_result', new Error(res.error));
          return finalize();
        }
      } catch (err) {
        fail('cmd_result', err);
        return finalize();
      }
      // после команды — ВСЕГДА точный скан хранилища (внутри объявленной паузы перед следующим шагом)
      const p = await probe(page, probes, { exact: true, heapSampler });
      rec.command.after = { retained: p.retained, loadedPages: p.loadedPages, heap: p.heap, drawn: p.drawn, activeRevision: p.activeRevision, probe_ms: p.probe_ms };
      foldProbe(p);
    }
  }

  rec.t_scenario_wall = lastReadyT;
  rec.t_scenario = +(lastReadyT - rec.probe_overrun_ms).toFixed(3);
  rec.pauses_declared_ms = rec.pauses_declared * pauseMs;
  rec.budgets.scenario = rec.t_scenario <= budgets.scenarioMs;
  rec.budgets.navAll = rec.budgets.navEach.every(Boolean);
  // JS-куча «в конце сценария» — здесь, пока не выполнены выгрузка снимков и конечный скан хранилища
  if (probes.heap) {
    try {
      const h = await probes.heap();
      rec.js_heap_end_mib = h.usedMib;
      heapSampler.note(h);
    } catch {
      /* нет CDP */
    }
    // ФИКСИРОВАННАЯ точка «после сборки мусора», одинаковая для всех адаптеров: величина, не
    // зависящая от того, когда сборщик решил сработать сам (§7.3, дефект N2). В пик не входит.
    if (probes.gc) {
      try {
        await probes.gc();
        const h2 = await probes.heap();
        rec.js_heap_post_gc_mib = h2.usedMib;
      } catch {
        /* HeapProfiler недоступен */
      }
    }
  }
  if (rec.command === null && cmdAfterStep <= route.length) {
    fail('cmd_missing', new Error('command step was not reached'));
  }

  // ---- снимки посещённых страниц для эталона -------------------------------------------
  // выгрузка копирует до 11 × 500 фигур в контекст оболочки — на это время опрос кучи приостановлен
  heapSampler.suspend('final-snapshots');
  try {
    const wanted = [...new Set([1, ...route])];
    for (const k of wanted) {
      let pid = pageIds.get(k) ?? (await pageIdFromDom(page, k));
      if (pid) pageIds.set(k, pid);
      const snap = pid
        ? await page.evaluate((pid) => {
            const s = /** @type {any} */ (window).__stand;
            try {
              return s.getPageSnapshot(pid) ?? null;
            } catch (e) {
              return { error: String(/** @type {any} */ (e)?.message ?? e) };
            }
          }, pid)
        : { error: 'pageId unknown (no data-page-id and no pageId in page-ready detail)' };
      rec.snapshots[String(k)] = { pageIndex: k, pageId: pid ?? null, snapshot: snap };
    }
  } catch (err) {
    fail('snapshots', err);
  } finally {
    if (probes.gc) {
      try {
        await probes.gc();
      } catch {
        /* HeapProfiler недоступен */
      }
    }
    heapSampler.resume();
  }
  return finalize();
}
