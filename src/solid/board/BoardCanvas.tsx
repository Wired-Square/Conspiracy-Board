/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import { Canvas, useCanvas } from '@wired-square/canvas';
import { floatingAnchors, type EdgeGeometry } from '@wired-square/canvas/core';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';
import { gradeTint } from '../../lib/grades';
import { highlight, linkDegrees, tieScaleInterner } from '../../lib/highlight';
import { CARD_H, CARD_W } from '../../lib/layout';
import { allSuggestedLinks, buildRoster } from '../../lib/roster';
import { drawnCardIds, linksWithin, searchMatchIds } from '../../lib/visibility';
import { yarnPath } from '../../lib/yarn';
import { boardStore } from '../../store/boardStore';
import { projectionStore } from '../../components/canvas/projection';
import type { CardNodeData, StringEdge, StringEdgeData } from '../../types/canvas';
import type { Viewport } from '../../types/board';
import { fromStore } from '../fromStore';
import { EvidenceCard } from './EvidenceCard';
import { camera, setCamera, withFitWhenDrawn } from './camera';

export { CanvasPanel } from '@wired-square/canvas';

function PublishCamera() {
  const handle = useCanvas<CardNodeData, StringEdgeData>();
  createEffect(() => {
    const base = handle();
    if (!base) return;
    const published = withFitWhenDrawn(base);
    setCamera(published);
    onCleanup(() => setCamera((current) => (current === published ? null : current)));
  });
  return null;
}

// Search is a transient lens: matches drawn on the board are framed, and clearing
// the box goes back to where the first frame left from.
function createSearchLens(matchIds: Accessor<Set<string> | null>) {
  let preSearch: Viewport | null = null;
  createEffect(() => {
    const cam = camera();
    const matches = matchIds();
    if (!cam) return;
    if (!matches) {
      if (preSearch) void cam.setViewport(preSearch, { duration: 300 });
      preSearch = null;
      return;
    }
    preSearch ??= cam.getViewport();
    if (matches.size) void cam.fitView({ ids: [...matches], maxZoom: 1.2, padding: 0.2, duration: 400 });
  });
}

function RedString(props: { edge: StringEdge; geometry: EdgeGeometry }) {
  // A derived link is one faint strand with no knots, always the Inference violet:
  // the app inferred it, and it must not read as tied by hand.
  const participant = () => props.edge.data.variant === 'participant';
  const ends = createMemo(() => floatingAnchors(props.geometry.source, props.geometry.target));
  const path = createMemo(() => yarnPath(ends().source.x, ends().source.y, ends().target.x, ends().target.y).path);
  const grade = () => (participant() ? 'inference' : props.edge.data.grade);
  return (
    <g style={grade() ? gradeTint(grade()!) : undefined}>
      <Show when={!participant()} fallback={<path class="derived-string__strand" d={path()} />}>
        <path class="red-string__shadow" d={path()} />
        <path class="red-string__strand" d={path()} />
        <path class="red-string__sheen" d={path()} />
        <circle class="red-string__knot" r="4" cx={ends().source.x} cy={ends().source.y} />
        <circle class="red-string__knot" r="4" cx={ends().target.x} cy={ends().target.y} />
      </Show>
    </g>
  );
}

function StringTag(props: { label: string; geometry: EdgeGeometry }) {
  const at = createMemo(() => {
    const { source, target } = floatingAnchors(props.geometry.source, props.geometry.target);
    return yarnPath(source.x, source.y, target.x, target.y);
  });
  return (
    <div
      class="red-string__tag"
      style={{ transform: `translate(-50%, -50%) translate(${at().labelX}px, ${at().labelY}px) rotate(-2deg)` }}
    >
      {props.label}
    </div>
  );
}

export function BoardCanvas() {
  const cards = fromStore(boardStore, (s) => s.cards);
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const selectedCardId = fromStore(boardStore, (s) => s.selectedCardId);
  const searchQuery = fromStore(boardStore, (s) => s.searchQuery);
  const nodes = fromStore(projectionStore, (s) => s.nodes);
  const edges = fromStore(projectionStore, (s) => s.edges);
  const { viewport, setViewport, selectCard, arrangeCards, addConnection } = boardStore.getState();

  // Filtered here, not in the projection, which keeps a node per card so a kind
  // switch works both ways; the canvas simply declines to draw.
  const drawnIds = createMemo(() => drawnCardIds(cards(), clusters()));
  const drawnNodes = createMemo(() => nodes().filter((n) => drawnIds().has(n.id)));
  const drawnEdges = createMemo(() => linksWithin(edges(), drawnIds()));
  const matchIds = createMemo(() => searchMatchIds(cards(), drawnIds(), searchQuery()));
  createSearchLens(matchIds);

  // Hover wins while it lasts; selection is what focus falls back to.
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);

  // Derived links never reach the store or disk, and can't be selected: a suggestion
  // isn't something to grade or cut.
  const roster = createMemo(() => buildRoster(cards()));
  const allEdges = createMemo((): StringEdge[] => {
    const derived = allSuggestedLinks(roster(), drawnIds(), drawnEdges()).map(({ source, target }) => ({
      id: `derived:${source}:${target}`,
      source,
      target,
      data: { variant: 'participant' as const },
    }));
    return derived.length ? [...drawnEdges(), ...derived] : drawnEdges();
  });
  const degrees = createMemo(() => linkDegrees(allEdges()));
  const dataFor = tieScaleInterner<CardNodeData>();
  const display = createMemo(() =>
    highlight(
      drawnNodes(),
      allEdges(),
      { focusId: hoveredId() ?? selectedCardId(), selectedId: selectedCardId(), matchIds: matchIds(), degrees: degrees() },
      dataFor,
    ),
  );

  return (
    <Canvas<CardNodeData, StringEdgeData>
      class="board-canvas"
      nodes={display().nodes}
      edges={display().edges}
      node={(node) => <EvidenceCard data={node().data} selected={node().id === selectedCardId()} />}
      edge={(edge, geometry) => <RedString edge={edge()} geometry={geometry()} />}
      edgeLabel={(edge, geometry) => (
        <Show when={edge().data.label}>{(label) => <StringTag label={label()} geometry={geometry()} />}</Show>
      )}
      onNodeClick={(node) => selectCard(node.id)}
      onNodeEnter={(node) => setHoveredId(node.id)}
      onNodeLeave={() => setHoveredId(null)}
      onPaneClick={() => selectCard(null)}
      onNodeDragEnd={(node, position) => arrangeCards(new Map([[node.id, position]]))}
      onConnect={addConnection}
      onMoveEnd={setViewport}
      viewport={viewport}
      minZoom={0.2}
      maxZoom={2.5}
      unmeasuredSize={{ width: CARD_W, height: CARD_H }}
      background={{ gap: 28, size: 1.5 }}
      controls
      minimap={{ nodeColour: (node) => node.data.clusterColor ?? NO_CLUSTER_ACCENT }}
    >
      <PublishCamera />
    </Canvas>
  );
}
