import { Show, createSignal, onMount } from 'solid-js';
import { Modal } from './Modal';
import { promptStore, type PromptRequest } from '../../store/promptStore';
import { fromStore } from '../fromStore';

/**
 * Renders the one active prompt/confirm request (see promptStore) on the shared
 * Modal and resolves its promise. Keyed on the request, so each one mounts a fresh
 * dialog with its own input state.
 */
export function PromptHost() {
  const request = fromStore(promptStore, (s) => s.request);
  return (
    <Show when={request()} keyed>
      {(request) => <PromptDialog request={request} />}
    </Show>
  );
}

function PromptDialog(props: { request: PromptRequest }) {
  const request = props.request;
  const [value, setValue] = createSignal(request.kind === 'text' ? (request.initialValue ?? '') : '');

  // Clearing narrows on `kind`, so resolve gets its exact type with no cast.
  const clear = () => promptStore.setState({ request: null });
  const cancel = () => {
    clear();
    if (request.kind === 'text') request.resolve(null);
    else request.resolve(false);
  };
  const submittable = () => request.kind !== 'text' || value().trim().length > 0;
  const submit = () => {
    if (!submittable()) return;
    clear();
    if (request.kind === 'text') request.resolve(value().trim());
    else request.resolve(true);
  };

  return (
    <Modal
      title={request.title}
      onClose={cancel}
      footer={
        <>
          <button class="link-button" onClick={cancel}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button class={request.danger ? 'is-danger' : ''} onClick={submit} disabled={!submittable()}>
            {request.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <Show when={request.message}>
        <p>{request.message}</p>
      </Show>
      {request.kind === 'text' && (
        <label class="field">
          <Show when={request.label}>
            <span>{request.label}</span>
          </Show>
          <input
            // Selects the prefilled text on open, so Rename is type-over and New is ready.
            ref={(el) =>
              onMount(() => {
                el.focus();
                el.select();
              })
            }
            value={value()}
            placeholder={request.placeholder}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
      )}
    </Modal>
  );
}
