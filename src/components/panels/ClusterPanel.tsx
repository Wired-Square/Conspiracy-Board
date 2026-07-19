import { useState } from 'react';
import { useBoardStore } from '../../store/boardStore';

export function ClusterPanel() {
  const clusters = useBoardStore((s) => s.clusters);
  const toggleCluster = useBoardStore((s) => s.toggleCluster);
  const updateCluster = useBoardStore((s) => s.updateCluster);
  const deleteCluster = useBoardStore((s) => s.deleteCluster);
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
            <div key={c.id} className="cluster-row">
              <input
                type="checkbox"
                checked={c.visible}
                onChange={() => toggleCluster(c.id)}
                title="Show/hide"
              />
              <input
                type="color"
                className="cluster-color"
                value={c.color}
                onChange={(e) => updateCluster(c.id, { color: e.target.value })}
                title="Colour"
              />
              <input
                className="cluster-label"
                value={c.label}
                onChange={(e) => updateCluster(c.id, { label: e.target.value })}
              />
              <button
                className="cluster-delete"
                onClick={() => deleteCluster(c.id)}
                title="Delete cluster"
              >
                ×
              </button>
            </div>
          ))}
          <button className="cluster-add" onClick={() => addCluster()}>
            + Add cluster
          </button>
        </>
      )}
    </div>
  );
}
