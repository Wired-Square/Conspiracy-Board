import { For, Show, createMemo, createSignal } from 'solid-js';
import { Button, IconButton } from '@wired-square/kit';
import { plus, trash } from '@wired-square/icons/solid';
import { touches } from '../../lib/connections';
import { boardStore } from '../../store/boardStore';
import { seenStore } from '../../store/maskStore';
import { fromStore } from '@wired-square/store/solid';
import { GradeField } from './GradeField';
import { EntityPickerDialog } from './EntityPickerDialog';
import { KindIcon } from '../ui/KindIcon';

export function ConnectionsSection(props: { cardId: string }) {
  const cards = fromStore(seenStore, (s) => s.cards);
  const connections = fromStore(seenStore, (s) => s.connections);
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
                <Button
                  tone="plain"
                  class="email-addr__entity connection-target"
                  onClick={() => {
                    const o = other();
                    if (o) selectCard(o.id);
                  }}
                >
                  <Show when={other()}>{(o) => <KindIcon kind={o().kind} class="email-addr__icon" />}</Show>
                  {other()?.title || '(unknown)'}
                </Button>
                {/* The string's label, editable in place — its own paper tag on the
                    board reads from this, so a rename lands there live (see projection,
                    updateConnection). Blank clears it back to an unlabelled string. */}
                <input
                  class="app-field__input connection-label"
                  value={label()}
                  placeholder="label…"
                  onBlur={(e) => updateConnection(id, { label: e.currentTarget.value.trim() || undefined })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                <IconButton class="cluster-delete" label="Remove connection" onClick={() => deleteConnection(id)}>
                  {trash()}
                </IconButton>
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
          <Button tone="plain" onClick={() => setPicking(true)}>
            {plus()} Link to a card…
          </Button>
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
