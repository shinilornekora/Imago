// @ts-check
/**
 * Окна измерительных проб ИНСТРУМЕНТА (дефект «пик памяти содержит собственную пробу»).
 *
 * Точный скан клиентского хранилища (`getRetainedAsync()`), выгрузка снимков посещений и
 * заключительная выгрузка — это работа ОБОЛОЧКИ, а не адаптера: она материализует в странице
 * копию строк (у Z на 50×500 — ≈25 000 объектов, медиана 955 мс) и поднимает и JS-кучу, и
 * частную память процессов Chromium. Сэмплер кучи на эти окна приостанавливался всегда, а
 * сэмплеры `/proc` (Chromium и серверные группы) — нет, поэтому `chromium_private_peak_mib`
 * у Z/F содержал пробу, а у H/Q — почти нет (их скан на порядок дешевле). Сравнение адаптеров
 * по такому пику измеряло инструмент.
 *
 * Реестр ниже — ЕДИНСТВЕННЫЙ источник окон для всех сэмплеров: сценарий открывает окно там же,
 * где приостанавливает сэмплер кучи (`startHeapSampler().suspend()`), а сэмплеры `/proc` помечают
 * выборки, попавшие внутрь окна, полем `probe:true` и ведут ВТОРОЙ пик — по выборкам вне окон.
 * Политика поэтому одна и та же у любого адаптера, режима и серии; публикуются обе величины
 * (`*_excl_probe_*` и сырая), и по сохранённым `samples[]` + `windows[]` пересчёт возможен извне.
 *
 * Вложенность допускается (окно внутри окна) и схлопывается в одно внешнее окно: моменты
 * begin/end считаются по глубине, как у `suspend/resume` сэмплера кучи.
 *
 * Время — абсолютное `performance.now()` процесса оболочки: те же часы, что у сэмплеров
 * (`ProcSample.t` = t − sampler_t0_ms), поэтому окна и выборки сопоставимы без пересчёта.
 */

import { performance } from 'node:perf_hooks';

/**
 * @typedef {object} ProbeWindow
 * @property {string} label     метка внешнего окна ('exact-retained', 'visit-snapshot', 'final-snapshots')
 * @property {number} t0        абсолютное performance.now() начала
 * @property {number} t1        абсолютное performance.now() конца (или NaN, пока окно открыто)
 * @property {number} ms
 */

/**
 * @typedef {object} ProbeWindows
 * @property {(label?: string) => void} begin
 * @property {() => void} end
 * @property {() => boolean} active
 * @property {() => number} generation
 * @property {() => {count: number, total_ms: number, open: boolean, windows: ProbeWindow[], by_label: Record<string, {count: number, ms: number}>}} summary
 */

/**
 * @param {{keepWindows?: boolean}} [opts]
 * @returns {ProbeWindows}
 */
export function createProbeWindows(opts = {}) {
  const keep = opts.keepWindows ?? true;
  let depth = 0;
  let gen = 0;
  let start = 0;
  let label = '';
  let totalMs = 0;
  let count = 0;
  /** @type {ProbeWindow[]} */
  const windows = [];
  /** @type {Record<string, {count: number, ms: number}>} */
  const byLabel = {};
  return {
    begin(l = 'probe') {
      gen += 1;
      if (depth++ === 0) {
        start = performance.now();
        label = l;
      }
    },
    end() {
      gen += 1;
      if (depth <= 0) {
        depth = 0;
        return;
      }
      if (--depth === 0) {
        const t1 = performance.now();
        const ms = t1 - start;
        totalMs += ms;
        count += 1;
        const agg = (byLabel[label] ??= { count: 0, ms: 0 });
        agg.count += 1;
        agg.ms = +(agg.ms + ms).toFixed(1);
        if (keep) windows.push({ label, t0: start, t1, ms: +ms.toFixed(1) });
      }
    },
    active: () => depth > 0,
    /** счётчик изменений: выборка, снятая «через» begin/end, тоже считается попавшей в окно */
    generation: () => gen,
    summary: () => ({
      count,
      total_ms: +totalMs.toFixed(1),
      open: depth > 0,
      windows: keep ? windows.map((w) => ({ ...w })) : [],
      by_label: JSON.parse(JSON.stringify(byLabel)),
    }),
  };
}

/**
 * Помощник для сэмплеров: снять «метку до опроса» и узнать, пересеклась ли выборка с окном пробы.
 * Опрос `/proc` по всем процессам занимает десятки миллисекунд, поэтому недостаточно проверить
 * `active()` один раз: окно могло открыться и закрыться внутри опроса (тогда меняется generation).
 * @param {ProbeWindows|null|undefined} pw
 */
export function probeMark(pw) {
  if (!pw) return null;
  return { gen: pw.generation(), active: pw.active() };
}

/**
 * @param {ProbeWindows|null|undefined} pw
 * @param {{gen: number, active: boolean}|null} mark
 * @returns {boolean} выборка попала в окно измерительной пробы инструмента
 */
export function probeTouched(pw, mark) {
  if (!pw || !mark) return false;
  return mark.active || pw.active() || pw.generation() !== mark.gen;
}
