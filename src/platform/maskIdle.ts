import { maskStore } from '../store/maskStore';

export const MASK_IDLE_MS = 15 * 60_000;

const INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

/** Turn Mask back on after `MASK_IDLE_MS` without user input while it is off. */
export function startMaskIdle(): () => void {
  let lastInput = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const noteInput = () => (lastInput = Date.now());

  const check = () => {
    const left = lastInput + MASK_IDLE_MS - Date.now();
    if (left > 0) timer = setTimeout(check, left);
    else maskStore.getState().setMask(true);
  };
  const arm = (mask: boolean) => {
    clearTimeout(timer);
    if (mask) return;
    lastInput = Date.now();
    timer = setTimeout(check, MASK_IDLE_MS);
  };

  for (const type of INPUT) window.addEventListener(type, noteInput, { capture: true, passive: true });
  const unsubscribe = maskStore.subscribe((s, prev) => s.mask !== prev.mask && arm(s.mask));
  arm(maskStore.getState().mask);

  return () => {
    clearTimeout(timer);
    for (const type of INPUT) window.removeEventListener(type, noteInput, { capture: true });
    unsubscribe();
  };
}
