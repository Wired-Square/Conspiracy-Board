// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { bust, calendar, film, page, paperclip } from '@wired-square/icons/solid';
import { KindIcon } from './KindIcon';
import { MediaIcon } from './MediaIcon';

afterEach(() => document.body.replaceChildren());

function draw(view: () => JSX.Element): HTMLElement {
  const host = document.body.appendChild(document.createElement('div'));
  render(view, host);
  return host;
}

const shape = (svg: Element | null) => svg?.innerHTML;

test('a kind draws its library glyph, and evidence draws nothing', () => {
  expect(shape(draw(() => KindIcon({ kind: 'person' })).querySelector('svg.kind-icon'))).toBe(shape(draw(bust).firstElementChild));
  expect(shape(draw(() => KindIcon({ kind: 'event' })).querySelector('svg'))).toBe(shape(draw(calendar).firstElementChild));
  expect(draw(() => KindIcon({ kind: 'evidence' })).childElementCount).toBe(0);
});

test('a media icon draws its library glyph, with the paperclip only on an attachment', () => {
  const plain = draw(() => MediaIcon({ type: 'movie' }));
  expect(plain.querySelectorAll('svg')).toHaveLength(1);
  expect(shape(plain.querySelector('svg'))).toBe(shape(draw(film).firstElementChild));

  const clipped = draw(() => MediaIcon({ type: 'document', attachment: true }));
  expect(shape(clipped.querySelector('svg'))).toBe(shape(draw(page).firstElementChild));
  expect(shape(clipped.querySelector('svg.media-icon__clip'))).toBe(shape(draw(paperclip).firstElementChild));
});
