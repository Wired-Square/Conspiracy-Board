import { For, Show, createSignal } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import { openDialog } from '../../store/dialogStore';
import { boardStore } from '../../store/boardStore';
import { strungNote } from '../../lib/connections';
import {
  CARD_KINDS,
  KIND_META,
  canChangeKind,
  isEntityKind,
  isGradedKind,
  isImportedCard,
  isTimelineKind,
  payloadPatchFor,
  viewFor,
} from '../../lib/kinds';
import { cardImageSrc } from '../../storage/media';
import { cardImageStyle } from '../../lib/imageCrop';
import { asPrimary, primaryClusterId, withMembership, withoutMembership } from '../../lib/clusters';
import { eventFor } from '../../lib/events';
import { imageFacts } from '../../lib/mediaFacts';
import type { Card, CardKind } from '../../types/board';
import { fromStore } from '@wired-square/store/solid';
import { createDraft } from '../createDraft';
import { autofocus } from '../ui/autofocus';
import { MarkdownView } from '../ui/MarkdownView';
import { MetaList } from '../ui/MetaList';
import { Modal } from '../ui/Modal';
import { ConnectionsSection } from './ConnectionsSection';
import { ParticipantsSection } from './ParticipantsSection';
import { WhenField } from './WhenField';
import { EmailFields } from './EmailFields';
import { CommsFields } from './CommsFields';
import { DocumentFields } from './DocumentFields';
import { EntityFields } from './EntityFields';
import { GradeField, GradeLegend } from './GradeField';

export function CardEditor() {
  const card = fromStore(boardStore, (s) => s.cards.find((c) => c.id === s.selectedCardId));

  // No selection, no dialog: the editor is a modal now, not a persistent column,
  // so the canvas and timeline fill the whole window when nothing is selected.
  return (
    <Show when={card()}>
      {(card) => (
        <Modal title="Edit card" onClose={() => boardStore.getState().selectCard(null)}>
          {/* Keyed on the id, so the title/notes drafts commit to the card they
              were typed for when the selection moves. */}
          <Show when={card().id} keyed>
            <CardEditorForm card={card()} />
          </Show>
        </Modal>
      )}
    </Show>
  );
}

function CardEditorForm(props: { card: Card }) {
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const { updateCard, setView } = boardStore.getState();
  const id = props.card.id;

  // Title and notes are typed into; every other field is a discrete control and
  // writes through.
  const [title, setTitle, flushTitle] = createDraft(() => props.card.title, (title) => updateCard(id, { title }));
  const [notes, setNotes, flushNotes] = createDraft(() => props.card.notes, (notes) => updateCard(id, { notes }));

  // Changing a card's kind can move it: an evidence card switched to email
  // leaves the board for the record. Follow it, or the card the user is editing
  // vanishes from under them while the editor still shows it.
  const switchKind = (kind: CardKind) => {
    updateCard(id, { kind, ...payloadPatchFor(props.card, kind) });
    setView(viewFor(kind));
  };

  const imageSrc = () => cardImageSrc(props.card);
  const kindMeta = () => KIND_META[props.card.kind];
  const isComms = () => props.card.kind === 'message' || props.card.kind === 'call';

  return (
    <>
      <label class="field">
        <span>Title</span>
        <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onBlur={flushTitle} />
      </label>

      {/* An actor is not a moment: a person does not *happen*, so `occurredAt`
          has nothing to mean on one. It is why the timeline excludes them by
          kind rather than by datedness (see isTimelineKind) — this is the same
          rule, said where the date would otherwise be typed. */}
      {/* An imported email's date is its sent time from the headers — fixed, not
          the reader's to edit. A hand-made email card (no .eml) stays editable. */}
      <Show when={!isEntityKind(props.card.kind)}>
        <WhenField card={props.card} locked={props.card.kind === 'email' && isImportedCard(props.card)} />
      </Show>

      <div class="field">
        <span>Kind</span>
        <Show
          when={canChangeKind(props.card)}
          fallback={
            // Locked: an actor is a legal entity and an import is what its file is
            // — neither is a mis-classification to fix here (see canChangeKind).
            <span class="kind-locked">
              <Show when={kindMeta().icon}>
                <span aria-hidden="true">{kindMeta().icon} </span>
              </Show>
              {kindMeta().label}
            </span>
          }
        >
          {/* Options come from CARD_KINDS rather than being spelled out here, so a
              new kind cannot be added to the model and forgotten in the one place
              it is chosen — KIND_META's Record makes that a compile error. (The
              cast below is unavoidable: a change event carries a string.) */}
          <select value={props.card.kind} onChange={(e) => switchKind(e.currentTarget.value as CardKind)}>
            <For each={CARD_KINDS}>{(kind) => <option value={kind}>{KIND_META[kind].label}</option>}</For>
          </select>
        </Show>
        <span class="field__hint">{kindMeta().hint}</span>
      </div>

      {/* Any dated thing can also *be* an event — a document, a text, a photo. The
          box spawns a graded event card carrying this one's moment, so the timeline
          gets a milestone without the record leaving the Record view. Not on an
          actor (not a moment) nor on an event itself. */}
      <Show when={isTimelineKind(props.card.kind) && props.card.kind !== 'event'}>
        <EventToggle cardId={id} />
      </Show>

      <Show when={props.card.kind === 'email'}>
        <EmailFields card={props.card} />
      </Show>
      <Show when={isComms()}>
        <CommsFields card={props.card} />
      </Show>
      <Show when={props.card.kind === 'document'}>
        <DocumentFields card={props.card} />
      </Show>
      <Show when={isEntityKind(props.card.kind)}>
        <EntityFields card={props.card} />
      </Show>
      {/* Only the argument is graded. An actor is not a claim, and the record
          exists whether or not you like it — see isGradedKind. */}
      <Show when={isGradedKind(props.card.kind)}>
        <GradeField grade={props.card.grade} onChange={(grade) => updateCard(id, { grade })} />
      </Show>

      <div class="field">
        <span>Clusters</span>
        {/* Ticking appends, so tick order is membership order and the first
            ticked is the primary — the one operation that matters on an
            ordering whose only meaningful position is the head. */}
        <ul class="cluster-picker">
          <For each={clusters()}>
            {(c) => {
              const member = () => props.card.clusterIds.includes(c.id);
              return (
                <li class="cluster-picker__row">
                  <label>
                    <input
                      type="checkbox"
                      checked={member()}
                      onChange={() =>
                        updateCard(id, {
                          clusterIds: member()
                            ? withoutMembership(props.card.clusterIds, c.id)
                            : withMembership(props.card.clusterIds, c.id),
                        })
                      }
                    />
                    <span class="cluster-picker__swatch" style={{ background: c.color }} aria-hidden="true" />
                    {c.label}
                  </label>
                  <Show when={member()}>
                    <Show
                      when={c.id === primaryClusterId(props.card.clusterIds)}
                      fallback={
                        <button
                          class="link-button"
                          onClick={() => updateCard(id, { clusterIds: asPrimary(props.card.clusterIds, c.id) })}
                        >
                          Make primary
                        </button>
                      }
                    >
                      <span class="cluster-picker__primary">primary</span>
                    </Show>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
        <span class="field__hint">
          The first cluster is the primary — it colours the card; the others show as dots.
        </span>
      </div>

      <div class="field">
        <span>Picture</span>
        <Show when={imageSrc()}>
          {(src) => (
            <div class={cx('card-editor__preview', props.card.imageCrop && 'is-cropped')}>
              <img src={src()} alt="" style={cardImageStyle(props.card)} />
            </div>
          )}
        </Show>
        {/* A file or a URL, framed by pan-and-zoom, then downloaded into the media
            library — all in the dialog, so this stays one link (see
            ImageEditorModal). */}
        <div class="field__row">
          <button class="link-button" onClick={() => openDialog({ imageEditorCardId: id })}>
            {imageSrc() ? 'Adjust image…' : 'Add image…'}
          </button>
          <Show when={imageSrc()}>
            <button
              class="link-button"
              onClick={() => updateCard(id, { imageFile: null, imageUrl: null, imageCrop: null, imageMeta: null })}
            >
              Remove
            </button>
          </Show>
        </div>
        <Show when={props.card.imageMeta}>{(meta) => <MetaList facts={imageFacts(meta())} />}</Show>
      </div>

      <label class="field field--grow">
        <span>Notes (markdown)</span>
        <textarea value={notes()} onInput={(e) => setNotes(e.currentTarget.value)} onBlur={flushNotes} rows={8} />
      </label>

      {/* The preview reads the draft, so it stays live without a store write. */}
      <Show when={notes().trim()}>
        <div class="field">
          <span>Preview</span>
          <MarkdownView>{notes()}</MarkdownView>
        </div>
      </Show>

      <ConnectionsSection cardId={id} />
      {/* Once, not per control: it serves the card's own grade above and every
          connection's grade in the section above, which are the same ladder. */}
      <GradeLegend />
      {/* Below the connections: what someone asserted comes before what the app
          worked out on its own. */}
      <ParticipantsSection cardId={id} />
      <DeleteCard cardId={id} />
    </>
  );
}

/**
 * "This is an event": a checkbox derived from whether an event card points back at
 * this one (see setIsEvent). Ticking it on spawns that event and strings it here;
 * ticking off removes it. The state is read from the store, not local, so it stays
 * right when the linked event is deleted from elsewhere.
 */
function EventToggle(props: { cardId: string }) {
  const isEvent = fromStore(boardStore, (s) => !!eventFor(s.cards, props.cardId));
  return (
    <label class="field field--check">
      <input
        type="checkbox"
        checked={isEvent()}
        onChange={(e) => boardStore.getState().setIsEvent(props.cardId, e.currentTarget.checked)}
      />
      <span>
        This is an event
        <span class="field__hint"> — a moment on the timeline, and a graded event card strung to this.</span>
      </span>
    </label>
  );
}

/**
 * Delete, confirmed in place. There is an undo behind it now (the toast, and
 * Cmd+Z — see startUndoShortcut), but one chance is still worth a
 * confirm on the only destructive control on the panel.
 *
 * The confirm counts the string first. Deleting a card takes its connections
 * with it (see deleteCard), and a card's links are the one thing about it you
 * cannot see from here without scrolling — so the number goes on the button
 * rather than in a warning nobody reads.
 */
function DeleteCard(props: { cardId: string }) {
  const connections = fromStore(boardStore, (s) => s.connections);
  const [confirming, setConfirming] = createSignal(false);

  return (
    <div class="card-editor__danger">
      <Show
        when={confirming()}
        fallback={
          <button class="card-delete" onClick={() => setConfirming(true)}>
            Delete card
          </button>
        }
      >
        <button
          class="card-delete card-delete--confirm"
          ref={autofocus}
          onBlur={() => setConfirming(false)}
          onClick={() => boardStore.getState().deleteCard(props.cardId)}
        >
          Really delete?{strungNote(connections(), props.cardId)}
        </button>
      </Show>
    </div>
  );
}
