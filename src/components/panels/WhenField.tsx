import type { Card, DatePrecision } from '../../types/board';
import {
  changePrecision,
  defaultOccurredAt,
  formatOccurredAt,
  fromLocalInputValue,
  toLocalInputValue,
} from '../../lib/dates';
import { useBoardStore } from '../../store/boardStore';

type WhenMode = 'none' | DatePrecision;

/**
 * Dates a card. Precision is an explicit choice rather than inferred from the
 * input, so "date only" is a first-class answer — most evidence is known to a
 * day, not a minute.
 *
 * `locked` shows the date read-only: an email's `When` is its sent time from the
 * headers, fixed on import, and not the reader's to edit.
 */
export function WhenField({ card, locked = false }: { card: Card; locked?: boolean }) {
  const updateCard = useBoardStore((s) => s.updateCard);

  if (locked) {
    return (
      <div className="field">
        <span>When</span>
        <span className="kind-locked">
          {card.occurredAt
            ? formatOccurredAt(card.occurredAt, card.occurredAtPrecision)
            : '— undated —'}
        </span>
        <span className="field__hint">From the email; fixed on import.</span>
      </div>
    );
  }

  const mode: WhenMode = card.occurredAt ? card.occurredAtPrecision : 'none';

  const onModeChange = (next: WhenMode) => {
    if (next === 'none') {
      updateCard(card.id, { occurredAt: null });
      return;
    }
    updateCard(card.id, {
      occurredAtPrecision: next,
      occurredAt: card.occurredAt
        ? changePrecision(card.occurredAt, next)
        : defaultOccurredAt(next),
    });
  };

  return (
    <div className="field">
      <span>When</span>
      <div className="field__row">
        <select value={mode} onChange={(e) => onModeChange(e.target.value as WhenMode)}>
          <option value="none">— undated —</option>
          <option value="day">Date only</option>
          <option value="minute">Date &amp; time</option>
        </select>

        {card.occurredAt && (
          <input
            type={card.occurredAtPrecision === 'day' ? 'date' : 'datetime-local'}
            value={toLocalInputValue(card.occurredAt, card.occurredAtPrecision)}
            onChange={(e) => {
              const next = fromLocalInputValue(
                e.target.value,
                card.occurredAtPrecision,
              );
              // A cleared or half-typed input parses to null; keep the stored
              // value until the user commits something valid.
              if (next) updateCard(card.id, { occurredAt: next });
            }}
          />
        )}
      </div>
      {!card.occurredAt && (
        <p className="hint">Undated cards stay off the timeline.</p>
      )}
    </div>
  );
}
