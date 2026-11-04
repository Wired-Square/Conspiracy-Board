import { Show, createSignal } from 'solid-js';
import { Button, Dialog, DialogActions, Notice } from '@wired-square/kit';
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
  const close = () => closeDialog('libraryMcp');

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

  return (
    <Dialog title="Library MCP" onClose={close}>
      <p class="hint">
        Access to this library for an AI client on this Mac. It can always read; it adds and edits only if you
        allow it, and it can never delete.
      </p>
      <SwitchField
        class="library-mcp__toggle"
        label="Serve this library over MCP"
        checked={enabled()}
        disabled={busy()}
        onFlip={(on) => void run(on ? libraryMcp.enable : libraryMcp.disable)}
      />
      <SwitchField
        class="library-mcp__add"
        label="Allow adding: import files, and create cards, connections, clusters and boards"
        checked={status()?.allowAdd ?? false}
        disabled={busy()}
        onFlip={(on) => void run(() => libraryMcp.allowAdd(on))}
      />
      <SwitchField
        class="library-mcp__edit"
        label="Allow editing: change cards, connections, clusters and board titles"
        checked={status()?.allowEdit ?? false}
        disabled={busy()}
        onFlip={(on) => void run(() => libraryMcp.allowEdit(on))}
      />
      <p class="hint">An edit to the open board can be undone like your own.</p>
      <Show when={status()?.error}>
        {(error) => (
          <Notice tone="bad" class="library-mcp__warn">
            <span>{error()}</span>
            <Button disabled={busy()} onClick={() => void run(libraryMcp.enable)}>
              Retry
            </Button>
          </Notice>
        )}
      </Show>
      <Notice tone="bad">{failure()}</Notice>
      <Show when={enabled() && status()}>
        {(s) => (
          <>
            <CopyField label="URL" value={s().url} onError={setFailure} />
            <Show when={s().token}>
              {(token) => <CopyField label="Token" value={token()} onError={setFailure} />}
            </Show>
            <div class="field">
              <div>
                <Button disabled={busy()} onClick={() => void run(libraryMcp.rotateToken)}>
                  Rotate token
                </Button>
              </div>
              <span class="field__hint">
                The token is kept in your Keychain, so it stays the same across relaunches until you rotate it.
              </span>
            </div>
          </>
        )}
      </Show>
      <DialogActions onCancel={close} />
    </Dialog>
  );
}

/** Shows the shell's answer, never the click: the box springs back until the status lands. */
function SwitchField(props: { class: string; label: string; checked: boolean; disabled: boolean; onFlip: (on: boolean) => void }) {
  const flip = (box: HTMLInputElement) => {
    const on = box.checked;
    box.checked = props.checked;
    props.onFlip(on);
  };
  return (
    <label class="field field--check">
      <input
        class={`app-switch ${props.class}`}
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => flip(e.currentTarget)}
      />
      <span>{props.label}</span>
    </label>
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
        <Button onClick={() => void copy()}>{copied() ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}
