import { memo, useMemo, useState } from 'react';
import type { Card } from '../../types/board';
import { useRoster } from '../../hooks/useRoster';
import { useVisibleCards } from '../../hooks/useVisibleCards';
import { clusterColor, NO_CLUSTER_ACCENT, primaryClusterId } from '../../lib/clusters';
import { mediaIconForKind } from '../../lib/mediaIcon';
import { MediaIcon } from '../ui/MediaIcon';
import { recordRows, whoLine } from '../../lib/record';
import { formatOccurredAt } from '../../lib/dates';
import { cardImageSrc } from '../../storage/media';
import { cardImageStyle } from '../../lib/imageCrop';
import { reactStyle } from '../ui/reactStyle';
import { useBoardStore } from '../../hooks/useStores';

// The record: the paper a board argues from. It is not on the canvas — an mbox
// would bury the argument under two hundred cards of post — so it is here, in
// the one shape that needs no layout and does not care how much of it there is.
//
// A list, not a second canvas: nothing here has a position worth choosing, and
// there is no auto-layout to choose one. Rows with pictures read as a contact
// sheet, which is what a pile of evidence photographs actually is.

export function RecordView() {
  const clusters = useBoardStore((s) => s.clusters);
  const connections = useBoardStore((s) => s.connections);
  const allCards = useBoardStore((s) => s.cards);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const selectCard = useBoardStore((s) => s.selectCard);
  const cards = useVisibleCards();
  const roster = useRoster();

  // A flag on everything marks nothing: straight after an mbox almost every row
  // is loose, because you only ever cared about a few of the senders. So the
  // list stays whole by default and this narrows it to the work.
  const [onlyLoose, setOnlyLoose] = useState(false);

  const { rows, looseCount } = useMemo(
    () => recordRows(cards, allCards, roster, connections),
    [cards, roster, connections, allCards],
  );

  const shown = onlyLoose ? rows.filter((r) => r.loose) : rows;

  return (
    <div className="record">
      <div className="record__bar">
        <span className="panel-heading">Record</span>
        <span className="record__count">
          {rows.length === 0
            ? 'nothing yet'
            : `${rows.length} item${rows.length === 1 ? '' : 's'}`}
          {looseCount > 0 && ` · ${looseCount} not linked up`}
        </span>
        {looseCount > 0 && (
          <label className="record__filter">
            <input
              type="checkbox"
              checked={onlyLoose}
              onChange={(e) => setOnlyLoose(e.target.checked)}
            />
            Only what isn’t linked
          </label>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="hint record__empty">
          The mail and documents a board argues from live here. Import an mbox with{' '}
          <strong>+ Add › Email</strong>, or drop messages into the Inbox folder
          (File ▸ Show Inbox Folder) and they import on their own.
        </p>
      ) : (
        <ul className="record__list">
          {shown.map(({ card, loose }) => (
            <RecordRow
              key={card.id}
              card={card}
              loose={loose}
              clusterColor={clusterColor(primaryClusterId(card.clusterIds), clusters)}
              selected={card.id === selectedCardId}
              onPick={selectCard}
            />
          ))}
        </ul>
      )}
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

function RecordRowImpl({ card, loose, clusterColor, selected, onPick }: RowProps) {
  const who = whoLine(card);
  const image = cardImageSrc(card);
  return (
    <li>
      <button
        className={`record-row${selected ? ' is-selected' : ''}${loose ? ' is-loose' : ''}`}
        style={{ ['--accent' as string]: clusterColor ?? NO_CLUSTER_ACCENT }}
        onClick={() => onPick(card.id)}
        title={card.title}
      >
        {/* The picture if the message carried one, else the kind's own glyph —
            a row is a fixed height either way, so the list does not jump. Not
            loading="lazy": the rows already defer via content-visibility, and
            WKWebView's lazy-load proved unreliable on the board faces. */}
        <span className="record-row__thumb">
          {image ? (
            <img src={image} alt="" draggable={false} decoding="async" style={reactStyle(cardImageStyle(card))} />
          ) : (
            <MediaIcon type={mediaIconForKind(card.kind) ?? 'document'} />
          )}
        </span>
        <span className="record-row__main">
          <span className="record-row__title">{card.title || 'Untitled'}</span>
          {who && <span className="record-row__who">{who}</span>}
        </span>
        {/* Says what is missing, not just that something is. "2 addresses
            unaccounted" is a thing you can go and do; a bare warning is not. */}
        {loose && <span className="record-row__loose">{loose}</span>}
        <span className="record-row__when">
          {card.occurredAt
            ? formatOccurredAt(card.occurredAt, card.occurredAtPrecision)
            : 'undated'}
        </span>
      </button>
    </li>
  );
}

// Memoised like TimelineItem: an mbox puts hundreds of these on screen, and a
// selection change must not re-render all of them.
const RecordRow = memo(RecordRowImpl);
