// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { MarkdownView } from './MarkdownView';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function view(source: string) {
  const host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(MarkdownView, { children: source }), host);
  return host.querySelector('.markdown')!;
}

test('raw HTML in a note is shown as text, never parsed', () => {
  const md = view('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> <b>bold</b>');
  expect(md.querySelector('script, img, b')).toBeNull();
  expect(md.textContent).toContain('<script>alert(1)</script>');
  expect(md.textContent).toContain('<b>bold</b>');
});

test('a javascript: link keeps its text but loses its target', () => {
  const md = view('[click](javascript:alert(1)) and [ok](https://example.com)');
  const [bad, good] = md.querySelectorAll('a');
  expect(bad.textContent).toBe('click');
  expect(bad.getAttribute('href')).toBe('');
  expect(good.getAttribute('href')).toBe('https://example.com');
});

test('GFM tables, strikethrough and autolinks render', () => {
  const md = view('| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~ see https://example.com/x');
  expect([...md.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['a', 'b']);
  expect([...md.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['1', '2']);
  expect(md.querySelector('del')?.textContent).toBe('gone');
  expect(md.querySelector('p a')?.getAttribute('href')).toBe('https://example.com/x');
});
