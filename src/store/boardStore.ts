import { createStore } from 'zustand/vanilla';
import type { Board, Card, Cluster, Connection, Vec2, Viewport } from '../types/board';
import { newCardId, newEdgeId, newClusterId, newBoardId } from '../lib/ids';
import { setLocalCallingCode } from '../lib/phone';
import { eventFor } from '../lib/events';
import { DEFAULT_KIND, isBoardKind, isRecordKind, viewFor } from '../lib/kinds';
import { gridPositions } from '../lib/layout';
import type { View } from '../types/view';
import { emailCardsByMessageId, matchDraft } from '../lib/email/meta';
import { emptyBoard } from '../data/emptyBoard';
import { buildManifest } from '../data/bundle';
import { slugify } from '../lib/slug';
import { errorMessage } from '../lib/errors';
import { storage } from '../storage';
import { doc, type CardPatch, type ClusterPatch, type ConnectionPatch, type DocChanged } from '../platform/document';
import { openDialog } from './dialogStore';
import type { MediaDraft } from '../storage/StorageAdapter';
import { boardMediaRefs, cardMediaEntries } from '../lib/media';
import { drafts } from '../lib/drafts';
import { migrateBoardMedia, recoverCardAttachments } from './boardMigration';

export type CardDraft = Partial<Omit<Card, 'id' | 'position'>>;

/** A card or cluster just deleted, while that delete is still the last edit. */
export type Deleted = { kind: 'card' | 'cluster'; id: string; label: string };

// Sorts after any ISO timestamp, so undated drafts land at the end of a batch.
const UNDATED_SORTS_LAST = '￿';

// Palette new clusters cycle through, so each added cluster gets a distinct hue.
const CLUSTER_PALETTE = [
  '#e23b3b', '#3b7de2', '#e2a13b', '#3bd17a', '#b06be0', '#e06ba8', // red, blue, amber, green, purple, pink
  '#3bd1c4', '#e2673b', '#6b6be0', '#9bd13b', '#d13bb0', '#d9cf3b', // teal, orange, indigo, lime, magenta, gold
];

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
    clusterIds: [],
    kind: DEFAULT_KIND,
    occurredAt: null,
    occurredAtPrecision: 'minute',
    ...over,
  };
}

function newConnection(source: string, target: string, label?: string): Connection {
  const trimmed = label?.trim();
  return { id: newEdgeId(), source, target, kind: 'red-string', ...(trimmed ? { label: trimmed } : {}) };
}

/**
 * `rows` with `upserts` laid in (a known id replaced in place, a new one appended) and
 * `removed` dropped, then put in `order` when an undo or redo gives one.
 */
function patchRows<T extends { id: string }>(rows: T[], upserts: T[], removed: string[], order?: string[]): T[] {
  if (!upserts.length && !removed.length) return rows;
  const gone = new Set(removed);
  const fresh = new Map(upserts.map((r) => [r.id, r]));
  const kept = rows
    .filter((r) => !gone.has(r.id))
    .map((r) => {
      const next = fresh.get(r.id);
      fresh.delete(r.id);
      return next ?? r;
    });
  const next = [...kept, ...fresh.values()];
  if (!order) return next;
  const rank = new Map(order.map((id, i) => [id, i]));
  return next.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

export type BoardState = {
  // The open board as the shell last reported it (see applyDocChanged). Actions
  // send commands and wait for the change to come back, except a settled drag,
  // which moves its cards at once (see arrangeCards).
  meta: Board['meta'];
  clusters: Cluster[];
  cards: Card[];
  connections: Connection[];
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
   * `import:progress` events refine it to "media x of y" (see startImportProgress).
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

  setViewport: (vp: Viewport) => void;

  // Selection.
  selectCard: (id: string | null) => void;

  // Editing.
  addCard: (init?: CardDraft) => string;
  /** Bulk append (email import). Returns the ids actually added. */
  addCards: (drafts: CardDraft[], opts?: { clusterId?: string | null }) => string[];
  /**
   * Place the cards the shell made from imported pictures and documents, and go to
   * them: one is opened, several show where they landed.
   */
  addImportedMedia: (drafts: MediaDraft[]) => void;
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
   * Reposition many cards in one command (Tidy, or a settled drag). The cards move
   * at once rather than a round trip later, and move back if the shell refuses.
   * Only a moved card gets a new identity, so unmoved chips and rows keep theirs.
   */
  arrangeCards: (positions: Map<string, Vec2>) => void;
  updateCard: (id: string, patch: CardPatch) => void;
  /**
   * Mark a card as an event, or unmark it. Ticking it on spawns a graded `event` card
   * carrying the source's moment, strung to it ("evidences"); ticking off removes that
   * event and its string. The source keeps its own kind — the event is the claim it
   * evidences, on the board and (once dated) the timeline, where it folds the source
   * under its milestone rather than double-listing it. Offered on any non-actor card
   * that isn't itself an event.
   */
  setIsEvent: (cardId: string, on: boolean) => void;
  /** Remove a card, and every piece of string tied to it. */
  deleteCard: (id: string) => void;
  /** What the toast offers to undo; cleared by the next content edit. */
  lastDeleted: Deleted | null;
  /** The shell's undo log for the open board (session.rs), as its last change reported it. */
  canUndo: boolean;
  canRedo: boolean;
  /** Commit any pending text draft, then step the shell's log back or forward. */
  undo: () => void;
  redo: () => void;
  toggleCluster: (id: string) => void;
  addCluster: (label?: string) => string;
  updateCluster: (id: string, patch: ClusterPatch) => void;
  deleteCluster: (id: string) => void;
  addConnection: (source: string, target: string, label?: string) => void;
  updateConnection: (id: string, patch: ConnectionPatch) => void;
  deleteConnection: (id: string) => void;
  /** Patch the open board with an edit the shell has committed, whoever made it. */
  applyDocChanged: (change: DocChanged) => void;

  // Library files.
  /** Bundle the given library boards (by id) and save to a chosen file; false if cancelled. */
  exportBundle: (ids: string[]) => Promise<boolean>;
  /** Pick a bundle (or legacy board file) and open the select/rename import dialog. */
  importBoard: () => Promise<void>;
  /** Adopt the chosen boards from an imported bundle, each under its (renamed) title. */
  adoptBundle: (selected: { board: Board; title: string }[]) => Promise<void>;
};

// init() must be idempotent: StrictMode double-invokes effects in dev, and two
// concurrent inits would both see an empty library and both seed it, leaving the
// user with two identical boards. Sharing one promise makes the second call
// await the first instead of racing it.
let initPromise: Promise<void> | undefined;

export const boardStore = createStore<BoardState>()((set, get) => {
  /** Send an edit for the open board; a refusal lands in lastError, as nothing else awaits it. */
  const send = (command: (boardId: string) => Promise<void>, onError?: () => void) => {
    const id = get().currentBoardId;
    if (!id) return;
    command(id).then(
      () => {
        if (get().lastError) set({ lastError: null });
      },
      (err) => {
        onError?.();
        set({ lastError: errorMessage(err) });
      },
    );
  };

  /** Send a card patch, unless the card is gone or already says so. */
  const patchCard = (id: string, patch: CardPatch, command: typeof doc.updateCard) => {
    // A no-op for a card that is gone: the editor's title/notes commits are
    // debounced, so one can land after deleteCard took the card away.
    const current = get().cards.find((c) => c.id === id);
    if (!current) return;
    if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => patch[k] === current[k])) return;
    send((board) => command(board, id, patch));
  };

  const hydrate = (board: Board) => {
    // Phone normalisation reads a module-level locale (lib/phone); a board carries
    // its own, so set it before any card's numbers are matched or shown.
    setLocalCallingCode(board.meta.countryCode ?? '+61');
    set({
      meta: board.meta,
      clusters: board.clusters,
      cards: board.cards,
      connections: board.connections,
      viewport: board.viewport,
      selectedCardId: null,
      // A fresh session starts a fresh log.
      lastDeleted: null,
      canUndo: false,
      canRedo: false,
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
    void localiseMedia(id, board);
  };

  /**
   * Open a board's session, or null if it could not be read *this time*.
   *
   * A failed open is NEVER taken to mean the board is gone: the entry is left
   * exactly as it was, so a transient unreadability — a file still syncing in, a
   * parse off a half-written byte — costs a retry, not the board. A board's file is
   * deleted only when the user asks (`deleteBoard`); inferring "delete it" from one
   * bad read is how a whole board, and then its media to the GC sweep, was lost. So
   * this never deletes: a genuinely dangling entry just fails to open with a
   * message, which is recoverable where a deletion is not. (A legacy JSON board
   * becomes its `.sqlite` in the shell, on this first open.)
   */
  const openSession = (id: string): Promise<Board | null> => doc.open(id).catch(() => null);

  /** Move a legacy board's inline or linked pictures into the media library, card by card. */
  const localiseMedia = async (id: string, board: Board) => {
    const { board: migrated, changed } = await migrateBoardMedia(board);
    if (!changed) return;
    migrated.cards.forEach((card, i) => {
      if (card === board.cards[i]) return;
      // Housekeeping: a board switched away from meanwhile converts on its next open.
      doc.refreshCard(id, card.id, { imageFile: card.imageFile, imageUrl: null }).catch(() => {});
    });
  };

  /**
   * Sweep media no board references any more, in the background off startup and
   * after a board is deleted. The shell builds the keep-set and sweeps nothing while
   * any board's refs are unknown, so an unreadable board never costs its media.
   */
  const gcMedia = async () => {
    // Housekeeping: a failed sweep just leaves orphans for next time.
    await storage.gcMedia().catch(() => {});
  };

  /**
   * Take a board that isn't in the library yet, give it an id, and switch to it.
   * Shared by New and Import — both are additive; neither disturbs the board
   * they replace on screen.
   */
  const adoptBoard = async (board: Board) => {
    const id = newBoardId();
    try {
      await storage.createBoard(id, board);
      await enterBoard(id, await doc.open(id));
      set({ firstRun: false });
    } catch (err) {
      set({ lastError: errorMessage(err) });
    }
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
    viewport: undefined,
    currentBoardId: null,
    selectedCardId: null,
    lastDeleted: null,
    canUndo: false,
    canRedo: false,
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
          await doc.listen((change) => get().applyDocChanged(change));
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
            const board = await openSession(id);
            if (!board) continue;
            await enterBoard(id, board);
            return;
          }

          // Every entry is unreadable. Don't strand the user on an empty screen.
          await get().newBoard();
        };

        await load();
        // The app is up; tidy media no board points at any more. Not awaited —
        // first paint must not wait on housekeeping.
        void gcMedia();
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
      await adoptBoard(await storage.seedBoard());
    },

    async openBoard(id) {
      if (id === get().currentBoardId) return;
      const board = await openSession(id);
      if (!board) {
        // Stay put. Minting a blank board under this id would be data loss
        // wearing a disguise.
        set({ lastError: 'That board could not be loaded.' });
        return;
      }
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
      send((board) => doc.setMeta(board, { title }));
    },

    setCountryCode(code) {
      // Store what the user typed; lib/phone normalises it (e.g. `61` → `+61`).
      send((board) => doc.setMeta(board, { countryCode: code }));
    },

    setViewport(vp) {
      set({ viewport: vp });
      send((board) => doc.setViewport(board, vp));
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
      const first = get().clusters[0];
      const card = blankCard(id, { clusterIds: first ? [first.id] : [], ...init, position });
      set({
        selectedCardId: id,
        // Go to wherever it went. + Add > Document and a message dropped from
        // Mail both make a card the board does not draw; without this they make
        // one that appears nowhere at all.
        view: viewFor(card.kind),
      });
      send((board) => doc.addCards(board, [card]));
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
        blankCard(newCardId(), {
          clusterIds: opts?.clusterId ? [opts.clusterId] : [],
          ...d,
          position: positions[i],
        }),
      );

      send((board) => doc.addCards(board, added));
      return [...completedIds, ...added.map((c) => c.id)];
    },

    addImportedMedia(drafts) {
      if (!drafts.length) return;
      const ids = get().addCards(drafts);
      if (!ids.length) return;
      // One file: open it, so its picture/metadata is right there. Several: just go
      // to where they landed — the board unless every one is a record card. Read
      // from the drafts: a new card isn't on the board until the shell says so.
      set({
        view: drafts.some((d) => isBoardKind(d.kind)) ? 'board' : 'record',
        ...(ids.length === 1 ? { selectedCardId: ids[0] } : {}),
      });
    },

    async reprocessCard(id) {
      const card = get().cards.find((c) => c.id === id);
      if (!card) return;

      // Email: re-parse the .eml for attachments the import may have dropped.
      if (card.email?.emlFile) {
        const patch = await recoverCardAttachments(card);
        if (patch) patchCard(id, patch, doc.refreshCard);
        return;
      }

      // Image: re-read EXIF and re-OCR the stored file. Only fills notes from OCR when
      // there are none — a reprocess must not overwrite what the user has written, or
      // their date.
      if (card.imageFile) {
        const draft = await storage.mediaCardDraft(card.imageFile);
        if (!draft) return;
        const patch: Partial<Card> = { imageMeta: draft.imageMeta ?? null };
        if (!card.notes.trim() && draft.notes) patch.notes = draft.notes;
        patchCard(id, patch, doc.refreshCard);
        return;
      }

      // Document: re-read the file's properties into the document payload, keeping
      // what the card calls it.
      if (card.document?.file) {
        const read = (await storage.mediaCardDraft(card.document.file))?.document;
        if (!read) return;
        const { file: _file, name: _name, mime: _mime, ...props } = read;
        patchCard(id, { document: { ...card.document, ...props } }, doc.refreshCard);
      }
    },

    async reprocessAll() {
      // One at a time: reading many large files (a 17MB .eml, a full-res photo) at
      // once would spike memory.
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
      // re-import dialog and no second copy (storing is idempotent by content hash).
      // addCards, not addImportedMedia, so it lands without pulling the user out of
      // the maintenance view onto the new card.
      const draft = await storage.mediaCardDraft(file);
      if (draft) get().addCards([draft]);
    },

    arrangeCards(positions) {
      const moved = new Map<Card, Card>();
      const cards = get().cards.map((card) => {
        const p = positions.get(card.id);
        if (!p || (p.x === card.position.x && p.y === card.position.y)) return card;
        const next = { ...card, position: p };
        moved.set(next, card);
        return next;
      });
      if (!moved.size) return;
      set({ cards });
      const moves = [...moved.keys()].map(({ id, position }) => ({ id, position }));
      send(
        (board) => doc.moveCards(board, moves),
        // Back where they were, unless the shell has since sent the card anew.
        () => set({ cards: get().cards.map((c) => moved.get(c) ?? c) }),
      );
    },

    updateCard(id, patch) {
      patchCard(id, patch, doc.updateCard);
    },

    setIsEvent(cardId, on) {
      const source = get().cards.find((c) => c.id === cardId);
      if (!source) return;
      const existing = eventFor(get().cards, cardId);

      if (on) {
        if (existing) return; // already marked — the checkbox is derived from this
        const event = blankCard(newCardId(), {
          // Named after the source so the milestone reads as the thing that happened;
          // the user can rename it. Beside the source, so it lands sensibly when the
          // source is drawn (a record isn't, but an evidence source is).
          title: source.title || 'Event',
          clusterIds: [...source.clusterIds],
          position: { x: source.position.x + 48, y: source.position.y + 48 },
          kind: 'event',
          occurredAt: source.occurredAt,
          occurredAtPrecision: source.occurredAtPrecision,
          event: { sourceCardId: cardId },
        });
        // With the string from the source to the event it evidences, in one edit.
        send((board) => doc.addCards(board, [event], [newConnection(cardId, event.id, 'evidences')]));
      } else if (existing) {
        // Takes its string with it (deleteCard cascades).
        get().deleteCard(existing.id);
      }
    },

    deleteCard(id) {
      // The string goes with the card (the shell cascades it). A connection is
      // drawn between two cards; one of them gone, it is not a claim any more. The
      // editor counts these first (see touches) so the user is told what they are
      // about to lose rather than finding out later.
      const { cards, selectedCardId } = get();
      const card = cards.find((c) => c.id === id);
      if (!card) return;
      set({
        // The editor reads this. Left pointing at a card that is gone, it would
        // render against undefined.
        selectedCardId: selectedCardId === id ? null : selectedCardId,
        lastDeleted: { kind: 'card', id, label: card.title },
      });
      send((board) => doc.deleteCards(board, [id]));
    },

    undo() {
      drafts.flushAll();
      send(doc.undo);
    },

    redo() {
      drafts.flushAll();
      send(doc.redo);
    },

    toggleCluster(id) {
      const cluster = get().clusters.find((c) => c.id === id);
      if (cluster) get().updateCluster(id, { visible: !cluster.visible });
    },

    addCluster(label) {
      const cluster: Cluster = {
        id: newClusterId(),
        label: label ?? 'New cluster',
        color: CLUSTER_PALETTE[get().clusters.length % CLUSTER_PALETTE.length],
        visible: true,
      };
      send((board) => doc.addCluster(board, cluster));
      return cluster.id;
    },

    updateCluster(id, patch) {
      send((board) => doc.updateCluster(board, id, patch));
    },

    deleteCluster(id) {
      const cluster = get().clusters.find((c) => c.id === id);
      if (!cluster) return;
      set({ lastDeleted: { kind: 'cluster', id, label: cluster.label } });
      send((board) => doc.deleteCluster(board, id));
    },

    addConnection(source, target, label) {
      if (!source || !target || source === target) return;
      const exists = get().connections.some(
        (c) => c.source === source && c.target === target,
      );
      if (exists) return;
      send((board) => doc.addConnections(board, [newConnection(source, target, label)]));
    },

    updateConnection(id, patch) {
      send((board) => doc.updateConnection(board, id, patch));
    },

    deleteConnection(id) {
      send((board) => doc.deleteConnections(board, [id]));
    },

    applyDocChanged(change) {
      const s = get();
      if (change.boardId !== s.currentBoardId) return;
      if (change.meta) setLocalCallingCode(change.meta.countryCode ?? '+61');
      const deleted = s.lastDeleted;
      const stillLast =
        !deleted || !change.meta || [...change.removedCards, ...change.removedClusters].includes(deleted.id);
      set({
        cards: patchRows(s.cards, change.cards, change.removedCards, change.cardOrder),
        connections: patchRows(s.connections, change.connections, change.removedConnections, change.connectionOrder),
        clusters: patchRows(s.clusters, change.clusters, change.removedClusters, change.clusterOrder),
        canUndo: change.canUndo,
        canRedo: change.canRedo,
        ...(stillLast ? {} : { lastDeleted: null }),
        ...(change.meta ? { meta: change.meta } : {}),
        ...(change.viewport ? { viewport: change.viewport } : {}),
        ...(s.selectedCardId && change.removedCards.includes(s.selectedCardId) ? { selectedCardId: null } : {}),
      });
    },

    async exportBundle(ids) {
      // Every edit is already on disk, the open board's included, so each board is
      // read from there. A board that won't load is dropped rather than failing the
      // whole export.
      const gathered = (
        await Promise.all(
          ids.map(async (id) => {
            const board = await storage.loadBoard(id);
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
        set({ lastError: errorMessage(err) });
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
        openDialog({ bundleImportBoards: boards });
      } catch (err) {
        set({ lastError: errorMessage(err) });
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
