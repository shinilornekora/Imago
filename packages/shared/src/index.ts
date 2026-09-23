/**
 * Общие типы и протокол стенда (SPEC §1, §2, §4).
 * Единственный источник контрактов для сервера, клиента, генератора и измерительной оболочки.
 */

export type ShapeKind = 'rect' | 'ellipse' | 'text';

export interface Shape {
  id: string;
  documentId: string;
  pageId: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  text: string | null;
  /** #rrggbb */
  fill: string;
  isSource: boolean;
  sourceId: string | null;
  fillOverridden: boolean;
}

export interface PageMeta {
  id: string;
  index: number;
  name: string;
}

export interface DocumentMeta {
  id: string;
  name: string;
  revision: number;
  pages: PageMeta[];
}

export interface DocumentListItem {
  id: string;
  name: string;
  revision: number;
  pageCount: number;
  shapeCount: number;
}

/** Ответ GET /api/documents/:docId/pages/:pageId — согласованный снимок страницы. */
export interface PageResponse {
  documentId: string;
  pageId: string;
  revision: number;
  shapes: Shape[];
}

export type CommandType = 'setSourceFill' | 'setLocalFill';

export interface CommandRequest {
  opId: string;
  type: CommandType;
  targetId: string;
  fill: string;
  expectedRevision: number;
}

export interface CommandResult {
  opId: string;
  revision: number;
  affectedPages: string[];
  affectedShapes: number;
}

export interface OperationStatus {
  opId: string;
  status: 'done';
  result: CommandResult;
}

export interface LoginRequest {
  login: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  userId: string;
  /** секунды */
  expiresIn: number;
}

export interface ApiError {
  error:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'revision_mismatch'
    | 'op_conflict'
    | 'bad_request'
    | 'internal';
  message: string;
  /** для revision_mismatch — текущая ревизия документа */
  currentRevision?: number;
}

/** Конфигурация клиента (query‑параметры, SPEC §4). */
export type AdapterKind = 'H' | 'Q' | 'Z';
export type LoadMode = 'F' | 'P';

export interface StandConfig {
  adapter: AdapterKind;
  mode: LoadMode;
  /** окно кеша неактивных страниц в режиме P */
  cache: number;
  docId: string;
  /**
   * Начальная страница (`?page=`): индекс (1‑based, как `data-page-index`) либо pageId.
   * `null` — первая по индексу. Задаётся ЯВНО и передаётся адаптеру в `open()`, поэтому приоритет
   * активной страницы в режиме F не зависит от совпадения «стартовая страница = минимальный index».
   */
  initialPage: number | string | null;
}

/** Снимок страницы, который адаптер отдаёт интерфейсу и измерительной оболочке. */
export interface PageSnapshot {
  pageId: string;
  revision: number;
  shapes: Shape[];
}

export interface RetainedStats {
  pages: number;
  shapes: number;
  /**
   * СИНТЕТИЧЕСКАЯ оценка `shapes × 200 Б`, а не измерение памяти: одинаковая константа для всех
   * адаптеров, не зависящая ни от представления строк, ни от накладных расходов движка.
   * В `runs.csv` НЕ выгружается; в записи прогона публикуется под именем `retained_bytes_synthetic`
   * (packages/analysis/COLUMNS.md). Память клиента измеряется `chromium_private_*` и `js_heap_*`.
   */
  bytesEstimate?: number;
}

/**
 * Моменты жизни команды в часах страницы (`performance.now()`), SPEC §7.3.
 * Разделение нужно, чтобы отделить стоимость протокола (у Z — чтение журнала операций)
 * от момента фактического обновления холста (§1.8: «время отсчитывается до фактического
 * обновления холста, подтверждение сервера регистрируется отдельно»).
 */
export interface CommandTiming {
  opId: string;
  type: CommandType;
  targetId: string;
  /** ожидаемая ревизия документа, отправленная серверу */
  expectedRevision: number;
  /** ревизия, которую команда обязана дать: expectedRevision + 1 (единственный писатель, §2.3) */
  targetRevision: number;
  /** вызов runCommand */
  sentAt: number;
  /** Z: оптимистичная (клиентская) часть мутатора применена; H/Q — null */
  clientAt: number | null;
  /** транспорт подтвердил мутацию: Z — `.server`, H/Q — ответ POST (без чтения журнала операций) */
  serverAt: number | null;
  /** результат операции известен (revision/affectedPages): Z — после GET /api/operations/:opId */
  ackedAt: number | null;
  /** данные команды в клиентском хранилище активной страницы (Z — синхронизация, H/Q — перечитывание) */
  syncedAt: number | null;
  /** активная страница ОТРИСОВАНА с данными команды (может быть раньше ackedAt) */
  drawnAt: number | null;
  /** ackedAt − serverAt: накладные расходы протокола подтверждения (у H/Q ≈ 0) */
  opGetMs: number | null;
  error: string | null;
}

export type StandEventType =
  | 'open'
  | 'page-select'
  | 'page-ready'
  | 'command-sent'
  | 'command-server'
  | 'command-synced'
  | 'command-acked'
  | 'command-drawn'
  | 'command-retry'
  | 'error'
  | 'logout';

export interface StandEvent {
  /** performance.now() */
  t: number;
  type: StandEventType;
  detail?: Record<string, unknown>;
}

/** Контракт готовности window.__stand (SPEC §4.2). */
export interface StandGlobal {
  config: StandConfig;
  state: 'idle' | 'loading' | 'ready' | 'error';
  activePageId: string | null;
  activeRevision: number | null;
  drawn: { pageId: string; revision: number; shapeCount: number; at: number } | null;
  pendingCommands: number;
  events: StandEvent[];
  waitFor(
    type: StandEventType,
    predicate?: (e: StandEvent) => boolean,
    timeoutMs?: number,
  ): Promise<StandEvent>;
  selectPage(pageId: string): void;
  runCommand(cmd: Omit<CommandRequest, 'expectedRevision' | 'opId'> & { opId?: string }): Promise<CommandResult>;
  getRetained(): RetainedStats;
  /** То же, но с гарантированно свежим подсчётом (Z: скан хранилища начинается после вызова; H/Q — синхронное значение). */
  getRetainedAsync(): Promise<RetainedStats>;
  getPageSnapshot(pageId: string): { revision: number; shapes: Array<{ id: string; fill: string; fillOverridden: boolean }> } | null;
  getLoadedPages(): string[];
  /** Моменты всех команд прогона (sent/client/server/synced/acked/drawn) — сырые данные для анализа. */
  getCommandTimings(): CommandTiming[];
  logout(): Promise<void>;
}

/** Общие константы протокола. */
export const API_PREFIX = '/api';
export const ZERO_PATH = '/zero';
export const OPERATION_TTL_HOURS = 24;
export const TOKEN_TTL_SECONDS = 15 * 60;
export const TEST_USERS = [
  { id: 'u-alice', login: 'alice', password: 'alice-pass' },
  { id: 'u-bob', login: 'bob', password: 'bob-pass' },
] as const;

export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
