/**
 * Круг 45 — оболочка (долги критиков круга 44):
 *   RS2) что хранится для спасения после перезагрузки — поведенчески (SHELL.rescueMemo), а не
 *        сверкой исходника: тело до предела хранится, больше — нет, у начатого проекта — нет;
 *   Д9)  пометка сироты по настоящему ответу списка (created_at; у прежнего сервиса — updated_at)
 *        и удаление её кнопкой: слова итога;
 *   «История» — один порядок у соавторов (по seq подтверждения);
 *   знак агента — в тон тосту, когда сервер агента не видит документ.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SHELL from '../src/shell.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'app.js'), 'utf8');

/* ------------------------------ RS2: запись спасения ------------------------------ */

test('r45 (RS2): rescueMemo — тело первой попытки хранится до предела, больше — нет; у начатого проекта — нет', () => {
  const body = { name: 'Спасение', doc: { nodes: { a: { id: 'a', name: 'x'.repeat(30000) } }, root: 'a' } };
  const job = { project: null, createId: 'rescue_1', bodySig: 's1', plan: { whole: true, body }, done: 0, total: 1, startedAt: 5 };
  const m = SHELL.rescueMemo(job, { from: 'p_from', sig: 'sig1', now: 10 });
  assert.ok(JSON.stringify(body).length > 30000 && JSON.stringify(body).length < SHELL.RESCUE_BODY_KEEP);
  assert.equal(m.body, JSON.stringify(body), 'тело ≤ предела хранится');
  const saved = JSON.parse(m.full);
  assert.equal(saved.body, JSON.stringify(body));
  assert.equal(saved.create_id, 'rescue_1');
  assert.equal(saved.body_sig, 's1');
  assert.equal(saved.from, 'p_from');
  assert.equal(saved.started_at, 5);
  assert.equal(JSON.parse(m.lean).body, undefined, 'запасная запись — без тела');
  // предел по умолчанию — не ноль и не меньше обычного документа
  assert.ok(SHELL.RESCUE_BODY_KEEP >= 1_000_000);
  // больше предела — без тела (тот же ключ с другим телом дал бы 409)
  const big = SHELL.rescueMemo(job, { keep: 1000 });
  assert.equal(big.body, '');
  assert.equal(JSON.parse(big.full).body, undefined);
  assert.equal(big.full, big.lean);
  // проект уже создан — тело не нужно
  const started = SHELL.rescueMemo({ ...job, project: { id: 'p1', name: 'Спасение' } });
  assert.equal(started.body, '');
  assert.deepEqual(JSON.parse(started.full).project, { id: 'p1', name: 'Спасение' });
  // пачек несколько — тела нет
  assert.equal(SHELL.rescueMemo({ ...job, plan: { whole: false, body } }).body, '');
  // сирота с ключом первой попытки переживает перезагрузку
  const orphan = SHELL.rescueMemo({ ...job, orphan: { name: 'Спасение', since: 1, certain: false, createId: 'rescue_0' } });
  assert.equal(JSON.parse(orphan.full).orphan.createId, 'rescue_0');
  // оболочка пишет именно эту запись
  assert.match(app, /SHELL\.rescueMemo\(job, \{ from: server\.project\.id, sig: rescueSig\(job\.plan\) \}\)/);
  assert.match(app, /sessionStorage\.setItem\(RESCUE_KEY, memo\.full\)/);
});

/* ------------------------------ Д9: сирота в «Проектах» ------------------------------ */

test('r45 (Д9): сирота помечается по настоящему ответу списка; прежний сервис без created_at — по updated_at', () => {
  const t0 = Date.parse('2026-10-26T07:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const hints = [{ name: 'Спасение', since: t0, keep: 'p_new', at: t0 + 60000, createId: 'rescue_0' }];
  // ответ GET /api/projects круга 45: {id, name, kind, head_seq, created_at, updated_at}
  const row = { id: 'p_old', name: 'Спасение', kind: 'design', head_seq: 0, created_at: iso(t0 + 1000), updated_at: iso(t0 + 1000) };
  assert.equal(SHELL.rescueOrphanHint(row, hints).createId, 'rescue_0');
  // прежний сервис (без created_at): у пустого проекта updated_at = время создания
  const { created_at: _c, ...legacy } = row;
  assert.equal(SHELL.isRescueOrphan(legacy, hints), true);
  assert.equal(SHELL.rescueOrphanHint({ ...row, id: 'p_new' }, hints), null, 'спасённый — не сирота');
  assert.equal(SHELL.rescueOrphanHint({ ...row, head_seq: 2 }, hints), null, 'с правками — не сирота');
  assert.equal(SHELL.rescueOrphanHint({ ...row, created_at: undefined, updated_at: undefined }, hints), null);
  // кнопка удаления — только у сироты с ключом и не у открытого проекта; ключ уходит в тело DELETE
  assert.match(app, /if \(hint && hint\.createId && p\.id !== current\)/);
  assert.match(app, /method: 'DELETE', body: \{ create_id: hint\.createId \}/);
  assert.match(app, /drop\.textContent = 'Точно удалить\?'/, 'не молча: второе нажатие');
});

test('r45: итог удаления сироты — словами, без кодов', () => {
  assert.equal(SHELL.orphanDeleteWords('Спасение'), 'Удалил пустую первую попытку «Спасение».');
  assert.match(SHELL.orphanDeleteWords('Спасение', { status: 409, detail: { cause: 'not_empty' } }), /уже есть правки/);
  assert.match(SHELL.orphanDeleteWords('Спасение', { status: 409, detail: { cause: 'create_id' } }), /не первая попытка/);
  assert.match(SHELL.orphanDeleteWords('Спасение', { status: 404 }), /уже удалён/);
  assert.match(SHELL.orphanDeleteWords('Спасение', { status: 405 }), /ещё не умеет удалять/);
  for (const e of [{ status: 503 }, { status: 500 }, { status: 409 }]) assert.doesNotMatch(SHELL.orphanDeleteWords('С', e), /\b\d{3}\b/);
});

/* ------------------------------ «История»: один порядок у соавторов ------------------------------ */

test('r45: «История» — порядок по seq подтверждения, одинаковый у Ани и Бориса', () => {
  /* s28h `one`: Аня офлайн обернула список (у неё — раньше по времени вкладки), Борис тем временем
     удалил подзаголовок (seq 1); обёртка Ани легла seq 2. Новые сверху у обоих: обёртка, удаление. */
  const t = (s) => Date.parse('2026-10-26T07:00:00Z') + s * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  // у Ани: своя обёртка в стеке (at — время вкладки, раньше удаления Бориса), удаление Бориса — чужое
  const ania = SHELL.historyOrder([{ at: t(0), seq: 2 }], [{ seq: 1, created_at: iso(t(5)) }]);
  assert.deepEqual(ania, [{ own: 0 }, { other: 0 }]);
  // у Бориса: своё удаление в стеке, обёртка Ани — чужая (created_at сервера позже)
  const boris = SHELL.historyOrder([{ at: t(5), seq: 1 }], [{ seq: 2, created_at: iso(t(9)) }]);
  assert.deepEqual(boris, [{ other: 0 }, { own: 0 }]);
  // прежнее правило (по времени вкладки) поставило бы удаление Бориса над обёрткой Ани
  const byTime = SHELL.historyOrder([{ at: t(0) }], [{ created_at: iso(t(5)) }]);
  assert.deepEqual(byTime, [{ other: 0 }, { own: 0 }], 'без номеров — по времени, как раньше');
  // своя ещё в пути — новее всего подтверждённого
  assert.deepEqual(SHELL.historyOrder([{ at: t(0), seq: 1 }, { at: t(1), pending: true }], [{ seq: 7, created_at: iso(t(30)) }]),
    [{ own: 1 }, { other: 0 }, { own: 0 }]);
  // чужие между своими — по номерам; стек своих не переставляется
  assert.deepEqual(SHELL.historyOrder([{ at: 0, seq: 2 }, { at: 1, seq: 5 }], [{ seq: 1 }, { seq: 3 }, { seq: 6 }, { seq: 4 }]),
    [{ other: 2 }, { own: 1 }, { other: 3 }, { other: 1 }, { own: 0 }, { other: 0 }]);
  assert.match(app, /SHELL\.historyOrder\(ownKeys, others\)/);
});

/* ------------------------------ знак агента ------------------------------ */

test('r45: знак агента в тон тосту — сервер без документа или модели не зелёный', () => {
  assert.deepEqual(SHELL.agentBadge('server', { ok: true, document: 'up', llm: 'up' }), { dot: 'on', words: 'агент: сервер' });
  const nodoc = SHELL.agentBadge('server', { ok: true, document: 'down', llm: 'up' });
  assert.equal(nodoc.dot, 'off');
  assert.match(nodoc.words, /без документа/);
  assert.equal(SHELL.agentBadge('server', { ok: true, document: 'up', llm: 'down' }).dot, 'off');
  assert.equal(SHELL.agentBadge('browser', null).dot, 'off');
  assert.equal(SHELL.agentBadge('off', null).dot, 'error');
  assert.match(app, /const badge = SHELL\.agentBadge\(mode, serverAgent\.health\);/);
  assert.match(app, /dot\.dataset\.state = badge\.dot;/);
  // «Сервер документа снова на связи» ждёт, пока и строка состояния это видит
  assert.match(app, /prev\.document !== 'up' && !syncHealthy\(\)\) \{ serverAgent\.backLater = words; return; \}/);
});
