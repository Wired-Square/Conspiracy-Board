import { createStore } from 'zustand/vanilla';
import { parseEmailFile, parseEmailText, type EmailDraft } from '../lib/email/parseEmails';
import { emailCardsByMessageId } from '../lib/email/meta';
import { persistDraftMedia } from '../lib/email/persistMedia';
import { clusterLabelFor, matchBatch } from '../lib/email/importSummary';
import { withMembership } from '../lib/clusters';
import { isBoardKind } from '../lib/kinds';
import type { OfferPlan } from '../lib/importOffer';
import type { PickedFile } from '../storage/StorageAdapter';
import { boardStore, type CardDraft } from './boardStore';
import { jobQueueStore } from './jobQueueStore';

// Staged drafts are not board content, so they don't belong in boardStore —
// which is deliberately the canonical board plus one scalar of UI state. Keeping
// them here also lets the toolbar and the canvas drop handler both drive an
// import with no prop drilling.

export type ImportTab = 'files' | 'paste';

// A clusterId the modal never persists: it stands for "make a fresh cluster for
// this batch", resolved to a real id in the modal's onAdd before it reaches the
// board. Offered in the cluster picker, and preselected for a folder batch (a
// dragged thread's .eml files land together, so grouping is the sensible default).
export const NEW_CLUSTER = '__new__';

type EmailImportState = {
  open: boolean;
  tab: ImportTab;
  drafts: EmailDraft[];
  errors: string[];
  clusterId: string | null;
  busy: boolean;
  /** null while parsing has started but no message has finished yet. */
  progress: { done: number; total: number } | null;

  openWith: () => void;
  close: () => void;
  setTab: (tab: ImportTab) => void;
  setClusterId: (id: string | null) => void;

  /** Parse picked or dropped files into staged drafts. */
  parseFiles: (files: PickedFile[]) => Promise<void>;
  /** Parse a pasted raw message (or mbox) into staged drafts. */
  parsePaste: (raw: string) => Promise<void>;
  /**
   * Add the staged drafts and the offer's ticked rows to the board, and close.
   * Returns every card added, and those of the added or patched cards the board
   * draws (the rest live in the record).
   */
  commit: (offer: Pick<OfferPlan, 'entityDrafts' | 'patches'>) => Promise<{ addedIds: string[]; drawnIds: string[] }>;
};

export const emailImportStore = createStore<EmailImportState>()((set, get) => {
  // Clears any previous result, so a re-parse in the same modal session doesn't
  // re-render the old preview on every progress tick.
  const startParse = () => set({ busy: true, progress: null, drafts: [], errors: [] });
  const onProgress = (done: number, total: number) => set({ progress: { done, total } });

  return {
    open: false,
    tab: 'files',
    drafts: [],
    errors: [],
    clusterId: null,
    busy: false,
    progress: null,

    openWith: () =>
      set({ open: true, tab: 'files', drafts: [], errors: [], busy: false, progress: null }),

    close: () =>
      set({ open: false, drafts: [], errors: [], busy: false, progress: null }),

    setTab: (tab) => set({ tab }),
    setClusterId: (clusterId) => set({ clusterId }),

    async parseFiles(files) {
      if (!files.length) return;
      startParse();
      const drafts: EmailDraft[] = [];
      const errors: string[] = [];
      for (const f of files) {
        const r = await parseEmailFile(f.name, f.bytes, onProgress);
        drafts.push(...r.drafts);
        errors.push(...r.errors);
      }
      set({ drafts, errors, busy: false, progress: null });
    },

    async parsePaste(raw) {
      startParse();
      const { drafts, errors } = await parseEmailText(raw, onProgress);
      set({ drafts, errors, busy: false, progress: null });
    },

    async commit({ entityDrafts, patches }) {
      const { drafts, clusterId } = get();
      const board = boardStore.getState();
      const byMessageId = emailCardsByMessageId(board.cards);
      const { matches } = matchBatch(drafts, byMessageId);

      // Write each message's media to the library first, turning the drafts into
      // plain card drafts that reference the files. Only the ones that will land:
      // a board-duplicate is turned away, so writing its files would just make
      // orphans for the sweep. (Idempotent by content hash, so a within-batch
      // repeat is written once regardless.)
      const emailDrafts = (
        await Promise.all(
          drafts.map((d, i) =>
            matches[i].kind === 'duplicate' ? Promise.resolve(null) : persistDraftMedia(d),
          ),
        )
      ).filter((d): d is CardDraft => d !== null);

      // Resolve the "new cluster" sentinel to a real cluster now, named after the
      // batch, so the fresh messages and any already-imported ones share one group.
      const cid = clusterId === NEW_CLUSTER ? board.addCluster(clusterLabelFor(drafts)) : clusterId;

      // One call: the messages and the new entities land in one grid block, in the
      // same cluster, and every id comes back. Nothing is strung together — who is
      // on what is derived from the addresses themselves (see lib/roster.ts), and
      // only the user draws a connection.
      const addedIds = board.addCards([...emailDrafts, ...entityDrafts], { clusterId: cid });

      // Index each message's .eml and attachments in the background, so a search finds
      // words in the mail itself, not only the subject/addresses on the card.
      jobQueueStore.getState().enqueue(
        emailDrafts.flatMap((d) =>
          [d.email?.emlFile, ...(d.email?.attachments ?? []).map((a) => a.file)].filter(
            (n): n is string => !!n,
          ),
        ),
      );

      // A message already on the board is part of this thread too. With a cluster
      // chosen, add it in rather than leaving it outside the group the rest joined
      // — appended, not moved: the user placed that card's primary, and this batch
      // is an additional strand. A duplicate carries no card on its match, so it
      // is found the same way the preview matched it — by Message-ID.
      if (cid) {
        matches.forEach((m, i) => {
          if (m.kind !== 'duplicate') return;
          const mid = drafts[i].email.messageId;
          const existing = mid ? byMessageId.get(mid) : undefined;
          if (existing && !existing.clusterIds.includes(cid)) {
            board.updateCard(existing.id, { clusterIds: withMembership(existing.clusterIds, cid) });
          }
        });
      }

      for (const [id, patch] of patches) board.updateCard(id, patch);
      get().close();

      // Read the cards back from the store rather than slicing addedIds: addCards
      // sorts the batch by date, so the ids do not come back in the order they
      // went in.
      const drawn = new Set(
        boardStore
          .getState()
          .cards.filter((c) => isBoardKind(c.kind))
          .map((c) => c.id),
      );
      const drawnIds = [...addedIds, ...patches.map(([id]) => id)].filter((id) => drawn.has(id));
      return { addedIds, drawnIds };
    },
  };
});
