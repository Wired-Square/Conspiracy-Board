import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Board } from '../types/board';
import type { BoardSummary } from '../bindings/BoardSummary';
import type { DocHit } from '../bindings/DocHit';
import type { DocStatus } from '../bindings/DocStatus';
import type { EmailParse } from '../bindings/EmailParse';
import type { RecoveredEmail } from '../bindings/RecoveredEmail';
import type { GcOutcome } from '../bindings/GcOutcome';
import type { LibraryRefs } from '../bindings/LibraryRefs';
import type { MediaDraft } from '../bindings/MediaDraft';
import type { MediaEntry } from '../bindings/MediaEntry';
import type { MediaMeta } from '../bindings/MediaMeta';
import { bytesToB64 } from '../lib/base64';
import { boardMediaRefs } from '../lib/media';
import { setMediaDir } from './media';
import type { StorageAdapter } from './StorageAdapter';

// Boards as files, under the app's data directory (see src-tauri/src/board_store.rs
// for the layout). The shell owns the schema: it validates and migrates every board
// it reads and every row it is asked to write, and the payload types are generated
// from its own (src/bindings).
//
// Picked files go to the shell by path, through the dialog plugin's open and save
// panels, so their bytes never cross the IPC boundary — a bundle, an email, a
// picture or a document alike.

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

  loadBoard(id) {
    // A corrupt, invalid or locked board reads as "unreadable this time", never a
    // throw: its callers treat a null load as "leave it be", never as a board to
    // delete.
    return invoke<Board | null>('load_board', { id }).catch(() => null);
  },

  seedBoard() {
    return invoke<Board>('seed_board');
  },

  async createBoard(id, board) {
    await invoke('create_board', { id, board });
  },

  deleteBoard(id) {
    return invoke('delete_board', { id });
  },

  getCurrentBoardId() {
    return invoke<string | null>('current_board_id');
  },

  async setCurrentBoardId(id) {
    await invoke('set_current_board_id', { id });
  },

  saveMedia(bytes, { name, mime }) {
    return invoke<string>('save_media', { b64: bytesToB64(bytes), name, mime });
  },

  downloadImage(url) {
    return invoke<string>('download_image', { url });
  },

  extractMediaMeta(name) {
    return invoke<MediaMeta>('extract_media_meta', { name });
  },

  importMediaFiles(paths) {
    return invoke<MediaDraft[]>('import_media_files', { paths });
  },

  mediaCardDraft(name) {
    return invoke<MediaDraft | null>('media_card_draft', { name });
  },

  attachDocument(path) {
    return invoke<MediaDraft>('attach_document', { path });
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

  async pickPaths(filter, multiple = false) {
    const picked = await open({ multiple, filters: filter && [filter] });
    return picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  },

  parseEmailFiles(paths) {
    return invoke<EmailParse>('parse_email_files', { paths });
  },

  parseEmailText(text) {
    return invoke<EmailParse>('parse_email_text', { text });
  },

  recoverEmailAttachments(eml, keepPicture) {
    return invoke<RecoveredEmail | null>('recover_email_attachments', { eml, keepPicture });
  },

};
