// An mbox is messages concatenated with a "From " (From_) separator line.
//
// The obvious `text.split(/^From /m)` is wrong twice over: it fires on any body
// line that happens to start with "From ", and it leaves mboxrd's ">From "
// escaping in place. Both are handled here.
//
// Matching on "From " plus a blank line before it is *also* not enough: the
// blank line separating headers from body means a body's first line is always
// preceded by one, so "From what I heard…" as an opening sentence would still
// split. A real From_ line is `From <sender> <ctime date>`, so the weekday and
// month are what actually distinguish it from prose.
const FROM_LINE = /^From \S+ +[A-Z][a-z]{2} +[A-Z][a-z]{2} +\d{1,2} /;

/** True if the text looks like an mbox rather than a single .eml. */
export function looksLikeMbox(text: string): boolean {
  return FROM_LINE.test(text.split(/\r?\n/, 1)[0] ?? '');
}

/** Split an mbox into raw RFC-5322 message texts. */
export function splitMbox(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messages: string[] = [];
  let current: string[] | null = null;
  let prevBlank = true; // Start-of-file counts as a separator boundary.

  for (const line of lines) {
    // A From_ line only separates messages at the start of the file or after a
    // blank line; anywhere else it is body text.
    if (FROM_LINE.test(line) && prevBlank) {
      if (current) messages.push(current.join('\n'));
      current = [];
    } else if (current) {
      // mboxrd escapes body lines starting with "From " as ">From ", and
      // pre-existing ">From " as ">>From ". Strip exactly one level.
      current.push(/^>+From /.test(line) ? line.slice(1) : line);
    }
    prevBlank = line.trim() === '';
  }
  if (current) messages.push(current.join('\n'));

  return messages.map((m) => m.trim()).filter((m) => m.length > 0);
}
