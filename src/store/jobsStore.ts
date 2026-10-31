import { createStore } from 'zustand/vanilla';

// How many files the shell's extraction workers have queued or are reading
// (src-tauri/src/jobs.rs), kept current by startJobProgress. 0 when idle.
export const jobsStore = createStore<{ pending: number }>()(() => ({ pending: 0 }));
