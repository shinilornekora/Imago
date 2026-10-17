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
import { DROPPED_KEEP, DROPPED_OP_BYTES, DROPPED_PREVIEW_CHARS, cleanMeta, undoPartOf } from '../limits.js';

/** Необязательные поля транзакции: в записи есть, только если заданы. */
const OPTIONAL = ['undo_of', 'redo_of', 'author', 'client', 'title', 'command_id', 'command_author'];

/**
 * Начало строки — не больше `n` кодовых точек: суррогатная пара не рвётся (половинка
 * пары — «одинокий суррогат»: jsonb такую строку не примет, 22P02, и вся запись упала бы).
 * @param {string} s
 * @param {number} n
 */
export function codePointSlice(s, n) {
  if (typeof s !== 'string') return '';
  // быстрый путь: в первых n единицах UTF-16 нет суррогатов — режем как есть
  let i = 0;
  let points = 0;
  while (i < s.length && points < n) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    points++;
  }
  return s.slice(0, i);
}

/**
 * Надгробия снимка — объект id → родитель (SPEC §9.11). Принимает объект, Map или
 * массив пар; всё прочее — пусто.
 * @param {any} t
 * @returns {Record<string, string|null>}
 */
export function tombstonesObject(t) {
  const out = {};
  const put = (id, parent) => {
    if (typeof id === 'string' && id) out[id] = typeof parent === 'string' ? parent : null;
  };
  if (t instanceof Map) for (const [id, parent] of t) put(id, parent);
  else if (Array.isArray(t)) for (const pair of t) Array.isArray(pair) && put(pair[0], pair[1]);
  else if (t && typeof t === 'object') for (const [id, parent] of Object.entries(t)) put(id, parent);
  return out;
}

/**
 * Надгробия снимка на входе хранилища (круг 27, I1) → то, что ложится в колонки:
 *   `parents` — объект id → родитель (колонка `snapshots.tombstones`, формат v1: его
 *     читают экземпляры кругов 25–26, смешанные версии не теряют надгробий);
 *   `meta` — всё остальное из v2 (`{v:2, seq:{id → seq удаления}, …}`) без `parents`
 *     (колонка `tombstones_meta`); null — номеров удаления нет (v1, Map, массив пар).
 * `null`/`undefined` на входе — «неизвестно»: обе колонки NULL.
 * Само содержимое v2 хранилище не толкует — кладёт и отдаёт как есть.
 * @param {any} t
 * @returns {{parents: Record<string, string|null>|null, meta: object|null}}
 */
export function splitTombstones(t) {
  if (t === null || t === undefined) return { parents: null, meta: null };
  if (t && typeof t === 'object' && !Array.isArray(t) && !(t instanceof Map) && t.v === 2) {
    const { parents, ...meta } = t;
    return { parents: tombstonesObject(parents), meta };
  }
  return { parents: tombstonesObject(t), meta: null };
}

/**
 * Надгробия снимка на выходе (круг 27, I1). Известны, если записаны этим кругом или
 * новее для той же цепочки, что у снимка (`metaChain` = `chain`):
 *   есть номера удаления (`meta`) — v2 `{…meta, parents}`;
 *   нет (записали v1 — объект id → родитель) — v1 как есть.
 * Иначе null — «неизвестно»: снимок записал экземпляр прежней версии (его INSERT
 * колонку tombstones_chain не знает), или он переписал снимок нового поверх (цепочка
 * снимка сменилась, tombstones_chain осталась прежней). Снимок seq 0 — затравка:
 * надгробий у него нет никогда, известно всегда.
 * @param {{seq: number, chain: string, parents: any, meta: any, metaChain: any}} row
 * @returns {object|null}
 */
export function joinTombstones({ seq, chain, parents, meta, metaChain }) {
  const p = parents && typeof parents === 'object' && !Array.isArray(parents) ? parents : {};
  const known = typeof metaChain === 'string' && metaChain === (chain || '');
  if (known && meta && typeof meta === 'object' && !Array.isArray(meta)) return { ...meta, v: 2, parents: p };
  if (known) return p;
  if (Number(seq) === 0) return { v: 2, parents: p, seq: {} };
  return null;
}

/**
 * Что Postgres не примет в записи (SPEC §9.11): `\u0000` в jsonb — 22P05, одинокий
 * суррогат в jsonb — 22P02, NUL в text — 22021. Адаптер в памяти проверяет то же, чтобы
 * не быть мягче базы: одна и та же транзакция — один и тот же ответ (400).
 * @param {{json?: any[], text?: any[]}} cols значения jsonb- и text-колонок
 * @returns {null|Error & {code: string}}
 */
export function pgRejects({ json = [], text = [] }) {
  const err = (code, message) => Object.assign(new Error(message), { code });
  let found = null;
  const walk = (v, depth) => {
    if (found || depth > 200) return;
    if (typeof v === 'string') {
      if (v.includes('\u0000')) found = err('22P05', 'unsupported Unicode escape sequence');
      else if (!v.isWellFormed()) found = err('22P02', 'invalid input syntax for type json');
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        walk(k, depth + 1);
        walk(x, depth + 1);
      }
    }
  };
  for (const v of json) walk(v, 0);
  if (found) return found;
  for (const v of text) {
    if (typeof v === 'string' && v.includes('\u0000')) return err('22021', 'invalid byte sequence for encoding "UTF8": 0x00');
  }
  return null;
}

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
  // круг 32: часть большой правки (колонка 011) — только годная пара {i, n}
  const part = undoPartOf(row.undo_part);
  if (part) out.undo_part = part;
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
      for (const f of ['id', 'type', 'name', 'parent']) if (typeof v[f] === 'string') n[f] = codePointSlice(v[f], 200);
      out.node = n;
      heavy = heavy === null ? v : heavy;
    } else {
      heavy = heavy === null ? v : heavy;
    }
  }
  const json = JSON.stringify(heavy === null ? op : heavy) || '';
  out.valueBytes = size;
  // по кодовым точкам: половинка суррогатной пары в jsonb — 22P02 и отказ всей записи
  out.preview = codePointSlice(json, DROPPED_PREVIEW_CHARS);
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
 * Сколько операций не пережило слияние по выжимке `dropped`: записи + `{more: N}` хвоста
 * (то же считает pg.recentTxMeta в SQL).
 * @param {any} list
 */
export function droppedCount(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const d of list) n += d && typeof d === 'object' && typeof d.more === 'number' && d.index === undefined ? d.more : 1;
  return n;
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
    // команда агента, породившая транзакцию (SPEC §9.11) — связь журнала с трассой
    command_id: typeof tx.command_id === 'string' && tx.command_id ? tx.command_id : null,
    // круг 30: кто дал команду агенту (имя, ≤ 200 символов) — подпись «Агент · Аня» в истории
    command_author: typeof tx.command_author === 'string' && tx.command_author ? tx.command_author : null,
    // круг 32: часть большой правки {i, n} (миграция 011) — оболочка сводит части в один шаг
    undo_part: undoPartOf(tx.undo_part),
    engine: tx.engine
  };
}

/** Сводка проекта для списка и `hello` (SPEC §9.2, §9.3). */
export function projectSummary(p) {
  // имя — метаданные: без управляющих и bidi-символов и у проектов, названных до круга 31
  return { id: p.id, name: typeof p.name === 'string' ? cleanMeta(p.name) : p.name, kind: p.kind, head_seq: p.head_seq, updated_at: p.updated_at };
}

/** Сводка головы: сводка + эпоха и tip (SPEC §9.8, `?head=1`). */
export function headSummary(p) {
  return { ...projectSummary(p), epoch: p.epoch, tip: p.head_chain || '' };
}
