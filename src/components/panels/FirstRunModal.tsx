// The app's own mark — the single source in src-tauri/icons, imported as a URL by
// Vite rather than copied, so it can't drift from the icon everything else is
// generated from.
import logo from '../../../src-tauri/icons/icon.svg';
import { Show } from 'solid-js';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';

// The first-run choice, shown only when the library is genuinely empty (see
// boardStore.firstRun). The app never seeds a board on its own — least of all the
// example — so this is where a first board comes from: an empty one to fill, or
// the worked example to look around.
//
// Deliberately not built on Modal: there is no board behind it and no Close, so it
// can't be dismissed — a choice is required — and it wears the modal chrome
// directly rather than borrowing the header's close button.
export function FirstRunModal() {
  const actions = boardStore.getState();
  // An error from any of these actions (a failed import most likely) would
  // otherwise be invisible — the toolbar that shows lastError isn't mounted while
  // the welcome dialog is, so say it here instead.
  const lastError = fromStore(boardStore, (s) => s.lastError);

  return (
    <div class="modal__backdrop">
      <div class="modal first-run" role="dialog" aria-modal="true" aria-label="Start a board">
        <header class="modal__header first-run__header">
          <img class="first-run__logo" src={logo} alt="" width={34} height={34} />
          <span class="panel-heading">Start a board</span>
        </header>
        <div class="modal__body">
          <p class="hint">
            Welcome. The corkboard’s bare — no pins, no photos, not a thread of red
            string yet. Where shall we begin?
          </p>
          <div class="first-run__choices">
            <button class="first-run__choice" onClick={() => void actions.newBoard()}>
              <span class="first-run__choice-title">Start from scratch</span>
              <span class="first-run__choice-note">An empty corkboard to fill.</span>
            </button>
            <button class="first-run__choice" onClick={() => void actions.importBoard()}>
              <span class="first-run__choice-title">Import a board</span>
              <span class="first-run__choice-note">From an exported bundle.</span>
            </button>
            <button class="first-run__choice" onClick={() => void actions.installExampleBoard()}>
              <span class="first-run__choice-title">Example board</span>
              <span class="first-run__choice-note">
                “The Nightingale File” — ready to explore.
              </span>
            </button>
          </div>
          <Show when={lastError()}>
            <p class="modal__warn">{lastError()}</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
