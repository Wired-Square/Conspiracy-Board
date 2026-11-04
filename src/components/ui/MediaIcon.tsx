import { Show } from 'solid-js';
import { envelope, film, handset, landscape, page, paperclip, speaker, speechBubble } from '@wired-square/icons/solid';
import type { MediaIconType } from '../../lib/mediaIcon';

const GLYPHS: Record<MediaIconType, typeof page> = {
  document: page,
  image: landscape,
  movie: film,
  sound: speaker,
  email: envelope,
  message: speechBubble,
  call: handset,
};

/** Sized in `em`: the caller sets the size with font-size on the box that holds it. */
export function MediaIcon(props: { type: MediaIconType; attachment?: boolean }) {
  return (
    <span class="media-icon" aria-hidden="true">
      {GLYPHS[props.type]()}
      <Show when={props.attachment}>{paperclip({ class: 'media-icon__clip' })}</Show>
    </span>
  );
}
