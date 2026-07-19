import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { usePromptStore, type PromptRequest } from '../../store/promptStore';

/**
 * Renders the one active prompt/confirm request (see promptStore) on the shared
 * Modal and resolves its promise. Mounted once, near the app root; returns null
 * when nothing is being asked, so each request mounts a fresh dialog with its own
 * input state.
 */
export function PromptHost() {
  const request = usePromptStore((s) => s.request);
  const token = usePromptStore((s) => s.token);
  return request ? <PromptDialog key={token} request={request} /> : null;
}

function PromptDialog({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.kind === 'text' ? request.initialValue ?? '' : '');
  const [showDetails, setShowDetails] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the prefilled text on open, so Rename is type-over and New is ready.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // Clearing narrows on `kind`, so resolve gets its exact type with no cast.
  const clear = () => usePromptStore.setState({ request: null });
  const cancel = () => {
    clear();
    if (request.kind === 'text') request.resolve(null);
    else if (request.kind === 'confirm') request.resolve(false);
    else request.resolve();
  };
  const submittable = request.kind !== 'text' || value.trim().length > 0;
  const submit = () => {
    if (!submittable) return;
    clear();
    if (request.kind === 'text') request.resolve(value.trim());
    else if (request.kind === 'confirm') request.resolve(true);
    else request.resolve();
  };

  return (
    <Modal
      title={request.title}
      onClose={cancel}
      footer={
        <>
          {request.details && (
            <button
              className="link-button modal__details-toggle"
              onClick={() => setShowDetails((s) => !s)}
            >
              {showDetails ? 'Hide details' : 'Details'}
            </button>
          )}
          {request.kind !== 'alert' && (
            <button className="link-button" onClick={cancel}>
              {request.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button className={request.danger ? 'is-danger' : ''} onClick={submit} disabled={!submittable}>
            {request.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {request.message && <p>{request.message}</p>}
      {request.details && showDetails && <pre className="modal__details">{request.details}</pre>}
      {request.kind === 'text' && (
        <label className="field">
          {request.label && <span>{request.label}</span>}
          <input
            ref={inputRef}
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
      )}
    </Modal>
  );
}
