/**
 * Список проектов (SPEC §9.2, круг 26): `GET /api/projects?kind=&limit=&after=` —
 * фильтр по виду (агент берёт только библиотеки) и страницы по ключу (updated_at, id):
 * `more`, `next` — курсор следующей страницы. Над памятью и над Postgres.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uid, ENGINE_VERSION } from '../../src/core.js';
import { backends, startFor, api } from './helpers.mjs';
import { PROJECTS_PAGE } from '../../server/document/limits.js';

const list = await backends();

for (const backend of list) {
  describe(`список проектов · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let svc;
    let h;
    const made = { design: [], library: [] };
    before(async () => {
      svc = await startFor(backend.name);
      h = api(svc.url);
      for (let i = 0; i < 7; i++) {
        const kind = i % 3 === 2 ? 'library' : 'design';
        const r = await h.post('/api/projects', { name: `${kind} ${i}`, kind });
        assert.equal(r.status, 201);
        made[kind].push(r.body.id);
      }
    });
    after(async () => { await svc.close(); });

    it('без параметров — все, новые первыми, more:false', async () => {
      const r = await h.get('/api/projects');
      assert.equal(r.status, 200);
      assert.equal(r.body.more, false);
      assert.equal(r.body.next, undefined);
      assert.equal(r.body.projects.length, 7);
      const at = r.body.projects.map((p) => p.updated_at);
      assert.deepEqual(at, [...at].sort().reverse(), 'по updated_at убыванию');
      assert.ok(PROJECTS_PAGE >= 50, 'умолчание страницы разумное');
    });

    it('kind=library — только библиотеки; kind=design — только макеты; иной вид — 400', async () => {
      const lib = await h.get('/api/projects?kind=library');
      assert.deepEqual(lib.body.projects.map((p) => p.id).sort(), [...made.library].sort());
      assert.ok(lib.body.projects.every((p) => p.kind === 'library'));
      const des = await h.get('/api/projects?kind=design');
      assert.deepEqual(des.body.projects.map((p) => p.id).sort(), [...made.design].sort());
      const bad = await h.get('/api/projects?kind=всё');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'bad_request');
    });

    it('страницы: limit=2 и after=next — все ровно по разу и по порядку; новый проект между страницами не сдвигает их', async () => {
      const full = (await h.get('/api/projects')).body.projects.map((p) => p.id);
      const seen = [];
      let next;
      let pages = 0;
      let inserted = null;
      for (;;) {
        const r = await h.get('/api/projects?limit=2' + (next ? '&after=' + encodeURIComponent(next) : ''));
        assert.equal(r.status, 200);
        assert.ok(r.body.projects.length <= 2);
        seen.push(...r.body.projects.map((p) => p.id));
        pages++;
        if (pages === 1) {
          // новый проект — в начало списка, на следующих страницах его нет
          inserted = (await h.post('/api/projects', { name: 'между страницами' })).body.id;
        }
        if (!r.body.more) { assert.equal(r.body.next, undefined); break; }
        assert.equal(typeof r.body.next, 'string');
        next = r.body.next;
      }
      assert.equal(pages, 4);
      assert.deepEqual(seen, full);
      assert.ok(!seen.includes(inserted));
      // с фильтром — тоже
      const a = await h.get('/api/projects?kind=design&limit=3');
      assert.equal(a.body.more, true);
      const b = await h.get('/api/projects?kind=design&limit=3&after=' + encodeURIComponent(a.body.next));
      const ids = [...a.body.projects, ...b.body.projects].map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id) => made.design.includes(id) || id === inserted));
    });

    it('негодные limit и after — 400', async () => {
      for (const q of ['limit=0', 'limit=abc', 'limit=100000', 'after=мусор', 'after=' + Buffer.from('[1,2]').toString('base64url'),
        'after=' + Buffer.from(JSON.stringify(['не время', uid('x')])).toString('base64url')]) {
        const r = await h.get('/api/projects?' + q);
        assert.equal(r.status, 400, q);
        assert.equal(r.body.retryable, false, q);
      }
      // курсор с id не того вида — пустая страница, не 500
      const odd = Buffer.from(JSON.stringify([new Date().toISOString(), 'не-uuid'])).toString('base64url');
      const r = await h.get('/api/projects?after=' + odd);
      assert.equal(r.status, 200);
    });

    it('проект, у которого появилась правка, поднимается в начало списка', async () => {
      const last = made.design[0];
      const r = await h.post(`/api/projects/${last}/tx`, { tx_id: uid('tx'), base_seq: 0, ops: [{ op: 'setToken', path: 'colors.q', value: '#000000' }], engine: ENGINE_VERSION });
      assert.equal(r.status, 201);
      const first = (await h.get('/api/projects?limit=1')).body;
      assert.equal(first.projects[0].id, last);
      assert.equal(first.more, true);
    });
  });
}
