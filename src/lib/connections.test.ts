import { describe, expect, it } from 'vitest';
import { touches } from './connections';

describe('touches', () => {
  const link = { source: 'card_a', target: 'card_b' };

  it('finds the card at either end', () => {
    // The direction is how the string was drawn, not what it claims. Asking only
    // about `source` is the bug this exists to prevent: it hides until a card is
    // deleted from the far end and leaves its string dangling.
    expect(touches(link, 'card_a')).toBe(true);
    expect(touches(link, 'card_b')).toBe(true);
  });

  it('ignores string between two other cards', () => {
    expect(touches(link, 'card_c')).toBe(false);
  });

  it('is true of a self-link, which the store refuses to make anyway', () => {
    expect(touches({ source: 'card_a', target: 'card_a' }, 'card_a')).toBe(true);
  });
});
