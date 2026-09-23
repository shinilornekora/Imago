import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installStand } from './stand';
import './styles.css';

// Контроллер и window.__stand создаются до React: путь данных от него не зависит.
const controller = installStand();
controller.start();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);
