import type { PageSnapshot, Shape } from '@stand/shared';

export interface DrawInfo {
  pageId: string;
  revision: number;
  shapeCount: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const CANVAS_CSS_WIDTH = 1280;
export const CANVAS_CSS_HEIGHT = 720;
const TEXT_FONT = '14px sans-serif';

/**
 * Единственный модуль отрисовки (Canvas 2D), одинаковый для всех адаптеров (SPEC §4):
 * рисует ТОЛЬКО активную страницу — фигуры в порядке z (rect / ellipse / text с фиксированным шрифтом),
 * перед отрисовкой очищает холст. Выделение и камера ссылаются на идентификаторы/координаты,
 * а не на объекты фигур, поэтому переживают обновление данных.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private snapshot: PageSnapshot | null = null;
  private selectedId: string | null = null;
  private readonly camera: Camera = { x: 0, y: 0, scale: 1 };
  /** отсортированный по z массив кешируется по идентичности массива фигур */
  private readonly sortedCache = new WeakMap<Shape[], Shape[]>();
  /** статистика последней отрисовки (для отладки производительности) */
  lastDrawMs = 0;

  attach(canvas: HTMLCanvasElement): void {
    this.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    canvas.width = Math.round(CANVAS_CSS_WIDTH * this.dpr);
    canvas.height = Math.round(CANVAS_CSS_HEIGHT * this.dpr);
    canvas.style.width = `${CANVAS_CSS_WIDTH}px`;
    canvas.style.height = `${CANVAS_CSS_HEIGHT}px`;
    this.ctx = canvas.getContext('2d', { alpha: false });
  }

  detach(): void {
    this.ctx = null;
  }

  isAttached(): boolean {
    return this.ctx !== null;
  }

  setSnapshot(snap: PageSnapshot | null): void {
    this.snapshot = snap;
  }

  getSnapshot(): PageSnapshot | null {
    return this.snapshot;
  }

  setSelection(id: string | null): void {
    this.selectedId = id;
  }

  getSelection(): string | null {
    return this.selectedId;
  }

  getCamera(): Readonly<Camera> {
    return this.camera;
  }

  setCamera(next: Partial<Camera>): void {
    if (next.x !== undefined) this.camera.x = next.x;
    if (next.y !== undefined) this.camera.y = next.y;
    if (next.scale !== undefined) this.camera.scale = Math.min(8, Math.max(0.1, next.scale));
  }

  resetCamera(): void {
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.scale = 1;
  }

  /** Фигуры активной страницы в порядке z (кешируется). */
  private sorted(shapes: Shape[]): Shape[] {
    let s = this.sortedCache.get(shapes);
    if (!s) {
      s = shapes.slice().sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.sortedCache.set(shapes, s);
    }
    return s;
  }

  /** Полная отрисовка. Возвращает описание нарисованного снимка (null — холст пуст). */
  draw(): DrawInfo | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const t0 = performance.now();
    const { dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_CSS_WIDTH, CANVAS_CSS_HEIGHT);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_CSS_WIDTH, CANVAS_CSS_HEIGHT);

    const snap = this.snapshot;
    if (!snap) {
      this.lastDrawMs = performance.now() - t0;
      return null;
    }
    const cam = this.camera;
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.scale, cam.scale);
    ctx.font = TEXT_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1 / cam.scale;

    const shapes = this.sorted(snap.shapes);
    let selected: Shape | null = null;
    for (let i = 0; i < shapes.length; i += 1) {
      const s = shapes[i] as Shape;
      ctx.fillStyle = s.fill;
      switch (s.kind) {
        case 'rect':
          ctx.fillRect(s.x, s.y, s.w, s.h);
          break;
        case 'ellipse':
          ctx.beginPath();
          ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(0.5, s.w / 2), Math.max(0.5, s.h / 2), 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'text':
          ctx.fillText(s.text ?? '', s.x, s.y + s.h / 2, Math.max(1, s.w));
          break;
      }
      if (s.isSource) {
        ctx.strokeStyle = '#222222';
        ctx.strokeRect(s.x, s.y, s.w, s.h);
      }
      if (s.id === this.selectedId) selected = s;
    }
    if (selected) {
      ctx.strokeStyle = '#1e90ff';
      ctx.lineWidth = 2 / cam.scale;
      ctx.setLineDash([6 / cam.scale, 4 / cam.scale]);
      ctx.strokeRect(selected.x - 2, selected.y - 2, selected.w + 4, selected.h + 4);
      ctx.setLineDash([]);
    }
    this.lastDrawMs = performance.now() - t0;
    return { pageId: snap.pageId, revision: snap.revision, shapeCount: snap.shapes.length };
  }

  /** Перевод CSS‑координат холста в координаты документа. */
  toWorld(cssX: number, cssY: number): { x: number; y: number } {
    const cam = this.camera;
    return { x: (cssX - cam.x) / cam.scale, y: (cssY - cam.y) / cam.scale };
  }

  /** Попадание по координатам холста (CSS‑px): верхняя по z фигура или null. */
  hitTest(cssX: number, cssY: number): Shape | null {
    const snap = this.snapshot;
    if (!snap) return null;
    const { x, y } = this.toWorld(cssX, cssY);
    const shapes = this.sorted(snap.shapes);
    for (let i = shapes.length - 1; i >= 0; i -= 1) {
      const s = shapes[i] as Shape;
      if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) continue;
      if (s.kind === 'ellipse') {
        const rx = s.w / 2;
        const ry = s.h / 2;
        const dx = (x - (s.x + rx)) / (rx || 1);
        const dy = (y - (s.y + ry)) / (ry || 1);
        if (dx * dx + dy * dy > 1) continue;
      }
      return s;
    }
    return null;
  }

  findShape(id: string): Shape | null {
    const snap = this.snapshot;
    if (!snap) return null;
    for (let i = 0; i < snap.shapes.length; i += 1) {
      const s = snap.shapes[i] as Shape;
      if (s.id === id) return s;
    }
    return null;
  }
}
