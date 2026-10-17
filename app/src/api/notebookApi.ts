/**
 * Small API module for other modules (e.g. a future AI assistant) to read the
 * document, selection and page images without touching components.
 */
import { useEditorStore } from '../store/editorStore';
import { useLibraryStore } from '../store/libraryStore';
import { loadPdf, getPage, renderPageToCanvas, getPageTextItems, loadPdfBytes, clampBitmapScale, type TextItem } from '../pdf/pdf';
import { drawPageAnnotations } from '../ink/render';
import type { Rect, Selection, DocumentRecord, Stroke, TextBox } from '../model/types';

function currentDoc(): DocumentRecord {
  const d = useEditorStore.getState().doc;
  if (!d) throw new Error('No document open');
  return d;
}

async function pageBitmap(pageId: string, scale: number): Promise<HTMLCanvasElement> {
  const doc = currentDoc();
  const rec = doc.pages.find((p) => p.id === pageId);
  if (!rec) throw new Error('Unknown page ' + pageId);
  const s = clampBitmapScale(rec.width, rec.height, scale);
  let canvas: HTMLCanvasElement;
  if (rec.kind === 'pdf' && doc.pdfBlobId && rec.pdfPageNumber) {
    const pdf = await loadPdf(doc.pdfBlobId);
    const page = await getPage(pdf, rec.pdfPageNumber);
    canvas = await renderPageToCanvas(page, s).promise;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rec.width * s); canvas.height = Math.ceil(rec.height * s);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const st = useEditorStore.getState();
  const ctx = canvas.getContext('2d')!;
  drawPageAnnotations(ctx, st.strokesByPage[pageId] ?? [], st.textBoxesByPage[pageId] ?? [], s);
  return canvas;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

/** X-1: render any page with its annotations to a PNG at `scale` px per PDF point. */
export async function renderPageImage(pageId: string, scale = 2): Promise<Blob> {
  const c = await pageBitmap(pageId, scale);
  const b = await toBlob(c);
  c.width = 0; c.height = 0;
  return b;
}

/** X-2: render a cropped region (PDF points, page top-left origin) with annotations. */
export async function renderRegionImage(pageId: string, rect: Rect, scale = 2): Promise<Blob> {
  const c = await pageBitmap(pageId, scale);
  const s = c.width / currentDoc().pages.find((p) => p.id === pageId)!.width;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.width * s)); out.height = Math.max(1, Math.round(rect.height * s));
  out.getContext('2d')!.drawImage(c, rect.x * s, rect.y * s, rect.width * s, rect.height * s, 0, 0, out.width, out.height);
  const b = await toBlob(out);
  c.width = 0; c.height = 0; out.width = 0; out.height = 0;
  return b;
}

/** X-5: pdf.js text content with positions (PDF points, displayed orientation, top-left origin). */
export async function getPageText(pageId: string): Promise<TextItem[]> {
  const doc = currentDoc();
  const rec = doc.pages.find((p) => p.id === pageId);
  if (!rec || rec.kind !== 'pdf' || !doc.pdfBlobId || !rec.pdfPageNumber) return [];
  const pdf = await loadPdf(doc.pdfBlobId);
  return getPageTextItems(await getPage(pdf, rec.pdfPageNumber));
}

/** X-5: the original, unmodified PDF bytes. */
export async function getOriginalPdfBytes(docId?: string): Promise<ArrayBuffer | null> {
  const doc = docId ? (await import('../db/db')).getDocument(docId) : Promise.resolve(currentDoc());
  const d = await doc;
  if (!d?.pdfBlobId) return null;
  return loadPdfBytes(d.pdfBlobId);
}

/** X-3: current lasso selection, and a subscription for changes. */
export function getSelection(): Selection | null { return useEditorStore.getState().selection; }
export function subscribeSelection(cb: (sel: Selection | null) => void): () => void {
  return useEditorStore.subscribe((s, prev) => { if (s.selection !== prev.selection) cb(s.selection); });
}

/** X-6: read-only snapshot of document + annotation state. */
export function getDocumentState(): { doc: DocumentRecord | null; strokesByPage: Record<string, Stroke[]>; textBoxesByPage: Record<string, TextBox[]>; zoom: number; currentPageIndex: number } {
  const s = useEditorStore.getState();
  return { doc: s.doc, strokesByPage: s.strokesByPage, textBoxesByPage: s.textBoxesByPage, zoom: s.zoom, currentPageIndex: s.currentPageIndex };
}

import { askApi } from '../agent/ask';
import { useAgentStore, client as agentClient } from '../agent/client';
import { captureViewport } from '../agent/capture';

export const notebookApi = {
  renderPageImage, renderRegionImage, getPageText, getOriginalPdfBytes, getSelection, subscribeSelection, getDocumentState,
  store: useEditorStore, library: useLibraryStore,
  /** Ask (agent design): the same entry points the toolbar uses, plus the capture for the debug view. */
  ask: askApi, agent: useAgentStore, agentClient, captureViewport,
};
declare global { interface Window { __notebook: typeof notebookApi } }
if (typeof window !== 'undefined') window.__notebook = notebookApi;
