import { Modal } from '../ui/Modal';
import { useBoardStore } from '../../store/boardStore';
import { useManageStore } from '../../store/manageStore';
import { storage } from '../../storage';
import { prompt, confirm } from '../../store/promptStore';

// Managing the open board — rename it, reveal its file, or delete it — gathered
// into one dialog rather than three separate File-menu items. The rename and
// delete actions borrow the reusable prompt/confirm the native menu used to, so a
// native menu that can't host a text field still isn't the one asking.
export function ManageModal() {
  const title = useBoardStore((s) => s.meta.title);
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  const setTitle = useBoardStore((s) => s.setTitle);
  const deleteBoard = useBoardStore((s) => s.deleteBoard);
  const setError = useBoardStore((s) => s.setError);
  const close = () => useManageStore.getState().setOpen(false);

  const rename = async () => {
    const name = await prompt({
      title: 'Rename board',
      label: 'Name',
      initialValue: title,
      confirmLabel: 'Rename',
    });
    if (name) setTitle(name);
  };

  const reveal = async () => {
    if (!currentBoardId) return;
    try {
      await storage.revealBoard(currentBoardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (!currentBoardId) return;
    const ok = await confirm({
      title: 'Delete board',
      message: `Delete “${title || 'Untitled board'}”? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    // The board it named is gone; close rather than leave the dialog on whatever
    // board the app landed on next.
    if (ok) {
      await deleteBoard(currentBoardId);
      close();
    }
  };

  return (
    <Modal
      title="Manage board"
      onClose={close}
      footer={
        <button className="is-danger" onClick={() => void remove()}>
          Delete board…
        </button>
      }
    >
      <div className="field">
        <span>Board</span>
        <p className="manage__name">{title || 'Untitled board'}</p>
      </div>
      <div className="manage__actions">
        <button onClick={() => void rename()}>Rename…</button>
        <button onClick={() => void reveal()}>Show in Finder</button>
      </div>
    </Modal>
  );
}
