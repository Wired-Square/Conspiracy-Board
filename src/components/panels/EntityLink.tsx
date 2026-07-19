import { useMemo, useState } from 'react';
import type { Card, CardKind, EmailAddress } from '../../types/board';
import { useBoardStore } from '../../store/boardStore';
import { useRoster } from '../../hooks/useRoster';
import type { AddressMatch, Roster } from '../../lib/roster';
import { KIND_META } from '../../lib/kinds';
import { gradeTint } from '../../lib/grades';
import { EntityPickerDialog, type PickerCreateOption } from './EntityPickerDialog';

// The badge + "Link…" + unlink UI, shared by the email view (matched by address)
// and the message/call view (matched by number). The whole of the address-vs-number
// difference is a few context members: how a value resolves to entities, how the
// line reads, whether a new organisation can be made from it, and the link/unlink
// callbacks that write to the entity.

/** The two sentinels the Link… picker uses for "make one". Card ids never collide
 *  with them: an id is minted `crd_…`, never with a colon. */
export const NEW_PERSON = 'new:person';
export const NEW_ORG = 'new:org';

/** The store-derived bits every linking view needs, gathered once. */
export function useEntityLinkCommon() {
  const cards = useBoardStore((s) => s.cards);
  const selectCard = useBoardStore((s) => s.selectCard);
  const addCard = useBoardStore((s) => s.addCard);
  const updateCard = useBoardStore((s) => s.updateCard);
  const roster = useRoster();
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const hasOrgs = useMemo(() => cards.some((c) => c.kind === 'organisation'), [cards]);
  return { cards, selectCard, addCard, updateCard, roster, cardsById, hasOrgs };
}

export type LinkRowContext = {
  roster: Roster;
  cardsById: Map<string, Card>;
  /** Whether any organisation exists — the only thing `canAddOrg` needs when the value
   *  carries no domain to make a new one from. The picker lists them itself. */
  hasOrgs: boolean;
  selectCard: (id: string | null) => void;
  /** Value (address or number) → the person and/or organisation it resolves to. */
  resolve: (roster: Roster, value: string) => { personId?: string; org?: AddressMatch };
  /** The text shown for one party. */
  display: (party: EmailAddress) => string;
  /** Whether "New organisation" is offered for this value (a domain has one; a
   *  number never does). */
  canMakeOrg: (value: string) => boolean;
  onLink: (party: EmailAddress, target: string) => void;
  onUnlink: (party: EmailAddress, entityId: string) => void;
};

/** The card a party resolves to, as a link, with an ✕ to unlink it. Tinted like an
 *  inference when the tie is only the domain. The ✕ is a sibling of the chip, not
 *  nested: a button cannot contain a button. */
function EntityChip({
  card,
  inference,
  onSelect,
  onUnlink,
}: {
  card: Card;
  inference?: boolean;
  onSelect: () => void;
  onUnlink: () => void;
}) {
  return (
    <span className="email-addr__chip">
      <button
        className="link-button email-addr__entity"
        style={inference ? gradeTint('inference') : undefined}
        onClick={onSelect}
      >
        <span className="email-addr__icon">{KIND_META[card.kind].icon}</span>
        {card.title || 'Untitled'}
      </button>
      <button
        className="email-addr__unlink"
        title={`Unlink ${card.title || 'Untitled'}`}
        aria-label="Unlink"
        onClick={onUnlink}
      >
        ×
      </button>
    </span>
  );
}

/**
 * One party: its text (the record — always shown, so every address/number reads as
 * its own line), then the person *and* the organisation it resolves to, each a chip
 * with an unlink ✕, then a "Link…" for whichever kind is still missing.
 */
export function ParticipantLine({ party, ctx }: { party: EmailAddress; ctx: LinkRowContext }) {
  const value = party.address;
  const { personId, org } = ctx.resolve(ctx.roster, value);
  const personCard = personId ? ctx.cardsById.get(personId) : undefined;
  const orgCard = org ? ctx.cardsById.get(org.id) : undefined;
  const canBeOrg = ctx.canMakeOrg(value);
  const canAddPerson = !personId;
  const canAddOrg = !org && (canBeOrg || ctx.hasOrgs);
  const [picking, setPicking] = useState(false);

  // Which tabs the picker offers, and the "make one" rows on them: a person is
  // always creatable from a value; an organisation only when the value names one
  // (a domain does, a bare number does not), though an existing org can be joined
  // regardless.
  const kinds: CardKind[] = [];
  const createOptions: PickerCreateOption[] = [];
  if (canAddPerson) {
    kinds.push('person');
    createOptions.push({ kind: 'person', label: 'New person', value: NEW_PERSON });
  }
  if (canAddOrg) {
    kinds.push('organisation');
    if (canBeOrg) createOptions.push({ kind: 'organisation', label: 'New organisation', value: NEW_ORG });
  }

  return (
    <li className="email-addr">
      <span className="email-addr__text">{ctx.display(party)}</span>
      {personCard && (
        <EntityChip
          card={personCard}
          onSelect={() => ctx.selectCard(personCard.id)}
          onUnlink={() => ctx.onUnlink(party, personCard.id)}
        />
      )}
      {orgCard && (
        <EntityChip
          card={orgCard}
          inference={org!.via === 'org-domain'}
          onSelect={() => ctx.selectCard(orgCard.id)}
          onUnlink={() => ctx.onUnlink(party, orgCard.id)}
        />
      )}
      {(canAddPerson || canAddOrg) && (
        <button className="link-button email-addr__link" onClick={() => setPicking(true)}>
          Link…
        </button>
      )}
      {picking && (
        <EntityPickerDialog
          kinds={kinds}
          createOptions={createOptions}
          onPick={(v) => ctx.onLink(party, v)}
          onClose={() => setPicking(false)}
        />
      )}
    </li>
  );
}

/** A labelled list of participant lines (From / To / Cc / Linked). */
export function ParticipantGroup({
  label,
  list,
  ctx,
}: {
  label: string;
  list: EmailAddress[];
  ctx: LinkRowContext;
}) {
  return (
    <div className="field email-fields__row email-fields__row--read">
      <span>{label}</span>
      {list.length === 0 ? (
        <span className="email-addr__empty">—</span>
      ) : (
        <ul className="email-addr__list">
          {list.map((a, i) => (
            <ParticipantLine key={i} party={a} ctx={ctx} />
          ))}
        </ul>
      )}
    </div>
  );
}
