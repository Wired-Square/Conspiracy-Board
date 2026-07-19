import { useEffect, useState } from 'react';
import type { Card } from '../../types/board';
import { emptyOrgMeta, emptyPersonMeta, withAddress, withDomain, withNumber } from '../../lib/entities';
import { formatNumber } from '../../lib/phone';
import { useBoardStore } from '../../store/boardStore';

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
export function EntityFields({ card }: { card: Card }) {
  const updateCard = useBoardStore((s) => s.updateCard);

  const isOrg = card.kind === 'organisation';
  // The raw payloads, not `meta` below: these keep their identity between
  // renders, so they can be effect deps. `emptyOrgMeta()` mints a new object
  // every time and would re-seed the inputs mid-typing.
  const { person, organisation } = card;
  const meta = isOrg ? organisation ?? emptyOrgMeta() : person ?? emptyPersonMeta();

  const format = (list: string[]) => list.join(', ');
  // Numbers show grouped and canonical (+61 403 123 456) — standardised on the way
  // out, so what's in the box is what will match (see lib/phone).
  const formatNumbers = (list: string[]) => list.map(formatNumber).join(', ');

  // Edited as raw text and only committed on blur, like EmailFields: parsing and
  // re-formatting on every keystroke would fight the caret as you typed a
  // separator.
  const [addresses, setAddresses] = useState(() => format(meta.addresses));
  const [numbers, setNumbers] = useState(() => formatNumbers(meta.numbers ?? []));
  const [domainText, setDomainText] = useState(() => format(organisation?.domains ?? []));

  // Re-seed when the editor switches card, and when these change under us — an
  // import can add an address to a person in place, so the id never changes and
  // keying on it alone would leave the box showing the old list. A payload only
  // gets a new identity when it is actually written, so this can't fire
  // mid-typing; committing on blur just re-seeds the same string back.
  useEffect(() => {
    setAddresses(format((organisation ?? person)?.addresses ?? []));
    setNumbers(formatNumbers((organisation ?? person)?.numbers ?? []));
    setDomainText(format(organisation?.domains ?? []));
  }, [card.id, person, organisation]);

  /**
   * Rebuild the list from what was typed, through the same withAddress/withDomain
   * the import path uses — so both routes agree on what an address *is*, and a
   * change to identity (folding case, say) reaches every writer at once.
   *
   * Generic over the payload rather than cast: a person and an organisation both
   * hold addresses, and each branch keeps its own type on the way to updateCard.
   */
  const rebuild = <T extends { addresses: string[] }>(base: T): T =>
    addresses
      .split(',')
      .reduce((m, a) => withAddress(m, a), { ...base, addresses: [] as string[] });

  const commitAddresses = () =>
    updateCard(
      card.id,
      isOrg
        ? { organisation: rebuild(organisation ?? emptyOrgMeta()) }
        : { person: rebuild(person ?? emptyPersonMeta()) },
    );

  const commitDomains = () =>
    updateCard(card.id, {
      organisation: domainText
        .split(',')
        .reduce(withDomain, { ...(organisation ?? emptyOrgMeta()), domains: [] }),
    });

  // The number equivalent of commitAddresses, through withNumber so the actor and a
  // text/call agree on what a number *is* (see lib/phone). Shared by both kinds.
  const rebuildNumbers = <T extends { numbers?: string[] }>(base: T): T =>
    numbers.split(',').reduce((m, n) => withNumber(m, n), { ...base, numbers: [] as string[] });

  const commitNumbers = () =>
    updateCard(
      card.id,
      isOrg
        ? { organisation: rebuildNumbers(organisation ?? emptyOrgMeta()) }
        : { person: rebuildNumbers(person ?? emptyPersonMeta()) },
    );

  return (
    <div className="field entity-fields">
      <span>{isOrg ? 'Organisation details' : 'Person details'}</span>

      <label className="field entity-fields__row">
        <span>Addresses</span>
        <input
          value={addresses}
          placeholder="comma separated"
          onChange={(e) => setAddresses(e.target.value)}
          onBlur={commitAddresses}
        />
      </label>
      <span className="field__hint">
        {isOrg
          ? 'Mail this body sends itself — legal@, info@ — including at a domain it does not own.'
          : 'Every address they use. Their mail finds them by these.'}
      </span>

      <label className="field entity-fields__row">
        <span>Numbers</span>
        <input
          value={numbers}
          placeholder="+61 400 123 456, 02 9000 0000"
          onChange={(e) => setNumbers(e.target.value)}
          onBlur={commitNumbers}
        />
      </label>
      <span className="field__hint">
        {isOrg
          ? 'Switchboard or direct lines. A text or call finds this body by these.'
          : 'Their phone numbers. A text or call finds them by these.'}
      </span>

      {isOrg && (
        <>
          <label className="field entity-fields__row">
            <span>Domains</span>
            <input
              value={domainText}
              placeholder="acme.com, acme.com.au"
              onChange={(e) => setDomainText(e.target.value)}
              onBlur={commitDomains}
            />
          </label>
          <span className="field__hint">
            Anyone mailing from these is this organisation’s. Subdomains are separate — add
            <code> mail.acme.com</code> too if it uses one.
          </span>
        </>
      )}
    </div>
  );
}
