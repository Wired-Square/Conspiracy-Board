import { createStore } from '@wired-square/store';

// How many files the shell's extraction workers have queued or are reading
// (src-tauri/src/jobs.rs), kept current by startJobProgress. 0 when idle.
export const jobsStore = createStore<{ pending: number }>(() => ({ pending: 0 }));
