import type { InboxBatch } from '../bindings/InboxBatch';
import { b64ToBytes } from '../lib/base64';
import { boardStore } from '../store/boardStore';
import { emailImportStore, NEW_CLUSTER } from '../store/emailImportStore';
import { listenTauri } from './listen';

// What the shell sweeps out of the Inbox folder (src-tauri/src/board_store/inbox.rs).
//
// The folder is the way in for what a webview drop can't take: dragging a Mail
// conversation to a Finder folder writes one .eml per message, because Finder can
// fulfil the promise the webview can't. The shell parses the email itself, so it
// arrives here as drafts for the import preview; images and documents import
// straight to cards.

async function filesArrived({ files, emails, emailFiles }: InboxBatch) {
  if (files.length) {
    await boardStore.getState().addImportedMedia(files.map((f) => ({ name: f.name, bytes: b64ToBytes(f.b64) })));
  }
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
  return listenTauri<InboxBatch>('inbox-files', (e) => void filesArrived(e.payload));
}
