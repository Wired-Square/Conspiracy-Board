import { For, Show, createRenderEffect, createSignal } from 'solid-js';
import { Button, IconButton } from '@wired-square/kit';
import { chevronDown, chevronRight, plus, trash } from '@wired-square/icons/solid';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';
import { createDraft } from '../createDraft';
import { NO_CLUSTER_ACCENT } from '../../lib/clusters';
import type { Cluster } from '../../types/board';

export function ClusterPanel() {
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const unclusteredShown = fromStore(boardStore, (s) => !s.meta.unclusteredHidden);
  const [open, setOpen] = createSignal(true);
  // Rows by id, not by object: a write replaces the cluster, and a remounted row
  // would drop the field the user is still typing in.
  const clusterIds = () => clusters().map((c) => c.id);

  return (
    <div class="cluster-panel">
      <div class="cluster-panel__head">
        <Show when={clusters().length}>
          <ShowAll shown={clusters().filter((c) => c.visible).length + Number(unclusteredShown())} of={clusters().length + 1} />
        </Show>
        <Button tone="plain" class="cluster-panel__toggle" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
          Clusters
          {open() ? chevronDown() : chevronRight()}
        </Button>
      </div>
      <Show when={open()}>
        <div class="cluster-panel__list">
          <For each={clusterIds()}>{(id) => <ClusterRow cluster={clusters().find((c) => c.id === id)!} />}</For>
          <div class="cluster-row cluster-row--none">
            <input
              type="checkbox"
              checked={unclusteredShown()}
              onChange={() => boardStore.getState().toggleUnclustered()}
              title="Show/hide cards in no cluster"
            />
            <span class="cluster-swatch" style={{ background: NO_CLUSTER_ACCENT }} />
            <span class="cluster-label">No cluster</span>
          </div>
          <Button class="cluster-add" onClick={() => boardStore.getState().addCluster()}>
            {plus()} Add cluster
          </Button>
        </div>
      </Show>
    </div>
  );
}

function ShowAll(props: { shown: number; of: number }) {
  const all = () => props.shown === props.of;
  return (
    <input
      type="checkbox"
      class="cluster-show-all"
      checked={all()}
      ref={(box) => createRenderEffect(() => (box.indeterminate = props.shown > 0 && !all()))}
      onChange={() => boardStore.getState().setClustersVisible(!all())}
      aria-label="Show all clusters"
      title={all() ? 'Hide all' : 'Show all'}
    />
  );
}

function ClusterRow(props: { cluster: Cluster }) {
  const { toggleCluster, updateCluster, deleteCluster } = boardStore.getState();
  const id = props.cluster.id;
  // The colour picker reports every step of a drag, so it drafts like the label.
  const [color, setColor, flushColor] = createDraft(() => props.cluster.color, (color) => updateCluster(id, { color }));
  const [label, setLabel, flushLabel] = createDraft(() => props.cluster.label, (label) => updateCluster(id, { label }));

  return (
    <div class="cluster-row">
      <input type="checkbox" checked={props.cluster.visible} onChange={() => toggleCluster(id)} title="Show/hide" />
      <input
        type="color"
        class="cluster-color"
        value={color()}
        onInput={(e) => setColor(e.currentTarget.value)}
        onBlur={flushColor}
        title="Colour"
      />
      <input
        class="app-field__input cluster-label"
        value={label()}
        title={label()}
        onInput={(e) => setLabel(e.currentTarget.value)}
        onBlur={flushLabel}
      />
      <IconButton class="cluster-delete" label="Delete cluster" onClick={() => deleteCluster(id)}>
        {trash()}
      </IconButton>
    </div>
  );
}
