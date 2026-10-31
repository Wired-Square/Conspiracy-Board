import { Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import { BoardCanvas, CanvasPanel } from './components/board/BoardCanvas';
import { BusyOverlay } from './components/ui/BusyOverlay';
import { BackgroundTaskIndicator } from './components/BackgroundTaskIndicator';
import { FirstRunModal } from './components/panels/FirstRunModal';
import { BoardPropertiesModal } from './components/panels/BoardPropertiesModal';
import { ManageModal } from './components/panels/ManageModal';
import { BundleExportModal } from './components/panels/BundleExportModal';
import { BundleImportModal } from './components/panels/BundleImportModal';
import { EmailImportModal } from './components/panels/EmailImportModal';
import { ImageEditorModal } from './components/panels/ImageEditorModal';
import { LibraryMcpModal } from './components/panels/LibraryMcpModal';
import { CardEditor } from './components/panels/CardEditor';
import { Toolbar } from './components/panels/Toolbar';
import { ClusterPanel } from './components/panels/ClusterPanel';
import { TimelineDrawer } from './components/timeline/TimelineDrawer';
import { RecordView } from './components/record/RecordView';
import { ObjectView } from './components/maintenance/ObjectView';
import { UndoToast } from './components/ui/UndoToast';
import { PromptHost } from './components/ui/PromptModal';
import { fromStore } from './components/fromStore';
import { startInbox } from './platform/inbox';
import { startUndoShortcut } from './platform/undoShortcut';
import { startBoardMenu } from './platform/boardMenu';
import { startImportProgress } from './platform/importProgress';
import { startJobProgress } from './platform/jobProgress';
import { startLibraryMcpStatus } from './platform/libraryMcpStatus';
import { boardStore } from './store/boardStore';
import { closeDialog, dialogStore } from './store/dialogStore';
import { emailImportStore } from './store/emailImportStore';

export default function App() {
  const boardId = fromStore(boardStore, (s) => s.currentBoardId);
  const view = fromStore(boardStore, (s) => s.view);
  const firstRun = fromStore(boardStore, (s) => s.firstRun);
  const dialogs = fromStore(dialogStore, (s) => s);
  const emailImportOpen = fromStore(emailImportStore, (s) => s.open);
  const [ready, setReady] = createSignal(false);

  onMount(() => {
    void boardStore.getState().init().then(() => setReady(true));
    for (const start of [
      startInbox,
      startUndoShortcut,
      startBoardMenu,
      startImportProgress,
      startJobProgress,
      startLibraryMcpStatus,
    ]) {
      onCleanup(start());
    }
  });

  const bundleImport = () => (
    <Show when={dialogs().bundleImportBoards}>{(boards) => <BundleImportModal boards={boards()} />}</Show>
  );

  return (
    <Switch>
      <Match when={!ready()}>
        <div class="loading">Pinning the board…</div>
      </Match>
      {/* An empty library: choose a first board before anything else mounts (there
          is no board to draw yet). Adopting one clears firstRun and the app proceeds.
          The bundle-import dialog rides alongside so "Import a board" can open its
          picker here, before the main tree (which normally hosts it) exists. */}
      <Match when={firstRun()}>
        <FirstRunModal />
        {bundleImport()}
        <BusyOverlay />
      </Match>
      <Match when={true}>
        <div class="app">
          <div class="app__main">
            <div class="app__canvas">
              {/* Keyed on the board: the canvas's viewport and fit are
                  initialisation-only, so switching boards without a remount would
                  show the new cards under the old camera. The drawer's open state
                  is initialised from the board's dates for the same reason.
                  The record covers the canvas rather than replacing it, so the
                  camera and the timeline's pan-to-card survive a view switch. */}
              <Show when={boardId()} keyed>
                <BoardCanvas />
                <Switch>
                  <Match when={view() === 'record'}>
                    <RecordView />
                  </Match>
                  <Match when={view() === 'object'}>
                    <ObjectView />
                  </Match>
                </Switch>
              </Show>
              <CanvasPanel position="top-left">
                <Toolbar />
              </CanvasPanel>
              {/* Shown over board and record: a cluster hides its cards wherever
                  they are. The Objects view has no clusters — it shows its own
                  Maintenance dropdown in this corner instead. */}
              <Show when={view() !== 'object'}>
                <CanvasPanel position="top-right">
                  <ClusterPanel />
                </CanvasPanel>
              </Show>
            </div>
            <Show when={boardId()} keyed>
              <TimelineDrawer />
            </Show>
          </div>
          <CardEditor />
          {/* Outside the canvas, whose wheel and drag handlers would eat scrolling
              and text selection in the forms, and outside the panels, whose
              stacking a fixed backdrop can't escape. Mounted only while open, so
              their local state doesn't outlive the dialog. */}
          <Show when={emailImportOpen()}>
            <EmailImportModal />
          </Show>
          <Show when={dialogs().properties}>
            <BoardPropertiesModal onClose={() => closeDialog('properties')} />
          </Show>
          <Show when={dialogs().imageEditorCardId} keyed>
            {(cardId) => <ImageEditorModal cardId={cardId} />}
          </Show>
          <Show when={dialogs().bundleExport}>
            <BundleExportModal />
          </Show>
          {bundleImport()}
          <Show when={dialogs().manage}>
            <ManageModal />
          </Show>
          <Show when={dialogs().libraryMcp}>
            <LibraryMcpModal />
          </Show>
          <BusyOverlay />
          <BackgroundTaskIndicator />
          <UndoToast />
          <PromptHost />
        </div>
      </Match>
    </Switch>
  );
}
