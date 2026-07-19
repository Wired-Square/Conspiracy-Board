import type { EmailAddress } from '../../types/board';

// Lenient address handling for the manual-entry fields. Imported mail arrives
// already structured from the MIME parser, so this only has to cope with what a
// person types or pastes: `Name <a@b.com>`, a bare address, or a display name.

const ANGLE = /^\s*(.*?)\s*<([^>]+)>\s*$/;

export function parseAddress(input: string): EmailAddress | null {
  const raw = input.trim();
  if (!raw) return null;

  const m = ANGLE.exec(raw);
  if (m) {
    // Strip quotes around a display name: "Doe, Jane" <j@x.com>
    const name = m[1].replace(/^"(.*)"$/, '$1').trim();
    return name ? { name, address: m[2].trim() } : { address: m[2].trim() };
  }
  return { address: raw };
}

/**
 * Split a comma-separated list. Commas inside a quoted display name are not
 * separators — `"Doe, Jane" <j@x.com>` is one address, not two.
 */
export function parseAddressList(input: string): EmailAddress[] {
  const parts: string[] = [];
  let buf = '';
  let quoted = false;
  let angled = false;

  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angled = true;
    else if (ch === '>') angled = false;
    else if (ch === ',' && !quoted && !angled) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);

  return parts.map(parseAddress).filter((a): a is EmailAddress => a !== null);
}

/** Render an address for an input field or a card face. */
export function formatAddress(a: EmailAddress | null): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddressList(list: EmailAddress[]): string {
  return list.map(formatAddress).join(', ');
}

/** Shortest useful label for an address: the display name, else the address. */
export function shortAddress(a: EmailAddress | null): string {
  if (!a) return 'unknown sender';
  return a.name || a.address;
}

// Identity, below. Everything above renders or reads addresses; this is what
// decides whether two of them are the same one — which is what people and
// organisations are matched on (see lib/roster.ts).

/**
 * Fold an address to the identity emails match on.
 *
 * Lowercases: the domain is case-insensitive per RFC 5321, and while the local
 * part technically is not, no mail system in real use treats it otherwise —
 * filing `Jane@X.com` apart from `jane@x.com` would be a bug wearing the costume
 * of fidelity.
 *
 * Case-folding and trimming is *all* it does. Notably it does not strip plus
 * tags: `jane+tender@acme.com` → `jane@acme.com` is a Gmail convention, not a
 * rule, and silently merging two literal addresses is evidence handling nobody
 * asked for. A person who uses both can hold both — that is why PersonMeta
 * carries a list.
 */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The domain half of an address, normalised, or null when there isn't one.
 *
 * Splits on the *last* `@`, not the first: a quoted local part may legally
 * contain one (`"odd@name"@acme.com`), and the domain is what we are after.
 */
export function addressDomain(address: string): string | null {
  const normalised = normaliseAddress(address);
  const at = normalised.lastIndexOf('@');
  if (at <= 0) return null; // no '@', or nothing before it
  return normalised.slice(at + 1) || null;
}

/** Normalise a domain someone typed: a leading '@' is a natural thing to write. */
export function normaliseDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, '');
}
