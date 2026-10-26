/**
 * Круг 43 (SHELL): спасение без перезагрузки (UX Д8) — повтор тем же create_id с прежним телом и
 * досылка изменившегося заменой документа; сирота первой попытки — словами и пометой; «История» по
 * применённым операциям; кто удалил слой обёртки; один тост на одно событие; знак агента при
 * лежащей базе — частой проверкой только пока документ «лежит».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';
import { engineWords } from '../src/sync.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const app = read('app.js');
const apply = (d, ops) => {
  const r = core.applyOps(d, ops);
  assert.ok(!r.error, r.error && r.error.message);
  return r.doc;
};

/* ------------------------------ Д8: спасение без перезагрузки ------------------------------ */

test('r43 (UX Д8): правки после неудачной попытки — заменой документа того же проекта: итог равен виду вкладки', () => {
  // проект первой попытки создан с документом на момент плана
  const planned = core.ensureLibrary(core.createDoc());
  const server = core.createDoc('empty');   // свой корень у проекта на сервере
  const created = apply(server, SHELL.replaceDocOps(server, planned));
  // после неудачи человек правил: скрыл слой, переименовал, удалил другой
  const kids = core.artboards(planned)[0].children;
  const view = apply(planned, [core.ops.set(kids[0], 'visible', false), core.ops.set(kids[1], 'name', 'После попытки'), core.ops.remove(kids[2])]);
  const ops = SHELL.replaceDocOps(created, view);
  const parts = SHELL.splitOpsForServer(ops, { maxOps: 40 });
  assert.ok(parts.length > 1, 'досылка частями по пределу транзакции');
  let doc = created;
  for (const p of parts) doc = apply(doc, p);
  const strip = (d) => {
    const out = {};
    for (const id of core.subtreeIds(d, d.root)) if (id !== d.root) out[id] = { ...d.nodes[id], parent: d.nodes[id].parent === d.root ? 'ROOT' : d.nodes[id].parent };
    return out;
  };
  assert.deepEqual(strip(doc), strip(view), 'документ проекта — ровно вид вкладки');
  assert.deepEqual(doc.tokens, view.tokens);
  assert.equal(doc.nodes[kids[0]].visible, false, 'правка после попытки на месте');
  // оболочка: повтор без перезагрузки сверяет отпечаток и досылает изменившееся
  const save = app.slice(app.indexOf('async function saveAsNewProject'), app.indexOf('function rescueChanged'));
  assert.match(save, /if \(job && !job\.catchUp && rescueChanged\(job, view, name\)\) job\.catchUp = true;/);
  assert.match(save, /if \(job\.catchUp\) \{\s*await rescueCatchUp\(job, sync\.view \|\| view\);/);
  const catchUp = app.slice(app.indexOf('async function rescueCatchUp'), app.indexOf('const RESCUE_KEY'));
  assert.match(catchUp, /SHELL\.splitOpsForServer\(SHELL\.replaceDocOps\(doc, viewNow\)\)/);
  // после перезагрузки: тело первой попытки — в sessionStorage, тот же ключ с тем же телом
  // круг 45: что хранится — SHELL.rescueMemo (поведение — test/shell-r45.test.mjs)
  assert.match(app, /SHELL\.rescueMemo\(job, \{ from: server\.project\.id, sig: rescueSig\(job\.plan\) \}\)/);
  assert.match(app, /plan: oldPlan, project: null, createId, bodySig: saved\.body_sig[^\n]*catchUp: true/);
});

test('r43: сирота первой попытки — словами и пометой в «Проектах»', () => {
  const sure = SHELL.rescueOrphanWords({ name: 'Спасение', certain: true });
  assert.match(sure, /^Первая попытка тоже сохранилась — отдельным проектом «Спасение» без последних правок/);
  assert.match(sure, /помечен «первая попытка»/);
  assert.match(SHELL.rescueOrphanWords({ name: 'Спасение' }), /^Если первая попытка всё же успела сохраниться/);
  const t0 = Date.parse('2026-10-18T07:00:00Z');
  const hints = [{ name: 'Спасение', since: t0, keep: 'p_new', at: t0 + 60000 }];
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(SHELL.isRescueOrphan({ id: 'p_old', name: 'Спасение', head_seq: 0, created_at: iso(t0 + 1000) }, hints), true);
  assert.equal(SHELL.isRescueOrphan({ id: 'p_new', name: 'Спасение', head_seq: 0, created_at: iso(t0 + 2000) }, hints), false, 'спасённый — не сирота');
  assert.equal(SHELL.isRescueOrphan({ id: 'p_x', name: 'Спасение', head_seq: 3, created_at: iso(t0 + 1000) }, hints), false, 'с правками — не пустая копия');
  assert.equal(SHELL.isRescueOrphan({ id: 'p_y', name: 'Другой', head_seq: 0, created_at: iso(t0 + 1000) }, hints), false);
  assert.equal(SHELL.isRescueOrphan({ id: 'p_z', name: 'Спасение', head_seq: 0, created_at: iso(t0 - 3600 * 1000) }, hints), false, 'старый одноимённый — не сирота');
  assert.match(app, /const hint = SHELL\.rescueOrphanHint\(p, orphanHints\(\)\);\s*const orphan = hint \? 'первая попытка сохранения, без последних правок'/);
  assert.match(app, /if \(job\.orphan\) rememberOrphan\(/);
});

/* ------------------------------ «История» по применённому ------------------------------ */

test('r43: «История» — по применённым операциям: часть не легла, не легло ничего', () => {
  assert.equal(SHELL.appliedLine('Обернул 2 слоя в рамку «Группа»', { ops: 2, dropped: 1 }), 'Обернул 2 слоя в рамку «Группа» · не легло 1 из 3');
  assert.equal(SHELL.appliedLine('Обернул 2 слоя в рамку «Группа»', { ops: 0, dropped: 3 }), 'Обернул 2 слоя в рамку «Группа» — не применилась');
  assert.equal(SHELL.appliedLine('Скрыл «Шапка»', { ops: 1, dropped: 0 }), 'Скрыл «Шапка»');
  // свои — по подтверждённой форме; чужие — по ops_count/dropped_count журнала
  assert.match(app, /entry\.dropped = Array\.isArray\(c\.dropped\) \? c\.dropped\.length/);
  assert.match(app, /SHELL\.appliedLine\(human\(tx\.human \|\| tx\.label\), \{ ops: /);
  assert.match(app, /SHELL\.appliedLine\(base, \{ ops: t\.ops_count, dropped: t\.dropped_count \}\)/);
  // «обернуть» соавтора — подпись по тому, что легло
  assert.match(app, /group \? SHELL\.wrapWords\(doc, group\.node\.children, group\.node\.name\) : describeOps\(tx\.ops, doc\)/);
});

test('r43: «1 слой в рамку не вошёл: его удалил Борис» — кто удалил, если известно', () => {
  assert.equal(SHELL.wrapLostWords(1, { author: 'Борис', author_kind: 'human' }), '1 слой в рамку не вошёл: его удалил Борис.');
  assert.equal(SHELL.wrapLostWords(1, { author: 'Аня', author_kind: 'human' }), '1 слой в рамку не вошёл: его удалила Аня.');
  assert.equal(SHELL.wrapLostWords(2, { author: 'Аня', author_kind: 'human' }), '2 слоя в рамку не вошли: их удалила Аня.');
  assert.equal(SHELL.wrapLostWords(1, null), '1 слой в рамку не вошёл: его уже удалили.');
  assert.equal(SHELL.wrapLostWords(1, { author: '', author_kind: 'human' }), '1 слой в рамку не вошёл: его уже удалили.', 'без имени — без «кто-то»');
  // wrapSettledWords отдаёт пропавшие, оболочка спрашивает, кто их удалил
  const doc = core.ensureLibrary(core.createDoc());
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && (n.children || []).length >= 3 && !core.isArtboard(doc, n.id) && !n.component);
  const sel = [frame.children[1], frame.children[2]];
  const w = SHELL.wrapOps(doc, sel, { rects: core.solve(doc).rects });
  const theirs = [core.ops.remove(sel[0])];
  const head = apply(doc, theirs);
  const tomb = new Map();
  core.collectTombstones(doc, theirs, tomb);
  const m = core.rebase(head, w.ops, { tombstones: tomb });
  const s = SHELL.wrapSettledWords(apply(head, m.ops), m.ops, w.id, sel);
  assert.deepEqual(s.lostIds, [sel[0]]);
  assert.match(app, /const note = SHELL\.wrapLostWords\(w\.lost, one\);/);
});

/* ------------------------------ слова и тосты ------------------------------ */

test('r43: без обещания «команды агента подождут»; один тост на обновление сервера и на возврат сети', () => {
  const w = engineWords(core.ENGINE_VERSION - 1, core.ENGINE_VERSION);
  assert.doesNotMatch(w.note, /подождут/);
  assert.match(w.note, /Команды агента до тех пор не выполняются/);
  assert.doesNotMatch(read('src/sync.js'), /Команды агента подождут/);
  // «сервер документа снова на связи» / «сеть вернулась — агент снова на связи» не дублируют сказанное
  assert.match(app, /if \(words\.back && Date\.now\(\) < \(serverAgent\.quietBackUntil \|\| 0\)\) return;/);
  assert.match(app, /serverAgent\.quietBackUntil = Date\.now\(\) \+ 15000;\s*\/\/ «сервер документа снова на связи»/);
  assert.match(app, /serverAgent\.quietBackUntil = Date\.now\(\) \+ 15000;\s*showMsg\('plain', 'Сеть вернулась'/);
});

test('r43: знак агента при лежащей базе — частая проверка только пока документ «лежит»', () => {
  assert.match(app, /const AGENT_DOWN_PROBE_MS = 4000;/);
  const fn = app.slice(app.indexOf('function docTrouble()'), app.indexOf('function watchAgentHealth()'));
  assert.match(fn, /s\.storage === 'down'/);
  assert.match(fn, /h\.document !== 'up'/);
  assert.match(fn, /if \(!docTrouble\(\)\) return;/, 'в норме — без лишних запросов');
  assert.match(app, /if \(wasHealthy && !syncHealthy\(\) && docTrouble\(\)\) probeAgent\(\{ force: true \}\);\s*armDocProbe\(\);/);
});

/* ------------------------------ ORCH круга 43: какой сервер старее ------------------------------ */

test('r43 (ORCH): engine от агента — сервер документов старее проекта (повтор по сроку) или сервер агента старее', async () => {
  const AG = await import('../src/agent.js');
  assert.ok(AG.DOCUMENT_REASONS.includes('engine'));
  const doc = { code: 'engine', retryable: true, retryAfterMs: 30000, detail: { cause: 'server_old', server: 'document', engine: 1, found: 2 } };
  assert.equal(AG.engineCause(doc), 'document_old');
  const wd = SHELL.agentErrorWords(doc);
  assert.equal(wd.title, 'Сервер документов ещё не обновился — команда не выполнена');
  assert.equal(wd.waitMs, 30000, '«Повторить» — по сроку');
  const ag = { code: 'engine', retryable: false, detail: { cause: 'agent_old', engine: 1, found: 2 } };
  assert.equal(AG.engineCause(ag), 'agent_old');
  assert.match(SHELL.agentErrorWords(ag).title, /^Сервер агента ещё не обновился/);
  assert.equal(AG.engineCause({ code: 'engine', detail: { cause: 'server_old' } }), 'server_old', 'сервер агента старее вкладки — как в круге 41');
  // health: документ «не виден» из-за версии — словами про версию
  const n = SHELL.agentHealthNotice({ ok: true, document: 'up', llm: 'up' }, { ok: true, document: 'down', document_reason: 'engine', llm: 'up' });
  assert.match(n.text, /сервер документов ещё на прежней версии редактора/);
  const fn = app.slice(app.indexOf('const cause = AGENT.engineCause(e);'), app.indexOf('const cause = AGENT.engineCause(e);') + 900);
  assert.match(fn, /cause === 'document_old' \? \[\{ label: 'Повторить', primary: true, waitMs: w\.waitMs/);
});
