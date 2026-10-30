// Every file-type rule the web side applies, stated once so the pickers, the Inbox
// router and the Objects view agree. Rust's Inbox filter (`is_inbox_file`) mirrors
// the email, image and document sets.
//
// The image and document sets are deliberately disjoint, and neither claims `.txt`:
// that stays with email, so a `.txt` still opens the email flow, not a document card.
// The parser and the extractor sniff the real bytes, so these extensions are a UI
// filter, not the authority on format.

export const EMAIL_FILE_ACCEPT = '.eml,.mbox,.txt,message/rfc822,application/mbox';

export const IMAGE_FILE_ACCEPT =
  'image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.tiff,.tif,.bmp,.avif,.svg';

export const DOCUMENT_FILE_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf';

const EMAIL_EXT = /\.(eml|mbox|txt)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|avif|svg)$/i;
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|pptx?)$/i;
// Video and audio aren't importable as their own cards — they arrive as email
// attachments — but the Objects view still picks their icon by type.
const VIDEO_EXT = /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|mpe?g|3gp)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|oga|opus|wma)$/i;

export function isEmailFile(name: string): boolean {
  return EMAIL_EXT.test(name);
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function isDocumentFile(name: string): boolean {
  return DOCUMENT_EXT.test(name);
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT.test(name);
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXT.test(name);
}

/** Whether a file imports straight to a card (image or document). */
export function isMediaFile(name: string): boolean {
  return isImageFile(name) || isDocumentFile(name);
}

// Picked bytes reach us as a PickedFile (name + bytes) with no File.type, so a
// document card's MIME is derived from the extension. An image's never has to be named.
const DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function documentMime(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? DOCUMENT_MIME[name.slice(dot + 1).toLowerCase()] : undefined;
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
