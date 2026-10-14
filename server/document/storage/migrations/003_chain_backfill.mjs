/**
 * 003_chain_backfill — chain у записей, легших до миграции 002 (SPEC §9.8).
 *
 * chain(n) = sha256(chain(n-1) + tx_id + seq), chain до первой записи — ''. Цепочка
 * последовательна, поэтому считается здесь, а не одним UPDATE: проект за проектом,
 * пачками по BATCH записей, каждая пачка — своя транзакция базы (тяжёлый UPDATE не
 * держит блокировку на весь журнал). Заполненное — всегда префикс журнала проекта,
 * поэтому прерванная миграция продолжает с последней заполненной записи.
 *
 * Запускается раннером миграций (storage/pg.js) без дедлайна обычных запросов.
 */

import { createHash } from 'node:crypto';

const BATCH = 1000;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * @param {{client: import('pg').Client, log: {info: Function}}} ctx
 */
export async function up({ client, log }) {
  const projects = (await client.query(
    'SELECT DISTINCT project_id FROM operations WHERE chain IS NULL'
  )).rows.map((r) => r.project_id);
  let total = 0;
  for (const projectId of projects) {
    // с последней заполненной записи: заполненное — префикс
    const last = (await client.query(
      'SELECT seq, chain FROM operations WHERE project_id = $1 AND chain IS NOT NULL ORDER BY seq DESC LIMIT 1',
      [projectId]
    )).rows[0];
    let prev = last ? last.chain : '';
    let from = last ? Number(last.seq) : 0;
    for (;;) {
      const rows = (await client.query(
        'SELECT seq, tx_id FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
        [projectId, from, BATCH]
      )).rows;
      if (!rows.length) break;
      const seqs = [];
      const chains = [];
      for (const r of rows) {
        const seq = Number(r.seq);
        prev = sha(prev + r.tx_id + String(seq));
        seqs.push(seq);
        chains.push(prev);
      }
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE operations o SET chain = v.chain
             FROM unnest($2::bigint[], $3::text[]) AS v(seq, chain)
            WHERE o.project_id = $1 AND o.seq = v.seq`,
          [projectId, seqs, chains]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
      total += rows.length;
      from = seqs[seqs.length - 1];
    }
  }
  // голова проекта и снимки — по заполненному журналу
  await client.query(
    `UPDATE projects p SET head_chain = o.chain
       FROM operations o
      WHERE o.project_id = p.id AND o.seq = p.head_seq AND o.chain IS NOT NULL AND p.head_chain IS DISTINCT FROM o.chain`
  );
  await client.query(
    `UPDATE snapshots s SET chain = o.chain
       FROM operations o
      WHERE o.project_id = s.project_id AND o.seq = s.seq AND s.chain IS NULL`
  );
  await client.query("UPDATE snapshots SET chain = '' WHERE seq = 0 AND chain IS NULL");
  if (total) log.info(`[document/pg] 003: chain посчитан у ${total} записей журнала`);
}
