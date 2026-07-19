import { useMemo, useState } from 'react';
import type { CardKind } from '../../types/board';
import { useBoardStore } from '../../store/boardStore';
import { CARD_KINDS, KIND_META, entitiesOfKind } from '../../lib/kinds';
import { Modal } from '../ui/Modal';

/** A "＋ New …" row, offered on the tab it belongs to. Its value is a sentinel the
 *  caller recognises (e.g. NEW_PERSON), handed back through onPick like a card id. */
export type PickerCreateOption = { kind: CardKind; label: string; value: string };

type Props = {
  /** Tabs to show. When named, shown even if empty so a create option stays
   *  reachable; otherwise only the kinds that have a (non-excluded) card, in
   *  registry order. */
  kinds?: CardKind[];
  /** A card to hide from the lists — the one being linked from. */
  excludeId?: string;
  createOptions?: PickerCreateOption[];
  onPick: (value: string) => void;
  onClose: () => void;
};

/**
 * Pick a card to link to, in a tab per type so a person reads apart from an email at
 * a glance — the flat "Link to…" select can't, and a library of a couple of hundred
 * records makes that unusable. Shared by the connections list and the from/to linker;
 * the value handed back is a card id, or one of the caller's create sentinels.
 */
export function EntityPickerDialog({ kinds, excludeId, createOptions = [], onPick, onClose }: Props) {
  const cards = useBoardStore((s) => s.cards);

  const counts = useMemo(() => {
    const m = new Map<CardKind, number>();
    for (const c of cards) if (c.id !== excludeId) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
    return m;
  }, [cards, excludeId]);

  const tabs = useMemo(
    () => kinds ?? CARD_KINDS.filter((k) => (counts.get(k) ?? 0) > 0),
    [kinds, counts],
  );

  const [active, setActive] = useState<CardKind | undefined>(tabs[0]);
  const [filter, setFilter] = useState('');
  const activeKind = active && tabs.includes(active) ? active : tabs[0];

  // The kind's cards, sorted once — the filter box narrows this by title without
  // re-running the sort on every keystroke.
  const sorted = useMemo(
    () => (activeKind ? entitiesOfKind(cards, activeKind).filter((c) => c.id !== excludeId) : []),
    [cards, activeKind, excludeId],
  );
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((c) => c.title.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

  const creates = createOptions.filter((o) => o.kind === activeKind);

  const pick = (value: string) => {
    onPick(value);
    onClose();
  };

  return (
    <Modal title="Link to…" onClose={onClose}>
      <div className="entity-picker">
        {activeKind ? (
          <>
            <div className="entity-picker__tabs" role="tablist">
              {tabs.map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={k === activeKind}
                  className={`entity-picker__tab${k === activeKind ? ' is-active' : ''}`}
                  onClick={() => {
                    setActive(k);
                    setFilter('');
                  }}
                >
                  {KIND_META[k].icon && (
                    <span className="entity-picker__tab-icon">{KIND_META[k].icon}</span>
                  )}
                  {KIND_META[k].label}
                  <span className="entity-picker__tab-count">{counts.get(k) ?? 0}</span>
                </button>
              ))}
            </div>

            <input
              className="entity-picker__filter"
              autoFocus
              value={filter}
              placeholder={`Filter ${KIND_META[activeKind].label.toLowerCase()}…`}
              onChange={(e) => setFilter(e.target.value)}
            />

            <ul className="email-addr__list entity-picker__list">
              {creates.map((o) => (
                <li key={o.value}>
                  <button
                    className="entity-picker__row entity-picker__row--create"
                    onClick={() => pick(o.value)}
                  >
                    <span className="entity-picker__row-icon">＋</span>
                    <span className="entity-picker__row-title">{o.label}</span>
                  </button>
                </li>
              ))}
              {list.map((c) => (
                <li key={c.id}>
                  <button className="entity-picker__row" onClick={() => pick(c.id)}>
                    {KIND_META[c.kind].icon && (
                      <span className="entity-picker__row-icon">{KIND_META[c.kind].icon}</span>
                    )}
                    <span className="entity-picker__row-title">{c.title || 'Untitled'}</span>
                  </button>
                </li>
              ))}
              {list.length === 0 && creates.length === 0 && (
                <li className="entity-picker__empty hint">Nothing here.</li>
              )}
            </ul>
          </>
        ) : (
          <p className="hint">Nothing to link to yet.</p>
        )}
      </div>
    </Modal>
  );
}
