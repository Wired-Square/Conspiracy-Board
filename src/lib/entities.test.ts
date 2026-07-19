import { describe, expect, it } from 'vitest';
import {
  emptyOrgMeta,
  emptyPersonMeta,
  withAddress,
  withDomain,
  withNumber,
  withoutAddress,
  withoutNumber,
} from './entities';

// What an actor holds. lib/roster.ts is what matches on it; these build it.

describe('withAddress / withDomain', () => {
  it('normalises on the way in', () => {
    expect(withAddress(emptyPersonMeta(), ' Jane@ACME.com ')).toEqual({
      addresses: ['jane@acme.com'],
    });
    expect(withDomain(emptyOrgMeta(), '@Acme.COM ')).toEqual({
      addresses: [],
      domains: ['acme.com'],
    });
  });

  it('does not add the same address twice, however it was typed', () => {
    const one = withAddress(emptyPersonMeta(), 'jane@acme.com');
    expect(withAddress(one, 'JANE@acme.com')).toBe(one); // unchanged, same object
  });

  it('ignores an empty address rather than storing a blank', () => {
    expect(withAddress(emptyPersonMeta(), '   ').addresses).toEqual([]);
  });

  it('works for an organisation, which holds addresses too', () => {
    expect(withAddress(emptyOrgMeta(), 'legal@acme.com')).toEqual({
      addresses: ['legal@acme.com'],
      domains: [],
    });
  });
});

describe('withoutAddress / withoutNumber', () => {
  it('removes a normalised address, however it was typed', () => {
    const meta = withAddress(emptyPersonMeta(), 'jane@acme.com');
    expect(withoutAddress(meta, 'JANE@acme.com ').addresses).toEqual([]);
  });

  it('leaves the meta untouched when the value is not held', () => {
    const meta = withAddress(emptyPersonMeta(), 'jane@acme.com');
    expect(withoutAddress(meta, 'bob@acme.com')).toBe(meta); // same object
  });

  it('removes a number by its canonical form, however it was typed', () => {
    const meta = withNumber(emptyPersonMeta(), '0403 123 456');
    expect(meta.numbers).toEqual(['+61403123456']);
    expect(withoutNumber(meta, '+61 403 123 456').numbers).toEqual([]);
  });
});
