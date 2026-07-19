import { useEffect, useState } from 'react';
import type { Card, CallMeta, EmailAddress, MessageMeta } from '../../types/board';
import {
  formatAddress,
  formatAddressList,
  parseAddress,
  parseAddressList,
} from '../../lib/email/addresses';
import { emptyCallMeta, emptyMessageMeta } from '../../lib/comms';
import { entitiesForNumber } from '../../lib/roster';
import { personDraftForNumber, patchFor } from '../../lib/importOffer';
import { withoutNumber } from '../../lib/entities';
import { formatNumber } from '../../lib/phone';
import {
  NEW_PERSON,
  ParticipantLine,
  useEntityLinkCommon,
  type LinkRowContext,
} from './EntityLink';

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
export function CommsFields({ card }: { card: Card }) {
  const { addCard, updateCard, roster, cardsById, hasOrgs, selectCard } = useEntityLinkCommon();
  const isCall = card.kind === 'call';
  const meta: MessageMeta | CallMeta = isCall
    ? (card.call ?? emptyCallMeta())
    : (card.message ?? emptyMessageMeta());

  const [from, setFrom] = useState(() => formatAddress(meta.from));
  const [to, setTo] = useState(() => formatAddressList(meta.to));
  const [body, setBody] = useState(() => (isCall ? '' : (card.message?.body ?? '')));
  const [durationMin, setDurationMin] = useState(() =>
    card.call?.durationSecs ? String(Math.round(card.call.durationSecs / 60)) : '',
  );

  // Re-seed on card switch; the payload only gets a new identity when written, so
  // this can't fire mid-typing.
  const message = card.message;
  const call = card.call;
  useEffect(() => {
    const m = isCall ? (call ?? emptyCallMeta()) : (message ?? emptyMessageMeta());
    setFrom(formatAddress(m.from));
    setTo(formatAddressList(m.to));
    setBody(isCall ? '' : (message?.body ?? ''));
    setDurationMin(call?.durationSecs ? String(Math.round(call.durationSecs / 60)) : '');
  }, [card.id, isCall, message, call]);

  // One writer per payload, so the `{ ...(card.X ?? emptyXMeta()), ...patch }` merge
  // isn't re-inlined at every field; participants route to whichever this kind is.
  const patchMessage = (p: Partial<MessageMeta>) =>
    updateCard(card.id, { message: { ...(card.message ?? emptyMessageMeta()), ...p } });
  const patchCall = (p: Partial<CallMeta>) =>
    updateCard(card.id, { call: { ...(card.call ?? emptyCallMeta()), ...p } });
  const commitParticipants = (p: { from?: EmailAddress | null; to?: EmailAddress[] }) =>
    isCall ? patchCall(p) : patchMessage(p);

  // Each committed party resolves to a person/organisation by number — linking and
  // unlinking write to the entity (its `numbers`), never to the message.
  const link = (party: EmailAddress, target: string) => {
    if (target === NEW_PERSON) {
      addCard(personDraftForNumber(party.address, party.name));
    } else {
      const c = cardsById.get(target);
      if (c) updateCard(c.id, patchFor(c, { addresses: [], domains: [], numbers: [party.address] }));
    }
  };

  const unlink = (party: EmailAddress, entityId: string) => {
    const c = cardsById.get(entityId);
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
  const linked = (parties: EmailAddress[]) =>
    parties.length > 0 && (
      <ul className="email-addr__list email-fields__linked">
        {parties.map((p, i) => (
          <ParticipantLine key={i} party={p} ctx={ctx} />
        ))}
      </ul>
    );

  return (
    <div className="field email-fields">
      <span>{isCall ? 'Call details' : 'Message details'}</span>

      <label className="field email-fields__row">
        <span>From</span>
        <input
          value={from}
          placeholder="Jane Doe <0400 123 456>"
          onChange={(e) => setFrom(e.target.value)}
          onBlur={() => commitParticipants({ from: parseAddress(from) })}
        />
      </label>
      {linked(meta.from?.address ? [meta.from] : [])}

      <label className="field email-fields__row">
        <span>To</span>
        <input
          value={to}
          placeholder="comma separated"
          onChange={(e) => setTo(e.target.value)}
          onBlur={() => commitParticipants({ to: parseAddressList(to) })}
        />
      </label>
      {linked(meta.to)}

      {!isCall && (
        <label className="field email-fields__row">
          <span>Message</span>
          <textarea
            value={body}
            rows={3}
            placeholder="What was said (or leave it to the screenshot)"
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => patchMessage({ body })}
          />
        </label>
      )}

      {isCall && (
        <label className="field email-fields__row">
          <span>Duration</span>
          <input
            value={durationMin}
            inputMode="numeric"
            placeholder="minutes"
            onChange={(e) => setDurationMin(e.target.value)}
            onBlur={() => {
              const mins = Number(durationMin.trim());
              patchCall({ durationSecs: Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : undefined });
            }}
          />
        </label>
      )}
    </div>
  );
}
