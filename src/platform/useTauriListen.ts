import { listen, type Event } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';

/**
 * Subscribe to a Tauri event for the component's lifetime. The handler is held in
 * a ref, so it may close over changing values and the subscription still attaches
 * exactly once — no teardown/re-attach on every render. The single home for the
 * "attaching is async, so unmounting can beat it" cleanup race.
 */
export function useTauriListen<T>(event: string, handler: (e: Event<T>) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const attached = listen<T>(event, (e) => ref.current(e));
    return () => void attached.then((off) => off());
  }, [event]);
}
