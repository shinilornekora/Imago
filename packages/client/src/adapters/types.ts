import type {
  CommandRequest,
  CommandResult,
  DocumentMeta,
  PageSnapshot,
  RetainedStats,
} from '@stand/shared';

export type Unsubscribe = () => void;

/** Явно заданная начальная страница: pageId либо 1‑based индекс (`?page=`, SPEC §4). */
export type InitialPage = string | number | null | undefined;

/**
 * Единственное место, где «начальная страница» превращается в pageId: и оболочка
 * (`StandController.openDocument` → `selectPage`), и адаптер (`open` → приоритет в F) обязаны
 * получить ОДИН и тот же ответ, иначе в F приоритет достанется не той странице (критик A, п. 16).
 * Строка — pageId (или десятичный индекс строкой), число — индекс страницы; иначе — минимальный индекс.
 */
export function resolveInitialPageId(pages: DocumentMeta['pages'], want: InitialPage): string | null {
  const byIndex = [...pages].sort((a, b) => a.index - b.index);
  const first = byIndex[0]?.id ?? null;
  if (want === null || want === undefined || want === '') return first;
  if (typeof want === 'string') {
    const byId = pages.find((p) => p.id === want);
    if (byId) return byId.id;
    const n = Number.parseInt(want, 10);
    if (Number.isFinite(n)) return pages.find((p) => p.index === n)?.id ?? first;
    return first;
  }
  return pages.find((p) => p.index === want)?.id ?? first;
}

/**
 * Хуки выполнения команды. Каждый момент фиксируется отдельно (§1.8): стоимость протокола
 * подтверждения не должна попадать в «команду до актуального холста».
 */
export interface CommandHooks {
  /** Z: оптимистичная (клиентская) часть мутатора применена. У H/Q не вызывается. */
  onClient?: () => void;
  /**
   * Транспорт подтвердил мутацию: Z — `mutate().server` (zero-cache/API приняли мутацию),
   * H/Q — получен ответ POST. Без чтения журнала операций; `command-server`.
   */
  onServer?: (detail: { via: 'http-post' | 'zero-server' }) => void;
  /** сервер подтвердил команду и её результат известен (command-acked) */
  onAcked?: (result: CommandResult) => void;
  /**
   * Данные команды доступны в клиентском хранилище активной страницы (`command-synced`):
   * Z — синхронизированная ревизия достигла ревизии команды, H/Q — перечитывание активной
   * страницы завершено. Отрисовка ещё не выполнена.
   */
  onSynced?: () => void;
  /** журнал повторов (command-retry) */
  onRetry?: (detail: Record<string, unknown>) => void;
}

/** События адаптера для журнала стенда (не для данных). */
export interface AdapterListener {
  onPageError?: (pageId: string, error: unknown) => void;
  onPageLoadStart?: (pageId: string) => void;
}

/**
 * Общий интерфейс адаптера данных (SPEC §4.1) + `close()` и вспомогательные геттеры,
 * нужные измерительной оболочке (`window.__stand`).
 */
export interface DataAdapter {
  /**
   * Метаданные страниц; в F запускает загрузку всех страниц (активная — приоритет).
   * `initialPage` — ЯВНО заданная начальная страница (pageId или 1‑based индекс); адаптер обязан
   * поставить её первой в очередь загрузки. `undefined`/`null` — первая по индексу.
   */
  open(docId: string, initialPage?: InitialPage): Promise<DocumentMeta>;
  /** Переключение; в P — загрузка при отсутствии, LRU‑окно `cache` для неактивных. */
  selectPage(pageId: string): void;
  /** Снимок {revision, shapes} или null, пока нет полного набора. Вызывается сразу с текущим значением. */
  subscribePage(pageId: string, cb: (snap: PageSnapshot | null) => void): Unsubscribe;
  /** Команда через HTTP (H, Q) или мутатор (Z). Промис завершается после подтверждения И обновления активной страницы. */
  runCommand(cmd: CommandRequest, hooks?: CommandHooks): Promise<CommandResult>;
  /** ФАКТИЧЕСКИ удерживаемые записи во внутреннем хранилище. */
  getRetained(): RetainedStats;
  /**
   * То же со свежим подсчётом: у H/Q значение синхронное (возвращается как есть), у Z — скан реальных строк
   * клиентского хранилища, начинающийся после вызова (кеш `getRetained()` обновляется асинхронно).
   * Единый контракт для измерительной оболочки.
   */
  getRetainedAsync(): Promise<RetainedStats>;
  /** Очистка памяти и постоянного хранилища. */
  logout(): Promise<void>;
  /** Остановка адаптера (отмена запросов, отписки) без очистки постоянного хранилища. */
  close(): void;

  // --- вспомогательное (для window.__stand и интерфейса) ---
  /** Текущий полный снимок страницы из хранилища (без сетевых запросов) или null. */
  getPageSnapshot(pageId: string): PageSnapshot | null;
  /** Страницы, для которых в хранилище есть полный набор фигур. */
  getLoadedPages(): string[];
  /** Последняя известная ревизия документа (из чтений/команд/метаданных) или null до open. */
  getDocRevision(): number | null;
  /** Перечитать метаданные документа (обновляет известную ревизию). */
  refreshMeta(): Promise<DocumentMeta>;
  /** Метаданные открытого документа. */
  getMeta(): DocumentMeta | null;
  setListener(listener: AdapterListener | null): void;
}

/**
 * СИНТЕТИЧЕСКАЯ константа «байт на фигуру» для `RetainedStats.bytesEstimate`: одинаковая для всех
 * адаптеров и НЕ измерение памяти (реальное представление строк у `Map`, `queryCache` и b-tree Zero
 * различается в разы). Не выгружается в `runs.csv`; в записи прогона — `retained_bytes_synthetic`.
 * Память клиента измеряется только `chromium_private_*`, `js_heap_*` и `client_storage_bytes`.
 */
export const SHAPE_BYTES_ESTIMATE = 200;

/** Настройки, общие для адаптеров (фиксируются в docs/PASSPORT). */
export const ADAPTER_SETTINGS = {
  /** параллелизм загрузки страниц в режиме F (H и Q одинаково) */
  fullLoadConcurrency: 4,
  /** число повторов чтения страницы при сетевой ошибке / 5xx (H — своя петля, Q — retry TanStack) */
  readRetry: 2,
  /** задержка между повторами чтения, мс: 500·2^attempt */
  readRetryDelayMs: (attempt: number): number => Math.min(500 * 2 ** attempt, 4000),
  /** сколько раз перечитать страницу, если сервер вернул ревизию старее требуемой */
  staleReadRereads: 3,
  /** команды: опросов GET /api/operations/:opId после неопределённого ответа */
  commandPollAttempts: 3,
  commandPollDelayMs: (attempt: number): number => 300 * 2 ** attempt,
  /** команды: повторных POST с тем же opId */
  commandRepostAttempts: 2,
  /** TanStack Query (Q) */
  query: {
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60 * 1000,
    retry: 2,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    networkMode: 'always' as const,
    /** без глубокого сравнения 500–1000 фигур на каждый ответ */
    structuralSharing: false,
  },
} as const;
