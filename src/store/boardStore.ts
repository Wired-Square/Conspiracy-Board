import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection as RFConnection,
} from '@xyflow/react';
import type { Board, Card, Cluster, Connection, Vec2, Viewport } from '../types/board';
import type { CardNode, StringEdge } from '../types/reactflow';
import { boardToFlow, cardToNode, connectionToEdge } from '../data/mappers';
import { newCardId, newEdgeId, newClusterId, newBoardId } from '../lib/ids';
import { touches } from '../lib/connections';
import { setLocalCallingCode } from '../lib/phone';
import { eventFor } from '../lib/events';
import { DEFAULT_KIND, isBoardKind, isRecordKind, viewFor } from '../lib/kinds';
import { gridPositions } from '../lib/layout';
import type { View } from '../types/view';
import { emailCardsByMessageId, matchDraft } from '../lib/email/meta';
import { documentMime, isDocumentFile, isImageFile } from '../lib/import/files';
import { pickDocumentMeta, pickImageMeta } from '../lib/import/meta';
import { ocrTitle, usableOcr } from '../lib/import/ocr';
import { emptyBoard } from '../data/emptyBoard';
import { buildManifest } from '../data/bundle';
import { slugify } from '../lib/slug';
import { storage } from '../storage';
import { extOf } from '../storage/media';
import { useBundleImportStore } from './bundleImportStore';
import { useJobQueueStore } from './jobQueueStore';
import type { MediaMeta, PickedFile } from '../storage/StorageAdapter';
import {
  boardMediaRefs,
  cardMediaEntries,
  migrateBoardMedia,
  recoverCardAttachments,
} from './boardMigration';

export type CardDraft = Partial<Omit<Card, 'id' | 'position'>>;

const AUTOSAVE_MS = 500;

// Sorts after any ISO timestamp, so undated drafts land at the end of a batch.
const UNDATED_SORTS_LAST = '￿';

// Palette new clusters cycle through, so each added cluster gets a distinct hue.
const CLUSTER_PALETTE = [
  '#e23b3b', '#3b7de2', '#e2a13b', '#3bd17a', '#b06be0', '#e06ba8', // red, blue, amber, green, purple, pink
  '#3bd1c4', '#e2673b', '#6b6be0', '#9bd13b', '#d13bb0', '#d9cf3b', // teal, orange, indigo, lime, magenta, gold
];

/** A filename without its directory or extension, for a card's title. */
function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = cut >= 0 ? name.slice(cut + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Turn one imported file into the card to make from it: an image becomes an evidence
 * card whose picture it is; a document becomes a document card. The file is stored
 * (content-addressed) and its metadata read in the shell; both a date (taken/created)
 * and a title flow onto the card. Best-effort — a file that will not even store is
 * dropped (returns null), and extraction that fails just leaves the extra fields off.
 */
async function buildMediaDraft(file: PickedFile): Promise<CardDraft | null> {
  const image = isImageFile(file.name);
  if (!image && !isDocumentFile(file.name)) return null;

  let mediaFile: string;
  try {
    mediaFile = await storage.saveMedia(file.bytes, extOf(file.name));
  } catch {
    return null;
  }

  // Metadata for either kind; started before the image branch so it reads
  // alongside OCR there rather than after it.
  const metaP = storage.extractMediaMeta(mediaFile).catch(() => ({}) as MediaMeta);

  if (image) {
    // A text-message screenshot's words become the card's notes, and its first
    // line the title — recognised while the metadata is still being read.
    const [meta, ocr] = await Promise.all([metaP, storage.ocrImage(mediaFile).catch(() => '')]);
    const text = usableOcr(ocr) ? ocr : '';
    return {
      kind: 'evidence',
      title: text ? ocrTitle(text) : baseName(file.name),
      notes: text,
      imageFile: mediaFile,
      imageCrop: null,
      imageMeta: pickImageMeta(meta),
      occurredAt: meta.takenAt ?? null,
    };
  }

  const meta = await metaP;
  return {
    kind: 'document',
    title: meta.title?.trim() || baseName(file.name),
    occurredAt: meta.created ?? null,
    document: { file: mediaFile, name: file.name, mime: documentMime(file.name), ...pickDocumentMeta(meta) },
  };
}

/**
 * A card with every field at its default, overridden by `over` — which must at least
 * carry a position (the schema requires one). The single blank-Card literal, so adding
 * a field to Card is one edit here, not three across addCard/addCards/setIsEvent.
 */
function blankCard(id: string, over: Partial<Card> & { position: Vec2 }): Card {
  return {
    id,
    title: 'New card',
    notes: '',
    imageUrl: null,
    imageFile: null,
    imageCrop: null,
    imageMeta: null,
    clusterId: null,
    kind: DEFAULT_KIND,
    occurredAt: null,
    occurredAtPrecision: 'minute',
    ...over,
  };
}

type BoardState = {
  // Canonical content (authoritative for everything except live node positions).
  meta: Board['meta'];
  clusters: Cluster[];
  cards: Card[];
  connections: Connection[];

  // Derived React Flow view.
  nodes: CardNode[];
  edges: StringEdge[];
  viewport: Viewport | undefined;

  /** The board currently open. Mirrors the adapter's persisted pointer. */
  currentBoardId: string | null;

  // UI state.
  selectedCardId: string | null;
  /**
   * Which surface is showing. Here rather than in a component because a card's
   * kind decides where it lives (see viewFor), so anything that makes or picks
   * one has to be able to say "it went over there" — the toolbar, the timeline,
   * a Mail drop, the import. Prop-drilling that to each was four chances to
   * forget, and forgetting makes a card that appears nowhere at all.
   *
   * Not hover, though: that fires on every pointermove and stays local.
   */
  view: View;
  setView: (view: View) => void;
  /**
   * The toolbar's free-text search: an in-memory entity search (names, addresses,
   * numbers — see cardMatchesEntity) that the board dims by and the record drops by.
   * One query so it follows you across the Board/Record toggle. Transient like the
   * selection, never persisted, cleared when a board opens (see hydrate). The timeline
   * runs its own full-text search (see useDocHits), not this one.
   */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /**
   * Last failure worth showing the user — a save that didn't happen, or a board
   * that wouldn't load. Surfaced in the toolbar; null when all is well.
   */
  lastError: string | null;
  setError: (message: string | null) => void;
  /**
   * True whenever the library is empty — no boards at all — whether on first run
   * or after deleting the last board. The app then shows the welcome dialog to
   * pick a way in rather than silently seeding a board; adopting one clears it
   * (see adoptBoard, init, deleteBoard).
   */
  firstRun: boolean;
  /**
   * A message while a bundle import is working, or null when idle — drives the
   * busy overlay. Set when reading begins and cleared when it's done; the shell's
   * `import:progress` events refine it to "media x of y" (see useImportProgress).
   */
  importStatus: string | null;

  // Lifecycle.
  init: () => Promise<void>;

  // Board library.
  newBoard: (title?: string) => Promise<void>;
  /** Adopt the bundled example board — "The Nightingale File". */
  installExampleBoard: () => Promise<void>;
  openBoard: (id: string) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;
  setTitle: (title: string) => void;
  /** The board's local calling code (e.g. `+61`) — what a leading `0` folds to when
   *  normalising phone numbers. Kept on meta and pushed to lib/phone live. */
  setCountryCode: (code: string) => void;

  // React Flow change handlers.
  onNodesChange: (changes: NodeChange<CardNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<StringEdge>[]) => void;
  onConnect: (conn: RFConnection) => void;
  setViewport: (vp: Viewport) => void;

  // Selection.
  selectCard: (id: string | null) => void;

  // Editing.
  addCard: (init?: CardDraft) => string;
  /** Bulk append (email import). Returns the ids actually added. */
  addCards: (drafts: CardDraft[], opts?: { clusterId?: string | null }) => string[];
  /**
   * Import dropped or picked files: images become evidence cards with the picture,
   * documents become document cards, each with metadata read from the file. Saves
   * the bytes and extracts in the shell; non-media files are ignored.
   */
  addImportedMedia: (files: PickedFile[]) => Promise<void>;
  /**
   * Re-run a card's media processing against its already-stored file — re-scan an
   * email's .eml for attachments, re-read a photo's EXIF and OCR, re-read a
   * document's properties. Additive: it patches derived fields, never re-saves the
   * file, and never touches user-typed notes/title/date. Driven by the maintenance
   * view.
   */
  reprocessCard: (id: string) => Promise<void>;
  /** Reprocess every media-bearing card, one at a time. Returns how many ran. */
  reprocessAll: () => Promise<{ done: number }>;
  /**
   * Turn an unreferenced media file into a card — an orphan image into an evidence
   * card, an orphan document into a document card — reusing the ordinary import path
   * against the file already on disk (no second copy). Lands the card without
   * navigating away, so the maintenance view stays put.
   */
  adoptOrphan: (file: string) => Promise<void>;
  /**
   * Reposition many cards in one pass (the Tidy control). One set and one autosave
   * for the whole board, where looping updateCard would re-map the nodes and
   * re-schedule a save per card.
   */
  arrangeCards: (positions: Map<string, Vec2>) => void;
  updateCard: (id: string, patch: Partial<Omit<Card, 'id'>>) => void;
  /**
   * Mark a card as an event, or unmark it. Ticking it on spawns a graded `event` card
   * carrying the source's moment, strung to it ("evidences"); ticking off removes that
   * event and its string. The source keeps its own kind — the event is the claim it
   * evidences, on the board and (once dated) the timeline, where it folds the source
   * under its milestone rather than double-listing it. Offered on any non-actor card
   * that isn't itself an event.
   */
  setIsEvent: (cardId: string, on: boolean) => void;
  /** Remove a card, and every piece of string tied to it. Irreversible. */
  deleteCard: (id: string) => void;
  toggleCluster: (id: string) => void;
  addCluster: (label?: string) => string;
  updateCluster: (id: string, patch: Partial<Omit<Cluster, 'id'>>) => void;
  deleteCluster: (id: string) => void;
  addConnection: (source: string, target: string, label?: string) => void;
  updateConnection: (id: string, patch: Partial<Omit<Connection, 'id'>>) => void;
  deleteConnection: (id: string) => void;

  // Persistence.
  toBoard: () => Board;
  save: () => Promise<void>;
  /** Bundle the given library boards (by id) and save to a chosen file; false if cancelled. */
  exportBundle: (ids: string[]) => Promise<boolean>;
  /** Pick a bundle (or legacy board file) and open the select/rename import dialog. */
  importBoard: () => Promise<void>;
  /** Adopt the chosen boards from an imported bundle, each under its (renamed) title. */
  adoptBundle: (selected: { board: Board; title: string }[]) => Promise<void>;
};

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

// init() must be idempotent: StrictMode double-invokes effects in dev, and two
// concurrent inits would both see an empty library and both seed it, leaving the
// user with two identical boards. Sharing one promise makes the second call
// await the first instead of racing it.
let initPromise: Promise<void> | undefined;

export const useBoardStore = create<BoardState>((set, get) => {
  const scheduleAutosave = () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      // Clearing the handle here is what lets flushAutosave tell "pending" from
      // "already ran".
      autosaveTimer = undefined;
      void get().save();
    }, AUTOSAVE_MS);
  };

  /** Write any pending edits before leaving the current board behind. */
  const flushAutosave = async () => {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    await get().save();
  };

  // Rebuild all derived nodes from canonical cards. Needed after cluster
  // colour/assignment changes, since each node caches its cluster colour.
  // Safe because card positions are kept current by onNodesChange, and because
  // selection is derived at render (see useHighlightConnections) rather than
  // stored on the node.
  const refreshNodes = () =>
    set({ nodes: get().cards.map((c) => cardToNode(c, get().clusters)) });

  const hydrate = (board: Board) => {
    // Phone normalisation reads a module-level locale (lib/phone); a board carries
    // its own, so set it before any card's numbers are matched or shown.
    setLocalCallingCode(board.meta.countryCode ?? '+61');
    const { nodes, edges } = boardToFlow(board);
    set({
      meta: board.meta,
      clusters: board.clusters,
      cards: board.cards,
      connections: board.connections,
      nodes,
      edges,
      viewport: board.viewport,
      selectedCardId: null,
      // A new board opens on the board, whatever the last one was showing.
      view: 'board',
      // The toolbar isn't remounted on a board switch, so a stale query would
      // otherwise carry over and hide the new board's cards.
      searchQuery: '',
    });
  };

  /**
   * Become this board. The store's `currentBoardId` and the adapter's persisted
   * pointer are two halves of one fact, so they are only ever written together,
   * here.
   */
  const enterBoard = async (id: string, board: Board) => {
    hydrate(board);
    set({ currentBoardId: id, lastError: null });
    await storage.setCurrentBoardId(id);
  };

  /**
   * Load a board for opening, or null if it could not be read *this time*.
   *
   * A failed load is NEVER taken to mean the board is gone: the entry is left
   * exactly as it was, so a transient unreadability — a file still syncing in, a
   * read that lost a race with the 500ms autosave, a parse off a half-written byte
   * — costs a retry, not the board. A board's file is deleted only when the user
   * asks (`deleteBoard`); inferring "delete it" from one bad read is how a whole
   * board, and then its media to the GC sweep, was lost. So this never deletes: a
   * genuinely dangling entry just fails to open with a message, which is recoverable
   * where a deletion is not.
   *
   * A legacy board's inline pictures are moved out to the media library here, and
   * the board rewritten once if that changed anything — so the base64 is paid off
   * a single time rather than re-serialised on every autosave from now on.
   */
  const loadBoardForOpen = async (id: string): Promise<Board | null> => {
    const board = await storage.loadBoard(id);
    if (!board) return null;
    const { board: migrated, changed } = await migrateBoardMedia(board);
    if (changed) await storage.saveBoard(id, migrated);
    return migrated;
  };

  /**
   * Sweep media no board references any more. Content-addressed files can be
   * shared, so a file cannot be deleted the moment one card lets go of it — the
   * keep-set is only whole once every board has been read. Runs in the background
   * off startup and after a board is deleted; it aborts rather than sweeping if
   * any board fails to load, so an unreadable board never costs its media.
   */
  const gcMedia = async () => {
    // Flush first, so the open board's just-added media is on disk and in the
    // keep-set. Only the current board can have unsaved edits; the rest are as
    // they are on disk. (The shell also spares very fresh files, as a backstop.)
    await flushAutosave();
    const entries = await storage.listBoards();
    const boards = await Promise.all(entries.map((e) => storage.loadBoard(e.id)));
    // A board that won't load means the keep-set is incomplete — don't sweep, or a
    // temporarily unreadable board would lose its media. (The shell dedupes the
    // list, so passing refs with repeats across boards is fine.)
    if (boards.some((b) => !b)) return;
    try {
      await storage.gcMedia(boards.flatMap((b) => boardMediaRefs(b!)));
      // Drop the search-index rows for any blob just swept, so the index tracks the
      // media store. Board-agnostic, so it reconciles against what's left on disk.
      await storage.pruneDocuments();
    } catch {
      // Housekeeping: a failed sweep just leaves orphans for next time.
    }
  };

  /**
   * Take a board that isn't in the library yet, give it an id, and switch to it.
   * Shared by New and Import — both are additive; neither disturbs the board
   * they replace on screen.
   */
  const adoptBoard = async (board: Board) => {
    await flushAutosave();
    const id = newBoardId();
    hydrate(board);
    set({ currentBoardId: id, lastError: null, firstRun: false });
    // Saved before the pointer is persisted: a reload in between would
    // otherwise dangle currentId at a board that was never written.
    await get().save();
    await storage.setCurrentBoardId(id);
  };

  /**
   * The mirror of adoptBoard: go to the empty-library state, where the welcome
   * dialog offers a way in (see firstRun). Used on a genuinely empty library at
   * init and after the last board is deleted. Clears the hydrated content too, so
   * a just-deleted board isn't left sitting in memory behind the dialog.
   */
  const enterEmptyLibrary = () => {
    hydrate(emptyBoard());
    set({ currentBoardId: null, firstRun: true, lastError: null });
  };

  return {
    ...emptyBoard(),
    nodes: [],
    edges: [],
    viewport: undefined,
    currentBoardId: null,
    selectedCardId: null,
    view: 'board',
    searchQuery: '',
    lastError: null,
    firstRun: false,
    importStatus: null,

    setView(view) {
      set({ view });
    },

    setSearchQuery(searchQuery) {
      set({ searchQuery });
    },

    setError(message) {
      set({ lastError: message });
    },

    init() {
      initPromise ??= (async () => {
        const load = async () => {
          await storage.init();
          const entries = await storage.listBoards();

          // Empty library — first run. Never seed anything on our own; ask what
          // the user wants via the welcome dialog, which App shows while firstRun
          // is set (see FirstRunModal).
          if (!entries.length) {
            enterEmptyLibrary();
            return;
          }

          // Prefer the last-open board, but never trust it: a dangling pointer or
          // an unreadable body must still land the user on *something*.
          const currentId = await storage.getCurrentBoardId();
          const ids = entries.map((e) => e.id);
          const ordered = currentId
            ? [currentId, ...ids.filter((id) => id !== currentId)]
            : ids;

          for (const id of ordered) {
            const board = await loadBoardForOpen(id);
            if (!board) continue;
            await enterBoard(id, board);
            return;
          }

          // Every entry is unreadable. Don't strand the user on an empty screen.
          await get().newBoard();
        };

        await load();
        // The app is up; tidy media no board points at any more. Not awaited —
        // it reads every board, and first paint must not wait on housekeeping.
        void gcMedia();
        // Pick up indexing where a previous run left off: extract text for any media
        // not yet in the search index (a crash mid-batch, or files from before the
        // index existed). A background projection, so first paint doesn't wait on it.
        void useJobQueueStore.getState().resume();
      })();
      return initPromise;
    },

    async newBoard(title) {
      const board = emptyBoard();
      const name = title?.trim();
      if (name) board.meta.title = name;
      await adoptBoard(board);
    },

    async installExampleBoard() {
      // Dynamically imported so data/board.json stays out of the main chunk —
      // it only ever loads if the user asks for the example.
      const { defaultBoard } = await import('../data/defaultBoard');
      await adoptBoard(defaultBoard);
    },

    async openBoard(id) {
      if (id === get().currentBoardId) return;
      await flushAutosave();

      const board = await loadBoardForOpen(id);
      if (!board) {
        // Stay put. Minting a blank board under this id would be data loss
        // wearing a disguise.
        set({ lastError: 'That board could not be loaded.' });
        return;
      }

      // Deliberately no autosave: toBoard() restamps updatedAt, so merely
      // opening a board would reorder the library by recency.
      await enterBoard(id, board);
    },

    async deleteBoard(id) {
      await storage.deleteBoard(id);
      // A deleted board may have held the only references to some media; sweep it
      // in the background rather than leaving it orphaned until the next startup.
      void gcMedia();
      if (id !== get().currentBoardId) return;

      // The open board just went away; land on the newest survivor, or — if that
      // was the last one — back to the welcome dialog, the same empty-library
      // state as first run, rather than silently minting a blank board.
      const survivor = (await storage.listBoards())[0];
      if (survivor) await get().openBoard(survivor.id);
      else enterEmptyLibrary();
    },

    setTitle(title) {
      set({ meta: { ...get().meta, title } });
      // The library entry is derived from board.meta on save, so the rename
      // reaches the index on the next autosave with no extra call.
      scheduleAutosave();
    },

    setCountryCode(code) {
      // Store what the user typed; lib/phone normalises it (e.g. `61` → `+61`).
      set({ meta: { ...get().meta, countryCode: code } });
      setLocalCallingCode(code);
      scheduleAutosave();
    },

    onNodesChange(changes) {
      const nodes = applyNodeChanges(changes, get().nodes);
      // Fold dragged positions back into canonical cards; ignore transient
      // select/dimension churn. (Deletion is an M2 feature; see deleteKeyCode.)
      if (changes.some((c) => c.type === 'position')) {
        const positionById = new Map(nodes.map((n) => [n.id, n.position]));
        set({
          nodes,
          // Only the dragged card gets a new identity. React Flow fires a
          // position change per pointermove, and the timeline now derives from
          // `cards` in a render path — respreading all of them would re-render
          // every chip on every frame.
          cards: get().cards.map((card) => {
            const p = positionById.get(card.id);
            return p && (p.x !== card.position.x || p.y !== card.position.y)
              ? { ...card, position: p }
              : card;
          }),
        });
        scheduleAutosave();
      } else {
        set({ nodes });
      }
    },

    onEdgesChange(changes) {
      set({ edges: applyEdgeChanges(changes, get().edges) });
    },

    onConnect(conn) {
      if (conn.source && conn.target) get().addConnection(conn.source, conn.target);
    },

    setViewport(vp) {
      set({ viewport: vp });
      scheduleAutosave();
    },

    selectCard(id) {
      // Picking a card shows you the card. It may not live where you are — a
      // timeline chip for an email, a person's mail in the editor — so selection
      // carries the view with it rather than each caller remembering to. Letting
      // go of the selection moves nothing: you are still looking at the place
      // you were looking at.
      const card = id ? get().cards.find((c) => c.id === id) : undefined;
      set({ selectedCardId: id, ...(card ? { view: viewFor(card.kind) } : {}) });
    },

    addCard(init) {
      const id = newCardId();
      const vp = get().viewport;
      // Drop the new card near the centre of the current view.
      const position = vp
        ? { x: -vp.x / vp.zoom + 200, y: -vp.y / vp.zoom + 160 }
        : { x: 200, y: 160 };
      const card = blankCard(id, { clusterId: get().clusters[0]?.id ?? null, ...init, position });
      set({
        cards: [...get().cards, card],
        nodes: [...get().nodes, cardToNode(card, get().clusters)],
        selectedCardId: id,
        // Go to wherever it went. + Add > Document and a message dropped from
        // Mail both make a card the board does not draw; without this they make
        // one that appears nowhere at all.
        view: viewFor(card.kind),
      });
      scheduleAutosave();
      return id;
    },

    // Bulk append, for email import. Distinct from importBoard(), which brings a
    // whole board in from a file — these drafts are added to the current one.
    addCards(drafts, opts) {
      // Same rules the import preview shows, so what the user confirms is what
      // lands.
      const byMessageId = emailCardsByMessageId(get().cards);
      const fresh: CardDraft[] = [];
      const completedIds: string[] = [];
      const seen = new Set<string>();

      for (const d of drafts) {
        const id = d.email?.messageId;
        // Duplicates *within* one batch, which the board doesn't know about yet.
        if (id && seen.has(id)) continue;

        const match = matchDraft(d, byMessageId);
        if (match.kind === 'duplicate') continue;

        if (match.kind === 'completes') {
          // Fill the card a Mail drag left waiting — in place, so its position,
          // cluster and connections survive. Provenance survives too: the
          // message is still the one sitting in the user's Mail.
          get().updateCard(match.card.id, {
            ...d,
            email: { ...d.email!, source: match.card.email?.source },
          });
          completedIds.push(match.card.id);
          continue;
        }

        if (id) seen.add(id);
        fresh.push(d);
      }

      if (!fresh.length) return completedIds;

      // Lay the block out oldest-first so the board itself reads chronologically
      // left-to-right, not just the timeline. Undated drafts sort to the end.
      //
      // Drawn cards take the near slots. Every card needs a position — the
      // schema requires one — but a record card is never placed at its own, so
      // letting the mail take the front of the grid would put the three people
      // you ticked in row 33 of a 200-message import, half a screen from
      // anything. They still get a slot, just the far ones, in case one is ever
      // switched to a kind the board draws.
      fresh.sort(
        (a, b) =>
          Number(isRecordKind(a.kind ?? DEFAULT_KIND)) -
            Number(isRecordKind(b.kind ?? DEFAULT_KIND)) ||
          (a.occurredAt ?? UNDATED_SORTS_LAST).localeCompare(
            b.occurredAt ?? UNDATED_SORTS_LAST,
          ),
      );

      const positions = gridPositions(fresh.length, get().cards);
      const added: Card[] = fresh.map((d, i) =>
        blankCard(newCardId(), { clusterId: opts?.clusterId ?? null, ...d, position: positions[i] }),
      );

      set({
        cards: [...get().cards, ...added],
        nodes: [...get().nodes, ...added.map((c) => cardToNode(c, get().clusters))],
      });
      scheduleAutosave();
      return [...completedIds, ...added.map((c) => c.id)];
    },

    async addImportedMedia(files) {
      // Save + extract every file at once; a bad one drops out rather than sinking
      // the batch. Order is preserved so the grid follows the drop/pick order.
      const drafts = (await Promise.all(files.map(buildMediaDraft))).filter(
        (d): d is CardDraft => d !== null,
      );
      if (!drafts.length) return;
      const ids = get().addCards(drafts);
      if (!ids.length) return;
      // Index the just-saved files' text in the background, so a search finds words
      // inside them (not only the fields on the card). Idempotent, so re-imports and
      // the startup resume() never double-work.
      useJobQueueStore.getState().enqueue(
        drafts.flatMap((d) => [d.imageFile, d.document?.file].filter((n): n is string => !!n)),
      );
      // One file: open it, so its picture/metadata is right there. Several: just go
      // to where they landed — the board unless every one is a record card.
      if (ids.length === 1) {
        get().selectCard(ids[0]);
      } else {
        set({ view: drafts.some((d) => isBoardKind(d.kind ?? DEFAULT_KIND)) ? 'board' : 'record' });
      }
    },

    async reprocessCard(id) {
      const card = get().cards.find((c) => c.id === id);
      if (!card) return;

      // Email: re-parse the .eml for attachments the import may have dropped.
      if (card.email?.emlFile) {
        const patch = await recoverCardAttachments(card);
        if (patch) get().updateCard(id, patch);
        return;
      }

      // Image: re-read EXIF and re-OCR the stored file (mirrors buildMediaDraft's
      // image branch). Only fills notes from OCR when there are none — a reprocess
      // must not overwrite what the user has written, or their date.
      if (card.imageFile) {
        const [meta, ocr] = await Promise.all([
          storage.extractMediaMeta(card.imageFile).catch(() => ({}) as MediaMeta),
          storage.ocrImage(card.imageFile).catch(() => ''),
        ]);
        const patch: Partial<Card> = { imageMeta: pickImageMeta(meta) };
        if (!card.notes.trim() && usableOcr(ocr)) patch.notes = ocr;
        get().updateCard(id, patch);
        return;
      }

      // Document: re-read the file's properties into the document payload.
      if (card.document?.file) {
        const meta = await storage
          .extractMediaMeta(card.document.file)
          .catch(() => ({}) as MediaMeta);
        get().updateCard(id, { document: { ...card.document, ...pickDocumentMeta(meta) } });
      }
    },

    async reprocessAll() {
      // One at a time: reading many large files (a 17MB .eml, a full-res photo) at
      // once would spike memory, and updateCard's debounced autosave collapses to one.
      const ids = get()
        .cards.filter((c) => cardMediaEntries(c).length > 0)
        .map((c) => c.id);
      let done = 0;
      for (const id of ids) {
        try {
          await get().reprocessCard(id);
          done += 1;
        } catch {
          // Best-effort: a file that won't read now is left for a later manual retry.
        }
      }
      return { done };
    },

    async adoptOrphan(file) {
      // Turn an unreferenced media file into a card, where it already lives — no
      // re-import dialog and no second copy (buildMediaDraft's saveMedia is
      // idempotent by content hash). addCards, not addImportedMedia, so it lands
      // without pulling the user out of the maintenance view onto the new card.
      const bytes = await storage.readMedia(file);
      const draft = await buildMediaDraft({ name: file, bytes });
      if (draft) get().addCards([draft]);
    },

    arrangeCards(positions) {
      if (!positions.size) return;
      const cards = get().cards.map((c) => {
        const p = positions.get(c.id);
        return p ? { ...c, position: p } : c;
      });
      set({
        cards,
        // Keep each moved node's measured size and cluster colour — only its
        // position, and the card it mirrors, change.
        nodes: get().nodes.map((n) => {
          const p = positions.get(n.id);
          return p ? { ...n, position: p, data: { ...n.data, card: { ...n.data.card, position: p } } } : n;
        }),
      });
      scheduleAutosave();
    },

    updateCard(id, patch) {
      const cards = get().cards.map((c) => (c.id === id ? { ...c, ...patch } : c));
      const updated = cards.find((c) => c.id === id)!;
      set({
        cards,
        // Keep the derived node in sync with the canonical card.
        nodes: get().nodes.map((n) =>
          n.id === id ? cardToNode(updated, get().clusters) : n,
        ),
      });
      scheduleAutosave();
    },

    setIsEvent(cardId, on) {
      const source = get().cards.find((c) => c.id === cardId);
      if (!source) return;
      const existing = eventFor(get().cards, cardId);

      if (on) {
        if (existing) return; // already marked — the checkbox is derived from this
        const id = newCardId();
        const event = blankCard(id, {
          // Named after the source so the milestone reads as the thing that happened;
          // the user can rename it. Beside the source, so it lands sensibly when the
          // source is drawn (a record isn't, but an evidence source is).
          title: source.title || 'Event',
          clusterId: source.clusterId,
          position: { x: source.position.x + 48, y: source.position.y + 48 },
          kind: 'event',
          occurredAt: source.occurredAt,
          occurredAtPrecision: source.occurredAtPrecision,
          event: { sourceCardId: cardId },
        });
        set({
          cards: [...get().cards, event],
          nodes: [...get().nodes, cardToNode(event, get().clusters)],
        });
        scheduleAutosave();
        // The string from the source to the event it evidences.
        get().addConnection(cardId, id, 'evidences');
      } else if (existing) {
        // Takes its string with it (deleteCard cascades) and saves.
        get().deleteCard(existing.id);
      }
    },

    deleteCard(id) {
      // The string goes with the card. A connection is drawn between two cards;
      // one of them gone, it is not a claim any more, it is a dangling id — and
      // nothing in the schema would catch it, so it would persist and quietly
      // fail to draw. The editor counts these first (see touches) so the user is
      // told what they are about to lose rather than finding out later.
      const { cards, nodes, connections, edges, selectedCardId } = get();
      set({
        cards: cards.filter((c) => c.id !== id),
        nodes: nodes.filter((n) => n.id !== id),
        connections: connections.filter((c) => !touches(c, id)),
        edges: edges.filter((e) => !touches(e, id)),
        // The editor reads this. Left pointing at a card that is gone, it would
        // render against undefined.
        selectedCardId: selectedCardId === id ? null : selectedCardId,
      });
      scheduleAutosave();
    },

    toggleCluster(id) {
      set({
        clusters: get().clusters.map((c) =>
          c.id === id ? { ...c, visible: !c.visible } : c,
        ),
      });
      scheduleAutosave();
    },

    addCluster(label) {
      const id = newClusterId();
      const cluster: Cluster = {
        id,
        label: label ?? 'New cluster',
        color: CLUSTER_PALETTE[get().clusters.length % CLUSTER_PALETTE.length],
        visible: true,
      };
      set({ clusters: [...get().clusters, cluster] });
      scheduleAutosave();
      return id;
    },

    updateCluster(id, patch) {
      set({
        clusters: get().clusters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      });
      // Cached node colours need rebuilding when a cluster colour changes.
      if (patch.color !== undefined) refreshNodes();
      scheduleAutosave();
    },

    deleteCluster(id) {
      set({
        clusters: get().clusters.filter((c) => c.id !== id),
        // Keep the cards; just drop their reference to the deleted cluster.
        cards: get().cards.map((c) =>
          c.clusterId === id ? { ...c, clusterId: null } : c,
        ),
      });
      refreshNodes();
      scheduleAutosave();
    },

    addConnection(source, target, label) {
      if (!source || !target || source === target) return;
      const exists = get().connections.some(
        (c) => c.source === source && c.target === target,
      );
      if (exists) return;
      const trimmed = label?.trim();
      const connection: Connection = {
        id: newEdgeId(),
        source,
        target,
        kind: 'red-string',
        ...(trimmed ? { label: trimmed } : {}),
      };
      set({
        connections: [...get().connections, connection],
        edges: [...get().edges, connectionToEdge(connection)],
      });
      scheduleAutosave();
    },

    updateConnection(id, patch) {
      const connections = get().connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
      const updated = connections.find((c) => c.id === id)!;
      set({
        connections,
        // Keep the derived edge in sync with the canonical connection, exactly as
        // updateCard does for its node. Rebuilding through connectionToEdge is
        // what carries a new grade to the thing that draws the string.
        edges: get().edges.map((e) => (e.id === id ? connectionToEdge(updated) : e)),
      });
      scheduleAutosave();
    },

    deleteConnection(id) {
      set({
        connections: get().connections.filter((c) => c.id !== id),
        edges: get().edges.filter((e) => e.id !== id),
      });
      scheduleAutosave();
    },

    toBoard() {
      // Canonical state is kept current as the user edits (positions folded in
      // onNodesChange), so the board can be assembled directly.
      const { meta, clusters, cards, connections, viewport } = get();
      return {
        version: 3,
        meta: { ...meta, updatedAt: new Date().toISOString() },
        clusters,
        cards,
        connections,
        viewport,
      };
    },

    async save() {
      // Snapshot both id and board before the first await. Web storage is
      // synchronous under the hood, but Tauri does real async IO — without this,
      // a slow write in flight during a board switch would land this board's
      // bytes under the next board's id.
      const id = get().currentBoardId;
      if (!id) return;
      const board = get().toBoard();

      try {
        await storage.saveBoard(id, board);
        if (get().lastError) set({ lastError: null });
      } catch (err) {
        // Autosave runs from a debounced timer with no caller to catch this, so
        // the error has to land in state or it is lost entirely.
        set({ lastError: err instanceof Error ? err.message : String(err) });
      }
    },

    async exportBundle(ids) {
      // Flush any pending edit so the library on disk and its index are current,
      // then gather each board: the open one from live state (its unsaved edits and
      // a fresh updatedAt), every other from disk. A board that won't load is
      // dropped rather than failing the whole export.
      await flushAutosave();
      const currentId = get().currentBoardId;
      const gathered = (
        await Promise.all(
          ids.map(async (id) => {
            const board = id === currentId ? get().toBoard() : await storage.loadBoard(id);
            return board ? { id, board } : null;
          }),
        )
      ).filter((g): g is { id: string; board: Board } => g !== null);
      if (!gathered.length) return false;

      // The union of every media file the chosen boards reference — content-
      // addressed, so a file shared across boards is named once.
      const media = [...new Set(gathered.flatMap((g) => boardMediaRefs(g.board)))];
      const filename = gathered.length === 1 ? slugify(gathered[0].board.meta.title) : 'conspiracy-library';
      try {
        return await storage.exportBundle({
          boards: gathered.map((g) => ({ id: g.id, json: JSON.stringify(g.board) })),
          media,
          manifest: JSON.stringify(buildManifest(gathered)),
          filename,
        });
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    async importBoard() {
      try {
        // Feedback runs from the moment a file is chosen (not while the picker is
        // open) until the shell has stored its media — the heavy part. The shell's
        // import:progress events refine the text; the busy overlay reads it.
        const boards = await storage.importFile(() =>
          set({ importStatus: 'Reading the bundle…' }),
        );
        if (!boards) return; // Cancelled.
        if (!boards.length) {
          set({ lastError: 'That file had no boards to import.' });
          return;
        }
        // The dialog picks which to bring in and renames them; a legacy .json
        // arrives as a one-board list, so it gets the same checkbox and rename.
        useBundleImportStore.getState().openWith(boards);
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ importStatus: null });
      }
    },

    async adoptBundle(selected) {
      // Additive: each board is adopted under a fresh id (adoptBoard mints one), so
      // a renamed import lands beside the board it is a new version of rather than
      // replacing it. The last one adopted is left current.
      for (const { board, title } of selected) {
        await adoptBoard({ ...board, meta: { ...board.meta, title } });
      }
      // Media for boards left unselected was stored when the bundle was read and is
      // now unreferenced; the sweep reclaims it (after its min-age grace).
      void gcMedia();
    },
  };
});
