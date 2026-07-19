import { z } from 'zod';
import type { Board } from '../types/board';

/**
 * Read an explicit `null` as "absent". The shell's metadata extractor emits null
 * for a field a file doesn't carry (Rust `Option::None` → JSON `null`), and those
 * nulls land on a card's `imageMeta`/`document`; but the fields are `optional()`,
 * which accepts *missing*, not null. Stripping nulls before validation lets such a
 * board load — and, since the stripped value is what's kept, re-save clean. Without
 * it, one no-EXIF screenshot makes the whole board fail to parse and refuse to open.
 */
function withoutNulls(v: unknown): unknown {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null))
    : v;
}

const vec2 = z.object({ x: z.number(), y: z.number() });

const clusterSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  visible: z.boolean(),
});

const emailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

// Accepts both shapes an attachment has been stored as: a bare filename (every
// board written before attachment bytes were kept) and the object that now
// carries the media file too. The string form widens to the object so readers
// downstream see one type — the same trick the board version migration uses.
const emailAttachmentSchema = z.union([
  z.string().transform((name) => ({ name })),
  z.object({
    name: z.string(),
    file: z.string().optional(),
    mime: z.string().optional(),
  }),
]);

const emailMetaSchema = z.object({
  from: emailAddressSchema.nullable().default(null),
  to: z.array(emailAddressSchema).default([]),
  cc: z.array(emailAddressSchema).default([]),
  messageId: z.string().nullable().default(null),
  inReplyTo: z.string().nullable().default(null),
  attachments: z.array(emailAttachmentSchema).default([]),
  emlFile: z.string().optional(),
  // Optional and strippable on purpose, so this rides in v2 without a bump: an
  // older build drops it and degrades to treating the card as an ordinary
  // email, which loses provenance but never content.
  source: z.enum(['mail-drag']).optional(),
});

const messageMetaSchema = z.object({
  from: emailAddressSchema.nullable().default(null),
  to: z.array(emailAddressSchema).default([]),
  body: z.string().optional(),
});

const callMetaSchema = z.object({
  from: emailAddressSchema.nullable().default(null),
  to: z.array(emailAddressSchema).default([]),
  durationSecs: z.number().optional(),
});

const personMetaSchema = z.object({
  addresses: z.array(z.string()).default([]),
  numbers: z.array(z.string()).optional(),
});

const orgMetaSchema = z.object({
  addresses: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  numbers: z.array(z.string()).optional(),
});

const eventMetaSchema = z.object({
  sourceCardId: z.string().optional(),
});

const documentMetaSchema = z.object({
  file: z.string().optional(),
  name: z.string().optional(),
  mime: z.string().optional(),
  // Read from the file on import; absent on an older board or an unparsed file.
  title: z.string().optional(),
  author: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  pages: z.number().optional(),
  words: z.number().optional(),
});

const imageMetaSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  takenAt: z.string().optional(),
  cameraMake: z.string().optional(),
  cameraModel: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const gradeSchema = z.enum([
  'adjudicated',
  'admitted',
  'confirmed',
  'corroborated',
  'asserted',
  'inference',
  'unresolved',
  'refuted',
]);

const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().default(''),
  // imageUrl now holds only a remote URL; a local picture is imageFile. A legacy
  // board's inline data: URL is still accepted here and moved out to a file by
  // migrateBoardMedia on load — the byte migration the transform below cannot do.
  imageUrl: z.string().nullable().default(null),
  imageFile: z.string().nullable().default(null),
  // How the picture is framed. Null (the default, and every pre-existing board)
  // means centre cover, so an older board parses unchanged; the byte migration
  // below never touches it.
  imageCrop: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullable()
    .default(null),
  // A picture's EXIF, read on import. Null on an older board or a picture-less card.
  // Preprocessed so a field the extractor returned as null (no EXIF) reads as absent
  // rather than failing the whole board — see withoutNulls.
  imageMeta: z.preprocess(withoutNulls, imageMetaSchema).nullable().default(null),
  clusterId: z.string().nullable().default(null),
  position: vec2,
  // v2 and v3 additions. The defaults are what let a v1 or v2 board parse into a
  // complete v3 board without any field-level migration work.
  //
  // 'evidence' stays the default because no pre-v3 card carries a kind at all:
  // it is what every existing card silently is, so widening this enum costs
  // nothing on the way in. It is not backward-compatible on the way *out* —
  // which is the whole point of the version bump below.
  kind: z
    .enum(['person', 'organisation', 'document', 'email', 'message', 'call', 'event', 'evidence'])
    .default('evidence'),
  // Z-only by default in zod 4, which is exactly the storage invariant we want
  // (every writer normalises through Date#toISOString).
  occurredAt: z.iso.datetime().nullable().default(null),
  occurredAtPrecision: z.enum(['day', 'minute']).default('minute'),
  email: emailMetaSchema.optional(),
  message: messageMetaSchema.optional(),
  call: callMetaSchema.optional(),
  person: personMetaSchema.optional(),
  organisation: orgMetaSchema.optional(),
  document: z.preprocess(withoutNulls, documentMetaSchema).optional(),
  event: eventMetaSchema.optional(),
  grade: gradeSchema.optional(),
});

const connectionSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  kind: z.enum(['red-string', 'plain']).default('red-string'),
  grade: gradeSchema.optional(),
});

const viewportSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number() });

const boardBase = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  meta: z.object({ title: z.string(), updatedAt: z.string() }),
  clusters: z.array(clusterSchema),
  cards: z.array(cardSchema),
  connections: z.array(connectionSchema),
  viewport: viewportSchema.optional(),
});

/**
 * v1 and v2 → v3 needs no field work: every addition since v1 is `.default()`-ed
 * or optional on cardSchema, so an old board parses into a complete v3 board and
 * this transform only restamps the version. That holds for v3 specifically
 * because `kind` still defaults to 'evidence' — which is what every pre-v3 card
 * already silently was — so widening the enum costs nothing on the way in.
 *
 * The bump earns its keep on the way *out*, and more than v2's did: a v2 build
 * meeting `kind: 'person'` fails the enum, safeParseBoardJson returns null, and
 * the board is refused whole — loudly — rather than loading with every person
 * and organisation silently reduced to evidence. There is no undo in this app;
 * failing to open is the kind failure.
 *
 * Moving image blobs out of the JSON is now underway, but only its *field*
 * half lives here: this schema accepts the new `imageFile` and structured
 * `attachments`, and still parses a legacy inline `imageUrl` data URL. The
 * *byte* half — decoding that data URL and writing it to the media library —
 * is async and effectful, so it cannot happen in a pure transform; it runs in
 * the store's load path (`migrateBoardMedia`) instead.
 */
export const boardSchema = boardBase.transform((b) => ({ ...b, version: 3 as const }));

/** Parse and validate unknown input into a Board, throwing on invalid data. */
export function parseBoard(input: unknown): Board {
  return boardSchema.parse(input) as Board;
}

/** Non-throwing variant; returns null on invalid input. */
export function safeParseBoard(input: unknown): Board | null {
  const result = boardSchema.safeParse(input);
  return result.success ? (result.data as Board) : null;
}

/**
 * Parse a stored/imported board from its raw JSON text.
 *
 * Every real caller starts from a string, and they all want the same answer:
 * unparseable JSON and a board that fails validation are both just "not a
 * board". Owning that here keeps the guard in one place — it will need to
 * change when image blobs move out of the JSON.
 */
export function safeParseBoardJson(raw: string): Board | null {
  try {
    return safeParseBoard(JSON.parse(raw));
  } catch {
    return null;
  }
}
