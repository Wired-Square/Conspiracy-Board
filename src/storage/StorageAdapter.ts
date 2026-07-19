import type { Board } from '../types/board';
import type { BoardSummary } from '../data/boardIndex';

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

/** One media file on disk, as the maintenance view lists it. */
export type MediaEntry = { name: string; size: number };

/**
 * A full-text search hit from the library index: the media file that matched (its
 * content-addressed name, which the webview maps back to a card), a snippet with the
 * match marked, and its BM25 rank — smaller is a better match.
 */
export type DocHit = { name: string; snippet: string; rank: number };

/**
 * A media file's place in the search index: its name and terminal processing status —
 * `indexed`, `failed`, or `unsupported`. A file with no row yet is simply pending.
 */
export type DocStatus = { name: string; status: string };

/**
 * Metadata read out of an imported file by the shell (`extract_media_meta`). Every
 * field is optional — a format that doesn't carry one, or a file that wouldn't
 * parse, just omits it. Document fields (title…words) and image fields (width…
 * longitude) share the one shape; the caller takes whichever its kind uses. Dates
 * are ISO-8601 UTC, ready for a card's `occurredAt`.
 */
export type MediaMeta = {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
  pages?: number;
  words?: number;
  width?: number;
  height?: number;
  takenAt?: string;
  cameraMake?: string;
  cameraModel?: string;
  latitude?: number;
  longitude?: number;
};

/** Read DOM Files into the byte form the adapter and parsers trade in. */
export function toPickedFiles(files: File[]): Promise<PickedFile[]> {
  return Promise.all(
    files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })),
  );
}

/**
 * The IO seam. `tauriStorage` is the only implementation — one JSON file per
 * board plus an index, written by the shell (src-tauri/src/board_store.rs).
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

  /** Board summaries for the library. Never parses board bodies. */
  listBoards(): Promise<BoardSummary[]>;
  /** The board's content, or null if it is missing or unreadable. */
  loadBoard(id: string): Promise<Board | null>;
  /**
   * Persist a board and derive its index entry from `board.meta`. The summary is
   * never supplied by the caller, so the index cannot drift from the board.
   * Throws with a user-facing message if storage is full.
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
   * Download a remote image in the shell, returning its bytes and declared media
   * type. The webview cannot do this itself — its CSP forbids fetching arbitrary
   * hosts, and a cross-origin image drawn to a canvas to crop would taint it — so
   * a pasted URL is fetched here and then stored like any other media.
   */
  fetchImage(url: string): Promise<{ bytes: ArrayBuffer; mime?: string }>;
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
   * Sweep media no board references any more. `keep` must be the *complete* set
   * of names still in use across every board — a partial set would delete live
   * files. Content-addressed media can be shared between cards, so this replaces
   * per-reference deletion. Returns how many files were removed.
   */
  gcMedia(keep: string[]): Promise<number>;
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
   * — populated in the background so a search can find a card by words inside the file
   * it carries, not only the fields typed onto it. Keyed by media name, so extraction
   * is deduped across boards; the webview maps a hit's name back to a card.
   */
  /**
   * Read and index a stored file's body text — PDF and Office bodies, plain text and
   * `.eml`, or a screenshot's text via OCR. Idempotent by content hash; `force`
   * re-reads a file already indexed (a manual reindex, or a newer extractor). Returns
   * the terminal status; best-effort, so it records rather than throws on a bad file.
   */
  processMedia(name: string, force: boolean): Promise<DocStatus>;
  /**
   * Search indexed document bodies. Each hit carries the media name (to map back to a
   * card), a snippet with the match marked, and a rank. An empty query returns nothing.
   */
  searchDocuments(query: string, limit: number): Promise<DocHit[]>;
  /**
   * The media still needing extraction — never indexed, or indexed under an older
   * extractor. The background queue asks for this at startup, so a crash mid-batch
   * simply resumes where it left off.
   */
  pendingMedia(): Promise<string[]>;
  /** Drop index rows for media no longer on disk; called after gcMedia sweeps blobs. */
  pruneDocuments(): Promise<number>;
  /** Empty the search index — the recovery path if it ever drifts; the queue rebuilds. */
  rebuildIndex(): Promise<void>;
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
}
