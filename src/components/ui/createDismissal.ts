import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { pushModal } from '../../lib/modalStack';

/**
 * While `open()`, a dropdown closes on a pointerdown outside `wrapper`, on Tab, and on
 * Escape, which refocuses `trigger`. Escape goes through the modal stack, so a dropdown
 * over a dialog closes alone.
 */
export function createDismissal(
  open: Accessor<boolean>,
  close: () => void,
  wrapper: () => HTMLElement,
  trigger: () => HTMLElement,
) {
  createEffect(() => {
    if (!open()) return;
    // pointerdown, not click: a click listener added during the opening click would
    // fire on that same click and close the dropdown on open.
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper().contains(e.target as Node)) close();
    };
    const onTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onTab);
    const popModal = pushModal(() => {
      close();
      trigger().focus();
    });
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onTab);
      popModal();
    });
  });
}
