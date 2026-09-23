// @ts-check
/**
 * Сэмплер ресурсов серверных процессов через /proc (SPEC §7.3): CPU (utime+stime),
 * частная память (smaps_rollup Private_Clean+Private_Dirty, fallback RSS), диск каталога.
 * Группы задаются pid'ами или регулярками на cmdline; потомки (например, backend'ы
 * PostgreSQL — дети postmaster'а) находятся по ppid и включаются в группу.
 *
 * CPU считается как Σ по всем когда-либо виденным процессам группы
 * (последнее известное значение − первое известное), поэтому короткоживущие процессы
 * (backend'ы) не теряются при завершении; недооценка — не более одного интервала опроса.
 * Интеграл памяти — Σ private_MiB × Δt по фактическим интервалам.
 */

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { clockTicks, descendants, dirSizeBytes, findPidsByCmdline, parentMap, readCmdline, readMemory, readPidFile, readStat, selfProcessTree } from './procfs.mjs';
import { probeMark, probeTouched } from './probe-windows.mjs';

/**
 * @typedef {object} ProcGroupSpec
 * @property {string} name
 * @property {number[]} [pids]
 * @property {string} [pidFile]                      pidfile процесса-корня (например, results/logs/api.pid); читается на каждом опросе,
 *                                                   относительный путь — от rootDir (см. startProcSampler) или cwd
 * @property {(string|RegExp)[]} [patterns]         регулярки на cmdline
 * @property {(string|RegExp)[]} [exclude]          регулярки-исключения на cmdline; применяются и к потомкам
 * @property {string|RegExp} [cwd]                   регулярка на рабочий каталог процесса (`/proc/<pid>/cwd`) для patterns
 * @property {boolean} [includeChildren]            по умолчанию true
 * @property {boolean} [allowSelfTree]               разрешить процессы из дерева самой оболочки (её предки/потомки);
 *                                                   по умолчанию false — защита от учёта Chromium/shell как «сервера»
 * @property {string} [dir]                          каталог, размер которого измерять (реплика zero-cache)
 * @property {string[]} [adapters]                   (серия) группа входит в БЮДЖЕТ этих адаптеров; сэмплируется она в
 *                                                  любом прогоне (§1.2), сам сэмплер поле игнорирует
 * @property {boolean} [essential]                   (серия) отсутствие совпадений делает прогон ошибочным, а не просто неполным;
 *                                                   по умолчанию true для групп api/pg/zero. Сам сэмплер поле игнорирует
 */

/**
 * @typedef {object} ProcSample
 * @property {number} t            мс от старта сэмплера
 * @property {number} pids         число процессов группы в момент опроса
 * @property {number} cpuMs        накопленное CPU группы с начала (мс)
 * @property {number} privateMib
 * @property {number} rssMib
 * @property {number} [dirBytes]
 * @property {true} [probe]      выборка пересеклась с окном измерительной пробы инструмента
 *                               (точный скан хранилища / выгрузка снимков) — см. sampling/probe-windows.mjs
 */

/**
 * @typedef {object} ProcGroupSummary
 * @property {string} name
 * @property {number[]} pids                     все pid, попавшие в группу за время наблюдения
 * @property {boolean} matched                   хотя бы один опрос нашёл процесс группы; при false ВСЕ числовые
 *                                               показатели ниже — нули «по построению», а не измерение
 *                                               (см. `unmatched_reason`; критик B, п. 15)
 * @property {boolean} partial                   группа найдена лишь в части опросов (< PARTIAL_COVERAGE):
 *                                               cpu_ms и mem_integral_mib_s заведомо занижены (дефект N6)
 * @property {number} coverage                   matched_ticks / expected_ticks, 0..1
 * @property {string | null} unmatched_reason
 * @property {number} matched_ticks              число опросов, в которых группа была непуста
 * @property {number} expected_ticks             сколько всего было опросов
 * @property {number} cpu_ms
 * @property {number} cpu_user_ms
 * @property {number} cpu_sys_ms
 * @property {number} mem_peak_mib                  СЫРОЙ пик: по всем выборкам, включая окна проб инструмента
 * @property {number | null} mem_peak_excl_probe_mib пик по выборкам ВНЕ окон проб инструмента (null — таких выборок нет)
 * @property {number} probe_ticks                    сколько выборок пришлось на окна проб
 * @property {number} mem_end_mib
 * @property {number} mem_integral_mib_s
 * @property {number} rss_peak_mib
 * @property {number | null} disk_start_bytes
 * @property {number | null} disk_end_bytes
 * @property {number | null} disk_peak_bytes
 * @property {boolean} mem_fallback_rss           хотя бы раз smaps_rollup был недоступен
 * @property {number} sample_count
 * @property {number} duration_s
 * @property {number} sampler_t0_ms   абсолютное performance.now() старта сэмплера (сопоставление с окнами проб)
 * @property {ProcSample[]} samples
 */

const MIB = 1024 * 1024;

/** Ниже этой доли опросов, в которых группа найдена, измерение считается частичным (дефект N6). */
export const PARTIAL_COVERAGE = 0.9;

/**
 * Какие процессы сейчас попали бы в группы (для --dry-run / проверки паттернов).
 * @param {ProcGroupSpec[]} specs
 * @returns {Record<string, Array<{pid: number, cmdline: string}>>}
 */
export function resolveGroups(specs) {
  const parents = parentMap();
  const selfTree = selfProcessTree(parents);
  /** @type {Set<number>} */
  const taken = new Set();
  /** @type {Record<string, Array<{pid: number, cmdline: string}>>} */
  const out = {};
  for (const spec of specs) {
    out[spec.name] = [];
    for (const pid of groupPids(spec, parents, taken, selfTree)) {
      taken.add(pid);
      out[spec.name].push({ pid, cmdline: readCmdline(pid).slice(0, 160) });
    }
  }
  return out;
}

/**
 * Множество pid группы на текущий момент: явные pids + совпадения по cmdline (+ потомки),
 * минус уже занятые другими группами и (если не allowSelfTree) дерево оболочки.
 * @param {ProcGroupSpec} spec
 * @param {Map<number, number>} parents
 * @param {Set<number>} taken
 * @param {Set<number>} selfTree
 * @returns {Set<number>}
 */
function groupPids(spec, parents, taken, selfTree) {
  const excluded = spec.allowSelfTree ? taken : new Set([...taken, ...selfTree]);
  /** @type {Set<number>} */
  let pids = new Set(spec.pids ?? []);
  if (spec.pidFile) {
    const p = readPidFile(spec.pidFile);
    if (p !== null) pids.add(p);
  }
  if (spec.patterns?.length) for (const p of findPidsByCmdline(spec.patterns, { exclude: spec.exclude, excludePids: excluded, cwd: spec.cwd })) pids.add(p);
  if (spec.includeChildren !== false) {
    pids = descendants(pids, parents);
    // исключения по cmdline действуют и на потомков (например, backend'ы PostgreSQL чужого клиента)
    if (spec.exclude?.length) {
      const exc = spec.exclude.map((p) => (typeof p === 'string' ? new RegExp(p) : p));
      for (const p of pids) if (exc.some((r) => r.test(readCmdline(p)))) pids.delete(p);
    }
  }
  for (const p of excluded) pids.delete(p);
  if (!spec.allowSelfTree) pids.delete(process.pid);
  return pids;
}

/**
 * Краткое описание спецификации группы для сообщений об ошибке.
 * @param {ProcGroupSpec} spec
 */
export function describeSpec(spec) {
  const parts = [];
  if (spec.pids?.length) parts.push(`pids=${spec.pids.join(',')}`);
  if (spec.pidFile) parts.push(`pidFile=${spec.pidFile}`);
  if (spec.patterns?.length) parts.push(`patterns=${spec.patterns.map(String).join('|')}`);
  if (spec.dir) parts.push(`dir=${spec.dir}`);
  return parts.join(' ') || '(пустая спецификация)';
}

/**
 * Привести пути в спецификациях групп (pidFile, dir) к абсолютным относительно rootDir.
 * @param {ProcGroupSpec[]} specs
 * @param {string} rootDir
 * @returns {ProcGroupSpec[]}
 */
export function resolveGroupPaths(specs, rootDir) {
  return specs.map((s) => ({
    ...s,
    ...(s.pidFile ? { pidFile: path.resolve(rootDir, s.pidFile) } : {}),
    ...(s.dir ? { dir: path.resolve(rootDir, s.dir) } : {}),
  }));
}

/**
 * @param {{groups: ProcGroupSpec[], intervalMs?: number, keepSamples?: boolean, probeWindows?: import('./probe-windows.mjs').ProbeWindows|null}} opts
 *        probeWindows — реестр окон измерительных проб инструмента (см. probe-windows.mjs): выборки
 *        внутри окон помечаются `probe:true` и не участвуют в `mem_peak_excl_probe_mib`
 */
export function startProcSampler(opts) {
  const intervalMs = opts.intervalMs ?? 250;
  const keepSamples = opts.keepSamples ?? true;
  const probeWindows = opts.probeWindows ?? null;
  const ticks = clockTicks();
  const t0 = performance.now();
  /** @type {Map<string, {spec: ProcGroupSpec, first: Map<number,{u:number,s:number}>, last: Map<number,{u:number,s:number}>, peak: number, peakExcl: number, probeTicks: number, rssPeak: number, integral: number, end: number, diskStart: number|null, diskEnd: number|null, diskPeak: number|null, fallback: boolean, samples: ProcSample[], count: number, matchedTicks: number, lastT: number}>} */
  const groups = new Map();
  for (const spec of opts.groups) {
    groups.set(spec.name, {
      spec,
      first: new Map(),
      last: new Map(),
      peak: 0,
      peakExcl: NaN,
      probeTicks: 0,
      rssPeak: 0,
      integral: 0,
      end: 0,
      diskStart: null,
      diskEnd: null,
      diskPeak: null,
      fallback: false,
      samples: [],
      count: 0,
      matchedTicks: 0,
      lastT: t0,
    });
  }
  /** группы взаимоисключающие в порядке объявления; дерево процессов оболочки исключено всегда */
  const tick = () => {
    const now = performance.now();
    // метка окна пробы снимается ДО чтения /proc: опрос группы длится десятки миллисекунд,
    // и окно могло открыться (или открыться и закрыться) внутри него
    const mark = probeMark(probeWindows);
    const parents = parentMap();
    const selfTree = selfProcessTree(parents);
    /** уже занятые более ранней группой (группы взаимоисключающие в порядке объявления) */
    /** @type {Set<number>} */
    const taken = new Set();
    for (const g of groups.values()) {
      const pids = groupPids(g.spec, parents, taken, selfTree);
      let priv = 0;
      let rss = 0;
      let alive = 0;
      let cpuUser = 0;
      let cpuSys = 0;
      for (const pid of pids) {
        const st = readStat(pid);
        if (!st) continue;
        taken.add(pid);
        alive++;
        const cpu = { u: st.utimeTicks, s: st.stimeTicks };
        if (!g.first.has(pid)) g.first.set(pid, cpu);
        g.last.set(pid, cpu);
        const mem = readMemory(pid);
        if (mem) {
          priv += mem.privateBytes;
          rss += mem.rssBytes;
          if (mem.fallback) g.fallback = true;
        }
      }
      for (const [pid, l] of g.last) {
        const f = g.first.get(pid) ?? l;
        cpuUser += l.u - f.u;
        cpuSys += l.s - f.s;
      }
      const cpuMs = ((cpuUser + cpuSys) * 1000) / ticks;
      const privMib = priv / MIB;
      const dt = (now - g.lastT) / 1000;
      g.integral += privMib * dt;
      g.lastT = now;
      g.peak = Math.max(g.peak, privMib);
      const inProbe = probeTouched(probeWindows, mark);
      if (inProbe) g.probeTicks += 1;
      else if (alive > 0) g.peakExcl = Math.max(Number.isFinite(g.peakExcl) ? g.peakExcl : 0, privMib);
      g.rssPeak = Math.max(g.rssPeak, rss / MIB);
      g.end = privMib;
      g.count++;
      if (alive > 0) g.matchedTicks += 1;
      /** @type {ProcSample} */
      const sample = { t: Math.round(now - t0), pids: alive, cpuMs: Math.round(cpuMs), privateMib: +privMib.toFixed(2), rssMib: +(rss / MIB).toFixed(2), ...(inProbe ? { probe: /** @type {true} */ (true) } : {}) };
      if (g.spec.dir) {
        const bytes = dirSizeBytes(g.spec.dir);
        if (g.diskStart === null) g.diskStart = bytes;
        g.diskEnd = bytes;
        g.diskPeak = Math.max(g.diskPeak ?? 0, bytes);
        sample.dirBytes = bytes;
      }
      if (keepSamples) g.samples.push(sample);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);

  /** @returns {Record<string, ProcGroupSummary>} */
  const summarize = () => {
    /** @type {Record<string, ProcGroupSummary>} */
    const out = {};
    for (const g of groups.values()) {
      let u = 0;
      let s = 0;
      for (const [pid, l] of g.last) {
        const f = g.first.get(pid) ?? l;
        u += l.u - f.u;
        s += l.s - f.s;
      }
      const matched = g.matchedTicks > 0;
      // Полнота выборки не двоична (дефект N6): группа, увиденная лишь частью опросов (процесс
      // перезапустился, появился поздно), даёт УРЕЗАННЫЕ cpu_ms/mem_integral. Поэтому наряду с
      // matched публикуются matched_ticks/expected_ticks, и при покрытии < PARTIAL_COVERAGE
      // группа помечается `partial` — вызывающий обязан отнести её в sampling_incomplete.
      const coverage = g.count > 0 ? g.matchedTicks / g.count : 0;
      const partial = matched && coverage < PARTIAL_COVERAGE;
      out[g.spec.name] = {
        name: g.spec.name,
        pids: [...g.last.keys()],
        matched,
        partial,
        coverage: +coverage.toFixed(4),
        unmatched_reason: matched
          ? partial
            ? `группа "${g.spec.name}" сопоставлена лишь в ${g.matchedTicks} из ${g.count} опросов (${(coverage * 100).toFixed(0)} %): cpu_ms и mem_integral_mib_s заведомо занижены`
            : null
          : `группа "${g.spec.name}" не сопоставлена ни одному процессу за ${g.count} опрос(ов): проверьте pidFile/patterns (${describeSpec(g.spec)})`,
        matched_ticks: g.matchedTicks,
        expected_ticks: g.count,
        cpu_ms: Math.round(((u + s) * 1000) / ticks),
        cpu_user_ms: Math.round((u * 1000) / ticks),
        cpu_sys_ms: Math.round((s * 1000) / ticks),
        mem_peak_mib: +g.peak.toFixed(2),
        // пик БЕЗ окон измерительных проб инструмента: политика одинакова у всех адаптеров
        mem_peak_excl_probe_mib: Number.isFinite(g.peakExcl) ? +g.peakExcl.toFixed(2) : null,
        probe_ticks: g.probeTicks,
        mem_end_mib: +g.end.toFixed(2),
        mem_integral_mib_s: +g.integral.toFixed(2),
        rss_peak_mib: +g.rssPeak.toFixed(2),
        disk_start_bytes: g.diskStart,
        disk_end_bytes: g.diskEnd,
        disk_peak_bytes: g.diskPeak,
        mem_fallback_rss: g.fallback,
        sample_count: g.count,
        duration_s: +((performance.now() - t0) / 1000).toFixed(3),
        sampler_t0_ms: t0,
        samples: g.samples,
      };
    }
    return out;
  };

  return {
    /** Снимок на текущий момент без остановки. */
    snapshot: () => summarize(),
    /** Финальный опрос, остановка таймера, сводка. */
    stop: () => {
      clearInterval(timer);
      tick();
      return summarize();
    },
  };
}
