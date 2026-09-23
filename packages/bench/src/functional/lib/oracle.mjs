// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Обёртка над Python-эталоном `packages/reference` (`python3 -m reference.compare …`).
 * Команды и отчёты пишутся в каталог артефактов проверки, чтобы расхождение можно было воспроизвести вручную.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT } from './config.mjs';

const execFileP = promisify(execFile);
const REFERENCE_DIR = path.join(REPO_ROOT, 'packages', 'reference');

/**
 * @typedef {{opId?:string, type:'setSourceFill'|'setLocalFill', targetId:string, fill:string, expectedRevision?:number}} OracleCommand
 */

export class Oracle {
  /**
   * @param {{docJson:string, dbUrl:string, artifactsDir:string}} opts
   */
  constructor(opts) {
    this.docJson = opts.docJson;
    this.dbUrl = opts.dbUrl;
    this.artifactsDir = opts.artifactsDir;
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  /** @param {string} name @param {OracleCommand[]} commands */
  writeCommands(name, commands) {
    const file = path.join(this.artifactsDir, `${name}-commands.json`);
    writeFileSync(file, JSON.stringify(commands, null, 2));
    return file;
  }

  /**
   * @param {string[]} args
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  async run(args) {
    try {
      const { stdout, stderr } = await execFileP('python3', ['-m', 'reference.compare', ...args], {
        cwd: REFERENCE_DIR,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (typeof err.code === 'number') return { code: err.code, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
      throw e;
    }
  }

  /** @param {string} file */
  readReport(file) {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  /**
   * Ожидаемое состояние и ожидаемые результаты команд.
   * @param {string} name @param {OracleCommand[]} commands
   * @returns {Promise<{revision:number, shapes:Record<string,{fill:string,fillOverridden:boolean,pageId:string}>, results:Array<{revision:number,affectedPages:string[],affectedShapes:number,opId?:string}>}>}
   */
  async expected(name, commands) {
    const cmdFile = this.writeCommands(name, commands);
    const out = path.join(this.artifactsDir, `${name}-expected.json`);
    const r = await this.run(['expected', '--doc', this.docJson, '--commands', cmdFile, '--out', out]);
    if (r.code !== 0) throw new Error(`oracle expected: code ${r.code}\n${r.stderr}`);
    return this.readReport(out);
  }

  /**
   * Ожидаемый снимок страницы после команд: {pageId, revision, shapes:[{id,fill,fillOverridden}]}.
   * @param {string} name @param {OracleCommand[]} commands @param {string} pageId
   */
  async expectedPage(name, commands, pageId) {
    const st = await this.expected(name, commands);
    const shapes = Object.entries(st.shapes)
      .filter(([, s]) => s.pageId === pageId)
      .map(([id, s]) => ({ id, fill: s.fill, fillOverridden: s.fillOverridden }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { pageId, revision: st.revision, shapes, results: st.results };
  }

  /**
   * compare-db [--check-operations]: сверка БД с эталоном.
   * @param {string} name @param {OracleCommand[]} commands @param {{checkOperations?:boolean}} [opts]
   */
  async compareDb(name, commands, opts = {}) {
    const cmdFile = this.writeCommands(name, commands);
    const out = path.join(this.artifactsDir, `${name}-compare-db.json`);
    const args = ['compare-db', '--doc', this.docJson, '--commands', cmdFile, '--db', this.dbUrl, '--out', out];
    if (opts.checkOperations) args.push('--check-operations');
    const r = await this.run(args);
    const report = this.readReport(out);
    return { ok: r.code === 0 && report?.ok === true, code: r.code, report, stderr: r.stderr.trim(), reportFile: out, commandLine: `cd packages/reference && python3 -m reference.compare ${args.join(' ')}` };
  }

  /**
   * compare-snapshots: снимки клиента против эталона (точное множество id, fill/fillOverridden, revision ≥ ожидаемой).
   * @param {string} name @param {OracleCommand[]} commands
   * @param {Array<{pageId:string, revision:number, shapes:Array<{id:string,fill:string,fillOverridden:boolean}>, afterCommands?:number}>} snapshots
   * @param {{requirePages?: string[]}} [opts]
   */
  async compareSnapshots(name, commands, snapshots, opts = {}) {
    const cmdFile = this.writeCommands(name, commands);
    const snapFile = path.join(this.artifactsDir, `${name}-snapshots.json`);
    writeFileSync(snapFile, JSON.stringify({ snapshots }));
    const out = path.join(this.artifactsDir, `${name}-compare-snapshots.json`);
    const args = ['compare-snapshots', '--doc', this.docJson, '--commands', cmdFile, '--snapshots', snapFile, '--out', out];
    if (opts.requirePages?.length) args.push('--require-pages', opts.requirePages.join(','));
    const r = await this.run(args);
    const report = this.readReport(out);
    return { ok: r.code === 0 && report?.ok === true, code: r.code, report, stderr: r.stderr.trim(), reportFile: out, commandLine: `cd packages/reference && python3 -m reference.compare ${args.join(' ')}` };
  }
}

/** Краткое описание расхождений для сообщения проверки. */
export function describeReport(res) {
  if (res.ok) return 'ok';
  const rep = res.report;
  if (!rep) return `code ${res.code}: ${res.stderr.slice(0, 400)}`;
  const first = (rep.mismatches ?? []).slice(0, 3).map((m) => JSON.stringify(m)).join('; ');
  const ops = rep.operations && !rep.operations.ok ? ` operations: ${JSON.stringify(rep.operations.counts)} ${(rep.operations.mismatches ?? []).slice(0, 2).map((m) => JSON.stringify(m)).join('; ')}` : '';
  return `mismatchTotal=${rep.mismatchTotal ?? '?'} counts=${JSON.stringify(rep.counts ?? {})} ${first}${ops}`;
}
