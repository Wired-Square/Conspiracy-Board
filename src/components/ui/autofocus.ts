import { onMount } from 'solid-js';

/** A `ref` that focuses the element once it is in the document. */
export function autofocus(el: HTMLElement) {
  onMount(() => el.focus());
}
