// The app's own mark — the single source in src-tauri/icons, imported as a URL by
// Vite rather than copied, so it can't drift from the icon everything else is
// generated from.
import logo from '../../../src-tauri/icons/icon.svg';
import { Button, Dialog, Notice } from '@wired-square/kit';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';

// The first-run choice, shown only when the library is genuinely empty (see
// boardStore.firstRun). The app never seeds a board on its own — least of all the
// example — so this is where a first board comes from: an empty one to fill, or
// the worked example to look around.
//
// Pending for good, so Escape can't dismiss it: there is no board behind it, and a
// choice is required.
export function FirstRunModal() {
  const actions = boardStore.getState();
  // An error from any of these actions (a failed import most likely) would
  // otherwise be invisible — the toolbar that shows lastError isn't mounted while
  // the welcome dialog is, so say it here instead.
  const lastError = fromStore(boardStore, (s) => s.lastError);

  return (
    <Dialog aria-label="Start a board" pending onClose={() => {}}>
      <header class="first-run__header">
        <img class="first-run__logo" src={logo} alt="" width={34} height={34} />
        <h2 class="app-dialog__title">Start a board</h2>
      </header>
      <p class="hint">
        Welcome. The corkboard’s bare — no pins, no photos, not a thread of red
        string yet. Where shall we begin?
      </p>
      <div class="first-run__choices">
        <Button class="first-run__choice" onClick={() => void actions.newBoard()}>
          <span class="first-run__choice-title">Start from scratch</span>
          <span class="first-run__choice-note">An empty corkboard to fill.</span>
        </Button>
        <Button class="first-run__choice" onClick={() => void actions.importBoard()}>
          <span class="first-run__choice-title">Import a board</span>
          <span class="first-run__choice-note">From an exported bundle.</span>
        </Button>
        <Button class="first-run__choice" onClick={() => void actions.installExampleBoard()}>
          <span class="first-run__choice-title">Example board</span>
          <span class="first-run__choice-note">
            “The Nightingale File” — ready to explore.
          </span>
        </Button>
      </div>
      <Notice tone="bad">{lastError()}</Notice>
    </Dialog>
  );
}
