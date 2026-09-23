import type {
  CommandRequest,
  CommandResult,
  CommandTiming,
  PageSnapshot,
  RetainedStats,
  StandEvent,
  StandEventType,
  StandGlobal,
} from '@stand/shared';
import { createAdapter, preloadAdapter } from './adapters';
import { resolveInitialPageId } from './adapters/types';
import type { DataAdapter, Unsubscribe } from './adapters/types';
import { isApiError, listDocuments, login as apiLogin, transfer } from './api';
import { clearToken, setToken } from './auth';
import { Renderer } from './canvas/renderer';
import type { DrawInfo } from './canvas/renderer';
import { parseConfig, passwordFor } from './config';
import type { ClientConfig } from './config';
import { uiStore } from './ui-store';
import type { SelectedShapeInfo, StandState, UiState } from './ui-store';

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const MAX_EVENTS = 20_000;

interface Waiter {
  type: StandEventType;
  predicate?: (e: StandEvent) => boolean;
  resolve: (e: StandEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Команда в полёте. `targetRevision` известен УЖЕ в момент отправки (`expectedRevision + 1`) и не
 * зависит от подтверждения: сервер принимает команду только при `expectedRevision === doc.revision`
 * и повышает ревизию ровно на 1 (`packages/server/src/domain/executeCommand.ts`, шаги 4 и 6), а на
 * стенде документ меняет единственный писатель. Поэтому «холст актуален» = «отрисована ревизия
 * ≥ targetRevision» и фиксируется независимо от `command-acked` (§1.8).
 */
interface InflightCommand {
  targetRevision: number;
  /** ревизия из результата сервера (для сверки; должна совпасть с targetRevision) */
  ackedRevision: number | null;
  acked: boolean;
  drawn: boolean;
  sentAt: number;
  timing: CommandTiming;
}

/**
 * Оркестратор клиента: адаптер данных ↔ отрисовщик ↔ журнал готовности (`window.__stand`, SPEC §4.2).
 * React в пути данных не участвует: подписка на снимок активной страницы толкает данные прямо в отрисовщик,
 * а в `uiStore` попадают только мелкие индикаторы.
 */
export class StandController {
  readonly config: ClientConfig;
  readonly renderer = new Renderer();
  readonly events: StandEvent[] = [];
  private adapter: DataAdapter | null = null;
  private activePageId: string | null = null;
  private unsubActive: Unsubscribe | null = null;
  private activeSnapshot: PageSnapshot | null = null;
  private selectionSeq = 0;
  private readyEmittedForSeq = -1;
  private selectedAt = 0;
  private drawnInfo: (DrawInfo & { at: number }) | null = null;
  private drawScheduled = false;
  private lastAckedRevision = 0;
  private readonly inflight = new Map<string, InflightCommand>();
  /** моменты всех команд прогона (сырые данные для анализа, SPEC §7.3) */
  private readonly commandTimings: CommandTiming[] = [];
  private readonly waiters: Waiter[] = [];
  private lastActionT = 0;
  private activeError: string | null = null;
  private openError: string | null = null;
  private started = false;

  constructor(config: ClientConfig) {
    this.config = config;
    // chunk адаптера начинает грузиться сразу (параллельно с login), а не в момент открытия документа
    void preloadAdapter(config.adapter).catch(() => undefined);
  }

  // ------------------------------------------------------------------ window.__stand

  get state(): StandState {
    if (this.openError) return 'error';
    if (!this.adapter || !this.activePageId) return 'idle';
    if (this.activeError) return 'error';
    const d = this.drawnInfo;
    if (d && d.pageId === this.activePageId && d.revision >= this.lastAckedRevision) return 'ready';
    return 'loading';
  }

  get activePage(): string | null {
    return this.activePageId;
  }

  get activeRevision(): number | null {
    return this.activeSnapshot?.revision ?? null;
  }

  get drawn(): StandGlobal['drawn'] {
    return this.drawnInfo;
  }

  get pendingCommands(): number {
    return this.inflight.size;
  }

  get transfer(): { bytesIn: number; bytesOut: number; requests: number } {
    return { bytesIn: transfer.bytesIn, bytesOut: transfer.bytesOut, requests: transfer.requests };
  }

  /**
   * Ожидание события. По умолчанию учитываются события, записанные ПОСЛЕ последнего действия
   * (open / selectPage / runCommand / logout) — включая уже случившиеся; `since` (performance.now()) переопределяет.
   */
  waitFor(
    type: StandEventType,
    predicate?: (e: StandEvent) => boolean,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
    since: number = this.lastActionT,
  ): Promise<StandEvent> {
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i] as StandEvent;
      if (e.t < since || e.type !== type) continue;
      if (!predicate || predicate(e)) return Promise.resolve(e);
    }
    return new Promise<StandEvent>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        predicate,
        resolve,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`waitFor(${type}) timed out after ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  getRetained(): RetainedStats {
    return this.adapter?.getRetained() ?? { pages: 0, shapes: 0, bytesEstimate: 0 };
  }

  /** Свежий подсчёт (Z — скан хранилища после вызова; H/Q — синхронное значение). Единый контракт для оболочки. */
  getRetainedAsync(): Promise<RetainedStats> {
    return this.adapter ? this.adapter.getRetainedAsync() : Promise.resolve({ pages: 0, shapes: 0, bytesEstimate: 0 });
  }

  getPageSnapshot(pageId: string): ReturnType<StandGlobal['getPageSnapshot']> {
    const snap = this.adapter?.getPageSnapshot(pageId) ?? null;
    if (!snap) return null;
    return {
      revision: snap.revision,
      shapes: snap.shapes.map((s) => ({ id: s.id, fill: s.fill, fillOverridden: s.fillOverridden })),
    };
  }

  getLoadedPages(): string[] {
    return this.adapter?.getLoadedPages() ?? [];
  }

  /**
   * Моменты всех команд прогона (SPEC §7.3): sent → client → server → synced → acked → drawn.
   * Позволяет пересчитать по сырым данным и «команду до холста», и стоимость протокола
   * подтверждения (`opGetMs` — чтение `GET /api/operations/:opId` у Z, ≈0 у H/Q).
   */
  getCommandTimings(): CommandTiming[] {
    return this.commandTimings.map((t) => ({ ...t }));
  }

  selectPage(pageId: string): void {
    const adapter = this.adapter;
    if (!adapter) throw new Error('document is not open');
    const meta = adapter.getMeta();
    const page = meta?.pages.find((p) => p.id === pageId);
    if (!page) throw new Error(`unknown page ${pageId}`);
    this.lastActionT = performance.now();
    this.selectionSeq += 1;
    this.selectedAt = this.lastActionT;
    this.activePageId = pageId;
    this.activeError = null;
    this.emit('page-select', { pageId, index: page.index, seq: this.selectionSeq });
    if (this.unsubActive) {
      this.unsubActive();
      this.unsubActive = null;
    }
    adapter.selectPage(pageId);
    this.unsubActive = adapter.subscribePage(pageId, (snap) => this.onActiveSnapshot(pageId, snap));
    uiStore.patch({ activePageId: pageId });
    this.refreshIndicators();
  }

  async runCommand(
    input: Omit<CommandRequest, 'expectedRevision' | 'opId'> & { opId?: string },
  ): Promise<CommandResult> {
    const adapter = this.adapter;
    if (!adapter) throw new Error('document is not open');
    const opId = input.opId ?? crypto.randomUUID();
    this.lastActionT = performance.now();
    const timing: CommandTiming = {
      opId,
      type: input.type,
      targetId: input.targetId,
      expectedRevision: NaN,
      targetRevision: NaN,
      sentAt: this.lastActionT,
      clientAt: null,
      serverAt: null,
      ackedAt: null,
      syncedAt: null,
      drawnAt: null,
      opGetMs: null,
      error: null,
    };
    this.commandTimings.push(timing);
    if (this.commandTimings.length > 50) this.commandTimings.splice(0, this.commandTimings.length - 50);
    const track: InflightCommand = { targetRevision: Number.POSITIVE_INFINITY, ackedRevision: null, acked: false, drawn: false, sentAt: this.lastActionT, timing };
    this.inflight.set(opId, track);
    this.refreshIndicators();

    const attempt = (expectedRevision: number): Promise<CommandResult> => {
      const cmd: CommandRequest = { opId, type: input.type, targetId: input.targetId, fill: input.fill, expectedRevision };
      // целевая ревизия известна ДО ответа сервера (см. InflightCommand); при повторе после
      // revision_mismatch она уточняется вместе с expectedRevision
      track.targetRevision = expectedRevision + 1;
      track.drawn = false;
      timing.expectedRevision = expectedRevision;
      timing.targetRevision = track.targetRevision;
      this.emit('command-sent', { opId, type: cmd.type, targetId: cmd.targetId, fill: cmd.fill, expectedRevision, targetRevision: track.targetRevision });
      return adapter.runCommand(cmd, {
        onClient: () => {
          timing.clientAt = performance.now();
        },
        onServer: (d) => {
          timing.serverAt = performance.now();
          this.emit('command-server', { opId, via: d.via, sinceSent: timing.serverAt - track.sentAt });
        },
        onAcked: (r) => {
          const at = performance.now();
          timing.ackedAt = at;
          if (timing.serverAt !== null) timing.opGetMs = +(at - timing.serverAt).toFixed(3);
          track.acked = true;
          track.ackedRevision = r.revision;
          if (r.revision > this.lastAckedRevision) this.lastAckedRevision = r.revision;
          this.emit('command-acked', {
            opId,
            revision: r.revision,
            targetRevision: track.targetRevision,
            affectedPages: r.affectedPages,
            affectedShapes: r.affectedShapes,
            sinceSent: at - track.sentAt,
          });
          // активная страница не затронута и уже актуальна — «поднятие» ревизии придёт снимком;
          // если она вообще не изменилась, проверим готовность по текущему снимку
          this.checkDrawnCommands();
          // холст мог обновиться ещё ДО подтверждения (у Z — обычный случай): команда завершена
          if (track.drawn) this.inflight.delete(opId);
          this.refreshIndicators();
        },
        onSynced: () => {
          timing.syncedAt = performance.now();
          this.emit('command-synced', { opId, sinceSent: timing.syncedAt - track.sentAt });
        },
        onRetry: (detail) => this.emit('command-retry', detail),
      });
    };

    try {
      try {
        return await attempt(adapter.getDocRevision() ?? 0);
      } catch (e) {
        if (isApiError(e, 'revision_mismatch')) {
          this.emit('command-retry', { opId, via: 'revision_mismatch', currentRevision: e.currentRevision ?? null });
          // Повтор берёт ревизию ТОЛЬКО из авторитетных серверных источников: свежий ответ
          // GET /api/documents/:id и currentRevision из отказа. Локальное значение адаптера здесь
          // использовать нельзя: у Z оно приходит синхронизацией и после сброса документа может
          // какое-то время оставаться больше фактической ревизии (отставание реплики zero-cache),
          // из-за чего повтор отправлял бы заведомо неверную expectedRevision.
          const meta = await adapter.refreshMeta();
          const rev = meta.revision ?? e.currentRevision ?? 0;
          return await attempt(rev);
        }
        throw e;
      }
    } catch (e) {
      this.inflight.delete(opId);
      const message = e instanceof Error ? e.message : String(e);
      timing.error = message.slice(0, 300);
      this.emit('error', { scope: 'command', opId, message });
      uiStore.patch({ lastError: message });
      this.refreshIndicators();
      throw e;
    }
  }

  async logout(): Promise<void> {
    this.lastActionT = performance.now();
    if (this.unsubActive) {
      this.unsubActive();
      this.unsubActive = null;
    }
    const adapter = this.adapter;
    this.adapter = null;
    this.activePageId = null;
    this.activeSnapshot = null;
    this.drawnInfo = null;
    this.inflight.clear();
    this.lastAckedRevision = 0;
    this.activeError = null;
    this.openError = null;
    if (adapter) {
      try {
        await adapter.logout();
      } catch (e) {
        this.emit('error', { scope: 'logout', message: e instanceof Error ? e.message : String(e) });
      }
    }
    clearToken();
    try {
      sessionStorage.clear();
    } catch {
      /* недоступно */
    }
    try {
      localStorage.clear();
    } catch {
      /* недоступно */
    }
    await deleteAllIndexedDb();
    this.renderer.setSnapshot(null);
    this.renderer.setSelection(null);
    this.scheduleDraw();
    this.emit('logout', {});
    uiStore.reset({ phase: 'login' });
  }

  // ------------------------------------------------------------------ app-level API

  /** Точка входа: автологин (если задан) и открытие документа. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const auto = this.config.autologin;
    if (auto) {
      const password = passwordFor(auto, this.config.autologinPassword);
      if (!password) {
        uiStore.patch({ phase: 'login', loginError: `пароль автологина не передан (?pass=…) и не известен сборке: ${auto}` });
        return;
      }
      void this.login(auto, password);
    } else {
      uiStore.patch({ phase: 'login' });
    }
  }

  async login(loginName: string, password: string): Promise<void> {
    uiStore.patch({ phase: 'boot', loginError: null });
    try {
      const res = await apiLogin({ login: loginName, password });
      setToken(res.token, res.userId);
      uiStore.patch({ userId: res.userId });
      await this.openDocument();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit('error', { scope: 'login', message });
      uiStore.patch({ phase: 'login', loginError: message });
    }
  }

  private async openDocument(): Promise<void> {
    this.lastActionT = performance.now();
    let docId = this.config.docId;
    if (!docId) {
      const docs = await listDocuments();
      const first = docs[0];
      if (!first) throw new Error('у пользователя нет документов');
      docId = first.id;
      this.config.docId = docId;
    }
    const adapter = await createAdapter(this.config.adapter, this.config.mode, this.config.cache);
    adapter.setListener({
      onPageError: (pageId, err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (pageId === this.activePageId) {
          this.activeError = message;
          this.refreshIndicators();
        }
        this.emit('error', { scope: 'page', pageId, message });
        uiStore.patch({ lastError: message });
      },
    });
    this.adapter = adapter;
    this.openError = null;
    uiStore.patch({ phase: 'app', lastError: null });
    try {
      // Начальная страница передаётся адаптеру ЯВНО (§1.6): в F именно она получает приоритет
      // загрузки, и это не зависит от совпадения «стартовая страница = минимальный index»
      // (критик A, п. 16). `resolveInitialPageId` — тот же выбор, что сделает адаптер внутри open().
      const meta = await adapter.open(docId, this.config.initialPage);
      uiStore.patch({ meta, docRevision: meta.revision });
      const firstId = resolveInitialPageId(meta.pages, this.config.initialPage);
      this.emit('open', { docId, revision: meta.revision, pages: meta.pages.length, initialPageId: firstId, initialPageRequested: this.config.initialPage });
      if (firstId) this.selectPage(firstId);
      else this.refreshIndicators();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.openError = message;
      this.emit('error', { scope: 'open', docId, message });
      uiStore.patch({ lastError: message });
      this.refreshIndicators();
    }
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.renderer.attach(canvas);
    this.scheduleDraw();
  }

  detachCanvas(): void {
    this.renderer.detach();
  }

  setSelection(id: string | null): void {
    this.renderer.setSelection(id);
    uiStore.patch({ selected: this.selectedInfo() });
    this.scheduleDraw();
  }

  /** Клик по холсту: попадание → выделение (только состояние интерфейса). */
  clickAt(cssX: number, cssY: number): void {
    const hit = this.renderer.hitTest(cssX, cssY);
    this.setSelection(hit ? hit.id : null);
  }

  zoomAt(cssX: number, cssY: number, factor: number): void {
    const cam = this.renderer.getCamera();
    const world = this.renderer.toWorld(cssX, cssY);
    const scale = Math.min(8, Math.max(0.1, cam.scale * factor));
    this.renderer.setCamera({ scale, x: cssX - world.x * scale, y: cssY - world.y * scale });
    this.scheduleDraw();
  }

  panBy(dx: number, dy: number): void {
    const cam = this.renderer.getCamera();
    this.renderer.setCamera({ x: cam.x + dx, y: cam.y + dy });
    this.scheduleDraw();
  }

  resetCamera(): void {
    this.renderer.resetCamera();
    this.scheduleDraw();
  }

  /** Локальная заливка выделенной фигуры. */
  localFill(fill: string): Promise<CommandResult> {
    const sel = this.selectedInfo();
    if (!sel) return Promise.reject(new Error('нет выделенной фигуры'));
    return this.runCommand({ type: 'setLocalFill', targetId: sel.id, fill });
  }

  /** Общая заливка источника: выделен источник — он сам; выделен экземпляр — его источник. */
  sourceFill(fill: string): Promise<CommandResult> {
    const sel = this.selectedInfo();
    if (!sel) return Promise.reject(new Error('нет выделенной фигуры'));
    const targetId = sel.isSource ? sel.id : sel.sourceId;
    if (!targetId) return Promise.reject(new Error('выделенная фигура не связана с источником'));
    return this.runCommand({ type: 'setSourceFill', targetId, fill });
  }

  // ------------------------------------------------------------------ internals

  private onActiveSnapshot(pageId: string, snap: PageSnapshot | null): void {
    if (pageId !== this.activePageId) return; // поздний ответ прежней страницы не активирует её
    this.activeSnapshot = snap;
    if (snap) this.activeError = null;
    this.renderer.setSnapshot(snap);
    this.scheduleDraw();
    uiStore.patch({ selected: this.selectedInfo() });
    this.refreshIndicators();
  }

  private scheduleDraw(): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    requestAnimationFrame(() => {
      this.drawScheduled = false;
      const info = this.renderer.draw();
      // фиксация «нарисовано» — в следующем кадре, после фактического вывода холста
      requestAnimationFrame(() => this.onDrawn(info));
    });
  }

  private onDrawn(info: DrawInfo | null): void {
    const at = performance.now();
    this.drawnInfo = info ? { ...info, at } : null;
    if (info && info.pageId === this.activePageId) {
      if (info.revision >= this.lastAckedRevision && this.readyEmittedForSeq !== this.selectionSeq) {
        this.readyEmittedForSeq = this.selectionSeq;
        this.emit('page-ready', {
          pageId: info.pageId,
          revision: info.revision,
          shapeCount: info.shapeCount,
          seq: this.selectionSeq,
          sinceSelect: at - this.selectedAt,
        });
      }
      this.checkDrawnCommands(at);
    }
    uiStore.patch({ lastDrawMs: Math.round(this.renderer.lastDrawMs * 100) / 100 });
    this.refreshIndicators();
  }

  /**
   * `command-drawn` — момент ФАКТИЧЕСКОЙ отрисовки холста с данными команды (§1.8), независимо от
   * подтверждения сервера: активная страница нарисована с ревизией ≥ `targetRevision`
   * (= `expectedRevision + 1`, см. InflightCommand). Для Z это обычно РАНЬШЕ `command-acked`
   * (ack включает отдельное чтение журнала операций); такой порядок — законный результат.
   * Время берётся из `drawnInfo.at` (запись во втором rAF после `draw()`), а не из момента вызова.
   */
  private checkDrawnCommands(at?: number): void {
    if (this.inflight.size === 0) return;
    const d = this.drawnInfo;
    if (!d || d.pageId !== this.activePageId) return;
    const drawnAt = at ?? d.at;
    for (const [opId, c] of this.inflight) {
      if (c.drawn || d.revision < c.targetRevision) continue;
      c.drawn = true;
      c.timing.drawnAt = drawnAt;
      this.emit('command-drawn', {
        opId,
        revision: c.targetRevision,
        pageId: d.pageId,
        drawnRevision: d.revision,
        sinceSent: drawnAt - c.sentAt,
        beforeAck: !c.acked,
      });
      // из «в полёте» команда уходит, только когда завершены ОБА момента (§4.2)
      if (c.acked) this.inflight.delete(opId);
    }
    this.refreshIndicators();
  }

  private selectedInfo(): SelectedShapeInfo | null {
    const id = this.renderer.getSelection();
    if (!id) return null;
    const s = this.renderer.findShape(id);
    if (!s) return null;
    return {
      id: s.id,
      pageId: s.pageId,
      kind: s.kind,
      fill: s.fill,
      isSource: s.isSource,
      sourceId: s.sourceId,
      fillOverridden: s.fillOverridden,
    };
  }

  private refreshIndicators(): void {
    const adapter = this.adapter;
    const cur = uiStore.getSnapshot();
    const retained = adapter ? adapter.getRetained() : { pages: 0, shapes: 0, bytesEstimate: 0 };
    const patch: Partial<UiState> = {
      state: this.state,
      pending: this.inflight.size,
      activeRevision: this.activeRevision,
      shapeCount: this.activeSnapshot?.shapes.length ?? 0,
      docRevision: adapter?.getDocRevision() ?? null,
      loadedPages: adapter ? adapter.getLoadedPages().length : 0,
    };
    if (cur.retained.pages !== retained.pages || cur.retained.shapes !== retained.shapes) patch.retained = retained;
    uiStore.patch(patch);
  }

  private emit(type: StandEventType, detail: Record<string, unknown>): void {
    const e: StandEvent = { t: performance.now(), type, detail };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (this.waiters.length === 0) return;
    const pending = this.waiters.slice();
    for (const w of pending) {
      if (w.type !== type) continue;
      if (w.predicate && !w.predicate(e)) continue;
      clearTimeout(w.timer);
      const idx = this.waiters.indexOf(w);
      if (idx >= 0) this.waiters.splice(idx, 1);
      w.resolve(e);
    }
  }
}

async function deleteAllIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  let names: string[] = [];
  try {
    if (typeof indexedDB.databases === 'function') {
      names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => Boolean(n));
    }
  } catch {
    return;
  }
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        }),
    ),
  );
}

declare global {
  interface Window {
    __stand: StandGlobal & { transfer: { bytesIn: number; bytesOut: number; requests: number } };
    __standController: StandController;
  }
}

/** Создаёт контроллер и публикует `window.__stand` (SPEC §4.2). */
export function installStand(): StandController {
  const controller = new StandController(parseConfig());
  const global: Window['__stand'] = {
    config: controller.config,
    get state() {
      return controller.state;
    },
    get activePageId() {
      return controller.activePage;
    },
    get activeRevision() {
      return controller.activeRevision;
    },
    get drawn() {
      return controller.drawn;
    },
    get pendingCommands() {
      return controller.pendingCommands;
    },
    get events() {
      return controller.events;
    },
    get transfer() {
      return controller.transfer;
    },
    waitFor: (type, predicate, timeoutMs, since?: number) => controller.waitFor(type, predicate, timeoutMs, since),
    selectPage: (pageId) => controller.selectPage(pageId),
    runCommand: (cmd) => controller.runCommand(cmd),
    getRetained: () => controller.getRetained(),
    getRetainedAsync: () => controller.getRetainedAsync(),
    getPageSnapshot: (pageId) => controller.getPageSnapshot(pageId),
    getLoadedPages: () => controller.getLoadedPages(),
    getCommandTimings: () => controller.getCommandTimings(),
    logout: () => controller.logout(),
  };
  window.__stand = global;
  window.__standController = controller;
  return controller;
}
