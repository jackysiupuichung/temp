import { create } from 'zustand';
import { deleteDocumentCascade, getThumbnail, listDocuments, putBlob, putDocument, putThumbnail } from '../db/db';
import { buildPageRecords, loadPdfFromData, renderPageToCanvas, getPage } from '../pdf/pdf';
import { newId, type DocumentRecord } from '../model/types';

export type LibraryState = {
  documents: DocumentRecord[];
  thumbnails: Record<string, string>; // object URLs
  loaded: boolean;
  busy: string | null;
  storage: { usage: number; quota: number; persisted: boolean | null } | null;
  refresh(): Promise<void>;
  importPdf(file: File): Promise<DocumentRecord>;
  createBlankNotebook(title?: string): Promise<DocumentRecord>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  checkStorage(): Promise<void>;
  addImported(doc: DocumentRecord, thumb?: Blob): Promise<void>;
};

async function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality));
}

export async function makeThumbnailFromCanvas(c: HTMLCanvasElement): Promise<Blob> {
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

function blankThumbnail(): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 240; c.height = 310;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#e5e7eb';
  for (let y = 30; y < c.height; y += 24) { ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(c.width - 16, y); ctx.stroke(); }
  return canvasToBlob(c);
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  documents: [],
  thumbnails: {},
  loaded: false,
  busy: null,
  storage: null,

  async refresh() {
    const docs = await listDocuments();
    const thumbs = { ...get().thumbnails };
    await Promise.all(docs.map(async (d) => {
      if (thumbs[d.id]) return;
      const b = await getThumbnail(d.id);
      if (b) thumbs[d.id] = URL.createObjectURL(b);
    }));
    set({ documents: docs, thumbnails: thumbs, loaded: true });
  },

  async importPdf(file) {
    set({ busy: `Importing ${file.name}…` });
    try {
      const bytes = await file.arrayBuffer();
      const { pdf, dispose } = await loadPdfFromData(bytes);
      const pages = await buildPageRecords(pdf);
      const first = await getPage(pdf, 1);
      const vp = first.getViewport({ scale: 1 });
      const { promise } = renderPageToCanvas(first, 240 / vp.width);
      const canvas = await promise;
      const thumb = await makeThumbnailFromCanvas(canvas);
      canvas.width = 0; canvas.height = 0;
      await dispose();
      const now = Date.now();
      const blobId = newId();
      await putBlob(blobId, new Blob([bytes], { type: 'application/pdf' }));
      const doc: DocumentRecord = {
        id: newId(), title: file.name.replace(/\.pdf$/i, '') || 'Untitled', createdAt: now, updatedAt: now, lastOpenedAt: now,
        pdfBlobId: blobId, pages,
      };
      await get().addImported(doc, thumb);
      return doc;
    } finally {
      set({ busy: null });
    }
  },

  async addImported(doc, thumb) {
    await putDocument(doc);
    if (thumb) await putThumbnail(doc.id, thumb);
    await get().refresh();
  },

  async createBlankNotebook(title = 'Untitled notebook') {
    const now = Date.now();
    const doc: DocumentRecord = {
      id: newId(), title, createdAt: now, updatedAt: now, lastOpenedAt: now, pdfBlobId: null,
      pages: [{ id: newId(), kind: 'blank', width: 612, height: 792 }],
    };
    await get().addImported(doc, await blankThumbnail());
    return doc;
  },

  async rename(id, title) {
    const doc = get().documents.find((d) => d.id === id);
    if (!doc) return;
    await putDocument({ ...doc, title, updatedAt: Date.now() });
    await get().refresh();
  },

  async remove(id) {
    const doc = get().documents.find((d) => d.id === id);
    if (!doc) return;
    await deleteDocumentCascade(doc);
    const thumbs = { ...get().thumbnails };
    if (thumbs[id]) { URL.revokeObjectURL(thumbs[id]); delete thumbs[id]; }
    set({ thumbnails: thumbs });
    await get().refresh();
  },

  async checkStorage() {
    if (!('storage' in navigator) || !navigator.storage?.estimate) return;
    try {
      let persisted: boolean | null = null;
      if (navigator.storage.persist) {
        persisted = (await navigator.storage.persisted?.()) ?? null;
        if (!persisted) persisted = await navigator.storage.persist();
      }
      const est = await navigator.storage.estimate();
      set({ storage: { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted } });
    } catch { /* ignore */ }
  },
}));
