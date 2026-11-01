import { Show } from 'solid-js';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';

// A full-screen spinner with a line of text, for work the user has to wait on with
// nothing else to look at — a bundle import storing its media (see importBoard).
// Above the modals, since it can sit over the first-run or import dialogs.
export function BusyOverlay() {
  const status = fromStore(boardStore, (s) => s.importStatus);
  return (
    <Show when={status()}>
      <div class="busy-overlay" role="status" aria-live="polite">
        <div class="busy-overlay__box">
          <span class="spinner" aria-hidden="true" />
          <span class="busy-overlay__text">{status()}</span>
        </div>
      </div>
    </Show>
  );
}
