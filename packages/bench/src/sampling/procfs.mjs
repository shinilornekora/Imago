// @ts-check
/**
 * Чтение /proc: список процессов, cmdline, stat (CPU, ppid, RSS), smaps_rollup (Private_*).
 * Все функции синхронные и «тихие»: процесс мог исчезнуть между readdir и read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let clkTck = 0;
/** Число jiffies в секунде (обычно 100). */
export function clockTicks() {
  if (clkTck) return clkTck;
  try {
    clkTck = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    clkTck = 100;
  }
  return clkTck;
}

let pageSize = 0;
export function pageSizeBytes() {
  if (pageSize) return pageSize;
  try {
    pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) || 4096;
  } catch {
    pageSize = 4096;
  }
  return pageSize;
}

/** @returns {number[]} все pid в /proc */
export function listPids() {
  /** @type {number[]} */
  const out = [];
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const n of names) if (/^\d+$/.test(n)) out.push(Number(n));
  return out;
}

/**
 * @param {number} pid
 * @returns {string} cmdline с пробелами вместо NUL (пусто для kernel threads / исчезнувших)
 */
export function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

/**
 * @typedef {object} ProcStat
 * @property {number} pid
 * @property {string} comm
 * @property {string} state
 * @property {number} ppid
 * @property {number} utimeTicks
 * @property {number} stimeTicks
 * @property {number} rssBytes
 * @property {number} startTimeTicks
 */

/**
 * @param {number} pid
 * @returns {ProcStat | null}
 */
export function readStat(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
  } catch {
    return null;
  }
  // comm в скобках может содержать пробелы и скобки — режем по последней ')'
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (open < 0 || close < 0) return null;
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 2).split(' ');
  // rest[0]=state(3) rest[1]=ppid(4) ... utime=14 → rest[11], stime=15 → rest[12], starttime=22 → rest[19], rss=24 → rest[21]
  return {
    pid,
    comm,
    state: rest[0],
    ppid: Number(rest[1]),
    utimeTicks: Number(rest[11]),
    stimeTicks: Number(rest[12]),
    startTimeTicks: Number(rest[19]),
    rssBytes: Number(rest[21]) * pageSizeBytes(),
  };
}

/**
 * Частная память процесса: Private_Clean + Private_Dirty из smaps_rollup (байты).
 * При недоступности — RSS из stat (fallback помечается).
 * @param {number} pid
 * @returns {{privateBytes: number, rssBytes: number, fallback: boolean} | null}
 */
export function readMemory(pid) {
  let rollup = '';
  try {
    rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'latin1');
  } catch {
    rollup = '';
  }
  if (rollup) {
    let priv = 0;
    let rss = 0;
    let ok = false;
    for (const line of rollup.split('\n')) {
      if (line.startsWith('Private_Clean:') || line.startsWith('Private_Dirty:')) {
        priv += Number(line.split(/\s+/)[1]) * 1024;
        ok = true;
      } else if (line.startsWith('Rss:')) rss = Number(line.split(/\s+/)[1]) * 1024;
    }
    if (ok) return { privateBytes: priv, rssBytes: rss, fallback: false };
  }
  const st = readStat(pid);
  if (!st) return null;
  return { privateBytes: st.rssBytes, rssBytes: st.rssBytes, fallback: true };
}

/**
 * Таблица pid → ppid для всех процессов (один проход по /proc).
 * @returns {Map<number, number>}
 */
export function parentMap() {
  /** @type {Map<number, number>} */
  const m = new Map();
  for (const pid of listPids()) {
    const st = readStat(pid);
    if (st) m.set(pid, st.ppid);
  }
  return m;
}

/**
 * Все потомки (транзитивно) заданных pid, включая их самих.
 * @param {Iterable<number>} roots
 * @param {Map<number, number>} [parents]
 * @returns {Set<number>}
 */
export function descendants(roots, parents = parentMap()) {
  const result = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (result.has(ppid) && !result.has(pid)) {
        result.add(pid);
        grew = true;
      }
    }
  }
  return result;
}

/**
 * Цепочка предков процесса (родитель, дед, …) по таблице ppid.
 * @param {number} pid
 * @param {Map<number, number>} parents
 * @returns {Set<number>}
 */
export function ancestors(pid, parents) {
  /** @type {Set<number>} */
  const out = new Set();
  let cur = parents.get(pid);
  while (cur !== undefined && cur > 0 && !out.has(cur)) {
    out.add(cur);
    cur = parents.get(cur);
  }
  return out;
}

/**
 * Процессы, которые никогда не должны попадать в серверные группы: сама оболочка,
 * её потомки (Chromium) и цепочка предков (оболочка shell, из которой её запустили).
 * @param {Map<number, number>} [parents]
 * @returns {Set<number>}
 */
export function selfProcessTree(parents = parentMap()) {
  const s = descendants([process.pid], parents);
  for (const a of ancestors(process.pid, parents)) s.add(a);
  return s;
}

/**
 * Рабочий каталог процесса (`/proc/<pid>/cwd`), пусто при недоступности.
 * @param {number} pid
 */
export function readCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/**
 * PID из pidfile (первое целое число в файле) или null, если файла нет / процесс не жив.
 * @param {string} file
 * @returns {number | null}
 */
export function readPidFile(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/\d+/);
    if (!m) return null;
    const pid = Number(m[0]);
    return pid > 0 && fs.existsSync(`/proc/${pid}`) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Найти процессы по регулярным выражениям на cmdline (исключая себя).
 * `cwd` — дополнительный фильтр: регулярка на рабочий каталог процесса (`/proc/<pid>/cwd`),
 * нужен, когда командная строка неинформативна (`node dist/index.js` из packages/server).
 * @param {(RegExp | string)[]} patterns
 * @param {{exclude?: (RegExp | string)[], excludePids?: Iterable<number>, cwd?: RegExp | string}} [opts]
 * @returns {number[]}
 */
export function findPidsByCmdline(patterns, opts = {}) {
  const res = patterns.map((p) => (typeof p === 'string' ? new RegExp(p) : p));
  const exc = (opts.exclude ?? []).map((p) => (typeof p === 'string' ? new RegExp(p) : p));
  const cwdRe = opts.cwd ? (typeof opts.cwd === 'string' ? new RegExp(opts.cwd) : opts.cwd) : null;
  const excludePids = new Set(opts.excludePids ?? []);
  excludePids.add(process.pid);
  /** @type {number[]} */
  const out = [];
  for (const pid of listPids()) {
    if (excludePids.has(pid)) continue;
    const cmd = readCmdline(pid);
    if (!cmd) continue;
    if (!res.some((r) => r.test(cmd)) || exc.some((r) => r.test(cmd))) continue;
    if (cwdRe && !cwdRe.test(readCwd(pid))) continue;
    out.push(pid);
  }
  return out;
}

/**
 * Суммарный размер файлов каталога (без переходов по симлинкам), байты. Нет каталога → 0.
 * @param {string} dir
 */
export function dirSizeBytes(dir) {
  let total = 0;
  /** @param {string} d */
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {
        /* исчез */
      }
    }
  };
  try {
    const st = fs.statSync(dir);
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  walk(dir);
  return total;
}
