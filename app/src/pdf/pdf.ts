import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getBlob } from '../db/db';
import type { PageRecord } from '../model/types';
import { newId } from '../model/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const docCache = new Map<string, { task: PDFDocumentLoadingTask; promise: Promise<PDFDocumentProxy> }>();
const bytesCache = new Map<string, Promise<ArrayBuffer>>();

export async function loadPdfBytes(blobId: string): Promise<ArrayBuffer> {
  let p = bytesCache.get(blobId);
  if (!p) {
    p = (async () => {
      const blob = await getBlob(blobId);
      if (!blob) throw new Error('PDF blob missing: ' + blobId);
      return blob.arrayBuffer();
    })();
    bytesCache.set(blobId, p);
  }
  return p;
}

/** Load (and cache) a pdf.js document for a stored blob. Rendering happens in the pdf.js worker. */
export function loadPdf(blobId: string): Promise<PDFDocumentProxy> {
  let entry = docCache.get(blobId);
  if (!entry) {
    let task: PDFDocumentLoadingTask | null = null;
    const promise = (async () => {
      const bytes = await loadPdfBytes(blobId);
      // pdf.js transfers the buffer to the worker; pass a copy so the cache keeps the original.
      task = pdfjs.getDocument({ data: bytes.slice(0) });
      const e = docCache.get(blobId);
      if (e) e.task = task;
      return task.promise;
    })();
    entry = { task: task as unknown as PDFDocumentLoadingTask, promise };
    docCache.set(blobId, entry);
    promise.catch(() => docCache.delete(blobId));
  }
  return entry.promise;
}

export function releasePdf(blobId: string): void {
  const e = docCache.get(blobId);
  docCache.delete(blobId);
  bytesCache.delete(blobId);
  if (e) e.promise.then(() => e.task?.destroy()).catch(() => {});
}

/** Load a pdf from bytes; returns the document plus a dispose function. */
export async function loadPdfFromData(data: ArrayBuffer): Promise<{ pdf: PDFDocumentProxy; dispose: () => Promise<void> }> {
  const task = pdfjs.getDocument({ data: data.slice(0) });
  const pdf = await task.promise;
  return { pdf, dispose: () => task.destroy() };
}

/** Build PageRecords (displayed size after rotation) for every page of a pdf. */
export async function buildPageRecords(pdf: PDFDocumentProxy): Promise<PageRecord[]> {
  const out: PageRecord[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    out.push({ id: newId(), kind: 'pdf', pdfPageNumber: i, width: vp.width, height: vp.height });
  }
  return out;
}

const pageCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PDFPageProxy>>>();

export function getPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<PDFPageProxy> {
  let m = pageCache.get(pdf);
  if (!m) { m = new Map(); pageCache.set(pdf, m); }
  let p = m.get(pageNumber);
  if (!p) { p = pdf.getPage(pageNumber); m.set(pageNumber, p); }
  return p;
}

/** Largest bitmap we allow per canvas (Safari caps around 16.7M px). */
export const MAX_CANVAS_PIXELS = 14_000_000;
export const MAX_CANVAS_SIDE = 8192;

export function clampBitmapScale(widthPt: number, heightPt: number, wanted: number): number {
  let s = wanted;
  const px = widthPt * heightPt * s * s;
  if (px > MAX_CANVAS_PIXELS) s = Math.sqrt(MAX_CANVAS_PIXELS / (widthPt * heightPt));
  if (widthPt * s > MAX_CANVAS_SIDE) s = MAX_CANVAS_SIDE / widthPt;
  if (heightPt * s > MAX_CANVAS_SIDE) s = MAX_CANVAS_SIDE / heightPt;
  return s;
}

/**
 * Render a pdf page into a fresh canvas at `scale` px per PDF point. Returns
 * the canvas and a cancel function. The page's own rotation is applied.
 */
export function renderPageToCanvas(
  page: PDFPageProxy, scale: number, canvas: HTMLCanvasElement = document.createElement('canvas'),
): { promise: Promise<HTMLCanvasElement>; cancel: () => void } {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvas, canvasContext: ctx, viewport, intent: 'display' });
  return {
    promise: task.promise.then(() => canvas),
    cancel: () => task.cancel(),
  };
}

export type TextItem = { str: string; x: number; y: number; width: number; height: number; fontName: string };

/** Text content with positions in displayed page coordinates (PDF points, top-left origin). */
export async function getPageTextItems(page: PDFPageProxy): Promise<TextItem[]> {
  const content = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const out: TextItem[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const tx = pdfjs.Util.transform(vp.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const w = item.width;
    const h = item.height || fontHeight;
    // tx[4], tx[5] is the baseline-left in viewport (top-left) coords
    out.push({ str: item.str, x: tx[4], y: tx[5] - h, width: w, height: h, fontName: item.fontName });
  }
  return out;
}
