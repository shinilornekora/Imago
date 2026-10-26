/**
 * Круг 45 — Document service (долги критиков круга 44):
 *   Д9 UX) список проектов отдаёт `created_at` — оболочка по нему помечает пустую сироту спасения;
 *   §9.19) `DELETE /api/projects/:id` с телом {create_id} удаляет только ПУСТОЙ проект своего создания:
 *          чужой create_id, проект с правками, библиотека, нет тела — отказ, проект на месте.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uid, createDoc } from '../../src/core.js';
import { CODE_ENGINE } from '../../server/document/engine.js';
import { backends, startFor, api } from './helpers.mjs';

const tx = (base_seq, list) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: CODE_ENGINE });
const cidOf = () => 'rescue_' + uid('c').replace(/[^A-Za-z0-9_-]/g, '');
const del = (h, id, body) => h.raw('DELETE', `/api/projects/${id}`, body);
const list = await backends();

describe('круг 45: сирота спасения — created_at в списке и удаление пустого проекта своего create_id', () => {
  for (const b of list) {
    it(`GET /api/projects — created_at у каждой строки; у пустого проекта он равен updated_at · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const made = await h.post('/api/projects', { name: 'спасение', doc: createDoc(), create_id: cidOf() });
        assert.equal(made.status, 201, made.text);
        const r = await h.get('/api/projects');
        assert.equal(r.status, 200);
        const row = r.body.projects.find((p) => p.id === made.body.id);
        assert.ok(row, 'проект в списке');
        assert.ok(Number.isFinite(Date.parse(row.created_at)), 'created_at — время: ' + row.created_at);
        assert.equal(Date.parse(row.created_at), Date.parse(made.body.created_at));
        assert.equal(Date.parse(row.created_at), Date.parse(row.updated_at), 'без правок — совпадают');
      } finally {
        await svc.close();
      }
    });

    it(`DELETE — пустой проект своего create_id удаляется (204, затем 404); остальное — отказ, проект на месте · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const cid = cidOf();
        const empty = (await h.post('/api/projects', { name: 'сирота', doc: createDoc(), create_id: cid })).body.id;
        // без тела и без create_id — 400
        assert.equal((await del(h, empty)).status, 400);
        assert.equal((await del(h, empty, {})).status, 400);
        // чужой create_id — 409 create_id
        const other = await del(h, empty, { create_id: cidOf() });
        assert.equal(other.status, 409, other.text);
        assert.equal(other.body.detail.cause, 'create_id');
        assert.equal((await h.get(`/api/projects/${empty}`)).status, 200, 'проект на месте');
        // свой — 204, проекта больше нет ни в чтении, ни в списке
        const ok = await del(h, empty, { create_id: cid });
        assert.equal(ok.status, 204, ok.text);
        assert.equal((await h.get(`/api/projects/${empty}`)).status, 404);
        assert.ok(!(await h.get('/api/projects')).body.projects.some((p) => p.id === empty));
        assert.equal((await del(h, empty, { create_id: cid })).status, 404, 'второй раз — нет такого');
        // повтор создания тем же create_id — новый проект (старый удалён)
        const again = await h.post('/api/projects', { name: 'сирота', doc: createDoc(), create_id: cid });
        assert.equal(again.status, 201, again.text);
        assert.notEqual(again.body.id, empty);

        // проект с правкой — 409 not_empty, правка на месте
        const cid2 = cidOf();
        const used = (await h.post('/api/projects', { name: 'с правкой', doc: createDoc(), create_id: cid2 })).body.id;
        const root = (await h.get(`/api/projects/${used}`)).body.snapshot.doc.root;
        assert.equal((await h.post(`/api/projects/${used}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'z' }]))).status, 201);
        const busy = await del(h, used, { create_id: cid2 });
        assert.equal(busy.status, 409, busy.text);
        assert.equal(busy.body.detail.cause, 'not_empty');
        assert.equal((await h.get(`/api/projects/${used}`)).body.head_seq, 1);

        // проект без create_id и библиотека этим путём не удаляются
        const plain = (await h.post('/api/projects', { name: 'обычный' })).body.id;
        assert.equal((await del(h, plain, { create_id: cidOf() })).status, 409);
        const cid3 = cidOf();
        const lib = (await h.post('/api/projects', { name: 'библиотека', kind: 'library', create_id: cid3 })).body.id;
        assert.equal((await del(h, lib, { create_id: cid3 })).status, 409);
        assert.equal((await h.get(`/api/projects/${lib}`)).status, 200);
        // не-uuid — 404, а не ошибка базы
        assert.equal((await del(h, 'нет-такого', { create_id: cid3 })).status, 404);
        // OPTIONS называет DELETE
        assert.match((await h.options('/api/projects')).headers.get('allow') || '', /DELETE/);
      } finally {
        await svc.close();
      }
    });

    it(`DELETE и запись одновременно — либо удалён и записи нет, либо записан и проект на месте · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        for (let i = 0; i < 6; i++) {
          const cid = cidOf();
          const made = (await h.post('/api/projects', { name: 'гонка ' + i, doc: createDoc(), create_id: cid })).body;
          const root = (await h.get(`/api/projects/${made.id}`)).body.snapshot.doc.root;
          const [w, d] = await Promise.all([
            h.post(`/api/projects/${made.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'w' }])),
            del(h, made.id, { create_id: cid })
          ]);
          const after = await h.get(`/api/projects/${made.id}`);
          if (d.status === 204) {
            assert.equal(after.status, 404);
            assert.notEqual(w.status, 201, 'запись не могла лечь в удалённый проект');
          } else {
            assert.equal(d.status, 409, d.text);
            assert.equal(w.status, 201, w.text);
            assert.equal(after.body.head_seq, 1);
          }
        }
      } finally {
        await svc.close();
      }
    });
  }
});
