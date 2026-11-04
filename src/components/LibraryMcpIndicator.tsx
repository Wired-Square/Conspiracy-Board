import { Show } from 'solid-js';
import { Button } from '@wired-square/kit';
import { openDialog } from '../store/dialogStore';
import { libraryMcpStore } from '../store/libraryMcpStore';
import { fromStore } from '@wired-square/store/solid';

export function LibraryMcpIndicator() {
  const status = fromStore(libraryMcpStore, (s) => s.status);
  return (
    <Show when={status()?.enabled && status()}>
      {(s) => {
        const writes = () => [s().allowAdd && 'add', s().allowEdit && 'edit'].filter(Boolean).join(' and ');
        const serving = () => `Serving this library at ${s().url}` + (writes() ? `; a client may ${writes()}` : '');
        return (
          <Button
            class="mcp-indicator"
            classList={{ 'is-error': !s().running, 'is-writable': !!writes() }}
            title={s().running ? serving() : (s().error ?? 'Not running')}
            onClick={() => openDialog({ libraryMcp: true })}
          >
            <span class="mcp-indicator__dot" aria-hidden="true" />
            {s().running ? (writes() ? 'MCP on · writes' : 'MCP on') : 'MCP stopped'}
          </Button>
        );
      }}
    </Show>
  );
}
