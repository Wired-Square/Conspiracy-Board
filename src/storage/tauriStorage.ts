import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Board } from '../types/board';
import type { BoardSummary } from '../bindings/BoardSummary';
import type { DocHit } from '../bindings/DocHit';
import type { DocStatus } from '../bindings/DocStatus';
import type { GcOutcome } from '../bindings/GcOutcome';
import type { LibraryRefs } from '../bindings/LibraryRefs';
import type { LoadedBoard } from '../bindings/LoadedBoard';
import type { MediaEntry } from '../bindings/MediaEntry';
import type { MediaMeta } from '../bindings/MediaMeta';
import type { SaveBoardPayload } from '../bindings/SaveBoardPayload';
import { bytesToB64, b64ToBytes } from '../lib/base64';
import { boardMediaRefs } from '../lib/media';
import { setMediaDir } from './media';
import { toPickedFiles, type PickedFile, type StorageAdapter } from './StorageAdapter';

// Boards as files, under the app's data directory (see src-tauri/src/board_store.rs
// for the layout). The shell owns the schema: it validates and migrates every board
// it reads and every row it is asked to write, and the payload types are generated
// from its own (src/bindings).
//
// The media picker is left to the webview: `<input type="file">` opens the real
// macOS picker. A bundle is the exception both ways — the shell writes and reads it
// by path, so a large `.zip` never crosses the IPC boundary — which is what the
// dialog plugin's open and save panels are for.

// What the board's .sqlite last held, per board id: each entity's JSON, keyed by id.
// Seeded on load and set to exactly what was written on each save, so a save can send
// only the rows whose JSON changed (the diff) while still handing the shell the
// complete id lists it needs to delete and reorder.
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

// The shell vouches only for boards whose media refs it has recorded, and names the
// rest. A board saved before refs were recorded is read here, where the media refs are
// derived (lib/media.ts), and its refs recorded once; then the shell is asked again.
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
    setMediaDir(await invoke<string>('media_dir_path'));
  },

  listBoards() {
    return invoke<BoardSummary[]>('list_boards');
  },

  async loadBoard(id) {
    // A corrupt, invalid or locked board reads as "unreadable this time", never a
    // throw: the load paths (loadBoardForOpen, withRefsRecorded) treat a null load as
    // "leave it be", never as a board to delete.
    const res = await invoke<LoadedBoard>('load_board', { id }).catch(() => null);
    const board = res?.board;
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

  seedBoard() {
    return invoke<Board>('seed_board');
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
    const payload: SaveBoardPayload = {
      version: board.version,
      meta: board.meta,
      viewport: board.viewport ?? null,
      cards: changed(next.cards, prev?.cards),
      cardIds: board.cards.map((c) => c.id),
      connections: changed(next.connections, prev?.connections),
      connectionIds: board.connections.map((c) => c.id),
      clusters: changed(next.clusters, prev?.clusters),
      clusterIds: board.clusters.map((c) => c.id),
      mediaRefs: boardMediaRefs(board),
    };
    await invoke('save_board', { id, payload });
    // Only after the write lands, so a failed save leaves the cache stale and the next
    // save re-sends rather than assuming the shell has what it does not.
    lastSaved.set(id, next);
  },

  async deleteBoard(id) {
    await invoke('delete_board', { id });
    lastSaved.delete(id);
  },

  getCurrentBoardId() {
    return invoke<string | null>('current_board_id');
  },

  async setCurrentBoardId(id) {
    await invoke('set_current_board_id', { id });
  },

  saveMedia(bytes, ext) {
    return invoke<string>('save_media', { ext, b64: bytesToB64(bytes) });
  },

  downloadImage(url) {
    return invoke<string>('download_image', { url });
  },

  async readMedia(name) {
    return b64ToBytes(await invoke<string>('read_media', { name }));
  },

  extractMediaMeta(name) {
    return invoke<MediaMeta>('extract_media_meta', { name });
  },

  ocrImage(name) {
    return invoke<string>('ocr_image', { name });
  },

  openMedia(name) {
    return invoke('open_media', { name });
  },

  async gcMedia() {
    return (await withRefsRecorded(() => invoke<GcOutcome>('gc_media'))).removed;
  },

  async mediaRefs(exceptId) {
    const refs = await withRefsRecorded(() => invoke<LibraryRefs>('media_refs', { except: exceptId }));
    return refs.unknown.length ? null : new Set(refs.names);
  },

  listMedia() {
    return invoke<MediaEntry[]>('list_media');
  },

  verifyMedia(name) {
    return invoke<boolean>('verify_media', { name });
  },

  openMediaDir() {
    return invoke('open_media_dir');
  },

  searchDocuments(query, limit) {
    return invoke<DocHit[]>('search_documents', { query, limit });
  },

  async reindexMedia(names) {
    await invoke('reindex_media', { names });
  },

  async reindexAll() {
    await invoke('reindex_all');
  },

  jobsPending() {
    return invoke<number>('jobs_pending');
  },

  indexStatuses() {
    return invoke<DocStatus[]>('index_statuses');
  },

  async boardLocation(id) {
    // The shell builds the path — it is the only thing that knows the data
    // directory, and it validates the id before letting it near the filesystem.
    return invoke<string>('board_location', { id });
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
    // The shell reads the file, stores a bundle's media, and hands back the boards
    // that parse, in the manifest's order. A legacy .json arrives as a one-board bundle.
    return invoke<Board[]>('read_bundle', { path });
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
