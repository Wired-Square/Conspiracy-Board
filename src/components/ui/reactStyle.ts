import type { CSSProperties } from 'react';

const converted = new WeakMap<Record<string, string>, CSSProperties>();

/** A framework-neutral kebab-case style map as React's camelCase `style`; custom properties pass through. */
export function reactStyle(css: Record<string, string>): CSSProperties {
  let style = converted.get(css);
  if (!style) {
    style = Object.fromEntries(
      Object.entries(css).map(([k, v]) => [k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
    );
    converted.set(css, style);
  }
  return style;
}
