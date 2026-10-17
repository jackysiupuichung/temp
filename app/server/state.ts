/** Per-document server state: which paper a document maps to and whether the PDF must be re-attached (agent design §5.2). */
import fs from 'node:fs';
import path from 'node:path';

export type DocState = { sha256: string | null; pdfReattach: boolean; sessionIds: string[] };

export class StateStore {
  private file: string;
  private docs: Record<string, DocState> = {};
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
    try { this.docs = JSON.parse(fs.readFileSync(this.file, 'utf8')).docs ?? {}; } catch { this.docs = {}; }
  }
  get(docId: string): DocState { return this.docs[docId] ?? (this.docs[docId] = { sha256: null, pdfReattach: false, sessionIds: [] }); }
  update(docId: string, patch: Partial<DocState>): DocState {
    const next = { ...this.get(docId), ...patch };
    this.docs[docId] = next;
    this.save();
    return next;
  }
  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify({ docs: this.docs }, null, 2)); } catch (e) { console.warn('state save failed', e); }
  }
}
