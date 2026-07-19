// Phone numbers (and handles) as an identity to match on, the way lib/email/addresses
// normalises an address. A text or a call finds a person by the number on it, so both
// the number stored on the actor and the one on the message must fold to the same key.
//
// A local number and its international form are the same number, so they must fold
// together: `0403 123 456` and `+61 403 123 456` are one person's mobile. That needs a
// region, which the board carries as its `countryCode` property and hands to
// `setLocalCallingCode` when it opens — a leading national-trunk `0` becomes that
// calling code. Absent a setting, the default is Australia (+61).

let localCallingCode = '+61';

/** Set the calling code a leading national `0` folds to — from meta.countryCode on
 *  board load, and whenever the setting changes (see boardStore). */
export function setLocalCallingCode(code: string): void {
  const c = code.trim();
  const digits = c.replace(/\D/g, '');
  localCallingCode = digits ? `+${digits}` : '+61';
}

/** The configured calling code (e.g. `+61`). */
export function getLocalCallingCode(): string {
  return localCallingCode;
}

/**
 * The number as an identity key: canonical international form. A leading `+` is kept;
 * `00…` (international access) becomes `+…`; a leading national-trunk `0` becomes the
 * configured calling code, so the local and international spellings of one number fold
 * together. Anything else (no `0`, no `+`) is left as bare digits — there is no region
 * to read it against.
 */
export function normaliseNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `${localCallingCode}${digits.slice(1)}`;
  return digits;
}

/**
 * A number for display: canonical first, then grouped so it reads as a phone number.
 * Australian (+61) mobiles group `+61 4XX XXX XXX` and landlines `+61 X XXXX XXXX`;
 * other calling codes get a light, even grouping. A region-less number is returned as
 * its bare digits.
 */
export function formatNumber(raw: string): string {
  const n = normaliseNumber(raw);
  if (!n || !n.startsWith('+')) return n;

  if (n.startsWith('+61')) {
    const rest = n.slice(3); // national significant number
    if (rest.length === 9) {
      // Mobile 4XX XXX XXX; landline (area 2/3/7/8) X XXXX XXXX.
      return rest.startsWith('4')
        ? `+61 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`
        : `+61 ${rest.slice(0, 1)} ${rest.slice(1, 5)} ${rest.slice(5)}`;
    }
    return `+61 ${rest}`; // an unusual length (13/1300 etc.) — just part the code off.
  }

  // Only group when we know where the country code ends — the configured one. Any
  // other code (a number typed with its own +) is left canonical rather than
  // mis-split, since code lengths vary (+1 vs +61).
  if (localCallingCode !== '+61' && n.startsWith(localCallingCode)) {
    const rest = n.slice(localCallingCode.length);
    return rest ? `${localCallingCode} ${(rest.match(/.{1,3}/g) ?? [rest]).join(' ')}` : n;
  }
  return n;
}
