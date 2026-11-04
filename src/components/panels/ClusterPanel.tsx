import { For, Show, createSignal } from 'solid-js';
import { Button, IconButton } from '@wired-square/kit';
import { chevronDown, chevronRight, plus, trash } from '@wired-square/icons/solid';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';
import { createDraft } from '../createDraft';
import type { Cluster } from '../../types/board';

export function ClusterPanel() {
  const clusters = fromStore(boardStore, (s) => s.clusters);
  const [open, setOpen] = createSignal(true);
  // Rows by id, not by object: a write replaces the cluster, and a remounted row
  // would drop the field the user is still typing in.
  const clusterIds = () => clusters().map((c) => c.id);

  return (
    <div class="cluster-panel">
      <Button tone="plain" class="cluster-panel__toggle" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        <span class="panel-heading">Clusters</span>
        {open() ? chevronDown() : chevronRight()}
      </Button>
      <Show when={open()}>
        <For each={clusterIds()}>{(id) => <ClusterRow cluster={clusters().find((c) => c.id === id)!} />}</For>
        <Button class="cluster-add" onClick={() => boardStore.getState().addCluster()}>
          {plus()} Add cluster
        </Button>
      </Show>
    </div>
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
