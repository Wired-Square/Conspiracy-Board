import { For, Show, createSignal } from 'solid-js';
import { Button, Popover } from '@wired-square/kit';
import { check } from '@wired-square/icons/solid';
import { KIND_META } from '../../lib/kinds';
import type { CardKind } from '../../types/board';

type Props = {
  /** The present timeline kinds, in CARD_KINDS order — one checklist row each. */
  kinds: CardKind[];
  /** Kinds toggled off. The trigger lights up while this has any member. */
  hidden: Set<CardKind>;
  /** Raw per-kind totals, shown as a muted badge so a row says how much it hides. */
  counts: Map<CardKind, number>;
  onToggle: (kind: CardKind) => void;
  onReset: () => void;
};

/**
 * The timeline's kind filter: one button, lit when a filter is applied, opening a
 * checklist of the kinds on the strip so any can be shown or hidden independently.
 *
 * Its own small dropdown rather than the shared Menu: that one is a single-choice
 * chooser that closes on every pick, and a filter you tick several boxes in must
 * stay open.
 */
export function TimelineKindFilter(props: Props) {
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;

  return (
    <div class="timeline__filter">
      <Button
        ref={trigger}
        class={props.hidden.size ? 'is-active' : ''}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
        title="Show or hide card kinds on the timeline"
      >
        Filter
      </Button>
      <Show when={open()}>
        <Popover anchor={trigger} onClose={() => setOpen(false)}>
          <div
            class="timeline__filter-menu"
            role="menu"
            aria-label="Show on timeline"
            onKeyDown={(e) => e.key === 'Tab' && setOpen(false)}
          >
            <For each={props.kinds}>
              {(k) => {
                const shown = () => !props.hidden.has(k);
                return (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={shown()}
                    class="app-menu__item timeline__filter-option"
                    onClick={() => props.onToggle(k)}
                  >
                    <span class="timeline__filter-check" aria-hidden="true">
                      {shown() && check()}
                    </span>
                    {KIND_META[k].label}
                    <span class="timeline__filter-count">{props.counts.get(k) ?? 0}</span>
                  </button>
                );
              }}
            </For>
            <button
              type="button"
              class="app-menu__item timeline__filter-reset"
              onClick={() => props.onReset()}
              disabled={props.hidden.size === 0}
            >
              Reset
            </button>
          </div>
        </Popover>
      </Show>
    </div>
  );
}
