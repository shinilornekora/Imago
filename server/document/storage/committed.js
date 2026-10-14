/**
 * Форма записи журнала — одна на оба адаптера (pg и память), чтобы клиент и
 * тесты видели одинаковый `Committed` (SPEC §9.1) независимо от того, откуда он
 * прочитан. Пустые необязательные поля не отдаём вовсе: `undo_of: null` и
 * отсутствующий `undo_of` — одно и то же для клиента, а deepEqual в тестах
 * между адаптерами так не спотыкается.
 *
 * Здесь же — якорь цепочки (`chainNext`) и выжимка `dropped` (SPEC §9.8): обе
 * вещи обязаны совпадать у адаптеров байт в байт.
 */

import { createHash, randomBytes } from 'node:crypto';
import { DROPPED_KEEP, DROPPED_OP_BYTES, DROPPED_PREVIEW_CHARS } from '../limits.js';

/** Необязательные поля транзакции: в записи есть, только если заданы. */
const OPTIONAL = ['undo_of', 'redo_of', 'author', 'client', 'title'];

/** Дата из базы (Date) или строки → ISO. */
function iso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
}

/**
 * Якорь цепочки (SPEC §9.8): chain(n) = sha256(chain(n-1) + tx_id + seq), до
 * первой записи — ''. Тот же расчёт делает Postgres в commitTx
 * (`encode(sha256(convert_to(head_chain || tx_id || seq::text, 'UTF8')), 'hex')`).
 * @param {string} prev
 * @param {string} txId
 * @param {number} seq
 */
export function chainNext(prev, txId, seq) {
  return createHash('sha256').update(String(prev || '') + String(txId) + String(seq), 'utf8').digest('hex');
}

/** Новая метка эпохи: 12 hex, случайная (счётчик после restore совпал бы со старой). */
export function newEpoch() {
  return randomBytes(6).toString('hex');
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
  if (typeof row.chain === 'string') out.chain = row.chain;
  for (const k of OPTIONAL) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

/** Байты JSON значения (UTF-8). */
export function jsonBytes(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v === undefined ? null : v), 'utf8');
  } catch (_) {
    return 0;
  }
}

/**
 * Операция в выжимке: скалярные поля как есть, большие значения (`value`, `node`,
 * всё прочее неcкалярное) — `valueBytes` (сколько весило) и `preview` (начало JSON).
 */
function compactOp(op) {
  if (!op || typeof op !== 'object') return op;
  const size = jsonBytes(op);
  if (size <= DROPPED_OP_BYTES) return op;
  const out = {};
  let heavy = null;
  for (const [k, v] of Object.entries(op)) {
    if (v === null || typeof v === 'string' && v.length <= 200 || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (k === 'node' && v && typeof v === 'object') {
      // узел: опознавательные поля оставляем — человеку и истории нужно, что это было
      const n = {};
      for (const f of ['id', 'type', 'name', 'parent']) if (typeof v[f] === 'string') n[f] = v[f].slice(0, 200);
      out.node = n;
      heavy = heavy === null ? v : heavy;
    } else {
      heavy = heavy === null ? v : heavy;
    }
  }
  const json = JSON.stringify(heavy === null ? op : heavy) || '';
  out.valueBytes = size;
  out.preview = json.slice(0, DROPPED_PREVIEW_CHARS);
  return out;
}

/**
 * `dropped` для журнала и ответа (SPEC §9.8): не больше DROPPED_KEEP записей,
 * остаток — последней записью `{more: N}`; большие операции — выжимкой.
 * Идемпотентна: выжимку выжимать второй раз нечего.
 * @param {object[]} list
 * @returns {object[]}
 */
export function compactDropped(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const real = list.filter((d) => d && !(typeof d.more === 'number' && d.index === undefined));
  const carried = list.reduce((n, d) => n + (d && typeof d.more === 'number' && d.index === undefined ? d.more : 0), 0);
  const kept = real.slice(0, DROPPED_KEEP).map((d) => (d && d.op ? { ...d, op: compactOp(d.op) } : d));
  const more = real.length - kept.length + carried;
  if (more > 0) kept.push({ more });
  return kept;
}

/**
 * Что из транзакции ложится в колонки: секвенсор отдаёт адаптеру уже слитую
 * форму (`ops` — применённая, `dropped`/`notes` — от слияния), адаптер добавляет
 * `seq`, `chain` и `created_at`.
 * @param {object} tx
 * @returns {object}
 */
export function txColumns(tx) {
  return {
    tx_id: tx.tx_id,
    base_seq: tx.base_seq,
    ops: tx.ops || [],
    dropped: compactDropped(tx.dropped || []),
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

/** Сводка головы: сводка + эпоха и tip (SPEC §9.8, `?head=1`). */
export function headSummary(p) {
  return { ...projectSummary(p), epoch: p.epoch, tip: p.head_chain || '' };
}
