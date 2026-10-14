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
 */

import { randomUUID } from 'node:crypto';
import { toCommitted, txColumns, chainNext, newEpoch, jsonBytes } from './committed.js';
import { PAGE_BYTES } from '../limits.js';

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

  return {
    kind: 'memory',

    async init() {},
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

    async createProject({ name = '', kind = 'design', doc, engine }) {
      const now = new Date().toISOString();
      const epoch = newEpoch();
      const project = { id: randomUUID(), name, kind, head_seq: 0, head_chain: '', epoch, epoch_cause: 'init', engine, created_at: now, updated_at: now };
      projects.set(project.id, project);
      snapshots.set(project.id, [{ seq: 0, doc: clone(doc), engine, chain: '', created_at: now }]);
      epochs.set(project.id, [{ epoch, seq: 0, cause: 'init', created_at: now }]);
      journalOf(project.id);
      return clone(project);
    },

    async listProjects() {
      return [...projects.values()]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
        .map(clone);
    },

    async getProject(id) {
      return clone(projects.get(String(id))) || null;
    },

    async renameProject(id, name) {
      const p = projects.get(String(id));
      if (!p) return null;
      p.name = name;
      p.updated_at = new Date().toISOString();
      return clone(p);
    },

    async latestSnapshot(projectId) {
      const list = snapshots.get(String(projectId));
      if (!list || !list.length) return null;
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (s.seq === 0) return clone(s);
        const row = rowAt(projectId, s.seq);
        if (row && row.chain === s.chain) return clone(s);
      }
      return null;
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
        const size = jsonBytes(row.ops) + jsonBytes(row.dropped);
        if (out.length && bytes + size > maxBytes) break;
        bytes += size;
        out.push(toCommitted(clone(row)));
        if (out.length >= limit) break;
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
      const seq = p.head_seq + 1;
      if (expectSeq !== undefined && seq !== expectSeq) return { status: 'stale', head_seq: p.head_seq, epoch: p.epoch };
      const chain = chainNext(p.head_chain, tx.tx_id, seq);
      if (expectChain !== undefined && chain !== expectChain) return { status: 'stale', reason: 'chain', head_seq: p.head_seq, epoch: p.epoch };
      const row = { project_id: p.id, seq, ...clone(txColumns(tx)), chain, created_at: new Date().toISOString() };
      p.head_seq = seq;
      p.head_chain = chain;
      p.updated_at = row.created_at;
      j.bySeq.push(row);
      j.byTx.set(row.tx_id, row);
      notify({ k: 'tx', p: p.id, s: seq, c: chain, e: p.epoch, i: origin || '' });
      return { status: 'committed', committed: toCommitted(clone(row)), epoch: p.epoch };
    },

    async writeSnapshot(projectId, seq, doc, engine, chain = '') {
      const list = snapshots.get(String(projectId));
      if (!list) return false;
      const row = rowAt(projectId, seq);
      if (!row || row.chain !== chain) return false;   // журнал на этом seq уже другой
      const at = list.findIndex((s) => s.seq === seq);
      if (at >= 0) {
        if (list[at].chain === chain) return false;    // ON CONFLICT DO NOTHING
        list.splice(at, 1);
      }
      list.push({ seq, doc: clone(doc), engine, chain, created_at: new Date().toISOString() });
      list.sort((a, b) => a.seq - b.seq);
      return true;
    },

    async pruneSnapshots(projectId, keep) {
      const list = snapshots.get(String(projectId));
      if (!list || !(keep > 0)) return 0;
      const rest = list.filter((s) => s.seq !== 0);
      const drop = rest.slice(0, Math.max(0, rest.length - keep));
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
      return clone({ projects, journals, snapshots, epochs, traces, traceId });
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
    }
  };
}
