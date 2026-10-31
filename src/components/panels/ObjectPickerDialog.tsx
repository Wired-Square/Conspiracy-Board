import { For, Show, createMemo, createSignal } from 'solid-js';
import { cx } from '@wired-square/kit/core';
import type { Card, CardKind } from '../../types/board';
import { CARD_KINDS, KIND_META } from '../../lib/kinds';
import { cardMatches, normaliseQuery } from '../../lib/search';
import { formatOccurredAt, dayKey } from '../../lib/dates';
import { Modal } from '../ui/Modal';
import { autofocus } from '../ui/autofocus';

/** One reusable picture and every card that uses it — pictures are content-addressed,
 *  so a shared image (a group photo) lists all its objects. `cards[0]` is the
 *  representative, first seen; the rest let the picker find it by any of them. */
export type PickableObject = { cards: Card[]; file: string; src: string };

type Props = {
  objects: PickableObject[];
  onPick: (file: string) => void;
  onClose: () => void;
};

/**
 * Pick a picture already on the board to reuse, from a grid of thumbnails with a
 * large preview of the highlighted one below. Type tabs and a text/date filter keep
 * it usable at a library of hundreds; the query runs through the same `cardMatches`
 * the board search uses (title, notes/OCR, participants, addresses, document author,
 * attachment names), plus the object's date. The value handed back is a media file.
 */
export function ObjectPickerDialog(props: Props) {
  const [active, setActive] = createSignal<CardKind | 'all'>('all');
  const [filter, setFilter] = createSignal('');
  // The clicked thumbnail; `current` below falls back to the first shown, so the
  // initial (null) render already previews something.
  const [selected, setSelected] = createSignal<string | null>(null);

  // A shared image counts once under each kind it is linked to, so the tabs point at
  // where it can be found — the totals overlap (an image on a person and an email is
  // in both), which is fine; only "All" is the object total.
  const counts = createMemo(() => {
    const m = new Map<CardKind, number>();
    for (const o of props.objects) for (const k of new Set(o.cards.map((c) => c.kind))) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  });

  // A typed date narrows the grid the way the board search narrows by text: match
  // against how each linked card's date reads (medium format) and its ISO day, so
  // "2011", "2011-09" or a month name all land. Built once per object set rather than
  // reformatted through Intl on every keystroke; dateless cards contribute nothing.
  const dateText = createMemo(() => {
    const m = new Map<string, string>();
    for (const { cards, file } of props.objects) {
      const parts: string[] = [];
      for (const c of cards) {
        if (!c.occurredAt) continue;
        parts.push(formatOccurredAt(c.occurredAt, c.occurredAtPrecision), dayKey(c.occurredAt, c.occurredAtPrecision));
      }
      if (parts.length) m.set(file, parts.join(' ').toLowerCase());
    }
    return m;
  });

  // "All" first, then only the kinds that actually have a picture — an empty tab is
  // a dead end here (unlike the link picker, nothing is created from this one). Each
  // tab is a ready-to-render descriptor, so the JSX below has no per-kind branching.
  const tabs = createMemo(() => [
    { key: 'all' as const, label: 'All', icon: undefined as string | undefined, count: props.objects.length },
    ...CARD_KINDS.filter((k) => (counts().get(k) ?? 0) > 0).map((k) => ({
      key: k,
      label: KIND_META[k].label,
      icon: KIND_META[k].icon,
      count: counts().get(k) ?? 0,
    })),
  ]);

  const visible = createMemo(() => {
    const q = normaliseQuery(filter());
    const kind = active();
    return props.objects.filter(
      (o) =>
        (kind === 'all' || o.cards.some((c) => c.kind === kind)) &&
        (o.cards.some((c) => cardMatches(c, q)) || (dateText().get(o.file)?.includes(q) ?? false)),
    );
  });

  // Keep a live selection: the highlighted file if it survived the filter/tab, else
  // the first shown — so the preview always tracks what the grid is showing.
  const current = createMemo(() => visible().find((o) => o.file === selected()) ?? visible()[0] ?? null);

  const choose = (file: string) => {
    props.onPick(file);
    props.onClose();
  };

  const footer = (
    <>
      <button class="link-button" onClick={() => props.onClose()}>
        Cancel
      </button>
      <button onClick={() => current() && choose(current()!.file)} disabled={!current()}>
        Use image
      </button>
    </>
  );

  return (
    <Modal title="Choose an object" onClose={props.onClose} footer={footer}>
      <div class="object-picker">
        <div class="entity-picker__tabs" role="tablist">
          <For each={tabs()}>
            {(t) => (
              <button
                role="tab"
                aria-selected={t.key === active()}
                class={cx('entity-picker__tab', t.key === active() && 'is-active')}
                onClick={() => setActive(t.key)}
              >
                <Show when={t.icon}>
                  <span class="entity-picker__tab-icon">{t.icon}</span>
                </Show>
                {t.label}
                <span class="entity-picker__tab-count">{t.count}</span>
              </button>
            )}
          </For>
        </div>

        <input
          class="entity-picker__filter"
          ref={autofocus}
          value={filter()}
          placeholder="Filter by name, text, date…"
          onInput={(e) => setFilter(e.currentTarget.value)}
        />

        <Show when={current()} fallback={<p class="object-picker__empty hint">Nothing matches.</p>}>
          {(shown) => {
            // The representative object of the shown image, and how many others share it.
            const rep = () => shown().cards[0];
            const shared = () => shown().cards.length - 1;
            return (
              <>
                <div class="image-picker">
                  <For each={visible()}>
                    {(o) => {
                      const [first, ...rest] = o.cards;
                      return (
                        <button
                          type="button"
                          class={cx('image-picker__item', o.file === shown().file && 'is-active')}
                          title={rest.length ? `${first.title || 'Untitled'} +${rest.length}` : first.title || 'Untitled'}
                          aria-pressed={o.file === shown().file}
                          onClick={() => setSelected(o.file)}
                          onDblClick={() => choose(o.file)}
                        >
                          <img src={o.src} alt={first.title} loading="lazy" />
                          <Show when={rest.length > 0}>
                            <span class="image-picker__count">+{rest.length}</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>

                <div class="object-picker__preview">
                  <img src={shown().src} alt={rep().title} />
                  <span class="object-picker__caption">
                    <Show when={KIND_META[rep().kind].icon}>
                      <span aria-hidden="true">{KIND_META[rep().kind].icon} </span>
                    </Show>
                    {rep().title || 'Untitled'}
                    <Show when={shared() > 0}>
                      <span class="object-picker__more"> +{shared()}</span>
                    </Show>
                    <Show when={rep().occurredAt}>
                      <span class="object-picker__date">
                        {' · '}
                        {formatOccurredAt(rep().occurredAt!, rep().occurredAtPrecision)}
                      </span>
                    </Show>
                  </span>
                </div>
              </>
            );
          }}
        </Show>
      </div>
    </Modal>
  );
}
