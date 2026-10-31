import type { Board } from '../types/board';
import type { BoardSummary } from '../bindings/BoardSummary';
import type { DocHit } from '../bindings/DocHit';
import type { DocStatus } from '../bindings/DocStatus';
import type { EmailParse } from '../bindings/EmailParse';
import type { MediaEntry } from '../bindings/MediaEntry';
import type { MediaMeta } from '../bindings/MediaMeta';
import type { RecoveredEmail } from '../bindings/RecoveredEmail';

export type { BoardSummary, DocHit, DocStatus, MediaEntry, MediaMeta };

/** A native open panel's filter: a label and the extensions it shows. */
export type FileFilter = { name: string; extensions: string[] };

/** A file chosen by the user, as raw bytes. */
export type PickedFile = { name: string; bytes: ArrayBuffer };

/**
 * The parts of a bundle the caller hands the shell to package: each board's id and
 * JSON, the union of media names they reference, the manifest text, and a base
 * filename (no extension). The webview gathers all of this — the shell only zips.
 */
export type BundleExport = {
  boards: { id: string; json: string }[];
  media: string[];
  manifest: string;
  filename: string;
};

/** Read DOM Files into the byte form the adapter and parsers trade in. */
export function toPickedFiles(files: File[]): Promise<PickedFile[]> {
  return Promise.all(
    files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })),
  );
}

/**
 * The IO seam. `tauriStorage` is the only implementation — one SQLite database
 * per board plus the library's, written by the shell (src-tauri/src/board_store.rs).
 *
 * The interface remains because it is what keeps persistence out of the rest of
 * `src/`: the store and the panels ask for boards and are told nothing about
 * where they live. That the boards moved from localStorage to files changed
 * nothing outside this directory, which is the property worth keeping.
 */
export interface StorageAdapter {
  /**
   * Prepare storage: make the library's directories and cache what later reads
   * need. Idempotent, and awaited once at startup before anything else is read —
   * not lazily inside listBoards()/getCurrentBoardId(), where two callers could
   * race it. (Tauri uses it to create the boards/media directories and cache the
   * media path.)
   */
  init(): Promise<void>;

  /** Board summaries for the library, newest first. Never opens a board. */
  listBoards(): Promise<BoardSummary[]>;
  /** The board's content, validated and migrated, or null if it is missing or unreadable. */
  loadBoard(id: string): Promise<Board | null>;
  /** The bundled example board. */
  seedBoard(): Promise<Board>;
  /**
   * Persist a board, with its library summary derived from `board.meta` in the same
   * call, so the list cannot drift from the board. Throws with a user-facing message
   * if storage is full.
   */
  saveBoard(id: string, board: Board): Promise<void>;
  /** Remove a board. Does not touch the current-board pointer; that is policy. */
  deleteBoard(id: string): Promise<void>;

  /** Which board to reopen on load. Persisted, so it lives behind the seam. */
  getCurrentBoardId(): Promise<string | null>;
  setCurrentBoardId(id: string | null): Promise<void>;

  /**
   * Media (pictures, the original .eml, attachments, a document's file) lives as
   * content-addressed files beside the boards, referenced from the JSON by name.
   * The shell owns the filesystem: these hand bytes across and get names back.
   */
  /** Store bytes, named by their content hash; returns the filename to link. */
  saveMedia(bytes: ArrayBuffer, ext: string): Promise<string>;
  /**
   * Download a remote image in the shell and store it, returning the filename to
   * link. The webview cannot fetch it itself — its CSP forbids fetching arbitrary
   * hosts, and a cross-origin image drawn to a canvas to crop would taint it.
   */
  downloadImage(url: string): Promise<string>;
  /** Read a media file's bytes back (used to re-inline pictures on export). */
  readMedia(name: string): Promise<ArrayBuffer>;
  /**
   * Read what metadata a stored file carries — a PDF's or Office file's properties,
   * a photo's dimensions and EXIF. Best-effort in the shell (the parsers have no
   * place in the webview); an unreadable file yields an empty result, not an error.
   */
  extractMediaMeta(name: string): Promise<MediaMeta>;
  /**
   * Recognise the text in a stored image (a text-message screenshot, chiefly), so
   * a picture of a conversation can be carried as searchable words. Best-effort in
   * the shell (macOS Vision, on-device); empty when there is nothing to read or the
   * platform has no OCR.
   */
  ocrImage(name: string): Promise<string>;
  /** Open a media file in the OS default app — Preview for a PDF, and so on. */
  openMedia(name: string): Promise<void>;
  /**
   * Sweep media no board references any more. The shell builds the keep-set from
   * every board's recorded refs and sweeps nothing while any board's are unknown
   * (unrecorded or unreadable). Returns how many files were removed.
   */
  gcMedia(): Promise<number>;
  /** The media every board but `exceptId` references, or null when some board's
   *  refs are unknown — the maintenance audit's "used elsewhere". */
  mediaRefs(exceptId: string | null): Promise<Set<string> | null>;
  /** Every file in the media library — the maintenance view's "see all files" and
   *  the disk side of its integrity checks. Read-only; never deletes. */
  listMedia(): Promise<MediaEntry[]>;
  /** Whether a media file still hashes to its own name (content-address integrity).
   *  On demand — re-hashing a large library eagerly would be too costly. */
  verifyMedia(name: string): Promise<boolean>;
  /** Show the media library folder in the platform's file manager. */
  openMediaDir(): Promise<void>;

  /**
   * The library-wide full-text search index over document bodies (library.sqlite in
   * the shell). A rebuildable projection of the media store — never a source of truth
   * — populated in the background as each file is stored, so a search can find a
   * card by words inside the file it carries, not only the fields typed onto it. Keyed
   * by media name, so extraction is deduped across boards; the webview maps a hit's
   * name back to a card.
   */
  /**
   * Search indexed document bodies. Each hit carries the media name (to map back to a
   * card), a snippet with the match marked, and a rank. An empty query returns nothing.
   */
  searchDocuments(query: string, limit: number): Promise<DocHit[]>;
  /** Read these files into the index again, even if already indexed. */
  reindexMedia(names: string[]): Promise<void>;
  /** Read every media file into the index again. */
  reindexAll(): Promise<void>;
  /** Files the shell's workers have queued or are reading; `jobs:progress` after. */
  jobsPending(): Promise<number>;
  /** Every indexed file's name and status, for the Objects view to badge each file. */
  indexStatuses(): Promise<DocStatus[]>;

  /**
   * Where a board is kept, and how to go and look at it.
   *
   * The one thing about storage this seam is willing to say out loud, and
   * deliberately: the rest of `src/` is told nothing about where boards live,
   * but the *user* is a different question. These are their files, holding their
   * evidence, on their disk. A tool that will not say where it put them is not
   * one to trust with them — all the more so now they live deep in Application
   * Support rather than in Documents, where nobody would find them unprompted.
   *
   * A display string, and only that — nothing in `src/` can read or write
   * through it, which is what keeps this from being a hole in the seam.
   *
   * Always where the board *would* be, whether or not it is there yet: it is
   * decided by the id, not by the file. Whether anything has been written is
   * revealBoard's problem, because it is the only one that cares.
   */
  boardLocation(id: string): Promise<string>;
  /** Show the board's file in the platform's file manager. */
  revealBoard(id: string): Promise<void>;

  /**
   * Build a portable `.zip` bundle of the given boards plus every media file they
   * reference, prompting the user for where to save it. Complete where the old
   * single-file JSON export was lossy — the `.eml`, attachments and a document's file
   * travel too, not only pictures. Resolves `true` once written, `false` if the user
   * cancels the save dialog. See src/data/bundle.ts for the layout.
   */
  exportBundle(input: BundleExport): Promise<boolean>;
  /**
   * Open a picker for a `.zip` bundle or a legacy `.json` board, parse it, and return
   * its boards for the import dialog to offer (a legacy file is just a one-board list).
   * A bundle's media is stored into the library as a side effect (content-addressed,
   * so a re-import is a no-op). Null if cancelled; `[]` if the file held no board.
   *
   * `onReadStart` fires once a file is chosen and reading begins — not while the
   * picker is open — so a caller can show progress only for the work, not the wait.
   */
  importFile(onReadStart?: () => void): Promise<Board[] | null>;
  /**
   * Read user-chosen files as raw bytes; empty if cancelled. Bytes rather than
   * text because email must be decoded with its own declared charset, which is
   * only possible while the original bytes survive.
   */
  pickFiles(accept: string, multiple?: boolean): Promise<PickedFile[]>;
  /** The native open panel, for files the shell then reads itself; empty if cancelled. */
  pickPaths(filter: FileFilter, multiple?: boolean): Promise<string[]>;

  /**
   * Parse picked email files (.eml, mbox, or a .txt that is either) or pasted text into
   * card drafts. The shell keeps each message's .eml, picture and attachments as it
   * parses, so a message previewed but never added leaves orphans for the media sweep.
   * Progress arrives as `email:progress` events.
   */
  parseEmailFiles(paths: string[]): Promise<EmailParse>;
  parseEmailText(text: string): Promise<EmailParse>;
  /** Re-read a kept .eml for its attachments, and its picture unless `keepPicture`. */
  recoverEmailAttachments(eml: string, keepPicture: boolean): Promise<RecoveredEmail | null>;
}
