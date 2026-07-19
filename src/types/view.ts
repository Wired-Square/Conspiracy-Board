/**
 * Which surface is showing. The registers of the model made into places: the
 * board is the actors and the argument, the record is the paper they are
 * argued from (see lib/kinds.ts).
 *
 * The timeline is not one of these — it is a drawer under both, because "when"
 * is a question you ask of either.
 *
 * 'object' is the odd one out: not a register, not card-backed — the media
 * library's housekeeping surface (see components/maintenance). It is reached only
 * from the File menu, never from a card, so nothing routes a kind to it.
 */
export type View = 'board' | 'record' | 'object';

/**
 * What each surface is called, in one place — the view chooser, the native View
 * menu (its labels mirror these) and the Objects badge all read it. In key order,
 * which is the order the chooser lists them.
 */
export const VIEW_META: Record<View, { label: string }> = {
  board: { label: 'Board' },
  record: { label: 'Record' },
  object: { label: 'Objects' },
};
