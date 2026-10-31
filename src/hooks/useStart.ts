import { useEffect } from 'react';

/** Run a framework-free `start*()` for the component's lifetime; its return tears it down. */
export function useStart(start: () => () => void): void {
  useEffect(start, [start]);
}
