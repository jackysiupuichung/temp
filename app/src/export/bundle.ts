import JSZip from 'jszip';
import { getBlob, getStrokesForDoc, getTextBoxesForDoc, putBlob } from '../db/db';
import type { DocumentRecord, Stroke, TextBox } from '../model/types';
import { newId } from '../model/types';
import { useLibraryStore } from '../store/libraryStore';
import { loadPdfFromData, renderPageToCanvas, getPage } from '../pdf/pdf';

const FORMAT = 'pdf-notebook-bundle/1';

/** Zip with the original PDF + annotations JSON, for backup or moving between devices. */
export async function exportBundle(doc: DocumentRecord): Promise<Blob> {
  const zip = new JSZip();
  const [strokes, textBoxes] = await Promise.all([getStrokesForDoc(doc.id), getTextBoxesForDoc(doc.id)]);
  zip.file('manifest.json', JSON.stringify({ format: FORMAT, exportedAt: Date.now() }));
  zip.file('document.json', JSON.stringify(doc));
  zip.file('strokes.json', JSON.stringify(strokes));
  zip.file('textBoxes.json', JSON.stringify(textBoxes));
  if (doc.pdfBlobId) {
    const blob = await getBlob(doc.pdfBlobId);
    if (blob) zip.file('original.pdf', await blob.arrayBuffer());
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Import a bundle as a new document (all ids are remapped so re-importing never collides). */
export async function importBundle(file: File): Promise<DocumentRecord> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docJson = await zip.file('document.json')?.async('string');
  if (!docJson) throw new Error('Not a PDF Notebook bundle');
  const src = JSON.parse(docJson) as DocumentRecord;
  const strokes = JSON.parse((await zip.file('strokes.json')?.async('string')) ?? '[]') as Stroke[];
  const textBoxes = JSON.parse((await zip.file('textBoxes.json')?.async('string')) ?? '[]') as TextBox[];
  const pdfBytes = await zip.file('original.pdf')?.async('arraybuffer');

  const pageMap = new Map<string, string>();
  const pages = src.pages.map((p) => { const id = newId(); pageMap.set(p.id, id); return { ...p, id }; });
  const now = Date.now();
  const docId = newId();
  let pdfBlobId: string | null = null;
  let thumb: Blob | undefined;
  if (pdfBytes) {
    pdfBlobId = newId();
    await putBlob(pdfBlobId, new Blob([pdfBytes], { type: 'application/pdf' }));
    const { pdf, dispose } = await loadPdfFromData(pdfBytes);
    const first = await getPage(pdf, 1);
    const vp = first.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(first, 240 / vp.width).promise;
    thumb = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('thumb'))), 'image/jpeg', 0.8));
    canvas.width = 0; canvas.height = 0;
    await dispose();
  }
  const doc: DocumentRecord = { ...src, id: docId, pdfBlobId, pages, createdAt: now, updatedAt: now, lastOpenedAt: now, title: src.title + (src.title.endsWith('(imported)') ? '' : ' (imported)') };
  const lib = useLibraryStore.getState();
  await lib.addImported(doc, thumb);
  const { writeBatch } = await import('../db/db');
  await writeBatch({
    putStrokes: strokes.filter((s) => pageMap.has(s.pageId)).map((s) => ({ ...s, id: newId(), docId, pageId: pageMap.get(s.pageId)! })),
    putTextBoxes: textBoxes.filter((t) => pageMap.has(t.pageId)).map((t) => ({ ...t, id: newId(), docId, pageId: pageMap.get(t.pageId)! })),
  });
  return doc;
}
