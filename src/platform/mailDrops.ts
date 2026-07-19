import { MAIL_BODY_FAILED, messageIdFromUrl } from '../lib/email/mailDrag';
import { emailCardsByMessageId, matchDraft } from '../lib/email/meta';
import { parseEmailFile } from '../lib/email/parseEmails';
import { persistDraftMedia } from '../lib/email/persistMedia';
import { b64ToBytes } from '../lib/base64';
import { useBoardStore } from '../store/boardStore';
import { useTauriListen } from './useTauriListen';

// Where a message dragged out of Apple Mail arrives with its body.
//
// The drag itself only tells the page the subject and a message: URL — the body
// is never offered to a webview. Mail does put a file promise for the whole .eml
// on the dragging pasteboard, though, and src-tauri/src/mail_drag.rs takes
// delivery and sends the bytes over. This is where they land.
//
// By then the card already exists — the ordinary HTML5 drop made it. Handing the
// parsed message to addCards *completes* that card in place instead of adding a
// second one, because the .eml's Message-ID is the one the card recorded off the
// message: URL. So there is no import rule here, and nothing to keep in step
// with the import modal: this is the plain .eml import, arriving on its own.

// emlFile: the whole .eml, which the shell kept for us (named by content hash),
// so this side links its name rather than writing the same bytes a second time.
// Empty when keeping it failed — the card is still made from b64.
type MailDropped = { name: string; b64: string; emlFile: string };
type MailDropFailed = { url: string; reason: string };

async function messageArrived({ name, b64, emlFile }: MailDropped) {
  // The parser is given bytes, never a string: a message can only be decoded with
  // its declared charset, and a string has already guessed.
  const { drafts, errors } = await parseEmailFile(name, b64ToBytes(b64));
  const { addCards, selectCard, setError } = useBoardStore.getState();

  if (!drafts.length) {
    // The card is still sitting there saying it's fetching, so a silent failure
    // would leave it lying. Errors here mean Mail gave us something unparseable.
    setError(errors[0] ?? `Couldn’t read the message Mail sent for “${name}”.`);
    return;
  }

  // The shell already kept the whole .eml — take its name rather than sending the
  // same bytes back to be written again. Then persist the picture and attachments
  // the parser pulled out (those the shell does not know about) and drop the
  // transient bytes, leaving a plain card draft.
  if (emlFile) drafts.forEach((d) => (d.email.emlFile = emlFile));
  const persisted = await Promise.all(drafts.map(persistDraftMedia));

  // Open it in the editor. Dragging a message over is the user picking this one
  // out, and what they reach for next is a cluster or a piece of string. The
  // drop selected the stub already, but bringing the window forward from Mail
  // means a click on the pane, which clears that — and the card is only worth
  // looking at now anyway.
  const [cardId] = addCards(persisted);
  if (cardId) selectCard(cardId);
}

/** Correct the card that is still promising a body it is never going to get. */
function messageFailed({ url, reason }: MailDropFailed) {
  const { cards, updateCard, setError } = useBoardStore.getState();
  // Asked the same way the arriving message asks it, so the two paths cannot
  // disagree about which card a Message-ID belongs to, or when it may be
  // rewritten. A message that failed is one that would have completed.
  const match = matchDraft(
    { email: { messageId: messageIdFromUrl(url) } },
    emailCardsByMessageId(cards),
  );

  if (match.kind === 'completes') updateCard(match.card.id, { notes: MAIL_BODY_FAILED });
  else setError(reason); // No card to correct — say it out loud instead.
}

/** Listen for messages the shell fetches out of Mail. */
export function useMailDrops() {
  useTauriListen<MailDropped>('mail-drop', (e) => void messageArrived(e.payload));
  useTauriListen<MailDropFailed>('mail-drop-failed', (e) => messageFailed(e.payload));
}
