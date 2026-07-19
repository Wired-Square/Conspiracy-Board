import { useEffect, useRef, useState } from 'react';
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
 * stay open. The dismiss handling is the same though — see Menu for why pointerdown.
 */
export function TimelineKindFilter({ kinds, hidden, counts, onToggle, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown, not click: a click listener added during the opening click would
    // fire on that same click and close the menu on open.
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

  return (
    <div className="timeline__filter" ref={wrapperRef}>
      <button
        ref={triggerRef}
        className={hidden.size ? 'is-active' : ''}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Show or hide card kinds on the timeline"
      >
        Filter
      </button>
      {open && (
        <div className="timeline__filter-menu" role="menu" aria-label="Show on timeline">
          {kinds.map((k) => {
            const shown = !hidden.has(k);
            return (
              <button
                key={k}
                role="menuitemcheckbox"
                aria-checked={shown}
                className="timeline__filter-option"
                onClick={() => onToggle(k)}
              >
                <span className="timeline__filter-check" aria-hidden>
                  {shown ? '☑' : '☐'}
                </span>
                {KIND_META[k].label}
                <span className="timeline__filter-count">{counts.get(k) ?? 0}</span>
              </button>
            );
          })}
          <button
            className="timeline__filter-reset"
            onClick={onReset}
            disabled={hidden.size === 0}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
