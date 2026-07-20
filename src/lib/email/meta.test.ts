import { describe, expect, it } from 'vitest';
import type { Card } from '../../types/board';
import { emailCardsByMessageId, emptyEmailMeta, isReferenceCard, matchDraft } from './meta';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card_1',
  title: 'A card',
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: [],
  position: { x: 0, y: 0 },
  kind: 'evidence',
  occurredAt: null,
  occurredAtPrecision: 'minute',
  ...over,
});

/** What dragging a message out of Apple Mail leaves behind. */
const dragged = (over: Partial<Card> = {}) =>
  card({
    kind: 'email',
    email: { ...emptyEmailMeta(), messageId: '<abc@host>', source: 'mail-drag' },
    ...over,
  });

/** A real message that happens to carry neither a From nor a Date header. */
const headerless = () =>
  card({
    kind: 'email',
    notes: 'Notes the user typed and would hate to lose.',
    email: { ...emptyEmailMeta(), messageId: '<abc@host>' },
  });

describe('isReferenceCard', () => {
  it('recognises a card dragged from Mail and still waiting for its content', () => {
    expect(isReferenceCard(dragged())).toBe(true);
  });

  it('does NOT mistake a headerless real message for one', () => {
    // The bug this field exists to prevent: a draft or machine-generated message
    // with no From and no Date looks identical to a Mail drag from the outside.
    // Treating it as a reference would let a re-import silently overwrite it.
    expect(isReferenceCard(headerless())).toBe(false);
  });

  it('stops being one once an import has filled the headers in', () => {
    const completed = dragged({
      occurredAt: '2020-08-18T02:45:03.000Z',
      email: {
        ...emptyEmailMeta(),
        messageId: '<abc@host>',
        source: 'mail-drag',
        from: { address: 'a@b.com' },
      },
    });
    expect(isReferenceCard(completed)).toBe(false);
  });

  it('is not one without a Message-ID — there would be nothing to match on', () => {
    expect(
      isReferenceCard(dragged({ email: { ...emptyEmailMeta(), source: 'mail-drag' } })),
    ).toBe(false);
  });

  it('is not one for an ordinary evidence card', () => {
    expect(isReferenceCard(card())).toBe(false);
  });
});

describe('matchDraft', () => {
  const draft = { email: { messageId: '<abc@host>' } };

  it('is new when the board has never seen the Message-ID', () => {
    expect(matchDraft(draft, emailCardsByMessageId([]))).toEqual({ kind: 'new' });
  });

  it('completes a card dragged from Mail', () => {
    const existing = dragged();
    expect(matchDraft(draft, emailCardsByMessageId([existing]))).toEqual({
      kind: 'completes',
      card: existing,
    });
  });

  it('is a plain duplicate of a headerless real message, not a completion', () => {
    expect(matchDraft(draft, emailCardsByMessageId([headerless()]))).toEqual({
      kind: 'duplicate',
    });
  });

  it('never matches a draft with no Message-ID', () => {
    // Two distinct hand-pasted messages would otherwise collide on `null`.
    const noId = { email: { messageId: null } };
    expect(matchDraft(noId, emailCardsByMessageId([dragged()]))).toEqual({ kind: 'new' });
    expect(matchDraft({}, emailCardsByMessageId([dragged()]))).toEqual({ kind: 'new' });
  });
});

describe('emailCardsByMessageId', () => {
  it('indexes only cards that carry a Message-ID', () => {
    const map = emailCardsByMessageId([card(), dragged(), headerless()]);
    expect(map.size).toBe(1); // dragged and headerless share an id; last wins
    expect(map.get('<abc@host>')).toBeDefined();
  });
});
