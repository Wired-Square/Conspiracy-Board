// What counts as an email file, stated once so the file picker and the canvas
// drop target agree. They previously disagreed: an mbox named .txt was
// importable via the picker but silently ignored on drop.
//
// The parser sniffs content rather than trusting the extension (see
// parseEmailFile), so these are a UI filter, not the authority on format.

export const EMAIL_FILE_ACCEPT =
  '.eml,.mbox,.txt,message/rfc822,application/mbox';

const EMAIL_FILE_EXT = /\.(eml|mbox|txt)$/i;

export function isEmailFile(name: string): boolean {
  return EMAIL_FILE_EXT.test(name);
}
