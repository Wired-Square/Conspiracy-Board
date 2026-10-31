import { createStore } from 'zustand/vanilla';

// A reusable "ask the user for something" dialog, promise-based so any caller —
// including the native menu handler, which lives outside the UI — can `await
// prompt(...)` / `await confirm(...)` and act on the answer. One request at a
// time; <PromptHost> renders it on the shared Modal and resolves the promise.

type Common = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (Delete). */
  danger?: boolean;
};

export type TextRequest = Common & {
  kind: 'text';
  label?: string;
  placeholder?: string;
  initialValue?: string;
  resolve: (value: string | null) => void;
};

export type ConfirmRequest = Common & {
  kind: 'confirm';
  resolve: (ok: boolean) => void;
};

export type PromptRequest = TextRequest | ConfirmRequest;

export const promptStore = createStore<{ request: PromptRequest | null }>()(() => ({ request: null }));

/** Show a request, cancel-resolving any it displaces so no awaiter is left hung. */
function show(request: PromptRequest) {
  const prev = promptStore.getState().request;
  if (prev) {
    if (prev.kind === 'text') prev.resolve(null);
    else prev.resolve(false);
  }
  promptStore.setState({ request });
}

/** Ask for a line of text. Resolves the entered string, or null if cancelled. */
export function prompt(opts: Omit<TextRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => show({ ...opts, kind: 'text', resolve }));
}

/** Ask a yes/no. Resolves true only if confirmed. */
export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => show({ ...opts, kind: 'confirm', resolve }));
}
