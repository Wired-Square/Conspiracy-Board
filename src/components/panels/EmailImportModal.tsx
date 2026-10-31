import { For, Show, createMemo, createSignal } from 'solid-js';
import { count } from '@wired-square/kit/core';
import { Modal } from '../ui/Modal';
import { camera } from '../board/camera';
import { NEW_CLUSTER, emailImportStore } from '../../store/emailImportStore';
import { boardStore } from '../../store/boardStore';
import { EMAIL_FILE_FILTER } from '../../lib/fileTypes';
import { emailCardsByMessageId, emptyEmailMeta } from '../../lib/email/meta';
import { MAX_MESSAGES, addLabel, batchStatus, cap, hidden, matchBatch } from '../../lib/email/importSummary';
import { shortAddress } from '../../lib/email/addresses';
import { buildRoster, unseenDomains, unseenParticipants } from '../../lib/roster';
import { entitiesOfKind } from '../../lib/kinds';
import { NEW_CARD, choiceFor, planOffer, type Choice } from '../../lib/importOffer';
import { formatOccurredAt } from '../../lib/dates';
import { storage } from '../../storage';
import type { Card } from '../../types/board';
import { fromStore } from '../fromStore';

export function EmailImportModal() {
  // Mounted only while open (see App), so there is no self-hide guard here and
  // the paste box below starts empty every time.
  const tab = fromStore(emailImportStore, (s) => s.tab);
  const drafts = fromStore(emailImportStore, (s) => s.drafts);
  const errors = fromStore(emailImportStore, (s) => s.errors);
  const clusterId = fromStore(emailImportStore, (s) => s.clusterId);
  const busy = fromStore(emailImportStore, (s) => s.busy);
  const progress = fromStore(emailImportStore, (s) => s.progress);
  const { close, setTab, setClusterId, parseFiles, parsePaste, commit } = emailImportStore.getState();

  const clusters = fromStore(boardStore, (s) => s.clusters);
  const cards = fromStore(boardStore, (s) => s.cards);
  const roster = createMemo(() => buildRoster(cards()));

  const [paste, setPaste] = createSignal('');
  const [choices, setChoices] = createSignal<Map<string, Choice>>(new Map());
  const choose = (key: string, choice: Choice) => setChoices((m) => new Map(m).set(key, choice));

  // Show what each message will do before committing — the same rules addCards
  // applies, so what's promised here is what lands.
  const byMessageId = createMemo(() => emailCardsByMessageId(cards()));
  const batch = createMemo(() => matchBatch(drafts(), byMessageId()));

  // Who the batch saw that no card claims yet. The roster is what "claims"
  // means — the same matcher the board itself is read through.
  const offer = createMemo(() => ({
    people: cap(unseenParticipants(drafts(), roster())),
    domains: cap(unseenDomains(drafts(), roster())),
  }));

  // Where a row can be aimed instead of minting a card. Both kinds are offered
  // for an address, since an organisation holds mail in its own right — legal@
  // is nobody's personal mail, and a new person named "legal" is not the answer.
  const people = createMemo(() => entitiesOfKind(cards(), 'person'));
  const orgs = createMemo(() => entitiesOfKind(cards(), 'organisation'));

  // What the ticked rows will do. The footer and onAdd read this one derivation,
  // so what the button promises is exactly what the button does. Only the rows on
  // screen are passed, so a choice left over from an earlier parse in the same
  // session can never fire unnoticed — what is offered is what is committed.
  const plan = createMemo(() => planOffer(offer().people.shown, offer().domains.shown, choices(), cards()));

  const newCount = () => drafts().length - batch().dupeCount;
  const tooMany = () => newCount() > MAX_MESSAGES;

  // A cluster is chosen (a new one, or an existing one) — so the messages in this
  // batch that are already on the board are moved into it rather than skipped.
  const willCluster = () => clusterId() !== null;
  const reclusterCount = () => (willCluster() ? batch().dupeCount : 0);

  const label = () =>
    addLabel({
      newCount: newCount(),
      newPeople: plan().newPeople,
      newOrgs: plan().newOrgs,
      patchCount: plan().patches.length,
      reclusterCount: reclusterCount(),
    });

  const onPickFiles = async () => {
    await parseFiles(await storage.pickPaths(EMAIL_FILE_FILTER, true));
  };

  const onAdd = async () => {
    const { entityDrafts, patches } = plan();
    const { addedIds, drawnIds } = await commit({ entityDrafts, patches });
    // Show the user exactly what landed — including a card that only gained an
    // address, whose face does not change and which would otherwise be silent.
    //
    // Only what is drawn, though: an all-email import — the ordinary case — has
    // nothing on the board to frame.
    if (drawnIds.length) {
      camera()?.fitWhenDrawn({ ids: drawnIds, duration: 500, padding: 0.4, maxZoom: 1 });
    } else if (addedIds.length) {
      // It all went to the record — the ordinary case, an mbox with nobody
      // ticked. Nothing moves on the board, so say where it went instead.
      boardStore.getState().setView('record');
    }
  };

  // This modal is reached from "+ Add > Email", so it has to be able to add an
  // email that isn't being imported from anywhere.
  const onAddBlank = () => {
    close();
    boardStore.getState().addCard({ title: 'New email', kind: 'email', email: emptyEmailMeta() });
  };

  const status = () => {
    if (busy()) {
      const p = progress();
      return p ? `Parsing ${p.done}/${p.total}…` : 'Parsing…';
    }
    return drafts().length > 0 && batchStatus(batch(), newCount(), plan().patches.length, willCluster());
  };

  return (
    <Modal
      title="Add email"
      onClose={close}
      footer={
        <>
          <span class="modal__status">{status()}</span>
          <button class="link-button" onClick={close}>
            Cancel
          </button>
          <button
            disabled={
              busy() ||
              tooMany() ||
              (newCount() === 0 && !plan().entityDrafts.length && !plan().patches.length && !reclusterCount())
            }
            onClick={() => void onAdd()}
          >
            {label()}
          </button>
        </>
      }
    >
      <div class="modal__tabs">
        <button class={tab() === 'files' ? 'is-active' : ''} onClick={() => setTab('files')}>
          Files
        </button>
        <button class={tab() === 'paste' ? 'is-active' : ''} onClick={() => setTab('paste')}>
          Paste
        </button>
        <button class="link-button modal__tabs-aside" onClick={onAddBlank}>
          Or add a blank email card
        </button>
      </div>

      <Show
        when={tab() === 'files'}
        fallback={
          <div class="field">
            <span>Raw message</span>
            <textarea
              rows={8}
              value={paste()}
              placeholder="Paste the raw message including headers — in Gmail: ⋮ → Show original"
              onInput={(e) => setPaste(e.currentTarget.value)}
            />
            <div class="field__row">
              <button onClick={() => void parsePaste(paste())} disabled={busy() || !paste().trim()}>
                Parse
              </button>
            </div>
          </div>
        }
      >
        <div class="field">
          <span>.eml or .mbox files</span>
          <div class="field__row">
            <button onClick={() => void onPickFiles()} disabled={busy()}>
              Choose files…
            </button>
          </div>
          <p class="hint">
            You can also drop email files into the Inbox folder (File ▸ Show Inbox Folder) —
            they import on their own.
          </p>
        </div>
      </Show>

      <label class="field">
        <span>Add to cluster</span>
        <select value={clusterId() ?? ''} onChange={(e) => setClusterId(e.currentTarget.value || null)}>
          <option value="">— none —</option>
          <option value={NEW_CLUSTER}>New cluster</option>
          <For each={clusters()}>{(c) => <option value={c.id}>{c.label}</option>}</For>
        </select>
      </label>

      <Show when={errors().length > 0}>
        <div class="field">
          <span>Skipped</span>
          <ul class="modal__errors">
            <For each={errors().slice(0, 8)}>{(e) => <li>{e}</li>}</For>
            <Show when={errors().length > 8}>
              <li>…and {errors().length - 8} more</li>
            </Show>
          </ul>
        </div>
      </Show>

      <Show when={tooMany()}>
        <p class="modal__warn">
          {newCount()} messages is more than this board can comfortably hold — import
          up to {MAX_MESSAGES} at a time.
        </p>
      </Show>

      <Show when={offer().people.shown.length > 0}>
        <div class="field">
          <span>People in these messages ({offer().people.total})</span>
          <ul class="import-offer">
            <For each={offer().people.shown}>
              {(p) => (
                <OfferRow
                  label={p.name ?? p.address}
                  meta={[p.name && p.address, count(p.count, 'message')].filter(Boolean).join(' · ')}
                  choice={choiceFor(choices(), p.address)}
                  newLabel="New person"
                  groups={[
                    { label: 'Add to existing person', cards: people() },
                    { label: 'Add to existing organisation', cards: orgs() },
                  ]}
                  onChange={(c) => choose(p.address, c)}
                />
              )}
            </For>
            <Show when={hidden(offer().people) > 0}>
              <li class="import-offer__more">…and {hidden(offer().people)} more</li>
            </Show>
          </ul>
          <span class="field__hint">
            Addresses no card claims yet, commonest first. Nothing is added unless you
            tick it.
          </span>
        </div>
      </Show>

      <Show when={offer().domains.shown.length > 0}>
        <div class="field">
          <span>Organisations in these messages ({offer().domains.total})</span>
          <ul class="import-offer">
            <For each={offer().domains.shown}>
              {(d) => (
                <OfferRow
                  label={d.domain}
                  meta={`${count(d.count, 'message')} · ${count(d.addressCount, 'address', 'addresses')}`}
                  choice={choiceFor(choices(), d.domain)}
                  newLabel="New organisation"
                  groups={[{ label: 'Add to existing organisation', cards: orgs() }]}
                  onChange={(c) => choose(d.domain, c)}
                />
              )}
            </For>
            <Show when={hidden(offer().domains) > 0}>
              <li class="import-offer__more">…and {hidden(offer().domains)} more</li>
            </Show>
          </ul>
          <span class="field__hint">
            Mail domains no organisation claims yet. Free mail providers are left out — a
            provider is not a body anyone is investigating.
          </span>
        </div>
      </Show>

      <Show when={drafts().length > 0}>
        <div class="field field--grow">
          <span>Preview ({drafts().length})</span>
          <ul class="import-preview">
            <For each={drafts()}>
              {(d, i) => {
                const match = () => batch().matches[i()];
                return (
                  <li class={match().kind === 'duplicate' ? 'is-dupe' : ''}>
                    <span class="import-preview__title">{d.title}</span>
                    <span class="import-preview__meta">
                      {shortAddress(d.email.from)}
                      {d.occurredAt ? ` · ${formatOccurredAt(d.occurredAt, d.occurredAtPrecision)}` : ' · undated'}
                    </span>
                    <Show when={match().kind === 'duplicate'}>
                      <span class="import-preview__badge">
                        {willCluster() ? 'already on board — will join cluster' : 'already on board'}
                      </span>
                    </Show>
                    <Show when={match().kind === 'completes'}>
                      <span class="import-preview__badge is-completes">fills in a dragged message</span>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </div>
      </Show>
    </Modal>
  );
}

/** One offered address or domain: tick it, and say where it should go. */
function OfferRow(props: {
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
      <label class="import-offer__main">
        <input
          type="checkbox"
          checked={props.choice.on}
          onChange={(e) => props.onChange({ ...props.choice, on: e.currentTarget.checked })}
        />
        <span class="import-offer__text">
          <span class="import-offer__label">{props.label}</span>
          <span class="import-offer__meta">{props.meta}</span>
        </span>
      </label>
      <select
        value={props.choice.target}
        // Aiming a row somewhere is itself the decision to use it; making the
        // user tick it as well would be asking the same question twice.
        onChange={(e) => props.onChange({ on: true, target: e.currentTarget.value })}
      >
        <option value={NEW_CARD}>{props.newLabel}</option>
        <For each={props.groups.filter((g) => g.cards.length > 0)}>
          {(g) => (
            <optgroup label={g.label}>
              <For each={g.cards}>{(c) => <option value={c.id}>{c.title}</option>}</For>
            </optgroup>
          )}
        </For>
      </select>
    </li>
  );
}
