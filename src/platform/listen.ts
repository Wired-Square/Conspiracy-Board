import { listen, type Event } from '@tauri-apps/api/event';

/**
 * Subscribe to a Tauri event; the returned function unsubscribes. Attaching is
 * async, so the unlisten waits for it — an early teardown can't leak the listener.
 */
export function listenTauri<T>(event: string, handler: (e: Event<T>) => void): () => void {
  const attached = listen<T>(event, handler);
  return () => void attached.then((off) => off());
}
