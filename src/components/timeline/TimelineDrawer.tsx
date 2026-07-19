import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useBoardStore } from '../../store/boardStore';
import { useTimelineCards } from '../../hooks/useTimelineCards';
import { useDocHits } from '../../hooks/useDocHits';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { dayKey, daysBetween, daysBetweenCards, formatDayKey, formatOccurredAt } from '../../lib/dates';
import { clusterColor } from '../../lib/clusters';
import { CARD_KINDS } from '../../lib/kinds';
import type { CardKind } from '../../types/board';
import { TimelineItem } from './TimelineItem';
import { TimelineKindFilter } from './TimelineKindFilter';

// Card face dimensions, used only until React Flow has measured a node.
const CARD_W = 210;
const CARD_H = 140;

/**
 * A chronological strip under the board.
 *
 * Deliberately an ordered list rather than a scaled time axis: the data is
 * wildly non-uniform (an email thread spans minutes, the evidence around it
 * spans years), so a true scale collapses most chips into a few pixels and
 * leaves the rest of the axis empty. Uniform chips with day headings and gap
 * markers give the temporal reading without the scaling pathology.
 */
export function TimelineDrawer() {
  // The timeline's own full-text search — query and doc-hits are local (the drawer
  // remounts per board), distinct from the toolbar's in-memory entity search. The box
  // owns its text so typing is instant; one debounce feeds both the field filter and
  // the indexed-body lookup (useDocHits).
  const [tlText, setTlText] = useState('');
  const tlQuery = useDebouncedValue(tlText, 200);
  const tlDocHits = useDocHits(tlQuery);
  const { dated: rawDated, undated: rawUndated } = useTimelineCards(tlQuery, tlDocHits);
  const clusters = useBoardStore((s) => s.clusters);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const selectCard = useBoardStore((s) => s.selectCard);
  const { setCenter, getNode, getZoom } = useReactFlow();
  const stripRef = useRef<HTMLDivElement>(null);

  // Which kinds the strip hides. The search (through useTimelineCards) has already
  // narrowed the raw sets to matches — this filters those by kind on top, so a chip
  // shows only if it matches AND its kind isn't hidden. Empty by default (show all);
  // a fresh Set per toggle so the memos below rerun. Local, like every other timeline
  // control: nothing else reads it.
  const [hidden, setHidden] = useState<Set<CardKind>>(() => new Set());
  const toggleKind = useCallback((k: CardKind) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }, []);
  const resetKinds = useCallback(() => setHidden(new Set()), []);
  const dated = useMemo(() => rawDated.filter((c) => !hidden.has(c.kind)), [rawDated, hidden]);
  const undated = useMemo(() => rawUndated.filter((c) => !hidden.has(c.kind)), [rawUndated, hidden]);

  // The kinds actually on the strip (from the raw, pre-filter sets so they're stable
  // as you toggle) and how many of each — the checklist rows and their counts. In
  // CARD_KINDS order; actors never reach here, so they never list.
  const { presentKinds, kindCounts } = useMemo(() => {
    const counts = new Map<CardKind, number>();
    const tally = (c: { kind: CardKind }) => counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    rawDated.forEach(tally);
    rawUndated.forEach(tally);
    return { presentKinds: CARD_KINDS.filter((k) => counts.has(k)), kindCounts: counts };
  }, [rawDated, rawUndated]);

  const [open, setOpen] = useState(() => dated.length > 0);
  const [showUndated, setShowUndated] = useState(false);

  const colorFor = useCallback(
    (clusterId: string | null) => clusterColor(clusterId, clusters),
    [clusters],
  );

  // Bring a chip into view in the horizontal strip, so a selection made elsewhere
  // (the milestone controls) isn't left off-screen.
  const scrollChipIntoView = useCallback((id: string) => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, []);

  // Searching opens the drawer and jumps to the first (earliest) match — the way
  // goToEvent does for milestones. On the settled query; two frames let the strip
  // mount before the scroll.
  useEffect(() => {
    if (!tlQuery) return;
    setOpen(true);
    const first = dated[0];
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => scrollChipIntoView(first.id)));
  }, [tlQuery, dated, scrollChipIntoView]);

  // The measure tool: pick two dated chips and read the days between them. Kept
  // local — it never selects a card or moves the board, so it needs no store state.
  const [measuring, setMeasuring] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const datedById = useMemo(() => new Map(dated.map((c) => [c.id, c])), [dated]);

  const toggleMeasure = useCallback(() => {
    setMeasuring((v) => !v);
    setPicks([]);
    setOpen(true);
  }, []);

  // onPick is handed to every memoized chip, so it must keep a stable identity: a
  // card drag respreads `cards` each pointermove (see boardStore's onNodesChange),
  // which rebuilds `datedById`, so depending on it directly would re-render the
  // whole strip every frame. The measure context is read through a ref instead.
  const measureRef = useRef({ measuring, datedById });
  measureRef.current = { measuring, datedById };

  const onPick = useCallback(
    (id: string) => {
      const { measuring, datedById } = measureRef.current;
      // Measuring picks endpoints instead of navigating: first pick, then second,
      // then a third starts over. Undated chips can't be measured, so ignore them.
      if (measuring) {
        if (!datedById.has(id)) return;
        setPicks((p) => (p.length >= 2 ? [id] : p.includes(id) ? p : [...p, id]));
        return;
      }
      selectCard(id);
      const n = getNode(id);
      if (!n) return; // Filtered out by cluster visibility.
      const w = n.measured?.width ?? CARD_W;
      const h = n.measured?.height ?? CARD_H;
      setCenter(n.position.x + w / 2, n.position.y + h / 2, {
        // Don't centre the card and leave it stranded at minZoom.
        zoom: Math.max(getZoom(), 0.9),
        duration: 400,
      });
    },
    [selectCard, getNode, getZoom, setCenter],
  );

  // The dated events, in order: the milestones the Start/Prev/Next/End controls
  // scroll the strip through. The cursor is the controls' own position — they only
  // move the timeline, they don't select the card or move the board.
  const events = useMemo(() => dated.filter((c) => c.kind === 'event'), [dated]);

  // Elapsed days from one event to the next, keyed by the later event's id — the
  // milestone-to-milestone reading, shown as a badge on each event chip.
  const eventGap = useMemo(() => {
    const gap = new Map<string, number>();
    events.forEach((e, i) => {
      if (i > 0) gap.set(e.id, daysBetweenCards(events[i - 1], e));
    });
    return gap;
  }, [events]);

  const [eventCursor, setEventCursor] = useState(0);
  const cursor = events.length ? Math.min(eventCursor, events.length - 1) : 0;
  const atStart = cursor === 0;
  const atEnd = cursor === events.length - 1;

  const goToEvent = useCallback(
    (where: 'start' | 'prev' | 'next' | 'end') => {
      if (events.length === 0) return;
      const idx =
        where === 'start' ? 0
        : where === 'end' ? events.length - 1
        : where === 'prev' ? Math.max(0, cursor - 1)
        : Math.min(events.length - 1, cursor + 1);
      setEventCursor(idx);
      setOpen(true);
      // Two frames: the strip may be opening from collapsed, so let it mount and
      // settle before scrolling the chip to the centre.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => scrollChipIntoView(events[idx].id)),
      );
    },
    [events, cursor, scrollChipIntoView],
  );

  // Group consecutive chips under a day heading, and note the elapsed gap
  // between one day and the next.
  const groups = useMemo(() => {
    const out: { key: string; gapDays: number; cards: typeof dated }[] = [];
    for (const card of dated) {
      const key = dayKey(card.occurredAt!, card.occurredAtPrecision);
      const last = out[out.length - 1];
      if (last && last.key === key) last.cards.push(card);
      else out.push({ key, gapDays: last ? daysBetween(last.key, key) : 0, cards: [card] });
    }
    return out;
  }, [dated]);

  // The measurement, ordered earliest→latest so the readout and the A/B badges
  // read in time order however the two chips were clicked.
  const measurement = useMemo(() => {
    if (picks.length < 2) return null;
    const a = datedById.get(picks[0]);
    const b = datedById.get(picks[1]);
    if (!a || !b) return null;
    const [from, to] = a.occurredAt! <= b.occurredAt! ? [a, b] : [b, a];
    return { from, to, days: daysBetweenCards(from, to) };
  }, [picks, datedById]);

  const measureMarks = useMemo(() => {
    const marks = new Map<string, 'A' | 'B'>();
    if (measurement) {
      marks.set(measurement.from.id, 'A');
      marks.set(measurement.to.id, 'B');
    } else if (picks[0]) {
      marks.set(picks[0], 'A');
    }
    return marks;
  }, [measurement, picks]);

  return (
    <section className={`timeline${open ? ' is-open' : ''}`}>
      <header className="timeline__bar">
        <button
          className="timeline__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="timeline__chevron">{open ? '▾' : '▸'}</span>
          <span className="panel-heading">Timeline</span>
          <span className="timeline__count">
            {dated.length === 0
              ? 'no dated items'
              : `${dated.length} dated${undated.length ? ` · ${undated.length} undated` : ''}`}
          </span>
        </button>
        <input
          className="timeline__search"
          type="search"
          value={tlText}
          onChange={(e) => setTlText(e.target.value)}
          placeholder="Search timeline…"
          aria-label="Search the timeline (full text, including file contents)"
        />
        {(presentKinds.length > 1 || hidden.size > 0) && (
          <TimelineKindFilter
            kinds={presentKinds}
            hidden={hidden}
            counts={kindCounts}
            onToggle={toggleKind}
            onReset={resetKinds}
          />
        )}
        {events.length > 0 && (
          <div className="timeline__events" aria-label="Scroll to events">
            <button onClick={() => goToEvent('start')} title="Scroll to first event">
              Start
            </button>
            <button onClick={() => goToEvent('prev')} disabled={atStart} title="Scroll to previous event">
              Prev
            </button>
            <button onClick={() => goToEvent('next')} disabled={atEnd} title="Scroll to next event">
              Next
            </button>
            <button onClick={() => goToEvent('end')} title="Scroll to last event">
              End
            </button>
          </div>
        )}
        {dated.length >= 2 && (
          <div className="timeline__tools">
            <button
              className={`timeline__measure-toggle${measuring ? ' is-active' : ''}`}
              aria-pressed={measuring}
              onClick={toggleMeasure}
              title="Measure the days between two cards"
            >
              Measure
            </button>
          </div>
        )}
      </header>

      {open && (
        <div className="timeline__body">
          {measuring && (
            <div className="timeline__measure" role="status">
              {measurement ? (
                <span className="timeline__measure-result">
                  <strong>{measurement.days}</strong> {measurement.days === 1 ? 'day' : 'days'}
                  <span className="timeline__measure-range">
                    {formatOccurredAt(measurement.from.occurredAt!, measurement.from.occurredAtPrecision)}
                    {' → '}
                    {formatOccurredAt(measurement.to.occurredAt!, measurement.to.occurredAtPrecision)}
                  </span>
                </span>
              ) : (
                <span className="timeline__measure-hint">
                  {picks.length === 0
                    ? 'Click a dated card to measure from.'
                    : 'Now click the card to measure to.'}
                </span>
              )}
              {picks.length > 0 && (
                <button className="link-button" onClick={() => setPicks([])}>
                  Clear
                </button>
              )}
            </div>
          )}
          <div className="timeline__body-row">
            {undated.length > 0 && (
              <div className="timeline__undated">
                <button
                  className="timeline__undated-toggle"
                  onClick={() => setShowUndated((v) => !v)}
                  aria-expanded={showUndated}
                >
                  Undated · {undated.length}
                </button>
                {showUndated && (
                  <div className="timeline__undated-list">
                    {undated.map((card) => (
                      <TimelineItem
                        key={card.id}
                        card={card}
                        clusterColor={colorFor(card.clusterId)}
                        selected={card.id === selectedCardId}
                        onPick={onPick}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="timeline__strip" ref={stripRef}>
              {groups.length === 0 && (
                <p className="hint timeline__empty">
                  Give a card a date in the editor and it will appear here.
                </p>
              )}
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {g.gapDays > 1 && (
                    <div className="timeline__gap" aria-hidden>
                      — {g.gapDays} days —
                    </div>
                  )}
                  <div className="timeline__group">
                    <div className="timeline__day">{formatDayKey(g.key)}</div>
                    <div className="timeline__chips">
                      {g.cards.map((card) => (
                        <TimelineItem
                          key={card.id}
                          card={card}
                          clusterColor={colorFor(card.clusterId)}
                          selected={card.id === selectedCardId}
                          onPick={onPick}
                          sincePrevEvent={eventGap.get(card.id)}
                          measureMark={measureMarks.get(card.id) ?? null}
                        />
                      ))}
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
