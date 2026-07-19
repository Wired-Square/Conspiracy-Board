/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' keeps the static build path-relative so a future Tauri wrapper can
// load it from the filesystem without rework.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist' },
  // Tauri spawns this dev server and points the webview at a fixed URL, so the
  // port cannot float: strictPort makes a clash fail loudly rather than serve
  // the app somewhere the window will never look. clearScreen keeps Vite from
  // wiping the Rust build output the two share a terminal with.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Only the pure logic is unit-tested (dates, mbox splitting, schema
  // migration) — no DOM needed, so no jsdom.
  // css: the stylesheet is stubbed to '' by default, which would quietly empty
  // the `?raw` import grades.test.ts reads --string out of. Processing it costs
  // one file: nothing else in the suite imports CSS.
  test: { environment: 'node', include: ['src/**/*.test.ts'], css: true },
});
