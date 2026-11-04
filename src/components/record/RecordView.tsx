import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import type { Card } from '../../types/board';
import { buildRoster } from '../../lib/roster';
import { visibleCards } from '../../lib/visibility';
import { clusterColor, NO_CLUSTER_ACCENT, primaryClusterId } from '../../lib/clusters';
import { mediaIconForKind } from '../../lib/mediaIcon';
import { recordRows, whoLine } from '../../lib/record';
import { formatOccurredAt } from '../../lib/dates';
import { cardImageSrc } from '../../storage/media';
import { cardImageStyle } from '../../lib/imageCrop';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';
import { MediaIcon } from '../ui/MediaIcon';
import { measure, untilPainted } from '../../platform/perf';
import { createWindow } from '../createWindow';

const ROW_H = 50;

/** Where each board's list was scrolled to, so leaving for the board and back keeps the place. */
const scrolledTo = new Map<string, number>();

// The record: the paper a board argues from. It is not on the canvas — an mbox
// would bury the argument under two hundred cards of post — so it is here, in
// the one shape that needs no layout and does not care how much of it there is.
//
// A list, not a second canvas: nothing here has a position worth choosing, and
// there is no auto-layout to choose one. Rows with pictures read as a contact
// sheet, which is what a pile of evidence photographs actually is.

export function RecordView() {
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const connections = fromStore(boardStore, (s) => s.connections);
  const allCards = fromStore(boardStore, (s) => s.cards);
  const searchQuery = fromStore(boardStore, (s) => s.searchQuery);
  const selectedCardId = fromStore(boardStore, (s) => s.selectedCardId);
  const { selectCard } = boardStore.getState();
  const roster = createMemo(() => buildRoster(allCards()));
  const cards = createMemo(() =>
    measure(
      'record filter',
      () => visibleCards(allCards(), clusters(), searchQuery()),
      (shown) => [allCards().length, shown.length],
    ),
  );

  // A flag on everything marks nothing: straight after an mbox almost every row
  // is loose, because you only ever cared about a few of the senders. So the
  // list stays whole by default and this narrows it to the work.
  const [onlyLoose, setOnlyLoose] = createSignal(false);

  const record = createMemo(() => {
    const rows = measure(
      'record rows',
      () => recordRows(cards(), allCards(), roster(), connections()),
      (r) => [cards().length, r.rows.length],
    );
    untilPainted('record painted', rows.rows.length);
    return rows;
  });
  // Rows by card, not by row: recordRows builds fresh rows on every edit, and the
  // cards it wraps are what stays put.
  const loose = createMemo(() => new Map(record().rows.map((r) => [r.card.id, r.loose])));
  const shown = createMemo(() => (onlyLoose() ? record().rows.filter((r) => r.loose) : record().rows).map((r) => r.card));

  // Ten thousand emails: only the rows in view are drawn.
  const rows = createWindow({
    count: () => shown().length,
    key: (i) => shown()[i].id,
    estimate: () => ROW_H,
    axis: 'y',
    overscan: 800,
  });
  const boardId = boardStore.getState().currentBoardId ?? '';
  let list: HTMLUListElement | undefined;
  onMount(() => {
    if (!list) return;
    list.scrollTop = scrolledTo.get(boardId) ?? 0;
    rows.sync();
  });
  onCleanup(() => list && scrolledTo.set(boardId, list.scrollTop));

  return (
    <div class="record">
      <div class="record__bar">
        <span class="panel-heading">Record</span>
        <span class="record__count">
          {record().rows.length === 0
            ? 'nothing yet'
            : `${record().rows.length} item${record().rows.length === 1 ? '' : 's'}`}
          {record().looseCount > 0 && ` · ${record().looseCount} not linked up`}
        </span>
        <Show when={record().looseCount > 0}>
          <label class="record__filter">
            <input type="checkbox" checked={onlyLoose()} onChange={(e) => setOnlyLoose(e.currentTarget.checked)} />
            Only what isn’t linked
          </label>
        </Show>
      </div>

      <Show
        when={record().rows.length > 0}
        fallback={
          <p class="hint record__empty">
            The mail and documents a board argues from live here. Import an mbox with{' '}
            <strong>Add › Email</strong>, or drop messages into the Inbox folder
            (File ▸ Show Inbox Folder) and they import on their own.
          </p>
        }
      >
        <ul
          class="record__list"
          ref={(el) => {
            list = el;
            rows.container(el);
          }}
        >
          <li class="record__spacer" aria-hidden="true" style={{ height: `${rows.before()}px` }} />
          <For each={shown().slice(rows.range().start, rows.range().end)}>
            {(card) => (
              <li ref={(el) => rows.measure(el, card.id)}>
                <RecordRow
                  card={card}
                  loose={loose().get(card.id) ?? null}
                  clusterColor={clusterColor(primaryClusterId(card.clusterIds), clusters())}
                  selected={card.id === selectedCardId()}
                  onPick={selectCard}
                />
              </li>
            )}
          </For>
          <li class="record__spacer" aria-hidden="true" style={{ height: `${rows.after()}px` }} />
        </ul>
      </Show>
    </div>
  );
}

type RowProps = {
  card: Card;
  /** What is still to do with it, or null when it is linked up. */
  loose: string | null;
  clusterColor: string | null;
  selected: boolean;
  onPick: (id: string) => void;
};

function RecordRow(props: RowProps) {
  return (
    <button
      type="button"
      class={cx('app-menu__item record-row', props.selected && 'is-selected', props.loose && 'is-loose')}
      style={{ '--accent': props.clusterColor ?? NO_CLUSTER_ACCENT }}
      onClick={() => props.onPick(props.card.id)}
      title={props.card.title}
    >
      {/* The picture if the message carried one, else the kind's own glyph —
          a row is a fixed height either way, so the list does not jump. Not
          loading="lazy": only the rows in view are drawn, and WKWebView's
          lazy-load proved unreliable on the board faces. */}
      <span class="record-row__thumb">
        <Show
          when={cardImageSrc(props.card)}
          fallback={<MediaIcon type={mediaIconForKind(props.card.kind) ?? 'document'} />}
        >
          {(image) => (
            <img src={image()} alt="" draggable={false} decoding="async" style={cardImageStyle(props.card)} />
          )}
        </Show>
      </span>
      <span class="record-row__main">
        <span class="record-row__title">{props.card.title || 'Untitled'}</span>
        <Show when={whoLine(props.card)}>{(who) => <span class="record-row__who">{who()}</span>}</Show>
      </span>
      {/* Says what is missing, not just that something is. "2 addresses
          unaccounted" is a thing you can go and do; a bare warning is not. */}
      <Show when={props.loose}>{(loose) => <span class="record-row__loose">{loose()}</span>}</Show>
      <span class="record-row__when">
        {props.card.occurredAt ? formatOccurredAt(props.card.occurredAt, props.card.occurredAtPrecision) : 'undated'}
      </span>
    </button>
  );
}
