import { useState } from 'react';
import { useBoardStore } from '../../hooks/useStores';
import { useDraft } from '../../hooks/useDraft';
import type { Cluster } from '../../types/board';

export function ClusterPanel() {
  const clusters = useBoardStore((s) => s.clusters);
  const addCluster = useBoardStore((s) => s.addCluster);
  const [open, setOpen] = useState(true);

  return (
    <div className="cluster-panel">
      <button
        className="cluster-panel__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="panel-heading">Clusters</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          {clusters.map((c) => (
            <ClusterRow key={c.id} cluster={c} />
          ))}
          <button className="cluster-add" onClick={() => addCluster()}>
            + Add cluster
          </button>
        </>
      )}
    </div>
  );
}

function ClusterRow({ cluster }: { cluster: Cluster }) {
  const toggleCluster = useBoardStore((s) => s.toggleCluster);
  const updateCluster = useBoardStore((s) => s.updateCluster);
  const deleteCluster = useBoardStore((s) => s.deleteCluster);
  // The colour picker reports every step of a drag, so it drafts like the label.
  const [color, setColor, flushColor] = useDraft(cluster.color, (color) => updateCluster(cluster.id, { color }));
  const [label, setLabel, flushLabel] = useDraft(cluster.label, (label) => updateCluster(cluster.id, { label }));

  return (
    <div className="cluster-row">
      <input
        type="checkbox"
        checked={cluster.visible}
        onChange={() => toggleCluster(cluster.id)}
        title="Show/hide"
      />
      <input
        type="color"
        className="cluster-color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        onBlur={flushColor}
        title="Colour"
      />
      <input
        className="cluster-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={flushLabel}
      />
      <button
        className="cluster-delete"
        onClick={() => deleteCluster(cluster.id)}
        title="Delete cluster"
      >
        ×
      </button>
    </div>
  );
}
