import type { DocumentMeta, RetainedStats, ShapeKind } from '@stand/shared';

export type StandState = 'idle' | 'loading' | 'ready' | 'error';
export type Phase = 'boot' | 'login' | 'app';

export interface SelectedShapeInfo {
  id: string;
  pageId: string;
  kind: ShapeKind;
  fill: string;
  isSource: boolean;
  sourceId: string | null;
  fillOverridden: boolean;
}

/** Состояние интерфейса (не данных): выбранная страница, выделение, индикаторы. */
export interface UiState {
  phase: Phase;
  loginError: string | null;
  userId: string | null;
  meta: DocumentMeta | null;
  activePageId: string | null;
  state: StandState;
  pending: number;
  activeRevision: number | null;
  shapeCount: number;
  docRevision: number | null;
  selected: SelectedShapeInfo | null;
  lastError: string | null;
  retained: RetainedStats;
  loadedPages: number;
  lastDrawMs: number;
}

const initial: UiState = {
  phase: 'boot',
  loginError: null,
  userId: null,
  meta: null,
  activePageId: null,
  state: 'idle',
  pending: 0,
  activeRevision: null,
  shapeCount: 0,
  docRevision: null,
  selected: null,
  lastError: null,
  retained: { pages: 0, shapes: 0, bytesEstimate: 0 },
  loadedPages: 0,
  lastDrawMs: 0,
};

type Listener = () => void;

class UiStore {
  private snapshot: UiState = initial;
  private readonly listeners = new Set<Listener>();

  getSnapshot = (): UiState => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  patch(partial: Partial<UiState>): void {
    let changed = false;
    for (const k of Object.keys(partial) as Array<keyof UiState>) {
      if (this.snapshot[k] !== partial[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...partial };
    for (const l of this.listeners) l();
  }

  reset(next: Partial<UiState> = {}): void {
    this.snapshot = { ...initial, ...next };
    for (const l of this.listeners) l();
  }
}

export const uiStore = new UiStore();
