import type {
  CommandRequest,
  CommandResult,
  DocumentMeta,
  LoadMode,
  PageResponse,
  PageSnapshot,
  RetainedStats,
  Shape,
} from '@stand/shared';
import { getDocument, isAbortError } from '../api';
import { sendCommandWithRetry } from './commands';
import { DocState } from './doc-state';
import { createLimiter } from './limiter';
import { readPageFresh, withReadRetry } from './read-page';
import { ADAPTER_SETTINGS, SHAPE_BYTES_ESTIMATE, resolveInitialPageId } from './types';
import type { AdapterListener, CommandHooks, DataAdapter, InitialPage, Unsubscribe } from './types';

export { SHAPE_BYTES_ESTIMATE };

type EntryStatus = 'loading' | 'ready' | 'stale' | 'error';

/**
 * Запись хранилища страницы:
 *  loading — полного набора ещё нет, запрос в полёте;
 *  ready   — полный набор на актуальной ревизии;
 *  stale   — полный, но устаревший набор (перечитывается при следующем открытии / в фоне в F);
 *  error   — полного набора нет, последний запрос завершился ошибкой.
 */
interface Entry {
  pageId: string;
  status: EntryStatus;
  revision: number;
  shapes: Shape[];
  /** объект снимка меняется только вместе с данными (чтобы отрисовщик мог кешировать сортировку) */
  snapshot: PageSnapshot | null;
  /** поколение загрузки: ответ более раннего поколения не применяется */
  generation: number;
  promise: Promise<void> | null;
  abort: AbortController | null;
  error: unknown;
}

type Subscriber = (snap: PageSnapshot | null) => void;

/**
 * Адаптер H: `fetch` + `Map<pageId, Entry>` (SPEC §4.1).
 */
export class HAdapter implements DataAdapter {
  private readonly pages = new Map<string, Entry>();
  private readonly shapeIndex = new Map<string, Shape>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly doc = new DocState();
  private readonly limiter = createLimiter(ADAPTER_SETTINGS.fullLoadConcurrency);
  private meta: DocumentMeta | null = null;
  private docId = '';
  private activePageId: string | null = null;
  /** порядок посещения страниц (последняя — в конце), для LRU‑окна режима P */
  private recent: string[] = [];
  private listener: AdapterListener | null = null;

  constructor(
    private readonly mode: LoadMode,
    private readonly cacheWindow: number,
  ) {}

  setListener(listener: AdapterListener | null): void {
    this.listener = listener;
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
      // все страницы через ограничитель параллелизма; активная — первой в очереди
      for (const pid of order) void this.startFetch(pid);
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

    if (this.mode === 'P' && prev && prev !== pageId) {
      // отмена незавершённой загрузки прежней активной страницы
      const pe = this.pages.get(prev);
      if (pe?.promise) {
        this.abortEntry(pe);
        if (pe.snapshot === null) this.evict(prev);
      }
      this.enforceWindow();
    }

    const entry = this.pages.get(pageId);
    if (!entry || entry.status === 'error' || entry.status === 'stale' || (entry.status === 'loading' && !entry.promise)) {
      void this.startFetch(pageId);
    }
    if (this.mode === 'F') this.limiter.prioritize(pageId); // активная — вне очереди, но в пределах параллелизма
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
    for (const e of this.pages.values()) {
      if (e.snapshot) {
        pages += 1;
        shapes += e.shapes.length;
      }
    }
    return { pages, shapes, bytesEstimate: shapes * SHAPE_BYTES_ESTIMATE };
  }

  /** H хранит данные синхронно в Map — значение то же, что у getRetained(). */
  async getRetainedAsync(): Promise<RetainedStats> {
    return this.getRetained();
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
    this.close();
    // постоянного хранилища у H нет; память очищена в close()
  }

  close(): void {
    this.limiter.clear();
    for (const e of this.pages.values()) this.abortEntry(e);
    const ids = [...this.pages.keys()];
    this.pages.clear();
    this.shapeIndex.clear();
    this.recent = [];
    this.activePageId = null;
    this.meta = null;
    this.doc.reset();
    for (const pid of ids) this.notify(pid);
  }

  // ---------------------------------------------------------------- internals

  private touchRecent(pageId: string): void {
    const idx = this.recent.indexOf(pageId);
    if (idx >= 0) this.recent.splice(idx, 1);
    this.recent.push(pageId);
  }

  /** LRU‑окно режима P: активная + `cacheWindow` последних посещённых неактивных; остальное — Map.delete. */
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
    // держим список посещений коротким
    if (this.recent.length > this.cacheWindow + 8) this.recent = this.recent.slice(-(this.cacheWindow + 8));
  }

  private evict(pageId: string): void {
    const e = this.pages.get(pageId);
    if (!e) return;
    this.abortEntry(e);
    for (const s of e.shapes) this.shapeIndex.delete(s.id);
    this.pages.delete(pageId);
    this.notify(pageId);
  }

  private abortEntry(e: Entry): void {
    if (e.abort) {
      e.abort.abort();
      e.abort = null;
    }
    e.promise = null;
    e.generation += 1; // ответы прежнего поколения не применяются
  }

  private newEntry(pageId: string): Entry {
    const e: Entry = {
      pageId,
      status: 'loading',
      revision: -1,
      shapes: [],
      snapshot: null,
      generation: 0,
      promise: null,
      abort: null,
      error: null,
    };
    this.pages.set(pageId, e);
    return e;
  }

  /** Загрузка/перечитывание страницы с дедупликацией одновременных запросов. Никогда не отклоняется. */
  private startFetch(pageId: string): Promise<void> {
    if (!this.docId) return Promise.resolve();
    const entry = this.pages.get(pageId) ?? this.newEntry(pageId);
    if (entry.promise) return entry.promise;
    if (entry.status === 'ready') return Promise.resolve();
    entry.generation += 1;
    const gen = entry.generation;
    const abort = new AbortController();
    entry.abort = abort;
    if (entry.snapshot === null) entry.status = 'loading';
    this.listener?.onPageLoadStart?.(pageId);

    const read = (): Promise<PageResponse> =>
      withReadRetry(() => readPageFresh(this.docId, pageId, this.doc, abort.signal), abort.signal);
    // F: фиксированный параллелизм (ADAPTER_SETTINGS.fullLoadConcurrency); P: одна активная страница
    const promise = (this.mode === 'F' ? this.limiter.run(pageId, read) : read()).then(
      (resp) => {
        if (entry.generation !== gen || this.pages.get(pageId) !== entry) return;
        this.applyPage(entry, resp);
      },
      (err: unknown) => {
        if (isAbortError(err)) return;
        if (entry.generation !== gen || this.pages.get(pageId) !== entry) return;
        entry.error = err;
        if (entry.snapshot === null) entry.status = 'error';
        this.listener?.onPageError?.(pageId, err);
        this.notify(pageId);
      },
    ).finally(() => {
      if (entry.generation === gen) {
        entry.promise = null;
        entry.abort = null;
      }
    });
    entry.promise = promise;
    return promise;
  }

  private applyPage(entry: Entry, resp: PageResponse): void {
    if (entry.snapshot && resp.revision < entry.revision) return; // никогда не откатываем ревизию
    for (const s of entry.shapes) this.shapeIndex.delete(s.id);
    entry.shapes = resp.shapes;
    entry.revision = resp.revision;
    entry.status = 'ready';
    entry.error = null;
    for (const s of resp.shapes) this.shapeIndex.set(s.id, s);
    entry.snapshot = { pageId: entry.pageId, revision: resp.revision, shapes: resp.shapes };
    this.notify(entry.pageId);
  }

  /**
   * После команды: затронутые страницы — активная перечитывается немедленно (ожидается), неактивные
   * в кеше помечаются устаревшими (P — перечитывание при следующем открытии; F — перечитывание в фоне).
   * Незатронутые актуальные страницы «поднимаются» до новой ревизии без запроса.
   */
  private async applyCommandResult(result: CommandResult): Promise<void> {
    const affected = new Set(result.affectedPages);
    const waits: Promise<void>[] = [];
    for (const [pid, entry] of this.pages) {
      let needsRefetch = false;
      if (affected.has(pid)) {
        needsRefetch = true;
      } else if (entry.snapshot && entry.status !== 'stale') {
        const eff = this.doc.effectiveRevision(pid, entry.revision);
        if (eff === null) needsRefetch = true;
        else if (eff !== entry.revision) {
          entry.revision = eff;
          entry.snapshot = { pageId: pid, revision: eff, shapes: entry.shapes };
          this.notify(pid);
        }
      }
      if (!needsRefetch) continue;
      if (entry.snapshot) entry.status = 'stale';
      if (pid === this.activePageId) {
        // не ждём возможного «старого» ответа — перезапускаем чтение
        this.abortEntry(entry);
        waits.push(this.startFetch(pid));
      } else if (this.mode === 'F') {
        this.abortEntry(entry);
        void this.startFetch(pid); // в фоне, через тот же ограничитель параллелизма
      }
      // P, неактивная: остаётся stale, перечитывается при следующем selectPage
    }
    if (this.mode === 'F' && this.activePageId) this.limiter.prioritize(this.activePageId);
    await Promise.all(waits);
  }

  private notify(pageId: string): void {
    const set = this.subscribers.get(pageId);
    if (!set) return;
    const snap = this.pages.get(pageId)?.snapshot ?? null;
    for (const cb of set) cb(snap);
  }
}
