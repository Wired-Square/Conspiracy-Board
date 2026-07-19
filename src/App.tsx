import { useEffect, useState } from 'react';
import { ReactFlowProvider, Panel } from '@xyflow/react';
import { useBoardStore } from './store/boardStore';
import { useEmailImportStore } from './store/emailImportStore';
import { BoardCanvas } from './components/BoardCanvas';
import { Toolbar } from './components/panels/Toolbar';
import { ClusterPanel } from './components/panels/ClusterPanel';
import { CardEditor } from './components/panels/CardEditor';
import { TimelineDrawer } from './components/timeline/TimelineDrawer';
import { RecordView } from './components/record/RecordView';
import { ObjectView } from './components/maintenance/ObjectView';
import { EmailImportModal } from './components/panels/EmailImportModal';
import { BoardPropertiesModal } from './components/panels/BoardPropertiesModal';
import { ImageEditorModal } from './components/panels/ImageEditorModal';
import { BundleExportModal } from './components/panels/BundleExportModal';
import { BundleImportModal } from './components/panels/BundleImportModal';
import { FirstRunModal } from './components/panels/FirstRunModal';
import { ManageModal } from './components/panels/ManageModal';
import { BusyOverlay } from './components/ui/BusyOverlay';
import { BackgroundTaskIndicator } from './components/ui/BackgroundTaskIndicator';
import { PromptHost } from './components/ui/PromptModal';
import { useMailDrops } from './platform/mailDrops';
import { useInbox } from './platform/inbox';
import { useBoardMenu } from './platform/boardMenu';
import { useImportProgress } from './platform/importProgress';
import { usePropertiesStore } from './store/propertiesStore';
import { useImageEditorStore } from './store/imageEditorStore';
import { useBundleExportStore } from './store/bundleExportStore';
import { useBundleImportStore } from './store/bundleImportStore';
import { useManageStore } from './store/manageStore';

// Subscribes to importStatus on its own, so a per-media progress event re-renders
// this leaf rather than App and the whole canvas beneath it.
function ImportOverlay() {
  const status = useBoardStore((s) => s.importStatus);
  return status ? <BusyOverlay status={status} /> : null;
}

export default function App() {
  const init = useBoardStore((s) => s.init);
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  const emailImportOpen = useEmailImportStore((s) => s.open);
  const propertiesOpen = usePropertiesStore((s) => s.open);
  const imageEditorCardId = useImageEditorStore((s) => s.cardId);
  const bundleExportOpen = useBundleExportStore((s) => s.open);
  const bundleImportOpen = useBundleImportStore((s) => s.open);
  const manageOpen = useManageStore((s) => s.open);
  const view = useBoardStore((s) => s.view);
  const firstRun = useBoardStore((s) => s.firstRun);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void init().then(() => setReady(true));
  }, [init]);

  // Messages the desktop shell fetches out of Mail. Mounted above the canvas so
  // one arriving late still lands if the board is switched mid-fetch.
  useMailDrops();
  // Email files the shell sweeps out of the Inbox drop-folder — how a whole
  // conversation comes in (see src/platform/inbox.ts).
  useInbox();
  // The native File menu (src-tauri/src/menu.rs) drives board management.
  useBoardMenu();
  // Refines the import busy-overlay text as the shell stores a bundle's media.
  useImportProgress();

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
        <FirstRunModal />
        {bundleImportOpen && <BundleImportModal />}
        <ImportOverlay />
      </>
    );
  }

  return (
    <div className="app">
      <ReactFlowProvider>
        {/* The drawer spans the full width now that the editor is a dialog rather
            than a column, and must sit inside the provider (it calls useReactFlow)
            yet outside <ReactFlow>. */}
        <div className="app__main">
          <div className="app__canvas">
            {/* Keyed on the board: React Flow's defaultViewport/fitView are
                initialisation-only, so switching boards without a remount would
                show the new cards under the old camera. The drawer's open state
                is lazily initialised from the board's dates for the same reason. */}
            <BoardCanvas key={currentBoardId} />
            {/* The record covers the canvas rather than replacing it. React Flow
                stays mounted and measured, so the camera and the timeline's
                pan-to-card survive a view switch — they would not across an
                unmount, and the viewport would snap back on every toggle. */}
            {view === 'record' && <RecordView key={currentBoardId} />}
            {view === 'object' && <ObjectView key={currentBoardId} />}
            <Panel position="top-left">
              <Toolbar />
            </Panel>
            {/* Shown over board and record: a cluster hides its cards wherever they
                are, and the record reads visibility through the same useVisibleCards
                the timeline does. The Objects view has no clusters — it shows its own
                Maintenance dropdown in this corner instead. */}
            {view !== 'object' && (
              <Panel position="top-right">
                <ClusterPanel />
              </Panel>
            )}
          </div>
          <TimelineDrawer key={currentBoardId} />
        </div>
        <CardEditor />
        {/* All three sit outside <ReactFlow> — nested in the pane, its
            wheel/drag handlers would eat scrolling and text selection inside the
            forms — and outside the <Panel>, since position:fixed escapes
            overflow but not stacking, so a backdrop inside the Panel's z-index
            would paint against CardEditor incorrectly.
            Mounted only while open, so their local state (a half-typed paste, a
            pending delete confirm) doesn't outlive the dialog. */}
        {emailImportOpen && <EmailImportModal />}
        {propertiesOpen && (
          <BoardPropertiesModal onClose={() => usePropertiesStore.getState().setOpen(false)} />
        )}
        {imageEditorCardId && <ImageEditorModal key={imageEditorCardId} cardId={imageEditorCardId} />}
        {bundleExportOpen && <BundleExportModal />}
        {bundleImportOpen && <BundleImportModal />}
        {manageOpen && <ManageModal />}
        <ImportOverlay />
        <BackgroundTaskIndicator />
        <PromptHost />
      </ReactFlowProvider>
    </div>
  );
}
