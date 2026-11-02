import { render } from 'solid-js/web';
import '@wired-square/canvas/canvas.css';
import '@wired-square/kit/theme.css';
import '@wired-square/kit/kit.css';
import './index.css';
import App from './App';

// Awaited so the harness's console capture is in place before the first render.
if (import.meta.env.DEV) await import('./harness/start');

render(() => <App />, document.getElementById('root')!);
