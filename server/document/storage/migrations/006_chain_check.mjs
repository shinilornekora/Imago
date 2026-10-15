/**
 * 006_chain_check — «у каждой записи журнала есть chain», безопасно для смешанных версий
 * (SPEC §9.11). Заменяет `ALTER … chain SET NOT NULL` прежней 004.
 *
 * Прежняя 004 в одном выпуске с 002/003 ломалась при работающем экземпляре прежней
 * версии: тот пишет записи без chain после 003 → SET NOT NULL падал при каждом старте;
 * на большой базе он же держал ACCESS EXCLUSIVE на всё время проверки таблицы.
 *
 * Здесь:
 *   1. без замка — дозаполнить всё, что осталось без chain (003.fillProject пачками);
 *   2. одна короткая транзакция под `LOCK projects, operations IN SHARE ROW EXCLUSIVE`
 *      (писатели ждут, читатели работают): дозаполнить хвосты, которые успели лечь после
 *      шага 1 (по заполненному префиксу — только записи после последней с chain),
 *      подтянуть head_chain, `ADD CONSTRAINT … CHECK (chain IS NOT NULL) NOT VALID` —
 *      с этого мига новые строки проверяются, а записи старого экземпляра получают chain
 *      триггером 002/005 (у предыдущей он теперь всегда есть);
 *      замок ждётся не дольше lock_timeout и повторяется;
 *   3. `VALIDATE CONSTRAINT` — проверка всей таблицы под SHARE UPDATE EXCLUSIVE: чтение и
 *      запись журнала идут.
 * Каждый шаг идемпотентен: упавшая миграция не записывается в учёт, повторный старт
 * проходит её заново. База, где прежняя 004 уже поставила NOT NULL, — пропускается.
 */

import { createHash } from 'node:crypto';
import { fillProject } from './003_chain_backfill.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const CONSTRAINT = 'operations_chain_present';

export async function up(ctx) {
  const { client, log } = ctx;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const lockTimeoutMs = ctx.lockTimeoutMs > 0 ? ctx.lockTimeoutMs : 1000;
  const lockTries = ctx.lockTries > 0 ? ctx.lockTries : 60;
  const isLockTimeout = ctx.isLockTimeout || ((e) => e && (e.code === '55P03' || e.code === '40P01'));

  const notNull = (await client.query(
    `SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'operations'::regclass AND a.attname = 'chain'`
  )).rows[0];
  if (notNull && notNull.attnotnull) return;   // прежняя 004 уже легла: NOT NULL есть

  // 1. без замка
  progress({ step: 'fill' });
  const todo = (await client.query('SELECT DISTINCT project_id FROM operations WHERE chain IS NULL')).rows;
  let filled = 0;
  for (const { project_id: projectId } of todo) {
    if (ctx.closing) throw new Error('остановка посреди заполнения');
    filled += await fillProject(client, projectId);
  }

  // 2. короткая транзакция под замком
  progress({ step: 'lock' });
  const { tail, lockedMs } = await seal(client, { lockTimeoutMs, lockTries, isLockTimeout, log, closing: () => ctx.closing });

  // снимки старого экземпляра без chain (триггер ставит его сам; это — легшие до триггера)
  await client.query(
    `UPDATE snapshots s SET chain = o.chain FROM operations o
      WHERE o.project_id = s.project_id AND o.seq = s.seq AND s.chain IS NULL AND o.chain IS NOT NULL`
  );
  await client.query("UPDATE snapshots SET chain = '' WHERE seq = 0 AND chain IS NULL");

  // 3. проверка всей таблицы — без эксклюзивного замка
  progress({ step: 'validate' });
  await client.query(`ALTER TABLE operations VALIDATE CONSTRAINT ${CONSTRAINT}`);
  log.info(`[document/pg] 006: chain — у всех записей (дозаполнено ${filled} + ${tail} под замком, замок ${lockedMs} мс)`);
}

/**
 * Шаг 2 отдельно (тестам — без шага 1): дозаполнить хвосты без chain под
 * `LOCK projects, operations IN SHARE ROW EXCLUSIVE`, подтянуть head_chain, поставить
 * CHECK NOT VALID. Замок ждётся не дольше lockTimeoutMs, иначе — откат и повтор.
 * @returns {Promise<{tail: number, lockedMs: number}>}
 */
export async function seal(client, { lockTimeoutMs = 1000, lockTries = 60, isLockTimeout = (e) => e && (e.code === '55P03' || e.code === '40P01'), log = console, closing = () => false } = {}) {
  let lockedMs = 0;
  let tail = 0;
  for (let attempt = 1; ; attempt++) {
    await client.query('BEGIN');
    // время, пока писатели ждут: с запроса замка (за ним уже встают) до COMMIT
    const t0 = Date.now();
    try {
      await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
      // порядок замков — как у писателя (UPDATE projects → INSERT operations): писатель,
      // уже державший строку проекта, доходит до конца, новые ждут на projects
      await client.query('LOCK TABLE projects, operations IN SHARE ROW EXCLUSIVE MODE');
      // заполненное — префикс журнала: пусто может быть только после последней с chain;
      // голова проекта без chain — признак такого хвоста
      const heads = (await client.query(
        `SELECT p.id FROM projects p JOIN operations o ON o.project_id = p.id AND o.seq = p.head_seq
          WHERE o.chain IS NULL`
      )).rows;
      for (const { id } of heads) {
        const last = (await client.query(
          'SELECT seq, chain FROM operations WHERE project_id = $1 AND chain IS NOT NULL ORDER BY seq DESC LIMIT 1', [id]
        )).rows[0];
        let prev = last ? last.chain : '';
        const rows = (await client.query(
          'SELECT seq, tx_id FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq', [id, last ? Number(last.seq) : 0]
        )).rows;
        const seqs = [];
        const chains = [];
        for (const r of rows) {
          prev = sha(prev + r.tx_id + String(r.seq));
          seqs.push(Number(r.seq));
          chains.push(prev);
        }
        await client.query(
          `UPDATE operations o SET chain = v.chain FROM unnest($2::bigint[], $3::text[]) AS v(seq, chain)
            WHERE o.project_id = $1 AND o.seq = v.seq`,
          [id, seqs, chains]
        );
        tail += rows.length;
      }
      await client.query(
        `UPDATE projects p SET head_chain = o.chain FROM operations o
          WHERE o.project_id = p.id AND o.seq = p.head_seq AND o.chain IS NOT NULL AND p.head_chain IS DISTINCT FROM o.chain`
      );
      const has = (await client.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = 'operations'::regclass AND conname = $1`, [CONSTRAINT]
      )).rowCount;
      if (!has) await client.query(`ALTER TABLE operations ADD CONSTRAINT ${CONSTRAINT} CHECK (chain IS NOT NULL) NOT VALID`);
      await client.query('COMMIT');
      lockedMs = Date.now() - t0;
      break;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (isLockTimeout(e) && attempt < lockTries && !closing()) {
        if (attempt === 1 || attempt % 10 === 0) log.warn(`[document/pg] 006: журнал занят, повтор замка ${attempt}`);
        await new Promise((r) => setTimeout(r, Math.min(2000, 100 * attempt)));
        continue;
      }
      throw e;
    }
  }
  return { tail, lockedMs };
}
