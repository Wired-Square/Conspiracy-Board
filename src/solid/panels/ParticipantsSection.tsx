/** @jsxImportSource solid-js */
import { For, Show, createMemo } from 'solid-js';
import type { Card } from '../../types/board';
import { buildRoster, relationsOf } from '../../lib/roster';
import { KIND_META } from '../../lib/kinds';
import { gradeTint } from '../../lib/grades';
import { formatOccurredAt } from '../../lib/dates';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '../fromStore';

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
export function ParticipantsSection(props: { cardId: string }) {
  const cards = fromStore(boardStore, (s) => s.cards);
  const { selectCard } = boardStore.getState();
  const relations = createMemo(() => relationsOf(buildRoster(cards()), props.cardId, cards()));

  return (
    <Show when={relations().actors.length || relations().sent.length || relations().received.length}>
      {/* Dyed from the Inference grade, which is exactly what all of this is: a
          reasoned read of the addresses, not a finding. */}
      <div class="field participants" style={gradeTint('inference')}>
        <span>Linked by address</span>

        <Show when={relations().actors.length > 0}>
          <ul class="participants__list">
            <For each={relations().actors}>
              {(c) => (
                <li>
                  <button class="link-button participants__row" onClick={() => selectCard(c.id)}>
                    <span class="participants__icon">{KIND_META[c.kind].icon}</span>
                    <span class="participants__title">{c.title}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* The arrow is the whole point: an email from them and an email to them
            are different facts, and the roster is the only thing that still knows
            which is which once the addresses are flattened. */}
        <MailList label="Sent" arrow="→" mail={relations().sent} onPick={selectCard} />
        <MailList label="Received" arrow="←" mail={relations().received} onPick={selectCard} />

        <span class="field__hint">
          Follows from the addresses themselves — not string anyone tied. Draw a connection
          to assert one.
        </span>
      </div>
    </Show>
  );
}

function MailList(props: { label: string; arrow: string; mail: Card[]; onPick: (id: string) => void }) {
  return (
    <Show when={props.mail.length}>
      <span class="participants__direction">
        {props.arrow} {props.label} ({props.mail.length})
      </span>
      <ul class="participants__list">
        <For each={props.mail}>
          {(c) => (
            <li>
              <button class="link-button participants__row" onClick={() => props.onPick(c.id)}>
                <span class="participants__title">{c.title || 'Untitled'}</span>
                <Show when={c.occurredAt}>
                  {(at) => <span class="participants__when">{formatOccurredAt(at(), c.occurredAtPrecision)}</span>}
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
