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
import type { CardNode } from '../types/reactflow';

export function BoardCanvas() {
  const cards = useBoardStore((s) => s.cards);
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

  // Cluster visibility → which cards (and therefore edges) are shown.
  // The predicate is shared with the timeline; see lib/clusters.
  const hidden = useMemo(() => hiddenClusterIds(clusters), [clusters]);

  // Two reasons a card is not drawn: every cluster it is in is hidden, or it is
  // the record and belongs in the Record view.
  //
  // Which ids are visible is derived from `cards`, not `nodes`: during a drag
  // the store rebuilds `nodes` every pointermove but leaves `cards` alone until
  // the drag settles (see onNodesChange), so everything keyed on this set — the
  // participant edges above all — stays put through a drag instead of
  // recomputing per frame.
  //
  // The filter lives in the canvas rather than the mappers on purpose. The
  // store keeps a node for every card and updateCard *maps over* that array in
  // place — it never adds or removes — so a mapper-level filter would break
  // switching kind in both directions: evidence→email would strand a node on
  // the canvas, and email→evidence would never get one. The canvas simply
  // declines to draw.
  const visibleNodeIds = useMemo(
    () =>
      new Set(
        cards
          .filter((c) => isVisible(c.clusterIds, hidden) && isBoardKind(c.kind))
          .map((c) => c.id),
      ),
    [cards, hidden],
  );

  const visibleNodes = useMemo(
    () => nodes.filter((n) => visibleNodeIds.has(n.id)),
    [nodes, visibleNodeIds],
  );

  // The cards the search matches, among those actually drawn — null when nothing
  // is being searched, which the highlight pass reads as "don't dim by search".
  // The board keeps every match in place and fades the rest, so a search reads
  // the argument without redrawing it. This is the in-memory entity matcher
  // (names, addresses, numbers) — full text is the timeline's search, not this.
  // From `cards`, like visibleNodeIds, so it too holds still during a drag.
  const matchIds = useMemo(() => {
    const q = normaliseQuery(searchQuery);
    if (!q) return null;
    return new Set(
      cards
        .filter((c) => visibleNodeIds.has(c.id) && cardMatchesEntity(c, q))
        .map((c) => c.id),
    );
  }, [cards, visibleNodeIds, searchQuery]);

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
      defaultViewport={viewport}
      fitView={!viewport}
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={2.5}
      // Mount DOM only for nodes in view: an mbox import can put hundreds of
      // image-bearing cards on the board, and off-screen ones need no <img>.
      // Selection and fitView work off the store/internal node set, not the DOM.
      onlyRenderVisibleElements
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
