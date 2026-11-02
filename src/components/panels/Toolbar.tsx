import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { Button, Menu, MenuItem, MenuItemRadio, SearchInput } from '@wired-square/kit';
import { count } from '@wired-square/kit/core';
import { plus } from '@wired-square/icons/solid';
import { KIND_META, emptyPayloadFor } from '../../lib/kinds';
import { countIssues } from '../../lib/maintenance';
import { DOCUMENT_FILE_FILTER, IMAGE_FILE_FILTER } from '../../lib/fileTypes';
import type { FileFilter } from '../../storage/StorageAdapter';
import { arrangedPositions, type LayoutNode } from '../../lib/autoLayout';
import { primaryClusterId } from '../../lib/clusters';
import { CARD_H, CARD_W } from '../../lib/layout';
import { storage } from '../../storage';
import type { CardKind } from '../../types/board';
import { VIEW_META, type View } from '../../types/view';
import { camera } from '../board/camera';
import { boardStore } from '../../store/boardStore';
import { emailImportStore } from '../../store/emailImportStore';
import { mediaAuditStore } from '../../store/mediaAuditStore';
import { fromStore } from '@wired-square/store/solid';
import { createDebounced } from '../createDebounced';
import { LibraryMcpIndicator } from '../LibraryMcpIndicator';
import { BackgroundTaskIndicator } from '../BackgroundTaskIndicator';

const VIEW_ORDER = Object.keys(VIEW_META) as View[];

export function Toolbar() {
  const title = fromStore(boardStore, (s) => s.meta.title);
  const view = fromStore(boardStore, (s) => s.view);
  const currentBoardId = fromStore(boardStore, (s) => s.currentBoardId);
  const lastError = fromStore(boardStore, (s) => s.lastError);
  const { setView, setSearchQuery, addCard, addImportedMedia, arrangeCards, addCluster } = boardStore.getState();

  // The box owns its text locally so typing is instant; the store — which drives the
  // board dim, record filter and search-lens — is written on a short debounce, so no
  // keystroke waits on that work. Reset when the board changes: hydrate clears the
  // query and this box isn't remounted.
  const [searchText, setSearchText] = createSignal('');
  const debouncedSearch = createDebounced(searchText, 150);
  createEffect(on(currentBoardId, () => setSearchText(''), { defer: true }));
  createEffect(() => setSearchQuery(debouncedSearch()));

  // Each new card lands selected (addCard does that), so the editor opens on it
  // — which is where the name and the addresses get typed. It gets its payload
  // here so the fields are there to type into straight away.
  const add = (kind: CardKind) =>
    addCard({
      title: `New ${KIND_META[kind].label.toLowerCase()}`,
      kind,
      ...emptyPayloadFor(kind),
    });

  // Image and Document both import a file, the same path as the Inbox: the shell
  // stores it, reads its metadata and hands back the card to place.
  const pickAndImport = async (filter: FileFilter) => {
    const paths = await storage.pickPaths(filter, true);
    if (paths.length) addImportedMedia(await storage.importMediaFiles(paths));
  };

  // Tidy the board: untangle the string and pull the cards together (see
  // lib/autoLayout). getNodes() is the drawn set with the canvas's measured sizes,
  // exactly what the layout needs; fitView then frames the result — a frame later,
  // once the new positions have reached the canvas.
  const tidy = () => {
    const cam = camera();
    if (!cam) return;
    const layoutNodes: LayoutNode[] = cam.getNodes().map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      width: n.size?.width ?? CARD_W,
      height: n.size?.height ?? CARD_H,
      // The layout's gravity cluster is the card's primary.
      clusterId: primaryClusterId(n.data.card.clusterIds),
    }));
    const positions = arrangedPositions(layoutNodes, boardStore.getState().connections);
    if (!positions.size) return;
    arrangeCards(positions);
    requestAnimationFrame(() => void cam.fitView({ padding: 0.2, duration: 400 }));
  };

  return (
    <div class="toolbar">
      <div class="toolbar__row">
        <span class="toolbar__title">{title()}</span>
        {/* The three surfaces from one control: the board (what you argue and who
            it is about), the record (what you argue from), and the objects (the
            files themselves). A chooser labelled with the current view, mirroring
            the native View menu — the same dropdown +Add uses. */}
        <Menu tone="default" aria-label={`View: ${VIEW_META[view()].label}`} trigger={VIEW_META[view()].label} chevron>
          <For each={VIEW_ORDER}>
            {(v) => (
              <MenuItemRadio checked={v === view()} onSelect={() => setView(v)}>
                {VIEW_META[v].label}
              </MenuItemRadio>
            )}
          </For>
        </Menu>
        {/* One search for whichever view is showing: it dims the board's
            non-matches and drops the record's, the objects view's and the
            timeline's. */}
        <SearchInput
          class="toolbar__search"
          label="Search"
          value={searchText()}
          onValue={setSearchText}
          placeholder={`Search ${VIEW_META[view()].label.toLowerCase()}…`}
        />
        <div class="toolbar__actions">
          {/* The Objects view isn't a place you add cards — its files come from
              import and the disk — so Add gives way to a count of what's there. */}
          <Show when={view() !== 'object'} fallback={<ObjectsBadge />}>
            {/* Ordered as the board is built: the actors you are investigating,
                then the record, then what you make of it. 'Card' stays first and
                unqualified because it is the one you reach for without thinking —
                it makes an evidence card, and the editor can change its kind. */}
            <Menu
              tone="default"
              aria-label="Add"
              trigger={
                <>
                  {plus()} Add
                </>
              }
              chevron
            >
              <MenuItem onSelect={() => addCard()}>Card</MenuItem>
              <MenuItem onSelect={() => void pickAndImport(IMAGE_FILE_FILTER)}>Image</MenuItem>
              <MenuItem onSelect={() => add('person')}>Person</MenuItem>
              <MenuItem onSelect={() => add('organisation')}>Organisation</MenuItem>
              <MenuItem onSelect={() => void pickAndImport(DOCUMENT_FILE_FILTER)}>Document</MenuItem>
              <MenuItem onSelect={() => emailImportStore.getState().openWith()}>Email</MenuItem>
              <MenuItem onSelect={() => add('message')}>Message</MenuItem>
              <MenuItem onSelect={() => add('call')}>Call</MenuItem>
              <MenuItem onSelect={() => add('event')}>Event</MenuItem>
              <MenuItem onSelect={() => addCluster()}>Cluster</MenuItem>
            </Menu>
          </Show>
          {/* Only in board view — Tidy arranges what the board draws. It untangles
              the string and pulls the cards in; the record has no positions. */}
          <Show when={view() === 'board'}>
            <Button onClick={tidy} title="Untangle the string and bring the cards together">
              Tidy
            </Button>
          </Show>
          {/* Board management lives in the native File menu now
              (src-tauri/src/menu.rs); autosave means there is no Save item to
              miss. A failed save is what's worth showing — the strip below. */}
        </div>
        <LibraryMcpIndicator />
        <BackgroundTaskIndicator />
      </div>
      <Show when={lastError()}>
        <div class="toolbar__error" role="alert">
          {lastError()}
        </div>
      </Show>
    </div>
  );
}

/**
 * The Objects view's file count, standing where Add would be. Reads the shared
 * media audit so it agrees with the list, and shows the view's transient operation line
 * ("· Reprocessing…") while a bulk action runs. The count is the library total, not the
 * filtered view — the list itself reflects the search and the "Only issues" filter.
 */
function ObjectsBadge() {
  const rows = fromStore(mediaAuditStore, (s) => s.rows);
  const loading = fromStore(mediaAuditStore, (s) => s.loading);
  const status = fromStore(mediaAuditStore, (s) => s.status);
  const label = () => {
    const issueCount = countIssues(rows());
    return `${count(rows().length, 'file')}${issueCount ? ` · ${issueCount} to look at` : ''}`;
  };
  return (
    <span class="objects-badge">
      {VIEW_META.object.label} · {loading() ? 'reading the library…' : label()}
      {status() && ` · ${status()}`}
    </span>
  );
}
