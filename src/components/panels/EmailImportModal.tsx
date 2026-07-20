import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Modal } from '../ui/Modal';
import { useBoardStore } from '../../store/boardStore';
import { useJobQueueStore } from '../../store/jobQueueStore';
import { NEW_CLUSTER, useEmailImportStore } from '../../store/emailImportStore';
import { useRoster } from '../../hooks/useRoster';
import { EMAIL_FILE_ACCEPT } from '../../lib/email/files';
import { emailCardsByMessageId, emptyEmailMeta, matchDraft } from '../../lib/email/meta';
import { shortAddress } from '../../lib/email/addresses';
import { unseenDomains, unseenParticipants } from '../../lib/roster';
import { withMembership } from '../../lib/clusters';
import { entitiesOfKind, isBoardKind } from '../../lib/kinds';
import { NEW_CARD, choiceFor, planOffer, type Choice } from '../../lib/importOffer';
import { formatOccurredAt } from '../../lib/dates';
import { formatBytes, plural } from '../../lib/format';
import { storage } from '../../storage';
import { persistDraftMedia } from '../../lib/email/persistMedia';
import type { EmailDraft } from '../../lib/email/parseEmails';
import type { CardDraft } from '../../store/boardStore';
import type { Card } from '../../types/board';

/** Parsing is on the main thread; a few hundred messages is ~1-2s, which the
 *  progress count covers. A worker would be right at thousands, not hundreds. */
const MAX_MESSAGES = 200;

/**
 * How many rows the offer shows before it stops, mirroring the errors list. A
 * 200-message mbox can carry 300 addresses, and the offer is for the handful the
 * user came for — one careless pass down a list that long would carpet the board
 * with newsletters, and there is no card deletion to take it back with.
 */
const MAX_OFFERED = 50;

// There was a 2MB cap here, to stop one import filling the ~5MB localStorage
// budget. Boards are files now (see src/storage), so there is no budget to fill
// and nothing to refuse. The size is still worth showing — it is the user's disk
// — but it is information, not a limit.

function draftSize(d: EmailDraft): number {
  const m = d.media;
  const attachments = m.attachments.reduce((n, a) => n + (a.bytes?.byteLength ?? 0), 0);
  return d.notes.length + (m.image?.bytes.byteLength ?? 0) + attachments + (m.eml?.byteLength ?? 0);
}

// The offer, below: the addresses and domains this batch saw that no card claims
// yet. It is the one active thing in this modal — everything else here describes
// what is about to happen, where these rows decide it. What ticking one actually
// *does* is lib/importOffer; this file only draws it and hands the answer on.

/** A list the offer had to cut short, and the length it would have been. */
type Capped<T> = { shown: T[]; total: number };

function cap<T>(list: T[]): Capped<T> {
  return { shown: list.slice(0, MAX_OFFERED), total: list.length };
}

function hidden(c: Capped<unknown>): number {
  return c.total - c.shown.length;
}

/**
 * A name for the cluster a dragged thread makes: the subject the batch shares,
 * with any `Re:`/`Fwd:` chain stripped, or a plain fallback when they disagree.
 */
function clusterLabelFor(drafts: EmailDraft[]): string {
  // Strip a whole Re:/Fwd: chain in one pass — `\s*` eats the gaps, `+` the repeats.
  const bareSubject = (raw: string): string =>
    raw.trim().replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/i, '').trim();
  const counts = new Map<string, number>();
  for (const d of drafts) {
    const s = bareSubject(d.title);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = '';
  let top = 0;
  for (const [s, n] of counts) {
    if (n > top) [best, top] = [s, n];
  }
  return best || 'Email thread';
}

export function EmailImportModal() {
  // Mounted only while open (see App), so there is no self-hide guard here and
  // the paste box below starts empty every time.
  const { tab, drafts, errors, clusterId, busy, progress, close, setTab, setClusterId, parseFiles, parsePaste } =
    useEmailImportStore();

  const clusters = useBoardStore((s) => s.clusters);
  const cards = useBoardStore((s) => s.cards);
  const addCards = useBoardStore((s) => s.addCards);
  const addCard = useBoardStore((s) => s.addCard);
  const updateCard = useBoardStore((s) => s.updateCard);
  const addCluster = useBoardStore((s) => s.addCluster);
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

  const { matches, dupeCount, completesCount, addedBytes } = useMemo(() => {
    const matches = drafts.map((d) => matchDraft(d, byMessageId));
    let dupeCount = 0;
    let completesCount = 0;
    let addedBytes = 0;
    matches.forEach((m, i) => {
      if (m.kind === 'duplicate') dupeCount++;
      else {
        if (m.kind === 'completes') completesCount++;
        addedBytes += draftSize(drafts[i]);
      }
    });
    return { matches, dupeCount, completesCount, addedBytes };
  }, [drafts, byMessageId]);

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

  // "3 people, 1 organisation" — what the offer is about to mint.
  const entityBits = [
    newPeople > 0 && plural(newPeople, 'person', 'people'),
    newOrgs > 0 && plural(newOrgs, 'organisation'),
  ]
    .filter(Boolean)
    .join(', ');
  // What the button will do, said out loud. A row aimed at a card that already
  // exists adds nothing, so when those are all there is, it stops saying Add
  // rather than offering to add none.
  const addBits = [newCount > 0 && plural(newCount, 'card'), entityBits]
    .filter(Boolean)
    .join(' + ');
  const addLabel = addBits
    ? `Add ${addBits}`
    : patches.length
      ? `Update ${plural(patches.length, 'card')}`
      : reclusterCount
        ? `Add ${plural(reclusterCount, 'card')} to cluster`
        : 'Add 0 cards';

  const onPickFiles = async () => {
    await parseFiles(await storage.pickFiles(EMAIL_FILE_ACCEPT, true));
  };

  const onAdd = async () => {
    // Write each message's media to the library first, turning the drafts into
    // plain card drafts that reference the files. Only the ones that will land:
    // a board-duplicate is turned away, so writing its files would just make
    // orphans for the sweep. (Idempotent by content hash, so a within-batch
    // repeat is written once regardless.)
    const emailDrafts = (
      await Promise.all(
        drafts.map((d, i) =>
          matches[i].kind === 'duplicate' ? Promise.resolve(null) : persistDraftMedia(d),
        ),
      )
    ).filter((d): d is CardDraft => d !== null);

    // Resolve the "new cluster" sentinel to a real cluster now, named after the
    // batch, so the fresh messages and any already-imported ones share one group.
    const cid = clusterId === NEW_CLUSTER ? addCluster(clusterLabelFor(drafts)) : clusterId;

    // One call: the messages and the new entities land in one grid block, in the
    // same cluster, and every id comes back for the fitView below. Nothing is
    // strung together — who is on what is derived from the addresses themselves
    // (see lib/roster.ts), and only the user draws a connection.
    const addedIds = addCards([...emailDrafts, ...entityDrafts], { clusterId: cid });

    // Index each message's .eml and attachments in the background, so a search finds
    // words in the mail itself, not only the subject/addresses on the card.
    useJobQueueStore.getState().enqueue(
      emailDrafts.flatMap((d) =>
        [d.email?.emlFile, ...(d.email?.attachments ?? []).map((a) => a.file)].filter(
          (n): n is string => !!n,
        ),
      ),
    );

    // A message already on the board is part of this thread too. With a cluster
    // chosen, add it in rather than leaving it outside the group the rest joined
    // — appended, not moved: the user placed that card's primary, and this batch
    // is an additional strand. A duplicate carries no card on its match, so it
    // is found the same way the preview matched it — by Message-ID.
    if (cid) {
      matches.forEach((m, i) => {
        if (m.kind !== 'duplicate') return;
        const mid = drafts[i].email.messageId;
        const existing = mid ? byMessageId.get(mid) : undefined;
        if (existing && !existing.clusterIds.includes(cid)) {
          updateCard(existing.id, { clusterIds: withMembership(existing.clusterIds, cid) });
        }
      });
    }

    for (const [id, patch] of patches) updateCard(id, patch);
    close();

    // Show the user exactly what landed — including a card that only gained an
    // address, whose face does not change and which would otherwise be silent.
    //
    // Only what is drawn, though. fitView does not no-op when it matches no
    // node: it fits an empty bounds, which divides by a zero width, clamps the
    // resulting Infinity to maxZoom, and sails off to park the world origin in
    // the middle of the screen. An all-email import — the ordinary case — would
    // do exactly that, since the record has no node. Read the cards back from
    // the store rather than slicing addedIds: addCards sorts the batch by date,
    // so the ids do not come back in the order they went in.
    const drawn = new Set(
      useBoardStore
        .getState()
        .cards.filter((c) => isBoardKind(c.kind))
        .map((c) => c.id),
    );
    const touched = [...addedIds, ...patches.map(([id]) => id)].filter((id) =>
      drawn.has(id),
    );
    if (touched.length) {
      fitView({
        nodes: touched.map((id) => ({ id })),
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
              : drafts.length > 0 &&
                [
                  `${newCount} to add`,
                  completesCount && `${completesCount} fills in a dragged message`,
                  dupeCount &&
                    (willCluster ? `${dupeCount} added to cluster` : `${dupeCount} already on board`),
                  patches.length && `${plural(patches.length, 'existing card')} updated`,
                  `~${formatBytes(addedBytes)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
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
            {addLabel}
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
