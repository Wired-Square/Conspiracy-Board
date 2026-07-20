import { describe, expect, it } from 'vitest';
import { parseBoard, safeParseBoard } from './schema';

const v1Board = {
  version: 1,
  meta: { title: 'Test', updatedAt: '2024-01-01T00:00:00.000Z' },
  clusters: [{ id: 'cl_1', label: 'People', color: '#e23b3b', visible: true }],
  cards: [
    {
      id: 'card_1',
      title: 'A card',
      notes: 'notes',
      imageUrl: null,
      clusterId: 'cl_1',
      position: { x: 0, y: 0 },
    },
  ],
  connections: [
    { id: 'edge_1', source: 'card_1', target: 'card_1', kind: 'red-string' },
  ],
};

describe('v1 → v4 migration', () => {
  it('restamps the version', () => {
    expect(parseBoard(v1Board).version).toBe(4);
  });

  it('widens the legacy clusterId into a one-element clusterIds', () => {
    const card = parseBoard(v1Board).cards[0];
    expect(card.clusterIds).toEqual(['cl_1']);
    expect('clusterId' in card).toBe(false);
  });

  it('widens a null clusterId to no memberships', () => {
    const board = parseBoard({
      ...v1Board,
      cards: [{ ...v1Board.cards[0], clusterId: null }],
    });
    expect(board.cards[0].clusterIds).toEqual([]);
  });

  it('fills the new card fields with defaults, leaving old cards undated', () => {
    const card = parseBoard(v1Board).cards[0];
    expect(card.kind).toBe('evidence');
    expect(card.occurredAt).toBeNull();
    expect(card.occurredAtPrecision).toBe('minute');
    expect(card.email).toBeUndefined();
  });

  it('leaves a pre-v3 card as evidence, ungraded and unentitied', () => {
    // The whole reason v3 is a cheap migration: 'evidence' is what every card
    // without a `kind` already silently was, so widening the enum costs nothing
    // on the way in and nothing needs rewriting.
    const card = parseBoard(v1Board).cards[0];
    expect(card.kind).toBe('evidence');
    expect(card.grade).toBeUndefined();
    expect(card.person).toBeUndefined();
    expect(card.organisation).toBeUndefined();
  });

  it('leaves a pre-v3 connection ungraded', () => {
    expect(parseBoard(v1Board).connections[0].grade).toBeUndefined();
  });

  it('preserves the existing content', () => {
    const board = parseBoard(v1Board);
    expect(board.meta.title).toBe('Test');
    expect(board.cards[0].title).toBe('A card');
    expect(board.clusters).toHaveLength(1);
    expect(board.connections).toHaveLength(1);
  });
});

describe('v2 boards', () => {
  it('round-trips without losing the new fields', () => {
    const email = {
      from: { name: 'Jane', address: 'jane@x.com' },
      to: [{ address: 'bob@x.com' }],
      cc: [],
      messageId: '<abc@x.com>',
      inReplyTo: null,
      attachments: ['report.pdf'],
    };
    const board = parseBoard({
      ...v1Board,
      version: 2,
      cards: [
        {
          ...v1Board.cards[0],
          kind: 'email',
          occurredAt: '2024-11-14T17:32:00.000Z',
          occurredAtPrecision: 'minute',
          email,
        },
      ],
    });
    expect(board.cards[0].kind).toBe('email');
    expect(board.cards[0].occurredAt).toBe('2024-11-14T17:32:00.000Z');
    // A v2 board's attachments were bare filenames; they widen to the object
    // form on read, so bytes can be attached to them going forward.
    expect(board.cards[0].email).toEqual({ ...email, attachments: [{ name: 'report.pdf' }] });
  });

  it('accepts a dated card at day precision', () => {
    const board = parseBoard({
      ...v1Board,
      cards: [
        {
          ...v1Board.cards[0],
          occurredAt: '2024-11-14T00:00:00.000Z',
          occurredAtPrecision: 'day',
        },
      ],
    });
    expect(board.cards[0].occurredAtPrecision).toBe('day');
  });
});

describe('v3 boards', () => {
  const kinds = ['person', 'organisation', 'document', 'email', 'event', 'evidence'] as const;

  it.each(kinds)('round-trips a %s card', (kind) => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [{ ...v1Board.cards[0], kind }],
    });
    expect(board.cards[0].kind).toBe(kind);
  });

  it('round-trips a person and their addresses', () => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [
        {
          ...v1Board.cards[0],
          kind: 'person',
          person: { addresses: ['jane@acme.com', 'jane@personal.example'] },
        },
      ],
    });
    expect(board.cards[0].person).toEqual({
      addresses: ['jane@acme.com', 'jane@personal.example'],
    });
  });

  it('round-trips an organisation, which holds addresses of its own as well as domains', () => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [
        {
          ...v1Board.cards[0],
          kind: 'organisation',
          organisation: { addresses: ['legal@acme.com'], domains: ['acme.com'] },
        },
      ],
    });
    expect(board.cards[0].organisation).toEqual({
      addresses: ['legal@acme.com'],
      domains: ['acme.com'],
    });
  });

  it('defaults an entity payload’s lists rather than rejecting a bare one', () => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [{ ...v1Board.cards[0], kind: 'organisation', organisation: {} }],
    });
    expect(board.cards[0].organisation).toEqual({ addresses: [], domains: [] });
  });

  it('round-trips a graded card', () => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [{ ...v1Board.cards[0], kind: 'event', grade: 'adjudicated' }],
    });
    expect(board.cards[0].grade).toBe('adjudicated');
  });

  it('round-trips a graded connection — a link is a claim too', () => {
    const board = parseBoard({
      ...v1Board,
      version: 3,
      connections: [{ ...v1Board.connections[0], grade: 'inference' }],
    });
    expect(board.connections[0].grade).toBe('inference');
  });

  it('keeps a payload for a kind the card no longer is, rather than losing it', () => {
    // Switching kind must not destroy parsed headers — a mis-click has to be
    // recoverable. `kind` is the only authority; readers gate on it, never on a
    // payload being present. See Card in types/board.ts.
    const board = parseBoard({
      ...v1Board,
      version: 3,
      cards: [
        {
          ...v1Board.cards[0],
          kind: 'person',
          person: { addresses: [] },
          email: { from: null, to: [], cc: [], messageId: '<a@b>', inReplyTo: null, attachments: [] },
        },
      ],
    });
    expect(board.cards[0].email?.messageId).toBe('<a@b>');
  });
});

describe('v4 boards', () => {
  it('round-trips ordered multi-cluster membership', () => {
    const board = parseBoard({
      ...v1Board,
      version: 4,
      clusters: [
        ...v1Board.clusters,
        { id: 'cl_2', label: 'Money', color: '#3b7de2', visible: true },
      ],
      cards: [{ ...v1Board.cards[0], clusterId: undefined, clusterIds: ['cl_2', 'cl_1'] }],
    });
    expect(board.cards[0].clusterIds).toEqual(['cl_2', 'cl_1']);
    expect(board.version).toBe(4);
  });

  it('lets clusterIds win when a card carries both shapes', () => {
    const board = parseBoard({
      ...v1Board,
      version: 4,
      cards: [{ ...v1Board.cards[0], clusterId: 'cl_1', clusterIds: [] }],
    });
    expect(board.cards[0].clusterIds).toEqual([]);
  });
});

describe('rejection', () => {
  it('rejects a malformed board', () => {
    expect(safeParseBoard({ version: 2, meta: {}, cards: [] })).toBeNull();
  });

  it('rejects an unknown version', () => {
    expect(safeParseBoard({ ...v1Board, version: 5 })).toBeNull();
  });

  it('rejects an unknown kind, which is what makes the v3 bump worth it', () => {
    // A v2 build meeting kind:'person' fails exactly here and refuses the board
    // whole, rather than loading it with every person reduced to evidence.
    expect(
      safeParseBoard({ ...v1Board, cards: [{ ...v1Board.cards[0], kind: 'suspect' }] }),
    ).toBeNull();
  });

  it('rejects an unknown grade', () => {
    expect(
      safeParseBoard({ ...v1Board, cards: [{ ...v1Board.cards[0], grade: 'probably' }] }),
    ).toBeNull();
  });

  it('rejects a non-UTC occurredAt, holding the storage invariant', () => {
    // Everything writes through Date#toISOString, so an offset here means data
    // arrived from somewhere that bypassed the app's own encoding.
    const board = safeParseBoard({
      ...v1Board,
      cards: [{ ...v1Board.cards[0], occurredAt: '2024-11-14T00:00:00+05:00' }],
    });
    expect(board).toBeNull();
  });

  it('rejects a non-ISO occurredAt', () => {
    expect(
      safeParseBoard({
        ...v1Board,
        cards: [{ ...v1Board.cards[0], occurredAt: 'November 2024' }],
      }),
    ).toBeNull();
  });

  // The shell's meta extractor returns null (not undefined) for a field a file
  // doesn't carry — a screenshot has width/height but no EXIF takenAt/camera/GPS.
  // Those nulls must read as absent, not fail the whole board (which once made a
  // board with one no-EXIF image refuse to open — see withoutNulls).
  it('loads a card whose imageMeta/document carry explicit nulls, stripping them', () => {
    const board = safeParseBoard({
      ...v1Board,
      cards: [
        {
          ...v1Board.cards[0],
          imageFile: 'shot.png',
          imageMeta: {
            width: 1288,
            height: 672,
            takenAt: null,
            cameraMake: null,
            cameraModel: null,
            latitude: null,
            longitude: null,
          },
          kind: 'document',
          document: { file: 'a.pdf', title: 'A', author: null, pages: null },
        },
      ],
    });
    expect(board).not.toBeNull();
    const card = board!.cards[0];
    expect(card.imageMeta).toEqual({ width: 1288, height: 672 });
    expect(card.document).toEqual({ file: 'a.pdf', title: 'A' });
  });
});
