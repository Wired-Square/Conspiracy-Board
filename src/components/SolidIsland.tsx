/** @jsxImportSource react */
import { useEffect, useRef } from 'react';
import { createComponent, createSignal, mergeProps, type Component } from 'solid-js';
import { render } from 'solid-js/web';

type IslandProps<P extends object> = { component: Component<P> } & P;

// Hosts a Solid component inside the React tree while the port is under way.
// React props reach it through a signal, so a re-render updates the Solid tree in place.
export function SolidIsland<P extends object>({ component, ...rest }: IslandProps<P>) {
  const props = rest as unknown as P;
  const host = useRef<HTMLDivElement>(null);
  const setProps = useRef<(props: P) => void>(undefined);

  useEffect(() => {
    const [current, set] = createSignal(props);
    setProps.current = (next) => set(() => next);
    const dispose = render(() => createComponent(component, mergeProps(current) as P), host.current!);
    return () => {
      setProps.current = undefined;
      dispose();
    };
  }, [component]);

  useEffect(() => {
    setProps.current?.(props);
  });

  return <div ref={host} style={{ display: 'contents' }} />;
}
