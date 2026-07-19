// What counts as an importable image or document, stated once so the file picker
// (Toolbar) and the canvas drop target (BoardCanvas) agree — the same reasoning as
// the email pair in ../email/files.ts.
//
// The two sets are deliberately disjoint, and neither claims `.txt`: that stays with
// email import, so a dropped `.txt` still opens the email flow, not a document card.
// The extractor sniffs the real bytes (magic numbers), so these extensions are a UI
// filter, not the authority on format.

export const IMAGE_FILE_ACCEPT =
  'image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.tiff,.tif,.bmp,.avif,.svg';

export const DOCUMENT_FILE_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|avif|svg)$/i;
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|pptx?)$/i;
// Video and audio aren't importable as their own cards — they arrive as email
// attachments — but the Objects view still wants to show what each file is, so
// its icon can be picked by type (see lib/mediaIcon).
const VIDEO_EXT = /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|mpe?g|3gp)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|oga|opus|wma)$/i;

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

/** Whether a file is one this importer handles at all (image or document). */
export function isMediaFile(name: string): boolean {
  return isImageFile(name) || isDocumentFile(name);
}

// The MIME to record on a document card. Picked/dropped bytes reach us as
// PickedFile (name + bytes) with no File.type, so it is derived from the extension.
// Only documents need this — an image's type never has to be named to display it.
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
