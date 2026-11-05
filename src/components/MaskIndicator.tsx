import { Show } from 'solid-js';
import { Button } from '@wired-square/kit';
import { fromStore } from '@wired-square/store/solid';
import { maskStore } from '../store/maskStore';

export function MaskIndicator() {
  const mask = fromStore(maskStore, (s) => s.mask);
  return (
    <Show when={!mask()}>
      <Button
        class="mcp-indicator mask-indicator"
        title="Confidential cards are showing. Click to mask them again."
        onClick={() => maskStore.getState().setMask(true)}
      >
        <span class="mcp-indicator__dot" aria-hidden="true" />
        Unmasked
      </Button>
    </Show>
  );
}
