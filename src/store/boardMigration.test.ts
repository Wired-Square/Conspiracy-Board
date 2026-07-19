import { describe, expect, it } from 'vitest';
import type { Board, Card } from '../types/board';
import { boardMediaRefs, cardMediaRefs } from './boardMigration';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1',
  title: 'A card',
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterId: null,
  position: { x: 0, y: 0 },
  kind: 'evidence',
  occurredAt: null,
  occurredAtPrecision: 'minute',
  ...over,
});

describe('cardMediaRefs', () => {
  it('is empty for a card with no media', () => {
    expect(cardMediaRefs(card())).toEqual([]);
  });

  it('collects the picture, the .eml, kept attachments and a document', () => {
    const c = card({
      imageFile: 'img.png',
      email: {
        from: null,
        to: [],
        cc: [],
        messageId: null,
        inReplyTo: null,
        emlFile: 'msg.eml',
        attachments: [{ name: 'a.pdf', file: 'a.pdf' }, { name: 'text-only' }],
      },
      document: { file: 'doc.pdf', name: 'doc.pdf' },
    });
    // The name-only attachment (no file) contributes nothing — it has no bytes.
    expect(cardMediaRefs(c).sort()).toEqual(['a.pdf', 'doc.pdf', 'img.png', 'msg.eml']);
  });
});

describe('boardMediaRefs', () => {
  it('is the union across every card — the GC keep-set', () => {
    const board = {
      version: 3,
      meta: { title: 't', updatedAt: '2024-01-01T00:00:00.000Z' },
      clusters: [],
      cards: [card({ imageFile: 'one.png' }), card({ imageFile: 'two.png' }), card()],
      connections: [],
    } as Board;
    expect(boardMediaRefs(board).sort()).toEqual(['one.png', 'two.png']);
  });
});
