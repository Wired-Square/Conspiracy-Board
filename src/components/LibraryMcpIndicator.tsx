import { Show } from 'solid-js';
import { openDialog } from '../store/dialogStore';
import { libraryMcpStore } from '../store/libraryMcpStore';
import { fromStore } from '@wired-square/store/solid';

export function LibraryMcpIndicator() {
  const status = fromStore(libraryMcpStore, (s) => s.status);
  return (
    <Show when={status()?.enabled && status()}>
      {(s) => (
        <button
          class="mcp-indicator"
          classList={{ 'is-error': !s().running }}
          title={s().running ? `Serving this library at ${s().url}` : (s().error ?? 'Not running')}
          onClick={() => openDialog({ libraryMcp: true })}
        >
          <span class="mcp-indicator__dot" aria-hidden="true" />
          {s().running ? 'MCP on' : 'MCP stopped'}
        </button>
      )}
    </Show>
  );
}
