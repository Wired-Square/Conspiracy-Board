import { memo, useMemo, useState } from 'react';
import type { Card, Connection } from '../../types/board';
import { useBoardStore } from '../../store/boardStore';
import { useRoster } from '../../hooks/useRoster';
import { useVisibleCards } from '../../hooks/useVisibleCards';
import { clusterColor, NO_CLUSTER_ACCENT } from '../../lib/clusters';
import { isRecordKind } from '../../lib/kinds';
import { communicationParties } from '../../lib/comms';
import { mediaIconForKind } from '../../lib/mediaIcon';
import { MediaIcon } from '../ui/MediaIcon';
import {
  actorIds,
  isLinkedDocument,
  unaccountedAddresses,
  type Roster,
} from '../../lib/roster';
import { formatOccurredAt, newestFirst } from '../../lib/dates';
import { shortAddress } from '../../lib/email/addresses';
import { cardImageSrc, cardImageStyle } from '../../storage/media';

// The record: the paper a board argues from. It is not on the canvas — an mbox
// would bury the argument under two hundred cards of post — so it is here, in
// the one shape that needs no layout and does not care how much of it there is.
//
// A list, not a second canvas: nothing here has a position worth choosing, and
// there is no auto-layout to choose one. Rows with pictures read as a contact
// sheet, which is what a pile of evidence photographs actually is.

/** "Dutch Sable → Vivian Vane +2" — who a communication was between. Email, a text
 *  message and a phone call all have a from and a to (see communicationParties). */
function whoLine(card: Card): string | null {
  const parties = communicationParties(card);
  if (!parties) return null;
  const to = parties.to.length
    ? shortAddress(parties.to[0]) + (parties.to.length > 1 ? ` +${parties.to.length - 1}` : '')
    : null;
  const from = shortAddress(parties.from);
  return to ? `${from} → ${to}` : from;
}

/**
 * What is still to do with this piece of paper, or null when it is done with.
 *
 * A record earns its place by being tied to somebody: an email when every
 * address on it belongs to a card, a document when string reaches an actor.
 * Until then it is a name nobody has looked up — and this is the list you work
 * off, which is what turns a mail import from a pile into a queue.
 */
function whatsLoose(
  card: Card,
  roster: Roster,
  connections: readonly Connection[],
  actors: ReadonlySet<string>,
): string | null {
  switch (card.kind) {
    case 'document':
      return isLinkedDocument(card.id, connections, actors) ? null : 'names nobody';
    case 'email': {
      const n = unaccountedAddresses(card, roster).length;
      return n ? `${n} address${n === 1 ? '' : 'es'} unaccounted` : null;
    }
    default:
      // Only the record is asked, and the record is these two. A third kind must
      // answer for itself rather than defaulting to "nothing to do here", which
      // is the one wrong answer this list can give.
      return null;
  }
}

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

  // One pass: the rows, and how many are loose. The count in the bar must not
  // disagree with the list under it. The actors are found once here rather than
  // per row — the answer is the same for every document on the board.
  const { rows, looseCount } = useMemo(() => {
    const actors = actorIds(allCards);
    const rows = cards
      .filter((c) => isRecordKind(c.kind))
      .map((card) => ({ card, loose: whatsLoose(card, roster, connections, actors) }))
      .sort((a, b) => newestFirst(a.card, b.card));
    return { rows, looseCount: rows.filter((r) => r.loose).length };
  }, [cards, roster, connections, allCards]);

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
          <strong>+ Add › Email</strong>, or drag a message straight onto the board.
        </p>
      ) : (
        <ul className="record__list">
          {shown.map(({ card, loose }) => (
            <RecordRow
              key={card.id}
              card={card}
              loose={loose}
              clusterColor={clusterColor(card.clusterId, clusters)}
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
            a row is a fixed height either way, so the list does not jump. */}
        <span className="record-row__thumb">
          {image ? (
            <img src={image} alt="" draggable={false} style={cardImageStyle(card)} />
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
