import { useState, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useBoardStore } from '../../store/boardStore';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEmailImportStore } from '../../store/emailImportStore';
import { useMediaAuditStore } from '../../store/mediaAuditStore';
import { KIND_META, emptyPayloadFor } from '../../lib/kinds';
import { countIssues } from '../../lib/maintenance';
import { plural } from '../../lib/format';
import { DOCUMENT_FILE_ACCEPT, IMAGE_FILE_ACCEPT } from '../../lib/import/files';
import { arrangedPositions, type LayoutNode } from '../../lib/autoLayout';
import { primaryClusterId } from '../../lib/clusters';
import { CARD_H, CARD_W } from '../../lib/layout';
import { storage } from '../../storage';
import type { CardKind } from '../../types/board';
import type { CardNode } from '../../types/reactflow';
import { VIEW_META, type View } from '../../types/view';
import { Menu } from '../ui/Menu';

const VIEW_ORDER = Object.keys(VIEW_META) as View[];

export function Toolbar() {
  const title = useBoardStore((s) => s.meta.title);
  const view = useBoardStore((s) => s.view);
  const setView = useBoardStore((s) => s.setView);
  const setSearchQuery = useBoardStore((s) => s.setSearchQuery);
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  const addCard = useBoardStore((s) => s.addCard);
  const addImportedMedia = useBoardStore((s) => s.addImportedMedia);
  const arrangeCards = useBoardStore((s) => s.arrangeCards);
  const connections = useBoardStore((s) => s.connections);
  const addCluster = useBoardStore((s) => s.addCluster);
  const lastError = useBoardStore((s) => s.lastError);
  const openEmailImport = useEmailImportStore((s) => s.openWith);
  const { getNodes, fitView } = useReactFlow<CardNode>();

  // The box owns its text locally so typing is instant; the store — which drives the
  // board dim, record filter and search-lens — is written on a short debounce, so no
  // keystroke waits on that work. Reset when the board changes: hydrate clears the
  // query and this box isn't remounted.
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebouncedValue(searchText, 150);
  useEffect(() => setSearchText(''), [currentBoardId]);
  useEffect(() => setSearchQuery(debouncedSearch), [debouncedSearch, setSearchQuery]);

  // Each new card lands selected (addCard does that), so the editor opens on it
  // — which is where the name and the addresses get typed. It gets its payload
  // here so the fields are there to type into straight away.
  const add = (kind: CardKind) =>
    addCard({
      title: `New ${KIND_META[kind].label.toLowerCase()}`,
      kind,
      ...emptyPayloadFor(kind),
    });

  // Image and Document both import a file (the same path as dropping one in): pick,
  // then let the store save it, read its metadata, and make the right card.
  const pickAndImport = async (accept: string) => {
    const files = await storage.pickFiles(accept, true);
    if (files.length) await addImportedMedia(files);
  };

  // Tidy the board: untangle the string and pull the cards together (see
  // lib/autoLayout). getNodes() is the drawn set with React Flow's measured sizes,
  // exactly what the layout needs; fitView then frames the result — a frame later,
  // once the new positions have been committed to the flow.
  const tidy = () => {
    const layoutNodes: LayoutNode[] = getNodes().map((n) => ({
      id: n.id,
      position: n.position,
      width: n.measured?.width ?? CARD_W,
      height: n.measured?.height ?? CARD_H,
      // The layout's gravity cluster is the card's primary.
      clusterId: primaryClusterId(n.data.card.clusterIds),
    }));
    const positions = arrangedPositions(layoutNodes, connections);
    if (!positions.size) return;
    arrangeCards(positions);
    requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 400 }));
  };

  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <span className="toolbar__title">{title}</span>
        {/* The three surfaces from one control: the board (what you argue and who
            it is about), the record (what you argue from), and the objects (the
            files themselves). A chooser labelled with the current view, mirroring
            the native View menu — the same dropdown +Add uses. */}
        <Menu
          label={VIEW_META[view].label}
          selectedLabel={VIEW_META[view].label}
          items={VIEW_ORDER.map((v) => ({
            label: VIEW_META[v].label,
            onSelect: () => setView(v),
          }))}
        />
        {/* One search for whichever view is showing: it dims the board's
            non-matches and drops the record's, the objects view's and the
            timeline's. type="search" gives the native clear affordance. */}
        <input
          className="toolbar__search"
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={`Search ${VIEW_META[view].label.toLowerCase()}…`}
          aria-label="Search"
        />
        <div className="toolbar__actions">
          {/* The Objects view isn't a place you add cards — its files come from
              import and the disk — so "+ Add" gives way to a count of what's there. */}
          {view === 'object' ? (
            <ObjectsBadge />
          ) : (
            /* Ordered as the board is built: the actors you are investigating,
               then the record, then what you make of it. 'Card' stays first and
               unqualified because it is the one you reach for without thinking —
               it makes an evidence card, and the editor can change its kind. */
            <Menu
              label="+ Add"
              items={[
                { label: 'Card', onSelect: () => addCard() },
                { label: 'Image', onSelect: () => void pickAndImport(IMAGE_FILE_ACCEPT) },
                { label: 'Person', onSelect: () => add('person') },
                { label: 'Organisation', onSelect: () => add('organisation') },
                { label: 'Document', onSelect: () => void pickAndImport(DOCUMENT_FILE_ACCEPT) },
                { label: 'Email', onSelect: () => openEmailImport() },
                { label: 'Message', onSelect: () => add('message') },
                { label: 'Call', onSelect: () => add('call') },
                { label: 'Event', onSelect: () => add('event') },
                { label: 'Cluster', onSelect: () => addCluster() },
              ]}
            />
          )}
          {/* Only in board view — Tidy arranges what the board draws. It untangles
              the string and pulls the cards in; the record has no positions. */}
          {view === 'board' && (
            <button onClick={tidy} title="Untangle the string and bring the cards together">
              Tidy
            </button>
          )}
          {/* Board management lives in the native File menu now
              (src-tauri/src/menu.rs); autosave means there is no Save item to
              miss. A failed save is what's worth showing — the strip below. */}
        </div>
      </div>
      {lastError && (
        <div className="toolbar__error" role="alert">
          {lastError}
        </div>
      )}
    </div>
  );
}

/**
 * The Objects view's file count, standing where "+ Add" would be. Reads the shared
 * media audit so it agrees with the list, and shows the view's transient operation line
 * ("· Reprocessing…") while a bulk action runs. The count is the library total, not the
 * filtered view — the list itself reflects the search and the "Only issues" filter.
 */
function ObjectsBadge() {
  const rows = useMediaAuditStore((s) => s.rows);
  const loading = useMediaAuditStore((s) => s.loading);
  const status = useMediaAuditStore((s) => s.status);
  const issueCount = countIssues(rows);
  const count = `${plural(rows.length, 'file')}${issueCount ? ` · ${issueCount} to look at` : ''}`;
  return (
    <span className="objects-badge">
      {VIEW_META.object.label} · {loading ? 'reading the library…' : count}
      {status && ` · ${status}`}
    </span>
  );
}
