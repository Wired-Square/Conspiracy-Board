import { useMemo, useState } from 'react';
import type { Card, CardKind } from '../../types/board';
import { CARD_KINDS, KIND_META } from '../../lib/kinds';
import { cardMatches, normaliseQuery } from '../../lib/search';
import { formatOccurredAt, dayKey } from '../../lib/dates';
import { Modal } from '../ui/Modal';

/** One reusable picture and every card that uses it — pictures are content-addressed,
 *  so a shared image (a group photo) lists all its objects. `cards[0]` is the
 *  representative, first seen; the rest let the picker find it by any of them. */
export type PickableObject = { cards: Card[]; file: string; src: string };

type Props = {
  objects: PickableObject[];
  onPick: (file: string) => void;
  onClose: () => void;
};

/**
 * Pick a picture already on the board to reuse, from a grid of thumbnails with a
 * large preview of the highlighted one below. Type tabs and a text/date filter keep
 * it usable at a library of hundreds; the query runs through the same `cardMatches`
 * the board search uses (title, notes/OCR, participants, addresses, document author,
 * attachment names), plus the object's date. The value handed back is a media file.
 */
export function ObjectPickerDialog({ objects, onPick, onClose }: Props) {
  const [active, setActive] = useState<CardKind | 'all'>('all');
  const [filter, setFilter] = useState('');
  // The clicked thumbnail; `current` below falls back to the first shown, so the
  // initial (null) render already previews something.
  const [selected, setSelected] = useState<string | null>(null);

  // A shared image counts once under each kind it is linked to, so the tabs point at
  // where it can be found — the totals overlap (an image on a person and an email is
  // in both), which is fine; only "All" is the object total.
  const counts = useMemo(() => {
    const m = new Map<CardKind, number>();
    for (const o of objects) for (const k of new Set(o.cards.map((c) => c.kind))) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [objects]);

  // A typed date narrows the grid the way the board search narrows by text: match
  // against how each linked card's date reads (medium format) and its ISO day, so
  // "2011", "2011-09" or a month name all land. Built once per object set rather than
  // reformatted through Intl on every keystroke; dateless cards contribute nothing.
  const dateText = useMemo(() => {
    const m = new Map<string, string>();
    for (const { cards, file } of objects) {
      const parts: string[] = [];
      for (const c of cards) {
        if (!c.occurredAt) continue;
        parts.push(formatOccurredAt(c.occurredAt, c.occurredAtPrecision), dayKey(c.occurredAt, c.occurredAtPrecision));
      }
      if (parts.length) m.set(file, parts.join(' ').toLowerCase());
    }
    return m;
  }, [objects]);

  // "All" first, then only the kinds that actually have a picture — an empty tab is
  // a dead end here (unlike the link picker, nothing is created from this one). Each
  // tab is a ready-to-render descriptor, so the JSX below has no per-kind branching.
  const tabs = useMemo(
    () => [
      { key: 'all' as const, label: 'All', icon: undefined as string | undefined, count: objects.length },
      ...CARD_KINDS.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => ({
        key: k,
        label: KIND_META[k].label,
        icon: KIND_META[k].icon,
        count: counts.get(k) ?? 0,
      })),
    ],
    [objects.length, counts],
  );

  const visible = useMemo(() => {
    const q = normaliseQuery(filter);
    return objects.filter(
      (o) =>
        (active === 'all' || o.cards.some((c) => c.kind === active)) &&
        (o.cards.some((c) => cardMatches(c, q)) || (dateText.get(o.file)?.includes(q) ?? false)),
    );
  }, [objects, active, filter, dateText]);

  // Keep a live selection: the highlighted file if it survived the filter/tab, else
  // the first shown — so the preview always tracks what the grid is showing.
  const current = visible.find((o) => o.file === selected) ?? visible[0] ?? null;
  const rep = current?.cards[0] ?? null; // the representative object of the shown image
  const shared = current ? current.cards.length - 1 : 0; // how many others share it

  const choose = (file: string) => {
    onPick(file);
    onClose();
  };

  const footer = (
    <>
      <button className="link-button" onClick={onClose}>
        Cancel
      </button>
      <button onClick={() => current && choose(current.file)} disabled={!current}>
        Use image
      </button>
    </>
  );

  return (
    <Modal title="Choose an object" onClose={onClose} footer={footer}>
      <div className="object-picker">
        <div className="entity-picker__tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === active}
              className={`entity-picker__tab${t.key === active ? ' is-active' : ''}`}
              onClick={() => setActive(t.key)}
            >
              {t.icon && <span className="entity-picker__tab-icon">{t.icon}</span>}
              {t.label}
              <span className="entity-picker__tab-count">{t.count}</span>
            </button>
          ))}
        </div>

        <input
          className="entity-picker__filter"
          autoFocus
          value={filter}
          placeholder="Filter by name, text, date…"
          onChange={(e) => setFilter(e.target.value)}
        />

        {current ? (
          <>
            <div className="image-picker">
              {visible.map((o) => {
                const [first, ...rest] = o.cards;
                return (
                  <button
                    key={o.file}
                    type="button"
                    className={`image-picker__item${o.file === current.file ? ' is-active' : ''}`}
                    title={rest.length ? `${first.title || 'Untitled'} +${rest.length}` : first.title || 'Untitled'}
                    aria-pressed={o.file === current.file}
                    onClick={() => setSelected(o.file)}
                    onDoubleClick={() => choose(o.file)}
                  >
                    <img src={o.src} alt={first.title} loading="lazy" />
                    {rest.length > 0 && <span className="image-picker__count">+{rest.length}</span>}
                  </button>
                );
              })}
            </div>

            <div className="object-picker__preview">
              <img src={current.src} alt={current.cards[0].title} />
              {rep && (
                <span className="object-picker__caption">
                  {KIND_META[rep.kind].icon && <span aria-hidden>{KIND_META[rep.kind].icon} </span>}
                  {rep.title || 'Untitled'}
                  {shared > 0 && <span className="object-picker__more"> +{shared}</span>}
                  {rep.occurredAt && (
                    <span className="object-picker__date">
                      {' · '}
                      {formatOccurredAt(rep.occurredAt, rep.occurredAtPrecision)}
                    </span>
                  )}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="object-picker__empty hint">Nothing matches.</p>
        )}
      </div>
    </Modal>
  );
}
