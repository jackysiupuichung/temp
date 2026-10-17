/** Per-document server state: which paper a document maps to, and what each of its agent sessions holds (agent design §5.2). */
import fs from 'node:fs';
import path from 'node:path';

/** What one agent session has in context: the paper it is about and whether that paper's PDF block is still in its history. */
export type SessionState = { sha256: string | null; pdfInContext: boolean };
export type DocState = { sha256: string | null; sessions: Record<string, SessionState> };

export class StateStore {
  private file: string;
  private docs: Record<string, DocState> = {};
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
    try { this.docs = JSON.parse(fs.readFileSync(this.file, 'utf8')).docs ?? {}; } catch { this.docs = {}; }
  }
  get(docId: string): DocState {
    const d = (this.docs[docId] ??= { sha256: null, sessions: {} });
    d.sessions ??= {}; // state.json written before sessions were tracked
    return d;
  }
  update(docId: string, patch: Partial<DocState>): DocState {
    const next = { ...this.get(docId), ...patch };
    this.docs[docId] = next;
    this.save();
    return next;
  }
  setSession(docId: string, sessionId: string, s: SessionState): void {
    const d = this.get(docId);
    this.update(docId, { sessions: { ...d.sessions, [sessionId]: s } });
  }
  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify({ docs: this.docs }, null, 2)); } catch (e) { console.warn('state save failed', e); }
  }
}
