/**
 * Настройки адаптера Z и машинный снимок ВСЕХ настроек адаптеров для паспорта серии.
 *
 * Z_SETTINGS живёт здесь, а не в `z.ts`, чтобы его можно было импортировать без клиента Zero
 * (`z.ts` тянет `@rocicorp/zero` и схему сервера): сборка клиента эмитит `dist/adapter-settings.json`
 * из этого модуля (`vite.config.ts`), а `packages/bench/src/series/passport.mjs` пишет его в
 * `passport.json → adapters` (docs/PASSPORT.md §2.1, ключ помечен как обязательный).
 */
import { ADAPTER_SETTINGS } from './types';

/** Настройки адаптера Z (фиксируются в docs/PASSPORT). */
export const Z_SETTINGS = {
  /** kvStore Zero: 'idb' — постоянное хранилище IndexedDB (учитывается в client_storage_bytes) */
  kvStore: 'idb' as const,
  /** ttl запросов страниц и документа: 'none' — после destroy() строки покидают клиентское хранилище */
  ttl: 'none' as const,
  /** параллелизм материализации страниц в режиме F (как fullLoadConcurrency у H/Q) */
  fullLoadConcurrency: ADAPTER_SETTINGS.fullLoadConcurrency,
  /** уровень логов клиента Zero */
  logLevel: 'error' as const,
  /** P: задержки повторного пересчёта retained после destroy() (строки удаляются сервером асинхронно, ~0.1–0.25 с) */
  retainedRecheckDelaysMs: [150, 450] as const,
  /** F: пересчёт (скан 25 000 строк ≈ 0.3 с main-thread) откладывается, пока идут изменения (trailing debounce) */
  retainedDebounceMs: 300,
  /** query-параметр с адресом zero-cache (по умолчанию `${location.origin}/zero` — через шейпер/Caddy) */
  cacheUrlParam: 'zero',
  /**
   * Оптимистичная (клиентская) реализация мутатора в ИЗМЕРЯЕМОМ пути.
   *
   * `false` (умолчание стенда): клиентская часть мутатора — пустая функция, локальные строки не
   * перекрашиваются, и каждая новая заливка в хранилище приходит ТОЛЬКО от сервера. Тогда
   * содержательный критерий готовности (`rowsReflect`) связывает, а `command-synced` /
   * `command-drawn` относятся к серверным данным, а не к собственной оптимистичной записи
   * клиента (закрытие N1). §1.6 прямо допускает серверную реализацию команды, отличную от
   * предварительного локального действия, и запрещает считать команду завершённой по нему.
   *
   * `true` (query-параметр `?zopt=1`) возвращает штатную оптимистичную окраску Zero — для
   * отдельных проверок и демонстрации; в основной серии не используется.
   */
  optimistic: false,
  /** query-параметр включения оптимистичного мутатора */
  optimisticParam: 'zopt',
} as const;

/**
 * JSON-снимок настроек адаптеров для паспорта: функции задержек разворачиваются в фактические
 * последовательности, иначе `JSON.stringify` выбросил бы их молча и паспорт врал бы о повторах.
 */
export function adapterSettingsSnapshot(): Record<string, unknown> {
  const a = ADAPTER_SETTINGS;
  return {
    generatedFrom: ['packages/client/src/adapters/types.ts → ADAPTER_SETTINGS', 'packages/client/src/adapters/settings.ts → Z_SETTINGS'],
    ADAPTER_SETTINGS: {
      fullLoadConcurrency: a.fullLoadConcurrency,
      readRetry: a.readRetry,
      // 500·2^n, n = 0..readRetry-1
      readRetryDelayMs: Array.from({ length: a.readRetry }, (_, i) => a.readRetryDelayMs(i)),
      staleReadRereads: a.staleReadRereads,
      commandPollAttempts: a.commandPollAttempts,
      commandPollDelayMs: Array.from({ length: a.commandPollAttempts }, (_, i) => a.commandPollDelayMs(i)),
      commandRepostAttempts: a.commandRepostAttempts,
      query: { ...a.query, staleTime: a.query.staleTime === Number.POSITIVE_INFINITY ? 'Infinity' : a.query.staleTime },
    },
    Z_SETTINGS: { ...Z_SETTINGS, retainedRecheckDelaysMs: [...Z_SETTINGS.retainedRecheckDelaysMs] },
  };
}
