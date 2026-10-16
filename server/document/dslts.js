/**
 * DSLTS — DSL Transaction Sequencer (SPEC §8.1, §9.4, §9.8): единственный писатель.
 * Держит голову каждого открытого проекта в памяти, сливает транзакцию поверх
 * головы тем же `core.rebase`, что и клиент, нумерует через базу, отдаёт
 * `Committed` в Hub, раз в N транзакций пишет снимок.
 *
 * Слияние не отказывает (§8.3): транзакция целиком не отклоняется никогда,
 * отдельная операция отбрасывается только по правилам §9.6 (и пределам §9.8) —
 * и автору об этом сказано в `dropped`. Отказ бывает только у формы (400),
 * размера (413) и версии движка (426).
 *
 * Голова = {doc, head_seq, chain, epoch, tombstones, recent}. Надгробия — id
 * удалённых узлов → последний родитель (восстанавливаются из `remove` в хвосте
 * после снимка). `chain` — якорь последней записи: sha256(prev + tx_id + seq).
 *
 * Несколько экземпляров на одной базе (§9.8): экземпляр, записавший транзакцию,
 * шлёт NOTIFY (в той же транзакции базы); остальные по уведомлению дочитывают
 * хвост и отдают его Hub. Голова в памяти сверяется с базой (head_seq,
 * head_chain, epoch) — по уведомлению, при подключении сокета, по таймеру и при
 * «чужом» номере на записи:
 *   база впереди, цепочка продолжается  → дочитать хвост;
 *   база позади или цепочка другая      → база откатилась: эпоха меняется
 *                                         (compare-and-set — один раз на откат),
 *                                         голова выбрасывается, Hub закрывает
 *                                         сокеты проекта кодом 4410;
 *   эпоха в базе другая                 → её сменил кто-то ещё: голова выбрасывается.
 *
 * Круг 25 (§9.10): строки транзакции чистятся (id с U+0000/половиной — 400), поля операций
 * проверяются по типу; очередь мьютекса ограничена байтами (проект и экземпляр — 503 busy);
 * надгробия загружаются из снимка и пишутся в него; байты документа считаются точно;
 * переигрывание после отката (`replay_of_epoch`) не затирает более новое чужое (`stale`).
 */

import * as core from '../../src/core.js';
import { applyOps, applyBatches, rebase, collectTombstones, ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, notFound, tooLarge, unavailable, viaStorage } from './errors.js';
import { chainNext, compactDropped, jsonBytes } from './storage/committed.js';
import {
  MAX_OPS_PER_TX, MAX_DOC_BYTES, MAX_DOC_NODES, MERGE_BUDGET_MS,
  SNAPSHOT_EVERY, SNAPSHOT_KEEP, VERIFY_MS, PAGE_TXS,
  QUEUE_PROJECT_BYTES, QUEUE_PROJECT_TXS, QUEUE_TOTAL_BYTES, BUSY_RETRY_S,
  REPLAY_MAX_AGE_MS, REPLAY_SCAN_TXS, MAX_VALUE_DEPTH, MAX_OP_ID, MAX_COMMAND_ID,
  TOMB_KEEP_SEQ, TOMB_PRUNE_EVERY, TOMB_MAX, RECENT_TXS, RECENT_BYTES,
  isCleanText, cleanText, cutText, cleanDeep
} from './limits.js';

/** Предел операций в транзакции (совместимость: прежде экспортировался отсюда). */
export const MAX_OPS = MAX_OPS_PER_TX;
/** Сколько последних транзакций голова помнит выжимкой (идемпотентность, окно `stale`); см. RECENT_BYTES. */
export const RECENT_LIMIT = RECENT_TXS;
/** Выгрузка головы по бездействию. */
export const IDLE_MS = 10 * 60 * 1000;
/**
 * Сколько раз пересливать, если голову двигает другой экземпляр. Проигрыш
 * гонки стоит один круг до базы, а очередь соседа может быть длинной — трёх
 * попыток на всплеске не хватает; после третьей ждём случайные миллисекунды,
 * чтобы два экземпляра не били в одну голову в такт.
 */
const MAX_RETRIES = 12;
const RETRY_BACKOFF_MS = 15;
/** Страница чтения хвоста внутри сервиса (загрузка и догон головы): байтами шире, чем наружу. */
const INTERNAL_PAGE_BYTES = 16 * 1024 * 1024;
const OP_KINDS = new Set(['create', 'remove', 'set', 'move', 'setToken']);
const AUTHOR_KINDS = new Set(['human', 'agent', 'system']);
const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_TITLE = 500;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** id-строка: не длиннее max и чистая (U+0000 и одиночные суррогаты в id — это 400, а не правка). */
const isId = (v, max) => isStr(v, max) && isCleanText(v);
const isMissing = (v) => v === undefined || v === null;

/**
 * Поля операции, которые читает слияние и применение: их тип проверяется здесь
 * (иначе `parent: {"toString": 1}` доходил до String() в движке и давал 500).
 * Отсутствующее поле — дело rebase (`dropped: invalid`, §9.7); присутствующее не
 * того типа или с негодными символами — 400.
 * @returns {string|null} что не так
 */
function opShapeError(op) {
  const idOk = (v) => typeof v === 'string' && v.length <= MAX_OP_ID && isCleanText(v);
  const optId = (v, name) => (isMissing(v) || idOk(v) ? null : `${name}: строка-id`);
  let err = optId(op.id, 'id') || optId(op.parent, 'parent');
  if (err) return err;
  if (op.after !== undefined && op.after !== null && !idOk(op.after)) return 'after: строка-id или null';
  if (!isMissing(op.index) && !(typeof op.index === 'number' && Number.isFinite(op.index))) return 'index: число';
  if (!isMissing(op.path) && !(typeof op.path === 'string' && op.path.length <= 1024 && isCleanText(op.path))) return 'path: строка';
  if (op.op === 'create' && !isMissing(op.node)) {
    if (typeof op.node !== 'object' || Array.isArray(op.node)) return 'node: объект';
    err = optId(op.node.id, 'node.id') || optId(op.node.parent, 'node.parent');
    if (err) return err;
  }
  return null;
}

/**
 * Проверка формы транзакции (SPEC §9.1, §9.10). Возвращает нормализованную копию с
 * известными полями; форма негодна → 400, операций больше предела → 413,
 * версия движка не наша → 426. Операции проверяются по форме полей, которые читает
 * движок (id, parent, after, index, path, node.id, node.parent), по смыслу их судит
 * rebase (`dropped: invalid`), иначе транзакция с одной битой операцией
 * отклонялась бы целиком — против §8.3.
 *
 * Строки (§9.10): id (tx_id, undo_of, redo_of, client, id в операциях) с U+0000 или
 * одиночной суррогатной половиной — 400; значения (author, title, всё внутри
 * операций, включая ключи) — чистятся: U+0000 убирается, одиночная половина → U+FFFD.
 * Иначе запись в jsonb падала, ответ был 503 retryable, и очередь клиента стояла вечно.
 * @param {any} raw
 * @param {{author?: string}} [ctx] автор из заголовка X-Author, если в теле нет
 * @returns {object}
 */
export function validateTx(raw, ctx = {}) {
  const txId = raw && isStr(raw.tx_id, MAX_ID) ? { tx_id: cleanText(raw.tx_id) } : {};
  const bad = (msg) => badRequest(msg, { compat: txId });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('транзакция должна быть объектом');
  if (!isId(raw.tx_id, MAX_ID)) throw bad('tx_id: непустая строка до 128 символов без U+0000 и одиночных суррогатов');
  if (!Number.isInteger(raw.base_seq) || raw.base_seq < 0) throw bad('base_seq: целое ≥ 0');
  if (!Array.isArray(raw.ops)) throw bad('ops: массив операций');
  if (raw.ops.length > MAX_OPS_PER_TX) {
    throw tooLarge(`ops: не больше ${MAX_OPS_PER_TX} операций в транзакции — разбейте правку`, { compat: txId, detail: { limit: 'ops_per_tx', max: MAX_OPS_PER_TX, got: raw.ops.length } });
  }
  for (let i = 0; i < raw.ops.length; i++) {
    const op = raw.ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op) || !OP_KINDS.has(op.op)) throw bad(`ops[${i}]: неизвестная операция`);
    const err = opShapeError(op);
    if (err) throw bad(`ops[${i}]: ${err}`);
  }
  for (const k of ['undo_of', 'redo_of', 'client']) {
    if (!isMissing(raw[k]) && raw[k] !== '' && !isId(raw[k], MAX_ID)) throw bad(`${k}: строка-id до ${MAX_ID} символов`);
  }
  for (const [k, max] of [['author', MAX_NAME], ['title', MAX_TITLE]]) {
    if (!isMissing(raw[k]) && (typeof raw[k] !== 'string' || raw[k].length > max)) throw bad(`${k}: строка до ${max} символов`);
  }
  if (raw.author_kind !== undefined && raw.author_kind !== null && !AUTHOR_KINDS.has(raw.author_kind)) throw bad('author_kind: human · agent · system');
  if (!isMissing(raw.replay_of_epoch) && !isId(raw.replay_of_epoch, 64)) throw bad('replay_of_epoch: метка эпохи');
  if (!isMissing(raw.replay_at) && !(typeof raw.replay_at === 'string' && raw.replay_at.length <= 40 && Number.isFinite(Date.parse(raw.replay_at)))) throw bad('replay_at: дата ISO');
  // версия движка — после формы: у мусора нет версии, у старого клиента есть, и ему нужен именно 426
  if (raw.engine !== ENGINE_VERSION) {
    throw new DocError(426, 'engine', `версия движка ${raw.engine === undefined ? 'не указана' : raw.engine}, сервер работает с ${ENGINE_VERSION} — обновите клиент`, {
      retryable: false, detail: { engine: ENGINE_VERSION }, compat: { engine: ENGINE_VERSION, ...txId }
    });
  }
  let ops;
  try {
    ops = cleanDeep(raw.ops);
  } catch (e) {
    if (e && e.code === 'depth') throw bad(`ops: вложенность значений глубже ${MAX_VALUE_DEPTH}`);
    throw e;
  }
  const tx = { tx_id: raw.tx_id, base_seq: raw.base_seq, ops, engine: ENGINE_VERSION };
  if (raw.undo_of) tx.undo_of = raw.undo_of;
  if (raw.redo_of) tx.redo_of = raw.redo_of;
  const author = cleanText(typeof raw.author === 'string' && raw.author ? raw.author : ctx.author);
  if (author) tx.author = cutText(String(author), MAX_NAME);
  tx.author_kind = raw.author_kind || 'human';
  if (raw.client) tx.client = raw.client;
  if (raw.title) tx.title = cleanText(raw.title);
  // связь с командой агента (трасса): метаданные — негодное значение не губит правку, его просто нет
  if (isId(raw.command_id, MAX_COMMAND_ID)) tx.command_id = raw.command_id;
  if (raw.replay_of_epoch) {
    tx.replay_of_epoch = raw.replay_of_epoch;
    if (raw.replay_at) tx.replay_at = new Date(Date.parse(raw.replay_at)).toISOString();
  }
  return tx;
}

/**
 * Первый индекс, на котором строгий applyOps ломается: двоичный поиск по
 * префиксам (префикс ломается тогда и только тогда, когда содержит первую
 * виноватую). log₂(n) применений вместо n — на 5000 операциях поверх большого
 * документа это разница между миллисекундами и секундами.
 */
function firstFailing(doc, list, apply = applyOps) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (apply(doc, list.slice(0, mid + 1)).error) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const nodeCount = (doc) => (doc && doc.nodes ? Object.keys(doc.nodes).length : 0);

/** Байты JSON документа без словаря узлов и токенов (метаданные, версия): их замена в delta. */
const restBytes = (doc) => jsonBytes({ ...doc, nodes: null, tokens: null });

/**
 * Точная разница байт JSON документа после применения (SPEC §9.10, предел
 * документа): applyOps копирует словарь узлов поверхностно и заменяет только
 * изменённые узлы, поэтому сравнение по ссылке находит ровно их. Разница
 * складывается из узлов (`"id":{…}` и запятые), токенов и прочих полей — сумма
 * совпадает с `jsonBytes(after) - jsonBytes(before)` байт в байт.
 * @param {object} before
 * @param {object} after
 * @returns {number}
 */
export function docBytesDelta(before, after) {
  if (before === after) return 0;
  let delta = restBytes(after) - restBytes(before);
  if (before.tokens !== after.tokens) delta += jsonBytes(after.tokens) - jsonBytes(before.tokens);
  const a = before.nodes || {};
  const b = after.nodes || {};
  if (a !== b) {
    const entry = (id, node) => jsonBytes(id) + 1 + jsonBytes(node);
    let na = 0;
    let nb = 0;
    for (const id in a) {
      na += 1;
      const x = a[id];
      const y = Object.prototype.hasOwnProperty.call(b, id) ? b[id] : undefined;
      if (y === undefined) delta -= entry(id, x);
      else if (y !== x) delta += jsonBytes(y) - jsonBytes(x);
    }
    for (const id in b) {
      nb += 1;
      if (!Object.prototype.hasOwnProperty.call(a, id)) delta += entry(id, b[id]);
    }
    // запятые между записями словаря
    delta += Math.max(0, nb - 1) - Math.max(0, na - 1);
  }
  return delta;
}

/** Лист документа, который пишет операция: `n:<id>\u0000<path>` (set) или `t:\u0000<path>` (setToken). */
function leafOf(op) {
  if (!op || typeof op.path !== 'string') return null;
  if (op.op === 'set' && typeof op.id === 'string') return { scope: 'n:' + op.id, path: op.path };
  if (op.op === 'setToken') return { scope: 't:', path: op.path };
  return null;
}
/** Пути пересекаются: один — префикс другого по сегментам (`layout` и `layout.gap`). */
const pathsMeet = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');

/**
 * Слияние транзакции с головой (SPEC §9.4, п.2; §9.8; §9.10): rebase → строгий applyOps;
 * не прошло — виноватая операция в `dropped` с `reason:'invalid'`, повтор (в
 * пределах бюджета времени — дальше подозрительный остаток отбрасывается целиком,
 * `limit:'merge_budget'`). Документ после транзакции больше предела (узлы, байты —
 * байты считаются точно, разницей по изменённым узлам) и больше, чем был, —
 * отбрасываются все операции, кроме `remove` (`limit:'doc_nodes'|'doc_bytes'`).
 * `lim.stale` — индексы операций, которые отброшены заранее с `reason:'stale'`
 * (переигрывание после отката базы, их лист уже переписан позже). Надгробия
 * считаются по применённой форме ДО применения.
 * @param {{doc:object, tombstones:Map, docBytes?:number}} head
 * @param {object} tx
 * @param {{mergeBudgetMs?:number, maxDocNodes?:number, maxDocBytes?:number, applyOps?:Function, stale?:Set<number>}} [lim]
 *   `applyOps` — подмена строгого применения (тестам: по контракту rebase отдаёт
 *   применимое, и ветку «applyOps не принял» иначе не достать)
 * @returns {{ops:object[], dropped:object[], notes:object[], doc:object, tombstones:[string, string|null][], docBytes:number}}
 */
export function mergeIntoHead(head, tx, lim = {}) {
  const budget = lim.mergeBudgetMs !== undefined ? lim.mergeBudgetMs : MERGE_BUDGET_MS;
  const maxNodes = lim.maxDocNodes || MAX_DOC_NODES;
  const maxBytes = lim.maxDocBytes || MAX_DOC_BYTES;
  const apply = typeof lim.applyOps === 'function' ? lim.applyOps : applyOps;
  const started = Date.now();
  const src = tx.ops;
  const dropped = [];
  let notes = [];
  // заранее отброшенные (stale): в rebase не идут, индексы остальных — через карту
  const stale = lim.stale && lim.stale.size ? lim.stale : null;
  const map = [];
  for (let i = 0; i < src.length; i++) {
    if (stale && stale.has(i)) dropped.push({ index: i, op: src[i], reason: 'stale' });
    else map.push(i);
  }
  const input = stale ? map.map((i) => src[i]) : src;
  // бюджет действует и внутри самого слияния (круг 26): rebase 5000 операций над
  // большим документом не должен съесть время под мьютексом проекта до проверки
  const rb = rebase(head.doc, input, { tombstones: head.tombstones, deadline: started + budget });
  for (const d of rb.dropped) dropped.push({ ...d, index: map[d.index] });
  notes = rb.notes.map((n) => ({ ...n, index: map[n.index] }));
  let kept = rb.ops.slice();
  // исходные индексы оставленных операций: rebase сохраняет порядок, минуя отброшенные
  const droppedIdx = new Set(dropped.map((d) => d.index));
  let keptIdx = [];
  for (let i = 0; i < src.length; i++) if (!droppedIdx.has(i)) keptIdx.push(i);

  const drop = (i, extra) => {
    const at = keptIdx[i];
    dropped.push({ index: at, op: src[at], reason: 'invalid', ...(extra || {}) });
    droppedIdx.add(at);
  };
  const settle = () => {
    for (;;) {
      const res = apply(head.doc, kept);
      if (!res.error) return res.doc;
      const bad = firstFailing(head.doc, kept, apply);
      if (Date.now() - started > budget) {
        // бюджет кончился: виноватую и всё после неё — в dropped, дальше не ищем
        for (let i = bad; i < kept.length; i++) drop(i, { limit: 'merge_budget' });
        kept = kept.slice(0, bad);
        keptIdx = keptIdx.slice(0, bad);
        continue;
      }
      drop(bad);
      kept = kept.filter((_, i) => i !== bad);
      keptIdx = keptIdx.filter((_, i) => i !== bad);
    }
  };
  let doc = settle();

  // пределы документа: узлы — счётом, байты — точно (разница по изменённым узлам)
  const beforeNodes = nodeCount(head.doc);
  const beforeBytes = Number.isFinite(head.docBytes) ? head.docBytes : jsonBytes(head.doc);
  let afterNodes = nodeCount(doc);
  let afterBytes = beforeBytes + docBytesDelta(head.doc, doc);
  let limit = null;
  if (afterNodes > maxNodes && afterNodes > beforeNodes) limit = 'doc_nodes';
  else if (afterBytes > maxBytes && afterBytes > beforeBytes) limit = 'doc_bytes';
  if (limit) {
    const keepRemoves = [];
    const keepRemovesIdx = [];
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].op === 'remove') {
        keepRemoves.push(kept[i]);
        keepRemovesIdx.push(keptIdx[i]);
      } else {
        drop(i, { limit });
      }
    }
    kept = keepRemoves;
    keptIdx = keepRemovesIdx;
    doc = settle();
    afterNodes = nodeCount(doc);
    afterBytes = beforeBytes + docBytesDelta(head.doc, doc);
  }
  dropped.sort((a, b) => a.index - b.index);
  notes = notes.filter((n) => !droppedIdx.has(n.index));
  return {
    ops: kept, dropped, notes, doc,
    tombstones: collectTombstones(head.doc, kept),
    docBytes: afterBytes
  };
}

const entriesOf = (x) => (x instanceof Map ? [...x] : x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(x) : []);

/**
 * Надгробия снимка (I1, круг 27) → `{parents: Map id→родитель, seq: Map id→seq удаления}`
 * или `null` — «неизвестно» (снимок записал экземпляр прежней версии: колонка NULL).
 *   v2 — `{v:2, parents:{id: parent}, seq:{id: seq}}`;
 *   v1 — плоский `{id: parent}` (круги 25–26) или массив пар: seq удаления неизвестен —
 *        считается `atSeq` (номер снимка), то есть не раньше снимка: прореживание
 *        с таким номером только позже, чем могло бы.
 * Если движок даёт `normalizeTombstones` — разбор его (одно правило с репликой).
 * @param {any} raw
 * @param {number} [atSeq]
 * @returns {{parents: Map<string, string|null>, seq: Map<string, number>}|null}
 */
export function readTombstones(raw, atSeq = 0) {
  if (raw === null || raw === undefined) return null;
  let parents = null;
  let seqs = null;
  if (typeof core.normalizeTombstones === 'function') {
    let n;
    try {
      n = core.normalizeTombstones(raw, { seq: atSeq });
    } catch (_) { n = undefined; }
    // движок сказал «неизвестно» (формат, которого он не знает, негодный v2) — так и есть:
    // голова восстановит надгробия журналом, а не прочтёт мусор как v1
    if (n === null) return null;
    if (n && typeof n === 'object') {
      parents = entriesOf(n.parents);
      seqs = entriesOf(n.seq);
    }
  }
  if (!parents) {
    if (Array.isArray(raw)) {
      parents = raw.filter((p) => Array.isArray(p)).map((p) => [p[0], p[1]]);
      seqs = [];
    } else if (typeof raw === 'object' && raw.v === 2) {
      parents = entriesOf(raw.parents);
      seqs = entriesOf(raw.seq);
    } else {
      parents = entriesOf(raw);
      seqs = [];
    }
  }
  const seqOf = new Map();
  for (const [id, v] of seqs) if (Number.isInteger(v) && v >= 0) seqOf.set(id, v);
  const list = [];
  for (const [id, parent] of parents) {
    if (typeof id !== 'string' || !id) continue;
    list.push([id, typeof parent === 'string' ? parent : null, seqOf.has(id) ? seqOf.get(id) : atSeq]);
  }
  // порядок вставки = порядок удаления: прореживание и предел снимают с начала
  list.sort((a, b) => a[2] - b[2]);
  const out = { parents: new Map(), seq: new Map() };
  for (const [id, parent, s] of list) {
    out.parents.set(id, parent);
    out.seq.set(id, s);
  }
  return out;
}

/** Надгробия снимка → Map id → родитель (совместимость; `null` и негодное — пусто). */
export function tombstonesOf(raw) {
  const t = readTombstones(raw);
  return t ? t.parents : new Map();
}

/** Плоская форма v1 `{id: parent}` — клиенту в `snapshot.tombstones` (его прогнозу слияния нужен только родитель). */
export function flatTombstones(raw) {
  const t = readTombstones(raw);
  return t ? Object.fromEntries(t.parents) : null;
}

/** Форма v2 для снимка: `{v:2, parents, seq}`. */
export function tombstonesV2(parents, seqs) {
  return { v: 2, parents: Object.fromEntries(parents), seq: Object.fromEntries(seqs) };
}

/** Сводка проекта из сообщения шины `{k:'project', p, n, d, s, u}` — или null, если форма не та. */
function projectOfBus(m) {
  if (typeof m.n !== 'string' || typeof m.d !== 'string') return null;
  return { id: m.p, name: m.n, kind: m.d, head_seq: Number.isInteger(m.s) ? m.s : undefined, updated_at: typeof m.u === 'string' ? m.u : undefined };
}

/** Листья set/setToken транзакции — для выжимки в голове и для окна `stale`. */
function leavesOf(c) {
  if (c && Array.isArray(c.leaves)) return c.leaves;
  const out = [];
  for (const op of (c && c.ops) || []) {
    const l = leafOf(op);
    if (l) out.push(l);
  }
  return out;
}

/**
 * Выжимка записанной транзакции для памяти головы (круг 27): всё, что нужно
 * идемпотентности и окну `stale`, без операций — голова не держит 500 транзакций по
 * 4 МБ. `bytes` — оценка памяти выжимки (строки по длине, поля — константой).
 */
function summaryOf(c, replayAt) {
  const leaves = leavesOf(c);
  let bytes = 160;
  for (const k of ['tx_id', 'chain', 'client', 'created_at', 'author']) if (typeof c[k] === 'string') bytes += 2 * c[k].length;
  for (const l of leaves) bytes += 48 + 2 * (l.scope.length + l.path.length);
  const out = { tx_id: c.tx_id, seq: c.seq, chain: c.chain, client: c.client, created_at: c.created_at, author: c.author, author_kind: c.author_kind, leaves, bytes };
  if (replayAt) out.replay_at = replayAt;
  return out;
}

/**
 * @param {{
 *   storage: object,
 *   instanceId?: string,
 *   snapshotEvery?: number,
 *   snapshotKeep?: number,
 *   idleMs?: number,
 *   verifyMs?: number,
 *   mergeBudgetMs?: number,
 *   maxDocNodes?: number,
 *   maxDocBytes?: number,
 *   tombKeepSeq?: number, tombPruneEvery?: number, tombMax?: number,
 *   recentTxs?: number, recentBytes?: number,
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createSequencer({
  storage, instanceId = 'i', snapshotEvery = SNAPSHOT_EVERY, snapshotKeep = SNAPSHOT_KEEP,
  idleMs = IDLE_MS, verifyMs = VERIFY_MS, mergeBudgetMs, maxDocNodes, maxDocBytes, log = console,
  queueProjectBytes = QUEUE_PROJECT_BYTES, queueProjectTxs = QUEUE_PROJECT_TXS, queueTotalBytes = QUEUE_TOTAL_BYTES,
  replayScanTxs = REPLAY_SCAN_TXS,
  tombKeepSeq = TOMB_KEEP_SEQ, tombPruneEvery = TOMB_PRUNE_EVERY, tombMax = TOMB_MAX,
  recentTxs = RECENT_TXS, recentBytes = RECENT_BYTES
}) {
  const lim = { mergeBudgetMs, maxDocNodes, maxDocBytes };
  /** Очередь записи (§9.10): projectId → {bytes, txs} транзакций в мьютексе (ждут и пишутся); всего — байт. */
  const queued = new Map();
  let queuedBytes = 0;
  let busyRefusals = 0;
  /** @type {Map<string, object>} projectId → голова */
  const heads = new Map();
  /** @type {Map<string, Promise>} projectId → хвост очереди (мьютекс) */
  const locks = new Map();
  /** @type {Set<Function>} слушатели событий (Hub): {kind:'tx'|'epoch'|'missing'|'project', …} */
  const listeners = new Set();
  /** @type {Set<Promise>} снимки и сверки в полёте — close() их дожидается */
  const inflight = new Set();
  /** проекты, для которых сверка уже стоит в очереди (уведомления сливаются) */
  const syncQueued = new Set();
  /** Hub говорит, кого он держит открытым: такие головы по бездействию не выгружаются */
  let watched = () => false;
  let closed = false;
  /** круги заново из-за гонки с другим экземпляром и исчерпанные попытки (тестам, отладке) */
  let staleRetries = 0;
  let exhausted = 0;

  /**
   * Мьютекс проекта: очередь промисов. Отказ одной транзакции не должен запирать
   * очередь, поэтому хвост всегда резолвится, а ошибка уходит только вызвавшему.
   */
  function withLock(projectId, fn) {
    const prev = locks.get(projectId) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.catch(() => {}).then(() => gate);
    locks.set(projectId, tail);
    return prev.catch(() => {}).then(fn).finally(() => {
      release();
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
  }

  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  function emit(event) {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (e) {
        log.warn('[document/dslts] слушатель упал:', e && e.message);
      }
    }
  }

  /**
   * Запомнить записанную транзакцию выжимкой (круг 27): предел — числом и байтами
   * выжимок; одна выжимка больше предела байт всё равно помнится (последняя).
   */
  function remember(head, committed, replayAt) {
    const sum = summaryOf(committed, replayAt);
    head.recent.push(sum);
    head.recentBytes += sum.bytes;
    head.byTx.set(sum.tx_id, sum);
    while (head.recent.length > 1 && (head.recent.length > recentTxs || head.recentBytes > recentBytes)) {
      const old = head.recent.shift();
      head.recentBytes -= old.bytes;
      if (head.byTx.get(old.tx_id) === old) head.byTx.delete(old.tx_id);
    }
  }

  /**
   * tx_id уже записан (память головы) → запись целиком из базы. Голова помнит только
   * выжимку, поэтому повтор стоит запрос — повторы редки, а память головы — нет.
   * Не нашлось (база ушла назад) — null: дальше решит UNIQUE в commitTx.
   */
  async function knownTx(projectId, head, txId) {
    const sum = head.byTx.get(txId);
    if (!sum || typeof storage.findTx !== 'function') return null;
    const full = await viaStorage(storage.findTx(projectId, txId));
    return full && full.seq === sum.seq ? full : null;
  }

  /* ------------------------------ надгробия ------------------------------ */

  /** Надгробие с номером удаления; порядок вставки — порядок удаления (предел снимает самые старые). */
  function addTomb(head, id, parent, seq) {
    if (head.tombstones.has(id)) {
      head.tombstones.delete(id);
      head.tombSeq.delete(id);
    }
    head.tombstones.set(id, parent);
    head.tombSeq.set(id, seq);
  }

  /**
   * Прореживание (I1): граница — по номеру головы, кратному tombPruneEvery, минус
   * tombKeepSeq; сверх tombMax — самые старые. Только по номерам, не по часам: голова
   * в памяти и голова со снимка на одном seq знают одно и то же.
   */
  function pruneTombs(head) {
    const bound = Math.floor(head.head_seq / tombPruneEvery) * tombPruneEvery - tombKeepSeq;
    for (const [id, seq] of head.tombSeq) {
      if (seq >= bound && head.tombSeq.size <= tombMax) break;
      head.tombSeq.delete(id);
      head.tombstones.delete(id);
    }
  }

  /**
   * Применить страницу записанных транзакций к голове (загрузка хвоста, догон за
   * другим экземпляром) одним черновиком — `core.applyBatches` (круг 26): словарь
   * узлов копируется раз на страницу, а не дважды на транзакцию. Итог тот же, что у
   * поштучного collectTombstones + applyOps (тест сверяет).
   */
  function absorbPage(head, projectId, page) {
    if (!page.length) return;
    const before = head.doc;
    const res = applyBatches(before, page.map((tx) => tx.ops));
    if (res.tombstones.length) {
      // seq удаления: applyBatches отдаёт надгробия всей страницы подряд — корень каждого
      // удаления (id операции remove) указывает на транзакцию, потомки идут за корнем
      const roots = page.map((tx) => {
        let set = null;
        for (const op of tx.ops || []) if (op && op.op === 'remove' && typeof op.id === 'string') (set || (set = new Set())).add(op.id);
        return set;
      });
      let k = 0;
      for (const [id, parent] of res.tombstones) {
        for (let j = k; j < page.length; j++) {
          if (roots[j] && roots[j].has(id)) {
            k = j;
            break;
          }
        }
        addTomb(head, id, parent, page[k].seq);
      }
    }
    for (let i = 0; i < page.length; i++) {
      const err = res.results[i] && res.results[i].error;
      // применённая форма обязана проходить строго; если нет — журнал и движок разошлись,
      // молчать нельзя, но и вставать нельзя: голова идёт дальше по номерам
      if (err) log.warn(`[document/dslts] ${projectId}: seq ${page[i].seq} не применяется: ${err.message}`);
    }
    if (res.doc !== before) {
      head.docBytes += docBytesDelta(before, res.doc);
      head.doc = res.doc;
    }
    for (const committed of page) {
      head.head_seq = committed.seq;
      if (typeof committed.chain === 'string') head.chain = committed.chain;
      remember(head, committed);
    }
    pruneTombs(head);
  }

  function dropHead(projectId) {
    const head = heads.get(projectId);
    if (head && head.timer) clearTimeout(head.timer);
    heads.delete(projectId);
  }

  function touch(projectId, head) {
    head.lastUsed = Date.now();
    if (head.timer) clearTimeout(head.timer);
    if (idleMs > 0) {
      head.timer = setTimeout(() => {
        withLock(projectId, () => {
          const cur = heads.get(projectId);
          if (cur !== head) return;
          // открытый сокетом проект держим: его сверяет таймер и будят уведомления
          if (watched(projectId)) { touch(projectId, head); return; }
          if (Date.now() - head.lastUsed >= idleMs) heads.delete(projectId);
        }).catch(() => {});
      }, idleMs);
      if (head.timer.unref) head.timer.unref();
    }
  }

  /** Проекта в базе больше нет (I3): голова выгружается, Hub закрывает сокеты проекта (4404). */
  function lost(projectId) {
    dropHead(projectId);
    emit({ kind: 'missing', projectId });
  }

  /**
   * Снимок, с которого поднимается голова, и его надгробия (I1). Надгробия `null` —
   * снимок записал экземпляр прежней версии, они неизвестны: голова поднимается с
   * ближайшего более раннего снимка с известными надгробиями (STORE `snapshotBefore`;
   * снимок seq 0 — затравка, до него удалять было нечего) и переигрывает журнал от
   * него — remove в этом журнале и дают надгробия. Нет `snapshotBefore` (хранилище
   * прежней версии) — пустые, как до круга 25, и предупреждение.
   */
  async function startingPoint(projectId, snap) {
    const t = readTombstones(snap.tombstones, snap.seq);
    if (t) return { snap, tomb: t, restored: false };
    if (snap.seq === 0) return { snap, tomb: { parents: new Map(), seq: new Map() }, restored: false };
    let cur = snap;
    for (let guard = 0; guard < 1000; guard++) {
      if (typeof storage.snapshotBefore !== 'function') break;
      const prev = await viaStorage(storage.snapshotBefore(projectId, cur.seq));
      if (!prev || !(prev.seq < cur.seq)) break;
      const pt = readTombstones(prev.tombstones, prev.seq);
      if (pt) return { snap: prev, tomb: pt, restored: true };
      if (prev.seq === 0) return { snap: prev, tomb: { parents: new Map(), seq: new Map() }, restored: true };
      cur = prev;   // хранилище отдало снимок без надгробий — ищем ещё раньше
    }
    log.warn(`[document/dslts] ${projectId}: у снимка seq ${snap.seq} надгробия неизвестны, а более раннего снимка хранилище не даёт — голова без надгробий до него`);
    return { snap, tomb: { parents: new Map(), seq: new Map() }, restored: false };
  }

  /** Голова проекта: ленивая загрузка снимка и хвоста. Звать под мьютексом. */
  async function ensureHead(projectId) {
    let head = heads.get(projectId);
    if (!head) {
      const project = await viaStorage(storage.getProject(projectId));
      if (!project) {
        // сокеты проекта могли остаться от прежней головы (база восстановлена без проекта)
        emit({ kind: 'missing', projectId });
        throw notFound();
      }
      const latest = await viaStorage(storage.latestSnapshot(projectId));
      if (!latest) throw unavailable('у проекта нет снимка — журнал не с чего переигрывать');
      const { snap, tomb, restored } = await startingPoint(projectId, latest);
      if (snap.engine !== ENGINE_VERSION) {
        // миграция формата — системная транзакция (§8.3), а не тихая правка; пока её нет — предупреждаем
        log.warn(`[document/dslts] ${projectId}: снимок seq ${snap.seq} записан движком ${snap.engine}, сервер работает с ${ENGINE_VERSION}`);
      }
      head = {
        doc: snap.doc, head_seq: snap.seq, chain: snap.chain || '', epoch: project.epoch,
        // надгробия до снимка — из самого снимка (§9.10): без них та же офлайн-транзакция
        // давала бы в свежей голове `orphan`, а в долгоживущей — `reparented`
        tombstones: tomb.parents, tombSeq: tomb.seq,
        recent: [], recentBytes: 0, byTx: new Map(), lastUsed: 0, timer: null,
        docBytes: jsonBytes(snap.doc), epochSeq: undefined
      };
      pruneTombs(head);
      // страница ограничена и числом, и байтами: конец — только пустая страница
      for (;;) {
        const page = await viaStorage(storage.txsAfter(projectId, head.head_seq, PAGE_TXS, { maxBytes: INTERNAL_PAGE_BYTES }));
        if (!page.length) break;
        absorbPage(head, projectId, page);
      }
      heads.set(projectId, head);
      if (restored) {
        log.warn(`[document/dslts] ${projectId}: надгробия снимка seq ${latest.seq} неизвестны (прежний экземпляр) — восстановлены журналом от снимка seq ${snap.seq}`);
        // свежий снимок с надгробиями: следующей загрузке переигрывать не придётся
        if (head.head_seq > 0) scheduleSnapshot(projectId, head.head_seq, head.doc, head.chain, head.tombstones, head.tombSeq);
      }
    }
    touch(projectId, head);
    return head;
  }

  /**
   * База откатилась под головой (SPEC §9.8): сменить эпоху, если её ещё никто не
   * сменил (compare-and-set), выбросить голову, сказать Hub. Звать под мьютексом.
   */
  async function rollback(projectId, head, project, why) {
    let epoch = project.epoch;
    if (project.epoch === head.epoch) {
      const r = await viaStorage(storage.bumpEpoch(projectId, head.epoch, 'instance', instanceId));
      if (r.status === 'missing') {
        lost(projectId);
        throw notFound();
      }
      epoch = r.epoch;
      if (r.status === 'bumped') log.warn(`[document/dslts] ${projectId}: база откатилась (${why}; в памяти seq ${head.head_seq}, в базе ${project.head_seq}) — новая эпоха ${epoch}`);
    }
    dropHead(projectId);
    emit({ kind: 'epoch', projectId, epoch });
    return epoch;
  }

  /**
   * Сверить голову с базой и догнать её (SPEC §9.8). Звать под мьютексом.
   * @returns {Promise<'none'|'ok'|'caught-up'|'epoch'|'rollback'>}
   */
  async function syncHead(projectId) {
    const head = heads.get(projectId);
    if (!head) return 'none';
    const p = await viaStorage(storage.getProject(projectId));
    if (!p) {
      lost(projectId);
      return 'none';
    }
    if (p.epoch !== head.epoch) {
      // эпоху сменил кто-то ещё (или база вернулась к эпохе, которой голова не знает)
      dropHead(projectId);
      emit({ kind: 'epoch', projectId, epoch: p.epoch });
      return 'epoch';
    }
    if (p.head_seq < head.head_seq) {
      await rollback(projectId, head, p, 'голова базы позади');
      return 'rollback';
    }
    if (p.head_seq === head.head_seq) {
      if (p.head_chain !== head.chain) {
        await rollback(projectId, head, p, 'цепочка на голове другая');
        return 'rollback';
      }
      return 'ok';
    }
    for (;;) {
      const page = await viaStorage(storage.txsAfter(projectId, head.head_seq, PAGE_TXS, { maxBytes: INTERNAL_PAGE_BYTES }));
      if (!page.length) break;
      // цепочка проверяется до применения: целый префикс страницы ложится одной
      // пачкой и уходит сокетам, на разрыве — откат (как прежде, поштучно)
      let seq = head.head_seq;
      let chain = head.chain;
      let ok = 0;
      for (; ok < page.length; ok++) {
        const tx = page[ok];
        if (tx.seq !== seq + 1 || (typeof tx.chain === 'string' && tx.chain !== chainNext(chain, tx.tx_id, tx.seq))) break;
        seq = tx.seq;
        if (typeof tx.chain === 'string') chain = tx.chain;
      }
      const good = ok === page.length ? page : page.slice(0, ok);
      absorbPage(head, projectId, good);
      for (const tx of good) emit({ kind: 'tx', projectId, committed: tx });
      if (ok < page.length) {
        await rollback(projectId, head, p, `цепочка рвётся на seq ${page[ok].seq}`);
        return 'rollback';
      }
    }
    return 'caught-up';
  }

  /** Сверка по уведомлению: одна в очереди на проект, остальные сливаются в неё. */
  function scheduleSync(projectId) {
    if (closed || syncQueued.has(projectId)) return;
    syncQueued.add(projectId);
    track(withLock(projectId, async () => {
      syncQueued.delete(projectId);
      if (closed) return;
      const r = await syncHead(projectId);
      // проект открыт сокетами — голова нужна им для живого потока: загрузить заново
      if ((r === 'epoch' || r === 'rollback') && watched(projectId)) await ensureHead(projectId);
    }).catch((e) => log.warn(`[document/dslts] ${projectId}: сверка с базой не удалась: ${e && e.message}`)));
  }

  function onEpochNotice(projectId, epoch) {
    track(withLock(projectId, async () => {
      const head = heads.get(projectId);
      if (head && head.epoch === epoch) return;
      dropHead(projectId);
      emit({ kind: 'epoch', projectId, epoch });
      if (watched(projectId) && !closed) await ensureHead(projectId);
    }).catch(() => {}));
  }

  /** Сверить все головы (таймер; переподключение слушателя — уведомления за разрыв потеряны). */
  function verifyAll() {
    for (const projectId of heads.keys()) scheduleSync(projectId);
  }

  const unlisten = typeof storage.onNotify === 'function' ? storage.onNotify((msg) => {
    if (!msg || closed) return;
    if (msg.k === 'resync') { verifyAll(); return; }
    if (typeof msg.p !== 'string' || msg.i === instanceId) return;
    if (msg.k === 'tx') {
      if (heads.has(msg.p)) scheduleSync(msg.p);
    } else if (msg.k === 'epoch') {
      onEpochNotice(msg.p, msg.e);
    } else if (msg.k === 'project') {
      // I4: проект переименовали на другом экземпляре — сокетам здесь
      const project = projectOfBus(msg);
      if (project) emit({ kind: 'project', projectId: msg.p, project });
    }
  }) : () => {};

  const verifier = verifyMs > 0 ? setInterval(verifyAll, verifyMs) : null;
  if (verifier && verifier.unref) verifier.unref();

  function scheduleSnapshot(projectId, seq, doc, chain, tombstones, tombSeq) {
    // надгробия — копией сейчас (v2, с номерами удаления): к моменту записи голова уйдёт дальше
    const tomb = tombstonesV2(tombstones, tombSeq);
    // после ответа: setImmediate отпускает текущий тик, запись идёт следующим
    track(new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        const written = await storage.writeSnapshot(projectId, seq, doc, ENGINE_VERSION, chain, tomb);
        if (written && snapshotKeep > 0) await storage.pruneSnapshots(projectId, snapshotKeep);
      })
      .catch((e) => log.warn(`[document/dslts] ${projectId}: снимок seq ${seq} не записан: ${e && e.message}`)));
  }

  /**
   * Seq начала нынешней эпохи (`project_epochs`): с него журнал этой эпохи расходится
   * с журналом, в котором правку писали впервые. Помнится в голове (голова живёт в
   * одной эпохе). Эпохи нет в учёте (проект создал экземпляр до круга 23) — null.
   */
  async function epochStartSeq(projectId, head) {
    if (head.epochSeq !== undefined) return head.epochSeq;
    let seq = null;
    if (typeof storage.epochs === 'function') {
      const list = await viaStorage(storage.epochs(projectId));
      for (const e of list || []) if (e && e.epoch === head.epoch && Number.isInteger(e.seq)) seq = e.seq;
    }
    head.epochSeq = seq;
    return seq;
  }

  /**
   * Какие `set`/`setToken` переигрываемой транзакции устарели (SPEC §9.10): тот же
   * лист (или путь, пересекающийся с ним) после исходной записи правки (`replay_at`)
   * переписала чужая транзакция. Окно поиска (I5, круг 27): переигрывание из другой
   * эпохи — от seq начала нынешней эпохи (её `base_seq` — номер в журнале, которого
   * больше нет: от него чужие правки сразу после отката не видны); из той же — от
   * `base_seq`. Своё (тот же `client`) не в счёт: свои переигранные правки идут по
   * порядку. Правка старше REPLAY_MAX_AGE_MS или окно длиннее replayScanTxs — устарели
   * все её листья.
   * @returns {Promise<Set<number>>}
   */
  async function staleOps(projectId, head, tx) {
    const leaves = [];
    tx.ops.forEach((op, i) => {
      const l = leafOf(op);
      if (l) leaves.push({ i, ...l });
    });
    const out = new Set();
    if (!leaves.length) return out;
    const all = () => { for (const x of leaves) out.add(x.i); return out; };
    const at = tx.replay_at ? Date.parse(tx.replay_at) : NaN;
    if (Number.isFinite(at) && Date.now() - at > REPLAY_MAX_AGE_MS) return all();
    let from = Math.min(tx.base_seq, head.head_seq);
    if (tx.replay_of_epoch !== head.epoch) {
      const start = await epochStartSeq(projectId, head);
      if (start !== null) from = Math.min(from, start);
    }
    if (head.head_seq - from > replayScanTxs) return all();
    const consider = (c) => {
      if (c.seq <= from || c.tx_id === tx.tx_id) return;
      if (tx.client && c.client === tx.client) return;
      if (Number.isFinite(at)) {
        // переигранная раньше чужая правка считается по своему исходному времени
        const t = Date.parse(c.replay_at || c.created_at);
        if (Number.isFinite(t) && t <= at) return;
      }
      for (const l of leavesOf(c)) {
        for (const x of leaves) if (!out.has(x.i) && x.scope === l.scope && pathsMeet(x.path, l.path)) out.add(x.i);
      }
    };
    if (head.recent.length && head.recent[0].seq <= from + 1) {
      for (const c of head.recent) consider(c);
      return out;
    }
    let seq = from;
    while (seq < head.head_seq) {
      const page = await viaStorage(storage.txsAfter(projectId, seq, PAGE_TXS, { maxBytes: INTERNAL_PAGE_BYTES }));
      const was = seq;
      for (const c of page) {
        if (c.seq > head.head_seq) break;
        // время переигранной раньше чужой правки знает только память головы
        const sum = head.byTx.get(c.tx_id);
        consider(sum && sum.seq === c.seq ? sum : c);
        seq = c.seq;
      }
      if (seq === was || out.size === leaves.length) break;
    }
    return out;
  }

  /** Запись транзакции под мьютексом проекта (SPEC §9.4); очередь уже учтена в commit. */
  async function commitQueued(projectId, raw, ctx) {
    let tx;
    try {
      tx = validateTx(raw, ctx);
    } catch (e) {
      // мусор в несуществующий проект — это 404, а не 400: проект проверяем только
      // на пути отказа, чтобы не платить запросом к базе за каждую годную транзакцию
      if (!(await viaStorage(storage.getProject(projectId)))) throw notFound();
      throw e;
    }
    return withLock(projectId, async () => {
      // очередь мьютекса могла дождаться остановки: голову после close() не загружаем
      if (closed) throw unavailable('сервис останавливается');
      let head = await ensureHead(projectId);
      if (tx.base_seq > head.head_seq) {
        // клиент видел голову дальше нашей: возможно, писал другой экземпляр — сначала сверка
        const r = await syncHead(projectId);
        if (r === 'none') throw notFound();
        if (r === 'epoch' || r === 'rollback') head = await ensureHead(projectId);
        if (tx.base_seq > head.head_seq) {
          // база позади клиента (откат или пересоздание): зажим, а не отказ — слияние не отказывает
          tx = { ...tx, base_seq: head.head_seq };
        }
      }
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        head = await ensureHead(projectId);
        // tx_id известен → сохранённое (идемпотентность, §8.3): память головы знает
        // последние выжимкой, запись целиком — из базы; всё старше ловит
        // UNIQUE(project_id, tx_id) в commitTx (но уже после слияния — дороже)
        const again = await knownTx(projectId, head, tx.tx_id);
        if (again) return { committed: again, existing: true };
        // переигрывание после отката базы (§9.10): лист, который после правки переписал
        // кто-то другой, остаётся за более новым — `set` отбрасывается с `reason:'stale'`
        const stale = tx.replay_of_epoch ? await staleOps(projectId, head, tx) : null;
        const merged = mergeIntoHead(head, tx, stale && stale.size ? { ...lim, stale } : lim);
        const record = { ...tx, ops: merged.ops, dropped: compactDropped(merged.dropped), notes: merged.notes };
        const expectSeq = head.head_seq + 1;
        const expectChain = chainNext(head.chain, tx.tx_id, expectSeq);
        const res = await viaStorage(storage.commitTx(projectId, record, { expectSeq, expectChain, origin: instanceId }));
        if (res.status === 'missing') {
          lost(projectId);
          throw notFound();
        }
        if (res.status === 'existing') {
          // записал другой экземпляр (или гонка мимо памяти): голова могла отстать
          if (res.committed.seq > head.head_seq) await syncHead(projectId);
          return { committed: res.committed, existing: true };
        }
        if (res.status === 'stale') {
          staleRetries += 1;
          if (res.reason === 'chain' || res.head_seq < head.head_seq) {
            // номер тот же, а журнал под ним другой, или база позади: откат базы
            await rollback(projectId, head, { epoch: res.epoch, head_seq: res.head_seq }, res.reason === 'chain' ? 'цепочка на записи другая' : 'номер записи позади головы');
          } else {
            // номер ушёл вперёд — писал другой экземпляр: перечитать хвост, слить заново
            await syncHead(projectId);
          }
          if (attempt >= 2) await new Promise((r) => setTimeout(r, Math.random() * RETRY_BACKOFF_MS * attempt));
          continue;
        }
        // надгробия пополняются ДО обновления документа — считались по прежней голове
        const seq = res.committed.seq;
        for (const [id, parent] of merged.tombstones) addTomb(head, id, parent, seq);
        head.doc = merged.doc;
        head.docBytes = merged.docBytes;
        head.head_seq = seq;
        head.chain = res.committed.chain;
        remember(head, res.committed, tx.replay_at);
        pruneTombs(head);
        // бездействие считается от конца записи, а не от её начала: долгая запись
        // (медленная база, длинная очередь) не должна выгружать голову сразу после себя
        touch(projectId, head);
        emit({ kind: 'tx', projectId, committed: res.committed });
        if (snapshotEvery > 0 && seq % snapshotEvery === 0) scheduleSnapshot(projectId, seq, head.doc, head.chain, head.tombstones, head.tombSeq);
        return { committed: res.committed, existing: false };
      }
      exhausted += 1;
      throw unavailable('голову проекта двигает другой экземпляр — повторите позже');
    });
  }

  const info = (head) => ({ head_seq: head.head_seq, chain: head.chain, epoch: head.epoch });

  return {
    /**
     * Подписка на события: `{kind:'tx', projectId, committed}` в порядке seq · `{kind:'epoch', projectId, epoch, token?}` ·
     * `{kind:'missing', projectId}` — проекта нет в базе (I3) · `{kind:'project', projectId, project}` — сводка изменилась (I4).
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Hub сообщает, какие проекты у него открыты (их головы не выгружаются по бездействию). */
    setWatcher(fn) {
      watched = typeof fn === 'function' ? fn : () => false;
    },

    /**
     * Голова проекта загружена и сверена с базой — для сокета, который
     * подключается: {head_seq, chain, epoch}. Тут же ловится откат базы, если
     * экземпляр ещё не знал о нём.
     */
    async attach(projectId) {
      return withLock(projectId, async () => {
        let head = await ensureHead(projectId);
        const r = await syncHead(projectId);
        // проекта не стало между загрузкой головы и сверкой (I3): сокету — 404, а не hello
        if (r === 'none') throw notFound();
        if (r === 'epoch' || r === 'rollback') head = await ensureHead(projectId);
        return info(head);
      });
    },

    /**
     * Клиент прислал след отката (SPEC §9.8): tip не совпал с журналом при
     * нынешней эпохе или эпоху, которой база не знает. Эпоха меняется не чаще
     * раза на эпоху: эпоху, начатую по слову клиента, клиент же сменить не может —
     * один неисправный клиент иначе закрывал бы всем сокеты по кругу.
     * @param {string} projectId
     * @param {{token?: any}} [opts] метка, по которой Hub узнает «своё» событие
     * @returns {Promise<{bumped: boolean, head_seq: number, chain: string, epoch: string}>}
     */
    async clientEvidence(projectId, opts = {}) {
      return withLock(projectId, async () => {
        const p = await viaStorage(storage.getProject(projectId));
        if (!p) throw notFound();
        let bumped = false;
        if (p.epoch_cause !== 'client') {
          const r = await viaStorage(storage.bumpEpoch(projectId, p.epoch, 'client', instanceId));
          if (r.status === 'bumped') {
            bumped = true;
            log.warn(`[document/dslts] ${projectId}: клиент прислал журнал, которого нет в базе — новая эпоха ${r.epoch}`);
            dropHead(projectId);
            emit({ kind: 'epoch', projectId, epoch: r.epoch, token: opts.token });
          }
        }
        const head = await ensureHead(projectId);
        if ((await syncHead(projectId)) === 'none') throw notFound();
        return { bumped, ...info(heads.get(projectId) || head) };
      });
    },

    /**
     * Зафиксировать транзакцию (SPEC §9.4).
     * @param {string} projectId
     * @param {any} raw транзакция как пришла
     * @param {{author?: string}} [ctx]
     * @returns {Promise<{committed: object, existing: boolean}>}
     */
    async commit(projectId, raw, ctx = {}) {
      if (closed) throw unavailable('сервис останавливается');
      // очередь мьютекса ограничена (§9.10): байтами тел — на проект и на экземпляр, и числом
      // на проект. Пустая очередь принимает всегда (одна транзакция в 4 МБ проходит)
      const bytes = Number.isFinite(ctx.bytes) && ctx.bytes > 0 ? ctx.bytes : jsonBytes(raw);
      const q = queued.get(projectId) || { bytes: 0, txs: 0 };
      const overProject = q.txs > 0 && (q.bytes + bytes > queueProjectBytes || q.txs + 1 > queueProjectTxs);
      const overTotal = queuedBytes > 0 && queuedBytes + bytes > queueTotalBytes;
      if (overProject || overTotal) {
        busyRefusals += 1;
        const txId = raw && typeof raw.tx_id === 'string' && raw.tx_id.length <= MAX_ID && isCleanText(raw.tx_id) ? { tx_id: raw.tx_id } : {};
        throw new DocError(503, 'busy', 'очередь записи переполнена — повторите чуть позже', {
          retryable: true, retryAfter: BUSY_RETRY_S, compat: txId,
          detail: { limit: overProject ? 'queue_project' : 'queue_total' }
        });
      }
      q.bytes += bytes;
      q.txs += 1;
      queued.set(projectId, q);
      queuedBytes += bytes;
      try {
        return await commitQueued(projectId, raw, ctx);
      } finally {
        q.bytes -= bytes;
        q.txs -= 1;
        queuedBytes -= bytes;
        if (q.txs <= 0 && queued.get(projectId) === q) queued.delete(projectId);
      }
    },

    /** Очередь записи сейчас: байты и число на проект, байты всего, сколько раз отказано (тестам). */
    queueStats(projectId) {
      const q = projectId !== undefined ? queued.get(projectId) : null;
      return { bytes: q ? q.bytes : 0, txs: q ? q.txs : 0, totalBytes: queuedBytes, refused: busyRefusals };
    },

    /**
     * Голова проекта (документ и номер) — тестам и отладке; загружает, если не
     * загружена, и сверяет с базой.
     */
    async headOf(projectId) {
      return withLock(projectId, async () => {
        await ensureHead(projectId);
        await syncHead(projectId);
        const head = await ensureHead(projectId);
        return {
          doc: head.doc, head_seq: head.head_seq, chain: head.chain, epoch: head.epoch,
          tombstones: new Map(head.tombstones), tombSeq: new Map(head.tombSeq),
          recent: head.recent.slice(), recentBytes: head.recentBytes
        };
      });
    },

    /**
     * Проект изменился вне журнала (I4: PATCH имени) — сокетам проекта здесь и на
     * других экземплярах (эфемерная шина хранилища, канал присутствия): `{kind:'project'}`.
     * @param {{id: string, name: string, kind: string, head_seq: number, updated_at: string}} project
     */
    projectChanged(project) {
      if (!project || typeof project.id !== 'string') return;
      const summary = { id: project.id, name: project.name, kind: project.kind, head_seq: project.head_seq, updated_at: project.updated_at };
      emit({ kind: 'project', projectId: project.id, project: summary });
      if (typeof storage.publish === 'function') {
        try {
          storage.publish({ k: 'project', p: project.id, i: instanceId, n: summary.name, d: summary.kind, s: summary.head_seq, u: summary.updated_at });
        } catch (e) {
          log.warn('[document/dslts] шина: имя проекта не разослано:', e && e.message);
        }
      }
    },

    /** Гонки с другими экземплярами: сколько кругов заново, сколько раз попытки кончились (503). */
    stats() {
      return { staleRetries, exhausted, heads: heads.size };
    },

    /** Загружена ли голова (после выгрузки по бездействию — нет). */
    isLoaded(projectId) {
      return heads.has(projectId);
    },

    /** Выгрузить голову сейчас (тесты выгрузки по бездействию не ждут 10 минут). */
    async unload(projectId) {
      return withLock(projectId, () => dropHead(projectId));
    },

    /** Сверить все головы с базой сейчас и дождаться (тестам; в работе — таймер и уведомления). */
    async verify() {
      verifyAll();
      await Promise.all([...inflight]);
    },

    /** Дождаться снимков и сверок в полёте. */
    async flush() {
      while (inflight.size) await Promise.all([...inflight]);
    },

    /** Остановка: новые транзакции — 503, снимки дописываются, таймеры сняты. */
    async close() {
      closed = true;
      unlisten();
      if (verifier) clearInterval(verifier);
      for (const head of heads.values()) if (head.timer) clearTimeout(head.timer);
      await Promise.all([...locks.values()]);
      await Promise.all([...inflight]);
      heads.clear();
    }
  };
}
