import type { OrgMeta, PersonMeta } from '../types/board';
import { normaliseAddress, normaliseDomain } from './email/addresses';
import { normaliseNumber } from './phone';

// What an actor holds: the addresses and domains their mail is found by. These
// build and edit the payload; lib/roster.ts is what *matches* on it.
//
// They live here rather than in roster.ts because they are not roster logic —
// they are a card's payload, the same way emptyEmailMeta belongs to
// lib/email/meta.ts. Keeping them there also made kinds.ts import roster.ts,
// which stopped roster.ts asking kinds.ts anything back. A payload constructor
// is not worth a cycle.

/** A blank person, for a card switched to kind 'person' by hand. */
export function emptyPersonMeta(): PersonMeta {
  return { addresses: [] };
}

/** A blank organisation. */
export function emptyOrgMeta(): OrgMeta {
  return { addresses: [], domains: [] };
}

/**
 * Add an address to an entity, normalised and duplicate-free. Shared by people
 * and organisations, which both hold addresses — an organisation is a legal
 * person too, and info@ is nobody's personal mail.
 */
export function withAddress<T extends { addresses: string[] }>(meta: T, address: string): T {
  const a = normaliseAddress(address);
  if (!a || meta.addresses.includes(a)) return meta;
  return { ...meta, addresses: [...meta.addresses, a] };
}

export function withDomain(meta: OrgMeta, domain: string): OrgMeta {
  const d = normaliseDomain(domain);
  if (!d || meta.domains.includes(d)) return meta;
  return { ...meta, domains: [...meta.domains, d] };
}

/**
 * Add a phone number/handle to an actor, normalised and duplicate-free — the sibling
 * of `withAddress`, for the identity a text or call matches on. Shared by people and
 * organisations (a body has a switchboard). `numbers` is optional, so this seeds it.
 */
export function withNumber<T extends { numbers?: string[] }>(meta: T, number: string): T {
  const n = normaliseNumber(number);
  const existing = meta.numbers ?? [];
  if (!n || existing.includes(n)) return meta;
  return { ...meta, numbers: [...existing, n] };
}

/**
 * Remove an address from an entity — the inverse of `withAddress`, for unlinking. A
 * badge is derived from a shared address, so dropping it here is what un-links it,
 * everywhere that address resolved.
 */
export function withoutAddress<T extends { addresses: string[] }>(meta: T, address: string): T {
  const a = normaliseAddress(address);
  if (!a || !meta.addresses.includes(a)) return meta;
  return { ...meta, addresses: meta.addresses.filter((x) => x !== a) };
}

/** Remove a phone number from an actor — the inverse of `withNumber`. */
export function withoutNumber<T extends { numbers?: string[] }>(meta: T, number: string): T {
  const n = normaliseNumber(number);
  const existing = meta.numbers ?? [];
  if (!n || !existing.includes(n)) return meta;
  return { ...meta, numbers: existing.filter((x) => x !== n) };
}
