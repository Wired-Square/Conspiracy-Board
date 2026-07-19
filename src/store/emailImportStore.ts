import { create } from 'zustand';
import { parseEmailFile, parseEmailText, type EmailDraft } from '../lib/email/parseEmails';
import type { PickedFile } from '../storage/StorageAdapter';

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
};

export const useEmailImportStore = create<EmailImportState>((set) => {
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
  };
});
