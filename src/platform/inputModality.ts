/**
 * Marks the root `data-modality="keyboard"` from a key press (not Escape or a shortcut)
 * until the next pointer press. WebKit counts focus moved by script, such as a dialog
 * opening or closing, as `:focus-visible`, so the stylesheet keys its rings off this.
 */
export function startInputModality(root: HTMLElement = document.documentElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && !e.metaKey && !e.ctrlKey) root.dataset.modality = 'keyboard';
  };
  const onPointer = () => delete root.dataset.modality;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
    delete root.dataset.modality;
  };
}
