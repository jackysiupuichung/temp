import { describe, it, expect } from 'vitest';
import { UndoStack } from './undo';

describe('UndoStack', () => {
  it('undoes and redoes in order', () => {
    const s = new UndoStack<number>();
    s.push(1); s.push(2); s.push(3);
    expect(s.undo()).toBe(3);
    expect(s.undo()).toBe(2);
    expect(s.redo()).toBe(2);
    expect(s.redo()).toBe(3);
    expect(s.redo()).toBeUndefined();
    expect(s.canRedo).toBe(false);
    expect(s.canUndo).toBe(true);
  });
  it('clears redo on new push', () => {
    const s = new UndoStack<number>();
    s.push(1); s.push(2);
    s.undo();
    s.push(3);
    expect(s.canRedo).toBe(false);
    expect(s.undo()).toBe(3);
    expect(s.undo()).toBe(1);
    expect(s.undo()).toBeUndefined();
  });
  it('keeps at least 100 steps and respects the limit', () => {
    const s = new UndoStack<number>(100);
    for (let i = 0; i < 150; i++) s.push(i);
    expect(s.size).toBe(100);
    let n = 0; let last: number | undefined;
    while (s.canUndo) { last = s.undo(); n++; }
    expect(n).toBe(100);
    expect(last).toBe(50);
  });
});
