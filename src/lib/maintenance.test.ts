import { describe, expect, it } from 'vitest';
import {
  auditMedia,
  isIssue,
  mediaRowMatches,
  mediaRowMatchesWithDocs,
  type CurrentRef,
  type MediaRow,
} from './maintenance';
import type { MediaEntry } from '../storage/StorageAdapter';

const disk = (name: string, size = 10): MediaEntry => ({ name, size });

const ref = (file: string): CurrentRef => ({
  file,
  cardId: `card-${file}`,
  title: file,
  cardKind: 'evidence',
  mediaKind: 'image',
});

const statusOf = (rows: ReturnType<typeof auditMedia>, file: string) =>
  rows.find((r) => r.file === file)?.status;

describe('auditMedia', () => {
  it('marks a referenced file present on disk as ok', () => {
    const rows = auditMedia([disk('a.png')], [ref('a.png')], new Set(['a.png']));
    expect(statusOf(rows, 'a.png')).toBe('ok');
    expect(rows.find((r) => r.file === 'a.png')?.owner?.cardId).toBe('card-a.png');
  });

  it('marks a referenced file absent from disk as missing', () => {
    const rows = auditMedia([], [ref('gone.pdf')], new Set(['gone.pdf']));
    const row = rows.find((r) => r.file === 'gone.pdf');
    expect(row?.status).toBe('missing');
    expect(row?.onDisk).toBe(false);
    expect(row?.size).toBeNull();
  });

  it('marks an unreferenced on-disk file as orphan when all boards were read', () => {
    const rows = auditMedia([disk('stray.bin')], [], new Set());
    expect(statusOf(rows, 'stray.bin')).toBe('orphan');
  });

  it('marks a file used by another board as foreign, not orphan', () => {
    const rows = auditMedia([disk('shared.png')], [], new Set(['shared.png']));
    expect(statusOf(rows, 'shared.png')).toBe('foreign');
  });

  it('withholds the orphan verdict as unknown when a board could not be read', () => {
    const rows = auditMedia([disk('maybe.png')], [], null);
    expect(statusOf(rows, 'maybe.png')).toBe('unknown');
  });

  it('sorts issues first, then by size descending', () => {
    const rows = auditMedia(
      [disk('ok.png', 5), disk('orphan.bin', 99), disk('foreign.png', 200)],
      [ref('ok.png')],
      new Set(['ok.png', 'foreign.png']),
    );
    // missing has no disk entry; add one referenced-but-absent to lead.
    const withMissing = auditMedia(
      [disk('ok.png', 5), disk('big-orphan.bin', 99)],
      [ref('ok.png'), ref('gone.pdf')],
      new Set(['ok.png', 'gone.pdf']),
    );
    expect(withMissing[0].status).toBe('missing');
    expect(rows[0].status).toBe('orphan'); // an issue leads
    expect(rows.map((r) => r.status).at(-1)).toBe('ok'); // ok trails
  });

  it('isIssue flags only actionable statuses', () => {
    expect(isIssue('missing')).toBe(true);
    expect(isIssue('orphan')).toBe(true);
    expect(isIssue('unknown')).toBe(true);
    expect(isIssue('foreign')).toBe(false);
    expect(isIssue('ok')).toBe(false);
  });
});

const ownedRow = (over: Partial<MediaRow> = {}): MediaRow => ({
  file: 'scan-01.png',
  size: 10,
  onDisk: true,
  owner: { cardId: 'c1', title: 'March invoice', cardKind: 'document', mediaKind: 'image' },
  status: 'ok',
  ...over,
});

describe('mediaRowMatches', () => {
  const row = ownedRow();

  it('matches every row on an empty query', () => {
    expect(mediaRowMatches(row, '')).toBe(true);
    expect(mediaRowMatches(ownedRow({ owner: null, status: 'orphan' }), '')).toBe(true);
  });

  it('matches on a filename fragment', () => {
    expect(mediaRowMatches(row, 'scan')).toBe(true);
  });

  it("matches on the owning card's title, kind and media kind", () => {
    expect(mediaRowMatches(row, 'invoice')).toBe(true);
    expect(mediaRowMatches(row, 'document')).toBe(true);
    expect(mediaRowMatches(row, 'image')).toBe(true);
  });

  it('matches on the raw status', () => {
    expect(mediaRowMatches(ownedRow({ owner: null, status: 'orphan' }), 'orphan')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(mediaRowMatches(row, 'zzz')).toBe(false);
  });

  it('does not read a missing owner', () => {
    const orphan = ownedRow({ file: 'stray.bin', owner: null, status: 'orphan' });
    expect(mediaRowMatches(orphan, 'invoice')).toBe(false);
    expect(mediaRowMatches(orphan, 'stray')).toBe(true);
  });
});

describe('mediaRowMatchesWithDocs', () => {
  it('surfaces an orphan file on an indexed-content hit its fields miss', () => {
    const orphan = ownedRow({ file: 'stray.pdf', owner: null, status: 'orphan' });
    expect(mediaRowMatches(orphan, 'contraband')).toBe(false);
    expect(mediaRowMatchesWithDocs(orphan, 'contraband', new Set(['stray.pdf']))).toBe(true);
  });

  it('ignores content hits for other files', () => {
    const orphan = ownedRow({ file: 'stray.pdf', owner: null, status: 'orphan' });
    expect(mediaRowMatchesWithDocs(orphan, 'contraband', new Set(['other.pdf']))).toBe(false);
  });

  it('still matches on fields with no content hits', () => {
    expect(mediaRowMatchesWithDocs(ownedRow(), 'invoice', new Set())).toBe(true);
  });
});
