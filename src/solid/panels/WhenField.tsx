/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import type { Card, DatePrecision } from '../../types/board';
import {
  changePrecision,
  defaultOccurredAt,
  formatOccurredAt,
  fromLocalInputValue,
  toLocalInputValue,
} from '../../lib/dates';
import { boardStore } from '../../store/boardStore';
import { createDraft } from '../createDraft';

type WhenMode = 'none' | DatePrecision;

/**
 * Dates a card. Precision is an explicit choice rather than inferred from the
 * input, so "date only" is a first-class answer — most evidence is known to a
 * day, not a minute.
 *
 * `locked` shows the date read-only: an email's `When` is its sent time from the
 * headers, fixed on import, and not the reader's to edit.
 */
export function WhenField(props: { card: Card; locked?: boolean }) {
  const { updateCard } = boardStore.getState();

  const mode = (): WhenMode => (props.card.occurredAt ? props.card.occurredAtPrecision : 'none');

  const onModeChange = (next: WhenMode) => {
    if (next === 'none') {
      updateCard(props.card.id, { occurredAt: null });
      return;
    }
    updateCard(props.card.id, {
      occurredAtPrecision: next,
      occurredAt: props.card.occurredAt ? changePrecision(props.card.occurredAt, next) : defaultOccurredAt(next),
    });
  };

  return (
    <Show
      when={!props.locked}
      fallback={
        <div class="field">
          <span>When</span>
          <span class="kind-locked">
            {props.card.occurredAt
              ? formatOccurredAt(props.card.occurredAt, props.card.occurredAtPrecision)
              : '— undated —'}
          </span>
          <span class="field__hint">From the email; fixed on import.</span>
        </div>
      }
    >
      <div class="field">
        <span>When</span>
        <div class="field__row">
          <select value={mode()} onChange={(e) => onModeChange(e.currentTarget.value as WhenMode)}>
            <option value="none">— undated —</option>
            <option value="day">Date only</option>
            <option value="minute">Date &amp; time</option>
          </select>

          {/* Remounted per precision: the input's type and its draft's format change together. */}
          <Show when={props.card.occurredAt}>
            {(occurredAt) => (
              <Show when={props.card.occurredAtPrecision} keyed>
                {(precision) => <WhenInput cardId={props.card.id} occurredAt={occurredAt()} precision={precision} />}
              </Show>
            )}
          </Show>
        </div>
        <Show when={!props.card.occurredAt}>
          <p class="hint">Undated cards stay off the timeline.</p>
        </Show>
      </div>
    </Show>
  );
}

function WhenInput(props: { cardId: string; occurredAt: string; precision: DatePrecision }) {
  const { updateCard } = boardStore.getState();
  const [text, setText, flush] = createDraft(
    () => toLocalInputValue(props.occurredAt, props.precision),
    (text) => {
      // A cleared or half-typed input parses to null; keep the stored value until
      // the user commits something valid.
      const next = fromLocalInputValue(text, props.precision);
      if (next) updateCard(props.cardId, { occurredAt: next });
    },
  );

  return (
    <input
      type={props.precision === 'day' ? 'date' : 'datetime-local'}
      value={text()}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={flush}
    />
  );
}
