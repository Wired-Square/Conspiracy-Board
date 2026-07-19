import { create } from 'zustand';
import { useBoardStore } from './boardStore';
import { storage } from '../storage';
import { boardMediaRefs, cardMediaEntries } from './boardMigration';
import { auditMedia, type CurrentRef, type MediaRow } from '../lib/maintenance';

// The media library reconciled against the boards, for the Objects view — lifted out
// of the view into a store so the toolbar's Objects badge can read the file count and
// the operation status without re-running the (expensive) audit itself. The view owns
// the imperative actions; this store is just the shared read-model they write to.
//
// Reads once when the view mounts and on demand — deliberately NOT on every card edit:
// it lists the disk and loads every other board, too much to redo per keystroke, and a
// reprocess changes derived fields, not the file inventory. The view is keyed on the
// board, so it re-audits when the board switches.

type MediaAuditState = {
  rows: MediaRow[];
  loading: boolean;
  error: string | null;
  /** True when a board other than this one wouldn't load, so orphan verdicts were
   *  withheld (shown as `unknown`) rather than risking a false accusation. */
  incomplete: boolean;
  /** The Objects view's transient operation line ("Reprocessing…"), shown on the
   *  toolbar badge. Null when idle. */
  status: string | null;
  setStatus: (status: string | null) => void;
  refresh: () => Promise<void>;
};

export const useMediaAuditStore = create<MediaAuditState>((set) => ({
  rows: [],
  loading: true,
  error: null,
  incomplete: false,
  status: null,
  setStatus: (status) => set({ status }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      // The open board's references come from memory — its live, possibly-unsaved
      // state — each tagged with its owner and media kind for the row's reprocess.
      const { cards, currentBoardId } = useBoardStore.getState();
      const currentRefs: CurrentRef[] = cards.flatMap((c) =>
        cardMediaEntries(c).map((e) => ({
          file: e.file,
          cardId: c.id,
          title: c.title,
          cardKind: c.kind,
          mediaKind: e.kind,
        })),
      );

      // The disk listing has no dependency on the board reads, so start it now and
      // let it run alongside them rather than after.
      const diskP = storage.listMedia();

      // Every *other* board's references, from disk, to tell an orphan (no board
      // wants it) from a file another board owns. If one won't load the set is
      // incomplete — withhold the orphan verdict, as gc_media does before deleting.
      const entries = await storage.listBoards();
      const others = await Promise.all(
        entries.filter((e) => e.id !== currentBoardId).map((e) => storage.loadBoard(e.id)),
      );
      const complete = others.every((b) => b !== null);
      const allRefs = complete ? new Set(others.flatMap((b) => boardMediaRefs(b!))) : null;

      set({ rows: auditMedia(await diskP, currentRefs, allRefs), incomplete: !complete });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
}));
