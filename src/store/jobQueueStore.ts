import { create } from 'zustand';
import { storage } from '../storage';

// The background worker for the search index: it turns imported files into searchable
// text off the UI thread, so dropping a thousand emails at once neither freezes the
// window nor waits on OCR before a card appears. The queue holds media names; a bounded
// number are read at once (extraction is CPU work in the shell, parallel across its
// command threads). It is a rebuildable projection — `resume()` asks the shell what
// still needs indexing, so a crash mid-batch simply picks up again — and idempotent per
// content hash, so enqueuing the same file twice is harmless.

/** How many files are read at once. Small: extraction is CPU-bound in the shell, and
 *  the point is to stay out of the way, not to saturate the machine. */
const CONCURRENCY = 3;

type JobQueueState = {
  queue: string[];
  inFlight: string[];
  /** Names to reprocess even if already indexed (a manual reindex, or a newer engine). */
  force: Set<string>;
  done: number;
  failed: number;
  /** Add media names to process. `force` reindexes them even if already done. */
  enqueue: (names: string[], opts?: { force?: boolean }) => void;
  /** Ask the shell what still needs indexing and queue it — the startup/backstop path. */
  resume: () => Promise<void>;
  /** Reindex every media file (force), for the Objects view's "rebuild" action. */
  reindexAll: () => Promise<void>;
};

/** Files queued or running — what the indicator shows; 0 when idle. A number, so a
 *  component selecting it re-renders only when the count changes. */
export const jobsPending = (s: JobQueueState): number => s.queue.length + s.inFlight.length;

export const useJobQueueStore = create<JobQueueState>((set, get) => {
  const runOne = (name: string) => {
    const forced = get().force.has(name);
    storage
      .processMedia(name, forced)
      .then((r) => set((s) => ({ failed: s.failed + (r.status === 'failed' ? 1 : 0) })))
      .catch(() => set((s) => ({ failed: s.failed + 1 })))
      .finally(() => {
        set((s) => {
          // Clone the set only when this name is in it, so a non-forced job (the common
          // case) doesn't churn a fresh Set on every completion.
          let force = s.force;
          if (force.has(name)) {
            force = new Set(force);
            force.delete(name);
          }
          return { inFlight: s.inFlight.filter((n) => n !== name), force, done: s.done + 1 };
        });
        pump();
      });
  };

  const pump = () => {
    const { queue, inFlight } = get();
    const room = CONCURRENCY - inFlight.length;
    if (room <= 0 || queue.length === 0) return;
    const take = queue.slice(0, room);
    set((s) => ({ queue: s.queue.slice(take.length), inFlight: [...s.inFlight, ...take] }));
    take.forEach(runOne);
  };

  return {
    queue: [],
    inFlight: [],
    force: new Set(),
    done: 0,
    failed: 0,

    enqueue: (names, opts) => {
      if (names.length === 0) return;
      const known = new Set([...get().queue, ...get().inFlight]);
      const fresh = names.filter((n) => !known.has(n));
      if (fresh.length === 0 && !opts?.force) return;
      set((s) => ({
        queue: fresh.length ? [...s.queue, ...fresh] : s.queue,
        force: opts?.force ? new Set([...s.force, ...names]) : s.force,
      }));
      pump();
    },

    resume: async () => {
      get().enqueue(await storage.pendingMedia());
    },

    reindexAll: async () => {
      const media = await storage.listMedia();
      get().enqueue(
        media.map((m) => m.name),
        { force: true },
      );
    },
  };
});
