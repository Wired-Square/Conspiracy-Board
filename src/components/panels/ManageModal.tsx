import { Modal } from '../ui/Modal';
import { closeDialog } from '../../store/dialogStore';
import { storage } from '../../storage';
import { prompt, confirm } from '../../store/promptStore';
import { errorMessage } from '../../lib/errors';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '../fromStore';

// Managing the open board — rename it, reveal its file, or delete it — gathered
// into one dialog rather than three separate File-menu items. The rename and
// delete actions borrow the reusable prompt/confirm the native menu used to, so a
// native menu that can't host a text field still isn't the one asking.
export function ManageModal() {
  const title = fromStore(boardStore, (s) => s.meta.title);
  const currentBoardId = fromStore(boardStore, (s) => s.currentBoardId);
  const { setTitle, deleteBoard, setError } = boardStore.getState();
  const close = () => closeDialog('manage');

  const rename = async () => {
    const name = await prompt({
      title: 'Rename board',
      label: 'Name',
      initialValue: title(),
      confirmLabel: 'Rename',
    });
    if (name) setTitle(name);
  };

  const reveal = async () => {
    const id = currentBoardId();
    if (!id) return;
    try {
      await storage.revealBoard(id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async () => {
    const id = currentBoardId();
    if (!id) return;
    const ok = await confirm({
      title: 'Delete board',
      message: `Delete “${title() || 'Untitled board'}”? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    // The board it named is gone; close rather than leave the dialog on whatever
    // board the app landed on next.
    if (ok) {
      await deleteBoard(id);
      close();
    }
  };

  return (
    <Modal
      title="Manage board"
      onClose={close}
      footer={
        <button class="is-danger" onClick={() => void remove()}>
          Delete board…
        </button>
      }
    >
      <div class="field">
        <span>Board</span>
        <p class="manage__name">{title() || 'Untitled board'}</p>
      </div>
      <div class="manage__actions">
        <button onClick={() => void rename()}>Rename…</button>
        <button onClick={() => void reveal()}>Show in Finder</button>
      </div>
    </Modal>
  );
}
