import type { CardKind } from '../types/board';
import type { CardMediaKind } from '../store/boardMigration';
import type { MediaEntry } from '../storage/StorageAdapter';

// The integrity read of the media library, done as one pure function so it can be
// tested without the shell. The IO — listing the disk, gathering every board's
// references — happens in mediaAuditStore; here we only reconcile the two.

/**
 * What a media file's references say about it:
 * - `ok`      — on disk and used by the open board.
 * - `missing` — the open board points at it, but it is not on disk.
 * - `orphan`  — on disk, referenced by no board at all.
 * - `foreign` — on disk, used by another board but not this one.
 * - `unknown` — on disk, not used here, and we couldn't read every board to say
 *               whether it is an orphan (so we don't accuse it of being one).
 */
export type MediaStatus = 'ok' | 'missing' | 'orphan' | 'foreign' | 'unknown';

/** A media file's owner on the open board, when it has one. */
export type MediaOwner = {
  cardId: string;
  title: string;
  cardKind: CardKind;
  mediaKind: CardMediaKind;
};

/** A reference the open board makes to a media file, with enough to show and act. */
export type CurrentRef = { file: string } & MediaOwner;

export type MediaRow = {
  file: string;
  /** Bytes on disk, or null when the file is missing. */
  size: number | null;
  onDisk: boolean;
  /** The card on the open board that references it, or null. */
  owner: MediaOwner | null;
  status: MediaStatus;
};

/** A file with a problem is worth the user's eye first; among equals, the big ones. */
const STATUS_ORDER: Record<MediaStatus, number> = {
  missing: 0,
  orphan: 1,
  unknown: 2,
  foreign: 3,
  ok: 4,
};

/** Whether a status is something to act on (drives the "issues" count and filter). */
export function isIssue(status: MediaStatus): boolean {
  return status === 'missing' || status === 'orphan' || status === 'unknown';
}

/** How many rows need looking at — the "N to look at" count the view and badge share. */
export function countIssues(rows: MediaRow[]): number {
  return rows.filter((r) => isIssue(r.status)).length;
}

/** How each status reads in the UI — the row badge and the details dialog agree on it. */
export const STATUS_LABEL: Record<MediaStatus, string> = {
  ok: 'ok',
  missing: 'missing',
  orphan: 'orphan',
  foreign: 'other board',
  unknown: 'unreferenced?',
};

/**
 * The Objects view's row matcher, over a row's visible fields — its filename, the
 * owning card's title, the card and media kind, and the raw status. Mirrors
 * lib/search's `cardMatches`: `q` is already through `normaliseQuery`, and an empty
 * query matches every row so an idle search box leaves the list whole.
 */
export function mediaRowMatches(row: MediaRow, q: string): boolean {
  if (!q) return true;
  const hit = (s?: string | null) => !!s && s.toLowerCase().includes(q);
  return (
    hit(row.file) ||
    hit(row.owner?.title) ||
    hit(row.owner?.cardKind) ||
    hit(row.owner?.mediaKind) ||
    hit(row.status)
  );
}

/**
 * `mediaRowMatches`, plus a hit when the query matched a file's indexed full text —
 * `docHits` is the set of media names the current query found (see useDocHits), keyed
 * the same as `row.file`, so a file surfaces on its contents even when it has no owning
 * card. Mirrors lib/search's `cardMatchesWithDocs`.
 */
export function mediaRowMatchesWithDocs(row: MediaRow, q: string, docHits: Set<string>): boolean {
  return mediaRowMatches(row, q) || docHits.has(row.file);
}

/**
 * The verdict for one file. `referencedElsewhere` is whether some *other* board uses
 * it — or null when we couldn't read every board, which withholds the orphan call.
 */
function statusFor(
  onDisk: boolean,
  owner: MediaOwner | null,
  referencedElsewhere: boolean | null,
): MediaStatus {
  if (!onDisk) return 'missing';
  if (owner) return 'ok';
  if (referencedElsewhere === null) return 'unknown';
  return referencedElsewhere ? 'foreign' : 'orphan';
}

/**
 * Reconcile what is on disk with what the boards reference.
 *
 * `allRefs` is the union of every board's referenced filenames, or null when the
 * gather was incomplete (a board wouldn't load) — in which case an unreferenced
 * on-disk file is `unknown`, not `orphan`, the same caution `gc_media` takes
 * before it deletes.
 */
export function auditMedia(
  diskFiles: MediaEntry[],
  currentRefs: CurrentRef[],
  allRefs: Set<string> | null,
): MediaRow[] {
  const onDisk = new Map(diskFiles.map((f) => [f.name, f]));
  // First owner wins: a content-addressed file may be shared by several cards, but
  // one row is enough to reach it and reprocess it.
  const owners = new Map<string, MediaOwner>();
  for (const r of currentRefs) if (!owners.has(r.file)) owners.set(r.file, r);

  const files = new Set<string>([...onDisk.keys(), ...owners.keys()]);
  const rows: MediaRow[] = [];
  for (const file of files) {
    const disk = onDisk.get(file);
    const owner = owners.get(file) ?? null;
    const referencedElsewhere = allRefs === null ? null : allRefs.has(file);
    rows.push({
      file,
      size: disk?.size ?? null,
      onDisk: !!disk,
      owner,
      status: statusFor(!!disk, owner, referencedElsewhere),
    });
  }

  return rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.size ?? 0) - (a.size ?? 0),
  );
}
