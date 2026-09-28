/**
 * Форма записи журнала — одна на оба адаптера (pg и память), чтобы клиент и
 * тесты видели одинаковый `Committed` (SPEC §9.1) независимо от того, откуда он
 * прочитан. Пустые необязательные поля не отдаём вовсе: `undo_of: null` и
 * отсутствующий `undo_of` — одно и то же для клиента, а deepEqual в тестах
 * между адаптерами так не спотыкается.
 */

/** Необязательные поля транзакции: в записи есть, только если заданы. */
const OPTIONAL = ['undo_of', 'redo_of', 'author', 'client', 'title'];

/** Дата из базы (Date) или строки → ISO. */
function iso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
}

/**
 * Committed из строки хранилища (колонки таблицы operations или такой же объект
 * адаптера в памяти).
 * @param {object} row
 * @returns {object} Committed
 */
export function toCommitted(row) {
  const out = {
    tx_id: String(row.tx_id),
    seq: Number(row.seq),
    base_seq: Number(row.base_seq),
    ops: Array.isArray(row.ops) ? row.ops : [],
    dropped: Array.isArray(row.dropped) ? row.dropped : [],
    notes: Array.isArray(row.notes) ? row.notes : [],
    author_kind: row.author_kind || 'human',
    engine: Number(row.engine),
    created_at: iso(row.created_at)
  };
  for (const k of OPTIONAL) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

/**
 * Что из транзакции ложится в колонки: секвенсор отдаёт адаптеру уже слитую
 * форму (`ops` — применённая, `dropped`/`notes` — от слияния), адаптер добавляет
 * `seq` и `created_at`.
 * @param {object} tx
 * @returns {object}
 */
export function txColumns(tx) {
  return {
    tx_id: tx.tx_id,
    base_seq: tx.base_seq,
    ops: tx.ops || [],
    dropped: tx.dropped || [],
    notes: tx.notes || [],
    undo_of: tx.undo_of ?? null,
    redo_of: tx.redo_of ?? null,
    author: tx.author ?? null,
    author_kind: tx.author_kind || 'human',
    client: tx.client ?? null,
    title: tx.title ?? null,
    engine: tx.engine
  };
}

/** Сводка проекта для списка и `hello` (SPEC §9.2, §9.3). */
export function projectSummary(p) {
  return { id: p.id, name: p.name, kind: p.kind, head_seq: p.head_seq, updated_at: p.updated_at };
}
