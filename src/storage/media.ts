import type { CSSProperties } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImageCrop } from '../types/board';
import { storage } from './index';

// Turning a stored media filename into something an <img> or a link can load.
//
// Media lives in a directory the webview cannot know the path of — it is the
// shell's to decide (see src-tauri/src/board_store.rs). The shell tells us once,
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

// A stable identity for the no-crop case, so an uncropped <img> is handed the same
// object every render rather than a fresh {} each time.
const NO_CROP: CSSProperties = {};

/**
 * The picture's crop as an inline style for its `<img>`, or `NO_CROP` for the
 * default centre cover. The render site must give the image a clip box —
 * `position: relative; overflow: hidden` with a definite height — because a crop
 * positions the image absolutely inside it. The saved region is 4:3: in a 4:3 box
 * (the polaroid, the editor preview) it lands exactly; in a box of another shape
 * (the 34px record thumb) it fills the width and is clipped in height. No pixel
 * size is needed at render — the image is sized so the crop's width fills the box
 * and shifted by its offset, both as percentages of the box. The one place the crop
 * becomes CSS, so every render site is a single spread and none re-derives it.
 */
export function cardImageStyle(card: { imageCrop: ImageCrop | null }): CSSProperties {
  const c = card.imageCrop;
  if (!c) return NO_CROP;
  return {
    position: 'absolute',
    left: `calc(${-c.x} / ${c.w} * 100%)`,
    top: `calc(${-c.y} / ${c.h} * 100%)`,
    width: `calc(100% / ${c.w})`,
    height: 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
  };
}

/**
 * An extension for naming a stored media file: from the filename if it has one,
 * else from the mime type. The shell sanitises it further; this only has to get
 * close. 'bin' when there is nothing to go on.
 */
export function extOf(name?: string, mime?: string): string {
  const dot = name ? name.lastIndexOf('.') : -1;
  const fromName = dot > 0 ? name!.slice(dot + 1) : '';
  if (fromName) return fromName;
  const sub = mime?.split('/')[1]?.split(/[;+]/)[0] ?? '';
  return sub || 'bin';
}

/**
 * Save a picked browser File to the media library, returning its content-hash
 * name to link from a card. The one place the File → (bytes, ext) → saveMedia
 * composition lives, so every "attach a file" affordance is a single call.
 */
export function saveFile(file: File): Promise<string> {
  return file.arrayBuffer().then((bytes) => storage.saveMedia(bytes, extOf(file.name, file.type)));
}

/** The last path segment of a URL, for naming a download's extension; '' if the
 *  URL won't parse. A host that omits Content-Type still often has it in the path. */
function urlBasename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf('/') + 1);
  } catch {
    return '';
  }
}

/**
 * The extension to store a fetched image under: the server's media type is the
 * authority; the URL path is only a fallback for a host that declared none
 * (`fetch_image` having accepted it regardless). Shared by `downloadImage` and the
 * image dialog's URL path so the rule is spelled once.
 */
export function extForFetched(url: string, mime?: string): string {
  return mime ? extOf(undefined, mime) : extOf(urlBasename(url));
}

/**
 * Download a remote image URL into the media library, returning its content-hash
 * name to link from a card — the URL counterpart to `saveFile`. The fetch happens
 * in the shell (`storage.fetchImage`).
 */
export async function downloadImage(url: string): Promise<string> {
  const { bytes, mime } = await storage.fetchImage(url);
  return storage.saveMedia(bytes, extForFetched(url, mime));
}
