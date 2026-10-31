import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { z } from 'zod';
import type { Board } from '../types/board';
import { safeParseBoardJson } from '../data/schema';
import { invokeChecked } from './ipc';
import {
  docHitSchema,
  docStatusSchema,
  gcOutcomeSchema,
  libraryRefsSchema,
  loadedBoardSchema,
  mediaEntrySchema,
  mediaMetaSchema,
  readBundleSchema,
} from './ipcSchemas';
import {
  byRecency,
  emptyBoardIndex,
  parseBoardIndexJson,
  summarize,
  type BoardIndex,
} from '../data/boardIndex';
import { orderByManifest, parseManifest } from '../data/bundle';
import { bytesToB64, b64ToBytes } from '../lib/base64';
import { boardMediaRefs } from '../lib/media';
import { setMediaDir } from './media';
import { toPickedFiles, type PickedFile, type StorageAdapter } from './StorageAdapter';

// Boards as files, under the app's data directory (see src-tauri/src/board_store.rs
// for the layout and why writes are atomic). The shell only ever sees strings:
// the schema is TypeScript's, and parsing stays on this side of the seam.
//
// The media picker is left to the webview: `<input type="file">` opens the real
// macOS picker. A bundle is the exception both ways — the shell writes and reads it
// by path, so a large `.zip` never crosses the IPC boundary — which is what the
// dialog plugin's open and save panels are for.

/** Whatever the index says, or an empty one — a missing file is just first run. */
async function readIndex(): Promise<BoardIndex> {
  const raw = await invokeChecked('load_index', z.string().nullable());
  return (raw && parseBoardIndexJson(raw)) || emptyBoardIndex();
}

function writeIndex(index: BoardIndex): Promise<void> {
  return invoke('save_index', { json: JSON.stringify(index) });
}

// What the board's .sqlite last held, per board id: each entity's canonical JSON,
// keyed by id. Seeded on load and set to exactly what was written on each save, so a
// save can send only the rows whose JSON changed (the diff) while still handing the
// shell the complete id lists it needs to delete and reorder. Kept from the parsed
// board — the schema's defaults are applied, so an unedited save diffs to nothing.
type EntityBodies = {
  cards: Map<string, string>;
  connections: Map<string, string>;
  clusters: Map<string, string>;
};
const lastSaved = new Map<string, EntityBodies>();

// Serialised JSON per entity, keyed by object identity. The store replaces an
// entity object on every mutation — updateCard, arrangeCards,
// deleteCluster, updateCluster, updateConnection all spread a fresh object —
// so an unchanged reference always means unchanged JSON, and a save only pays
// for stringifying the entities that actually changed since the last one.
// That replace-don't-mutate discipline is load-bearing here: an in-place
// mutation anywhere in the store would serve stale JSON from this cache.
const bodyCache = new WeakMap<object, string>();
const bodyJson = (x: { id: string }): string => {
  let s = bodyCache.get(x);
  if (s === undefined) {
    s = JSON.stringify(x);
    bodyCache.set(x, s);
  }
  return s;
};

const bodyMap = (xs: { id: string }[]): Map<string, string> =>
  new Map(xs.map((x) => [x.id, bodyJson(x)]));

// What the index last recorded for each board, as summary JSON — so a save
// whose summary is unchanged (a viewport-only autosave; updatedAt untouched)
// skips the read-modify-write of index.json entirely.
const lastSummary = new Map<string, string>();

// The shell vouches only for boards whose media refs it has recorded, and names the
// rest. A board saved before refs were recorded is read here, where the card schema
// lives, and its refs recorded once; then the shell is asked again.
async function withRefsRecorded<T extends { unknown: string[] }>(ask: () => Promise<T>): Promise<T> {
  const first = await ask();
  if (!first.unknown.length) return first;
  await Promise.all(
    first.unknown.map(async (id) => {
      const board = await tauriStorage.loadBoard(id);
      if (board) await invoke('record_media_refs', { id, refs: boardMediaRefs(board) });
    }),
  );
  return ask();
}

const boardBodies = (board: Board): EntityBodies => ({
  cards: bodyMap(board.cards),
  connections: bodyMap(board.connections),
  clusters: bodyMap(board.clusters),
});

export const tauriStorage: StorageAdapter = {
  async init() {
    // Bring the library up: create its directories, then cache the media directory
    // so mediaSrc can resolve names synchronously at render time. Done here once,
    // before anything is read — not lazily inside a read, where two callers could
    // race it.
    await invoke('init_storage');
    setMediaDir(await invokeChecked('media_dir_path', z.string()));
  },

  async listBoards() {
    return byRecency((await readIndex()).entries);
  },

  async loadBoard(id) {
    // A corrupt or locked database reads as "unreadable this time", never a throw:
    // the load paths (loadBoardForOpen, withRefsRecorded) treat a null load as
    // "leave it be", never as a board to delete.
    const res = await invokeChecked('load_board', loadedBoardSchema, { id }).catch(() => null);
    if (!res?.json) return null;
    const board = safeParseBoardJson(res.json);
    if (!board) return null;
    if (res.legacy) {
      // First open of a pre-SQLite board: write its .sqlite through the normal save
      // path, then drop the old boards/<id>.json — only once the shell confirms the
      // database reassembles. The empty cache makes that first save write every row.
      lastSaved.delete(id);
      await this.saveBoard(id, board);
      await invoke('retire_legacy_board', { id }).catch(() => {});
    } else {
      lastSaved.set(id, boardBodies(board));
    }
    return board;
  },

  async saveBoard(id, board) {
    const prev = lastSaved.get(id);
    // Serialise each entity once: this map is both the diff input and the next save's
    // cache, so nothing is stringified twice on the autosave hot path. Only the rows
    // whose JSON changed are sent as bodies; the `*Ids` lists are always complete, so
    // the shell deletes and reorders from them regardless. A drifted cache can at worst
    // cost a redundant or a missed body upsert — never a wrong delete — and it is
    // rebuilt from ground truth on every load. On a migrating save `prev` is absent, so
    // every row is sent (a full write), which materialises a board's first .sqlite.
    const next = boardBodies(board);
    const changed = (now: Map<string, string>, was: Map<string, string> | undefined) =>
      [...now].filter(([k, json]) => was?.get(k) !== json).map(([k, json]) => ({ id: k, json }));
    await invoke('save_board', {
      id,
      payload: {
        version: board.version,
        meta: JSON.stringify(board.meta),
        viewport: board.viewport ? JSON.stringify(board.viewport) : null,
        cards: changed(next.cards, prev?.cards),
        cardIds: board.cards.map((c) => c.id),
        connections: changed(next.connections, prev?.connections),
        connectionIds: board.connections.map((c) => c.id),
        clusters: changed(next.clusters, prev?.clusters),
        clusterIds: board.clusters.map((c) => c.id),
        mediaRefs: boardMediaRefs(board),
      },
    });
    // Only after the write lands, so a failed save leaves the cache stale and the next
    // save re-sends rather than assuming the shell has what it does not.
    lastSaved.set(id, next);

    // Derived from the board we just wrote, never from a caller — so the index
    // cannot claim something the board does not say. Skipped when this board's
    // summary already reads exactly the same, which is every viewport-only save.
    const summary = summarize(id, board);
    const summaryJson = JSON.stringify(summary);
    if (lastSummary.get(id) === summaryJson) return;
    const index = await readIndex();
    const entries = index.entries.some((e) => e.id === id)
      ? index.entries.map((e) => (e.id === id ? summary : e))
      : [...index.entries, summary];
    await writeIndex({ ...index, entries });
    lastSummary.set(id, summaryJson);
  },

  async deleteBoard(id) {
    // The board first: an index still naming a deleted board would list a board
    // that opens as null, where an unlisted file is merely invisible.
    await invoke('delete_board', { id });
    lastSaved.delete(id);
    lastSummary.delete(id);
    const index = await readIndex();
    await writeIndex({ ...index, entries: index.entries.filter((e) => e.id !== id) });
  },

  async getCurrentBoardId() {
    return (await readIndex()).currentId;
  },

  async setCurrentBoardId(id) {
    await writeIndex({ ...(await readIndex()), currentId: id });
  },

  saveMedia(bytes, ext) {
    return invokeChecked('save_media', z.string(), { ext, b64: bytesToB64(bytes) });
  },

  downloadImage(url) {
    return invokeChecked('download_image', z.string(), { url });
  },

  async readMedia(name) {
    return b64ToBytes(await invokeChecked('read_media', z.string(), { name }));
  },

  extractMediaMeta(name) {
    return invokeChecked('extract_media_meta', mediaMetaSchema, { name });
  },

  ocrImage(name) {
    return invokeChecked('ocr_image', z.string(), { name });
  },

  openMedia(name) {
    return invoke('open_media', { name });
  },

  async gcMedia() {
    return (await withRefsRecorded(() => invokeChecked('gc_media', gcOutcomeSchema))).removed;
  },

  async mediaRefs(exceptId) {
    const refs = await withRefsRecorded(() =>
      invokeChecked('media_refs', libraryRefsSchema, { except: exceptId }),
    );
    return refs.unknown.length ? null : new Set(refs.names);
  },

  listMedia() {
    return invokeChecked('list_media', z.array(mediaEntrySchema));
  },

  verifyMedia(name) {
    return invokeChecked('verify_media', z.boolean(), { name });
  },

  openMediaDir() {
    return invoke('open_media_dir');
  },

  processMedia(name, force) {
    return invokeChecked('process_media', docStatusSchema, { name, force });
  },

  searchDocuments(query, limit) {
    return invokeChecked('search_documents', z.array(docHitSchema), { query, limit });
  },

  pendingMedia() {
    return invokeChecked('pending_media', z.array(z.string()));
  },

  rebuildIndex() {
    return invoke('rebuild_index');
  },

  indexStatuses() {
    return invokeChecked('index_statuses', z.array(docStatusSchema));
  },

  async boardLocation(id) {
    // The shell builds the path — it is the only thing that knows the data
    // directory, and it validates the id before letting it near the filesystem.
    return invokeChecked('board_location', z.string(), { id });
  },

  async revealBoard(id) {
    await invoke('reveal_board', { id });
  },

  async exportBundle({ boards, media, manifest, filename }) {
    // Ask the user where to put it — the one thing the webview can't do itself, so
    // the one plugin we take. Then the shell writes the `.zip` straight to that
    // path, so a large bundle never crosses the IPC boundary. False on cancel.
    const path = await save({
      defaultPath: `${filename}.zip`,
      filters: [{ name: 'Conspiracy bundle', extensions: ['zip'] }],
    });
    if (!path) return false;
    await invoke('write_bundle', { path, boards, media, manifest });
    return true;
  },

  async importFile(onReadStart) {
    const path = await open({
      filters: [{ name: 'Conspiracy bundle or board', extensions: ['zip', 'json'] }],
    });
    if (!path) return null;
    onReadStart?.();
    // The shell reads the file, stores a bundle's media, and hands the board strings
    // back to parse here — the schema stays this side of the seam. A legacy .json
    // arrives as a one-board bundle, so both take the same path.
    const res = await invokeChecked('read_bundle', readBundleSchema, { path });
    const parsed = res.boards
      .map((b) => ({ id: b.id, board: safeParseBoardJson(b.json) }))
      .filter((b): b is { id: string; board: Board } => b.board !== null);
    const manifest = res.manifest ? parseManifest(res.manifest) : null;
    return orderByManifest(parsed, manifest).map((b) => b.board);
  },

  pickFiles(accept, multiple = false) {
    return new Promise<PickedFile[]>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.onchange = async () => {
        resolve(await toPickedFiles(Array.from(input.files ?? [])));
      };
      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  },
};
