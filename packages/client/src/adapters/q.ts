import type {
  CommandRequest,
  CommandResult,
  DocumentMeta,
  LoadMode,
  PageResponse,
  PageSnapshot,
  RetainedStats,
} from '@stand/shared';
import { CancelledError, QueryClient, QueryObserver } from '@tanstack/react-query';
import type { QueryObserverResult } from '@tanstack/react-query';
import { getDocument } from '../api';
import { sendCommandWithRetry } from './commands';
import { DocState } from './doc-state';
import { createLimiter } from './limiter';
import { queryRetry, queryRetryDelay, readPageFresh } from './read-page';
import { ADAPTER_SETTINGS, SHAPE_BYTES_ESTIMATE, resolveInitialPageId } from './types';
import type { AdapterListener, CommandHooks, DataAdapter, InitialPage, Unsubscribe } from './types';

type Subscriber = (snap: PageSnapshot | null) => void;

interface ObserverRecord {
  observer: QueryObserver<PageResponse, Error>;
  unsubscribe: () => void;
  subs: Set<Subscriber>;
  lastData: PageResponse | undefined;
  lastError: unknown;
}

/** Снимок для интерфейса кешируется по объекту данных запроса — идентичность стабильна, пока данные те же. */
const snapshotCache = new WeakMap<PageResponse, PageSnapshot>();
function snapshotOf(data: PageResponse): PageSnapshot {
  let s = snapshotCache.get(data);
  if (!s) {
    s = { pageId: data.pageId, revision: data.revision, shapes: data.shapes };
    snapshotCache.set(data, s);
  }
  return s;
}

/**
 * Адаптер Q: TanStack Query 5 (SPEC §4.1). Ключ страницы — ['doc', docId, 'page', pageId].
 * Все настройки заданы явно (см. ADAPTER_SETTINGS.query и docs/PASSPORT):
 *  staleTime: Infinity — данные страницы меняются только через команды, которые делают invalidateQueries;
 *  refetchOnMount/WindowFocus/Reconnect: false — перечитывание только по решению адаптера;
 *  retry: 2 (кроме окончательных 4xx), retryDelay 500·2^n мс; gcTime 5 мин; networkMode 'always'.
 */
export class QAdapter implements DataAdapter {
  private readonly client: QueryClient;
  private readonly doc = new DocState();
  private readonly limiter = createLimiter(ADAPTER_SETTINGS.fullLoadConcurrency);
  private readonly observers = new Map<string, ObserverRecord>();
  private meta: DocumentMeta | null = null;
  private docId = '';
  private activePageId: string | null = null;
  private recent: string[] = [];
  private listener: AdapterListener | null = null;

  constructor(
    private readonly mode: LoadMode,
    private readonly cacheWindow: number,
  ) {
    const q = ADAPTER_SETTINGS.query;
    this.client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: q.staleTime,
          gcTime: q.gcTime,
          retry: queryRetry,
          retryDelay: queryRetryDelay,
          refetchOnWindowFocus: q.refetchOnWindowFocus,
          refetchOnReconnect: q.refetchOnReconnect,
          refetchOnMount: q.refetchOnMount,
          networkMode: q.networkMode,
          structuralSharing: q.structuralSharing,
        },
      },
    });
    this.client.mount();
  }

  /** Доступ к QueryClient для проверок (queryCache) — не для интерфейса. */
  getQueryClient(): QueryClient {
    return this.client;
  }

  setListener(listener: AdapterListener | null): void {
    this.listener = listener;
  }

  private pageKey(pageId: string): readonly [string, string, string, string] {
    return ['doc', this.docId, 'page', pageId] as const;
  }

  private pageOptions(pageId: string) {
    const docId = this.docId;
    const full = this.mode === 'F';
    return {
      queryKey: this.pageKey(pageId),
      // F: чтения идут через ограничитель параллелизма (тот же, что у H), signal не потребляется —
      //    смена страницы не отменяет фоновую загрузку; P: signal потребляется → отписка наблюдателя
      //    активной страницы отменяет запрос в полёте (отмена при смене страницы).
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        full
          ? this.limiter.run(pageId, () => readPageFresh(docId, pageId, this.doc))
          : readPageFresh(docId, pageId, this.doc, signal),
      staleTime: ADAPTER_SETTINGS.query.staleTime,
      gcTime: ADAPTER_SETTINGS.query.gcTime,
    };
  }

  async open(docId: string, initialPage?: InitialPage): Promise<DocumentMeta> {
    this.docId = docId;
    const meta = await getDocument(docId);
    this.meta = meta;
    this.doc.noteRevision(meta.revision);
    if (this.mode === 'F') {
      const order = [...meta.pages].sort((a, b) => a.index - b.index).map((p) => p.id);
      // приоритет активной страницы задаётся ЯВНО (§1.6), а не совпадением с минимальным индексом
      const initialPageId = resolveInitialPageId(meta.pages, initialPage);
      if (initialPageId && order.includes(initialPageId)) {
        order.splice(order.indexOf(initialPageId), 1);
        order.unshift(initialPageId);
      }
      for (const pid of order) this.prefetch(pid);
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
    if (!this.meta) throw new Error('document is not open');
    const prev = this.activePageId;
    this.activePageId = pageId;
    this.touchRecent(pageId);
    if (this.mode === 'P' && prev !== pageId) this.enforceWindow();
    // нет данных → загрузка; invalidated (stale) → перечитывание; свежие → без запроса; в полёте → дедупликация
    this.listener?.onPageLoadStart?.(pageId);
    void this.client.fetchQuery(this.pageOptions(pageId)).catch(() => undefined);
    if (this.mode === 'F') this.limiter.prioritize(pageId); // активная — первой в очереди чтений
  }

  subscribePage(pageId: string, cb: Subscriber): Unsubscribe {
    let rec = this.observers.get(pageId);
    if (!rec) {
      const observer = new QueryObserver<PageResponse, Error>(this.client, {
        ...this.pageOptions(pageId),
        notifyOnChangeProps: 'all',
      });
      const record: ObserverRecord = {
        observer,
        unsubscribe: () => undefined,
        subs: new Set(),
        lastData: observer.getCurrentResult().data,
        lastError: null,
      };
      record.unsubscribe = observer.subscribe((result) => this.onResult(pageId, record, result));
      this.observers.set(pageId, record);
      rec = record;
    }
    rec.subs.add(cb);
    cb(this.getPageSnapshot(pageId));
    return () => {
      const r = this.observers.get(pageId);
      if (!r) return;
      r.subs.delete(cb);
      if (r.subs.size === 0) {
        r.unsubscribe(); // в P: отписка последнего наблюдателя отменяет запрос в полёте (signal)
        this.observers.delete(pageId);
      }
    };
  }

  async runCommand(cmd: CommandRequest, hooks?: CommandHooks): Promise<CommandResult> {
    const result = await sendCommandWithRetry(this.docId, cmd, hooks?.onRetry);
    // у H/Q результат приходит в теле ответа POST: подтверждение транспорта и результат — один момент
    hooks?.onServer?.({ via: 'http-post' });
    this.doc.noteCommand(result);
    hooks?.onAcked?.(result);
    await this.applyCommandResult(result);
    // активная страница перечитана (или «поднята» до новой ревизии) — данные команды в хранилище
    hooks?.onSynced?.();
    return result;
  }

  getRetained(): RetainedStats {
    let pages = 0;
    let shapes = 0;
    for (const q of this.pageQueries()) {
      const data = q.state.data as PageResponse | undefined;
      if (data) {
        pages += 1;
        shapes += data.shapes.length;
      }
    }
    return { pages, shapes, bytesEstimate: shapes * SHAPE_BYTES_ESTIMATE };
  }

  /** Q: queryCache читается синхронно — значение то же, что у getRetained(). */
  async getRetainedAsync(): Promise<RetainedStats> {
    return this.getRetained();
  }

  getPageSnapshot(pageId: string): PageSnapshot | null {
    if (!this.docId) return null;
    const data = this.client.getQueryData<PageResponse>(this.pageKey(pageId));
    return data ? snapshotOf(data) : null;
  }

  getLoadedPages(): string[] {
    const out: string[] = [];
    for (const q of this.pageQueries()) {
      if (q.state.data) out.push(q.queryKey[3] as string);
    }
    return out;
  }

  async logout(): Promise<void> {
    this.close();
    // постоянного хранилища у Q нет (persister не используется); queryCache очищен в close()
  }

  close(): void {
    this.limiter.clear();
    const ids = [...this.observers.keys()];
    for (const rec of this.observers.values()) rec.unsubscribe();
    const subs = new Map<string, Set<Subscriber>>();
    for (const [pid, rec] of this.observers) subs.set(pid, rec.subs);
    this.observers.clear();
    void this.client.cancelQueries().catch(() => undefined);
    this.client.clear();
    this.client.unmount();
    this.recent = [];
    this.activePageId = null;
    this.meta = null;
    this.docId = '';
    this.doc.reset();
    for (const pid of ids) for (const cb of subs.get(pid) ?? []) cb(null);
  }

  // ---------------------------------------------------------------- internals

  private pageQueries() {
    if (!this.docId) return [];
    return this.client.getQueryCache().findAll({ queryKey: ['doc', this.docId, 'page'] });
  }

  /** Фоновая загрузка страницы (F): prefetchQuery; HTTP‑чтение гейтится ограничителем внутри queryFn. */
  private prefetch(pageId: string): void {
    void this.client.prefetchQuery(this.pageOptions(pageId)).then(() => {
      const st = this.client.getQueryState(this.pageKey(pageId));
      if (st?.status === 'error' && st.error) this.listener?.onPageError?.(pageId, st.error);
    });
  }

  private touchRecent(pageId: string): void {
    const idx = this.recent.indexOf(pageId);
    if (idx >= 0) this.recent.splice(idx, 1);
    this.recent.push(pageId);
  }

  /** LRU‑окно режима P: страницы вне окна удаляются явно через removeQueries. */
  private enforceWindow(): void {
    if (this.mode !== 'P') return;
    const allowed = new Set<string>();
    if (this.activePageId) allowed.add(this.activePageId);
    for (let i = this.recent.length - 1; i >= 0 && allowed.size < this.cacheWindow + 1; i -= 1) {
      allowed.add(this.recent[i] as string);
    }
    for (const q of this.pageQueries()) {
      const pid = q.queryKey[3] as string;
      if (!allowed.has(pid)) {
        this.client.removeQueries({ queryKey: this.pageKey(pid), exact: true });
      }
    }
    if (this.recent.length > this.cacheWindow + 8) this.recent = this.recent.slice(-(this.cacheWindow + 8));
  }

  private onResult(pageId: string, rec: ObserverRecord, result: QueryObserverResult<PageResponse, Error>): void {
    if (result.status === 'error' && result.error && result.error !== rec.lastError) {
      rec.lastError = result.error;
      this.listener?.onPageError?.(pageId, result.error);
    }
    if (result.data === rec.lastData) return;
    rec.lastData = result.data;
    const snap = result.data ? snapshotOf(result.data) : null;
    for (const cb of rec.subs) cb(snap);
  }

  /**
   * После команды: invalidateQueries по затронутым страницам (refetchType 'active' — активная
   * перечитывается сразу и ожидается; неактивные помечаются stale и перечитываются при следующем
   * наблюдении; в F — перечитывание в фоне через тот же ограничитель). Незатронутые свежие страницы
   * «поднимаются» до новой ревизии через setQueryData без запроса.
   */
  private async applyCommandResult(result: CommandResult): Promise<void> {
    const affected = new Set(result.affectedPages);
    const toInvalidate: string[] = [];
    for (const q of this.pageQueries()) {
      const pid = q.queryKey[3] as string;
      const data = q.state.data as PageResponse | undefined;
      if (affected.has(pid)) {
        toInvalidate.push(pid);
        continue;
      }
      if (data && !q.state.isInvalidated) {
        const eff = this.doc.effectiveRevision(pid, data.revision);
        if (eff === null) toInvalidate.push(pid);
        else if (eff !== data.revision) {
          const seen = data.revision;
          this.client.setQueryData<PageResponse>(q.queryKey, (old) =>
            old && old.revision === seen ? { ...old, revision: eff } : old,
          );
        }
      }
    }
    const active = this.activePageId;
    const invalidations = toInvalidate.map((pid) =>
      this.client.invalidateQueries(
        { queryKey: this.pageKey(pid), exact: true, refetchType: 'active' },
        { cancelRefetch: true, throwOnError: false },
      ),
    );
    if (this.mode === 'F' && active) this.limiter.prioritize(active);
    await Promise.all(invalidations);
    if (active && toInvalidate.includes(active)) {
      // гарантируем актуальность активной страницы независимо от наличия наблюдателя
      try {
        await this.client.fetchQuery(this.pageOptions(active));
      } catch (e) {
        if (!(e instanceof CancelledError)) this.listener?.onPageError?.(active, e);
      }
    }
    if (this.mode === 'F') {
      for (const pid of toInvalidate) if (pid !== active) this.prefetch(pid);
    }
  }
}
