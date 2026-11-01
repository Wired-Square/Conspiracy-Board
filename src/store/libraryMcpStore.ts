import { createStore } from '@wired-square/store';
import type { LibraryMcpStatus } from '../bindings/LibraryMcpStatus';

// The library MCP listener as the shell last reported it, kept current by
// startLibraryMcpStatus. null until the first report lands.
export const libraryMcpStore = createStore<{ status: LibraryMcpStatus | null }>(() => ({ status: null }));

export const setLibraryMcpStatus = (status: LibraryMcpStatus) => libraryMcpStore.setState({ status });
