import type { FitOptions } from '@wired-square/canvas/core';

export const FIT_WAIT_MS = 3000;

export type PendingFit = { readonly options: FitOptions; readonly awaiting: readonly string[]; readonly expiresAt: number };

/** A fit that waits for those of its ids not drawn yet; null when every one is drawn already. */
export function awaitFit(options: FitOptions, isDrawn: (id: string) => boolean, now: number): PendingFit | null {
  const awaiting = (options.ids ?? []).filter((id) => !isDrawn(id));
  return awaiting.length ? { options, awaiting, expiresAt: now + FIT_WAIT_MS } : null;
}

// One awaited id drawn means the edit carrying them has landed; an id still absent
// then is one the board does not draw, which fitView already passes over.
export function settleFit(fit: PendingFit, isDrawn: (id: string) => boolean, now: number): 'fit' | 'wait' | 'drop' {
  if (now > fit.expiresAt) return 'drop';
  return fit.awaiting.some(isDrawn) ? 'fit' : 'wait';
}
