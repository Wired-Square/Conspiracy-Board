import { useBoardStore } from '../store/boardStore';
import { useTauriListen } from './useTauriListen';

type ImportProgress = { done: number; total: number };

// The webview half of a bundle import's progress: the shell (read_bundle) emits
// `import:progress` as it stores each media file, and this refines the busy
// overlay's text to "media x of y". Guarded on an import actually being in flight
// (importStatus set), so an event delivered after importBoard has cleared the
// overlay can't revive it.
export function useImportProgress() {
  useTauriListen<ImportProgress>('import:progress', (e) => {
    if (useBoardStore.getState().importStatus === null) return;
    const { done, total } = e.payload;
    useBoardStore.setState({ importStatus: `Importing media ${done} of ${total}…` });
  });
}
