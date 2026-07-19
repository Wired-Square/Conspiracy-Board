import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type NodeMouseHandler,
  type Viewport as RFViewport,
} from '@xyflow/react';
import { useBoardStore } from '../store/boardStore';
import { nodeTypes } from './nodes/nodeTypes';
import { edgeTypes } from './edges/edgeTypes';
import { useHighlightConnections } from '../hooks/useHighlightConnections';
import { useParticipantEdges } from '../hooks/useParticipantEdges';
import { useRoster } from '../hooks/useRoster';
import { hiddenClusterIds, isVisible, NO_CLUSTER_ACCENT } from '../lib/clusters';
import { isBoardKind } from '../lib/kinds';
import { cardMatchesEntity, normaliseQuery } from '../lib/search';
import { useEmailImportStore } from '../store/emailImportStore';
import { isEmailFile } from '../lib/email/files';
import { isMediaFile } from '../lib/import/files';
import { toPickedFiles } from '../storage/StorageAdapter';
import { readMailDrop } from '../lib/email/mailDrag';
import { alert } from '../store/promptStore';
import type { CardNode } from '../types/reactflow';

export function BoardCanvas() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const clusters = useBoardStore((s) => s.clusters);
  const viewport = useBoardStore((s) => s.viewport);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const searchQuery = useBoardStore((s) => s.searchQuery);

  const onNodesChange = useBoardStore((s) => s.onNodesChange);
  const onEdgesChange = useBoardStore((s) => s.onEdgesChange);
  const onConnect = useBoardStore((s) => s.onConnect);
  const setViewport = useBoardStore((s) => s.setViewport);
  const selectCard = useBoardStore((s) => s.selectCard);
  const addCard = useBoardStore((s) => s.addCard);
  const addImportedMedia = useBoardStore((s) => s.addImportedMedia);

  const openImport = useEmailImportStore((s) => s.openWith);
  const parseFiles = useEmailImportStore((s) => s.parseFiles);

  // Cluster visibility → which cards (and therefore edges) are shown.
  // The predicate is shared with the timeline; see lib/clusters.
  const hidden = useMemo(() => hiddenClusterIds(clusters), [clusters]);

  // Two reasons a node is not drawn: its cluster is hidden, or it is the record
  // and belongs in the Record view.
  //
  // The filter is here rather than in the mappers on purpose. The store keeps a
  // node for every card and updateCard *maps over* that array in place — it
  // never adds or removes — so a mapper-level filter would break switching kind
  // in both directions: evidence→email would strand a node on the canvas, and
  // email→evidence would never get one. The canvas simply declines to draw.
  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (n) => isVisible(n.data.card.clusterId, hidden) && isBoardKind(n.data.card.kind),
      ),
    [nodes, hidden],
  );

  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes],
  );

  // The cards the search matches, among those actually drawn — null when nothing
  // is being searched, which the highlight pass reads as "don't dim by search".
  // The board keeps every match in place and fades the rest, so a search reads
  // the argument without redrawing it. This is the in-memory entity matcher
  // (names, addresses, numbers) — full text is the timeline's search, not this.
  const matchIds = useMemo(() => {
    const q = normaliseQuery(searchQuery);
    if (!q) return null;
    return new Set(
      visibleNodes.filter((n) => cardMatchesEntity(n.data.card, q)).map((n) => n.id),
    );
  }, [visibleNodes, searchQuery]);

  // Frame the search: when a settled query has matches drawn on the board, move
  // the viewport to them — one match zooms in and centres, several fit together
  // within view — and restore the pre-search viewport when the box is cleared.
  // A transient lens: searching takes you to look, clearing brings you home.
  // The toolbar debounces its store write, so this fires when typing pauses.
  // React Flow's own viewport controls — the animated camera. Distinct from the
  // store's setViewport above, which persists the viewport the user pans to.
  const { fitView, getViewport, setViewport: moveViewport } = useReactFlow();
  const preSearchViewport = useRef<RFViewport | null>(null);
  // matchIds is null exactly when the query is empty (see the memo above), so this
  // needs no second normalise.
  const searching = matchIds !== null;

  useEffect(() => {
    if (!searching) {
      // Box cleared — return to where we were, once, then forget it.
      if (preSearchViewport.current) {
        void moveViewport(preSearchViewport.current, { duration: 300 });
        preSearchViewport.current = null;
      }
      return;
    }
    // Remember where we were before the first frame, so clearing can bring us back.
    if (!preSearchViewport.current) preSearchViewport.current = getViewport();
    // Nothing drawn to frame (matches live only in the record) — leave the view put.
    if (matchIds?.size) {
      void fitView({
        nodes: [...matchIds].map((id) => ({ id })),
        maxZoom: 1.2,
        padding: 0.2,
        duration: 400,
      });
    }
  }, [searching, matchIds, fitView, getViewport, moveViewport]);

  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [edges, visibleNodeIds],
  );

  // Hover lives here, not in the store: it changes on every pointermove, and the
  // store is deliberately the canonical board plus one scalar of UI state.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // What the board is answering questions about. Hover wins while it lasts;
  // selection is what it falls back to, so letting go of a card leaves the
  // thing you were reading still strung.
  const focusId = hoveredId ?? selectedCardId;

  const roster = useRoster();
  const participantEdges = useParticipantEdges(roster, visibleNodeIds, visibleEdges);

  // The derived strings join the real ones before the highlight pass. They are
  // on the board whether or not anything is focused; when a card is focused, that
  // pass dims the ones that don't touch it, exactly as it does any other edge.
  const allEdges = useMemo(
    () => (participantEdges.length ? [...visibleEdges, ...participantEdges] : visibleEdges),
    [visibleEdges, participantEdges],
  );

  const { nodes: displayNodes, edges: displayEdges } = useHighlightConnections(
    visibleNodes,
    allEdges,
    focusId,
    selectedCardId,
    matchIds,
  );

  const handleNodeClick: NodeMouseHandler<CardNode> = useCallback(
    (_, node) => selectCard(node.id),
    [selectCard],
  );

  const handleNodeMouseEnter: NodeMouseHandler<CardNode> = useCallback(
    (_, node) => setHoveredId(node.id),
    [],
  );

  const handleNodeMouseLeave = useCallback(() => setHoveredId(null), []);

  const handlePaneClick = useCallback(() => selectCard(null), [selectCard]);

  const handleMoveEnd = useCallback(
    (_: unknown, vp: RFViewport) => setViewport(vp),
    [setViewport],
  );

  // React Flow doesn't consume drop events, so the pane can host a drop target.
  // Dropped mail opens the same preview modal as the toolbar rather than landing
  // silently: an mbox can hold hundreds of messages and there is no undo.
  //
  // The canvas claims every drag it is offered. Anything it doesn't claim, the
  // browser handles — and the browser's idea of handling a dropped message or
  // link is to navigate to it, which throws the user out of their board.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      // Before anything else, and unconditionally: returning early without this
      // hands the drop back to the browser, whose idea of handling a dropped
      // message or link is to navigate away from the board.
      e.preventDefault();

      // Read every string synchronously — DataTransfer is neutered after the
      // first await, so anything not taken now is gone.
      const uriList = e.dataTransfer.getData('text/uri-list');
      const text = e.dataTransfer.getData('text/plain');
      const all = Array.from(e.dataTransfer.files);
      const types = Array.from(e.dataTransfer.types);
      // Email keeps its own path (a preview modal, since an mbox can be hundreds of
      // messages); images and documents import straight to cards. A drop may mix
      // both, so route each set rather than choosing one.
      const emails = all.filter((f) => isEmailFile(f.name));
      const media = all.filter((f) => isMediaFile(f.name));

      if (emails.length) {
        openImport();
        await parseFiles(await toPickedFiles(emails));
      }
      if (media.length) {
        await addImportedMedia(await toPickedFiles(media));
      }
      if (emails.length || media.length) return;

      // Apple Mail hands the page no file — only the subject and a message: URL.
      // That's still the card worth making, and it carries the Message-ID: the
      // shell is already fetching the body from Mail's file promise, and will
      // complete this very card by matching on it (see src/platform/mailDrops.ts).
      const draft = readMailDrop(uriList, text);
      if (draft) {
        // Lands in the record, not here — the board does not draw mail. addCard
        // goes to wherever the card went, so a drop cannot look like the board
        // swallowing it.
        addCard(draft);
        return;
      }

      // dragOver promised 'copy', so a drop that quietly does nothing reads as a
      // bug. Say why, in a dialog rather than a banner that is easy to miss. A
      // *single* Apple Mail message brings a message: URL and is handled above;
      // what lands here is a whole conversation (only plain text reaches the page,
      // no message it can take) or a browser-tab message (a link, not the mail) —
      // both of which the Inbox folder handles. Details carries what the drop
      // actually offered, for when that guess is wrong.
      if (uriList || text || all.length) {
        void alert({
          title: 'Nothing here to import',
          message:
            'Drag one message from Apple Mail, or drop an image, document, .eml or .mbox file. ' +
            'A whole conversation — or a message dragged from a browser tab (Gmail, Outlook on ' +
            'the web) — doesn’t hand over the message itself. To bring in a thread, drag it onto ' +
            'the Conspiracy Inbox folder (File ▸ Show Inbox Folder) and its messages import on their own.',
          confirmLabel: 'OK',
          details: [
            `Types: ${types.join(', ') || '(none)'}`,
            all.length ? `Files: ${all.map((f) => f.name).join(', ')}` : '',
            uriList ? `URLs: ${uriList.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).join(' | ')}` : '',
            text ? `Text: ${text.slice(0, 200)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
    },
    [openImport, parseFiles, addCard, addImportedMedia],
  );

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={handleNodeMouseEnter}
      onNodeMouseLeave={handleNodeMouseLeave}
      onPaneClick={handlePaneClick}
      onMoveEnd={handleMoveEnd}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
      defaultViewport={viewport}
      fitView={!viewport}
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#3a3026" />
      <Controls />
      <MiniMap
        nodeColor={(n) => (n as CardNode).data.clusterColor ?? NO_CLUSTER_ACCENT}
        maskColor="rgba(15, 12, 9, 0.7)"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}
