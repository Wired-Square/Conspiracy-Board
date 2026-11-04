import { Show } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import { bust, calendar, envelope, handset, page, portico, speechBubble } from '@wired-square/icons/solid';
import type { CardKind } from '../../types/board';
import { KIND_META, type KindGlyph } from '../../lib/kinds';

const GLYPHS: Record<KindGlyph, typeof page> = {
  bust,
  portico,
  page,
  envelope,
  'speech-bubble': speechBubble,
  handset,
  calendar,
};

/** A kind's glyph at the size of the text beside it, or nothing for a kind that has none. */
export function KindIcon(props: { kind: CardKind; class?: string }) {
  return (
    <Show when={KIND_META[props.kind].icon}>
      {(name) => GLYPHS[name()]({ class: cx('inline-glyph', props.class) })}
    </Show>
  );
}
