import { memo } from 'react';
import { Handle, Position, useConnection, type NodeProps } from '@xyflow/react';
import type { CardNode } from '../../types/reactflow';
import type { Card } from '../../types/board';
import { formatOccurredAt } from '../../lib/dates';
import { KIND_META, isEntityKind, isGradedKind } from '../../lib/kinds';
import { GRADE_META, gradeTint } from '../../lib/grades';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';
import { cardImageSrc, cardImageStyle } from '../../storage/media';

// A short plain-text preview of the markdown notes for the card face.
function notesPreview(notes: string): string {
  const text = notes.replace(/[#*_`>\-]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * What the mail finds an actor by, written on the polaroid's frame under their
 * name. Only the actors are asked: they are the only kinds still drawn that
 * have anything variable to say about themselves.
 */
function actorDetail(card: Card): string | null {
  if (card.kind === 'person') {
    // The first address is the one they are most likely known by; the count says
    // there are others without listing them on a frame this size.
    const [first, ...rest] = card.person?.addresses ?? [];
    if (!first) return null;
    return rest.length ? `${first} +${rest.length}` : first;
  }
  return card.organisation?.domains.join(' · ') || null;
}

/**
 * An actor's face: a polaroid. A person and an organisation are the only things
 * on a board that are *somebody* rather than something said about them, and a
 * photograph pinned to a corkboard is what that has always looked like.
 *
 * The picture is the card's own — an uploaded file, or a pasted link — resolved
 * through `cardImageSrc`. There is simply somewhere on an actor for it to be the
 * point rather than a decoration.
 */
function PolaroidFace({ card }: { card: Card }) {
  const detail = actorDetail(card);
  const image = cardImageSrc(card);
  return (
    <>
      <div className="polaroid__photo">
        {image ? (
          // Not loading="lazy": WKWebView's lazy-load intersection is unreliable
          // inside React Flow's transformed pane — images deferred and often never
          // loaded. onlyRenderVisibleElements already keeps off-screen cards
          // imageless, so eager here costs nothing.
          <img src={image} alt="" draggable={false} decoding="async" style={cardImageStyle(card)} />
        ) : (
          // Empty film, not a hole: a polaroid nobody has found a photograph
          // for yet still reads as one waiting.
          <span className="polaroid__blank" aria-hidden>
            {KIND_META[card.kind].icon}
          </span>
        )}
      </div>
      <div className="polaroid__caption">
        <div className="polaroid__name">{card.title || 'Untitled'}</div>
        {/* Their first address, or the organisation's domains — what the mail
            finds them by, and the only other thing that fits on the frame. */}
        {detail && <div className="polaroid__detail">{detail}</div>}
        {card.notes && <div className="polaroid__note">{notesPreview(card.notes)}</div>}
      </div>
    </>
  );
}

/**
 * The argument: paper. An event and an evidence card are the only things left
 * drawn that are not somebody — they are what is being said, and what is being
 * said goes on paper and gets graded.
 */
function PaperFace({ card }: { card: Card }) {
  // Gated on the kind, never on the grade merely being there: switching kind
  // leaves the old payload behind, so an ungradeable card can still be carrying
  // a grade from before the switch, and it must not wear it.
  const grade = isGradedKind(card.kind) ? card.grade : undefined;
  const image = cardImageSrc(card);
  return (
    <>
      <div className="evidence-card__accent" />
      {image && (
        <div className={`evidence-card__image${card.imageCrop ? ' is-cropped' : ''}`}>
          {/* Eager, like the polaroid above — see the note there. */}
          <img src={image} alt="" draggable={false} decoding="async" style={cardImageStyle(card)} />
        </div>
      )}
      <div className="evidence-card__body">
        <div className="evidence-card__title">{card.title || 'Untitled'}</div>
        {card.occurredAt && (
          <div className="evidence-card__date">
            {formatOccurredAt(card.occurredAt, card.occurredAtPrecision)}
          </div>
        )}
        {/* The chip does not fight the cluster accent up the left edge: the
            accent says which strand of the investigation, the chip says how
            good the claim is. Different questions, so both are allowed to
            answer at once. */}
        {grade && (
          <span className="grade-chip" style={gradeTint(grade)}>
            {GRADE_META[grade].label}
          </span>
        )}
        {card.notes && (
          <div className="evidence-card__notes">{notesPreview(card.notes)}</div>
        )}
      </div>
    </>
  );
}

function EvidenceCardNodeImpl({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const accent = data.clusterColor ?? NO_CLUSTER_ACCENT;
  // Two faces, one node type. They are still the same card — same size, handles,
  // accent, drag and selection — and six node types would widen the
  // 'evidenceCard' literal across five files to change a stroke.
  const actor = isEntityKind(card.kind);
  // Only let the whole-card target catch drops while a connection is in progress,
  // so it never blocks normal clicking/dragging of the card.
  const connecting = useConnection((c) => c.inProgress);
  return (
    <div
      // Not per kind any more: the record is not drawn here at all, and the
      // argument keeps the default paper deliberately, so the face follows the
      // register and nothing else.
      className={`evidence-card${actor ? ' evidence-card--polaroid' : ''}${selected ? ' is-selected' : ''}`}
      // --card-scale grows an actor's polaroid with its connections. Set only
      // when the hook derived one (actors only), so paper faces carry no inert
      // style; the stylesheet's var(--card-scale, 1) owns the default.
      style={{
        ['--accent' as string]: accent,
        ...(data.tieScale !== undefined && { ['--card-scale' as string]: data.tieScale }),
      }}
    >
      {actor ? <PolaroidFace card={card} /> : <PaperFace card={card} />}
      {/* The primary wears the accent; membership of any further clusters shows
          as a dot per colour, so multi-membership is visible at a glance. */}
      {data.extraClusterColors.length > 0 && (
        <span className="evidence-card__cluster-dots" aria-hidden>
          {data.extraClusterColors.map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </span>
      )}
      {/* Start a link from the hot corner; drop it anywhere on a card. */}
      <Handle type="target" position={Position.Left} className={`card-target${connecting ? ' connecting' : ''}`} />
      <Handle type="source" position={Position.Right} className="card-source" />
    </div>
  );
}

export const EvidenceCardNode = memo(EvidenceCardNodeImpl);
