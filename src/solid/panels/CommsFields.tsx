/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import type { Card, CallMeta, EmailAddress, MessageMeta } from '../../types/board';
import { formatAddress, formatAddressList, parseAddress, parseAddressList } from '../../lib/email/addresses';
import { emptyCallMeta, emptyMessageMeta } from '../../lib/comms';
import { entitiesForNumber } from '../../lib/roster';
import { personDraftForNumber, patchFor } from '../../lib/importOffer';
import { withoutNumber } from '../../lib/entities';
import { formatNumber } from '../../lib/phone';
import { createSeeded } from '../createSeeded';
import { NEW_PERSON, ParticipantLines, entityLinkCommon, type LinkRowContext } from './EntityLink';

/**
 * The from/to for a Message or Call card, plus a message's body or a call's duration.
 * Like a hand-made email's fields, but keyed on phone numbers or handles rather than
 * addresses — the roster matches those to people by number (see lib/roster). The
 * justifying screenshot rides on the card's Picture field, like any other image.
 *
 * The from/to are typed (parsed on blur, for the caret reason EmailFields explains),
 * and each committed party is resolved to the person/organisation it belongs to —
 * linked, and unlinked, exactly like an email's addresses, only by number.
 */
export function CommsFields(props: { card: Card }) {
  const { addCard, updateCard, roster, cardsById, hasOrgs, selectCard } = entityLinkCommon();
  const isCall = () => props.card.kind === 'call';
  const meta = (): MessageMeta | CallMeta =>
    isCall() ? (props.card.call ?? emptyCallMeta()) : (props.card.message ?? emptyMessageMeta());

  const [from, setFrom] = createSeeded(() => formatAddress(meta().from));
  const [to, setTo] = createSeeded(() => formatAddressList(meta().to));
  const [body, setBody] = createSeeded(() => (isCall() ? '' : (props.card.message?.body ?? '')));
  const [durationMin, setDurationMin] = createSeeded(() =>
    props.card.call?.durationSecs ? String(Math.round(props.card.call.durationSecs / 60)) : '',
  );

  // One writer per payload, so the `{ ...(card.X ?? emptyXMeta()), ...patch }` merge
  // isn't re-inlined at every field; participants route to whichever this kind is.
  const patchMessage = (p: Partial<MessageMeta>) =>
    updateCard(props.card.id, { message: { ...(props.card.message ?? emptyMessageMeta()), ...p } });
  const patchCall = (p: Partial<CallMeta>) =>
    updateCard(props.card.id, { call: { ...(props.card.call ?? emptyCallMeta()), ...p } });
  const commitParticipants = (p: { from?: EmailAddress | null; to?: EmailAddress[] }) =>
    isCall() ? patchCall(p) : patchMessage(p);

  // Each committed party resolves to a person/organisation by number — linking and
  // unlinking write to the entity (its `numbers`), never to the message.
  const link = (party: EmailAddress, target: string) => {
    if (target === NEW_PERSON) {
      addCard(personDraftForNumber(party.address, party.name));
    } else {
      const c = cardsById().get(target);
      if (c) updateCard(c.id, patchFor(c, { addresses: [], domains: [], numbers: [party.address] }));
    }
  };

  const unlink = (party: EmailAddress, entityId: string) => {
    const c = cardsById().get(entityId);
    if (c?.kind === 'person' && c.person) {
      updateCard(c.id, { person: withoutNumber(c.person, party.address) });
    } else if (c?.kind === 'organisation' && c.organisation) {
      updateCard(c.id, { organisation: withoutNumber(c.organisation, party.address) });
    }
  };

  const ctx: LinkRowContext = {
    roster,
    cardsById,
    hasOrgs,
    selectCard,
    resolve: entitiesForNumber,
    // Name and the number, grouped and canonical (see lib/phone).
    display: (p) => (p.name ? `${p.name} <${formatNumber(p.address)}>` : formatNumber(p.address)),
    // A number carries no domain, so there is no new organisation to make from it —
    // only a new person, or an existing entity to add it to.
    canMakeOrg: () => false,
    onLink: link,
    onUnlink: unlink,
  };

  // The resolved parties sit right under their field — chips and Link… belong to this
  // From or To, not a lumped list below.
  const Linked = (p: { parties: EmailAddress[] }) => (
    <Show when={p.parties.length > 0}>
      <ParticipantLines class="email-addr__list email-fields__linked" parties={p.parties} ctx={ctx} />
    </Show>
  );

  return (
    <div class="field email-fields">
      <span>{isCall() ? 'Call details' : 'Message details'}</span>

      <label class="field email-fields__row">
        <span>From</span>
        <input
          value={from()}
          placeholder="Jane Doe <0400 123 456>"
          onInput={(e) => setFrom(e.currentTarget.value)}
          onBlur={() => commitParticipants({ from: parseAddress(from()) })}
        />
      </label>
      <Linked parties={meta().from?.address ? [meta().from!] : []} />

      <label class="field email-fields__row">
        <span>To</span>
        <input
          value={to()}
          placeholder="comma separated"
          onInput={(e) => setTo(e.currentTarget.value)}
          onBlur={() => commitParticipants({ to: parseAddressList(to()) })}
        />
      </label>
      <Linked parties={meta().to} />

      <Show when={!isCall()}>
        <label class="field email-fields__row">
          <span>Message</span>
          <textarea
            value={body()}
            rows={3}
            placeholder="What was said (or leave it to the screenshot)"
            onInput={(e) => setBody(e.currentTarget.value)}
            onBlur={() => patchMessage({ body: body() })}
          />
        </label>
      </Show>

      <Show when={isCall()}>
        <label class="field email-fields__row">
          <span>Duration</span>
          <input
            value={durationMin()}
            inputmode="numeric"
            placeholder="minutes"
            onInput={(e) => setDurationMin(e.currentTarget.value)}
            onBlur={() => {
              const mins = Number(durationMin().trim());
              patchCall({ durationSecs: Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : undefined });
            }}
          />
        </label>
      </Show>
    </div>
  );
}
