import { useState } from 'react';
import type { StandController } from '../stand';
import type { UiState } from '../ui-store';

export function FillPanel({ controller, ui }: { controller: StandController; ui: UiState }) {
  const [color, setColor] = useState('#ff8800');
  const sel = ui.selected;
  const sourceTarget = sel ? (sel.isSource ? sel.id : sel.sourceId) : null;
  return (
    <div className="fill-panel" data-testid="fill-panel">
      <div className="panel-title">Заливка</div>
      <div className="selected" data-testid="selected-shape" data-shape-id={sel?.id ?? ''}>
        {sel ? (
          <>
            <div>
              <b>{sel.kind}</b> <code>{sel.id}</code>
            </div>
            <div>
              fill <span className="swatch" style={{ background: sel.fill }} /> {sel.fill}
              {sel.fillOverridden ? ' (переопределена)' : ''}
            </div>
            <div>{sel.isSource ? 'источник' : sel.sourceId ? `экземпляр ${sel.sourceId}` : 'обычная фигура'}</div>
          </>
        ) : (
          <span className="muted">Кликните по фигуре на холсте</span>
        )}
      </div>
      <label className="color-row">
        Цвет
        <input type="color" value={color} data-testid="fill-color" onChange={(e) => setColor(e.target.value)} />
        <code>{color}</code>
      </label>
      <div className="buttons">
        <button
          type="button"
          data-action="local-fill"
          disabled={!sel || ui.pending > 0}
          onClick={() => void controller.localFill(color).catch(() => undefined)}
        >
          Local fill
        </button>
        <button
          type="button"
          data-action="source-fill"
          disabled={!sourceTarget || ui.pending > 0}
          title={sourceTarget ? `источник ${sourceTarget}` : 'выделите источник или экземпляр'}
          onClick={() => void controller.sourceFill(color).catch(() => undefined)}
        >
          Source fill
        </button>
      </div>
      <div className="buttons">
        <button type="button" data-action="reset-camera" onClick={() => controller.resetCamera()}>
          Сброс камеры
        </button>
      </div>
    </div>
  );
}
