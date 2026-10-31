import type { Board } from '../types/board';
import type { BundleManifest } from '../bindings/BundleManifest';

// The manifest that names a bundle a bundle: `format`/`formatVersion` are the
// signature that lets import recognise one, and `boards` the order and an advisory
// title. The shell reads it back on import (src-tauri/src/board_store/bundle.rs).

const BUNDLE_FORMAT = 'conspiracy-bundle';
const BUNDLE_FORMAT_VERSION = 1;

/** The manifest for a set of boards about to be bundled. */
export function buildManifest(boards: { id: string; board: Board }[]): BundleManifest {
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    app: 'Conspiracy',
    exportedAt: new Date().toISOString(),
    boards: boards.map(({ id, board }) => ({
      id,
      title: board.meta.title,
      file: `boards/${id}.json`,
    })),
  };
}
