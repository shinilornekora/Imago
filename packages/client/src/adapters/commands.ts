import type { CommandRequest, CommandResult } from '@stand/shared';
import { getOperation, isApiError, isDefinitiveError, postCommand } from '../api';
import { ADAPTER_SETTINGS } from './types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Отправка команды с политикой повтора (общая для H и Q, SPEC §2.3, §6 п. 6):
 *  1) POST; определённый ответ (2xx/4xx) — результат/ошибка;
 *  2) сетевая ошибка или 5xx — результат неопределён: опрос GET /api/operations/:opId
 *     до `commandPollAttempts` раз (операция могла быть записана);
 *  3) если операции нет (404) — повторный POST с ТЕМ ЖЕ opId (идемпотентность);
 *     всего до `commandRepostAttempts` повторных POST.
 * Каждый шаг повтора отдаётся в `onRetry` (событие command-retry).
 */
export async function sendCommandWithRetry(
  docId: string,
  cmd: CommandRequest,
  onRetry?: (detail: Record<string, unknown>) => void,
): Promise<CommandResult> {
  let lastError: unknown = null;
  for (let post = 0; post <= ADAPTER_SETTINGS.commandRepostAttempts; post += 1) {
    if (post > 0) {
      onRetry?.({ opId: cmd.opId, via: 'repost', attempt: post, reason: describe(lastError) });
    }
    try {
      return await postCommand(docId, cmd);
    } catch (e) {
      if (isDefinitiveError(e)) throw e;
      lastError = e;
    }
    // Неопределённый результат: проверяем журнал операций.
    for (let poll = 0; poll < ADAPTER_SETTINGS.commandPollAttempts; poll += 1) {
      await sleep(ADAPTER_SETTINGS.commandPollDelayMs(poll));
      onRetry?.({ opId: cmd.opId, via: 'poll', attempt: poll + 1, reason: describe(lastError) });
      try {
        const status = await getOperation(cmd.opId);
        if (status.status === 'done') return status.result;
      } catch (e) {
        if (isApiError(e, 'not_found')) break; // операции нет — нужен повторный POST
        if (isDefinitiveError(e)) throw e;
        lastError = e; // сеть всё ещё недоступна — продолжаем опрос
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('command failed: indeterminate result');
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
