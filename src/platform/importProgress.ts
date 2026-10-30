import { boardStore } from '../store/boardStore';
import { listenTauri } from './listen';

type ImportProgress = { done: number; total: number };

// The webview half of a bundle import's progress: the shell (read_bundle) emits
// `import:progress` as it stores each media file, and this refines the busy
// overlay's text to "media x of y". Guarded on an import actually being in flight
// (importStatus set), so an event delivered after importBoard has cleared the
// overlay can't revive it.
export function startImportProgress(): () => void {
  return listenTauri<ImportProgress>('import:progress', (e) => {
    if (boardStore.getState().importStatus === null) return;
    const { done, total } = e.payload;
    boardStore.setState({ importStatus: `Importing media ${done} of ${total}…` });
  });
}
