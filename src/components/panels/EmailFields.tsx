import { useEffect, useState } from 'react';
import type { Card, EmailAddress, EmailMeta } from '../../types/board';
import {
  addressDomain,
  formatAddress,
  formatAddressList,
  parseAddress,
  parseAddressList,
} from '../../lib/email/addresses';
import { emptyEmailMeta } from '../../lib/email/meta';
import { mailUrlFor } from '../../lib/email/mailDrag';
import { withoutAddress } from '../../lib/entities';
import { useBoardStore } from '../../store/boardStore';
import { entitiesForAddress, FREEMAIL_DOMAINS } from '../../lib/roster';
import { orgDraftForDomain, patchFor, personDraftFor } from '../../lib/importOffer';
import { isImportedCard } from '../../lib/kinds';
import { storage } from '../../storage';
import {
  NEW_ORG,
  NEW_PERSON,
  ParticipantGroup,
  useEntityLinkCommon,
  type LinkRowContext,
} from './EntityLink';

/**
 * Headers for an email card. There is deliberately no Subject or Date field
 * here: the card's Title is the subject and the When field is the date, and a
 * second input for either would be a second source of truth.
 *
 * An imported email is a document — its headers are what arrived, so they are
 * shown read-only, one address per line, each linked to the person or
 * organisation it resolves to. Only a hand-made email card (no .eml) is typed
 * into: the split is the difference between reading the record and writing it.
 */
export function EmailFields({ card }: { card: Card }) {
  const meta = card.email ?? emptyEmailMeta();
  return isImportedCard(card) ? (
    <ImportedEmailFields meta={meta} />
  ) : (
    <EditableEmailFields card={card} meta={meta} />
  );
}

/** The read-only view: the addresses as they arrived, each a link to its card,
 *  matched to people/organisations by address (see EntityLink for the shared UI). */
function ImportedEmailFields({ meta }: { meta: EmailMeta }) {
  const { selectCard, addCard, updateCard, roster, cardsById, hasOrgs } = useEntityLinkCommon();

  // Linking writes to the entity, not the email: the address is folded into a
  // person or organisation exactly as the import offer does it, so the two can
  // never mean different things.
  const link = (party: EmailAddress, target: string) => {
    if (target === NEW_PERSON) {
      addCard(personDraftFor(party.address, party.name));
    } else if (target === NEW_ORG) {
      const domain = addressDomain(party.address);
      if (domain) addCard(orgDraftForDomain(domain));
    } else {
      const c = cardsById.get(target);
      if (c) updateCard(c.id, patchFor(c, { addresses: [party.address], domains: [] }));
    }
  };

  // Unlinking removes the address from the entity — the badge is derived from it,
  // so dropping it there is what un-ties it.
  const unlink = (party: EmailAddress, entityId: string) => {
    const c = cardsById.get(entityId);
    if (c?.kind === 'person' && c.person) {
      updateCard(c.id, { person: withoutAddress(c.person, party.address) });
    } else if (c?.kind === 'organisation' && c.organisation) {
      updateCard(c.id, { organisation: withoutAddress(c.organisation, party.address) });
    }
  };

  const ctx: LinkRowContext = {
    roster,
    cardsById,
    hasOrgs,
    selectCard,
    resolve: entitiesForAddress,
    display: formatAddress,
    // A new organisation is named by its domain, so a free-mail address has none
    // to make — "New organisation: gmail.com" is noise, and wrong.
    canMakeOrg: (v) => {
      const d = addressDomain(v);
      return !!d && !FREEMAIL_DOMAINS.has(d);
    },
    onLink: link,
    onUnlink: unlink,
  };

  return (
    <div className="field email-fields">
      <span>Email details</span>
      <ParticipantGroup label="From" list={meta.from ? [meta.from] : []} ctx={ctx} />
      <ParticipantGroup label="To" list={meta.to} ctx={ctx} />
      <ParticipantGroup label="Cc" list={meta.cc} ctx={ctx} />
      <EmailExtras meta={meta} />
    </div>
  );
}

/**
 * The parts common to both modes: the attachments, a way to open the original,
 * and the Message-ID. Each hides itself when it has nothing, so a hand-made card
 * shows none of them.
 */
function EmailExtras({ meta }: { meta: EmailMeta }) {
  return (
    <>
      {meta.attachments.length > 0 && (
        <div className="field email-fields__attachments">
          <span>Attachments</span>
          <ul className="attach-list">
            {meta.attachments.map((a, i) => (
              <li key={i}>
                {/* Kept ones open in the OS app; a name with no file is one whose
                    bytes we never got (an older import). */}
                {a.file ? (
                  <button
                    className="link-button attach-list__item"
                    onClick={() => void storage.openMedia(a.file!)}
                  >
                    📎 {a.name}
                  </button>
                ) : (
                  <span className="attach-list__item attach-list__item--dead">📎 {a.name}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(meta.emlFile || (meta.source === 'mail-drag' && meta.messageId)) && (
        <div className="field__row email-fields__actions">
          {/* The whole message, kept as its .eml — the OS opens it in the default
              mail client. A future build may render it in place. */}
          {meta.emlFile && (
            <button className="link-button" onClick={() => void storage.openMedia(meta.emlFile!)}>
              ✉ Open email
            </button>
          )}
          {/* Offered for cards dragged out of Mail, where the message is known to
              be in the user's mailbox. The URL is derived from the Message-ID
              rather than stored, so editing the notes can't lose it. */}
          {meta.source === 'mail-drag' && meta.messageId && (
            <a className="email-fields__mail-link" href={mailUrlFor(meta.messageId)}>
              Open in Mail
            </a>
          )}
        </div>
      )}

      {/* Read-only: nobody hand-types a Message-ID, but seeing it explains why a
          re-import was skipped as a duplicate. */}
      {meta.messageId && (
        <p className="hint email-fields__id" title={meta.messageId}>
          Message-ID: {meta.messageId}
        </p>
      )}
    </>
  );
}

/** The editable view, for a hand-made email card that has no imported .eml. */
function EditableEmailFields({ card, meta }: { card: Card; meta: EmailMeta }) {
  const updateCard = useBoardStore((s) => s.updateCard);

  // Addresses are edited as raw text and only parsed on blur. Parsing every
  // keystroke and formatting the result back into a controlled input would
  // fight the caret (a trailing ", " would vanish as you typed it).
  const [from, setFrom] = useState(() => formatAddress(meta.from));
  const [to, setTo] = useState(() => formatAddressList(meta.to));
  const [cc, setCc] = useState(() => formatAddressList(meta.cc));

  // Re-seed when the editor switches card. `card.email` only gets a new identity
  // when the headers are actually written, so this can't fire mid-typing.
  const email = card.email;
  useEffect(() => {
    const m = email ?? emptyEmailMeta();
    setFrom(formatAddress(m.from));
    setTo(formatAddressList(m.to));
    setCc(formatAddressList(m.cc));
  }, [card.id, email]);

  const commit = (patch: Partial<EmailMeta>) => {
    updateCard(card.id, { email: { ...meta, ...patch } });
  };

  return (
    <div className="field email-fields">
      <span>Email details</span>

      <label className="field email-fields__row">
        <span>From</span>
        <input
          value={from}
          placeholder="Jane Doe <jane@example.com>"
          onChange={(e) => setFrom(e.target.value)}
          onBlur={() => commit({ from: parseAddress(from) })}
        />
      </label>

      <label className="field email-fields__row">
        <span>To</span>
        <input
          value={to}
          placeholder="comma separated"
          onChange={(e) => setTo(e.target.value)}
          onBlur={() => commit({ to: parseAddressList(to) })}
        />
      </label>

      <label className="field email-fields__row">
        <span>Cc</span>
        <input
          value={cc}
          placeholder="comma separated"
          onChange={(e) => setCc(e.target.value)}
          onBlur={() => commit({ cc: parseAddressList(cc) })}
        />
      </label>

      <EmailExtras meta={meta} />
    </div>
  );
}
