import type { DocumentMeta, ImageMeta } from '../../types/board';
import type { MediaMeta } from '../../storage/StorageAdapter';

// Shaping the shell's flat `MediaMeta` (a superset of every format's fields) into
// the half a card actually carries. One place per card kind, so the "what a card
// keeps from its file" rule is spelled once — both the drop-import path and the
// editor's attach path build through these rather than each copying the fields.

// The shell returns a field a file doesn't carry as null (Rust Option → JSON null),
// not undefined. A null must never reach a card: the schema's optional() fields
// reject it, and one such field makes the whole board fail to load. So both pickers
// keep only present (non-null, non-undefined) values.

type DocMeta = Pick<DocumentMeta, 'title' | 'author' | 'created' | 'modified' | 'pages' | 'words'>;

/** The document half, to spread into a `DocumentMeta` beside `file`/`name`/`mime`. */
export function pickDocumentMeta(m: MediaMeta): DocMeta {
  const d: DocMeta = {};
  if (m.title != null) d.title = m.title;
  if (m.author != null) d.author = m.author;
  if (m.created != null) d.created = m.created;
  if (m.modified != null) d.modified = m.modified;
  if (m.pages != null) d.pages = m.pages;
  if (m.words != null) d.words = m.words;
  return d;
}

/** The image half, or null when a photo carried no EXIF at all. */
export function pickImageMeta(m: MediaMeta): ImageMeta | null {
  const im: ImageMeta = {};
  if (m.width != null) im.width = m.width;
  if (m.height != null) im.height = m.height;
  if (m.takenAt != null) im.takenAt = m.takenAt;
  if (m.cameraMake != null) im.cameraMake = m.cameraMake;
  if (m.cameraModel != null) im.cameraModel = m.cameraModel;
  if (m.latitude != null) im.latitude = m.latitude;
  if (m.longitude != null) im.longitude = m.longitude;
  return Object.keys(im).length ? im : null;
}
