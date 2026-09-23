/** Модульные тесты предметного модуля (SPEC §2.3) на in-memory DomainTx. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandRequest } from '@stand/shared';
import { DomainError, executeCommand, paramsHash } from '../src/domain/index.js';
import { FakeTx } from './fakeTx.js';

const DOC = 'doc-1';
const ALICE = 'u-alice';
const BOB = 'u-bob';

function setup(): FakeTx {
  const tx = new FakeTx();
  tx.addDoc(DOC, ALICE, 0);
  tx.addDoc('doc-bob', BOB, 0);
  tx.addShape({ id: 'src', documentId: DOC, pageId: 'p-lib', isSource: true, fill: '#111111' });
  tx.addShape({ id: 'i1', documentId: DOC, pageId: 'p1', sourceId: 'src', fill: '#111111' });
  tx.addShape({ id: 'i2', documentId: DOC, pageId: 'p2', sourceId: 'src', fill: '#111111' });
  tx.addShape({ id: 'i3-over', documentId: DOC, pageId: 'p2', sourceId: 'src', fill: '#abcdef', fillOverridden: true });
  tx.addShape({ id: 'i4', documentId: DOC, pageId: 'p3', sourceId: 'src', fill: '#111111' });
  tx.addShape({ id: 'plain', documentId: DOC, pageId: 'p1', fill: '#222222' });
  tx.addShape({ id: 'bob-src', documentId: 'doc-bob', pageId: 'pb', isSource: true, fill: '#333333' });
  return tx;
}

const cmd = (over: Partial<CommandRequest> = {}): CommandRequest => ({
  opId: 'op-1',
  type: 'setSourceFill',
  targetId: 'src',
  fill: '#ff0000',
  expectedRevision: 0,
  ...over,
});

async function expectError(p: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected DomainError ${code}, but command succeeded`);
}

describe('executeCommand: setSourceFill', () => {
  it('меняет источник и непереопределённые экземпляры на всех страницах, revision+1, пишет операцию', async () => {
    const tx = setup();
    const { result, replayed } = await executeCommand(tx, ALICE, DOC, cmd());
    assert.equal(replayed, false);
    // src + i1 + i2 + i4 = 4 (i3-over переопределён и не считается).
    assert.deepEqual(result, { opId: 'op-1', revision: 1, affectedPages: ['p-lib', 'p1', 'p2', 'p3'], affectedShapes: 4 });
    assert.equal(tx.shapes.get('src')!.fill, '#ff0000');
    assert.equal(tx.shapes.get('i1')!.fill, '#ff0000');
    assert.equal(tx.shapes.get('i2')!.fill, '#ff0000');
    assert.equal(tx.shapes.get('i4')!.fill, '#ff0000');
    // Переопределённый экземпляр не тронут (§1.1).
    assert.equal(tx.shapes.get('i3-over')!.fill, '#abcdef');
    assert.equal(tx.shapes.get('i3-over')!.fillOverridden, true);
    assert.equal(tx.shapes.get('plain')!.fill, '#222222');
    assert.equal(tx.docs.get(DOC)!.revision, 1);
    const op = tx.ops.get('op-1')!;
    assert.equal(op.documentId, DOC);
    assert.equal(op.paramsHash, paramsHash(DOC, cmd()));
    assert.deepEqual(op.result, result);
    // Порядок: права → идемпотентность → ревизия → изменение → revision+1 → запись операции.
    assert.deepEqual(tx.calls, [
      `readRevision:${DOC}`, 'readShapeOwner:src', 'readOperation:op-1',
      'updateSourceAndInstances:src:#ff0000', `bumpRevision:${DOC}`, 'writeOperation:op-1',
    ]);
  });

  it('target не источник → bad_request', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ targetId: 'i1' })), 'bad_request');
    assert.equal(tx.docs.get(DOC)!.revision, 0);
  });
});

describe('executeCommand: setLocalFill', () => {
  it('ставит fill и fillOverridden=true; affectedPages = страница фигуры', async () => {
    const tx = setup();
    const { result } = await executeCommand(tx, ALICE, DOC, cmd({ type: 'setLocalFill', targetId: 'i2', fill: '#00ff00' }));
    assert.deepEqual(result, { opId: 'op-1', revision: 1, affectedPages: ['p2'], affectedShapes: 1 });
    assert.equal(tx.shapes.get('i2')!.fill, '#00ff00');
    assert.equal(tx.shapes.get('i2')!.fillOverridden, true);
  });

  it('совпадение локального цвета с цветом источника не снимает переопределение (§1.1)', async () => {
    const tx = setup();
    await executeCommand(tx, ALICE, DOC, cmd({ opId: 'a', type: 'setLocalFill', targetId: 'i2', fill: '#111111' }));
    assert.equal(tx.shapes.get('i2')!.fillOverridden, true);
    // Последующая общая заливка источника его не меняет.
    const { result } = await executeCommand(tx, ALICE, DOC, cmd({ opId: 'b', fill: '#ff0000', expectedRevision: 1 }));
    assert.equal(tx.shapes.get('i2')!.fill, '#111111');
    // src, i1, i4 — i2 и i3-over переопределены и не затронуты.
    assert.equal(result.affectedShapes, 3);
    assert.deepEqual(result.affectedPages, ['p-lib', 'p1', 'p3']);
  });

  it('обычная фигура тоже принимает локальную заливку', async () => {
    const tx = setup();
    const { result } = await executeCommand(tx, ALICE, DOC, cmd({ type: 'setLocalFill', targetId: 'plain', fill: '#00ff00' }));
    assert.deepEqual(result.affectedPages, ['p1']);
    assert.equal(tx.shapes.get('plain')!.fill, '#00ff00');
  });

  it('setLocalFill на источнике → bad_request', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ type: 'setLocalFill', targetId: 'src' })), 'bad_request');
  });
});

describe('executeCommand: идемпотентность', () => {
  it('повтор с тем же opId и параметрами → тот же результат без второго изменения', async () => {
    const tx = setup();
    const first = await executeCommand(tx, ALICE, DOC, cmd());
    tx.calls.length = 0;
    const second = await executeCommand(tx, ALICE, DOC, cmd());
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(tx.docs.get(DOC)!.revision, 1);
    assert.ok(!tx.calls.some((c) => c.startsWith('update') || c.startsWith('bump') || c.startsWith('writeOperation')));
  });

  it('повтор после чужой команды (ревизия ушла вперёд) всё равно возвращает сохранённый результат', async () => {
    const tx = setup();
    const first = await executeCommand(tx, ALICE, DOC, cmd());
    await executeCommand(tx, ALICE, DOC, cmd({ opId: 'op-2', type: 'setLocalFill', targetId: 'i1', fill: '#123456', expectedRevision: 1 }));
    const replay = await executeCommand(tx, ALICE, DOC, cmd());
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal(tx.docs.get(DOC)!.revision, 2);
  });

  it('тот же opId с другими ЛОГИЧЕСКИМИ параметрами → op_conflict', async () => {
    const tx = setup();
    await executeCommand(tx, ALICE, DOC, cmd());
    // другое значение, другая цель, другой тип, другой документ — всё это иные параметры операции
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ fill: '#00ff00' })), 'op_conflict');
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ targetId: 'i1', type: 'setLocalFill' })), 'op_conflict');
    await expectError(executeCommand(tx, BOB, 'doc-bob', cmd({ targetId: 'bob-src' })), 'op_conflict');
    assert.equal(tx.docs.get(DOC)!.revision, 1);
  });

  // --- дефект B16: expectedRevision не входит в ключ идемпотентности -----------------------------
  // §1.2: «Повтор с теми же параметрами возвращает ранее полученный результат, повтор с иными
  // параметрами отклоняется». expectedRevision — предусловие блокировки, а не параметр операции.
  it('B16: повтор с тем же opId и иным expectedRevision → сохранённый результат, а не op_conflict', async () => {
    const tx = setup();
    const first = await executeCommand(tx, ALICE, DOC, cmd({ expectedRevision: 0 }));
    assert.equal(first.replayed, false);
    assert.equal(first.result.revision, 1);
    tx.calls.length = 0;
    // Клиент не получил ответ, перечитал метаданные (revision уже 1) и повторил ту же команду.
    const retry = await executeCommand(tx, ALICE, DOC, cmd({ expectedRevision: 1 }));
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.result, first.result);
    assert.equal(tx.docs.get(DOC)!.revision, 1, 'второго изменения быть не должно');
    assert.ok(!tx.calls.some((c) => c.startsWith('update') || c.startsWith('bump') || c.startsWith('writeOperation')));
    // и наоборот: повтор со «старым» expectedRevision тоже отдаёт результат, а не revision_mismatch
    const retryOld = await executeCommand(tx, ALICE, DOC, cmd({ expectedRevision: 0 }));
    assert.equal(retryOld.replayed, true);
    assert.deepEqual(retryOld.result, first.result);
  });

  it('B16: paramsHash не зависит от expectedRevision и зависит от каждого логического параметра', async () => {
    const base = paramsHash(DOC, cmd());
    assert.equal(base, paramsHash(DOC, cmd({ expectedRevision: 42 })));
    assert.equal(base, paramsHash(DOC, cmd({ opId: 'op-other' })), 'opId — ключ записи, а не её параметр');
    for (const other of [cmd({ fill: '#00ff00' }), cmd({ targetId: 'i1' }), cmd({ type: 'setLocalFill' })]) {
      assert.notEqual(base, paramsHash(DOC, other));
    }
    assert.notEqual(base, paramsHash('doc-2', cmd()), 'документ входит в хеш');
  });
});

describe('executeCommand: ревизия', () => {
  it('expectedRevision != revision → revision_mismatch с currentRevision', async () => {
    const tx = setup();
    tx.docs.get(DOC)!.revision = 7;
    const err = await expectError(executeCommand(tx, ALICE, DOC, cmd({ expectedRevision: 6 })), 'revision_mismatch');
    assert.equal(err.currentRevision, 7);
    assert.equal(err.statusCode, 409);
    assert.deepEqual(err.toApiError(), { error: 'revision_mismatch', message: err.message, currentRevision: 7 });
    assert.equal(tx.shapes.get('src')!.fill, '#111111');
    assert.equal(tx.ops.size, 0);
  });

  it('последовательные команды: ревизия растёт на 1 за каждую', async () => {
    const tx = setup();
    for (let i = 0; i < 5; i++) {
      const { result } = await executeCommand(tx, ALICE, DOC, cmd({ opId: `op-${i}`, expectedRevision: i, fill: `#00000${i}` }));
      assert.equal(result.revision, i + 1);
    }
  });
});

describe('executeCommand: права и валидация', () => {
  it('чужой документ → forbidden', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, BOB, DOC, cmd()), 'forbidden');
  });

  it('чужая фигура в своём документе → forbidden; фигура из другого своего документа → not_found', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ targetId: 'bob-src' })), 'forbidden');
    tx.addDoc('doc-alice-2', ALICE, 0);
    tx.addShape({ id: 'other-src', documentId: 'doc-alice-2', pageId: 'px', isSource: true });
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ targetId: 'other-src' })), 'not_found');
  });

  it('несуществующий документ/фигура → not_found', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, ALICE, 'nope', cmd()), 'not_found');
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ targetId: 'nope' })), 'not_found');
  });

  it('неверный цвет / тип → bad_request', async () => {
    const tx = setup();
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ fill: '#FF0000' })), 'bad_request');
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ fill: 'red' })), 'bad_request');
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ type: 'delete' as never })), 'bad_request');
    await expectError(executeCommand(tx, ALICE, DOC, cmd({ expectedRevision: -1 })), 'bad_request');
  });
});
