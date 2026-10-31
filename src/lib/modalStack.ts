// The stack of open modals, innermost last — a modal mounted over another (a picker
// on the card editor) mounts later and so sits on top. Escape closes only the top
// one, so a single keypress never dismisses two stacked dialogs; no dialog needs to
// know which one is above it.
const stack: (() => void)[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') stack[stack.length - 1]?.();
}

/** Puts a modal's close on top of the stack; returns its removal. */
export function pushModal(close: () => void): () => void {
  const entry = () => close();
  if (stack.length === 0) window.addEventListener('keydown', onKey);
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    if (stack.length === 0) window.removeEventListener('keydown', onKey);
  };
}
