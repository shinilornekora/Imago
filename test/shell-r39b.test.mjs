/**
 * Круг 39 (стыковка ORCH → SHELL): событие `queued {scope:'read'}` — очередь полных чтений
 * агента (семафор DSLR), а не очередь проекта: без «чьи команды впереди» по присутствию.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const others = [{ author: 'Аня', busy: true }, { author: 'Борис', busy: 2 }, { author: 'Вера' }];

test('r39b: queued scope read — «ждёт очереди на чтение документа», без имён соавторов', () => {
  const r = SHELL.queuedStage({ position: 3, scope: 'read' }, others);
  assert.equal(r.stage, 'srv:queued');
  assert.equal(r.scope, 'read');
  assert.equal(r.position, 3);
  assert.equal(r.label, 'Ждёт очереди на чтение документа…');
  assert.doesNotMatch(r.label, /Аня|Борис|проекта/);
  assert.equal(SHELL.queuedLabel(1, ['Аня'], 'read'), 'Ждёт очереди на чтение документа…');
});

test('r39b: workers — как прежде; проект (и событие без scope от прежнего Orchestrator) — с именами впереди', () => {
  assert.equal(SHELL.queuedStage({ position: 2, scope: 'workers' }, others).label, 'Ждёт свободного исполнителя агента…');
  assert.equal(SHELL.queuedStage({ position: 2, scope: 'project' }, others).label, 'В очереди проекта: впереди 2 команды (Аня, Борис)');
  const old = SHELL.queuedStage({ position: 1 }, others);
  assert.equal(old.scope, 'project');
  assert.equal(old.label, 'В очереди проекта: впереди 1 команда (Аня, Борис)');
  assert.equal(SHELL.queuedStage(null, null).label, 'В очереди проекта');
  // неизвестная (будущая) очередь агента — общими словами, без чужих имён
  const fut = SHELL.queuedStage({ position: 4, scope: 'gpu' }, others);
  assert.equal(fut.label, 'Ждёт очереди агента…');
});

test('r39b: оболочка берёт стадию очереди из SHELL.queuedStage, своей развилки по scope нет', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  const at = app.indexOf("if (ev.type === 'queued')");
  assert.ok(at > 0);
  const body = app.slice(at, app.indexOf("} else if (ev.type === 'stage')", at));
  assert.match(body, /SHELL\.queuedStage\(ev\.data, server \? server\.others : \[\]\)/);
  assert.doesNotMatch(body, /'workers'/, 'scope не разбирается в app.js');
});
