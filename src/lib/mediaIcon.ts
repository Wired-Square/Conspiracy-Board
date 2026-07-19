import type { CardKind } from '../types/board';
import type { CardMediaKind } from '../store/boardMigration';
import { KIND_META } from './kinds';
import { isAudioFile, isImageFile, isVideoFile } from './import/files';

// Which icon a file or a card gets, decided once here rather than in the
// component that draws it — the same reason auditMedia is a pure function: logic
// inside a component is logic nobody checks.
//
// A file's icon is its *type* (a document, an image, a movie, a sound, or the
// message itself), and a paperclip rides in the corner when the file came in on
// an email — provenance, not the base icon.

export type MediaIconType = 'document' | 'image' | 'movie' | 'sound' | 'email' | 'message' | 'call';

export type MediaIconSpec = { type: MediaIconType; attachment: boolean };

/** The base icon for a filename — what kind of thing the bytes are. */
function typeForFile(file: string): MediaIconType {
  if (isVideoFile(file)) return 'movie';
  if (isAudioFile(file)) return 'sound';
  if (isImageFile(file)) return 'image';
  // Everything else — a PDF, an Office file, or an attachment of a kind we don't
  // name — reads as a document; a plain page is the honest "some file" glyph.
  return 'document';
}

/**
 * The icon for a media file in the Objects view. `mediaKind` is the owning card's
 * role for it when there is one (an orphan has none): the `.eml` itself is the
 * message, and anything marked `attachment` rode in on one, which draws the clip.
 */
export function mediaIconFor(file: string, mediaKind?: CardMediaKind): MediaIconSpec {
  if (mediaKind === 'eml') return { type: 'email', attachment: false };
  return { type: typeForFile(file), attachment: mediaKind === 'attachment' };
}

/**
 * The icon for a card by its kind, for the record list and the timeline. Read
 * straight off KIND_META so the mapping lives with every other per-kind fact and
 * a new kind can't be added without deciding its glyph (null where it shows none).
 */
export function mediaIconForKind(kind: CardKind): MediaIconType | null {
  return KIND_META[kind].mediaIcon;
}
