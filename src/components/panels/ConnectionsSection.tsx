import { For, Show, createMemo, createSignal } from 'solid-js';
import { touches } from '../../lib/connections';
import { KIND_META } from '../../lib/kinds';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '../fromStore';
import { GradeField } from './GradeField';
import { EntityPickerDialog } from './EntityPickerDialog';

export function ConnectionsSection(props: { cardId: string }) {
  const cards = fromStore(boardStore, (s) => s.cards);
  const connections = fromStore(boardStore, (s) => s.connections);
  const { addConnection, updateConnection, deleteConnection, selectCard } = boardStore.getState();

  const [picking, setPicking] = createSignal(false);

  const mine = createMemo(() => connections().filter((c) => touches(c, props.cardId)));
  // Rows by id, not by object: a write replaces the connection's row, and a
  // remounted row would drop the control the user is still in.
  const mineIds = () => mine().map((c) => c.id);
  const hasOthers = () => cards().some((c) => c.id !== props.cardId);

  return (
    <div class="field connections">
      <span>Connections</span>

      <Show when={mine().length === 0}>
        <p class="hint">No connections yet.</p>
      </Show>
      <For each={mineIds()}>
        {(id) => {
          const c = () => mine().find((x) => x.id === id)!;
          const outgoing = () => c().source === props.cardId;
          const other = () => cards().find((x) => x.id === (outgoing() ? c().target : c().source));
          const label = createMemo(() => c().label ?? '');
          return (
            <div class="connection">
              <div class="connection-row">
                <span class="connection-arrow">{outgoing() ? '→' : '←'}</span>
                <button
                  class="link-button email-addr__entity connection-target"
                  onClick={() => {
                    const o = other();
                    if (o) selectCard(o.id);
                  }}
                >
                  <Show when={other() && KIND_META[other()!.kind].icon}>
                    {(icon) => <span class="email-addr__icon">{icon()}</span>}
                  </Show>
                  {other()?.title || '(unknown)'}
                </button>
                {/* The string's label, editable in place — its own paper tag on the
                    board reads from this, so a rename lands there live (see projection,
                    updateConnection). Blank clears it back to an unlabelled string. */}
                <input
                  class="connection-label"
                  value={label()}
                  placeholder="label…"
                  onBlur={(e) => updateConnection(id, { label: e.currentTarget.value.trim() || undefined })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                <button class="cluster-delete" onClick={() => deleteConnection(id)} title="Remove connection">
                  ×
                </button>
              </div>
              {/* A link is a claim in its own right — "Acme owns Bam" is asserted
                  by the string, not by either card it ties — so it is graded on
                  the same ladder, by the same control. */}
              <GradeField grade={c().grade} onChange={(grade) => updateConnection(id, { grade })} />
            </div>
          );
        }}
      </For>

      <Show when={hasOthers()}>
        <div class="connection-add">
          <button class="link-button connection-add__button" onClick={() => setPicking(true)}>
            ＋ Link to a card…
          </button>
        </div>
      </Show>

      <Show when={picking()}>
        <EntityPickerDialog
          excludeId={props.cardId}
          onPick={(value) => addConnection(props.cardId, value)}
          onClose={() => setPicking(false)}
        />
      </Show>
    </div>
  );
}
