import { Show, createSignal } from 'solid-js';
import { Modal } from '../ui/Modal';
import { errorMessage } from '../../lib/errors';
import { libraryMcp, type LibraryMcpStatus } from '../../platform/libraryMcp';
import { closeDialog } from '../../store/dialogStore';
import { libraryMcpStore, setLibraryMcpStatus } from '../../store/libraryMcpStore';
import { fromStore } from '@wired-square/store/solid';

export function LibraryMcpModal() {
  const status = fromStore(libraryMcpStore, (s) => s.status);
  const enabled = () => status()?.enabled ?? false;
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  // One command at a time: two in flight can land out of order.
  const run = async (command: () => Promise<LibraryMcpStatus>) => {
    setBusy(true);
    setFailure(null);
    try {
      setLibraryMcpStatus(await command());
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (box: HTMLInputElement) => {
    const on = box.checked;
    box.checked = enabled();
    void run(on ? libraryMcp.enable : libraryMcp.disable);
  };

  return (
    <Modal title="Library MCP" onClose={() => closeDialog('libraryMcp')}>
      <p class="hint">Read-only access to this library for an AI client on this Mac.</p>
      <label class="field field--check">
        <input
          class="library-mcp__toggle"
          type="checkbox"
          role="switch"
          checked={enabled()}
          disabled={busy()}
          onChange={(e) => toggle(e.currentTarget)}
        />
        <span>Serve this library over MCP</span>
      </label>
      <Show when={status()?.error}>
        {(error) => (
          <div class="modal__warn library-mcp__warn" role="alert">
            <span>{error()}</span>
            <button disabled={busy()} onClick={() => void run(libraryMcp.enable)}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <Show when={failure()}>
        {(message) => (
          <div class="modal__warn" role="alert">
            {message()}
          </div>
        )}
      </Show>
      <Show when={enabled() && status()}>
        {(s) => (
          <>
            <CopyField label="URL" value={s().url} onError={setFailure} />
            <Show when={s().token}>
              {(token) => <CopyField label="Token" value={token()} onError={setFailure} />}
            </Show>
            <div class="field">
              <div>
                <button disabled={busy()} onClick={() => void run(libraryMcp.rotateToken)}>
                  Rotate token
                </button>
              </div>
              <span class="field__hint">
                The token is kept in your Keychain, so it stays the same across relaunches until you rotate it.
              </span>
            </div>
          </>
        )}
      </Show>
    </Modal>
  );
}

function CopyField(props: { label: string; value: string; onError: (message: string) => void }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () =>
    navigator.clipboard.writeText(props.value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      (err) => props.onError(errorMessage(err)),
    );
  return (
    <div class="field">
      <span>{props.label}</span>
      <div class="library-mcp__value">
        <code>{props.value}</code>
        <button onClick={() => void copy()}>{copied() ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
