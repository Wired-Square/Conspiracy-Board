import { useEffect, useState } from 'react';
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
 * index (storage.searchDocuments → the Rust FTS over PDF/Office/OCR/.eml bodies).
 * Stale-guarded: a response a newer query has superseded is ignored, so hits never
 * lag the box; an empty (or too-short) query resolves to an empty Set with no call at
 * all. The caller debounces `query` (see useDebouncedValue), so this fires no timer of
 * its own.
 *
 * The full-text half of the timeline's search (the fields half is the synchronous
 * matcher). Lifted from the store's old shared runDocSearch, now that full text
 * belongs to the timeline alone.
 */
export function useDocHits(query: string): Set<string> {
  const [hits, setHits] = useState<Set<string>>(() => new Set());
  const q = normaliseQuery(query);

  useEffect(() => {
    if (q.length < MIN_DOC_QUERY) {
      setHits(new Set());
      return;
    }
    let live = true;
    void storage
      .searchDocuments(q, 500)
      .then((rows) => {
        if (live) setHits(new Set(rows.map((r) => r.name)));
      })
      .catch(() => {
        if (live) setHits(new Set());
      });
    return () => {
      live = false;
    };
  }, [q]);

  return hits;
}
