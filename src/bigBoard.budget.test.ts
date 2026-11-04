import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocChanged } from './platform/document';
import type { Card, Cluster, Connection } from './types/board';
import { boardStore } from './store/boardStore';
import { buildRoster, rosterOf } from './lib/roster';
import { recordRows } from './lib/record';
import { visibleCards } from './lib/visibility';
import { dayGroups, timelineCards } from './lib/timeline';

vi.mock('./platform/document', () => ({ doc: {} }));
vi.mock('./storage', () => ({ storage: {} }));

// The real board's shape (plan D6): 73 board cards, 18 clusters, 10,953 emails with
// ~3 KB of notes, dated 2015 to 2026.
const EMAILS = 10_953;
const PEOPLE = 60;
const CLUSTERS = 18;

function lcg(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 48_271) % 2_147_483_647;
    return s % n;
  };
}

function bigBoard(): { cards: Card[]; clusters: Cluster[]; connections: Connection[] } {
  const pick = lcg(11);
  const base = (id: string, kind: Card['kind'], extra: Partial<Card>): Card => ({
    id,
    title: id,
    notes: '',
    imageUrl: null,
    imageFile: null,
    imageCrop: null,
    imageMeta: null,
    clusterIds: [],
    position: { x: 0, y: 0 },
    kind,
    occurredAt: null,
    occurredAtPrecision: 'minute',
    ...extra,
  });
  const address = (i: number) => `person${i}@domain${i % 9}.example`;
  const notes = 'word '.repeat(600);
  const clusters = Array.from({ length: CLUSTERS }, (_, i) => ({ id: `cl_${i}`, name: `Cluster ${i}`, colour: '#a33' }) as unknown as Cluster);
  const people = Array.from({ length: PEOPLE }, (_, i) =>
    base(`card_p${i}`, 'person', { position: { x: i * 10, y: 0 }, clusterIds: [`cl_${i % CLUSTERS}`], person: { addresses: [address(i)] } } as Partial<Card>),
  );
  const others = Array.from({ length: 13 }, (_, i) => base(`card_d${i}`, 'document', { position: { x: 0, y: i * 10 } }));
  const emails = Array.from({ length: EMAILS }, (_, i) => {
    const at = new Date(Date.UTC(2015 + pick(12), pick(12), 1 + pick(28), pick(24), pick(60))).toISOString();
    return base(`card_e${i}`, 'email', {
      title: `Subject ${i % 300}`,
      notes,
      occurredAt: at,
      email: {
        from: { address: address(pick(PEOPLE * 2)) },
        to: [{ address: address(pick(PEOPLE * 2)) }],
        cc: pick(3) ? [] : [{ address: address(pick(PEOPLE * 2)) }],
        messageId: `<${i}@x>`,
        inReplyTo: null,
        attachments: [],
      },
    } as Partial<Card>);
  });
  const connections = Array.from({ length: 35 }, (_, i) => ({ id: `edge_${i}`, source: `card_p${i % PEOPLE}`, target: `card_p${(i + 1) % PEOPLE}`, kind: 'red-string' }) as Connection);
  return { cards: [...people, ...others, ...emails], clusters, connections };
}

const time = (step: () => unknown) => {
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    step();
    runs.push(performance.now() - start);
  }
  return runs.sort((a, b) => a - b)[2];
};

const one = (card: Card, title: string): DocChanged => ({
  boardId: 'brd',
  cards: [{ ...card, title }],
  connections: [],
  clusters: [],
  removedCards: [],
  removedConnections: [],
  removedClusters: [],
  canUndo: true,
  canRedo: false,
});

// Each budget is several times the step's median on an M-series Mac under node (in
// brackets), so a slow CI box passes and a full-board pass in the wrong place fails.
const BUDGET_MS = { apply: 20, roster: 150, recordRows: 150, timeline: 100, dayGroups: 40 };

let board: ReturnType<typeof bigBoard>;
beforeAll(() => {
  board = bigBoard();
  boardStore.setState({ currentBoardId: 'brd', ...board, selectedCardId: null, lastDeleted: null });
});
afterEach(() => vi.restoreAllMocks());

describe('an 11,000-card board', () => {
  it('applies a one-card change in place, keeping every other card (0.5 ms)', () => {
    const before = boardStore.getState().cards;
    const target = before[5000];
    boardStore.getState().applyDocChanged(one(target, 'Renamed'));
    const after = boardStore.getState().cards;
    expect(after).toHaveLength(before.length);
    expect(after.filter((c, i) => c !== before[i]).map((c) => c.id)).toEqual([target.id]);
    let n = 0;
    expect(time(() => boardStore.getState().applyDocChanged(one(target, `t${n++}`)))).toBeLessThan(BUDGET_MS.apply);
  });

  it('builds its roster once per change, however many views read it (18 ms)', () => {
    const { cards } = board;
    expect(rosterOf(cards)).toBe(rosterOf(cards));
    expect(time(() => buildRoster(cards))).toBeLessThan(BUDGET_MS.roster);
  });

  it('builds the Record view rows within budget (17 ms)', () => {
    const { cards, clusters, connections } = board;
    const roster = buildRoster(cards);
    const shown = visibleCards(cards, clusters, '');
    expect(time(() => recordRows(shown, cards, roster, connections))).toBeLessThan(BUDGET_MS.recordRows);
  });

  it('sorts the timeline within budget (11 ms)', () => {
    const { cards, clusters } = board;
    expect(time(() => timelineCards(cards, clusters, '', new Set()))).toBeLessThan(BUDGET_MS.timeline);
  });

  it('groups 11,000 days without building a date formatter per card (3 ms)', () => {
    const { dated } = timelineCards(board.cards, board.clusters, '', new Set());
    const formatted = vi.spyOn(Date.prototype, 'toLocaleDateString');
    const formatter = vi.spyOn(Intl, 'DateTimeFormat');
    expect(dayGroups(dated).length).toBeGreaterThan(1000);
    expect([formatted.mock.calls.length, formatter.mock.calls.length]).toEqual([0, 0]);
    expect(time(() => dayGroups(dated))).toBeLessThan(BUDGET_MS.dayGroups);
  });
});
