/** @jsxImportSource solid-js */
import { For, Show, createResource } from 'solid-js';
import { Modal } from '../ui/Modal';
import { autofocus } from '../ui/autofocus';
import { formatOccurredAt } from '../../lib/dates';
import { DEFAULT_BOARD_TITLE } from '../../data/emptyBoard';
import { GRADES, GRADE_META, gradeTint } from '../../lib/grades';
import { storage } from '../../storage';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '../fromStore';
import { createDraft } from '../createDraft';

export function BoardPropertiesModal(props: { onClose: () => void }) {
  const meta = fromStore(boardStore, (s) => s.meta);
  const { setTitle: commitTitle, setCountryCode: commitCountryCode } = boardStore.getState();
  const [title, setTitle, flushTitle] = createDraft(() => meta().title, commitTitle);
  const [countryCode, setCountryCode, flushCountryCode] = createDraft(
    () => meta().countryCode ?? '',
    commitCountryCode,
  );

  return (
    <Modal title="Board properties" onClose={props.onClose}>
      <label class="field">
        <span>Title</span>
        {/* Saved as typed, like the cluster label, so there is no OK/Cancel
            semantic to invent. */}
        <input
          ref={autofocus}
          value={title()}
          placeholder={DEFAULT_BOARD_TITLE}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onBlur={flushTitle}
        />
      </label>
      <p class="hint">Last saved {formatOccurredAt(meta().updatedAt, 'minute')}.</p>

      <label class="field">
        <span>Local country code</span>
        {/* Saved as typed like Title; lib/phone normalises it. What a leading
            national 0 folds to when matching and showing numbers. */}
        <input
          value={countryCode()}
          placeholder="+61"
          onInput={(e) => setCountryCode(e.currentTarget.value)}
          onBlur={flushCountryCode}
        />
        <span class="field__hint">
          A leading 0 in a phone number folds to this, so 0403… matches +61 403…. Defaults to Australia.
        </span>
      </label>

      <BoardFile />

      {/* The scale this board is graded on, in full. The picker shows the grade
          in play; this is where you read the whole ladder at once — including
          the colour, which is the only part of a grade you see from across a
          board once the sidebar is shut. */}
      <div class="field">
        <span>Grades</span>
        <ul class="grade-key">
          <For each={GRADES}>
            {(g) => (
              <li style={gradeTint(g)}>
                <span class="grade-key__swatch" />
                <span class="grade-key__label">{GRADE_META[g].label}</span>
                <span class="grade-key__definition">{GRADE_META[g].definition}</span>
              </li>
            )}
          </For>
        </ul>
        <span class="field__hint">
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
  const currentBoardId = fromStore(boardStore, (s) => s.currentBoardId);
  // Where it would be, whether or not it is there yet — a display string, not
  // a promise that a file exists. Whether it does is revealBoard's problem.
  const [path] = createResource(currentBoardId, (id) => storage.boardLocation(id).catch(() => null));

  // The shell knows the honest reason it couldn't — most likely a board not
  // yet autosaved — so let it say so rather than guessing here.
  const reveal = async (id: string) => {
    try {
      await storage.revealBoard(id);
    } catch (e) {
      boardStore.getState().setError(String(e));
    }
  };

  // No path only before the id or the async has landed — there is always an
  // open board by the time this modal is up, so this is a first-paint guard.
  return (
    <Show when={path.latest && currentBoardId()}>
      {(id) => (
        <div class="field">
          <span>File</span>
          <button class="link-button board-file" onClick={() => void reveal(id())} title={path.latest!}>
            {path.latest}
          </button>
          <span class="field__hint">
            Saved here as you edit. Click to show it in Finder.
          </span>
        </div>
      )}
    </Show>
  );
}
