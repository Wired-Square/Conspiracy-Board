import { useMemo } from 'react';
import type { Card } from '../../types/board';
import { useBoardStore } from '../../store/boardStore';
import { useRoster } from '../../hooks/useRoster';
import { relationsOf } from '../../lib/roster';
import { KIND_META } from '../../lib/kinds';
import { gradeTint } from '../../lib/grades';
import { formatOccurredAt } from '../../lib/dates';

/**
 * What this card shares addresses with — derived, read-only, click to open.
 *
 * Since the record left the canvas this is the only place a person's mail
 * surfaces at all, which is most of what the roster was ever for: the board
 * shows who they are, and this shows what they wrote and who wrote to them.
 *
 * There is nothing to edit here on purpose. These are not links anyone drew:
 * they follow from the addresses, and the way to change one is to change the
 * addresses on the card. Asserting a relation is a Connection, drawn by hand,
 * carrying its own grade — see lib/roster.ts on what the derivations are worth.
 *
 * The section hides itself when nothing is derived, so an evidence card with no
 * addresses is not made to display its own emptiness.
 */
export function ParticipantsSection({ cardId }: { cardId: string }) {
  const cards = useBoardStore((s) => s.cards);
  const selectCard = useBoardStore((s) => s.selectCard);
  const roster = useRoster();

  const { actors, sent, received } = useMemo(
    () => relationsOf(roster, cardId, cards),
    [roster, cardId, cards],
  );

  if (!actors.length && !sent.length && !received.length) return null;

  return (
    // Dyed from the Inference grade, which is exactly what all of this is: a
    // reasoned read of the addresses, not a finding.
    <div className="field participants" style={gradeTint('inference')}>
      <span>Linked by address</span>

      {actors.length > 0 && (
        <ul className="participants__list">
          {actors.map((c) => (
            <li key={c.id}>
              <button className="link-button participants__row" onClick={() => selectCard(c.id)}>
                <span className="participants__icon">{KIND_META[c.kind].icon}</span>
                <span className="participants__title">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The arrow is the whole point: an email from them and an email to them
          are different facts, and the roster is the only thing that still knows
          which is which once the addresses are flattened. */}
      <MailList label="Sent" arrow="→" mail={sent} onPick={selectCard} />
      <MailList label="Received" arrow="←" mail={received} onPick={selectCard} />

      <span className="field__hint">
        Follows from the addresses themselves — not string anyone tied. Draw a connection
        to assert one.
      </span>
    </div>
  );
}

function MailList({
  label,
  arrow,
  mail,
  onPick,
}: {
  label: string;
  arrow: string;
  mail: Card[];
  onPick: (id: string) => void;
}) {
  if (!mail.length) return null;
  return (
    <>
      <span className="participants__direction">
        {arrow} {label} ({mail.length})
      </span>
      <ul className="participants__list">
        {mail.map((c) => (
          <li key={c.id}>
            <button className="link-button participants__row" onClick={() => onPick(c.id)}>
              <span className="participants__title">{c.title || 'Untitled'}</span>
              {c.occurredAt && (
                <span className="participants__when">
                  {formatOccurredAt(c.occurredAt, c.occurredAtPrecision)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
