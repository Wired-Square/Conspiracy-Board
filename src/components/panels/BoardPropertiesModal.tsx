import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { useBoardStore } from '../../store/boardStore';
import { formatOccurredAt } from '../../lib/dates';
import { DEFAULT_BOARD_TITLE } from '../../data/emptyBoard';
import { GRADES, GRADE_META, gradeTint } from '../../lib/grades';
import { storage } from '../../storage';

export function BoardPropertiesModal({ onClose }: { onClose: () => void }) {
  const title = useBoardStore((s) => s.meta.title);
  const updatedAt = useBoardStore((s) => s.meta.updatedAt);
  const setTitle = useBoardStore((s) => s.setTitle);
  const countryCode = useBoardStore((s) => s.meta.countryCode);
  const setCountryCode = useBoardStore((s) => s.setCountryCode);

  return (
    <Modal title="Board properties" onClose={onClose}>
      <label className="field">
        <span>Title</span>
        {/* Straight to the store, like the cluster label input — autosave
            persists it and the library entry is derived from it on save, so
            there is no OK/Cancel semantic to invent. */}
        <input
          autoFocus
          value={title}
          placeholder={DEFAULT_BOARD_TITLE}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <p className="hint">Last saved {formatOccurredAt(updatedAt, 'minute')}.</p>

      <label className="field">
        <span>Local country code</span>
        {/* Straight to the store like Title; lib/phone normalises it. What a leading
            national 0 folds to when matching and showing numbers. */}
        <input
          value={countryCode ?? ''}
          placeholder="+61"
          onChange={(e) => setCountryCode(e.target.value)}
        />
        <span className="field__hint">
          A leading 0 in a phone number folds to this, so 0403… matches +61 403…. Defaults to Australia.
        </span>
      </label>

      <BoardFile />

      {/* The scale this board is graded on, in full. The picker shows the grade
          in play; this is where you read the whole ladder at once — including
          the colour, which is the only part of a grade you see from across a
          board once the sidebar is shut. */}
      <div className="field">
        <span>Grades</span>
        <ul className="grade-key">
          {GRADES.map((g) => (
            <li key={g} style={gradeTint(g)}>
              <span className="grade-key__swatch" />
              <span className="grade-key__label">{GRADE_META[g].label}</span>
              <span className="grade-key__definition">{GRADE_META[g].definition}</span>
            </li>
          ))}
        </ul>
        <span className="field__hint">
          Only an event, an evidence card, or a connection carries one — an actor is not
          a claim, and a document exists whether or not you like it.
        </span>
      </div>
    </Modal>
  );
}

/**
 * Where this board actually is, and a way to go and look at it.
 *
 * The board is a file the user owns, holding evidence they may need to back up,
 * hand over, or put beyond the reach of this app entirely. Autosave means they
 * never chose where it went, so this is the only place it can be said — and a
 * tool that will not tell you where it put your evidence is not one to trust
 * with it.
 *
 * The path is asked for on open rather than held in the store: it is a fact
 * about the shell, not about the board, and nothing else wants it.
 */
function BoardFile() {
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  const setError = useBoardStore((s) => s.setError);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    if (!currentBoardId) return;
    // Where it would be, whether or not it is there yet — a display string, not
    // a promise that a file exists. Whether it does is revealBoard's problem.
    void storage.boardLocation(currentBoardId).then(setPath, () => setPath(null));
  }, [currentBoardId]);

  // No path only before the id or the async has landed — there is always an
  // open board by the time this modal is up, so this is a first-paint guard.
  if (!path || !currentBoardId) return null;

  const reveal = async () => {
    // The shell knows the honest reason it couldn't — most likely a board not
    // yet autosaved — so let it say so rather than guessing here.
    try {
      await storage.revealBoard(currentBoardId);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="field">
      <span>File</span>
      <button className="link-button board-file" onClick={() => void reveal()} title={path}>
        {path}
      </button>
      <span className="field__hint">
        Saved here automatically, 500ms after every edit. Click to show it in Finder.
      </span>
    </div>
  );
}
