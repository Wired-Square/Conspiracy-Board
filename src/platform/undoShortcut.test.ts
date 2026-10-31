import { describe, expect, it } from 'vitest';
import { boardUndoKey } from './undoShortcut';

const key = (over: Partial<Parameters<typeof boardUndoKey>[0]>) =>
  boardUndoKey({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: null, ...over });

describe('the board undo shortcut', () => {
  it('is Cmd+Z for undo and Shift+Cmd+Z for redo', () => {
    expect(key({})).toBe('undo');
    expect(key({ key: 'Z', shiftKey: true })).toBe('redo');
    expect(key({ metaKey: false })).toBeNull();
    expect(key({ key: 'y' })).toBeNull();
  });

  it('leaves a focused text field its own undo', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
      expect(key({ target: target as unknown as EventTarget })).toBeNull();
    }
    expect(key({ target: { tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget })).toBe('undo');
  });
});
