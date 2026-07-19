import { jobsPending, useJobQueueStore } from '../../store/jobQueueStore';

// A small, non-blocking pill that background indexing is running — the search index
// reading text out of imported files. Unlike BusyOverlay, it never covers the screen:
// the user keeps working while files are read. Subscribes to the queue count alone, so
// it re-renders only as that number changes, and shows nothing when idle.
export function BackgroundTaskIndicator() {
  const pending = useJobQueueStore(jobsPending);
  if (pending === 0) return null;
  return (
    <div className="task-indicator" role="status" aria-live="polite">
      <span className="spinner spinner--small" aria-hidden />
      <span>{`Indexing ${pending} ${pending === 1 ? 'file' : 'files'}…`}</span>
    </div>
  );
}
