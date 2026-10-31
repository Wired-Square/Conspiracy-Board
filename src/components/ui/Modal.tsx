import { useEffect, useRef, type ReactNode } from 'react';
import { pushModal } from '../../lib/modalStack';

type Props = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
};

export function Modal({ title, onClose, children, footer }: Props) {
  // Through a ref so the stack entry binds once, not on every onClose identity: a
  // dialog whose owner re-renders per keystroke (the card editor) would otherwise
  // re-stack on each key.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => pushModal(() => onCloseRef.current()), []);

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
