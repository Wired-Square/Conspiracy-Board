import { useEffect, useState } from 'react';
import type { Component } from 'solid-js';
import { BoardCanvas } from './components/BoardCanvas';
import { CameraProvider, CanvasPanel, useCamera, type Camera } from './components/canvas/Canvas';
import { ObjectView } from './components/maintenance/ObjectView';
import { BusyOverlay } from './components/ui/BusyOverlay';
import { SolidIsland } from './components/SolidIsland';
import { BackgroundTaskIndicator } from './solid/BackgroundTaskIndicator';
import { FirstRunModal } from './solid/panels/FirstRunModal';
import { BoardPropertiesModal } from './solid/panels/BoardPropertiesModal';
import { ManageModal } from './solid/panels/ManageModal';
import { BundleExportModal } from './solid/panels/BundleExportModal';
import { BundleImportModal } from './solid/panels/BundleImportModal';
import { EmailImportModal } from './solid/panels/EmailImportModal';
import { ImageEditorModal } from './solid/panels/ImageEditorModal';
import { CardEditor } from './solid/panels/CardEditor';
import { Toolbar } from './solid/panels/Toolbar';
import { ClusterPanel } from './solid/panels/ClusterPanel';
import { TimelineDrawer } from './solid/timeline/TimelineDrawer';
import { RecordView } from './solid/record/RecordView';
import { UndoToast } from './components/ui/UndoToast';
import { PromptHost } from './components/ui/PromptModal';
import { useStart } from './hooks/useStart';
import { startInbox } from './platform/inbox';
import { startUndoShortcut } from './platform/undoShortcut';
import { startBoardMenu } from './platform/boardMenu';
import { startImportProgress } from './platform/importProgress';
import { startJobProgress } from './platform/jobProgress';
import { closeDialog } from './store/dialogStore';
import { useBoardStore, useDialogStore, useEmailImportStore } from './hooks/useStores';

// Subscribes to importStatus on its own, so a per-media progress event re-renders
// this leaf rather than App and the whole canvas beneath it.
function ImportOverlay() {
  const status = useBoardStore((s) => s.importStatus);
  return status ? <BusyOverlay status={status} /> : null;
}

// The camera is React context, which an island can't read, so it is handed in.
function CameraIsland<P extends object>(props: { component: Component<P & { camera: Camera | null }> } & P) {
  return <SolidIsland<P & { camera: Camera | null }> {...props} camera={useCamera()} />;
}

export default function App() {
  const init = useBoardStore((s) => s.init);
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  const emailImportOpen = useEmailImportStore((s) => s.open);
  const propertiesOpen = useDialogStore((s) => s.properties);
  const imageEditorCardId = useDialogStore((s) => s.imageEditorCardId);
  const bundleExportOpen = useDialogStore((s) => s.bundleExport);
  const bundleImportBoards = useDialogStore((s) => s.bundleImportBoards);
  const manageOpen = useDialogStore((s) => s.manage);
  const view = useBoardStore((s) => s.view);
  const firstRun = useBoardStore((s) => s.firstRun);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void init().then(() => setReady(true));
  }, [init]);

  // Files the shell sweeps out of the Inbox drop-folder — the one automatic way
  // in for email, images and documents (see src/platform/inbox.ts).
  useStart(startInbox);
  // Cmd+Z restores the last delete, board-wide.
  useStart(startUndoShortcut);
  // The native File menu (src-tauri/src/menu.rs) drives board management.
  useStart(startBoardMenu);
  // Refines the import busy-overlay text as the shell stores a bundle's media.
  useStart(startImportProgress);
  // Keeps the indexing badge on the shell's extraction queue.
  useStart(startJobProgress);

  if (!ready) {
    return <div className="loading">Pinning the board…</div>;
  }

  // An empty library: choose a first board before anything else mounts (there is
  // no board to draw yet). Adopting one clears firstRun and the app proceeds. The
  // bundle-import dialog rides alongside so "Import a board" can open its picker
  // here, before the main tree (which normally hosts it) exists.
  if (firstRun) {
    return (
      <>
        <SolidIsland component={FirstRunModal} />
        {bundleImportBoards && <SolidIsland component={BundleImportModal} boards={bundleImportBoards} />}
        <ImportOverlay />
      </>
    );
  }

  return (
    <div className="app">
      <CameraProvider>
        {/* The drawer spans the full width now that the editor is a dialog rather
            than a column, and must sit inside the provider (it calls useCamera)
            yet outside the canvas. */}
        <div className="app__main">
          <div className="app__canvas">
            {/* Keyed on the board: the canvas's viewport and fit are
                initialisation-only, so switching boards without a remount would
                show the new cards under the old camera. The drawer's open state
                is lazily initialised from the board's dates for the same reason. */}
            <BoardCanvas key={currentBoardId} />
            {/* The record covers the canvas rather than replacing it. The canvas
                stays mounted and measured, so the camera and the timeline's
                pan-to-card survive a view switch — they would not across an
                unmount, and the viewport would snap back on every toggle. */}
            {view === 'record' && <SolidIsland key={`record-${currentBoardId}`} component={RecordView} />}
            {view === 'object' && <ObjectView key={`object-${currentBoardId}`} />}
            <CanvasPanel position="top-left">
              <CameraIsland component={Toolbar} />
            </CanvasPanel>
            {/* Shown over board and record: a cluster hides its cards wherever they
                are, and the record reads visibility through the same visibleCards
                the timeline does. The Objects view has no clusters — it shows its own
                Maintenance dropdown in this corner instead. */}
            {view !== 'object' && (
              <CanvasPanel position="top-right">
                <SolidIsland component={ClusterPanel} />
              </CanvasPanel>
            )}
          </div>
          <CameraIsland key={currentBoardId} component={TimelineDrawer} />
        </div>
        <SolidIsland component={CardEditor} />
        {/* All three sit outside the canvas — nested in the pane, its
            wheel/drag handlers would eat scrolling and text selection inside the
            forms — and outside the panels, since position:fixed escapes
            overflow but not stacking, so a backdrop inside a panel's z-index
            would paint against CardEditor incorrectly.
            Mounted only while open, so their local state (a half-typed paste, a
            pending delete confirm) doesn't outlive the dialog. */}
        {emailImportOpen && <CameraIsland component={EmailImportModal} />}
        {propertiesOpen && <SolidIsland component={BoardPropertiesModal} onClose={() => closeDialog('properties')} />}
        {imageEditorCardId && <SolidIsland key={imageEditorCardId} component={ImageEditorModal} cardId={imageEditorCardId} />}
        {bundleExportOpen && <SolidIsland component={BundleExportModal} />}
        {bundleImportBoards && <SolidIsland component={BundleImportModal} boards={bundleImportBoards} />}
        {manageOpen && <SolidIsland component={ManageModal} />}
        <ImportOverlay />
        <SolidIsland component={BackgroundTaskIndicator} />
        <UndoToast />
        <PromptHost />
      </CameraProvider>
    </div>
  );
}
