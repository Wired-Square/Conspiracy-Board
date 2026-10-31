export const DRAFT_COMMIT_MS = 300;

const pending = new Set<() => void>();

/** Text drafts waiting to commit (see useDraft), so a board undo can commit them first. */
export const drafts = {
  hold: (flush: () => void) => pending.add(flush),
  release: (flush: () => void) => pending.delete(flush),
  flushAll: () => [...pending].forEach((flush) => flush()),
};
