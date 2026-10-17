/** Generic bounded undo/redo stack. Pure; no DOM. */
export class UndoStack<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  constructor(private readonly limit = 200) {}

  push(entry: T): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(): T | undefined {
    const e = this.undoStack.pop();
    if (e !== undefined) this.redoStack.push(e);
    return e;
  }
  redo(): T | undefined {
    const e = this.redoStack.pop();
    if (e !== undefined) this.undoStack.push(e);
    return e;
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get size(): number { return this.undoStack.length; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}

import type { PageRecord, Stroke, TextBox } from './types';

/** An atomic mutation of annotation/page state. Ops are their own inverse given a "backward" op. */
export type Op =
  | { kind: 'putStrokes'; items: Stroke[] }
  | { kind: 'deleteStrokes'; ids: string[]; pageIds: string[] }
  | { kind: 'putTextBoxes'; items: TextBox[] }
  | { kind: 'deleteTextBoxes'; ids: string[]; pageIds: string[] }
  | { kind: 'setPages'; pages: PageRecord[] };

export type Action = { label: string; forward: Op[]; backward: Op[] };
