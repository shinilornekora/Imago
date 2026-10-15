/**
 * 003_chain_backfill — chain у записей, легших до миграции 002 (SPEC §9.8, §9.11).
 *
 * chain(n) = sha256(chain(n-1) + tx_id + seq), chain до первой записи — ''. Цепочка
 * последовательна, поэтому считается здесь, а не одним UPDATE: проект за проектом,
 * пачками по BATCH записей, каждая пачка — своя транзакция базы (тяжёлый UPDATE не
 * держит блокировку на весь журнал; читатели и писатели работают). Считается с первой
 * записи без chain: прерванная миграция (SIGTERM, обрыв) продолжает с того же места.
 *
 * Экземпляр прежней версии может писать журнал всё это время: его записи получают chain
 * триггером (002), если у предыдущей chain уже есть, иначе их подберёт следующая пачка
 * или 006 (под замком, перед «не пусто»). Прогресс — ctx.progress({done, total}) → 503
 * migrating отдаёт его в detail.
 *
 * Запускается раннером миграций (storage/pg.js) без дедлайна обычных запросов.
 */

import { createHash } from 'node:crypto';

const BATCH = 5000;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Заполнить chain проекта с первой записи без него; пачки — свои транзакции.
 * @returns {Promise<number>} сколько записей посчитано
 */
export async function fillProject(client, projectId, onBatch = () => {}) {
  const first = (await client.query(
    'SELECT min(seq) AS seq FROM operations WHERE project_id = $1 AND chain IS NULL',
    [projectId]
  )).rows[0];
  if (!first || first.seq === null) return 0;
  let from = Number(first.seq) - 1;
  let prev = '';
  if (from > 0) {
    const row = (await client.query('SELECT chain FROM operations WHERE project_id = $1 AND seq = $2', [projectId, from])).rows[0];
    if (!row || row.chain === null) throw new Error(`журнал проекта ${projectId}: нет записи ${from} с chain перед первой без chain`);
    prev = row.chain;
  }
  let total = 0;
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
          WHERE o.project_id = $1 AND o.seq = v.seq AND o.chain IS DISTINCT FROM v.chain`,
        [projectId, seqs, chains]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    total += rows.length;
    from = seqs[seqs.length - 1];
    onBatch(rows.length);
  }
  return total;
}

/**
 * @param {{client: import('pg').Client, log: {info: Function}, progress?: Function, closing?: boolean}} ctx
 */
export async function up(ctx) {
  const { client, log } = ctx;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const todo = (await client.query(
    'SELECT project_id, count(*)::bigint AS n FROM operations WHERE chain IS NULL GROUP BY project_id'
  )).rows;
  const total = todo.reduce((n, r) => n + Number(r.n), 0);
  let done = 0;
  progress({ done, total });
  for (const { project_id: projectId } of todo) {
    if (ctx.closing) throw new Error('остановка посреди заполнения');
    await fillProject(client, projectId, (n) => {
      done += n;
      progress({ done: Math.min(done, total), total });
      if (ctx.closing) throw new Error('остановка посреди заполнения');
    });
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
  if (done) log.info(`[document/pg] 003: chain посчитан у ${done} записей журнала`);
}
