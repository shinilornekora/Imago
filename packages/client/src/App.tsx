import { useSyncExternalStore } from 'react';
import { CanvasView } from './components/CanvasView';
import { FillPanel } from './components/FillPanel';
import { LoginForm } from './components/LoginForm';
import { PageList } from './components/PageList';
import { TopBar } from './components/TopBar';
import type { StandController } from './stand';
import { uiStore } from './ui-store';

export function App({ controller }: { controller: StandController }) {
  const ui = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);

  if (ui.phase === 'login') {
    return <LoginForm controller={controller} error={ui.loginError} />;
  }
  if (ui.phase === 'boot') {
    return (
      <div className="boot" data-phase="boot">
        Вход…
      </div>
    );
  }
  return (
    <div className="app" data-phase="app">
      <TopBar controller={controller} ui={ui} />
      <div className="main">
        <aside className="left">
          <PageList controller={controller} ui={ui} />
          <FillPanel controller={controller} ui={ui} />
        </aside>
        <section className="center">
          <CanvasView controller={controller} />
        </section>
      </div>
    </div>
  );
}
