// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Чтение БД через `psql` («psql → JSON», SPEC §6): ревизия документа, строки `operations`, заливки фигур.
 * Только чтение; изменения состояния выполняются исключительно через API и тестовые хуки.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class Db {
  /** @param {string} dsn */
  constructor(dsn) {
    this.dsn = dsn;
  }

  /**
   * Выполняет запрос и возвращает строки как объекты (через json_agg).
   * @param {string} sql запрос без завершающего `;`
   * @returns {Promise<any[]>}
   */
  async rows(sql) {
    const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t`;
    const { stdout } = await execFileP('psql', [this.dsn, '-At', '-v', 'ON_ERROR_STOP=1', '-c', wrapped], {
      env: { ...process.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim() || '[]');
  }

  /** @param {string} s */
  static lit(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
  }

  /** @param {string} docId */
  async revision(docId) {
    const r = await this.rows(`SELECT revision FROM documents WHERE id = ${Db.lit(docId)}`);
    if (r.length === 0) throw new Error(`document ${docId} not found in DB`);
    return Number(r[0].revision);
  }

  /** @param {string} docId */
  operations(docId) {
    return this.rows(
      `SELECT op_id AS "opId", document_id AS "documentId", params_hash AS "paramsHash", result, created_at AS "createdAt"
         FROM operations WHERE document_id = ${Db.lit(docId)} ORDER BY created_at, op_id`,
    );
  }

  /** @param {string} opId */
  operation(opId) {
    return this.rows(`SELECT op_id AS "opId", document_id AS "documentId", result FROM operations WHERE op_id = ${Db.lit(opId)}`);
  }

  /** @param {string} shapeId */
  async shape(shapeId) {
    const r = await this.rows(
      `SELECT id, page_id AS "pageId", fill, fill_overridden AS "fillOverridden", is_source AS "isSource", source_id AS "sourceId"
         FROM shapes WHERE id = ${Db.lit(shapeId)}`,
    );
    return r[0] ?? null;
  }

  /** @param {string} pageId */
  pageShapes(pageId) {
    return this.rows(
      `SELECT id, fill, fill_overridden AS "fillOverridden" FROM shapes WHERE page_id = ${Db.lit(pageId)} ORDER BY id`,
    );
  }

  /** Распределение экземпляров источника по страницам (как в задании: psql group by). */
  instanceDistribution(docId) {
    return this.rows(
      `SELECT source_id AS "sourceId", page_id AS "pageId",
              count(*) FILTER (WHERE NOT fill_overridden) AS plain,
              count(*) FILTER (WHERE fill_overridden) AS overridden
         FROM shapes WHERE document_id = ${Db.lit(docId)} AND source_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`,
    );
  }
}
