import type { PageResponse } from '@stand/shared';
import { getPage, isAbortError, isDefinitiveError } from '../api';
import type { DocState } from './doc-state';
import { ADAPTER_SETTINGS } from './types';

export class StaleReadError extends Error {
  constructor(pageId: string, got: number, required: number) {
    super(`stale read of page ${pageId}: revision ${got} < required ${required}`);
    this.name = 'StaleReadError';
  }
}

/**
 * Одно чтение страницы с проверкой актуальности ревизии (общая для H и Q политика):
 * ответ с ревизией старее требуемой (ответ «старого чтения», пришедший после команды) отбрасывается
 * и страница перечитывается — до `staleReadRereads` раз. Возвращаемый снимок несёт эффективную ревизию.
 */
export async function readPageFresh(
  docId: string,
  pageId: string,
  doc: DocState,
  signal?: AbortSignal,
): Promise<PageResponse> {
  let lastGot = -1;
  for (let attempt = 0; attempt <= ADAPTER_SETTINGS.staleReadRereads; attempt += 1) {
    const resp = await getPage(docId, pageId, signal);
    doc.noteRevision(resp.revision);
    const eff = doc.effectiveRevision(pageId, resp.revision);
    if (eff !== null) {
      return eff === resp.revision ? resp : { ...resp, revision: eff };
    }
    lastGot = resp.revision;
  }
  throw new StaleReadError(pageId, lastGot, doc.requiredRevision(pageId));
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Повторы чтения при сетевой ошибке / 5xx (для H; в Q ту же политику выполняет `retry` TanStack). */
export async function withReadRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e) || isDefinitiveError(e) || e instanceof StaleReadError) throw e;
      if (attempt >= ADAPTER_SETTINGS.readRetry) throw e;
      await sleep(ADAPTER_SETTINGS.readRetryDelayMs(attempt), signal);
      attempt += 1;
    }
  }
}

/** Политика retry для TanStack Query, эквивалентная `withReadRetry`. */
export function queryRetry(failureCount: number, error: unknown): boolean {
  if (isDefinitiveError(error) || error instanceof StaleReadError) return false;
  return failureCount < ADAPTER_SETTINGS.readRetry;
}

export function queryRetryDelay(failureCount: number): number {
  return ADAPTER_SETTINGS.readRetryDelayMs(failureCount);
}
