import { useEffect, useRef, type ReactNode } from 'react';

type Props = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
};

// The stack of open modals, innermost last — a modal mounted over another (a picker
// on the card editor) mounts later and so sits on top. Escape closes only the top
// one, so a single keypress never dismisses two stacked dialogs; no dialog needs to
// know which one is above it.
const modalStack: object[] = [];

export function Modal({ title, onClose, children, footer }: Props) {
  // Through a ref so the listener binds once, not on every onClose identity: a
  // dialog whose owner re-renders per keystroke (the card editor) would otherwise
  // tear down and re-add this on each key.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tokenRef = useRef({});
  useEffect(() => {
    const token = tokenRef.current;
    modalStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modalStack[modalStack.length - 1] !== token) return; // only the top-most
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(token);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, []);

  return (
    // No backdrop click-to-close: over the busy board a mis-aimed click would
    // discard the dialog. Closing is deliberate only — the Close button or Escape.
    <div className="modal__backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <span className="panel-heading">{title}</span>
          <button className="link-button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
