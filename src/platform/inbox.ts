import type { InboxBatch } from '../bindings/InboxBatch';
import { boardStore } from '../store/boardStore';
import { emailImportStore, NEW_CLUSTER } from '../store/emailImportStore';
import { listenTauri } from './listen';

// What the shell sweeps out of the Inbox folder (src-tauri/src/board_store/inbox.rs).
//
// The folder is the way in for what a webview drop can't take: dragging a Mail
// conversation to a Finder folder writes one .eml per message, because Finder can
// fulfil the promise the webview can't. The shell stores every file and hands over
// what it made of them: drafts for the email import preview, and the cards its
// images and documents become, which only need placing.

function filesArrived({ cards, emails, emailFiles }: InboxBatch) {
  boardStore.getState().addImportedMedia(cards);
  if (emailFiles) {
    const store = emailImportStore.getState();
    store.openWith();
    // A folder batch is usually a whole thread, so group it into a fresh cluster by
    // default; a lone message stays ungrouped. The modal lets the user change either.
    store.setClusterId(emailFiles > 1 ? NEW_CLUSTER : null);
    store.stage(emails);
  }
}

/** Import the files the shell finds in the Inbox folder. */
export function startInbox(): () => void {
  return listenTauri<InboxBatch>('inbox-files', (e) => filesArrived(e.payload));
}
