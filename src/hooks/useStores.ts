import { useStore, type StoreApi } from 'zustand';
import { boardStore } from '../store/boardStore';
import { dialogStore } from '../store/dialogStore';
import { emailImportStore } from '../store/emailImportStore';
import { jobsStore } from '../store/jobsStore';
import { mediaAuditStore } from '../store/mediaAuditStore';
import { promptStore } from '../store/promptStore';

// The stores are framework-free; these are the React bindings to them.
const bind =
  <S,>(store: StoreApi<S>) =>
  <T,>(selector: (s: S) => T): T =>
    useStore(store, selector);

export const useBoardStore = bind(boardStore);
export const useDialogStore = bind(dialogStore);
export const useEmailImportStore = bind(emailImportStore);
export const useJobsStore = bind(jobsStore);
export const useMediaAuditStore = bind(mediaAuditStore);
export const usePromptStore = bind(promptStore);
