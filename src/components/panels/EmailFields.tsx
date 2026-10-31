import { For, Show } from 'solid-js';
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
import { entitiesForAddress, FREEMAIL_DOMAINS } from '../../lib/roster';
import { orgDraftForDomain, patchFor, personDraftFor } from '../../lib/importOffer';
import { isImportedCard } from '../../lib/kinds';
import { storage } from '../../storage';
import { boardStore } from '../../store/boardStore';
import { createSeeded } from '../createSeeded';
import { NEW_ORG, NEW_PERSON, ParticipantGroup, entityLinkCommon, type LinkRowContext } from './EntityLink';

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
export function EmailFields(props: { card: Card }) {
  const meta = () => props.card.email ?? emptyEmailMeta();
  return (
    <Show when={isImportedCard(props.card)} fallback={<EditableEmailFields card={props.card} meta={meta()} />}>
      <ImportedEmailFields meta={meta()} />
    </Show>
  );
}

/** The read-only view: the addresses as they arrived, each a link to its card,
 *  matched to people/organisations by address (see EntityLink for the shared UI). */
function ImportedEmailFields(props: { meta: EmailMeta }) {
  const { selectCard, addCard, updateCard, roster, cardsById, hasOrgs } = entityLinkCommon();

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
      const c = cardsById().get(target);
      if (c) updateCard(c.id, patchFor(c, { addresses: [party.address], domains: [] }));
    }
  };

  // Unlinking removes the address from the entity — the badge is derived from it,
  // so dropping it there is what un-ties it.
  const unlink = (party: EmailAddress, entityId: string) => {
    const c = cardsById().get(entityId);
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
    <div class="field email-fields">
      <span>Email details</span>
      <ParticipantGroup label="From" list={props.meta.from ? [props.meta.from] : []} ctx={ctx} />
      <ParticipantGroup label="To" list={props.meta.to} ctx={ctx} />
      <ParticipantGroup label="Cc" list={props.meta.cc} ctx={ctx} />
      <EmailExtras meta={props.meta} />
    </div>
  );
}

/**
 * The parts common to both modes: the attachments, a way to open the original,
 * and the Message-ID. Each hides itself when it has nothing, so a hand-made card
 * shows none of them.
 */
function EmailExtras(props: { meta: EmailMeta }) {
  const mailDragId = () => (props.meta.source === 'mail-drag' ? props.meta.messageId : undefined);
  return (
    <>
      <Show when={props.meta.attachments.length > 0}>
        <div class="field email-fields__attachments">
          <span>Attachments</span>
          <ul class="attach-list">
            <For each={props.meta.attachments}>
              {(a) => (
                <li>
                  {/* Kept ones open in the OS app; a name with no file is one whose
                      bytes we never got (an older import). */}
                  <Show
                    when={a.file}
                    fallback={<span class="attach-list__item attach-list__item--dead">📎 {a.name}</span>}
                  >
                    {(file) => (
                      <button class="link-button attach-list__item" onClick={() => void storage.openMedia(file())}>
                        📎 {a.name}
                      </button>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={props.meta.emlFile || mailDragId()}>
        <div class="field__row email-fields__actions">
          {/* The whole message, kept as its .eml — the OS opens it in the default
              mail client. A future build may render it in place. */}
          <Show when={props.meta.emlFile}>
            {(eml) => (
              <button class="link-button" onClick={() => void storage.openMedia(eml())}>
                ✉ Open email
              </button>
            )}
          </Show>
          {/* Offered for cards dragged out of Mail, where the message is known to
              be in the user's mailbox. The URL is derived from the Message-ID
              rather than stored, so editing the notes can't lose it. */}
          <Show when={mailDragId()}>
            {(id) => (
              <a class="email-fields__mail-link" href={mailUrlFor(id())}>
                Open in Mail
              </a>
            )}
          </Show>
        </div>
      </Show>

      {/* Read-only: nobody hand-types a Message-ID, but seeing it explains why a
          re-import was skipped as a duplicate. */}
      <Show when={props.meta.messageId}>
        {(id) => (
          <p class="hint email-fields__id" title={id()}>
            Message-ID: {id()}
          </p>
        )}
      </Show>
    </>
  );
}

/** The editable view, for a hand-made email card that has no imported .eml. */
function EditableEmailFields(props: { card: Card; meta: EmailMeta }) {
  const { updateCard } = boardStore.getState();

  // Addresses are edited as raw text and only parsed on blur. Parsing every
  // keystroke and formatting the result back into a controlled input would
  // fight the caret (a trailing ", " would vanish as you typed it).
  const [from, setFrom] = createSeeded(() => formatAddress(props.meta.from));
  const [to, setTo] = createSeeded(() => formatAddressList(props.meta.to));
  const [cc, setCc] = createSeeded(() => formatAddressList(props.meta.cc));

  const commit = (patch: Partial<EmailMeta>) => {
    updateCard(props.card.id, { email: { ...props.meta, ...patch } });
  };

  return (
    <div class="field email-fields">
      <span>Email details</span>

      <label class="field email-fields__row">
        <span>From</span>
        <input
          value={from()}
          placeholder="Jane Doe <jane@example.com>"
          onInput={(e) => setFrom(e.currentTarget.value)}
          onBlur={() => commit({ from: parseAddress(from()) })}
        />
      </label>

      <label class="field email-fields__row">
        <span>To</span>
        <input
          value={to()}
          placeholder="comma separated"
          onInput={(e) => setTo(e.currentTarget.value)}
          onBlur={() => commit({ to: parseAddressList(to()) })}
        />
      </label>

      <label class="field email-fields__row">
        <span>Cc</span>
        <input
          value={cc()}
          placeholder="comma separated"
          onInput={(e) => setCc(e.currentTarget.value)}
          onBlur={() => commit({ cc: parseAddressList(cc()) })}
        />
      </label>

      <EmailExtras meta={props.meta} />
    </div>
  );
}
