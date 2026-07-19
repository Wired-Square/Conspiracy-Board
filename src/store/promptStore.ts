import { create } from 'zustand';

// A reusable "ask the user for something" dialog, promise-based so any caller —
// including the native menu handler, which lives outside React — can `await
// prompt(...)` / `await confirm(...)` and act on the answer. One request at a
// time; <PromptHost> renders it on the shared Modal and resolves the promise.

type Common = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (Delete). */
  danger?: boolean;
  /** Extra context behind a "Details" toggle — kept out of the way until asked
   *  for, so the message stays short but the specifics are one click away. */
  details?: string;
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

// One button, no choice to make — telling the user something and waiting for the
// nod. Used where a transient banner is too easy to miss and the drop it explains
// is worth a sentence of context.
export type AlertRequest = Common & {
  kind: 'alert';
  resolve: () => void;
};

export type PromptRequest = TextRequest | ConfirmRequest | AlertRequest;

// token bumps per request so <PromptHost> remounts the dialog even on a direct
// request→request swap, giving it fresh input state and re-running its focus.
export const usePromptStore = create<{ request: PromptRequest | null; token: number }>(() => ({
  request: null,
  token: 0,
}));

/** Show a request, cancel-resolving any it displaces so no awaiter is left hung. */
function show(request: PromptRequest) {
  const prev = usePromptStore.getState().request;
  if (prev) {
    if (prev.kind === 'text') prev.resolve(null);
    else if (prev.kind === 'confirm') prev.resolve(false);
    else prev.resolve();
  }
  usePromptStore.setState((s) => ({ request, token: s.token + 1 }));
}

/** Ask for a line of text. Resolves the entered string, or null if cancelled. */
export function prompt(opts: Omit<TextRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => show({ ...opts, kind: 'text', resolve }));
}

/** Ask a yes/no. Resolves true only if confirmed. */
export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => show({ ...opts, kind: 'confirm', resolve }));
}

/** Tell the user something and wait for the acknowledgement. */
export function alert(opts: Omit<AlertRequest, 'kind' | 'resolve'>): Promise<void> {
  return new Promise((resolve) => show({ ...opts, kind: 'alert', resolve }));
}
