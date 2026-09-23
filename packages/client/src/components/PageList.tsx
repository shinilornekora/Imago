import { useMemo } from 'react';
import type { StandController } from '../stand';
import type { UiState } from '../ui-store';

export function PageList({ controller, ui }: { controller: StandController; ui: UiState }) {
  const pages = useMemo(() => (ui.meta ? [...ui.meta.pages].sort((a, b) => a.index - b.index) : []), [ui.meta]);
  return (
    <nav className="pages" data-testid="page-list">
      <div className="panel-title">Страницы ({pages.length})</div>
      <div className="page-buttons">
        {pages.map((p) => (
          <button
            type="button"
            key={p.id}
            data-page-id={p.id}
            data-page-index={p.index}
            className={p.id === ui.activePageId ? 'page active' : 'page'}
            aria-current={p.id === ui.activePageId ? 'page' : undefined}
            onClick={() => controller.selectPage(p.id)}
          >
            <span className="page-index">{p.index + 1}</span> {p.name}
          </button>
        ))}
      </div>
    </nav>
  );
}
