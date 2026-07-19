import { useState } from 'react';
import { useBoardStore } from '../../store/boardStore';
import { touches } from '../../lib/connections';
import { KIND_META } from '../../lib/kinds';
import { GradeField } from './GradeField';
import { EntityPickerDialog } from './EntityPickerDialog';

export function ConnectionsSection({ cardId }: { cardId: string }) {
  const cards = useBoardStore((s) => s.cards);
  const connections = useBoardStore((s) => s.connections);
  const addConnection = useBoardStore((s) => s.addConnection);
  const updateConnection = useBoardStore((s) => s.updateConnection);
  const deleteConnection = useBoardStore((s) => s.deleteConnection);
  const selectCard = useBoardStore((s) => s.selectCard);

  const [picking, setPicking] = useState(false);

  const mine = connections.filter((c) => touches(c, cardId));
  const hasOthers = cards.some((c) => c.id !== cardId);

  return (
    <div className="field connections">
      <span>Connections</span>

      {mine.length === 0 && <p className="hint">No connections yet.</p>}
      {mine.map((c) => {
        const outgoing = c.source === cardId;
        const other = cards.find((x) => x.id === (outgoing ? c.target : c.source));
        return (
          <div key={c.id} className="connection">
            <div className="connection-row">
              <span className="connection-arrow">{outgoing ? '→' : '←'}</span>
              <button
                className="link-button email-addr__entity connection-target"
                onClick={() => other && selectCard(other.id)}
              >
                {other && KIND_META[other.kind].icon && (
                  <span className="email-addr__icon">{KIND_META[other.kind].icon}</span>
                )}
                {other?.title || '(unknown)'}
              </button>
              {/* The string's label, editable in place — its own paper tag on the
                  board reads from this, so a rename lands there live (see mappers,
                  updateConnection). Blank clears it back to an unlabelled string. */}
              <input
                className="connection-label"
                defaultValue={c.label ?? ''}
                placeholder="label…"
                onBlur={(e) => updateConnection(c.id, { label: e.target.value.trim() || undefined })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <button
                className="cluster-delete"
                onClick={() => deleteConnection(c.id)}
                title="Remove connection"
              >
                ×
              </button>
            </div>
            {/* A link is a claim in its own right — "Acme owns Bam" is asserted
                by the string, not by either card it ties — so it is graded on
                the same ladder, by the same control. */}
            <GradeField grade={c.grade} onChange={(grade) => updateConnection(c.id, { grade })} />
          </div>
        );
      })}

      {hasOthers && (
        <div className="connection-add">
          <button className="link-button connection-add__button" onClick={() => setPicking(true)}>
            ＋ Link to a card…
          </button>
        </div>
      )}

      {picking && (
        <EntityPickerDialog
          excludeId={cardId}
          onPick={(value) => addConnection(cardId, value)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
