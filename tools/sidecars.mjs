/**
 * Сайдкары для LLM (конституция, принцип VII): рядом с каждым файлом кода — заметка
 * `<файл>.llm.md` о том, что в нём происходит. Каталог, где лежит `README.llm.md`, описан
 * одной заметкой на все свои файлы (миграции, deploy/).
 *
 *   node tools/sidecars.mjs                    проверка: у кого нет заметки, чья заметка без файла
 *   node tools/sidecars.mjs --changed <база>   плюс: файлы, изменённые с <база>, чья заметка
 *                                              в том же диапазоне не менялась (git diff база...HEAD)
 *   node tools/sidecars.mjs --json             то же объектом
 *
 * Выход 1 — есть файл без заметки, заметка без файла или (с --changed) устаревшая заметка.
 * Та же проверка без --changed идёт в `npm test` (test/sidecars.test.mjs).
 */

import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Что считается кодом: этим файлам нужна заметка. */
export const CODE_RE = /\.(js|mjs|html|css)$/;
/** Каталоги, которые не обходим: зависимости, сборка, служебное, тесты (у тестов — одна заметка на каталог). */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.specify', '.claude', 'specs', 'test']);
/** Порождённые файлы (их пишет tools/build.mjs). */
const SKIP_FILES = new Set(['dev.html']);
const SIDECAR = '.llm.md';
const DIR_NOTE = 'README' + SIDECAR;

const posix = (p) => p.split(sep).join('/');

/** Все файлы кода и все заметки под корнем. */
export function scan(root = ROOT) {
  const code = [];
  const notes = [];
  const covered = new Set();   // каталоги с README.llm.md
  (function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === DIR_NOTE)) covered.add(posix(relative(root, dir)));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = posix(relative(root, full));
      if (e.name.endsWith(SIDECAR)) notes.push(rel);
      else if (CODE_RE.test(e.name) && !SKIP_FILES.has(rel)) code.push(rel);
    }
  })(root);
  return { code: code.sort(), notes: notes.sort(), covered };
}

/** Заметка, которая отвечает за файл: своя `<файл>.llm.md` или `README.llm.md` его каталога. */
export function noteOf(file, covered) {
  const dir = posix(dirname(file));
  return covered.has(dir === '.' ? '' : dir) ? (dir === '.' ? DIR_NOTE : `${dir}/${DIR_NOTE}`) : file + SIDECAR;
}

/** → {missing: файлы без заметки, orphans: заметки без файла}. */
export function check(root = ROOT) {
  const { code, notes, covered } = scan(root);
  const missing = code.filter((f) => !existsSync(join(root, noteOf(f, covered))));
  const orphans = notes.filter((n) => !n.endsWith('/' + DIR_NOTE) && n !== DIR_NOTE && !existsSync(join(root, n.slice(0, -SIDECAR.length))));
  return { missing, orphans, code: code.length, notes: notes.length };
}

/** Файлы кода, изменённые с `base`, чья заметка в том же диапазоне не менялась. */
export function stale(base, root = ROOT) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8' });
  const changed = new Set(out.split('\n').filter(Boolean));
  const { covered } = scan(root);
  const list = [];
  for (const f of changed) {
    if (f.endsWith(SIDECAR) || !CODE_RE.test(f) || !existsSync(join(root, f))) continue;
    if (f.split('/').some((p) => SKIP_DIRS.has(p)) || SKIP_FILES.has(f)) continue;
    const note = noteOf(f, covered);
    if (!changed.has(note)) list.push({ file: f, note });
  }
  return list.sort((a, b) => a.file.localeCompare(b.file));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--changed');
  const base = i >= 0 ? args[i + 1] : null;
  const r = check();
  const st = base ? stale(base) : [];
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...r, stale: st }, null, 2));
  } else {
    console.log(`файлов кода: ${r.code}, заметок: ${r.notes}`);
    for (const f of r.missing) console.log(`нет заметки:      ${f}  →  ${f}${SIDECAR}`);
    for (const n of r.orphans) console.log(`заметка без файла: ${n}`);
    for (const s of st) console.log(`заметка не обновлена: ${s.file}  (заметка ${s.note})`);
    if (!r.missing.length && !r.orphans.length && !st.length) console.log('всё на месте');
  }
  process.exit(r.missing.length || r.orphans.length || st.length ? 1 : 0);
}
