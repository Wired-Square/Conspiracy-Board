// A screenshot of a text-message thread is the practical way to get a conversation
// onto the board — there's no clean iMessage/SMS export — and the shell reads the
// words back out of it with Vision (storage.ocrImage). But not every imported image
// is a screenshot: a photo carries no text at all, or only the incidental word on a
// sign, and dropping that into a card's notes would be noise. So recognised text is
// kept only when it looks like captured writing — a few words, not a stray fragment.

const MIN_WORDS = 3;
const MIN_CHARS = 12;

/** Whether recognised text is worth keeping as a card's notes. */
export function usableOcr(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.replace(/\s/g, '').length < MIN_CHARS) return false;
  // `trimmed` is non-empty with no edge whitespace, so the split yields no blanks.
  return trimmed.split(/\s+/).length >= MIN_WORDS;
}

/**
 * A one-line card title from recognised text: the first non-empty line, tidied and
 * capped — a screenshot titled by its opening message reads far better than IMG_1234.
 */
export function ocrTitle(text: string, max = 60): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
