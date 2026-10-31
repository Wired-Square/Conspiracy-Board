import { useCallback, useEffect, useRef, useState } from 'react';
import { DRAFT_COMMIT_MS, drafts } from '../lib/drafts';

/**
 * A typed field's local copy of `value`, so a keystroke never crosses to the shell:
 * the draft shows at once and `commit` runs when typing pauses, on `flush` (blur)
 * and on unmount. A change to `value` from elsewhere shows while nothing is pending.
 */
export function useDraft<T>(value: T, commit: (draft: T) => void): [T, (draft: T) => void, () => void] {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ draft: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestCommit = useRef(commit);
  useEffect(() => {
    latestCommit.current = commit;
  });

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    drafts.release(flush);
    const staged = pending.current;
    pending.current = null;
    if (staged) latestCommit.current(staged.draft);
  }, []);

  const change = useCallback(
    (next: T) => {
      setDraft(next);
      pending.current = { draft: next };
      drafts.hold(flush);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DRAFT_COMMIT_MS);
    },
    [flush],
  );

  useEffect(() => {
    if (!pending.current) setDraft(value);
  }, [value]);
  useEffect(() => flush, [flush]);

  return [draft, change, flush];
}
