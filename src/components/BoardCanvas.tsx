import { useMemo, useState, useEffect, useRef } from 'react';
import { EvidenceCard } from './nodes/EvidenceCard';
import { useHighlightConnections } from '../hooks/useHighlightConnections';
import { useParticipantEdges } from '../hooks/useParticipantEdges';
import { useRoster } from '../hooks/useRoster';
import { NO_CLUSTER_ACCENT } from '../lib/clusters';
import { drawnCardIds, linksWithin, searchMatchIds } from '../lib/visibility';
import { CARD_H, CARD_W } from '../lib/layout';
import type { Viewport } from '../types/board';
import { boardStore } from '../store/boardStore';
import { useBoardStore } from '../hooks/useStores';
import { Canvas, useCamera } from './canvas/Canvas';
import { mountRedString } from './canvas/redString';
import { useProjection } from './canvas/projection';

export function BoardCanvas() {
  const cards = useBoardStore((s) => s.cards);
  const nodes = useProjection((s) => s.nodes);
  const edges = useProjection((s) => s.edges);
  const clusters = useBoardStore((s) => s.clusters);
  const [savedViewport] = useState(() => boardStore.getState().viewport);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const searchQuery = useBoardStore((s) => s.searchQuery);

  const setViewport = useBoardStore((s) => s.setViewport);
  const selectCard = useBoardStore((s) => s.selectCard);
  const arrangeCards = useBoardStore((s) => s.arrangeCards);
  const addConnection = useBoardStore((s) => s.addConnection);

  // The filter lives here rather than in the projection on purpose. The
  // projection keeps a node for every card, so switching kind works in both
  // directions: a filter there would have to add and drop nodes as a card's kind
  // changes. The canvas simply declines to draw.
  const visibleNodeIds = useMemo(() => drawnCardIds(cards, clusters), [cards, clusters]);

  const visibleNodes = useMemo(
    () => nodes.filter((n) => visibleNodeIds.has(n.id)),
    [nodes, visibleNodeIds],
  );

  // The board keeps every search match in place and fades the rest, so a search
  // reads the argument without redrawing it. This is the in-memory entity matcher
  // (names, addresses, numbers) — full text is the timeline's search, not this.
  const matchIds = useMemo(
    () => searchMatchIds(cards, visibleNodeIds, searchQuery),
    [cards, visibleNodeIds, searchQuery],
  );

  // Frame the search: when a settled query has matches drawn on the board, move
  // the viewport to them — one match zooms in and centres, several fit together
  // within view — and restore the pre-search viewport when the box is cleared.
  // A transient lens: searching takes you to look, clearing brings you home.
  // The toolbar debounces its store write, so this fires when typing pauses.
  const camera = useCamera();
  const preSearchViewport = useRef<Viewport | null>(null);
  // matchIds is null exactly when the query is empty (see the memo above), so this
  // needs no second normalise.
  const searching = matchIds !== null;

  useEffect(() => {
    if (!camera) return;
    if (!searching) {
      // Box cleared — return to where we were, once, then forget it.
      if (preSearchViewport.current) {
        void camera.setViewport(preSearchViewport.current, { duration: 300 });
        preSearchViewport.current = null;
      }
      return;
    }
    // Remember where we were before the first frame, so clearing can bring us back.
    preSearchViewport.current ??= camera.getViewport();
    // Nothing drawn to frame (matches live only in the record) — leave the view put.
    if (matchIds?.size) void camera.fitView({ ids: [...matchIds], maxZoom: 1.2, padding: 0.2, duration: 400 });
  }, [camera, searching, matchIds]);

  const visibleEdges = useMemo(() => linksWithin(edges, visibleNodeIds), [edges, visibleNodeIds]);

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

  return (
    <Canvas
      nodes={displayNodes}
      edges={displayEdges}
      renderNode={(node) => <EvidenceCard data={node.data} selected={!!node.selected} />}
      mountEdge={mountRedString}
      onNodeClick={(node) => selectCard(node.id)}
      onNodeEnter={(node) => setHoveredId(node.id)}
      onNodeLeave={() => setHoveredId(null)}
      onPaneClick={() => selectCard(null)}
      onNodeDragEnd={(node, position) => arrangeCards(new Map([[node.id, position]]))}
      onConnect={addConnection}
      onMoveEnd={setViewport}
      viewport={savedViewport}
      minZoom={0.2}
      maxZoom={2.5}
      unmeasuredSize={{ width: CARD_W, height: CARD_H }}
      background={{ gap: 28, size: 1.5 }}
      controls
      minimap={{ nodeColour: (node) => node.data.clusterColor ?? NO_CLUSTER_ACCENT }}
    />
  );
}
