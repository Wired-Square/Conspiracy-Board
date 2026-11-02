/** Up to two letters for an actor without a picture: the first and last words' first letters. */
export function initials(name: string): string {
  const words = name
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (!words.length) return '';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** A card's resting tilt in degrees, within ±1 and the same every time for one id. */
export function cardTilt(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return ((Math.abs(hash) % 201) - 100) / 100;
}
