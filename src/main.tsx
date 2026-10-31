/** @jsxImportSource react */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@wired-square/canvas/canvas.css';
import './index.css';
import App from './App';

// Awaited so the harness's console capture is in place before the first render.
if (import.meta.env.DEV) await import('./harness/start');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
