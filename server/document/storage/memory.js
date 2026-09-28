/**
 * Адаптер хранилища в памяти — тот же интерфейс, что у ./pg.js (см. шапку там).
 * Для юнит-тестов без базы и как заготовка соло-режима (SPEC §8.4: локальная
 * сборка — «один процесс с адаптером хранилища»). Данные живут, пока жив процесс.
 *
 * Всё, что уходит наружу, копируется (structuredClone): голова в памяти
 * секвенсора и записи журнала не должны делить объекты с «базой», иначе
 * мутация с одной стороны молча меняла бы другую — с Postgres такого не бывает,
 * и адаптер в памяти не должен вести себя мягче.
 */

import { randomUUID } from 'node:crypto';
import { toCommitted, txColumns } from './committed.js';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function createMemoryStorage() {
  /** @type {Map<string, object>} id → проект */
  const projects = new Map();
  /** @type {Map<string, {bySeq: object[], byTx: Map<string, object>}>} */
  const journals = new Map();
  /** @type {Map<string, object[]>} projectId → снимки по возрастанию seq */
  const snapshots = new Map();

  const journalOf = (id) => {
    let j = journals.get(id);
    if (!j) {
      j = { bySeq: [], byTx: new Map() };
      journals.set(id, j);
    }
    return j;
  };

  return {
    kind: 'memory',

    async init() {},
    async close() {},

    async createProject({ name = '', kind = 'design', doc, engine }) {
      const now = new Date().toISOString();
      const project = { id: randomUUID(), name, kind, head_seq: 0, engine, created_at: now, updated_at: now };
      projects.set(project.id, project);
      snapshots.set(project.id, [{ seq: 0, doc: clone(doc), engine, created_at: now }]);
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
      return clone(list[list.length - 1]);
    },

    async txsAfter(projectId, seq, limit = 500) {
      const j = journals.get(String(projectId));
      if (!j) return [];
      const out = [];
      for (const row of j.bySeq) {
        if (row.seq <= seq) continue;
        out.push(toCommitted(clone(row)));
        if (out.length >= limit) break;
      }
      return out;
    },

    /** Та же семантика, что у pg.commitTx: номер головы не уходит вперёд без записи. */
    async commitTx(projectId, tx, { expectSeq } = {}) {
      const p = projects.get(String(projectId));
      if (!p) return { status: 'missing' };
      const j = journalOf(p.id);
      const known = j.byTx.get(String(tx.tx_id));
      if (known) return { status: 'existing', committed: toCommitted(clone(known)) };
      const seq = p.head_seq + 1;
      if (expectSeq !== undefined && seq !== expectSeq) return { status: 'stale', head_seq: p.head_seq };
      const row = { project_id: p.id, seq, ...clone(txColumns(tx)), created_at: new Date().toISOString() };
      p.head_seq = seq;
      p.updated_at = row.created_at;
      j.bySeq.push(row);
      j.byTx.set(row.tx_id, row);
      return { status: 'committed', committed: toCommitted(clone(row)) };
    },

    async writeSnapshot(projectId, seq, doc, engine) {
      const list = snapshots.get(String(projectId));
      if (!list) return;
      if (list.some((s) => s.seq === seq)) return;   // ON CONFLICT DO NOTHING
      list.push({ seq, doc: clone(doc), engine, created_at: new Date().toISOString() });
      list.sort((a, b) => a.seq - b.seq);
    },

    async findTx(projectId, txId) {
      const j = journals.get(String(projectId));
      const row = j && j.byTx.get(String(txId));
      return row ? toCommitted(clone(row)) : null;
    }
  };
}
