import { For, Show, createMemo, createSignal } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import type { CardKind } from '../../types/board';
import { CARD_KINDS, KIND_META, entitiesOfKind } from '../../lib/kinds';
import { boardStore } from '../../store/boardStore';
import { Modal } from '../ui/Modal';
import { autofocus } from '../ui/autofocus';
import { fromStore } from '../fromStore';

/** A "＋ New …" row, offered on the tab it belongs to. Its value is a sentinel the
 *  caller recognises (e.g. NEW_PERSON), handed back through onPick like a card id. */
export type PickerCreateOption = { kind: CardKind; label: string; value: string };

type Props = {
  /** Tabs to show. When named, shown even if empty so a create option stays
   *  reachable; otherwise only the kinds that have a (non-excluded) card, in
   *  registry order. */
  kinds?: CardKind[];
  /** A card to hide from the lists — the one being linked from. */
  excludeId?: string;
  createOptions?: PickerCreateOption[];
  onPick: (value: string) => void;
  onClose: () => void;
};

/**
 * Pick a card to link to, in a tab per type so a person reads apart from an email at
 * a glance — the flat "Link to…" select can't, and a library of a couple of hundred
 * records makes that unusable. Shared by the connections list and the from/to linker;
 * the value handed back is a card id, or one of the caller's create sentinels.
 */
export function EntityPickerDialog(props: Props) {
  const cards = fromStore(boardStore, (s) => s.cards);

  const counts = createMemo(() => {
    const m = new Map<CardKind, number>();
    for (const c of cards()) if (c.id !== props.excludeId) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
    return m;
  });

  const tabs = createMemo(() => props.kinds ?? CARD_KINDS.filter((k) => (counts().get(k) ?? 0) > 0));

  const [active, setActive] = createSignal<CardKind | undefined>(tabs()[0]);
  const [filter, setFilter] = createSignal('');
  const activeKind = () => {
    const a = active();
    return a && tabs().includes(a) ? a : tabs()[0];
  };

  // The kind's cards, sorted once — the filter box narrows this by title without
  // re-running the sort on every keystroke.
  const sorted = createMemo(() => {
    const kind = activeKind();
    return kind ? entitiesOfKind(cards(), kind).filter((c) => c.id !== props.excludeId) : [];
  });
  const list = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? sorted().filter((c) => c.title.toLowerCase().includes(q)) : sorted();
  });

  const creates = () => (props.createOptions ?? []).filter((o) => o.kind === activeKind());

  const pick = (value: string) => {
    props.onPick(value);
    props.onClose();
  };

  return (
    <Modal title="Link to…" onClose={props.onClose}>
      <div class="entity-picker">
        <Show when={activeKind()} fallback={<p class="hint">Nothing to link to yet.</p>}>
          {(kind) => (
            <>
              <div class="entity-picker__tabs" role="tablist">
                <For each={tabs()}>
                  {(k) => (
                    <button
                      role="tab"
                      aria-selected={k === kind()}
                      class={cx('entity-picker__tab', k === kind() && 'is-active')}
                      onClick={() => {
                        setActive(k);
                        setFilter('');
                      }}
                    >
                      <Show when={KIND_META[k].icon}>
                        <span class="entity-picker__tab-icon">{KIND_META[k].icon}</span>
                      </Show>
                      {KIND_META[k].label}
                      <span class="entity-picker__tab-count">{counts().get(k) ?? 0}</span>
                    </button>
                  )}
                </For>
              </div>

              <input
                class="entity-picker__filter"
                ref={autofocus}
                value={filter()}
                placeholder={`Filter ${KIND_META[kind()].label.toLowerCase()}…`}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />

              <ul class="email-addr__list entity-picker__list">
                <For each={creates()}>
                  {(o) => (
                    <li>
                      <button class="entity-picker__row entity-picker__row--create" onClick={() => pick(o.value)}>
                        <span class="entity-picker__row-icon">＋</span>
                        <span class="entity-picker__row-title">{o.label}</span>
                      </button>
                    </li>
                  )}
                </For>
                <For each={list()}>
                  {(c) => (
                    <li>
                      <button class="entity-picker__row" onClick={() => pick(c.id)}>
                        <Show when={KIND_META[c.kind].icon}>
                          <span class="entity-picker__row-icon">{KIND_META[c.kind].icon}</span>
                        </Show>
                        <span class="entity-picker__row-title">{c.title || 'Untitled'}</span>
                      </button>
                    </li>
                  )}
                </For>
                <Show when={list().length === 0 && creates().length === 0}>
                  <li class="entity-picker__empty hint">Nothing here.</li>
                </Show>
              </ul>
            </>
          )}
        </Show>
      </div>
    </Modal>
  );
}
