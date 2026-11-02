import { Show } from 'solid-js';
import { Dialog } from '@wired-square/kit';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';

// A full-screen spinner with a line of text, for work the user has to wait on with
// nothing else to look at — a bundle import storing its media (see importBoard).
// A dialog, so the top layer puts it over the first-run or import dialog it can follow.
export function BusyOverlay() {
  const status = fromStore(boardStore, (s) => s.importStatus);
  return (
    <Show when={status()}>
      <Dialog aria-label="Working" pending onClose={() => {}}>
        <div class="busy-overlay" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true" />
          <span class="busy-overlay__text">{status()}</span>
        </div>
      </Dialog>
    </Show>
  );
}
