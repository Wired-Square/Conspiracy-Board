// A full-screen spinner with a line of text, for work the user has to wait on with
// nothing else to look at — a bundle import storing its media (see importBoard).
// Above the modals, since it can sit over the first-run or import dialogs.
export function BusyOverlay({ status }: { status: string }) {
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-overlay__box">
        <span className="spinner" aria-hidden />
        <span className="busy-overlay__text">{status}</span>
      </div>
    </div>
  );
}
