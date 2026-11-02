/** The top modal dialog: the one holding focus, else the last open in the document. */
export function topDialog(target: EventTarget | null): HTMLDialogElement | undefined {
  const focused = target instanceof Element ? target.closest<HTMLDialogElement>('dialog[open]') : null;
  return focused ?? [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
}

/**
 * Escape cancels the top dialog. The macOS webview does this itself only once the
 * page has user activation, so this does it always, and takes the default action
 * so the webview's own cancel can't close a second dialog.
 */
export function startDialogEscape(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const dialog = topDialog(e.target);
    if (!dialog) return;
    e.preventDefault();
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
