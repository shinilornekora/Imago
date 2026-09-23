import type { StandController } from '../stand';
import type { UiState } from '../ui-store';

export function TopBar({ controller, ui }: { controller: StandController; ui: UiState }) {
  const { config } = controller;
  return (
    <header className="topbar">
      <span className="badge" data-testid="adapter-badge" data-adapter={config.adapter} data-mode={config.mode}>
        {config.adapter} / {config.mode}
        {config.mode === 'P' ? ` / cache=${config.cache}` : ''}
      </span>
      <span className="doc" title={config.docId}>
        {ui.meta ? ui.meta.name : config.docId || '—'}
        {ui.docRevision !== null ? ` · rev ${ui.docRevision}` : ''}
      </span>
      <span
        className={`state state-${ui.state}`}
        data-testid="state"
        data-state={ui.state}
        data-pending={ui.pending}
        data-revision={ui.activeRevision ?? ''}
      >
        {ui.state}
        {ui.pending > 0 ? ` · pending ${ui.pending}` : ''}
      </span>
      <span className="stats" data-testid="stats">
        стр. {ui.retained.pages} / фиг. {ui.retained.shapes} · загружено {ui.loadedPages}
        {ui.activeRevision !== null ? ` · активная rev ${ui.activeRevision}, ${ui.shapeCount} фиг.` : ''}
        {` · draw ${ui.lastDrawMs} мс`}
      </span>
      {ui.lastError ? (
        <span className="error" data-testid="last-error" title={ui.lastError}>
          {ui.lastError}
        </span>
      ) : null}
      <span className="spacer" />
      <span className="user">{ui.userId ?? ''}</span>
      <button type="button" data-action="logout" onClick={() => void controller.logout()}>
        Выйти
      </button>
    </header>
  );
}
