import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Modal } from '../ui/Modal';
import { NEW_CLUSTER } from '../../store/emailImportStore';
import { useRoster } from '../../hooks/useRoster';
import { EMAIL_FILE_ACCEPT } from '../../lib/fileTypes';
import { emailCardsByMessageId, emptyEmailMeta } from '../../lib/email/meta';
import { MAX_MESSAGES, addLabel, batchStatus, cap, hidden, matchBatch } from '../../lib/email/importSummary';
import { shortAddress } from '../../lib/email/addresses';
import { unseenDomains, unseenParticipants } from '../../lib/roster';
import { entitiesOfKind } from '../../lib/kinds';
import { NEW_CARD, choiceFor, planOffer, type Choice } from '../../lib/importOffer';
import { formatOccurredAt } from '../../lib/dates';
import { plural } from '../../lib/format';
import { storage } from '../../storage';
import type { Card } from '../../types/board';
import { useBoardStore, useEmailImportStore } from '../../hooks/useStores';

export function EmailImportModal() {
  // Mounted only while open (see App), so there is no self-hide guard here and
  // the paste box below starts empty every time.
  const { tab, drafts, errors, clusterId, busy, progress, close, setTab, setClusterId, parseFiles, parsePaste, commit } =
    useEmailImportStore((s) => s);

  const clusters = useBoardStore((s) => s.clusters);
  const cards = useBoardStore((s) => s.cards);
  const addCard = useBoardStore((s) => s.addCard);
  const setView = useBoardStore((s) => s.setView);
  const roster = useRoster();
  const { fitView } = useReactFlow();

  const [paste, setPaste] = useState('');
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const choose = (key: string, choice: Choice) =>
    setChoices((m) => new Map(m).set(key, choice));

  // Show what each message will do before committing — the same rules addCards
  // applies, so what's promised here is what lands.
  const byMessageId = useMemo(() => emailCardsByMessageId(cards), [cards]);

  const batch = useMemo(() => matchBatch(drafts, byMessageId), [drafts, byMessageId]);
  const { matches, dupeCount } = batch;

  // Who the batch saw that no card claims yet. The roster is what "claims"
  // means — the same matcher the board itself is read through.
  const offer = useMemo(
    () => ({
      people: cap(unseenParticipants(drafts, roster)),
      domains: cap(unseenDomains(drafts, roster)),
    }),
    [drafts, roster],
  );

  // Where a row can be aimed instead of minting a card. Both kinds are offered
  // for an address, since an organisation holds mail in its own right — legal@
  // is nobody's personal mail, and a new person named "legal" is not the answer.
  const { people, orgs } = useMemo(
    () => ({
      people: entitiesOfKind(cards, 'person'),
      orgs: entitiesOfKind(cards, 'organisation'),
    }),
    [cards],
  );

  // What the ticked rows will do. The footer and onAdd read this one derivation,
  // so what the button promises is exactly what the button does. Only the rows on
  // screen are passed, so a choice left over from an earlier parse in the same
  // session can never fire unnoticed — what is offered is what is committed.
  const { entityDrafts, patches, newPeople, newOrgs } = useMemo(
    () => planOffer(offer.people.shown, offer.domains.shown, choices, cards),
    [offer, choices, cards],
  );

  const newCount = drafts.length - dupeCount;
  const tooMany = newCount > MAX_MESSAGES;

  // A cluster is chosen (a new one, or an existing one) — so the messages in this
  // batch that are already on the board are moved into it rather than skipped.
  const willCluster = clusterId !== null;
  const reclusterCount = willCluster ? dupeCount : 0;

  const label = addLabel({ newCount, newPeople, newOrgs, patchCount: patches.length, reclusterCount });

  const onPickFiles = async () => {
    await parseFiles(await storage.pickFiles(EMAIL_FILE_ACCEPT, true));
  };

  const onAdd = async () => {
    const { addedIds, drawnIds } = await commit({ entityDrafts, patches });
    // Show the user exactly what landed — including a card that only gained an
    // address, whose face does not change and which would otherwise be silent.
    //
    // Only what is drawn, though. fitView does not no-op when it matches no
    // node: it fits an empty bounds, which divides by a zero width, clamps the
    // resulting Infinity to maxZoom, and sails off to park the world origin in
    // the middle of the screen. An all-email import — the ordinary case — would
    // do exactly that, since the record has no node.
    if (drawnIds.length) {
      fitView({
        nodes: drawnIds.map((id) => ({ id })),
        duration: 500,
        padding: 0.4,
        maxZoom: 1,
      });
    } else if (addedIds.length) {
      // It all went to the record — the ordinary case, an mbox with nobody
      // ticked. Nothing moves on the board, so say where it went instead.
      setView('record');
    }
  };

  // This modal is reached from "+ Add > Email", so it has to be able to add an
  // email that isn't being imported from anywhere.
  const onAddBlank = () => {
    close();
    addCard({ title: 'New email', kind: 'email', email: emptyEmailMeta() });
  };

  return (
    <Modal
      title="Add email"
      onClose={close}
      footer={
        <>
          <span className="modal__status">
            {busy
              ? progress
                ? `Parsing ${progress.done}/${progress.total}…`
                : 'Parsing…'
              : drafts.length > 0 && batchStatus(batch, newCount, patches.length, willCluster)}
          </span>
          <button className="link-button" onClick={close}>
            Cancel
          </button>
          <button
            disabled={
              busy ||
              tooMany ||
              (newCount === 0 && !entityDrafts.length && !patches.length && !reclusterCount)
            }
            onClick={() => void onAdd()}
          >
            {label}
          </button>
        </>
      }
    >
      <div className="modal__tabs">
        <button
          className={tab === 'files' ? 'is-active' : ''}
          onClick={() => setTab('files')}
        >
          Files
        </button>
        <button
          className={tab === 'paste' ? 'is-active' : ''}
          onClick={() => setTab('paste')}
        >
          Paste
        </button>
        <button className="link-button modal__tabs-aside" onClick={onAddBlank}>
          Or add a blank email card
        </button>
      </div>

      {tab === 'files' ? (
        <div className="field">
          <span>.eml or .mbox files</span>
          <div className="field__row">
            <button onClick={() => void onPickFiles()} disabled={busy}>
              Choose files…
            </button>
          </div>
          <p className="hint">
            You can also drop email files into the Inbox folder (File ▸ Show Inbox Folder) —
            they import on their own.
          </p>
        </div>
      ) : (
        <div className="field">
          <span>Raw message</span>
          <textarea
            rows={8}
            value={paste}
            placeholder="Paste the raw message including headers — in Gmail: ⋮ → Show original"
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="field__row">
            <button onClick={() => void parsePaste(paste)} disabled={busy || !paste.trim()}>
              Parse
            </button>
          </div>
        </div>
      )}

      <label className="field">
        <span>Add to cluster</span>
        <select
          value={clusterId ?? ''}
          onChange={(e) => setClusterId(e.target.value || null)}
        >
          <option value="">— none —</option>
          <option value={NEW_CLUSTER}>New cluster</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      {errors.length > 0 && (
        <div className="field">
          <span>Skipped</span>
          <ul className="modal__errors">
            {errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {errors.length > 8 && <li>…and {errors.length - 8} more</li>}
          </ul>
        </div>
      )}

      {tooMany && (
        <p className="modal__warn">
          {newCount} messages is more than this board can comfortably hold — import
          up to {MAX_MESSAGES} at a time.
        </p>
      )}

      {offer.people.shown.length > 0 && (
        <div className="field">
          <span>People in these messages ({offer.people.total})</span>
          <ul className="import-offer">
            {offer.people.shown.map((p) => (
              <OfferRow
                key={p.address}
                label={p.name ?? p.address}
                meta={[p.name && p.address, plural(p.count, 'message')]
                  .filter(Boolean)
                  .join(' · ')}
                choice={choiceFor(choices, p.address)}
                newLabel="New person"
                groups={[
                  { label: 'Add to existing person', cards: people },
                  { label: 'Add to existing organisation', cards: orgs },
                ]}
                onChange={(c) => choose(p.address, c)}
              />
            ))}
            {hidden(offer.people) > 0 && (
              <li className="import-offer__more">…and {hidden(offer.people)} more</li>
            )}
          </ul>
          <span className="field__hint">
            Addresses no card claims yet, commonest first. Nothing is added unless you
            tick it.
          </span>
        </div>
      )}

      {offer.domains.shown.length > 0 && (
        <div className="field">
          <span>Organisations in these messages ({offer.domains.total})</span>
          <ul className="import-offer">
            {offer.domains.shown.map((d) => (
              <OfferRow
                key={d.domain}
                label={d.domain}
                meta={`${plural(d.count, 'message')} · ${plural(d.addressCount, 'address', 'addresses')}`}
                choice={choiceFor(choices, d.domain)}
                newLabel="New organisation"
                groups={[{ label: 'Add to existing organisation', cards: orgs }]}
                onChange={(c) => choose(d.domain, c)}
              />
            ))}
            {hidden(offer.domains) > 0 && (
              <li className="import-offer__more">…and {hidden(offer.domains)} more</li>
            )}
          </ul>
          <span className="field__hint">
            Mail domains no organisation claims yet. Free mail providers are left out — a
            provider is not a body anyone is investigating.
          </span>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="field field--grow">
          <span>Preview ({drafts.length})</span>
          <ul className="import-preview">
            {drafts.map((d, i) => {
              const match = matches[i];
              return (
                <li key={i} className={match.kind === 'duplicate' ? 'is-dupe' : ''}>
                  <span className="import-preview__title">{d.title}</span>
                  <span className="import-preview__meta">
                    {shortAddress(d.email.from)}
                    {d.occurredAt
                      ? ` · ${formatOccurredAt(d.occurredAt, d.occurredAtPrecision)}`
                      : ' · undated'}
                  </span>
                  {match.kind === 'duplicate' && (
                    <span className="import-preview__badge">
                      {willCluster ? 'already on board — will join cluster' : 'already on board'}
                    </span>
                  )}
                  {match.kind === 'completes' && (
                    <span className="import-preview__badge is-completes">
                      fills in a dragged message
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** One offered address or domain: tick it, and say where it should go. */
function OfferRow({
  label,
  meta,
  choice,
  newLabel,
  groups,
  onChange,
}: {
  label: string;
  meta: string;
  choice: Choice;
  /** What the default option makes: "New person", "New organisation". */
  newLabel: string;
  groups: { label: string; cards: Card[] }[];
  onChange: (choice: Choice) => void;
}) {
  return (
    <li>
      <label className="import-offer__main">
        <input
          type="checkbox"
          checked={choice.on}
          onChange={(e) => onChange({ ...choice, on: e.target.checked })}
        />
        <span className="import-offer__text">
          <span className="import-offer__label">{label}</span>
          <span className="import-offer__meta">{meta}</span>
        </span>
      </label>
      <select
        value={choice.target}
        // Aiming a row somewhere is itself the decision to use it; making the
        // user tick it as well would be asking the same question twice.
        onChange={(e) => onChange({ on: true, target: e.target.value })}
      >
        <option value={NEW_CARD}>{newLabel}</option>
        {groups
          .filter((g) => g.cards.length > 0)
          .map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
    </li>
  );
}
