import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { storage } from '../storage';
import { normaliseQuery } from '../lib/search';

/**
 * A query shorter than this never hits the index. A one- or two-character prefix
 * expands to nearly every term in the corpus, so the FTS match is both uselessly broad
 * and pathologically slow to rank (seconds, not milliseconds); the synchronous field
 * matchers still narrow on such a query, they just don't reach into file bodies for it.
 */
const MIN_DOC_QUERY = 3;

/**
 * The media names whose indexed full text matches `query`, from the shell's search
 * index. A response a newer query has superseded is ignored; a too-short query is an
 * empty Set with no call. The caller debounces `query`.
 */
export function createDocHits(query: Accessor<string>): Accessor<Set<string>> {
  const [hits, setHits] = createSignal<Set<string>>(new Set());
  createEffect(
    on(
      () => normaliseQuery(query()),
      (q) => {
        if (q.length < MIN_DOC_QUERY) {
          setHits(new Set<string>());
          return;
        }
        let live = true;
        onCleanup(() => (live = false));
        storage
          .searchDocuments(q, 500)
          .then((rows) => live && setHits(new Set(rows.map((r) => r.name))))
          .catch(() => live && setHits(new Set<string>()));
      },
    ),
  );
  return hits;
}
