import { useEffect, useRef, useState } from 'react';

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
 * Items are data rather than children: both call sites are flat lists, and an
 * array makes the roving focus below trivial.
 */
export function Menu({ label, items, selectedLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;

    // pointerdown, not click: a click listener registered during the opening
    // click would fire immediately and close the menu on open.
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Move real focus with the active index, so screen readers follow along.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  /** Next selectable item in `delta`'s direction, wrapping. */
  const step = (from: number, delta: number): number => {
    // Move one slot at a time so the wrap correction is a plain `+ length`, and
    // give up after a full lap so an all-disabled menu can't spin forever.
    let next = from;
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) return next;
    }
    return from;
  };

  const openAt = (index: number) => {
    setActiveIndex(items[index]?.disabled ? step(index, 1) : index);
    setOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAt(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(items.length - 1);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => step(i, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => step(i, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(step(-1, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(step(items.length, -1));
    }
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    // Close before acting: an item that opens a dialog must not leave a live
    // menu behind competing for Escape.
    setOpen(false);
    item.onSelect();
  };

  return (
    <div className="menu" ref={wrapperRef}>
      <button
        ref={triggerRef}
        className="menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <span className="menu__caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="menu__list" role="menu" aria-label={label} onKeyDown={onListKeyDown}>
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role={selectedLabel === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={selectedLabel === undefined ? undefined : selectedLabel === item.label}
              tabIndex={-1}
              className={`menu__item${selectedLabel === item.label ? ' is-selected' : ''}`}
              disabled={item.disabled}
              onClick={() => select(item)}
              onMouseEnter={() => !item.disabled && setActiveIndex(i)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
