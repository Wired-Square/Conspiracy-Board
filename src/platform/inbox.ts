import { b64ToBytes } from '../lib/base64';
import { isEmailFile } from '../lib/email/files';
import { isMediaFile } from '../lib/import/files';
import { useBoardStore } from '../store/boardStore';
import { NEW_CLUSTER, useEmailImportStore } from '../store/emailImportStore';
import { useTauriListen } from './useTauriListen';

// Files the shell sweeps out of the Inbox folder (src-tauri/src/board_store.rs).
//
// The folder is the way in for what a webview drop can't take. Dragging a whole
// Mail conversation onto the page hands it only plain text — the messages never
// arrive — but dragging that same conversation to a Finder folder writes one .eml
// per message, because Finder can fulfil the promise the webview can't. Dropping a
// screenshot or a PDF into Finder is just as easy, and the shell forwards those too.
// So each set takes the same path a drop on the board does: email opens the import
// preview, images and documents import straight to cards.

type InboxFile = { name: string; b64: string };
type InboxBatch = { files: InboxFile[] };

async function filesArrived({ files }: InboxBatch) {
  if (!files.length) return;
  const picked = files.map((f) => ({ name: f.name, bytes: b64ToBytes(f.b64) }));
  // Route each set independently — a batch may mix a thread with a screenshot —
  // exactly as BoardCanvas.handleDrop does for a drop on the board.
  const emails = picked.filter((f) => isEmailFile(f.name));
  const media = picked.filter((f) => isMediaFile(f.name));

  if (media.length) await useBoardStore.getState().addImportedMedia(media);

  if (emails.length) {
    const store = useEmailImportStore.getState();
    store.openWith();
    // A folder batch is usually a whole thread, so group it into a fresh cluster by
    // default; a lone message stays ungrouped. The modal lets the user change either.
    store.setClusterId(emails.length > 1 ? NEW_CLUSTER : null);
    await store.parseFiles(emails);
  }
}

/** Import the files the shell finds in the Inbox folder. */
export function useInbox() {
  useTauriListen<InboxBatch>('inbox-files', (e) => void filesArrived(e.payload));
}
