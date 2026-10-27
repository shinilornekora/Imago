/**
 * Сайдкары для LLM (конституция, принцип VII): у каждого файла кода есть заметка
 * `<файл>.llm.md` (или `README.llm.md` его каталога), и нет заметок без файла.
 * Свежесть заметок против изменений ветки — `node tools/sidecars.mjs --changed <база>`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, noteOf } from '../tools/sidecars.mjs';

test('у каждого файла кода есть заметка, у каждой заметки — файл', () => {
  const r = check();
  assert.ok(r.code > 0, 'файлы кода не найдены — проверка смотрит не туда');
  assert.deepEqual(r.missing, [], 'файлы без заметки <файл>.llm.md (шаблон — .specify/templates/sidecar-template.md)');
  assert.deepEqual(r.orphans, [], 'заметки, чьего файла больше нет: переименуйте или удалите вместе с файлом');
});

test('README.llm.md каталога отвечает за все его файлы; прочие — своей заметкой', () => {
  const root = mkdtempSync(join(tmpdir(), 'imago-sidecars-'));
  try {
    mkdirSync(join(root, 'a', 'mig'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'a', 'x.js'), '');
    writeFileSync(join(root, 'a', 'x.js.llm.md'), '');
    writeFileSync(join(root, 'a', 'y.mjs'), '');
    writeFileSync(join(root, 'a', 'gone.js.llm.md'), '');
    writeFileSync(join(root, 'a', 'mig', '001_a.mjs'), '');
    writeFileSync(join(root, 'a', 'mig', 'README.llm.md'), '');
    writeFileSync(join(root, 'test', 't.test.mjs'), '');
    const r = check(root);
    assert.deepEqual(r.missing, ['a/y.mjs']);
    assert.deepEqual(r.orphans, ['a/gone.js.llm.md']);
    assert.equal(noteOf('a/mig/001_a.mjs', new Set(['a/mig'])), 'a/mig/README.llm.md');
    assert.equal(noteOf('a/x.js', new Set()), 'a/x.js.llm.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
