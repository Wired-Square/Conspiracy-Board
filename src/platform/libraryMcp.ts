import { invoke } from '@tauri-apps/api/core';
import type { LibraryMcpStatus } from '../bindings/LibraryMcpStatus';
import { listenTauri } from './listen';

export type { LibraryMcpStatus };

/** The library MCP server the shell runs on loopback (src-tauri/src/library_mcp/lifecycle.rs). */
export const libraryMcp = {
  status: () => invoke<LibraryMcpStatus>('library_mcp_status'),
  enable: () => invoke<LibraryMcpStatus>('enable_library_mcp'),
  disable: () => invoke<LibraryMcpStatus>('disable_library_mcp'),
  rotateToken: () => invoke<LibraryMcpStatus>('rotate_library_mcp_token'),
  allowAdd: (on: boolean) => invoke<LibraryMcpStatus>('allow_library_mcp_add', { on }),
  allowEdit: (on: boolean) => invoke<LibraryMcpStatus>('allow_library_mcp_edit', { on }),
  /** Every change, including the start at launch; the returned function unsubscribes. */
  listen: (handler: (status: LibraryMcpStatus) => void) =>
    listenTauri<LibraryMcpStatus>('library-mcp:changed', (e) => handler(e.payload)),
};
