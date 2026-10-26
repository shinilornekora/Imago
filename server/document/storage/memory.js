/**
 * Адаптер хранилища в памяти — тот же интерфейс, что у ./pg.js (см. шапку там).
 * Для юнит-тестов без базы и как заготовка соло-режима (SPEC §8.4: локальная
 * сборка — «один процесс с адаптером хранилища»). Данные живут, пока жив процесс.
 *
 * Всё, что уходит наружу, копируется (structuredClone): голова в памяти
 * секвенсора и записи журнала не должны делить объекты с «базой», иначе
 * мутация с одной стороны молча меняла бы другую — с Postgres такого не бывает,
 * и адаптер в памяти не должен вести себя мягче.
 *
 * Уведомления (`onNotify`) — как LISTEN/NOTIFY у pg: асинхронно, после записи,
 * всем подписчикам (в том числе экземплярам, делящим это хранилище); `publish` —
 * эфемерные сообщения присутствия тем же путём.
 * `backup()`/`restore(b)` — копия всего хранилища и возврат к ней: так тесты
 * моделируют откат базы из бэкапа под работающим сервисом.
 *
 * Надгробия снимка хранятся так же, как в колонках pg (migrations/007): `parents`,
 * `meta` (v2 без parents) и `metaChain` — и читаются тем же committed.joinTombstones;
 * `forgetTombstones(projectId, seq)` — снимок «как от экземпляра прежней версии»
 * (надгробия неизвестны) — тестам смешанных версий без базы.
 */

import { randomUUID } from 'node:crypto';
import { toCommitted, txColumns, chainNext, newEpoch, jsonBytes, splitTombstones, joinTombstones, pgRejects, droppedCount } from './committed.js';
import { PAGE_BYTES, undoPartOf } from '../limits.js';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function createMemoryStorage() {
  /** @type {Map<string, object>} id → проект */
  let projects = new Map();
  /** @type {Map<string, {bySeq: object[], byTx: Map<string, object>}>} */
  let journals = new Map();
  /** @type {Map<string, object[]>} projectId → снимки по возрастанию seq */
  let snapshots = new Map();
  /** @type {Map<string, object[]>} projectId → эпохи */
  let epochs = new Map();
  /** @type {Map<string, object[]>} projectId → трассы */
  let traces = new Map();
  let traceId = 0;
  /** @type {Map<string, string>} id проекта → отпечаток тела создания (круг 35) */
  const createHashes = new Map();
  /** @type {Map<string, string>} create_id → id проекта (круг 33, L1) */
  let byCreateId = new Map();
  const listeners = new Set();

  const journalOf = (id) => {
    let j = journals.get(id);
    if (!j) {
      j = { bySeq: [], byTx: new Map() };
      journals.set(id, j);
    }
    return j;
  };

  function notify(msg) {
    // как NOTIFY: доставка после записи и не в том же тике
    setImmediate(() => {
      for (const fn of listeners) {
        try {
          fn(clone(msg));
        } catch (_) { /* слушатель — не наша забота */ }
      }
    });
  }

  const rowAt = (id, seq) => {
    const j = journals.get(String(id));
    if (!j) return null;
    // журнал без дыр по номерам: индекс = seq - 1 (а если нет — ищем)
    const guess = j.bySeq[seq - 1];
    if (guess && guess.seq === seq) return guess;
    return j.bySeq.find((r) => r.seq === seq) || null;
  };

  /** Снимки проекта, годные по журналу (seq 0 или chain совпадает), старшие первыми. */
  const validSnapshots = (projectId) => {
    const list = snapshots.get(String(projectId)) || [];
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.seq === 0) out.push(s);
      else {
        const row = rowAt(projectId, s.seq);
        if (row && row.chain === s.chain) out.push(s);
      }
    }
    return out;
  };
  /** Снимок наружу — копией; надгробия — v2, v1 или null, как у pg. */
  const snapshotOut = (s, withDoc) => {
    const out = {
      seq: s.seq, engine: s.engine, chain: s.chain || '',
      tombstones: clone(joinTombstones({ seq: s.seq, chain: s.chain || '', parents: s.parents, meta: s.meta, metaChain: s.metaChain })),
      created_at: s.created_at
    };
    // снимок импорта хранится строкой JSON (круг 33): разбор — при чтении, а не в цикле записи
    if (withDoc) out.doc = typeof s.docJson === 'string' ? JSON.parse(s.docJson) : clone(s.doc);
    return out;
  };

  const self = {
    kind: 'memory',

    async init() {},
    /** Жива ли база (J1): у памяти — всегда. */
    async ping() { return true; },
    async close() {
      listeners.clear();
    },

    onNotify(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Эфемерное сообщение всем экземплярам (присутствие, SPEC §9.9) — как NOTIFY отдельного канала. */
    publish(msg) {
      if (!listeners.size) return false;
      notify(msg);
      return true;
    },

    /**
     * Как у pg: `docJson` — документ строкой (импорт, круг 33); `createId` — проект с таким
     * create_id уже есть → он же с `existing: true` (L1).
     */
    async createProject({ name = '', kind = 'design', doc, docJson, engine, createId, createHash }) {
      const cid = typeof createId === 'string' && createId ? createId : null;
      if (cid && byCreateId.has(cid) && projects.has(byCreateId.get(cid))) return { ...(await self.projectByCreateId(cid)), existing: true };
      // документ строкой (импорт, круг 33) уже вычищен подготовкой (cleanDeep): его не разбираем
      // и не обходим здесь — только строку имени и вида; разбор — при чтении снимка
      const bad = pgRejects({ json: typeof docJson === 'string' ? [] : [doc], text: [name, kind] });
      if (bad) throw bad;
      const now = new Date().toISOString();
      const epoch = newEpoch();
      const project = { id: randomUUID(), name, kind, head_seq: 0, head_chain: '', epoch, epoch_cause: 'init', engine, created_at: now, updated_at: now };
      projects.set(project.id, project);
      if (cid) {
        byCreateId.set(cid, project.id);
        // круг 35: отпечаток тела создания — как колонка create_hash в pg (013)
        if (typeof createHash === 'string' && createHash) createHashes.set(project.id, createHash);
      }
      snapshots.set(project.id, [{ seq: 0, ...(typeof docJson === 'string' ? { docJson } : { doc: clone(doc) }), engine, chain: '', parents: {}, meta: null, metaChain: null, created_at: now }]);
      epochs.set(project.id, [{ epoch, seq: 0, cause: 'init', created_at: now }]);
      journalOf(project.id);
      return clone(project);
    },

    /** Как у pg (круг 45): пустой проект своего create_id. */
    async deleteEmptyProject(id, createId) {
      const p = projects.get(String(id));
      if (!p) return { status: 'not_found' };
      if (typeof createId !== 'string' || !createId || byCreateId.get(createId) !== p.id) return { status: 'create_id' };
      const j = journals.get(p.id);
      if (p.kind !== 'design' || p.head_seq !== 0 || (j && j.bySeq.length)) return { status: 'not_empty' };
      projects.delete(p.id);
      byCreateId.delete(createId);
      createHashes.delete(p.id);
      for (const m of [journals, snapshots, epochs, traces]) m.delete(p.id);
      return { status: 'deleted' };
    },

    /** Проект по create_id (круг 33, L1) или null. */
    async projectByCreateId(createId) {
      const id = typeof createId === 'string' ? byCreateId.get(createId) : undefined;
      return id && projects.has(id) ? { ...clone(projects.get(id)), create_hash: createHashes.get(id) || null } : null;
    },

    async listProjects() {
      return [...projects.values()]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
        .map(clone);
    },

    /**
     * Страница списка (круг 26): новые по updated_at первыми, при равенстве — id по
     * убыванию; `after` — {at, id} последней строки прежней страницы (ключ, не смещение:
     * новые проекты между страницами не сдвигают её).
     * @param {{kind?: string, limit?: number, after?: {at: string, id: string}}} [o]
     * @returns {Promise<{projects: object[], more: boolean, next: {at: string, id: string}|null}>}
     */
    async listProjectsPage({ kind, limit = 200, after } = {}) {
      const key = (p) => [p.updated_at, p.id];
      const before = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);   // a раньше в списке, чем b
      const all = [...projects.values()]
        .filter((p) => !kind || p.kind === kind)
        .filter((p) => !after || before([after.at, after.id], key(p)))
        .sort((a, b) => (before(key(a), key(b)) ? -1 : before(key(b), key(a)) ? 1 : 0));
      const page = all.slice(0, limit);
      const last = page[page.length - 1];
      const more = all.length > limit;
      return { projects: page.map(clone), more, next: more && last ? { at: last.updated_at, id: last.id } : null };
    },

    async getProject(id) {
      return clone(projects.get(String(id))) || null;
    },

    async renameProject(id, name) {
      const p = projects.get(String(id));
      if (!p) return null;
      const bad = pgRejects({ text: [name] });
      if (bad) throw bad;
      p.name = name;
      p.updated_at = new Date().toISOString();
      return clone(p);
    },

    async latestSnapshot(projectId) {
      const s = validSnapshots(projectId)[0];
      return s ? snapshotOut(s, true) : null;
    },

    /** Тот же снимок без документа и надгробий (круг 27, I2). */
    async latestSnapshotMeta(projectId) {
      const s = validSnapshots(projectId)[0];
      if (!s) return null;
      return { seq: s.seq, chain: s.chain || '', engine: s.engine, epoch: projects.get(String(projectId)).epoch, created_at: s.created_at };
    },

    /** Ближайший снимок раньше `seq`, годный по журналу и с известными надгробиями (круг 27, I1). */
    async snapshotBefore(projectId, seq, { doc = true } = {}) {
      const s = validSnapshots(projectId).find((x) => x.seq < seq && (x.seq === 0 || x.metaChain === x.chain));
      return s ? snapshotOut(s, doc) : null;
    },

    /** Снимок «записан экземпляром прежней версии»: надгробия неизвестны (тестам). */
    forgetTombstones(projectId, seq) {
      const s = (snapshots.get(String(projectId)) || []).find((x) => x.seq === seq);
      if (!s) return false;
      s.metaChain = null;
      s.meta = null;
      return true;
    },

    async snapshotSeqs(projectId) {
      return (snapshots.get(String(projectId)) || []).map((s) => s.seq);
    },

    async txsAfter(projectId, seq, limit = 500, { maxBytes = PAGE_BYTES } = {}) {
      const j = journals.get(String(projectId));
      if (!j) return [];
      const out = [];
      let bytes = 0;
      for (const row of j.bySeq) {
        if (row.seq <= seq) continue;
        const size = typeof row.ops_bytes === 'number' ? row.ops_bytes : jsonBytes(row.ops) + jsonBytes(row.dropped);
        if (out.length && bytes + size > maxBytes) break;
        bytes += size;
        out.push(toCommitted(clone(row)));
        if (out.length >= limit) break;
      }
      return out;
    },

    /** Сводки последних транзакций для истории (J2) — как у pg: от новых к старым, seq < beforeSeq. */
    async recentTxMeta(projectId, { limit = 50, beforeSeq } = {}) {
      const j = journals.get(String(projectId));
      if (!j) return [];
      const lim = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 50));
      const before = beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(Number(beforeSeq)) ? Math.floor(Number(beforeSeq)) : Infinity;
      const out = [];
      for (let i = j.bySeq.length - 1; i >= 0 && out.length < lim; i--) {
        const r = j.bySeq[i];
        if (r.seq >= before) continue;
        out.push({
          seq: r.seq, tx_id: String(r.tx_id), author: r.author ?? null, author_kind: r.author_kind || 'human',
          title: r.title ?? null, created_at: r.created_at, client: r.client ?? null, command_id: r.command_id ?? null, command_author: r.command_author ?? null,
          // круг 32: отмена/повтор и часть большой правки — «История» сводит части точно
          undo_of: r.undo_of ?? null, redo_of: r.redo_of ?? null, undo_part: undoPartOf(r.undo_part),
          ops_count: typeof r.ops_count === 'number' ? r.ops_count : (Array.isArray(r.ops) ? r.ops.length : 0),
          dropped_count: droppedCount(r.dropped)
        });
      }
      return out;
    },

    async chainAt(projectId, seq) {
      const p = projects.get(String(projectId));
      if (!p) return null;
      if (seq === 0) return '';
      const row = rowAt(projectId, seq);
      return row ? row.chain : null;
    },

    /** Та же семантика, что у pg.commitTx: номер головы не уходит вперёд без записи. */
    async commitTx(projectId, tx, { expectSeq, expectChain, origin } = {}) {
      const p = projects.get(String(projectId));
      if (!p) return { status: 'missing' };
      const j = journalOf(p.id);
      const known = j.byTx.get(String(tx.tx_id));
      if (known) return { status: 'existing', committed: toCommitted(clone(known)) };
      const cols = txColumns(tx);
      // то, чего не примет Postgres (NUL, одинокий суррогат), — отказ и здесь (→ 400)
      const bad = pgRejects({ json: [cols.ops, cols.dropped, cols.notes], text: [cols.tx_id, cols.undo_of, cols.redo_of, cols.author, cols.client, cols.title, cols.command_id, cols.command_author] });
      if (bad) throw bad;
      const seq = p.head_seq + 1;
      if (expectSeq !== undefined && seq !== expectSeq) return { status: 'stale', head_seq: p.head_seq, epoch: p.epoch };
      const chain = chainNext(p.head_chain, tx.tx_id, seq);
      if (expectChain !== undefined && chain !== expectChain) return { status: 'stale', reason: 'chain', head_seq: p.head_seq, epoch: p.epoch };
      const row = { project_id: p.id, seq, ...clone(cols), chain, created_at: new Date().toISOString() };
      // вес и число операций — один раз при записи, как колонки pg (migrations/009)
      row.ops_bytes = jsonBytes(row.ops) + jsonBytes(row.dropped);
      row.ops_count = Array.isArray(row.ops) ? row.ops.length : 0;
      p.head_seq = seq;
      p.head_chain = chain;
      p.updated_at = row.created_at;
      j.bySeq.push(row);
      j.byTx.set(row.tx_id, row);
      notify({ k: 'tx', p: p.id, s: seq, c: chain, e: p.epoch, i: origin || '' });
      return { status: 'committed', committed: toCommitted(clone(row)), epoch: p.epoch };
    },

    /** Объектная форма writeSnapshot: `{seq, doc, engine, chain, tombstones}`. */
    async saveSnapshot(projectId, { seq, doc, engine, chain = '', tombstones } = {}) {
      return self.writeSnapshot(projectId, seq, doc, engine, chain, tombstones);
    },

    async writeSnapshot(projectId, seq, doc, engine, chain = '', tombstones = null) {
      const list = snapshots.get(String(projectId));
      if (!list) return false;
      const row = rowAt(projectId, seq);
      if (!row || row.chain !== chain) return false;   // журнал на этом seq уже другой
      const { parents, meta } = splitTombstones(tombstones);
      const metaChain = parents === null ? null : chain;
      const at = list.findIndex((s) => s.seq === seq);
      if (at >= 0) {
        // как ON CONFLICT … WHERE в pg: та же цепочка и надгробия не прибавились — DO NOTHING
        if (list[at].chain === chain && (metaChain === null || list[at].metaChain === metaChain)) return false;
        list.splice(at, 1);
      }
      list.push({ seq, doc: clone(doc), engine, chain, parents: clone(parents), meta: clone(meta), metaChain, created_at: new Date().toISOString() });
      list.sort((a, b) => a.seq - b.seq);
      return true;
    },

    async pruneSnapshots(projectId, keep) {
      const list = snapshots.get(String(projectId));
      if (!list || !(keep > 0)) return 0;
      const rest = list.filter((s) => s.seq !== 0);
      // старший снимок с известными надгробиями не удаляется (как в pg)
      const known = rest.filter((s) => s.metaChain === s.chain).pop();
      const drop = rest.slice(0, Math.max(0, rest.length - keep)).filter((s) => s !== known);
      if (!drop.length) return 0;
      const gone = new Set(drop.map((s) => s.seq));
      snapshots.set(String(projectId), list.filter((s) => !gone.has(s.seq)));
      return drop.length;
    },

    async findTx(projectId, txId) {
      const j = journals.get(String(projectId));
      const row = j && j.byTx.get(String(txId));
      return row ? toCommitted(clone(row)) : null;
    },

    async knownEpoch(projectId, epoch) {
      return (epochs.get(String(projectId)) || []).some((e) => e.epoch === epoch);
    },

    async bumpEpoch(projectId, fromEpoch, cause, origin) {
      const p = projects.get(String(projectId));
      if (!p) return { status: 'missing' };
      if (p.epoch !== fromEpoch) return { status: 'moved', epoch: p.epoch, cause: p.epoch_cause };
      p.epoch = newEpoch();
      p.epoch_cause = cause;
      epochs.get(p.id).push({ epoch: p.epoch, seq: p.head_seq, cause, created_at: new Date().toISOString() });
      notify({ k: 'epoch', p: p.id, e: p.epoch, i: origin || '' });
      return { status: 'bumped', epoch: p.epoch, cause };
    },

    async epochs(projectId) {
      return clone(epochs.get(String(projectId)) || []);
    },

    async addTrace({ projectId, commandId, body }) {
      if (!projects.has(String(projectId))) return null;
      const bad = pgRejects({ json: [body], text: [String(commandId)] });
      if (bad) throw bad;
      const row = { id: String(++traceId), command_id: String(commandId), created_at: new Date().toISOString(), body: clone(body) };
      if (!traces.has(projectId)) traces.set(projectId, []);
      traces.get(projectId).push(row);
      return { id: row.id, created_at: row.created_at };
    },

    async listTraces(projectId, limit) {
      const list = traces.get(String(projectId)) || [];
      return clone(list.slice(-limit).reverse());
    },

    /** Копия всего хранилища — «бэкап» (тестам отката базы). */
    backup() {
      return clone({ projects, journals, snapshots, epochs, traces, traceId, byCreateId });
    },

    /** Вернуть хранилище к бэкапу — «restore» под работающим сервисом. Уведомлений нет: restore их не шлёт. */
    restore(b) {
      const c = clone(b);
      projects = c.projects;
      journals = c.journals;
      snapshots = c.snapshots;
      epochs = c.epochs;
      traces = c.traces;
      traceId = c.traceId;
      byCreateId = c.byCreateId instanceof Map ? c.byCreateId : new Map();
    }
  };
  return self;
}
