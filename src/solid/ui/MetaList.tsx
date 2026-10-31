/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js';

// A compact read-only key/value list for the metadata read out of an imported file
// — a document's properties, a photo's EXIF. The facts are pre-formatted strings;
// the caller decides what a document card versus an image card has to show.

export function MetaList(props: { facts: [string, string][] }) {
  return (
    <Show when={props.facts.length}>
      <dl class="media-meta">
        <For each={props.facts}>
          {([key, value]) => (
            <div>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}
