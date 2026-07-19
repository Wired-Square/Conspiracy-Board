// Domain model for a conspiracy board. This is the canonical shape persisted to
// a board file, and to data/board.json. React Flow nodes/edges are a derived
// view (see src/data/mappers.ts) and are never persisted directly.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Cluster {
  id: string;
  label: string;
  color: string;
  visible: boolean;
}

/**
 * What a card is. Three registers, and which one a kind belongs to decides what
 * the card can carry — see `src/lib/kinds.ts`, which is where those questions
 * are answered rather than re-asked at each call site.
 *
 * - The **actors**: `person`, `organisation`. Legal entities. Never graded — a
 *   person is not a claim.
 * - The **record**: `document`, `email`, `message`, `call`. Never graded either:
 *   it exists, you are holding it. (If a document's authenticity is disputed, that
 *   is a *claim about* it — an `evidence` card, connected to it, graded `refuted`.)
 *   `message` (a text) and `call` (a phone call) are communications like `email`,
 *   matched to people by phone number rather than address.
 * - The **argument**: `event`, `evidence`. Graded, because they might be wrong.
 *
 * `event` and `evidence` are both claims, and the line between them is a moment
 * versus a state: an event *happened* ("did it happen?"), evidence *is so*
 * ("is it so?"). A card wanting a date is almost always an event.
 *
 * `evidence` is also the default, which is what lets every pre-v3 card — none of
 * which carries a kind at all — arrive intact.
 */
export type CardKind =
  | 'person'
  | 'organisation'
  | 'document'
  | 'email'
  | 'message'
  | 'call'
  | 'event'
  | 'evidence';

/**
 * How well the record supports a claim. Eight points, from a court's finding
 * down to a claim the record contradicts; the definitions — not the one-word
 * labels — are what you actually grade by (see GRADE_META in lib/grades.ts).
 *
 * Absent is not `unresolved`: that is a finding about the record ("the record
 * does not settle it"), where absent is the absence of one.
 */
export type Grade =
  | 'adjudicated'
  | 'admitted'
  | 'confirmed'
  | 'corroborated'
  | 'asserted'
  | 'inference'
  | 'unresolved'
  | 'refuted';

/** How much of a card's `occurredAt` is meaningful. 'day' ignores the time. */
export type DatePrecision = 'day' | 'minute';

export interface EmailAddress {
  name?: string;
  address: string;
}

/**
 * An attachment carried with an imported message. The name is what the message
 * called it; `file` is where its bytes are kept — a content-addressed file in
 * the media library. `file` is absent only when keeping the bytes failed, which
 * degrades the attachment to a name, as it always was before.
 */
export interface EmailAttachment {
  name: string;
  file?: string;
  mime?: string;
}

/**
 * Structured headers for a card of kind 'email'. The subject is NOT stored here:
 * the card's `title` is the subject, and a second copy would be a second source
 * of truth. Same for the date, which lives in `occurredAt`.
 */
export interface EmailMeta {
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** RFC 5322 Message-ID including angle brackets. Used to dedupe imports. */
  messageId: string | null;
  inReplyTo: string | null;
  /** Attachments carried with the message; their bytes kept in the media library. */
  attachments: EmailAttachment[];
  /** The whole original .eml, kept in the media library. Absent if not retained. */
  emlFile?: string;
  /**
   * Where this card came from, when that changes what we can do with it.
   * 'mail-drag' means it was dragged out of Apple Mail — which hands a browser
   * the subject and Message-ID but never the body — so the message is known to
   * exist in the user's Mail and the card may still be waiting for its content.
   * Absent for anything parsed from an actual message.
   */
  source?: 'mail-drag';
}

/**
 * A text message — SMS, an iMessage, a DM. Like email, a record of a communication
 * with a from and a to, but the address is a phone number or handle rather than an
 * email address, and there is usually no file behind it: the justification is a
 * screenshot, kept on the card's `imageFile` like any other picture. The title/date
 * rule EmailMeta follows holds here too — the card's `title` and `occurredAt` are
 * those, never a second copy.
 */
export interface MessageMeta {
  from: EmailAddress | null;
  to: EmailAddress[];
  /** What was said, when it was typed in rather than only shown in a screenshot. */
  body?: string;
}

/**
 * A phone call — a record that a call happened, between a from and a to, justified by
 * a screenshot of the call log and whatever the notes say. No body: a call has no
 * text of its own. `durationSecs`, when known, is how long it lasted.
 */
export interface CallMeta {
  from: EmailAddress | null;
  to: EmailAddress[];
  durationSecs?: number;
}

/**
 * A person. The *name* is not stored here: the card's `title` is the name, and a
 * second copy would be a second source of truth — the rule EmailMeta already
 * follows for the subject.
 *
 * Addresses is a list because one person has several — work, personal, an old
 * employer's. They are what emails match on, so they are stored normalised (see
 * `lib/email/addresses.ts`); every writer goes through `withAddress`.
 */
export interface PersonMeta {
  addresses: string[];
  /**
   * Phone numbers and handles, normalised (see `lib/phone.ts`); every writer goes
   * through `withNumber`. A text message or a phone call finds a person by these, the
   * way an email finds them by an address. Optional — a later addition, absent on a
   * person nobody has given a number.
   */
  numbers?: string[];
}

/**
 * An organisation, which is a legal person too: it holds addresses in its own
 * right (info@, legal@ — nobody's personal mail), including at domains it does
 * not own, such as its solicitor's. Domains are the *additional* thing it has,
 * and are what make person↔organisation derivable rather than hand-maintained.
 */
export interface OrgMeta {
  addresses: string[];
  /** Normalised, no leading '@'. */
  domains: string[];
  /** Phone numbers the organisation is reached on, matched like a person's — a body
   *  has a switchboard. Optional, as on a person. */
  numbers?: string[];
}

/**
 * The file behind a card of kind 'document' — a warrant, a filing, an invoice
 * the user attached. `file` is its content-addressed name in the media library;
 * `name` is what it was called, kept for display and for opening it in the OS.
 * Empty (`{}`) is a document card with nothing attached yet.
 *
 * The rest is metadata read out of the file on import (`extract_media_meta`): a
 * PDF's or Office document's own properties. All optional — a format that carries
 * none, or one we couldn't parse, simply leaves them off. `created` is also copied
 * to the card's `occurredAt` so the document lands on the timeline by its own date.
 */
export interface DocumentMeta {
  file?: string;
  name?: string;
  mime?: string;
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
  pages?: number;
  words?: number;
}

/**
 * What a card of kind 'event' carries. An event spawned by ticking "mark as event"
 * on another card keeps a back-reference to it here: the source *is* an event iff some
 * event points back at it, which is what makes the checkbox derivable, and it lets the
 * timeline show the event's milestone while folding the dated source under it — so a
 * document and the event it evidences don't list twice at the same moment. A hand-made
 * event has no source and omits this.
 */
export interface EventMeta {
  sourceCardId?: string;
}

/**
 * What an imported photo carries beyond the picture itself, read from its EXIF on
 * import (`extract_media_meta`). All optional. `takenAt` is also copied to the
 * card's `occurredAt`, so a photo lands on the timeline by when it was taken.
 */
export interface ImageMeta {
  width?: number;
  height?: number;
  takenAt?: string;
  cameraMake?: string;
  cameraModel?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * A crop over the source image, as fractions of its natural width and height:
 * the top-left corner (`x`, `y`) and size (`w`, `h`), each in [0, 1]. The region
 * is 4:3 (the card's display shape), which is why it maps to a pure-CSS transform
 * without needing the image's pixel dimensions at render — see `cardImageStyle`.
 */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Card {
  id: string;
  title: string;
  /** Markdown notes / evidence for this card. */
  notes: string;
  /**
   * A remote picture URL (http/https) that lives elsewhere. Local pictures are
   * kept as files and named by `imageFile`; `cardImageSrc` prefers the file.
   * A legacy board may still carry a `data:` URL here until `migrateBoardMedia`
   * moves it out into the media library on load.
   */
  imageUrl: string | null;
  /**
   * A local picture, kept in the media library and referenced by filename. Like
   * every media reference — `DocumentMeta.file`, `EmailMeta.emlFile`, an
   * `EmailAttachment.file` — it must be enumerated in `cardMediaEntries`, or the
   * sweep that frees unreferenced media (`gcMedia`) would delete it as an orphan.
   */
  imageFile: string | null;
  /**
   * How the picture is framed on the card, or null for the default centre cover.
   * The crop is stored, not baked into the file, so it stays re-adjustable and the
   * original is never re-cropped — `cardImageStyle` turns it into a display-time
   * transform. Not a media reference (it names no file, it frames `imageFile`), so
   * it is deliberately absent from `cardMediaEntries`.
   */
  imageCrop: ImageCrop | null;
  /**
   * A picture's own metadata (dimensions, when/where/what it was taken with), read
   * from EXIF on import. Null when there is no picture or it carried none. Not a
   * media reference — like `imageCrop`, it describes `imageFile` rather than naming
   * a file, so it is absent from `cardMediaEntries`.
   */
  imageMeta: ImageMeta | null;
  clusterId: string | null;
  position: Vec2;
  kind: CardKind;
  /**
   * When this card's event happened, as a UTC ISO-8601 instant (always `…Z`),
   * or null when undated. Undated cards are omitted from the timeline.
   *
   * Normalising to UTC buys two things: lexicographic order equals chronological
   * order (so the timeline sorts raw strings), and day-precision values are
   * stored at UTC midnight and must be *rendered* in UTC to stay on their day.
   */
  occurredAt: string | null;
  occurredAtPrecision: DatePrecision;
  /**
   * The payload for the card's kind. Present iff `kind` says so; maintained by
   * addCard and the import mapper.
   *
   * A payload for a kind the card no longer is may linger, and is never read:
   * switching kind deliberately does not clear it, so that email → person →
   * email is a mis-click rather than the silent loss of parsed headers. That
   * makes `kind` the only authority — every reader gates on it, never on a
   * payload merely being present. `buildRoster` is the one that matters.
   */
  email?: EmailMeta;
  message?: MessageMeta;
  call?: CallMeta;
  person?: PersonMeta;
  organisation?: OrgMeta;
  document?: DocumentMeta;
  /** For an 'event' card, an optional back-reference to the card it was spawned from
   *  (see EventMeta and the "mark as event" checkbox). */
  event?: EventMeta;
  /**
   * How well the record supports this card. Only meaningful for the argument —
   * `event` and `evidence`; see `isGradedKind`. Absent means ungraded.
   */
  grade?: Grade;
}

export type ConnectionKind = 'red-string' | 'plain';

export interface Connection {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: ConnectionKind;
  /**
   * A link is itself a claim, and usually the weakest one on the board — that
   * two people are connected is exactly the thing most often assumed. So it
   * carries its own grade, independent of what it joins.
   */
  grade?: Grade;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Board {
  version: 3;
  /** `countryCode` is the local calling code (e.g. `+61`) a leading national `0`
   *  folds to when normalising phone numbers; absent means the default (Australia). */
  meta: { title: string; updatedAt: string; countryCode?: string };
  clusters: Cluster[];
  cards: Card[];
  connections: Connection[];
  viewport?: Viewport;
}
