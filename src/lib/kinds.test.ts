import { describe, expect, it } from 'vitest';
import type { Card, CardKind } from '../types/board';
import {
  CARD_KINDS,
  KIND_META,
  emptyPayloadFor,
  isBoardKind,
  isEntityKind,
  isGradedKind,
  isRecordKind,
  isTimelineKind,
  payloadPatchFor,
} from './kinds';

// `Record<CardKind, …>` already makes a *forgotten* kind a compile error. These
// catch a kind that is present but filed in the wrong register — which the
// compiler cannot see, and which would put a grade field on a person or bury
// the undated column under every organisation on the board.

const ALL: CardKind[] = [
  'person',
  'organisation',
  'document',
  'email',
  'message',
  'call',
  'event',
  'evidence',
];

describe('CARD_KINDS', () => {
  it('lists every kind, actors first', () => {
    expect(CARD_KINDS).toEqual(ALL);
  });

  it('gives each kind a label and a hint', () => {
    for (const kind of ALL) {
      expect(KIND_META[kind].label).toBeTruthy();
      expect(KIND_META[kind].hint).toBeTruthy();
    }
  });

  it('files each kind in the register the model says it is in', () => {
    // The registers are the organising idea; everything below reads them.
    expect(Object.fromEntries(ALL.map((k) => [k, KIND_META[k].register]))).toEqual({
      person: 'actor',
      organisation: 'actor',
      document: 'record',
      email: 'record',
      message: 'record',
      call: 'record',
      event: 'argument',
      evidence: 'argument',
    });
  });
});

describe('isEntityKind', () => {
  it('is the actors, and only the actors', () => {
    expect(ALL.filter(isEntityKind)).toEqual(['person', 'organisation']);
  });
});

describe('isGradedKind', () => {
  it('is the argument, and only the argument', () => {
    // Not the record: a document exists, you are holding it. Not the actors: a
    // person is not true or false.
    expect(ALL.filter(isGradedKind)).toEqual(['event', 'evidence']);
  });
});

describe('isRecordKind / isBoardKind', () => {
  it('is the record, and only the record', () => {
    expect(ALL.filter(isRecordKind)).toEqual(['document', 'email', 'message', 'call']);
  });

  it('draws everything the record is not', () => {
    // The board is what you argue and who it is about; the record is what you
    // argue *from*, and it lives in the Record view. Two hundred imported
    // messages are two hundred cards, and the argument disappears under them.
    expect(ALL.filter(isBoardKind)).toEqual(['person', 'organisation', 'event', 'evidence']);
  });

  it('puts every kind in exactly one of the two', () => {
    for (const kind of ALL) expect(isBoardKind(kind)).toBe(!isRecordKind(kind));
  });
});

describe('isTimelineKind', () => {
  it('excludes the actors and nothing else', () => {
    // Everything else stays governed by occurredAt, as it always was.
    expect(ALL.filter(isTimelineKind)).toEqual([
      'document',
      'email',
      'message',
      'call',
      'event',
      'evidence',
    ]);
  });

  it('excludes actors by kind, not by being undated', () => {
    // The bug this avoids: a person has no date, so without this they would
    // pile into the undated column and bury what is genuinely undated.
    expect(isTimelineKind('person')).toBe(false);
    expect(isTimelineKind('evidence')).toBe(true);
  });
});

describe('emptyPayloadFor', () => {
  it('gives the kinds that carry one a blank payload', () => {
    expect(emptyPayloadFor('person')).toEqual({ person: { addresses: [] } });
    expect(emptyPayloadFor('organisation')).toEqual({
      organisation: { addresses: [], domains: [] },
    });
    expect(emptyPayloadFor('email').email).toBeDefined();
    expect(emptyPayloadFor('message')).toEqual({ message: { from: null, to: [] } });
    expect(emptyPayloadFor('call')).toEqual({ call: { from: null, to: [] } });
    // A document carries its file, so it seeds an empty payload for the editor
    // to attach into — the same reason email seeds its headers.
    expect(emptyPayloadFor('document')).toEqual({ document: {} });
  });

  it('gives the kinds that carry none nothing', () => {
    for (const kind of ['event', 'evidence'] as CardKind[]) {
      expect(emptyPayloadFor(kind)).toEqual({});
    }
  });
});

describe('payloadPatchFor', () => {
  const card = (extra: Partial<Card> = {}): Card => ({
    id: 'c1',
    title: '',
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
    ...extra,
  });

  it('fills a payload the card hasn’t got', () => {
    expect(payloadPatchFor(card(), 'person')).toEqual({ person: { addresses: [] } });
  });

  it('never clobbers a payload the card already has', () => {
    // The whole point: email → person → email must be a mis-click, not the
    // silent loss of parsed headers.
    const withPerson = card({ person: { addresses: ['jane@acme.com'] } });
    expect(payloadPatchFor(withPerson, 'person')).toEqual({});
  });

  it('leaves other kinds’ payloads out of it entirely', () => {
    const withEmail = card({
      email: { from: null, to: [], cc: [], messageId: null, inReplyTo: null, attachments: [] },
    });
    // Becoming a person says nothing about the email payload, which lingers
    // unread rather than being cleared.
    expect(payloadPatchFor(withEmail, 'person')).toEqual({ person: { addresses: [] } });
  });
});
