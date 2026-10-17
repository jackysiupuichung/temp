import { writeBatch, type WriteBatch } from '../db/db';
import type { DocumentRecord, Stroke, TextBox } from '../model/types';

/**
 * Debounced autosave queue. Changes are merged into one pending batch and
 * flushed <= 600 ms after the last change, or immediately on visibilitychange /
 * pagehide. No manual save.
 */
class Persister {
  private pending: {
    document?: DocumentRecord;
    putStrokes: Map<string, Stroke>;
    deleteStrokes: Set<string>;
    putTextBoxes: Map<string, TextBox>;
    deleteTextBoxes: Set<string>;
  } = this.empty();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  readonly delayMs = 600;
  onError: ((e: unknown) => void) | null = null;

  private empty() {
    return { putStrokes: new Map<string, Stroke>(), deleteStrokes: new Set<string>(), putTextBoxes: new Map<string, TextBox>(), deleteTextBoxes: new Set<string>() };
  }

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void this.flush(); });
      window.addEventListener('pagehide', () => { void this.flush(); });
      window.addEventListener('beforeunload', () => { void this.flush(); });
    }
  }

  document(doc: DocumentRecord) { this.pending.document = doc; this.schedule(); }
  putStrokes(items: Stroke[]) {
    for (const s of items) { this.pending.deleteStrokes.delete(s.id); this.pending.putStrokes.set(s.id, s); }
    this.schedule();
  }
  deleteStrokes(ids: string[]) {
    for (const id of ids) { this.pending.putStrokes.delete(id); this.pending.deleteStrokes.add(id); }
    this.schedule();
  }
  putTextBoxes(items: TextBox[]) {
    for (const t of items) { this.pending.deleteTextBoxes.delete(t.id); this.pending.putTextBoxes.set(t.id, t); }
    this.schedule();
  }
  deleteTextBoxes(ids: string[]) {
    for (const id of ids) { this.pending.putTextBoxes.delete(id); this.pending.deleteTextBoxes.add(id); }
    this.schedule();
  }

  get hasPending(): boolean {
    const p = this.pending;
    return !!p.document || p.putStrokes.size > 0 || p.deleteStrokes.size > 0 || p.putTextBoxes.size > 0 || p.deleteTextBoxes.size > 0;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.flushing) await this.flushing;
    if (!this.hasPending) return;
    const p = this.pending;
    this.pending = this.empty();
    const batch: WriteBatch = {
      document: p.document,
      putStrokes: [...p.putStrokes.values()],
      deleteStrokes: [...p.deleteStrokes],
      putTextBoxes: [...p.putTextBoxes.values()],
      deleteTextBoxes: [...p.deleteTextBoxes],
    };
    this.flushing = writeBatch(batch).catch((e) => { this.onError?.(e); }).finally(() => { this.flushing = null; });
    await this.flushing;
  }
}

export const persister = new Persister();
