import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { DRAFT_COMMIT_MS, drafts } from '../lib/drafts';

/** The Solid twin of hooks/useDraft: a typed field's local copy of `value`, committed when typing pauses, on flush and on cleanup. */
export function createDraft<T>(value: Accessor<T>, commit: (draft: T) => void): [Accessor<T>, (draft: T) => void, () => void] {
  const [draft, setDraft] = createSignal(value());
  let pending: { draft: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    drafts.release(flush);
    const staged = pending;
    pending = null;
    if (staged) commit(staged.draft);
  };

  const change = (next: T) => {
    setDraft(() => next);
    pending = { draft: next };
    drafts.hold(flush);
    clearTimeout(timer);
    timer = setTimeout(flush, DRAFT_COMMIT_MS);
  };

  createEffect(
    on(value, (v) => {
      if (!pending) setDraft(() => v);
    }, { defer: true }),
  );
  onCleanup(flush);

  return [draft, change, flush];
}
