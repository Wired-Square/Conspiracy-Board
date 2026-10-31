/** @jsxImportSource solid-js */
import { Index, Show, createEffect, createSignal } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import { createDismissal } from './createDismissal';

export type MenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

type Props = {
  label: string;
  items: MenuItem[];
  /** When set, the item whose label matches is shown ticked (a chooser, not a menu). */
  selectedLabel?: string;
};

/**
 * A small dropdown menu. Hand-rolled to match the rest of this codebase, which
 * has no UI dependencies.
 *
 * Items are data rather than children: every call site is a flat list, and an
 * array makes the roving focus below trivial.
 */
export function Menu(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let wrapper!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const itemEls: HTMLButtonElement[] = [];

  createDismissal(open, () => setOpen(false), () => wrapper, () => trigger);

  // Move real focus with the active index, so screen readers follow along.
  createEffect(() => {
    if (open()) itemEls[activeIndex()]?.focus();
  });

  /** Next selectable item in `delta`'s direction, wrapping. */
  const step = (from: number, delta: number): number => {
    // Move one slot at a time so the wrap correction is a plain `+ length`, and
    // give up after a full lap so an all-disabled menu can't spin forever.
    const items = props.items;
    let next = from;
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) return next;
    }
    return from;
  };

  const openAt = (index: number) => {
    setActiveIndex(props.items[index]?.disabled ? step(index, 1) : index);
    setOpen(true);
  };

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAt(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(props.items.length - 1);
    }
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    const to = {
      ArrowDown: () => step(activeIndex(), 1),
      ArrowUp: () => step(activeIndex(), -1),
      Home: () => step(-1, 1),
      End: () => step(props.items.length, -1),
    }[e.key];
    if (!to) return;
    e.preventDefault();
    setActiveIndex(to());
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    // Close before acting: an item that opens a dialog must not leave a live
    // menu behind competing for Escape.
    setOpen(false);
    item.onSelect();
  };

  const chooser = () => props.selectedLabel !== undefined;

  return (
    <div class="menu" ref={wrapper}>
      <button
        ref={trigger}
        class="menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : openAt(0))}
        onKeyDown={onTriggerKeyDown}
      >
        {props.label}
        <span class="menu__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      <Show when={open()}>
        <div class="menu__list" role="menu" aria-label={props.label} onKeyDown={onListKeyDown}>
          <Index each={props.items}>
            {(item, i) => (
              <button
                ref={(el) => (itemEls[i] = el)}
                role={chooser() ? 'menuitemradio' : 'menuitem'}
                aria-checked={chooser() ? props.selectedLabel === item().label : undefined}
                tabIndex={-1}
                class={cx('menu__item', props.selectedLabel === item().label && 'is-selected')}
                disabled={item().disabled}
                onClick={() => select(item())}
                onMouseEnter={() => !item().disabled && setActiveIndex(i)}
              >
                {item().label}
              </button>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}
