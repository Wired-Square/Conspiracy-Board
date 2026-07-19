import { useBoardStore } from '../../store/boardStore';
// The app's own mark — the single source in src-tauri/icons, imported as a URL by
// Vite rather than copied, so it can't drift from the icon everything else is
// generated from.
import logo from '../../../src-tauri/icons/icon.svg';

// The first-run choice, shown only when the library is genuinely empty (see
// boardStore.firstRun). The app never seeds a board on its own — least of all the
// example — so this is where a first board comes from: an empty one to fill, or
// the worked example to look around.
//
// Deliberately not built on Modal: there is no board behind it and no Close, so it
// can't be dismissed — a choice is required — and it wears the modal chrome
// directly rather than borrowing the header's close button.
export function FirstRunModal() {
  const newBoard = useBoardStore((s) => s.newBoard);
  const installExampleBoard = useBoardStore((s) => s.installExampleBoard);
  const importBoard = useBoardStore((s) => s.importBoard);
  // An error from any of these actions (a failed import most likely) would
  // otherwise be invisible — the toolbar that shows lastError isn't mounted while
  // the welcome dialog is, so say it here instead.
  const lastError = useBoardStore((s) => s.lastError);

  return (
    <div className="modal__backdrop">
      <div className="modal first-run" role="dialog" aria-modal="true" aria-label="Start a board">
        <header className="modal__header first-run__header">
          <img className="first-run__logo" src={logo} alt="" width={34} height={34} />
          <span className="panel-heading">Start a board</span>
        </header>
        <div className="modal__body">
          <p className="hint">
            Welcome. The corkboard’s bare — no pins, no photos, not a thread of red
            string yet. Where shall we begin?
          </p>
          <div className="first-run__choices">
            <button className="first-run__choice" onClick={() => void newBoard()}>
              <span className="first-run__choice-title">Start from scratch</span>
              <span className="first-run__choice-note">An empty corkboard to fill.</span>
            </button>
            <button className="first-run__choice" onClick={() => void importBoard()}>
              <span className="first-run__choice-title">Import a board</span>
              <span className="first-run__choice-note">From an exported bundle.</span>
            </button>
            <button className="first-run__choice" onClick={() => void installExampleBoard()}>
              <span className="first-run__choice-title">Example board</span>
              <span className="first-run__choice-note">
                “The Nightingale File” — ready to explore.
              </span>
            </button>
          </div>
          {lastError && <p className="modal__warn">{lastError}</p>}
        </div>
      </div>
    </div>
  );
}
