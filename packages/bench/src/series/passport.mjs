// @ts-check
/**
 * Паспорт серии (SPEC §7.4): ОС, ядро, CPU, версии Node/PostgreSQL/Chromium/пакетов
 * (из корневого package-lock.json), параметры шейпера, конфигурация серии, время.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describeSpec, resolveGroups } from '../sampling/procs.mjs';
import { dirSizeBytes, readPidFile } from '../sampling/procfs.mjs';

/** @param {string} file @param {string[]} args */
function tryExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function cpuModel() {
  try {
    const m = /model name\s*:\s*(.+)/.exec(fs.readFileSync('/proc/cpuinfo', 'utf8'));
    if (m) return m[1].trim();
  } catch {
    /* не linux */
  }
  return os.cpus()[0]?.model ?? null;
}

/**
 * Версии прямых зависимостей всех workspace-пакетов из package-lock.json (lockfile v3).
 * @param {string} rootDir
 * @returns {{lockfileVersion: number|null, packages: Record<string,string>, workspaces: Record<string, Record<string,string>>, conflicts: Record<string,string[]>, hoisted: Record<string,string>}}
 *   packages — версия, которую реально использует workspace (вложенная node_modules приоритетнее поднятой);
 *   hoisted — версии в корневом node_modules для тех же имён (транзитивные зависимости, например postgres 3.4.7 у @rocicorp/zero)
 */
export function packageVersions(rootDir) {
  const lockPath = path.join(rootDir, 'package-lock.json');
  /** @type {{lockfileVersion: number|null, packages: Record<string,string>, workspaces: Record<string, Record<string,string>>, conflicts: Record<string,string[]>, hoisted: Record<string,string>}} */
  const out = { lockfileVersion: null, packages: {}, workspaces: {}, conflicts: {}, hoisted: {} };
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return out;
  }
  out.lockfileVersion = lock.lockfileVersion ?? null;
  const pk = lock.packages ?? {};
  /** @param {string} name */
  const versionOf = (name) => pk[`node_modules/${name}`]?.version ?? null;
  for (const [key, entry] of Object.entries(pk)) {
    if (!key.startsWith('packages/') || key.includes('node_modules')) continue;
    /** @type {Record<string,string>} */
    const deps = {};
    for (const section of ['dependencies', 'devDependencies']) {
      for (const name of Object.keys(/** @type {any} */ (entry)[section] ?? {})) {
        // сначала версия, вложенная в сам workspace (packages/server/node_modules/postgres = 3.4.9), затем поднятая в корень
        // (node_modules/postgres = 3.4.7 — транзитивная зависимость @rocicorp/zero); иначе паспорт показал бы не ту версию, что использует пакет
        const nested = /** @type {any} */ (pk[key + '/node_modules/' + name])?.version ?? null;
        const v = nested ?? versionOf(name);
        if (v) {
          deps[name] = v;
          // в сводном списке — версия, которую реально используют workspace-пакеты; расхождения перечисляются отдельно
          if (out.packages[name] && out.packages[name] !== v) out.conflicts[name] = [...new Set([out.packages[name], v])];
          out.packages[name] = v;
        }
      }
    }
    out.workspaces[key] = deps;
  }
  for (const name of Object.keys(out.packages)) {
    const h = versionOf(name);
    if (h && h !== out.packages[name]) out.hoisted[name] = h;
  }
  return out;
}

/** Ключи, значения которых НИКОГДА не попадают в паспорт (пароли, секреты, токены, ключи). */
export const SECRET_KEY = /(secret|password|token|passwd|apikey|api_key|private_key)/i;

/**
 * Рекурсивная редакция секретов по ИМЕНИ ключа. Применяется ко всему, что паспорт копирует из
 * внешних источников (конфигурация серии, среда zero-cache): пароль тестовой учётки не должен
 * попадать в опубликованный артефакт — этого требуют packages/client/src/config.ts §N9 и
 * docs/PASSPORT.md («пароль … не попадает … ни в паспорт серии»). До 2026-09-13 `buildPassport`
 * клал `seriesConfig` целиком, и `alice-pass` лежал во всех одиннадцати паспортах программы.
 * Структура сохраняется: ключ остаётся на месте, меняется только значение.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (SECRET_KEY.test(k)) out[k] = v === '' || v === null || v === undefined ? '(пусто)' : '(задан, не записывается)';
    else out[k] = redactSecrets(v, depth + 1);
  }
  return out;
}

/**
 * @param {object} p
 * @param {string} p.rootDir
 * @param {any} p.series           конфигурация серии (как загружена)
 * @param {{delayMs: number, bandwidthMbit: number, bucketMs?: number, statsUrl?: string, effective?: any, beforeSeries?: any}} p.shaper
 *        запрошенные параметры канала + `effective` — фактические из GET /config шейпера (delayMs, bandwidthMbit, bucketMs, bucketBytes, segmentBytes, handshakeRtt)
 * @param {string|null} [p.chromiumVersion]
 * @param {string} [p.startedAt]
 * @param {Record<string, unknown>} [p.extra]
 */
export function buildPassport(p) {
  const pv = packageVersions(p.rootDir);
  return {
    series: p.series?.name ?? null,
    startedAt: p.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    host: {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      platform: os.platform(),
      arch: os.arch(),
      kernel: tryExec('uname', ['-r']) ?? os.release(),
      distro: (() => {
        try {
          const m = /PRETTY_NAME="([^"]+)"/.exec(fs.readFileSync('/etc/os-release', 'utf8'));
          return m ? m[1] : null;
        } catch {
          return null;
        }
      })(),
      cpuModel: cpuModel(),
      cpuCount: os.cpus().length,
      totalMemMib: Math.round(os.totalmem() / 1048576),
    },
    versions: {
      node: process.version,
      npm: tryExec('npm', ['--version']),
      postgres: tryExec('psql', ['--version']) ?? tryExec('pg_config', ['--version']) ?? tryExec('/usr/lib/postgresql/16/bin/postgres', ['--version']),
      chromium: p.chromiumVersion ?? null,
      playwright: pv.packages['playwright'] ?? null,
      zero: pv.packages['@rocicorp/zero'] ?? null,
      reactQuery: pv.packages['@tanstack/react-query'] ?? null,
      react: pv.packages['react'] ?? null,
      fastify: pv.packages['fastify'] ?? null,
      vite: pv.packages['vite'] ?? null,
      typescript: pv.packages['typescript'] ?? null,
      python: tryExec('python3', ['--version']),
    },
    packages: pv.packages,
    packagesHoistedDifferent: pv.hoisted,
    workspacePackages: pv.workspaces,
    lockfileVersion: pv.lockfileVersion,
    shaper: p.shaper,
    seed: p.series?.seed ?? null,
    repetitions: p.series?.repetitions ?? null,
    configs: redactSecrets(p.series?.configs ?? null),
    // конфигурация серии — ЧЕРЕЗ редактор секретов (пароль тестовой учётки в паспорт не пишется)
    seriesConfig: redactSecrets(p.series),
    ...(p.extra ?? {}),
  };
}

// ===================================================================== §2.1 docs/PASSPORT.md
// Ключи, которые паспорт обязан содержать помимо host/versions/packages/shaper/seed/plan:
// api.logLevel, adapters, client.dist, client.buildId, zero.config, preSeriesChecks, commit.

/**
 * Сборка клиента: полный список файлов `packages/client/dist` (имя с хешем, размер, mtime, sha256)
 * и `buildId` — sha256 от отсортированного списка «путь + sha256 файла» по всему `dist`
 * (та же величина, что даёт команда из docs/PASSPORT.md §2.2 — в §2 её больше нет).
 * @param {string} rootDir
 */
export function clientBuildInfo(rootDir) {
  const distDir = path.join(rootDir, 'packages', 'client', 'dist');
  /** @type {Array<{path: string, bytes: number, mtime: string, sha256: string}>} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          files.push({
            path: path.relative(distDir, abs).split(path.sep).join('/'),
            bytes: st.size,
            mtime: st.mtime.toISOString(),
            sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
          });
        } catch {
          /* файл исчез */
        }
      }
    }
  };
  walk(distDir);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const buildId = files.length ? crypto.createHash('sha256').update(files.map((f) => `${f.path}  ${f.sha256}`).join('\n')).digest('hex') : null;
  return { dir: path.relative(rootDir, distDir), exists: files.length > 0, files, totalBytes: files.reduce((s, f) => s + f.bytes, 0), buildId };
}

/** sha256 от содержимого каталога (для commit-фолбэка по packages/server/dist). @param {string} dir */
function dirDigest(dir) {
  /** @type {string[]} */
  const parts = [];
  /** @param {string} d */
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        try {
          parts.push(`${path.relative(dir, abs)}  ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
        } catch {
          /* пропуск */
        }
      }
    }
  };
  walk(dir);
  return parts.length ? crypto.createHash('sha256').update(parts.join('\n')).digest('hex') : null;
}

/**
 * Настройки адаптеров: `ADAPTER_SETTINGS` + `Z_SETTINGS` целиком. Источник — JSON, который
 * эмитит сборка клиента (`packages/client/dist/adapter-settings.json`, плагин в `vite.config.ts`),
 * то есть ровно те значения, что попали в измеряемую сборку. Если файла нет (сборка старее правки),
 * возвращается `{available:false, reason}` — ключ не «молча пустой».
 * @param {string} rootDir
 */
export function adapterSettings(rootDir) {
  const file = path.join(rootDir, 'packages', 'client', 'dist', 'adapter-settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { available: true, source: 'packages/client/dist/adapter-settings.json', ...parsed };
  } catch (err) {
    return { available: false, source: 'packages/client/dist/adapter-settings.json', reason: `не прочитан: ${/** @type {any} */ (err)?.message}; пересоберите клиент (npm run build -w packages/client)` };
  }
}

const SECRET_ENV = /(SECRET|PASSWORD|TOKEN|KEY)/i;

/**
 * Конфигурация zero-cache: переменные ZERO_* процесса zero-cache (`/proc/<pid>/environ` по
 * `results/logs/zero.pid`), путь и размер реплики на старте серии, ответ `GET :4848/`.
 * Секреты (`ZERO_AUTH_SECRET`, `ZERO_ADMIN_PASSWORD`, пароль в DSN) не пишутся — только пометка «задан».
 * @param {string} rootDir
 * @param {{port?: number, replicaDir?: string, reachable?: boolean|null, status?: number|null}} [opts]
 */
export function zeroConfig(rootDir, opts = {}) {
  const pid = readPidFile(path.join(rootDir, 'results', 'logs', 'zero.pid'));
  /** @type {Record<string, string>} */
  const env = {};
  if (pid !== null) {
    try {
      for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const i = kv.indexOf('=');
        if (i <= 0) continue;
        const k = kv.slice(0, i);
        if (!k.startsWith('ZERO_') && k !== 'NODE_OPTIONS' && k !== 'DO_NOT_TRACK') continue;
        const v = kv.slice(i + 1);
        env[k] = SECRET_ENV.test(k) ? (v ? '(задан, не записывается)' : '(пусто)') : k === 'ZERO_UPSTREAM_DB' ? v.replace(/\/\/[^@/]*@/, '//***@') : v;
      }
    } catch {
      /* процесс исчез или /proc недоступен */
    }
  }
  const replicaDir = opts.replicaDir ?? path.join(rootDir, 'results', 'zero-replica');
  return {
    pid,
    env,
    envAvailable: Object.keys(env).length > 0,
    replicaDir: path.relative(rootDir, replicaDir) || replicaDir,
    replicaBytesAtSeriesStart: fs.existsSync(replicaDir) ? dirSizeBytes(replicaDir) : null,
    port: opts.port ?? Number(env.ZERO_PORT ?? 4848),
    httpReachable: opts.reachable ?? null,
    httpStatus: opts.status ?? null,
  };
}

/**
 * Идентификатор состояния кода. Git-хеш, если каталог — репозиторий git; иначе `null`
 * (и тогда состояние кода описывает `codeId` — buildId клиента + sha256 сборки сервера).
 * @param {string} rootDir
 * @param {string|null} clientBuildId
 */
export function codeIdentity(rootDir, clientBuildId) {
  const isRepo = tryExec('git', ['-C', rootDir, 'rev-parse', '--is-inside-work-tree']) === 'true';
  const commit = isRepo ? tryExec('git', ['-C', rootDir, 'rev-parse', 'HEAD']) : null;
  const serverDist = dirDigest(path.join(rootDir, 'packages', 'server', 'dist'));
  return {
    commit,
    isGitRepo: isRepo,
    dirty: isRepo ? (tryExec('git', ['-C', rootDir, 'status', '--porcelain']) ?? '') !== '' : null,
    codeId: clientBuildId && serverDist ? crypto.createHash('sha256').update(`${clientBuildId}\n${serverDist}`).digest('hex') : null,
    clientBuildId: clientBuildId ?? null,
    serverDistSha256: serverDist,
  };
}

/**
 * Идентичность ИЗМЕРИТЕЛЬНОЙ ОБОЛОЧКИ (дефект «оболочка менялась внутри программы»).
 *
 * `codeIdentity()` покрывает только собранные клиент и сервер, поэтому две серии могли быть сняты
 * разными версиями `packages/bench/**` — и в опубликованной программе именно так и вышло: восемь
 * основных серий и три дополнительных различались сценарием, раннером и схемой `runs.csv`
 * (100 против 115 колонок), а ни один артефакт об этом не говорил.
 *
 * `benchId` — sha256 по `packages/bench/src/**`: версия оболочки как таковая, одинаковая у всех
 * серий одной программы (её читает анализ). `harnessId` — sha256 от четырёх частей: исходники
 * оболочки, исходники шейпера, КОНФИГУРАЦИЯ ЭТОЙ СЕРИИ (после редакции секретов) и набор колонок CSV. Плюс отдельно — эталон (`packages/reference`
 * и `scripts/reference-check.sh`), который проверяет каждый прогон. Две серии сопоставимы по
 * построению тогда и только тогда, когда у них совпадают `benchSrcSha256`, `netshaperSrcSha256`,
 * `columnsSha256` и `referenceSha256`; `seriesConfigSha256` по определению различается.
 * @param {object} p
 * @param {string} p.rootDir
 * @param {any} p.series            эффективная конфигурация серии (как её выполняет раннер)
 * @param {string[]} p.columns      набор колонок runs.csv
 */
export function harnessIdentity(p) {
  const sha = (/** @type {string} */ text) => crypto.createHash('sha256').update(text).digest('hex');
  const fileSha = (/** @type {string} */ rel) => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(p.rootDir, rel))).digest('hex');
    } catch {
      return null;
    }
  };
  const benchSrc = dirDigest(path.join(p.rootDir, 'packages', 'bench', 'src'));
  const netshaperSrc = dirDigest(path.join(p.rootDir, 'packages', 'netshaper', 'src'));
  const referencePy = dirDigest(path.join(p.rootDir, 'packages', 'reference', 'reference'));
  const referenceSh = fileSha('scripts/reference-check.sh');
  const referenceSha = sha(`${referencePy ?? '-'}\n${referenceSh ?? '-'}`);
  // канонический JSON: ключи отсортированы на каждом уровне, секреты отредактированы — хеш не
  // зависит ни от порядка ключей в файле серии, ни от значений секретов
  const seriesConfigSha = sha(canonicalJson(redactSecrets(p.series)));
  const columnsSha = sha(p.columns.join(','));
  const harnessId = sha([benchSrc ?? '-', netshaperSrc ?? '-', seriesConfigSha, columnsSha].join('\n'));
  return {
    harnessId,
    harnessIdShort: harnessId.slice(0, 16),
    // benchId — идентификатор ВЕРСИИ ОБОЛОЧКИ как таковой (sha256 по packages/bench/src/**), без
    // конфигурации серии: у всех серий ОДНОЙ программы он обязан совпадать, и именно это читает
    // анализ (`passport.harness.benchId`). harnessId, наоборот, включает конфигурацию серии и
    // потому у разных серий различается по построению.
    benchId: benchSrc,
    benchSrcSha256: benchSrc,
    netshaperSrcSha256: netshaperSrc,
    seriesConfigSha256: seriesConfigSha,
    columnsSha256: columnsSha,
    columnCount: p.columns.length,
    columns: [...p.columns],
    referenceSha256: referenceSha,
    referencePySha256: referencePy,
    referenceScriptSha256: referenceSh,
    comparableBy: ['benchId', 'benchSrcSha256', 'netshaperSrcSha256', 'columnsSha256', 'referenceSha256'],
    note: 'две серии сопоставимы по построению, если совпадают все поля comparableBy; harnessId дополнительно включает конфигурацию серии и потому у разных серий различается',
  };
}

/**
 * Канонический JSON: ключи объектов отсортированы на каждом уровне, порядок элементов массивов
 * сохранён (он значим — это порядок конфигураций и маршрут). @param {unknown} v @returns {string}
 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (v)).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(/** @type {any} */ (v)[k])).join(',') + '}';
}

/**
 * Предсерийные проверки (docs/PASSPORT.md §8). Автоматическая часть — тот же preflight, что и у
 * `scripts/run-all-series.sh`: каждая нужная серии группа процессов обязана быть непустой, иначе
 * серверные колонки были бы нулями по построению. Плюс дисковый бюджет §1.7 и ручные проверки
 * §8.1–8.3.
 *
 * Вывод проверок ищется в двух местах: сначала `results/<series>/pre-series-checks.txt` (его кладёт
 * туда оркестратор), затем `results/logs/pre-series-checks.txt` — один файл на прогон оркестратора.
 * Второй кандидат добавлен 2026‑09‑13: до этого серия, запущенная оркестратором, получала
 * `manual.status = "not-performed"`, ХОТЯ проверки выполнялись и проходили — они просто лежали в
 * `results/logs/`. Так записаны все одиннадцать паспортов выполненной программы; свидетельство —
 * docs/PASSPORT.md §8.4. Если файла нет ни там, ни там, пишется «не выполнена», а не опускается.
 * @param {object} p
 * @param {string} p.rootDir
 * @param {import('../sampling/procs.mjs').ProcGroupSpec[]} p.procGroups   с абсолютными путями
 * @param {string[]} p.adapters                                            адаптеры серии
 * @param {string} p.seriesDir
 * @param {string[]} p.diskDirs
 */
export function preSeriesChecks(p) {
  const resolved = resolveGroups(p.procGroups);
  /** @type {Array<{group: string, needed: boolean, processes: number, pids: number[], verdict: string, spec: string}>} */
  const samplers = [];
  let samplersOk = true;
  for (const spec of p.procGroups) {
    const needed = !spec.adapters || spec.adapters.some((a) => p.adapters.includes(a));
    const procs = resolved[spec.name] ?? [];
    const verdict = !needed ? 'skip' : procs.length ? 'ok' : 'FAIL';
    if (verdict === 'FAIL') samplersOk = false;
    samplers.push({ group: spec.name, needed, processes: procs.length, pids: procs.map((x) => x.pid), verdict, spec: describeSpec(spec) });
  }
  /** @type {Record<string, number>} */
  const disk = {};
  let diskTotal = 0;
  for (const d of p.diskDirs) {
    const b = dirSizeBytes(d);
    disk[d] = b;
    diskTotal += b;
  }
  const stopBytes = 32 * 1024 ** 3; // §1.7: 80 % от бюджета 40 ГиБ
  // Рядом с серией — основной путь (оркестратор кладёт туда копию вывода ЭТОГО прогона программы).
  // Фолбэк — файл, на который указывает STAND_PRE_SERIES_CHECKS (оркестратор ставит туда
  // results/logs/pre-series-checks-<штамп>.txt). ПУСТОЕ значение переменной — явный сигнал
  // «проверки этой программы не выполнялись» (STAND_SKIP_PRE_CHECKS=1): файл ПРОШЛОЙ программы
  // фолбэком не считается, иначе паспорт выдал бы чужое свидетельство за своё. Переменная не
  // задана вовсе (серия запущена вручную) — прежнее поведение с results/logs/pre-series-checks.txt.
  const envChecks = process.env.STAND_PRE_SERIES_CHECKS;
  const manualCandidates = [path.join(p.seriesDir, 'pre-series-checks.txt')];
  if (envChecks === undefined) manualCandidates.push(path.join(p.rootDir, 'results', 'logs', 'pre-series-checks.txt'));
  else if (envChecks !== '') manualCandidates.push(path.resolve(p.rootDir, envChecks));
  const manualFile = manualCandidates.find((f) => fs.existsSync(f)) ?? manualCandidates[0];
  const manualExists = fs.existsSync(manualFile);
  return {
    at: new Date().toISOString(),
    samplers: { ok: samplersOk, groups: samplers },
    disk: { dirs: disk, totalBytes: diskTotal, stopThresholdBytes: stopBytes, withinBudget: diskTotal < stopBytes },
    manual: manualExists
      ? { status: 'performed', file: path.relative(p.rootDir, manualFile), text: fs.readFileSync(manualFile, 'utf8').slice(0, 8000) }
      : { status: 'not-performed', file: path.relative(p.rootDir, manualFile), searched: manualCandidates.map((f) => path.relative(p.rootDir, f)), note: 'ручные проверки §8.1–8.3 (диск, лаг репликации, восстановление копии) не выполнены или их вывод не положен ни рядом с серией, ни в results/logs/' },
  };
}

/**
 * Дописывает в паспорт ключи §2.1, которые требуют внешних источников (API, zero-cache, dist, git).
 * Ошибки источников не роняют серию: недостающий ключ получает `{available:false, reason}`.
 * @param {any} passport
 * @param {object} p
 * @param {string} p.rootDir
 * @param {string} p.apiUrl
 * @param {string} p.seriesDir
 * @param {string[]} p.adapters
 * @param {import('../sampling/procs.mjs').ProcGroupSpec[]} p.procGroups
 * @param {string[]} p.diskDirs
 * @param {number} [p.zeroPort]
 * @param {string[]} [p.columns]          набор колонок runs.csv (для harnessIdentity)
 */
export async function completePassport(passport, p) {
  const client = clientBuildInfo(p.rootDir);
  passport.client = { dist: client.files, distDir: client.dir, distTotalBytes: client.totalBytes, buildId: client.buildId };
  passport.adapters = adapterSettings(p.rootDir);
  passport.api = await apiInfo(p.apiUrl);
  const zeroPort = p.zeroPort ?? 4848;
  let reachable = null;
  let status = null;
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${zeroPort}/`, 3000);
    reachable = res.ok;
    status = res.status;
  } catch {
    reachable = false;
  }
  passport.zero = { config: zeroConfig(p.rootDir, { port: zeroPort, reachable, status, replicaDir: p.procGroups.find((g) => g.dir)?.dir }) };
  const ident = codeIdentity(p.rootDir, client.buildId);
  passport.commit = ident.commit;
  passport.code = ident;
  // идентичность измерительной оболочки: см. harnessIdentity() — проверка сопоставимости серий
  if (p.columns) passport.harness = harnessIdentity({ rootDir: p.rootDir, series: passport.seriesConfig, columns: p.columns });
  passport.preSeriesChecks = preSeriesChecks({ rootDir: p.rootDir, procGroups: p.procGroups, adapters: p.adapters, seriesDir: p.seriesDir, diskDirs: p.diskDirs });
  return passport;
}

/** @param {string} url @param {number} ms */
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Состояние API во время серии: `GET /api/health` целиком (в нём `logLevel`, который DEVIATIONS 4.1
 * требует держать `warn`) + фактическая привязка порта.
 * @param {string} apiUrl
 */
export async function apiInfo(apiUrl) {
  try {
    const res = await fetchWithTimeout(`${apiUrl}/api/health`, 5000);
    const body = await res.json();
    return { url: apiUrl, available: true, logLevel: body?.logLevel ?? null, health: body };
  } catch (err) {
    return { url: apiUrl, available: false, logLevel: null, reason: String(/** @type {any} */ (err)?.message ?? err) };
  }
}
