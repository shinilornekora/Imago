import type {
  CommandRequest,
  CommandResult,
  DocumentMeta,
  LoadMode,
  PageSnapshot,
  RetainedStats,
  Shape,
} from '@stand/shared';
import { ZERO_PATH } from '@stand/shared';
import { dropAllDatabases, Zero, type TypedView } from '@rocicorp/zero';
import { defineMutatorWithType, defineMutatorsWithType } from '@rocicorp/zero';
import { ApiHttpError, getDocument, getOperation, isApiError, isDefinitiveError } from '../api';
import { getToken, getUserId } from '../auth';
import { DocState } from './doc-state';
import { createLimiter } from './limiter';
import { ADAPTER_SETTINGS, SHAPE_BYTES_ESTIMATE, resolveInitialPageId } from './types';
import { Z_SETTINGS } from './settings';
import type { AdapterListener, CommandHooks, DataAdapter, InitialPage, Unsubscribe } from './types';
// Единый модуль Zero-схемы (таблицы, synced queries, мутаторы) — исходник сервера, см. комментарий в нём.
import {
  fillArgs,
  mutators as optimisticMutators,
  queries,
  schema,
  type DocumentRow,
  type ShapeRow,
  type ZeroCtx,
  type ZeroSchema,
} from '../../../server/src/zero/schema';

/**
 * Мутаторы БЕЗ клиентской реализации (server-authoritative): имена и валидаторы те же, что у
 * серверного реестра, поэтому мутация ставится в очередь и уходит на push-обработчик API, но
 * локальные строки клиента не перекрашиваются.
 *
 * Зачем (N1): при оптимистичной окраске предикат `rowsReflect` удовлетворялся записью САМОГО
 * клиента — ровно те строки и ровно тот цвет, — поэтому содержательный критерий готовности не
 * связывал, а фактическим признаком оставалась ревизия строки `documents`. Без клиентской
 * реализации каждая новая заливка в хранилище имеет ровно один источник — синхронизацию с
 * сервера, и `t_cmd_synced` / `t_cmd_drawn` измеряют приход СЕРВЕРНЫХ данных.
 * §1.6: «API Zero допускает серверную реализацию команды, отличающуюся от локального
 * предварительного действия… массовая команда не объявляется завершённой по предварительной
 * окраске видимых фигур». Цена — в измеряемом пути нет мгновенного локального отклика Zero;
 * зафиксировано в packages/client/README.md.
 */
const serverAuthoritativeMutators = (() => {
  const defineMutator = defineMutatorWithType<ZeroSchema, ZeroCtx>();
  const defineMutators = defineMutatorsWithType<ZeroSchema>();
  // валидация аргументов — та же (fillArgs); тело клиентской части пустое и идемпотентно при rebase
  const noClientImpl = () => defineMutator(fillArgs, async () => undefined);
  return defineMutators({ setSourceFill: noClientImpl(), setLocalFill: noClientImpl() });
})();

/** Оптимистичная окраска включается только явным `?zopt=1` (см. Z_SETTINGS.optimistic). */
function optimisticEnabled(): boolean {
  const q = new URLSearchParams(window.location.search).get(Z_SETTINGS.optimisticParam);
  if (q === null) return Z_SETTINGS.optimistic;
  return q === '1' || q.toLowerCase() === 'true';
}

type Subscriber = (snap: PageSnapshot | null) => void;
type ZeroClient = Zero<ZeroSchema, undefined, ZeroCtx>;
type ShapesView = TypedView<ReadonlyArray<ShapeRow>>;
type DocView = TypedView<ReadonlyArray<DocumentRow>>;
type ResultType = 'unknown' | 'complete' | 'error';

// Z_SETTINGS вынесены в ./settings, чтобы сборка клиента могла собрать паспортный снимок настроек
// адаптеров без загрузки клиента Zero (docs/PASSPORT.md §2.1, ключ `adapters`).
export { Z_SETTINGS };

/**
 * Запись страницы: materialized view synced query `shapesByPage` с ttl 'none'.
 * `complete` — сервер подтвердил полный набор (resultType 'complete'); до этого снимка нет
 * (SPEC §4.2: результат 'unknown' готовностью не считается).
 */
interface PageEntry {
  pageId: string;
  view: ShapesView | null;
  off: (() => void) | null;
  complete: boolean;
  rows: ReadonlyArray<ShapeRow>;
  /** снимок для интерфейса; объект меняется только вместе со строками или ревизией */
  snapshot: PageSnapshot | null;
  error: unknown;
  /** F: задача ограничителя (ожидание complete) */
  loading: Promise<void> | null;
}

/** Диагностика последней команды (не часть контракта __stand): моменты в performance.now(). */
export interface ZCommandTiming {
  opId: string;
  sentAt: number;
  /** .client разрешился (оптимистичная транзакция применена) */
  clientAt: number | null;
  /** .server разрешился (zero-cache/API подтвердили мутацию) */
  serverAt: number | null;
  /** результат операции получен по HTTP (GET /api/operations/:opId) → command-acked */
  ackedAt: number | null;
  /** синхронизированная ревизия документа достигла ревизии команды */
  syncedAt: number | null;
  /** снимок АКТИВНОЙ страницы достиг ревизии команды (содержимое проверено) */
  activeSyncedAt: number | null;
  error: string | null;
}

/**
 * Ожидаемый эффект нашей команды на СОДЕРЖИМОМ страницы (§1.2: «для синхронизируемых данных —
 * фактическое содержимое полученной страницы»). Строки Zero не несут ревизии, поэтому страница
 * считается актуальной на ревизию команды только тогда, когда её строки уже отражают команду.
 */
interface PendingEffect {
  opId: string;
  type: CommandRequest['type'];
  targetId: string;
  fill: string;
  /** ревизия, которую даёт команда: expectedRevision + 1 */
  targetRevision: number;
}

function cacheUrl(): string {
  const q = new URLSearchParams(window.location.search).get(Z_SETTINGS.cacheUrlParam);
  if (q) return q;
  return `${window.location.origin}${ZERO_PATH}`;
}

/** Ошибка мутатора (details из ApplicationError сервера) → те же коды/тип, что у HTTP (ApiHttpError). */
function mutatorErrorToApiError(error: { type: 'app' | 'zero'; message: string; details?: unknown }): Error {
  if (error.type === 'app') {
    const d = (error.details ?? {}) as { code?: string; status?: number; message?: string; currentRevision?: number };
    const status = typeof d.status === 'number' ? d.status : 400;
    const code = (d.code ?? 'bad_request') as ApiHttpError['code'];
    return new ApiHttpError(status, { error: code, message: d.message ?? error.message, currentRevision: d.currentRevision }, error.message);
  }
  return new Error(`zero: ${error.message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Адаптер Z: @rocicorp/zero 1.9.0 (SPEC §4.1).
 *  - метаданные документа — HTTP `GET /api/documents/:id` (тот же путь, что у H/Q);
 *  - ревизия документа — синхронизируемый запрос `docMeta` (строка documents), materialized, ttl 'none';
 *  - страница — materialized `shapesByPage(docId, pageId)`, ttl 'none'; снимок страницы появляется только
 *    при resultType 'complete' и несёт СИНХРОНИЗИРОВАННУЮ ревизию документа, НО не выше, чем позволяет
 *    её собственное содержимое: пока строки страницы не отражают наши неподтверждённые содержимым
 *    команды (`pendingEffects`, §1.2 «фактическое содержимое полученной страницы»), ревизия снимка
 *    удерживается на `targetRevision − 1`;
 *  - F: все страницы материализуются (активная — первой, далее через ограничитель параллелизма 4) и остаются;
 *  - P: активная + LRU-окно `cache`; вытесненные view уничтожаются (`destroy()`, ttl 'none' → строки уходят
 *    из хранилища за ~0.1–0.2 с), что видно через `getRetained()`;
 *  - команда — `zero.mutate(mutators.setSourceFill(...))`: `.server` (успех, `command-server`) →
 *    `GET /api/operations/:opId` (протокол Zero не возвращает результат мутатора) → `command-acked`.
 *    `command-drawn` НЕ ждёт ack: он фиксируется, когда активная страница отрисована со снимком ревизии
 *    ≥ `expectedRevision + 1` (содержимое проверено, см. выше), поэтому у Z drawn обычно РАНЬШЕ ack на
 *    время чтения журнала операций;
 *  - клиентская (оптимистичная) часть мутатора в измеряемом пути ОТКЛЮЧЕНА
 *    (`serverAuthoritativeMutators`, см. выше и `Z_SETTINGS.optimistic`): новые заливки попадают в
 *    хранилище только синхронизацией с сервера, поэтому содержательный критерий готовности связывает;
 *  - `getRetained()` — РЕАЛЬНЫЕ строки клиентского хранилища (`zero.inspector.client.rows('shapes')`),
 *    значение кешируется и пересчитывается асинхронно (см. `getRetainedAsync`).
 */
export class ZAdapter implements DataAdapter {
  private zero: ZeroClient | null = null;
  private readonly pages = new Map<string, PageEntry>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly doc = new DocState();
  private readonly limiter = createLimiter(Z_SETTINGS.fullLoadConcurrency);
  private meta: DocumentMeta | null = null;
  private docId = '';
  private activePageId: string | null = null;
  private recent: string[] = [];
  private listener: AdapterListener | null = null;
  private docView: DocView | null = null;
  private docViewOff: (() => void) | null = null;
  /** ревизия документа из синхронизированных данных (строка documents), null — ещё не пришла */
  private syncedRevision: number | null = null;
  private retained: RetainedStats = { pages: 0, shapes: 0, bytesEstimate: 0 };
  private retainedRefresh: Promise<RetainedStats> | null = null;
  private retainedDirty = false;
  private retainedTimers: ReturnType<typeof setTimeout>[] = [];
  private retainedDebounce: ReturnType<typeof setTimeout> | null = null;
  private connectionOff: (() => void) | null = null;
  private generation = 0;
  /** диагностика команд (последние 50) */
  readonly commandTimings: ZCommandTiming[] = [];
  /** команды, чей эффект ещё не подтверждён содержимым всех полных страниц (обычно 0 или 1) */
  private readonly pendingEffects: PendingEffect[] = [];
  /** ожидания «снимок активной страницы достиг ревизии r» (для onSynced) */
  private activeWaiters: Array<{ revision: number; resolve: () => void }> = [];
  /** включена ли оптимистичная клиентская часть мутатора (в измеряемом пути — нет, см. выше) */
  readonly optimistic = optimisticEnabled();
  /** реестр мутаторов: без клиентской реализации (умолчание) либо штатный оптимистичный */
  private readonly mutators = optimisticEnabled() ? optimisticMutators : (serverAuthoritativeMutators as typeof optimisticMutators);

  constructor(
    private readonly mode: LoadMode,
    private readonly cacheWindow: number,
  ) {}

  setListener(listener: AdapterListener | null): void {
    this.listener = listener;
  }

  /** Экземпляр Zero (для проверок), null до open(). */
  getZero(): ZeroClient | null {
    return this.zero;
  }

  getSyncedRevision(): number | null {
    return this.syncedRevision;
  }

  // ---------------------------------------------------------------- DataAdapter

  async open(docId: string, initialPage?: InitialPage): Promise<DocumentMeta> {
    this.docId = docId;
    const meta = await getDocument(docId); // права: чужой документ → 403 здесь же, как у H/Q
    this.meta = meta;
    this.doc.noteRevision(meta.revision);
    const gen = (this.generation += 1);

    const userID = getUserId();
    const auth = getToken();
    if (!userID || !auth) throw new Error('not authenticated');
    const zero = new Zero<ZeroSchema, undefined, ZeroCtx>({
      cacheURL: cacheUrl(),
      userID,
      auth,
      schema,
      mutators: this.mutators,
      context: { userID },
      kvStore: Z_SETTINGS.kvStore,
      logLevel: Z_SETTINGS.logLevel,
      // по умолчанию оба вызывают location.reload() — недопустимо во время измерений
      onUpdateNeeded: (reason) => this.reportError(`zero: update needed (${reason.type}${reason.message ? `: ${reason.message}` : ''})`),
      onClientStateNotFound: () => this.reportError('zero: client state not found'),
    });
    this.zero = zero;
    this.connectionOff = zero.connection.state.subscribe((s) => {
      if (s.name === 'error' || s.name === 'needs-auth') {
        this.reportError(`zero connection ${s.name}: ${typeof s.reason === 'string' ? s.reason : JSON.stringify(s.reason)}`);
      }
    });

    // Ревизия документа синхронизацией (та же пока, что и изменения строк → согласованные снимки).
    const docView = zero.materialize(queries.docMeta({ documentId: docId }), { ttl: Z_SETTINGS.ttl }) as DocView;
    this.docView = docView;
    this.docViewOff = docView.addListener((rows, type) => {
      if (this.generation !== gen) return;
      this.onDocView(rows, type as ResultType);
    });

    if (this.mode === 'F') {
      const order = [...meta.pages].sort((a, b) => a.index - b.index).map((p) => p.id);
      // приоритет активной страницы задаётся ЯВНО (§1.6), а не совпадением с минимальным индексом
      const initialPageId = resolveInitialPageId(meta.pages, initialPage);
      if (initialPageId && order.includes(initialPageId)) {
        order.splice(order.indexOf(initialPageId), 1);
        order.unshift(initialPageId);
      }
      // все страницы через ограничитель параллелизма; активная — первой в очереди
      for (const pid of order) this.ensurePage(pid);
    }
    return meta;
  }

  getMeta(): DocumentMeta | null {
    return this.meta;
  }

  async refreshMeta(): Promise<DocumentMeta> {
    const meta = await getDocument(this.docId);
    this.meta = meta;
    this.doc.noteRevision(meta.revision);
    return meta;
  }

  getDocRevision(): number | null {
    return this.doc.revision;
  }

  selectPage(pageId: string): void {
    if (!this.meta || !this.zero) throw new Error('document is not open');
    const prev = this.activePageId;
    this.activePageId = pageId;
    this.touchRecent(pageId);

    if (this.mode === 'P' && prev && prev !== pageId) {
      // отмена незавершённой загрузки прежней активной страницы (как abort у H): view без полного набора уничтожается
      const pe = this.pages.get(prev);
      if (pe && !pe.complete) this.evict(prev);
      this.enforceWindow();
    }
    this.ensurePage(pageId);
    if (this.mode === 'F') this.limiter.prioritize(pageId);
  }

  subscribePage(pageId: string, cb: Subscriber): Unsubscribe {
    let set = this.subscribers.get(pageId);
    if (!set) {
      set = new Set();
      this.subscribers.set(pageId, set);
    }
    set.add(cb);
    cb(this.pages.get(pageId)?.snapshot ?? null);
    return () => {
      const s = this.subscribers.get(pageId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.subscribers.delete(pageId);
    };
  }

  async runCommand(cmd: CommandRequest, hooks?: CommandHooks): Promise<CommandResult> {
    const zero = this.zero;
    if (!zero) throw new Error('document is not open');
    const timing: ZCommandTiming = {
      opId: cmd.opId,
      sentAt: performance.now(),
      clientAt: null,
      serverAt: null,
      ackedAt: null,
      syncedAt: null,
      activeSyncedAt: null,
      error: null,
    };
    this.commandTimings.push(timing);
    if (this.commandTimings.length > 50) this.commandTimings.splice(0, this.commandTimings.length - 50);

    const args = {
      opId: cmd.opId,
      documentId: this.docId,
      targetId: cmd.targetId,
      fill: cmd.fill,
      expectedRevision: cmd.expectedRevision,
    };
    const targetRevision = cmd.expectedRevision + 1;
    // Ожидаемый эффект на содержимом страниц: пока он не подтверждён строками, снимок страницы
    // НЕ получает ревизию ≥ targetRevision, даже если строка documents её уже принесла (§1.2).
    const effect: PendingEffect = { opId: cmd.opId, type: cmd.type, targetId: cmd.targetId, fill: cmd.fill, targetRevision };
    this.pendingEffects.push(effect);
    if (this.pendingEffects.length > 20) this.pendingEffects.splice(0, this.pendingEffects.length - 20);

    const mr = cmd.type === 'setSourceFill' ? zero.mutate(this.mutators.setSourceFill(args)) : zero.mutate(this.mutators.setLocalFill(args));
    void mr.client.then(() => {
      timing.clientAt = performance.now();
      hooks?.onClient?.();
    });
    // «синхронизировано» — по достижению ревизии команды в docMeta (та же пока несёт и строки)
    const synced = this.waitSyncedRevision(targetRevision);
    const syncedP = synced.promise.then(() => {
      timing.syncedAt = performance.now();
    });
    // «данные команды в хранилище активной страницы» — снимок активной страницы (содержимое проверено)
    void this.waitActiveRevision(targetRevision).then(() => {
      if (timing.activeSyncedAt === null) {
        timing.activeSyncedAt = performance.now();
        hooks?.onSynced?.();
      }
    });

    const server = await mr.server; // никогда не отклоняется: {type:'success'} | {type:'error', error}
    timing.serverAt = performance.now();
    if (server.type === 'error') {
      synced.cancel();
      void syncedP.catch(() => undefined);
      this.dropEffect(effect);
      const err = mutatorErrorToApiError(server.error);
      timing.error = err.message;
      throw err;
    }
    hooks?.onServer?.({ via: 'zero-server' });

    // Результат операции (revision, affectedPages, affectedShapes): протокол Zero его не возвращает —
    // читаем журнал операций тем же маршрутом, что и H/Q после неопределённого ответа.
    let result: CommandResult;
    try {
      result = await this.fetchOperationResult(cmd, hooks);
    } catch (e) {
      this.dropEffect(effect);
      throw e;
    }
    timing.ackedAt = performance.now();
    this.doc.noteCommand(result);
    hooks?.onAcked?.(result);

    // Промис завершается после подтверждения И обновления активной страницы серверными данными:
    // синхронизированная ревизия ≥ ревизии команды (снимок активной страницы переиздаётся с ней).
    await syncedP;
    this.scheduleRetainedRefresh(false, true);
    return result;
  }

  /** Снять ожидаемый эффект (ошибка команды либо он подтверждён всеми полными страницами). */
  private dropEffect(effect: PendingEffect): void {
    const i = this.pendingEffects.indexOf(effect);
    if (i >= 0) this.pendingEffects.splice(i, 1);
  }

  getRetained(): RetainedStats {
    return this.retained;
  }

  /** Свежий подсчёт реальных строк клиентского хранилища Zero (обновляет кеш `getRetained()`): скан начинается ПОСЛЕ вызова. */
  async getRetainedAsync(): Promise<RetainedStats> {
    if (this.retainedRefresh) await this.retainedRefresh.catch(() => undefined);
    return this.refreshRetained();
  }

  getPageSnapshot(pageId: string): PageSnapshot | null {
    return this.pages.get(pageId)?.snapshot ?? null;
  }

  getLoadedPages(): string[] {
    const out: string[] = [];
    for (const e of this.pages.values()) if (e.snapshot) out.push(e.pageId);
    return out;
  }

  async logout(): Promise<void> {
    const zero = this.zero;
    this.close();
    if (zero) {
      try {
        await zero.close();
      } catch {
        /* уже закрыт */
      }
      // постоянное хранилище: базы rep:zero-* (idb) — удаляем все базы Zero этого origin
      try {
        await dropAllDatabases();
      } catch {
        /* нет IndexedDB (mem) */
      }
    }
  }

  close(): void {
    this.generation += 1;
    this.limiter.clear();
    for (const t of this.retainedTimers) clearTimeout(t);
    this.retainedTimers = [];
    if (this.retainedDebounce) clearTimeout(this.retainedDebounce);
    this.retainedDebounce = null;
    const ids = [...this.pages.keys()];
    for (const e of this.pages.values()) this.destroyEntry(e);
    this.pages.clear();
    if (this.docViewOff) this.docViewOff();
    this.docViewOff = null;
    if (this.docView) {
      try {
        this.docView.destroy();
      } catch {
        /* уже уничтожен */
      }
    }
    this.docView = null;
    if (this.connectionOff) this.connectionOff();
    this.connectionOff = null;
    const zero = this.zero;
    this.zero = null;
    if (zero) void zero.close().catch(() => undefined);
    this.recent = [];
    this.activePageId = null;
    this.meta = null;
    this.docId = '';
    this.syncedRevision = null;
    this.doc.reset();
    this.retained = { pages: 0, shapes: 0, bytesEstimate: 0 };
    this.pendingEffects.length = 0;
    const waiters = this.activeWaiters;
    this.activeWaiters = [];
    for (const w of waiters) w.resolve(); // адаптер закрыт — ожидания не висят
    for (const pid of ids) this.notify(pid);
  }

  // ---------------------------------------------------------------- internals: страницы

  private touchRecent(pageId: string): void {
    const idx = this.recent.indexOf(pageId);
    if (idx >= 0) this.recent.splice(idx, 1);
    this.recent.push(pageId);
  }

  /** LRU-окно режима P: активная + `cacheWindow` последних посещённых; остальные view уничтожаются. */
  private enforceWindow(): void {
    if (this.mode !== 'P') return;
    const allowed = new Set<string>();
    if (this.activePageId) allowed.add(this.activePageId);
    for (let i = this.recent.length - 1; i >= 0 && allowed.size < this.cacheWindow + 1; i -= 1) {
      allowed.add(this.recent[i] as string);
    }
    for (const pid of [...this.pages.keys()]) {
      if (!allowed.has(pid)) this.evict(pid);
    }
    if (this.recent.length > this.cacheWindow + 8) this.recent = this.recent.slice(-(this.cacheWindow + 8));
  }

  private evict(pageId: string): void {
    const e = this.pages.get(pageId);
    if (!e) return;
    this.destroyEntry(e);
    this.pages.delete(pageId);
    this.notify(pageId);
    // destroy() + ttl 'none' → zero-cache снимает запрос, строки удаляются из клиентского хранилища асинхронно
    this.scheduleRetainedRefresh(true);
  }

  private destroyEntry(e: PageEntry): void {
    if (e.off) e.off();
    e.off = null;
    if (e.view) {
      try {
        e.view.destroy();
      } catch {
        /* уже уничтожен */
      }
    }
    e.view = null;
    e.snapshot = null;
    e.complete = false;
  }

  /** Материализация страницы (дедупликация: одна view на страницу). В F — через ограничитель параллелизма. */
  private ensurePage(pageId: string): void {
    if (this.pages.has(pageId) || !this.zero) return;
    const entry: PageEntry = { pageId, view: null, off: null, complete: false, rows: [], snapshot: null, error: null, loading: null };
    this.pages.set(pageId, entry);
    this.listener?.onPageLoadStart?.(pageId);
    if (this.mode === 'F') {
      entry.loading = this.limiter
        .run(pageId, () => this.materializePage(entry))
        .catch(() => undefined)
        .finally(() => {
          entry.loading = null;
        });
    } else {
      void this.materializePage(entry);
    }
  }

  /** Создаёт view и ждёт первого 'complete' (или ошибки); дальше view живёт до evict/close. */
  private materializePage(entry: PageEntry): Promise<void> {
    const zero = this.zero;
    if (!zero || this.pages.get(entry.pageId) !== entry) return Promise.resolve();
    const gen = this.generation;
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const view = zero.materialize(queries.shapesByPage({ documentId: this.docId, pageId: entry.pageId }), {
        ttl: Z_SETTINGS.ttl,
      }) as ShapesView;
      entry.view = view;
      // ВНИМАНИЕ: addListener вызывает слушателя синхронно с текущим состоянием ('unknown', локальные строки).
      entry.off = view.addListener((rows, type, err) => {
        if (this.generation !== gen || this.pages.get(entry.pageId) !== entry) return;
        this.onPageView(entry, rows, type as ResultType, err);
        if (type === 'complete' || type === 'error') done();
      });
    });
  }

  private onPageView(entry: PageEntry, rows: ReadonlyArray<ShapeRow>, type: ResultType, err: unknown): void {
    if (type === 'error') {
      entry.error = err;
      if (!entry.complete) {
        const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
        this.listener?.onPageError?.(entry.pageId, new Error(`zero query error: ${message}`));
        this.notify(entry.pageId);
      }
      return;
    }
    if (type !== 'complete') return; // 'unknown' — локальный/частичный результат, готовностью не считается
    const wasComplete = entry.complete;
    entry.complete = true;
    entry.error = null;
    entry.rows = rows;
    this.publish(entry);
    this.afterPublish();
    if (!wasComplete) this.scheduleRetainedRefresh();
  }

  /** Ревизия, которой помечаются снимки: синхронизированная (строка documents) либо ревизия из метаданных до неё. */
  private snapshotRevision(): number {
    return this.syncedRevision ?? this.meta?.revision ?? 0;
  }

  /**
   * Отражают ли строки страницы ожидаемый эффект команды (§1.2 — проверка СОДЕРЖИМОГО, а не ревизии).
   * Предикат повторяет серверный `updateSourceAndInstances` / `updateShapeFill`: источник и
   * непереопределённые экземпляры получают новую заливку, переопределённые не трогаются.
   * Страница, которой команда не касается, удовлетворяет предикату тривиально.
   */
  private rowsReflect(rows: ReadonlyArray<ShapeRow>, e: PendingEffect): boolean {
    if (e.type === 'setSourceFill') {
      for (const r of rows) {
        if (r.id === e.targetId) {
          if (r.fill !== e.fill) return false;
          continue;
        }
        if (r.sourceId === e.targetId && !r.fillOverridden && r.fill !== e.fill) return false;
      }
      return true;
    }
    for (const r of rows) {
      if (r.id === e.targetId && (r.fill !== e.fill || !r.fillOverridden)) return false;
    }
    return true;
  }

  /**
   * Ревизия снимка страницы. База — синхронизированная ревизия документа, но она удерживается ниже
   * ревизии команды, пока СТРОКИ этой страницы её не отражают: строка `documents` и строки `shapes`
   * приходят одной покой, однако порядок вызова слушателей внутри поки не документирован, а поздние
   * данные вообще могут прийти отдельно. Без этой проверки снимок мог бы получить новую ревизию
   * со старыми заливками (см. reviews/pass1, дефект «ревизия из строки documents»).
   */
  private revisionFor(entry: PageEntry): number {
    let revision = this.snapshotRevision();
    for (const e of this.pendingEffects) {
      if (revision >= e.targetRevision && !this.rowsReflect(entry.rows, e)) revision = e.targetRevision - 1;
    }
    return revision;
  }

  /** Новый объект снимка, если изменились строки или ревизия; уведомление подписчиков. */
  private publish(entry: PageEntry): void {
    if (!entry.complete) return;
    const revision = this.revisionFor(entry);
    const prev = entry.snapshot;
    if (prev && prev.shapes === (entry.rows as unknown as Shape[]) && prev.revision === revision) return;
    // строки Zero неизменяемы и в клиентских именах (camelCase) — совпадают с Shape по форме
    entry.snapshot = { pageId: entry.pageId, revision, shapes: entry.rows as unknown as Shape[] };
    this.notify(entry.pageId);
  }

  private onDocView(rows: ReadonlyArray<DocumentRow>, type: ResultType): void {
    if (type !== 'complete') return;
    const row = rows.find((r) => r.id === this.docId);
    if (!row) return;
    if (this.syncedRevision !== null && row.revision <= this.syncedRevision) return; // ревизия не откатывается
    this.syncedRevision = row.revision;
    this.doc.noteRevision(row.revision);
    // все полные страницы — на одной версии хранилища → переиздаём снимки с новой ревизией
    // (страницы, чьи строки ещё не отражают команду, получат её ревизию позже — revisionFor)
    for (const e of this.pages.values()) this.publish(e);
    this.afterPublish();
  }

  /** Пруним подтверждённые эффекты и будим ожидания активной страницы. */
  private afterPublish(): void {
    if (this.pendingEffects.length) {
      const synced = this.syncedRevision ?? 0;
      for (const e of [...this.pendingEffects]) {
        // Эффект, поверх которого документ уже ушёл на БОЛЕЕ НОВУЮ ревизию, проверить нельзя:
        // строки описывают более позднее состояние, `rowsReflect` для него может навсегда остаться
        // ложным (две команды по одному источнику в разные цвета) и удерживал бы ревизию ВСЕХ
        // снимков на targetRevision−1, т. е. `page-ready` не наступил бы до close() (дефект N7).
        // В измеряемом сценарии команда одна, поэтому на его числа это не влияет.
        if (synced > e.targetRevision) {
          this.dropEffect(e);
          continue;
        }
        if (synced < e.targetRevision) continue;
        let all = true;
        for (const p of this.pages.values()) {
          if (p.complete && !this.rowsReflect(p.rows, e)) {
            all = false;
            break;
          }
        }
        if (all) this.dropEffect(e);
      }
    }
    if (this.activeWaiters.length === 0) return;
    const rev = this.activeRevision();
    const ready = this.activeWaiters.filter((w) => rev >= w.revision);
    if (!ready.length) return;
    this.activeWaiters = this.activeWaiters.filter((w) => rev < w.revision);
    for (const w of ready) w.resolve();
  }

  /** Ревизия снимка активной страницы; если её нет в хранилище — синхронизированная ревизия документа. */
  private activeRevision(): number {
    const pid = this.activePageId;
    const e = pid ? this.pages.get(pid) : null;
    if (e?.snapshot) return e.snapshot.revision;
    return this.syncedRevision ?? 0;
  }

  /** Промис «снимок активной страницы на ревизии ≥ revision» (никогда не отклоняется). */
  private waitActiveRevision(revision: number): Promise<void> {
    if (this.activeRevision() >= revision) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.activeWaiters.push({ revision, resolve });
    });
  }

  /** Ожидание синхронизированной ревизии ≥ revision (слушатель docMeta; `cancel` снимает его при ошибке команды). */
  private waitSyncedRevision(revision: number): { promise: Promise<void>; cancel: () => void } {
    if (this.syncedRevision !== null && this.syncedRevision >= revision) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }
    const view = this.docView;
    if (!view) return { promise: Promise.reject(new Error('document is not open')), cancel: () => undefined };
    let off: (() => void) | null = null;
    let settled = false;
    const promise = new Promise<void>((resolve, reject) => {
      const gen = this.generation;
      off = view.addListener((rows) => {
        if (settled) return;
        if (this.generation !== gen) {
          settled = true;
          queueMicrotask(() => off?.());
          reject(new Error('adapter closed'));
          return;
        }
        const row = rows.find((r) => r.id === this.docId);
        if (row && row.revision >= revision) {
          settled = true;
          queueMicrotask(() => off?.());
          resolve();
        }
      });
    });
    return {
      promise,
      cancel: () => {
        if (!settled) {
          settled = true;
          off?.();
        }
      },
    };
  }

  private notify(pageId: string): void {
    const set = this.subscribers.get(pageId);
    if (!set) return;
    const snap = this.pages.get(pageId)?.snapshot ?? null;
    for (const cb of set) cb(snap);
  }

  private reportError(message: string): void {
    console.warn(`[Z] ${message}`);
    this.listener?.onPageError?.(this.activePageId ?? '', new Error(message));
  }

  // ---------------------------------------------------------------- internals: команды

  /** Результат операции из журнала (после .server success он уже записан в той же транзакции). */
  private async fetchOperationResult(cmd: CommandRequest, hooks?: CommandHooks): Promise<CommandResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= ADAPTER_SETTINGS.commandPollAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(ADAPTER_SETTINGS.commandPollDelayMs(attempt - 1));
        hooks?.onRetry?.({ opId: cmd.opId, via: 'poll', attempt, reason: lastError instanceof Error ? lastError.message : String(lastError) });
      }
      try {
        const status = await getOperation(cmd.opId);
        if (status.status === 'done') return status.result;
      } catch (e) {
        lastError = e;
        if (isApiError(e, 'not_found')) continue; // журнал ещё не виден (не должно случаться после .server)
        if (isDefinitiveError(e)) throw e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`operation ${cmd.opId} result unavailable`);
  }

  // ---------------------------------------------------------------- internals: retained

  /** Подсчёт реальных строк хранилища (inspector.client.rows — чтение локального b-tree, без сервера). */
  private async refreshRetained(): Promise<RetainedStats> {
    if (this.retainedRefresh) {
      this.retainedDirty = true;
      return this.retainedRefresh;
    }
    const zero = this.zero;
    if (!zero) {
      this.retained = { pages: 0, shapes: 0, bytesEstimate: 0 };
      return this.retained;
    }
    const gen = this.generation;
    this.retainedRefresh = (async () => {
      try {
        const rows = (await zero.inspector.client.rows('shapes')) as unknown as ShapeRow[];
        if (this.generation !== gen) return this.retained;
        const pageIds = new Set<string>();
        for (const r of rows) pageIds.add(r.pageId);
        // пустые полные страницы (0 фигур) тоже удерживаются как запросы
        for (const e of this.pages.values()) if (e.complete && e.rows.length === 0) pageIds.add(e.pageId);
        this.retained = { pages: pageIds.size, shapes: rows.length, bytesEstimate: rows.length * SHAPE_BYTES_ESTIMATE };
      } catch (e) {
        console.warn('[Z] retained refresh failed', e);
      }
      return this.retained;
    })().finally(() => {
      this.retainedRefresh = null;
      if (this.retainedDirty) {
        this.retainedDirty = false;
        void this.refreshRetained();
      }
    });
    return this.retainedRefresh;
  }

  /**
   * Плановый пересчёт. P: сразу (окно маленькое, скан ~40 мс) + повторы после вытеснения, пока сервер
   * удаляет строки. F: с задержкой после последнего изменения (во время фоновой загрузки страницы
   * завершаются непрерывно, а скан хранилища растёт до ~0.3 с) — `immediate` форсирует немедленный скан.
   */
  private scheduleRetainedRefresh(afterEvict = false, immediate = this.mode === 'P'): void {
    if (immediate) {
      void this.refreshRetained();
    } else {
      if (this.retainedDebounce) clearTimeout(this.retainedDebounce);
      this.retainedDebounce = setTimeout(() => {
        this.retainedDebounce = null;
        void this.refreshRetained();
      }, Z_SETTINGS.retainedDebounceMs);
    }
    if (!afterEvict) return;
    for (const t of this.retainedTimers) clearTimeout(t);
    this.retainedTimers = Z_SETTINGS.retainedRecheckDelaysMs.map((ms) =>
      setTimeout(() => {
        void this.refreshRetained();
      }, ms),
    );
  }
}
