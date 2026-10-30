import { describe, expect, it } from 'vitest';
import type { Card } from '../../types/board';
import { emptyEmailMeta } from './meta';
import type { EmailDraft } from './parseEmails';
import { addLabel, batchStatus, cap, clusterLabelFor, hidden, matchBatch } from './importSummary';

const draft = (title: string, messageId: string | null = null, notes = ''): EmailDraft => ({
  kind: 'email',
  title,
  notes,
  occurredAt: null,
  occurredAtPrecision: 'minute',
  email: { ...emptyEmailMeta(), messageId },
  media: { attachments: [{ name: 'a.pdf', ext: 'pdf', bytes: new ArrayBuffer(10) }], eml: new ArrayBuffer(100) },
});

const onBoard = { id: 'c1', kind: 'email', email: { ...emptyEmailMeta(), messageId: '<dup@x>' } } as Card;

describe('matchBatch', () => {
  it('counts duplicates and sizes only what will land', () => {
    const batch = matchBatch([draft('a', '<dup@x>'), draft('b', '<new@x>', 'hello')], new Map([['<dup@x>', onBoard]]));
    expect(batch.matches.map((m) => m.kind)).toEqual(['duplicate', 'new']);
    expect(batch.dupeCount).toBe(1);
    expect(batch.completesCount).toBe(0);
    expect(batch.addedBytes).toBe(5 + 10 + 100);
  });
});

describe('clusterLabelFor', () => {
  it('names a thread after its shared subject, without the reply chain', () => {
    expect(clusterLabelFor([draft('Plans'), draft('Re: Fwd: Plans'), draft('Other')])).toBe('Plans');
  });

  it('falls back when no message has a subject', () => {
    expect(clusterLabelFor([draft(' ')])).toBe('Email thread');
  });
});

describe('addLabel', () => {
  const none = { newCount: 0, newPeople: 0, newOrgs: 0, patchCount: 0, reclusterCount: 0 };

  it('says what will be added', () => {
    expect(addLabel({ ...none, newCount: 3, newPeople: 2, newOrgs: 1 })).toBe('Add 3 cards + 2 people, 1 organisation');
  });

  it('says Update when the rows only append to existing cards', () => {
    expect(addLabel({ ...none, patchCount: 1 })).toBe('Update 1 card');
  });

  it('says what joins the cluster when only duplicates are left', () => {
    expect(addLabel({ ...none, reclusterCount: 2 })).toBe('Add 2 cards to cluster');
    expect(addLabel(none)).toBe('Add 0 cards');
  });
});

describe('batchStatus', () => {
  it('lists only the parts that apply', () => {
    const batch = { matches: [], dupeCount: 1, completesCount: 0, addedBytes: 0 };
    expect(batchStatus(batch, 2, 0, true)).toMatch(/^2 to add · 1 added to cluster · ~/);
    expect(batchStatus(batch, 2, 1, false)).toMatch(/1 already on board · 1 existing card updated/);
  });
});

describe('cap', () => {
  it('shows fifty and counts the rest', () => {
    const c = cap(Array.from({ length: 60 }, (_, i) => i));
    expect(c.shown).toHaveLength(50);
    expect(hidden(c)).toBe(10);
  });
});
