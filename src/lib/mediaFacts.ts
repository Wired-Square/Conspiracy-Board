import type { DocumentMeta, ImageMeta } from '../types/board';
import { formatOccurredAt } from './dates';

// A file's metadata as display rows for MetaList, pre-formatted.

type Facts = [string, string][];

/** A photo's EXIF as display rows: size, when, camera, where. */
export function imageFacts(m: ImageMeta): Facts {
  const facts: Facts = [];
  if (m.width && m.height) facts.push(['Size', `${m.width} × ${m.height}`]);
  if (m.takenAt) facts.push(['Taken', formatOccurredAt(m.takenAt, 'day')]);
  const camera = [m.cameraMake, m.cameraModel].filter(Boolean).join(' ').trim();
  if (camera) facts.push(['Camera', camera]);
  if (m.latitude != null && m.longitude != null) {
    facts.push(['Location', `${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`]);
  }
  return facts;
}

/** A document's properties as display rows. */
export function documentFacts(doc: DocumentMeta): Facts {
  const facts: Facts = [];
  if (doc.title) facts.push(['Title', doc.title]);
  if (doc.author) facts.push(['Author', doc.author]);
  if (doc.pages != null) facts.push(['Pages', String(doc.pages)]);
  if (doc.words != null) facts.push(['Words', doc.words.toLocaleString('en-AU')]);
  if (doc.created) facts.push(['Created', formatOccurredAt(doc.created, 'day')]);
  if (doc.modified) facts.push(['Modified', formatOccurredAt(doc.modified, 'day')]);
  return facts;
}
