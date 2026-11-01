import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import { formatDayKey, formatOccurredAt } from '../../lib/dates';
import { clusterColor, primaryClusterId } from '../../lib/clusters';
import {
  dayGroups,
  eventGaps,
  kindTally,
  measureBetween,
  measureMarks,
  nextPicks,
  stepEvent,
  timelineCards,
  type EventStep,
} from '../../lib/timeline';
import { CARD_H, CARD_W } from '../../lib/layout';
import type { Card, CardKind } from '../../types/board';
import { camera } from '../board/camera';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';
import { createDebounced } from '../createDebounced';
import { createDocHits } from '../createDocHits';
import { TimelineItem } from './TimelineItem';
import { TimelineKindFilter } from './TimelineKindFilter';

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
  const cards = fromStore(boardStore, (s) => s.cards);
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const selectedCardId = fromStore(boardStore, (s) => s.selectedCardId);
  const { selectCard } = boardStore.getState();
  let strip: HTMLDivElement | undefined;

  // The timeline's own full-text search — query and doc-hits are local (the drawer
  // remounts per board), distinct from the toolbar's in-memory entity search. The box
  // owns its text so typing is instant; one debounce feeds both the field filter and
  // the indexed-body lookup (createDocHits).
  const [tlText, setTlText] = createSignal('');
  const tlQuery = createDebounced(tlText, 200);
  const tlDocHits = createDocHits(tlQuery);
  const raw = createMemo(() => timelineCards(cards(), clusters(), tlQuery(), tlDocHits()));

  // Keeping your place: changing a filter used to snap the strip back to the
  // start — the filtered strip is short, so the old scroll offset lands near
  // zero when the full strip returns. So every filter-changing event first
  // notes which chips sit nearest the strip's centre (inside an event handler
  // the DOM still shows the pre-change strip), and once the new strip has
  // rendered, the nearest surviving chip is put back at the centre (see the
  // restore effect below). Candidates rather than one id, so narrowing by kind
  // anchors on the closest chip that survives; an empty strip keeps the
  // previous anchor, so even a fruitless search returns you to where you were.
  let anchor: string[] = [];
  const captureAnchor = () => {
    if (!strip) return;
    const centre = strip.getBoundingClientRect().left + strip.clientWidth / 2;
    const chips = [...strip.querySelectorAll<HTMLElement>('[data-card-id]')];
    if (!chips.length) return;
    anchor = chips
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.cardId!, d: Math.abs((r.left + r.right) / 2 - centre) };
      })
      .sort((a, b) => a.d - b.d)
      .map((c) => c.id);
  };

  // Which kinds the strip hides. The search has already narrowed the raw sets to
  // matches — this filters those by kind on top, so a chip shows only if it matches
  // AND its kind isn't hidden. Empty by default (show all); a fresh Set per toggle.
  // Local, like every other timeline control: nothing else reads it.
  const [hidden, setHidden] = createSignal<Set<CardKind>>(new Set());
  const toggleKind = (k: CardKind) => {
    captureAnchor();
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  };
  const resetKinds = () => {
    captureAnchor();
    setHidden(new Set<CardKind>());
  };
  const dated = createMemo(() => raw().dated.filter((c) => !hidden().has(c.kind)));
  const undated = createMemo(() => raw().undated.filter((c) => !hidden().has(c.kind)));

  // The kinds actually on the strip (from the raw, pre-filter sets so they're stable
  // as you toggle) and how many of each — the checklist rows and their counts. In
  // CARD_KINDS order; actors never reach here, so they never list.
  const tally = createMemo(() => kindTally(raw().dated, raw().undated));

  const [open, setOpen] = createSignal(dated().length > 0);
  const [showUndated, setShowUndated] = createSignal(false);

  const colorFor = (card: Card) => clusterColor(primaryClusterId(card.clusterIds), clusters());

  // Bring a chip into view in the horizontal strip, so a selection made elsewhere
  // (the milestone controls) isn't left off-screen. Two frames: the strip may be
  // opening from collapsed, so let it mount and settle before scrolling.
  const scrollChipIntoView = (id: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        strip
          ?.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }),
      ),
    );
  };

  // Searching opens the drawer and jumps to the first (earliest) match — the way
  // goToEvent does for milestones. On the settled query.
  createEffect(() => {
    if (!tlQuery()) return;
    setOpen(true);
    const first = dated()[0];
    if (first) scrollChipIntoView(first.id);
  });

  // The anchor's other half: after a filter change re-renders the strip, put
  // the nearest surviving anchored chip back at the centre. Only with no
  // search active — while searching, the effect above owns the scroll (jump to
  // first match). Instant, not smooth: the point is that the chip under the
  // eye stays put rather than travels. Keyed on the filters, not on `dated`,
  // so a set change from ordinary editing can never fire a stale anchor.
  createEffect(
    on([tlQuery, hidden], ([query]) => {
      if (query || !anchor.length) return;
      const candidates = anchor;
      anchor = [];
      for (const id of candidates) {
        const chip = strip?.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
        if (chip) {
          chip.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
          return;
        }
      }
    }),
  );

  // The measure tool: pick two dated chips and read the days between them. Kept
  // local — it never selects a card or moves the board, so it needs no store state.
  const [measuring, setMeasuring] = createSignal(false);
  const [picks, setPicks] = createSignal<string[]>([]);
  const datedById = createMemo(() => new Map(dated().map((c) => [c.id, c])));

  const toggleMeasure = () => {
    setMeasuring((v) => !v);
    setPicks([]);
    setOpen(true);
  };

  const onPick = (id: string) => {
    // Measuring picks endpoints instead of navigating. Undated chips can't be
    // measured, so ignore them.
    if (measuring()) {
      if (datedById().has(id)) setPicks((p) => nextPicks(p, id));
      return;
    }
    selectCard(id);
    const cam = camera();
    const n = cam?.getNode(id);
    if (!cam || !n) return; // Not drawn: a record kind, or in a hidden cluster.
    const w = n.size?.width ?? CARD_W;
    const h = n.size?.height ?? CARD_H;
    void cam.setCentre(n.x + w / 2, n.y + h / 2, {
      // Don't centre the card and leave it stranded at minZoom.
      zoom: Math.max(cam.getViewport().zoom, 0.9),
      duration: 400,
    });
  };

  // The dated events, in order: the milestones the Start/Prev/Next/End controls
  // scroll the strip through. The cursor is the controls' own position — they only
  // move the timeline, they don't select the card or move the board.
  const events = createMemo(() => dated().filter((c) => c.kind === 'event'));

  // The milestone-to-milestone reading, shown as a badge on each event chip.
  const eventGap = createMemo(() => eventGaps(events()));

  const [eventCursor, setEventCursor] = createSignal(0);
  const cursor = () => (events().length ? Math.min(eventCursor(), events().length - 1) : 0);

  const goToEvent = (where: EventStep) => {
    if (events().length === 0) return;
    const idx = stepEvent(where, cursor(), events().length);
    setEventCursor(idx);
    setOpen(true);
    scrollChipIntoView(events()[idx].id);
  };

  // Consecutive chips under a day heading, with the elapsed gap between days. Keyed
  // by day, so an edit redraws only its own day.
  const groups = createMemo(() => new Map(dayGroups(dated()).map((g) => [g.key, g])));
  const dayKeys = () => [...groups().keys()];

  const measurement = createMemo(() => measureBetween(picks(), datedById()));
  const marks = createMemo(() => measureMarks(measurement(), picks()));

  const chip = (card: Card, onStrip: boolean) => (
    <TimelineItem
      card={card}
      clusterColor={colorFor(card)}
      selected={card.id === selectedCardId()}
      onPick={onPick}
      sincePrevEvent={onStrip ? eventGap().get(card.id) : undefined}
      measureMark={onStrip ? (marks().get(card.id) ?? null) : undefined}
    />
  );

  return (
    <section class={cx('timeline', open() && 'is-open')}>
      <header class="timeline__bar">
        <button class="timeline__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open()}>
          <span class="timeline__chevron">{open() ? '▾' : '▸'}</span>
          <span class="panel-heading">Timeline</span>
          <span class="timeline__count">
            {dated().length === 0
              ? 'no dated items'
              : `${dated().length} dated${undated().length ? ` · ${undated().length} undated` : ''}`}
          </span>
        </button>
        <input
          class="timeline__search"
          type="search"
          value={tlText()}
          onInput={(e) => {
            // Before the text lands: the strip still shows the previous result,
            // which is exactly the view worth anchoring (see captureAnchor).
            captureAnchor();
            setTlText(e.currentTarget.value);
          }}
          placeholder="Search timeline…"
          aria-label="Search the timeline (full text, including file contents)"
        />
        <Show when={tally().presentKinds.length > 1 || hidden().size > 0}>
          <TimelineKindFilter
            kinds={tally().presentKinds}
            hidden={hidden()}
            counts={tally().kindCounts}
            onToggle={toggleKind}
            onReset={resetKinds}
          />
        </Show>
        <Show when={events().length > 0}>
          <div class="timeline__events" aria-label="Scroll to events">
            <button onClick={() => goToEvent('start')} title="Scroll to first event">
              Start
            </button>
            <button onClick={() => goToEvent('prev')} disabled={cursor() === 0} title="Scroll to previous event">
              Prev
            </button>
            <button
              onClick={() => goToEvent('next')}
              disabled={cursor() === events().length - 1}
              title="Scroll to next event"
            >
              Next
            </button>
            <button onClick={() => goToEvent('end')} title="Scroll to last event">
              End
            </button>
          </div>
        </Show>
        <Show when={dated().length >= 2}>
          <div class="timeline__tools">
            <button
              class={cx('timeline__measure-toggle', measuring() && 'is-active')}
              aria-pressed={measuring()}
              onClick={toggleMeasure}
              title="Measure the days between two cards"
            >
              Measure
            </button>
          </div>
        </Show>
      </header>

      <Show when={open()}>
        <div class="timeline__body">
          <Show when={measuring()}>
            <div class="timeline__measure" role="status">
              <Show
                when={measurement()}
                fallback={
                  <span class="timeline__measure-hint">
                    {picks().length === 0 ? 'Click a dated card to measure from.' : 'Now click the card to measure to.'}
                  </span>
                }
              >
                {(m) => (
                  <span class="timeline__measure-result">
                    <strong>{m().days}</strong> {m().days === 1 ? 'day' : 'days'}
                    <span class="timeline__measure-range">
                      {formatOccurredAt(m().from.occurredAt!, m().from.occurredAtPrecision)}
                      {' → '}
                      {formatOccurredAt(m().to.occurredAt!, m().to.occurredAtPrecision)}
                    </span>
                  </span>
                )}
              </Show>
              <Show when={picks().length > 0}>
                <button class="link-button" onClick={() => setPicks([])}>
                  Clear
                </button>
              </Show>
            </div>
          </Show>
          <div class="timeline__body-row">
            <Show when={undated().length > 0}>
              <div class="timeline__undated">
                <button
                  class="timeline__undated-toggle"
                  onClick={() => setShowUndated((v) => !v)}
                  aria-expanded={showUndated()}
                >
                  Undated · {undated().length}
                </button>
                <Show when={showUndated()}>
                  <div class="timeline__undated-list">
                    <For each={undated()}>{(card) => chip(card, false)}</For>
                  </div>
                </Show>
              </div>
            </Show>

            <div
              class="timeline__strip"
              ref={(el) => {
                strip = el;
                onCleanup(() => (strip = undefined));
              }}
            >
              <Show when={dayKeys().length === 0}>
                <p class="hint timeline__empty">Give a card a date in the editor and it will appear here.</p>
              </Show>
              <For each={dayKeys()}>
                {(key) => {
                  const group = () => groups().get(key)!;
                  return (
                    <>
                      <Show when={group().gapDays > 1}>
                        <div class="timeline__gap" aria-hidden="true">
                          — {group().gapDays} days —
                        </div>
                      </Show>
                      <div class="timeline__group">
                        <div class="timeline__day">{formatDayKey(key)}</div>
                        <div class="timeline__chips">
                          <For each={group().cards}>{(card) => chip(card, true)}</For>
                        </div>
                      </div>
                    </>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
