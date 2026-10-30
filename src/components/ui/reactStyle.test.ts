import { describe, expect, it } from 'vitest';
import { reactStyle } from './reactStyle';

describe('reactStyle', () => {
  it('camel-cases properties and passes custom properties through', () => {
    expect(reactStyle({ 'max-width': 'none', left: '0', '--grade-ink': '#fff' })).toEqual({
      maxWidth: 'none',
      left: '0',
      '--grade-ink': '#fff',
    });
  });

  it('hands the same map back the same style', () => {
    const css = { top: '0' };
    expect(reactStyle(css)).toBe(reactStyle(css));
  });
});
