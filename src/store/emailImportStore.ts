import { createStore } from 'zustand/vanilla';
import type { EmailDraft } from '../bindings/EmailDraft';
import type { EmailParse } from '../bindings/EmailParse';
import { emailCardsByMessageId } from '../lib/email/meta';
import { clusterLabelFor, matchBatch } from '../lib/email/importSummary';
import { withMembership } from '../lib/clusters';
import { errorMessage } from '../lib/errors';
import { isBoardKind } from '../lib/kinds';
import type { OfferPlan } from '../lib/importOffer';
import { listenTauri } from '../platform/listen';
import { storage } from '../storage';
import { boardStore, newCluster, type CardDraft } from './boardStore';

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

  /** Parse picked files into staged drafts. */
  parseFiles: (paths: string[]) => Promise<void>;
  /** Parse a pasted raw message (or mbox) into staged drafts. */
  parsePaste: (raw: string) => Promise<void>;
  /** Stage what the shell already parsed (an Inbox batch). */
  stage: (parsed: EmailParse) => void;
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
  const parse = async (run: () => Promise<EmailParse>) => {
    set({ busy: true, progress: null, drafts: [], errors: [] });
    const stop = listenTauri<{ done: number; total: number }>('email:progress', (e) => set({ progress: e.payload }));
    try {
      get().stage(await run());
    } catch (err) {
      set({ busy: false, progress: null, errors: [errorMessage(err)] });
    } finally {
      stop();
    }
  };

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

    async parseFiles(paths) {
      if (paths.length) await parse(() => storage.parseEmailFiles(paths));
    },

    parsePaste: (raw) => parse(() => storage.parseEmailText(raw)),

    stage: ({ drafts, errors }) => set({ drafts, errors, busy: false, progress: null }),

    async commit({ entityDrafts, patches }) {
      const { drafts, clusterId } = get();
      const board = boardStore.getState();
      const byMessageId = emailCardsByMessageId(board.cards);
      const { matches } = matchBatch(drafts, byMessageId);

      // A board-duplicate is turned away; its media, kept at parse, is left to the sweep.
      const emailDrafts = drafts
        .filter((_, i) => matches[i].kind !== 'duplicate')
        .map(({ bytes: _bytes, ...card }): CardDraft => card);

      // Resolve the "new cluster" sentinel to a real cluster now, named after the
      // batch, so the fresh messages and any already-imported ones share one group.
      const fresh = clusterId === NEW_CLUSTER ? newCluster(clusterLabelFor(drafts), board.clusters) : null;
      const cid = fresh?.id ?? clusterId;

      // A message already on the board is part of this thread too. With a cluster
      // chosen, add it in rather than leaving it outside the group the rest joined
      // — appended, not moved: the user placed that card's primary, and this batch
      // is an additional strand. A duplicate carries no card on its match, so it
      // is found the same way the preview matched it — by Message-ID.
      const joining = !cid
        ? []
        : matches.flatMap((m, i) => {
            const mid = drafts[i].email.messageId;
            const existing = m.kind === 'duplicate' && mid ? byMessageId.get(mid) : undefined;
            return existing ? [{ id: existing.id, patch: { clusterIds: withMembership(existing.clusterIds, cid) } }] : [];
          });

      // One edit, so one undo takes the whole import back: the messages and the new
      // entities land in one grid block, in the same cluster, and every id comes
      // back. Nothing is strung together — who is on what is derived from the
      // addresses themselves (see lib/roster.ts), and only the user draws a
      // connection.
      const added = board.addCards([...emailDrafts, ...entityDrafts], {
        clusterId: cid,
        alongside: {
          clusters: fresh ? [fresh] : [],
          cardUpdates: [...joining, ...patches.map(([id, patch]) => ({ id, patch }))],
        },
      });

      get().close();

      // Kinds from what the edit sends: the new cards reach the store only when the
      // shell's change comes back.
      const kinds = new Map([...board.cards, ...added].map((c) => [c.id, c.kind]));
      const addedIds = added.map((c) => c.id);
      const drawnIds = [...addedIds, ...patches.map(([id]) => id)].filter((id) => {
        const kind = kinds.get(id);
        return kind && isBoardKind(kind);
      });
      return { addedIds, drawnIds };
    },
  };
});
