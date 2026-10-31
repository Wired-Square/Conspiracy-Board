import { Show } from 'solid-js';
import { jobsStore } from '../store/jobsStore';
import { fromStore } from './fromStore';

// A small, non-blocking pill that background indexing is running — the search index
// reading text out of imported files. Unlike BusyOverlay, it never covers the screen:
// the user keeps working while files are read. Shows nothing when idle.
export function BackgroundTaskIndicator() {
  const pending = fromStore(jobsStore, (s) => s.pending);
  return (
    <Show when={pending() > 0}>
      <div class="task-indicator" role="status" aria-live="polite">
        <span class="spinner spinner--small" aria-hidden="true" />
        <span>{`Indexing ${pending()} ${pending() === 1 ? 'file' : 'files'}…`}</span>
      </div>
    </Show>
  );
}
