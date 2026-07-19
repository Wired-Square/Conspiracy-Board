import { useEffect, useState } from 'react';

/**
 * `value`, but only after it has held still for `ms`. Keeps a fast-changing input
 * (a search box's local text) from driving expensive work on every keystroke: the
 * box updates instantly, its debounced copy lags behind and settles when typing
 * pauses. Shared by the toolbar and timeline search boxes.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
