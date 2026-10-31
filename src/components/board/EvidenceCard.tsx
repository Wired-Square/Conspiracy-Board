import { Index, Show } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import type { CardNodeData } from '../../types/canvas';
import type { Card } from '../../types/board';
import { formatOccurredAt } from '../../lib/dates';
import { KIND_META, isEntityKind, isGradedKind } from '../../lib/kinds';
import { GRADE_META, gradeTint } from '../../lib/grades';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';
import { cardImageSrc } from '../../storage/media';
import { cardImageStyle } from '../../lib/imageCrop';

function notesPreview(notes: string): string {
  const text = notes.replace(/[#*_`>\-]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** What the mail finds an actor by, for the polaroid's frame: the first address (and how many more), or the domains. */
function actorDetail(card: Card): string | null {
  if (card.kind === 'person') {
    const [first, ...rest] = card.person?.addresses ?? [];
    if (!first) return null;
    return rest.length ? `${first} +${rest.length}` : first;
  }
  return card.organisation?.domains.join(' · ') || null;
}

// Not loading="lazy": WKWebView's lazy-load intersection is unreliable inside the
// canvas's transformed pane, and the canvas mounts only the cards in view anyway.
function CardImage(props: { card: Card; src: string }) {
  return <img src={props.src} alt="" draggable={false} decoding="async" style={cardImageStyle(props.card)} />;
}

/** An actor's face: a polaroid of somebody, rather than something said about them. */
function PolaroidFace(props: { card: Card }) {
  const detail = () => actorDetail(props.card);
  const image = () => cardImageSrc(props.card);
  return (
    <>
      <div class="polaroid__photo">
        <Show
          when={image()}
          fallback={
            <span class="polaroid__blank" aria-hidden="true">
              {KIND_META[props.card.kind].icon}
            </span>
          }
        >
          {(src) => <CardImage card={props.card} src={src()} />}
        </Show>
      </div>
      <div class="polaroid__caption">
        <div class="polaroid__name">{props.card.title || 'Untitled'}</div>
        <Show when={detail()}>{(text) => <div class="polaroid__detail">{text()}</div>}</Show>
        <Show when={props.card.notes}>
          <div class="polaroid__note">{notesPreview(props.card.notes)}</div>
        </Show>
      </div>
    </>
  );
}

/** The argument's face: paper, graded. */
function PaperFace(props: { card: Card }) {
  // Gated on the kind: a card switched to an ungradeable kind still carries its old grade.
  const grade = () => (isGradedKind(props.card.kind) ? props.card.grade : undefined);
  const image = () => cardImageSrc(props.card);
  return (
    <>
      <div class="evidence-card__accent" />
      <Show when={image()}>
        {(src) => (
          <div class={cx('evidence-card__image', props.card.imageCrop && 'is-cropped')}>
            <CardImage card={props.card} src={src()} />
          </div>
        )}
      </Show>
      <div class="evidence-card__body">
        <div class="evidence-card__title">{props.card.title || 'Untitled'}</div>
        <Show when={props.card.occurredAt}>
          {(at) => <div class="evidence-card__date">{formatOccurredAt(at(), props.card.occurredAtPrecision)}</div>}
        </Show>
        <Show when={grade()}>
          {(g) => (
            <span class="grade-chip" style={gradeTint(g())}>
              {GRADE_META[g()].label}
            </span>
          )}
        </Show>
        <Show when={props.card.notes}>
          <div class="evidence-card__notes">{notesPreview(props.card.notes)}</div>
        </Show>
      </div>
    </>
  );
}

export function EvidenceCard(props: { data: CardNodeData; selected: boolean }) {
  const card = () => props.data.card;
  const actor = () => isEntityKind(card().kind);
  return (
    <div
      class={cx('evidence-card', actor() && 'evidence-card--polaroid', props.selected && 'is-selected')}
      // --card-scale only when derived (actors); the stylesheet's var(--card-scale, 1) owns the default.
      style={{ '--accent': props.data.clusterColor ?? NO_CLUSTER_ACCENT, '--card-scale': props.data.tieScale?.toString() }}
    >
      <Show when={actor()} fallback={<PaperFace card={card()} />}>
        <PolaroidFace card={card()} />
      </Show>
      <Show when={props.data.extraClusterColors.length}>
        <span class="evidence-card__cluster-dots" aria-hidden="true">
          <Index each={props.data.extraClusterColors}>{(c) => <span style={{ background: c() }} />}</Index>
        </span>
      </Show>
      <span class="card-target" aria-hidden="true" />
      <span class="card-source canvas-source" aria-hidden="true" />
    </div>
  );
}
