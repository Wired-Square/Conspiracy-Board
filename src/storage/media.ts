import { convertFileSrc } from '@tauri-apps/api/core';

// Media files by name: resolving one for an <img> or a link.
//
// Media lives in a directory the webview cannot know the path of — it is the
// shell's to decide (see src-tauri/src/board_store/media.rs). The shell tells us once,
// at startup (tauriStorage.init), and we cache it here so resolving a name is a
// synchronous string build at render time rather than an await in every node.

let mediaDir = '';

/** Called once during storage.init with the shell's absolute media directory. */
export function setMediaDir(dir: string) {
  mediaDir = dir;
}

/**
 * An `asset:` URL the webview may load, for a media file by name. Empty before
 * init has run, but nothing renders a card until init has resolved, so callers
 * never see that window.
 */
export function mediaSrc(name: string): string {
  return convertFileSrc(`${mediaDir}/${name}`);
}

/**
 * The picture to show for a card: the local file if it has one, else a remote
 * URL, else nothing. The one place the imageFile/imageUrl split is resolved, so
 * every render site stays a single call and none of them re-derives the rule.
 */
export function cardImageSrc(card: {
  imageFile: string | null;
  imageUrl: string | null;
}): string | null {
  return card.imageFile ? mediaSrc(card.imageFile) : card.imageUrl;
}
