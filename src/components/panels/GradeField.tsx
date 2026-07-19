import { GRADES, GRADE_META, gradeTint } from '../../lib/grades';
import type { Grade } from '../../types/board';

/**
 * Pick a grade, with the help to pick one.
 *
 * A bare select of eight one-word options would be the wrong thing: the words
 * only mean what the definitions say, and a scale nobody can read is a scale two
 * people will use differently. So the definition of the grade in play sits under
 * the control, and GradeLegend below puts all eight within one click.
 *
 * Shared by the card and its connections — a claim and a link are graded on the
 * same ladder, and reading GRADE_META once is what stops the two drifting apart.
 */
export function GradeField({
  grade,
  onChange,
}: {
  grade?: Grade;
  onChange: (grade: Grade | undefined) => void;
}) {
  return (
    <label className="field">
      <span>Grade</span>
      <select
        className="grade-select"
        value={grade ?? ''}
        style={grade ? gradeTint(grade) : undefined}
        onChange={(e) => onChange((e.target.value || undefined) as Grade | undefined)}
      >
        <option value="">— ungraded —</option>
        {GRADES.map((g) => (
          <option key={g} value={g}>
            {GRADE_META[g].label}
          </option>
        ))}
      </select>
      <span className="field__hint">
        {grade ? (
          GRADE_META[grade].definition
        ) : (
          // Absence is not a finding. "Unresolved" says the record was read and
          // does not settle it; ungraded says nobody has looked yet, and the
          // board must not quietly upgrade the second into the first.
          <>Nobody has graded this yet — which is not the same as Unresolved.</>
        )}
      </span>
    </label>
  );
}

/**
 * The eight, in one place, one click away. Collapsed by default: it is here to
 * be consulted while grading, not to fill the sidebar of someone who already
 * knows the scale.
 */
export function GradeLegend() {
  return (
    <details className="grade-legend">
      <summary>What the grades mean</summary>
      <ul>
        {GRADES.map((g) => (
          <li key={g}>
            <span className="grade-chip" style={gradeTint(g)}>
              {GRADE_META[g].label}
            </span>
            <span>{GRADE_META[g].definition}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
