import { memo } from 'react';
import type { Card } from '../../types/board';
import { formatOccurredAt } from '../../lib/dates';
import { mediaIconForKind } from '../../lib/mediaIcon';
import { MediaIcon } from '../ui/MediaIcon';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';

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

function TimelineItemImpl({ card, clusterColor, selected, onPick, sincePrevEvent, measureMark }: Props) {
  // An event is a moment, not a document about one: it reads as a milestone (a
  // thick accent bar, see .timeline-item--event) rather than a paper chip.
  const isEvent = card.kind === 'event';
  // The record's two kinds show a glyph on the timeline; an event has its own
  // milestone marker, and the argument's evidence carries none.
  const glyphType = mediaIconForKind(card.kind);
  return (
    <button
      className={`timeline-item${isEvent ? ' timeline-item--event' : ''}${selected ? ' is-selected' : ''}${measureMark ? ' is-measured' : ''}`}
      style={{ ['--accent' as string]: clusterColor ?? NO_CLUSTER_ACCENT }}
      data-card-id={card.id}
      onClick={() => onPick(card.id)}
      title={card.title}
    >
      {measureMark && (
        <span className="timeline-item__measure-mark" aria-hidden>{measureMark}</span>
      )}
      {sincePrevEvent != null && (
        <span
          className="timeline-item__since"
          title={`${sincePrevEvent} days since the previous event`}
        >
          +{sincePrevEvent} {sincePrevEvent === 1 ? 'day' : 'days'}
        </span>
      )}
      {card.occurredAt && (
        <span className="timeline-item__when">
          {formatOccurredAt(card.occurredAt, card.occurredAtPrecision)}
        </span>
      )}
      <span className="timeline-item__title">
        {/* An event flags itself with a milestone marker; the record's two kinds
            are guests from another place and the glyph says which — a document its
            page, an email its envelope. */}
        {isEvent ? (
          <span className="timeline-item__glyph" aria-hidden>◆</span>
        ) : (
          glyphType && (
            <span className="timeline-item__glyph">
              <MediaIcon type={glyphType} />
            </span>
          )
        )}
        {card.title || 'Untitled'}
      </span>
    </button>
  );
}

export const TimelineItem = memo(TimelineItemImpl);
