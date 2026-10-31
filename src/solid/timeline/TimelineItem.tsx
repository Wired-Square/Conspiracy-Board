/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import type { Card } from '../../types/board';
import { formatOccurredAt } from '../../lib/dates';
import { mediaIconForKind } from '../../lib/mediaIcon';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';
import { MediaIcon } from '../ui/MediaIcon';

type Props = {
  card: Card;
  clusterColor: string | null;
  selected: boolean;
  onPick: (id: string) => void;
  /** Whole days since the previous event, shown on event chips only. */
  sincePrevEvent?: number;
  /** 'A' (earlier) or 'B' (later) when this chip is a measure-tool endpoint. */
  measureMark?: 'A' | 'B' | null;
};

export function TimelineItem(props: Props) {
  // An event is a moment, not a document about one: it reads as a milestone (a
  // thick accent bar, see .timeline-item--event) rather than a paper chip.
  const isEvent = () => props.card.kind === 'event';
  return (
    <button
      class={cx('timeline-item', isEvent() && 'timeline-item--event', props.selected && 'is-selected', props.measureMark && 'is-measured')}
      style={{ '--accent': props.clusterColor ?? NO_CLUSTER_ACCENT }}
      data-card-id={props.card.id}
      onClick={() => props.onPick(props.card.id)}
      title={props.card.title}
    >
      <Show when={props.measureMark}>
        <span class="timeline-item__measure-mark" aria-hidden="true">
          {props.measureMark}
        </span>
      </Show>
      <Show when={props.sincePrevEvent != null}>
        <span class="timeline-item__since" title={`${props.sincePrevEvent} days since the previous event`}>
          +{props.sincePrevEvent} {props.sincePrevEvent === 1 ? 'day' : 'days'}
        </span>
      </Show>
      <Show when={props.card.occurredAt}>
        {(occurredAt) => (
          <span class="timeline-item__when">{formatOccurredAt(occurredAt(), props.card.occurredAtPrecision)}</span>
        )}
      </Show>
      <span class="timeline-item__title">
        {/* An event flags itself with a milestone marker; the record's two kinds
            are guests from another place and the glyph says which — a document its
            page, an email its envelope. */}
        <Show
          when={!isEvent()}
          fallback={
            <span class="timeline-item__glyph" aria-hidden="true">
              ◆
            </span>
          }
        >
          <Show when={mediaIconForKind(props.card.kind)}>
            {(glyph) => (
              <span class="timeline-item__glyph">
                <MediaIcon type={glyph()} />
              </span>
            )}
          </Show>
        </Show>
        {props.card.title || 'Untitled'}
      </span>
    </button>
  );
}
