/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import type { Card } from '../../types/board';
import { emptyOrgMeta, emptyPersonMeta, withAddress, withDomain, withNumber } from '../../lib/entities';
import { formatNumber } from '../../lib/phone';
import { boardStore } from '../../store/boardStore';
import { createSeeded } from '../createSeeded';

/**
 * What a person or an organisation is matched on: addresses, and for an
 * organisation its domains too.
 *
 * There is deliberately no Name field — the card's Title is the name, the same
 * rule EmailFields follows for the subject.
 *
 * These are the join. An address here is what pulls a person's mail onto their
 * card, so what is typed matters more than it looks: it is normalised on the way
 * in (case-folded — `Jane@X.com` and `jane@x.com` are one person) and shown back
 * normalised, so the value in the box is exactly the value that will match.
 */
export function EntityFields(props: { card: Card }) {
  const { updateCard } = boardStore.getState();

  const isOrg = () => props.card.kind === 'organisation';
  const format = (list: string[]) => list.join(', ');
  // Numbers show grouped and canonical (+61 403 123 456) — standardised on the way
  // out, so what's in the box is what will match (see lib/phone).
  const formatNumbers = (list: string[]) => list.map(formatNumber).join(', ');

  // Edited as raw text and only committed on blur, like EmailFields: parsing and
  // re-formatting on every keystroke would fight the caret as you typed a
  // separator. Re-seeded when the payload is rewritten under us — an import can
  // add an address to a person in place.
  const payload = () => props.card.organisation ?? props.card.person;
  const [addresses, setAddresses] = createSeeded(() => format(payload()?.addresses ?? []));
  const [numbers, setNumbers] = createSeeded(() => formatNumbers(payload()?.numbers ?? []));
  const [domainText, setDomainText] = createSeeded(() => format(props.card.organisation?.domains ?? []));

  /**
   * Rebuild the list from what was typed, through the same withAddress/withDomain
   * the import path uses — so both routes agree on what an address *is*, and a
   * change to identity (folding case, say) reaches every writer at once.
   *
   * Generic over the payload rather than cast: a person and an organisation both
   * hold addresses, and each branch keeps its own type on the way to updateCard.
   */
  const rebuild = <T extends { addresses: string[] }>(base: T): T =>
    addresses()
      .split(',')
      .reduce((m, a) => withAddress(m, a), { ...base, addresses: [] as string[] });

  const commitAddresses = () =>
    updateCard(
      props.card.id,
      isOrg()
        ? { organisation: rebuild(props.card.organisation ?? emptyOrgMeta()) }
        : { person: rebuild(props.card.person ?? emptyPersonMeta()) },
    );

  const commitDomains = () =>
    updateCard(props.card.id, {
      organisation: domainText()
        .split(',')
        .reduce(withDomain, { ...(props.card.organisation ?? emptyOrgMeta()), domains: [] }),
    });

  // The number equivalent of commitAddresses, through withNumber so the actor and a
  // text/call agree on what a number *is* (see lib/phone). Shared by both kinds.
  const rebuildNumbers = <T extends { numbers?: string[] }>(base: T): T =>
    numbers()
      .split(',')
      .reduce((m, n) => withNumber(m, n), { ...base, numbers: [] as string[] });

  const commitNumbers = () =>
    updateCard(
      props.card.id,
      isOrg()
        ? { organisation: rebuildNumbers(props.card.organisation ?? emptyOrgMeta()) }
        : { person: rebuildNumbers(props.card.person ?? emptyPersonMeta()) },
    );

  return (
    <div class="field entity-fields">
      <span>{isOrg() ? 'Organisation details' : 'Person details'}</span>

      <label class="field entity-fields__row">
        <span>Addresses</span>
        <input
          value={addresses()}
          placeholder="comma separated"
          onInput={(e) => setAddresses(e.currentTarget.value)}
          onBlur={commitAddresses}
        />
      </label>
      <span class="field__hint">
        {isOrg()
          ? 'Mail this body sends itself — legal@, info@ — including at a domain it does not own.'
          : 'Every address they use. Their mail finds them by these.'}
      </span>

      <label class="field entity-fields__row">
        <span>Numbers</span>
        <input
          value={numbers()}
          placeholder="+61 400 123 456, 02 9000 0000"
          onInput={(e) => setNumbers(e.currentTarget.value)}
          onBlur={commitNumbers}
        />
      </label>
      <span class="field__hint">
        {isOrg()
          ? 'Switchboard or direct lines. A text or call finds this body by these.'
          : 'Their phone numbers. A text or call finds them by these.'}
      </span>

      <Show when={isOrg()}>
        <label class="field entity-fields__row">
          <span>Domains</span>
          <input
            value={domainText()}
            placeholder="acme.com, acme.com.au"
            onInput={(e) => setDomainText(e.currentTarget.value)}
            onBlur={commitDomains}
          />
        </label>
        <span class="field__hint">
          Anyone mailing from these is this organisation’s. Subdomains are separate — add
          <code> mail.acme.com</code> too if it uses one.
        </span>
      </Show>
    </div>
  );
}
