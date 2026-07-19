import { describe, expect, it } from 'vitest';
import { addressDomain, normaliseAddress, normaliseDomain } from './addresses';

// These three decide whether two addresses are the same person, and whether an
// address belongs to an organisation. Everything in lib/roster.ts is built on
// them, so the edge cases are worth pinning here rather than discovering on a
// board full of evidence.

describe('normaliseAddress', () => {
  it('folds case, so one person is one person', () => {
    expect(normaliseAddress('Jane@X.com')).toBe('jane@x.com');
    expect(normaliseAddress('jane@x.com')).toBe('jane@x.com');
  });

  it('trims, since addresses arrive from typed input', () => {
    expect(normaliseAddress('  jane@x.com \n')).toBe('jane@x.com');
  });

  it('does NOT strip plus tags — they are different literal addresses', () => {
    // A Gmail convention, not a rule. Merging them would be a decision about
    // someone's evidence that this layer has no business making; a person who
    // uses both can hold both.
    expect(normaliseAddress('jane+tender@acme.com')).toBe('jane+tender@acme.com');
  });
});

describe('addressDomain', () => {
  it('takes the domain, normalised', () => {
    expect(addressDomain('Jane@Acme.COM')).toBe('acme.com');
  });

  it('splits on the last @, not the first', () => {
    // A quoted local part may legally contain one; the domain is what we want.
    expect(addressDomain('"odd@name"@acme.com')).toBe('acme.com');
  });

  it('returns null when there is no domain to speak of', () => {
    expect(addressDomain('jane')).toBeNull();
    expect(addressDomain('jane@')).toBeNull();
    expect(addressDomain('@acme.com')).toBeNull(); // nothing before the @
    expect(addressDomain('')).toBeNull();
  });

  it('handles a subdomain as the domain it literally is', () => {
    // mail.acme.com is not acme.com. An organisation that wants both says so
    // with two domains rather than this guessing at the registrable suffix.
    expect(addressDomain('jane@mail.acme.com')).toBe('mail.acme.com');
  });
});

describe('normaliseDomain', () => {
  it('strips a leading @, which is a natural thing to type', () => {
    expect(normaliseDomain('@acme.com')).toBe('acme.com');
    expect(normaliseDomain('acme.com')).toBe('acme.com');
  });

  it('folds case and trims', () => {
    expect(normaliseDomain('  @Acme.COM ')).toBe('acme.com');
  });

  it('agrees with addressDomain, which is the point of both', () => {
    expect(normaliseDomain('@Acme.com')).toBe(addressDomain('jane@ACME.com'));
  });
});
