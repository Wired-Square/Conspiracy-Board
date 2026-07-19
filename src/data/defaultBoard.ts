import rawBoard from '../../data/board.json';
import { parseBoard } from './schema';
import type { Board } from '../types/board';

// Bundled, validated source-of-truth board. Used when no working copy exists in
// storage. Validation runs at module load so a malformed board.json fails loudly.
export const defaultBoard: Board = parseBoard(rawBoard);
