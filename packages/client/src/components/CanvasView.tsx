import { useEffect, useRef } from 'react';
import { CANVAS_CSS_HEIGHT, CANVAS_CSS_WIDTH } from '../canvas/renderer';
import type { StandController } from '../stand';

/**
 * Обёртка над единственным <canvas>. React лишь монтирует элемент и передаёт его отрисовщику;
 * данные страницы в React не попадают.
 */
export function CanvasView({ controller }: { controller: StandController }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    controller.attachCanvas(canvas);
    return () => controller.detachCanvas();
  }, [controller]);

  return (
    <canvas
      ref={ref}
      className="stage"
      data-testid="stage"
      width={CANVAS_CSS_WIDTH}
      height={CANVAS_CSS_HEIGHT}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        controller.clickAt(e.clientX - rect.left, e.clientY - rect.top);
      }}
      onWheel={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        controller.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }}
      onPointerDown={(e) => {
        if (e.button === 1 || e.button === 2 || e.shiftKey) {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        controller.panBy(e.clientX - d.x, e.clientY - d.y);
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        if (drag.current) {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
