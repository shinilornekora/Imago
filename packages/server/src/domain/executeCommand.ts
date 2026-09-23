/**
 * Чистая логика команды (SPEC §2.3):
 *   права → идемпотентность → expectedRevision → изменение → revision+1 → запись операции.
 * Не знает о HTTP и о драйвере БД — работает только через DomainTx.
 */
import { createHash } from 'node:crypto';
import { HEX_COLOR_RE, type CommandRequest } from '@stand/shared';
import { DomainError, type CommandOutcome, type DomainTx } from './types.js';

/**
 * Хеш ЛОГИЧЕСКИХ параметров команды для идемпотентности: фиксированный порядок ключей, документ включён.
 *
 * `expectedRevision` в хеш НЕ входит (исправление дефекта B16, 2026‑09‑13). §1.2: «Повтор с теми же
 * параметрами возвращает ранее полученный результат, повтор с иными параметрами отклоняется».
 * Логические параметры команды — документ, тип, целевая фигура и новое значение; `expectedRevision` —
 * это предусловие оптимистичной блокировки, а не часть смысла операции. Когда он входил в хеш,
 * честный повтор одной и той же логической команды (клиент не получил ответ → `GET /api/operations/:opId`
 * дал 404 → клиент перечитал метаданные документа и повторил POST с уже сдвинувшейся ревизией)
 * получал 409 `op_conflict` — «конфликт параметров» там, где по контракту должен быть возврат
 * сохранённого результата.
 *
 * Семантика после исправления (проверяется `test/domain.test.ts`, блок «идемпотентность»):
 *   тот же `opId` + те же (docId, type, targetId, fill) → тот же результат, второго изменения нет,
 *     независимо от того, какой `expectedRevision` пришёл в повторе и сдвинулась ли ревизия;
 *   тот же `opId` + иные логические параметры (другой документ, тип, цель или цвет) → `op_conflict`.
 * Возврат сохранённого результата происходит ДО проверки ревизии (шаг 3 раньше шага 4), поэтому
 * повтор после сдвига ревизии не даёт и `revision_mismatch`.
 */
export function paramsHash(docId: string, cmd: CommandRequest): string {
  const canonical = JSON.stringify({
    docId,
    type: cmd.type,
    targetId: cmd.targetId,
    fill: cmd.fill,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function validate(cmd: CommandRequest): void {
  if (cmd.type !== 'setSourceFill' && cmd.type !== 'setLocalFill') {
    throw new DomainError('bad_request', `unknown command type "${String(cmd.type)}"`);
  }
  if (typeof cmd.fill !== 'string' || !HEX_COLOR_RE.test(cmd.fill)) {
    throw new DomainError('bad_request', `fill must match #rrggbb (lowercase), got "${String(cmd.fill)}"`);
  }
  if (!Number.isInteger(cmd.expectedRevision) || cmd.expectedRevision < 0) {
    throw new DomainError('bad_request', 'expectedRevision must be a non-negative integer');
  }
  if (typeof cmd.opId !== 'string' || cmd.opId.length === 0) {
    throw new DomainError('bad_request', 'opId is required');
  }
  if (typeof cmd.targetId !== 'string' || cmd.targetId.length === 0) {
    throw new DomainError('bad_request', 'targetId is required');
  }
}

export async function executeCommand(
  tx: DomainTx,
  userId: string,
  docId: string,
  cmd: CommandRequest,
): Promise<CommandOutcome> {
  validate(cmd);

  // 1. Права на документ (403 чужой, 404 отсутствует). readRevision блокирует строку документа,
  //    поэтому параллельные команды и повторы по одному документу выполняются строго по очереди.
  const doc = await tx.readRevision(docId);
  if (!doc) throw new DomainError('not_found', `document "${docId}" not found`);
  if (doc.ownerId !== userId) throw new DomainError('forbidden', 'document belongs to another user');

  // 2. Права на целевую фигуру и её семантика.
  const shape = await tx.readShapeOwner(cmd.targetId);
  if (!shape) throw new DomainError('not_found', `shape "${cmd.targetId}" not found`);
  if (shape.ownerId !== userId) throw new DomainError('forbidden', 'target shape belongs to another user');
  if (shape.documentId !== docId) {
    throw new DomainError('not_found', `shape "${cmd.targetId}" is not in document "${docId}"`);
  }
  if (cmd.type === 'setSourceFill' && !shape.isSource) {
    throw new DomainError('bad_request', 'setSourceFill target must be a source shape');
  }
  if (cmd.type === 'setLocalFill' && shape.isSource) {
    throw new DomainError('bad_request', 'setLocalFill target must be an instance or an ordinary shape, not a source');
  }

  // 3. Идемпотентность: тот же opId + те же ЛОГИЧЕСКИЕ параметры → тот же результат без второго
  //    изменения (в том числе если ревизия уже сдвинулась — см. paramsHash); тот же opId + другие
  //    логические параметры → op_conflict. Шаг идёт РАНЬШЕ проверки ревизии намеренно: повтор не
  //    должен зависеть от того, какой expectedRevision клиент подставил во второй попытке.
  const hash = paramsHash(docId, cmd);
  const stored = await tx.readOperation(cmd.opId);
  if (stored) {
    if (stored.documentId === docId && stored.paramsHash === hash) {
      return { result: stored.result, replayed: true };
    }
    throw new DomainError('op_conflict', `operation "${cmd.opId}" already exists with different parameters`);
  }

  // 4. Проверка ревизии.
  if (cmd.expectedRevision !== doc.revision) {
    throw new DomainError(
      'revision_mismatch',
      `expected revision ${cmd.expectedRevision}, current is ${doc.revision}`,
      doc.revision,
    );
  }

  // 5. Изменение.
  let affectedPages: string[];
  let affectedShapes: number;
  if (cmd.type === 'setSourceFill') {
    const r = await tx.updateSourceAndInstances(cmd.targetId, cmd.fill);
    affectedPages = [...new Set(r.affectedPages)].sort();
    affectedShapes = r.affectedShapes;
  } else {
    const r = await tx.updateShapeFill(cmd.targetId, cmd.fill);
    affectedPages = [r.pageId];
    affectedShapes = 1;
  }

  // 6. revision + 1 и запись операции — в той же транзакции.
  const revision = await tx.bumpRevision(docId);
  const result = { opId: cmd.opId, revision, affectedPages, affectedShapes };
  await tx.writeOperation({ opId: cmd.opId, documentId: docId, paramsHash: hash, result });
  return { result, replayed: false };
}
