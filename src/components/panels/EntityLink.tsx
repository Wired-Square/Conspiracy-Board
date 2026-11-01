import { Index, Show, createMemo, createSignal, type Accessor } from 'solid-js';
import type { Card, CardKind, EmailAddress } from '../../types/board';
import { buildRoster, type AddressMatch, type Roster } from '../../lib/roster';
import { KIND_META } from '../../lib/kinds';
import { gradeTint } from '../../lib/grades';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';
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
export function entityLinkCommon() {
  const cards = fromStore(boardStore, (s) => s.cards);
  const { selectCard, addCard, updateCard } = boardStore.getState();
  const roster = createMemo(() => buildRoster(cards()));
  const cardsById = createMemo(() => new Map(cards().map((c) => [c.id, c])));
  const hasOrgs = createMemo(() => cards().some((c) => c.kind === 'organisation'));
  return { selectCard, addCard, updateCard, roster, cardsById, hasOrgs };
}

export type LinkRowContext = {
  roster: Accessor<Roster>;
  cardsById: Accessor<Map<string, Card>>;
  /** Whether any organisation exists — the only thing `canAddOrg` needs when the value
   *  carries no domain to make a new one from. The picker lists them itself. */
  hasOrgs: Accessor<boolean>;
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
function EntityChip(props: { card: Card; inference?: boolean; onSelect: () => void; onUnlink: () => void }) {
  return (
    <span class="email-addr__chip">
      <button
        class="link-button email-addr__entity"
        style={props.inference ? gradeTint('inference') : undefined}
        onClick={() => props.onSelect()}
      >
        <span class="email-addr__icon">{KIND_META[props.card.kind].icon}</span>
        {props.card.title || 'Untitled'}
      </button>
      <button
        class="email-addr__unlink"
        title={`Unlink ${props.card.title || 'Untitled'}`}
        aria-label="Unlink"
        onClick={() => props.onUnlink()}
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
export function ParticipantLine(props: { party: EmailAddress; ctx: LinkRowContext }) {
  const resolved = createMemo(() => props.ctx.resolve(props.ctx.roster(), props.party.address));
  const personCard = () => {
    const id = resolved().personId;
    return id ? props.ctx.cardsById().get(id) : undefined;
  };
  const orgCard = () => {
    const org = resolved().org;
    return org ? props.ctx.cardsById().get(org.id) : undefined;
  };
  const canBeOrg = () => props.ctx.canMakeOrg(props.party.address);
  const canAddPerson = () => !resolved().personId;
  const canAddOrg = () => !resolved().org && (canBeOrg() || props.ctx.hasOrgs());
  const [picking, setPicking] = createSignal(false);

  // Which tabs the picker offers, and the "make one" rows on them: a person is
  // always creatable from a value; an organisation only when the value names one
  // (a domain does, a bare number does not), though an existing org can be joined
  // regardless.
  const offer = () => {
    const kinds: CardKind[] = [];
    const createOptions: PickerCreateOption[] = [];
    if (canAddPerson()) {
      kinds.push('person');
      createOptions.push({ kind: 'person', label: 'New person', value: NEW_PERSON });
    }
    if (canAddOrg()) {
      kinds.push('organisation');
      if (canBeOrg()) createOptions.push({ kind: 'organisation', label: 'New organisation', value: NEW_ORG });
    }
    return { kinds, createOptions };
  };

  return (
    <li class="email-addr">
      <span class="email-addr__text">{props.ctx.display(props.party)}</span>
      <Show when={personCard()}>
        {(card) => (
          <EntityChip
            card={card()}
            onSelect={() => props.ctx.selectCard(card().id)}
            onUnlink={() => props.ctx.onUnlink(props.party, card().id)}
          />
        )}
      </Show>
      <Show when={orgCard()}>
        {(card) => (
          <EntityChip
            card={card()}
            inference={resolved().org?.via === 'org-domain'}
            onSelect={() => props.ctx.selectCard(card().id)}
            onUnlink={() => props.ctx.onUnlink(props.party, card().id)}
          />
        )}
      </Show>
      <Show when={canAddPerson() || canAddOrg()}>
        <button class="link-button email-addr__link" onClick={() => setPicking(true)}>
          Link…
        </button>
      </Show>
      <Show when={picking()}>
        <EntityPickerDialog
          kinds={offer().kinds}
          createOptions={offer().createOptions}
          onPick={(v) => props.ctx.onLink(props.party, v)}
          onClose={() => setPicking(false)}
        />
      </Show>
    </li>
  );
}

/** Participant lines by position, so a line (and its open picker) outlives a rewrite of the card. */
export function ParticipantLines(props: { parties: EmailAddress[]; ctx: LinkRowContext; class?: string }) {
  return (
    <ul class={props.class ?? 'email-addr__list'}>
      <Index each={props.parties}>{(party) => <ParticipantLine party={party()} ctx={props.ctx} />}</Index>
    </ul>
  );
}

/** A labelled list of participant lines (From / To / Cc / Linked). */
export function ParticipantGroup(props: { label: string; list: EmailAddress[]; ctx: LinkRowContext }) {
  return (
    <div class="field email-fields__row email-fields__row--read">
      <span>{props.label}</span>
      <Show when={props.list.length > 0} fallback={<span class="email-addr__empty">—</span>}>
        <ParticipantLines parties={props.list} ctx={props.ctx} />
      </Show>
    </div>
  );
}
