import { For } from 'solid-js';
import { Menu, MenuItem, MenuItemCheckbox } from '@wired-square/kit';
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

export function TimelineKindFilter(props: Props) {
  return (
    <div class={props.hidden.size ? 'timeline__filter is-active' : 'timeline__filter'}>
      <Menu tone="default" align="start" aria-label="Filter the kinds shown on the timeline" trigger="Filter">
        <For each={props.kinds}>
          {(k) => (
            <MenuItemCheckbox checked={!props.hidden.has(k)} onSelect={() => props.onToggle(k)}>
              {KIND_META[k].label}
              <span class="timeline__filter-count">{props.counts.get(k) ?? 0}</span>
            </MenuItemCheckbox>
          )}
        </For>
        <MenuItem disabled={props.hidden.size === 0} onSelect={() => props.onReset()}>
          Reset
        </MenuItem>
      </Menu>
    </div>
  );
}
