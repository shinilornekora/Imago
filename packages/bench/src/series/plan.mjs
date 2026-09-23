// @ts-check
/**
 * План серии: детерминированное перемешивание конфигураций в каждом повторении (SPEC §7.4).
 * PRNG — mulberry32 от (seed, repetition); тасование — Fisher–Yates. План не зависит от
 * фильтра --only и от того, какие прогоны уже выполнены: order_index и run_id стабильны.
 */

/**
 * @typedef {object} RunConfig
 * @property {'H'|'Q'|'Z'|string} adapter
 * @property {'F'|'P'|string} mode
 * @property {number} cache
 * @property {string} [variant]    вариант команды (серия `command-shape`): входит в ключ и run_id
 * @property {string} [sourceId]   источник команды варианта (перекрывает `series.sourceId`)
 * @property {string} [fill]       цвет команды варианта (перекрывает `series.fill`)
 */

/**
 * @typedef {object} PlannedRun
 * @property {string} run_id
 * @property {number} order_index     сквозной номер в перемешанной серии (0..)
 * @property {number} repetition      0..N-1
 * @property {number} position        позиция внутри повторения (0..configs-1)
 * @property {RunConfig} config
 */

/** @param {number} a */
export function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed для повторения: смешиваем seed серии и номер повторения (FNV-подобно), чтобы
 * повторения давали разные, но воспроизводимые перестановки.
 * @param {number} seed
 * @param {number} repetition
 */
export function repetitionSeed(seed, repetition) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (repetition + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** @param {RunConfig} c */
export function configKey(c) {
  return `${c.adapter}:${c.mode}:${c.cache}${c.variant ? `:${c.variant}` : ''}`;
}

/**
 * Короткая метка варианта команды для run_id: буквы/цифры, до 8 символов
 * (`concentrated` → `conc`, задаётся в серии полем `variant`).
 * @param {string} v
 */
export function variantTag(v) {
  return String(v)
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 8);
}

/**
 * @param {{name: string, configs: RunConfig[], repetitions: number, seed: number}} series
 * @param {{repetitions?: number}} [over]
 * @returns {PlannedRun[]}
 */
export function buildPlan(series, over = {}) {
  const reps = over.repetitions ?? series.repetitions;
  /** @type {PlannedRun[]} */
  const plan = [];
  let order = 0;
  for (let r = 0; r < reps; r++) {
    const rng = mulberry32(repetitionSeed(series.seed, r));
    const perm = shuffle(series.configs, rng);
    perm.forEach((config, position) => {
      plan.push({
        run_id: `${series.name}-${String(order).padStart(4, '0')}-${config.adapter}${config.mode}${config.cache}${config.variant ? `-${variantTag(config.variant)}` : ''}`,
        order_index: order,
        repetition: r,
        position,
        config,
      });
      order++;
    });
  }
  return plan;
}

/**
 * Фильтр --only: 'H:P:1' | 'H:P' | 'H' | список через запятую.
 * @param {PlannedRun[]} plan
 * @param {string | undefined | null} only
 */
export function filterPlan(plan, only) {
  if (!only) return plan;
  const wants = only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':'));
  return plan.filter((p) =>
    wants.some(
      ([a, m, c, v]) =>
        (!a || a === '*' || a === p.config.adapter) &&
        (!m || m === '*' || m === p.config.mode) &&
        (!c || c === '*' || Number(c) === p.config.cache) &&
        (!v || v === '*' || v === (p.config.variant ?? '')),
    ),
  );
}
