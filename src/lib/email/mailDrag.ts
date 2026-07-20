// What remains of the Apple Mail drag path. Dragging onto the app is gone —
// mail comes in through the Inbox folder now — but boards written while it
// existed still hold cards with `email.source: 'mail-drag'`, whose body lives
// in Mail rather than in a stored .eml. This keeps the one derivation those
// legacy cards still need: the link that reopens the original message.

/**
 * The `message:` URL that reopens a message in Mail.
 *
 * Derived rather than stored: Mail encodes only the angle brackets, leaving `@`
 * and `.` literal, so the URL is a total function of the Message-ID we already
 * hold. (encodeURIComponent would not do — it escapes `@` too.) This is why the
 * link never needs to live in the card's notes, where a user editing their own
 * prose could delete it.
 */
export function mailUrlFor(messageId: string): string {
  return `message:${messageId.replace('<', '%3C').replace('>', '%3E')}`;
}
