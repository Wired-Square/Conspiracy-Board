import { useCallback, useEffect, useRef, useState } from 'react';
import { useBoardStore } from '../../store/boardStore';
import { useImageEditorStore } from '../../store/imageEditorStore';
import { touches } from '../../lib/connections';
import { MarkdownView } from '../ui/MarkdownView';
import { Modal } from '../ui/Modal';
import { ConnectionsSection } from './ConnectionsSection';
import { ParticipantsSection } from './ParticipantsSection';
import { WhenField } from './WhenField';
import { EmailFields } from './EmailFields';
import { CommsFields } from './CommsFields';
import { DocumentFields } from './DocumentFields';
import { EntityFields } from './EntityFields';
import { GradeField, GradeLegend } from './GradeField';
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
import { cardImageSrc, cardImageStyle } from '../../storage/media';
import { asPrimary, primaryClusterId, withMembership, withoutMembership } from '../../lib/clusters';
import { eventFor } from '../../lib/events';
import { formatOccurredAt } from '../../lib/dates';
import { MetaList } from '../ui/MetaList';
import type { Card, CardKind, Connection, ImageMeta } from '../../types/board';

/** A photo's EXIF as display rows: size, when, camera, where. */
function imageFacts(m: ImageMeta): [string, string][] {
  const facts: [string, string][] = [];
  if (m.width && m.height) facts.push(['Size', `${m.width} × ${m.height}`]);
  if (m.takenAt) facts.push(['Taken', formatOccurredAt(m.takenAt, 'day')]);
  const camera = [m.cameraMake, m.cameraModel].filter(Boolean).join(' ').trim();
  if (camera) facts.push(['Camera', camera]);
  if (m.latitude != null && m.longitude != null) {
    facts.push(['Location', `${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`]);
  }
  return facts;
}

export function CardEditor() {
  const selectedId = useBoardStore((s) => s.selectedCardId);
  const card = useBoardStore((s) => s.cards.find((c) => c.id === s.selectedCardId));
  const selectCard = useBoardStore((s) => s.selectCard);

  // No selection, no dialog: the editor is a modal now, not a persistent column,
  // so the canvas and timeline fill the whole window when nothing is selected.
  if (!selectedId || !card) return null;

  return (
    <Modal title="Edit card" onClose={() => selectCard(null)}>
      {/* Keyed, so the title/notes drafts reset when the selection moves. */}
      <CardEditorForm key={card.id} card={card} />
    </Modal>
  );
}

/** How long typing in title/notes may pause before the draft commits. */
const DRAFT_COMMIT_MS = 300;

function CardEditorForm({ card }: { card: Card }) {
  const clusters = useBoardStore((s) => s.clusters);
  const updateCard = useBoardStore((s) => s.updateCard);
  const setView = useBoardStore((s) => s.setView);
  const openImageEditor = useImageEditorStore((s) => s.openFor);

  // Title and notes are the fields that are *typed* into, and each keystroke
  // used to write through to the store — which rebuilds the card's node and
  // re-derives the roster and the participant edges per character. So the two
  // edit a local draft here and commit on a typing pause, on blur, and on
  // unmount. Deliberate trade, worth a note: an external change to them while
  // the editor is open (reprocessCard filling notes from OCR) won't refresh an
  // open draft. Every other field is a discrete control and writes through.
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const pending = useRef<Partial<Pick<Card, 'title' | 'notes'>>>({});
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = undefined;
    }
    const patch = pending.current;
    pending.current = {};
    // updateCard is a no-op if the card was deleted under a pending commit.
    if (patch.title !== undefined || patch.notes !== undefined) updateCard(card.id, patch);
  }, [card.id, updateCard]);

  const stage = (patch: Partial<Pick<Card, 'title' | 'notes'>>) => {
    pending.current = { ...pending.current, ...patch };
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(flush, DRAFT_COMMIT_MS);
  };

  // Closing the editor or moving the selection unmounts this (it is keyed by
  // card id) — commit whatever is still pending on the way out.
  useEffect(() => flush, [flush]);

  // Changing a card's kind can move it: an evidence card switched to email
  // leaves the board for the record. Follow it, or the card the user is editing
  // vanishes from under them while the editor still shows it.
  const switchKind = (kind: CardKind) => {
    updateCard(card.id, { kind, ...payloadPatchFor(card, kind) });
    setView(viewFor(kind));
  };

  const imageSrc = cardImageSrc(card);
  const hasImage = !!imageSrc;

  return (
    <>
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            stage({ title: e.target.value });
          }}
          onBlur={flush}
        />
      </label>

      {/* An actor is not a moment: a person does not *happen*, so `occurredAt`
          has nothing to mean on one. It is why the timeline excludes them by
          kind rather than by datedness (see isTimelineKind) — this is the same
          rule, said where the date would otherwise be typed. */}
      {/* An imported email's date is its sent time from the headers — fixed, not
          the reader's to edit. A hand-made email card (no .eml) stays editable. */}
      {!isEntityKind(card.kind) && (
        <WhenField card={card} locked={card.kind === 'email' && isImportedCard(card)} />
      )}

      <div className="field">
        <span>Kind</span>
        {canChangeKind(card) ? (
          /* Options come from CARD_KINDS rather than being spelled out here, so a
             new kind cannot be added to the model and forgotten in the one place
             it is chosen — KIND_META's Record makes that a compile error. (The
             cast below is unavoidable: a change event carries a string.) */
          <select
            value={card.kind}
            onChange={(e) => switchKind(e.target.value as CardKind)}
          >
            {CARD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_META[kind].label}
              </option>
            ))}
          </select>
        ) : (
          // Locked: an actor is a legal entity and an import is what its file is
          // — neither is a mis-classification to fix here (see canChangeKind).
          <span className="kind-locked">
            {KIND_META[card.kind].icon && (
              <span aria-hidden>{KIND_META[card.kind].icon} </span>
            )}
            {KIND_META[card.kind].label}
          </span>
        )}
        <span className="field__hint">{KIND_META[card.kind].hint}</span>
      </div>

      {/* Any dated thing can also *be* an event — a document, a text, a photo. The
          box spawns a graded event card carrying this one's moment, so the timeline
          gets a milestone without the record leaving the Record view. Not on an
          actor (not a moment) nor on an event itself. */}
      {isTimelineKind(card.kind) && card.kind !== 'event' && <EventToggle card={card} />}

      {card.kind === 'email' && <EmailFields card={card} />}
      {(card.kind === 'message' || card.kind === 'call') && <CommsFields card={card} />}
      {card.kind === 'document' && <DocumentFields card={card} />}
      {isEntityKind(card.kind) && <EntityFields card={card} />}
      {/* Only the argument is graded. An actor is not a claim, and the record
          exists whether or not you like it — see isGradedKind. */}
      {isGradedKind(card.kind) && (
        <GradeField
          grade={card.grade}
          onChange={(grade) => updateCard(card.id, { grade })}
        />
      )}

      <div className="field">
        <span>Clusters</span>
        {/* Ticking appends, so tick order is membership order and the first
            ticked is the primary — the one operation that matters on an
            ordering whose only meaningful position is the head. */}
        <ul className="cluster-picker">
          {clusters.map((c) => {
            const member = card.clusterIds.includes(c.id);
            return (
              <li key={c.id} className="cluster-picker__row">
                <label>
                  <input
                    type="checkbox"
                    checked={member}
                    onChange={() =>
                      updateCard(card.id, {
                        clusterIds: member
                          ? withoutMembership(card.clusterIds, c.id)
                          : withMembership(card.clusterIds, c.id),
                      })
                    }
                  />
                  <span className="cluster-picker__swatch" style={{ background: c.color }} aria-hidden />
                  {c.label}
                </label>
                {member &&
                  (c.id === primaryClusterId(card.clusterIds) ? (
                    <span className="cluster-picker__primary">primary</span>
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        updateCard(card.id, { clusterIds: asPrimary(card.clusterIds, c.id) })
                      }
                    >
                      Make primary
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
        <span className="field__hint">
          The first cluster is the primary — it colours the card; the others show as dots.
        </span>
      </div>

      <div className="field">
        <span>Picture</span>
        {imageSrc && (
          <div className={`card-editor__preview${card.imageCrop ? ' is-cropped' : ''}`}>
            <img src={imageSrc} alt="" style={cardImageStyle(card)} />
          </div>
        )}
        {/* A file or a URL, framed by pan-and-zoom, then downloaded into the media
            library — all in the dialog, so this stays one link (see
            ImageEditorModal). */}
        <div className="field__row">
          <button className="link-button" onClick={() => openImageEditor(card.id)}>
            {hasImage ? 'Adjust image…' : 'Add image…'}
          </button>
          {hasImage && (
            <button
              className="link-button"
              onClick={() =>
                updateCard(card.id, { imageFile: null, imageUrl: null, imageCrop: null, imageMeta: null })
              }
            >
              Remove
            </button>
          )}
        </div>
        {card.imageMeta && <MetaList facts={imageFacts(card.imageMeta)} />}
      </div>

      <label className="field field--grow">
        <span>Notes (markdown)</span>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            stage({ notes: e.target.value });
          }}
          onBlur={flush}
          rows={8}
        />
      </label>

      {/* The preview reads the draft, so it stays live without a store write. */}
      {notes.trim() && (
        <div className="field">
          <span>Preview</span>
          <MarkdownView>{notes}</MarkdownView>
        </div>
      )}

      <ConnectionsSection cardId={card.id} />
      {/* Once, not per control: it serves the card's own grade above and every
          connection's grade in the section above, which are the same ladder. */}
      <GradeLegend />
      {/* Below the connections: what someone asserted comes before what the app
          worked out on its own. */}
      <ParticipantsSection cardId={card.id} />
      <DeleteCard card={card} />
    </>
  );
}

/**
 * "This is an event": a checkbox derived from whether an event card points back at
 * this one (see setIsEvent). Ticking it on spawns that event and strings it here;
 * ticking off removes it. The state is read from the store, not local, so it stays
 * right when the linked event is deleted from elsewhere.
 */
function EventToggle({ card }: { card: Card }) {
  const isEvent = useBoardStore((s) => !!eventFor(s.cards, card.id));
  const setIsEvent = useBoardStore((s) => s.setIsEvent);
  return (
    <label className="field field--check">
      <input
        type="checkbox"
        checked={isEvent}
        onChange={(e) => setIsEvent(card.id, e.target.checked)}
      />
      <span>
        This is an event
        <span className="field__hint"> — a moment on the timeline, and a graded event card strung to this.</span>
      </span>
    </label>
  );
}

/**
 * Delete, confirmed in place. There is a single-level undo behind it now (the
 * toast, and Cmd+Z — see undoLastDelete), but one chance is still worth a
 * confirm on the only destructive control on the panel.
 *
 * The confirm counts the string first. Deleting a card takes its connections
 * with it (see deleteCard), and a card's links are the one thing about it you
 * cannot see from here without scrolling — so the number goes on the button
 * rather than in a warning nobody reads.
 */
function DeleteCard({ card }: { card: Card }) {
  const connections = useBoardStore((s) => s.connections);
  const deleteCard = useBoardStore((s) => s.deleteCard);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card-editor__danger">
      {confirming ? (
        // The count is taken here, inside the branch: the editor re-renders every
        // frame of a drag, and this walks every connection on the board for a
        // string nobody is looking at until they have clicked Delete.
        <button
          className="card-delete card-delete--confirm"
          autoFocus
          onBlur={() => setConfirming(false)}
          onClick={() => deleteCard(card.id)}
        >
          Really delete?{strungNote(connections, card.id)}
        </button>
      ) : (
        <button className="card-delete" onClick={() => setConfirming(true)}>
          Delete card
        </button>
      )}
    </div>
  );
}

/** " (and 3 connections)", or nothing when the card is tied to none. */
function strungNote(connections: readonly Connection[], cardId: string): string {
  const n = connections.filter((c) => touches(c, cardId)).length;
  return n ? ` (and ${n} connection${n === 1 ? '' : 's'})` : '';
}
