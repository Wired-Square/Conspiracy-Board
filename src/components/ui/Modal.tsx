import { Show, onCleanup, type JSX } from 'solid-js';
import { Button } from '@wired-square/kit';
import { pushModal } from '../../lib/modalStack';

type Props = {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
};

export function Modal(props: Props) {
  onCleanup(pushModal(() => props.onClose()));

  return (
    // No backdrop click-to-close: over the busy board a mis-aimed click would
    // discard the dialog. Closing is deliberate only — the Close button or Escape.
    <div class="modal__backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <header class="modal__header">
          <span class="panel-heading">{props.title}</span>
          <Button tone="plain" onClick={() => props.onClose()}>
            Close
          </Button>
        </header>
        <div class="modal__body">{props.children}</div>
        <Show when={props.footer}>{(footer) => <footer class="modal__footer">{footer()}</footer>}</Show>
      </div>
    </div>
  );
}
