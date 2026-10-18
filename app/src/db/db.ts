import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocumentRecord, Stroke, TextBox, ToolSettings } from '../model/types';

interface NotebookDB extends DBSchema {
  documents: { key: string; value: DocumentRecord; indexes: { byUpdated: number } };
  blobs: { key: string; value: { id: string; blob: Blob } };
  thumbnails: { key: string; value: { docId: string; blob: Blob } };
  strokes: { key: string; value: Stroke; indexes: { byDoc: string; byPage: string } };
  textBoxes: { key: string; value: TextBox; indexes: { byDoc: string; byPage: string } };
  settings: { key: string; value: { key: string; value: unknown } };
}

let dbPromise: Promise<IDBPDatabase<NotebookDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<NotebookDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NotebookDB>('pdf-notebook', 1, {
      upgrade(db) {
        createStores(db);
      },
    }).catch((e: unknown) => {
      // A newer build may have upgraded this database (extra stores only); open it at its current version
      // rather than failing every read and leaving the library on "Loading…" forever.
      if ((e as DOMException)?.name !== 'VersionError') {
        dbPromise = null;
        throw e;
      }
      return openDB<NotebookDB>('pdf-notebook');
    });
  }
  return dbPromise;
}

function createStores(db: IDBPDatabase<NotebookDB>) {
  const docs = db.createObjectStore('documents', { keyPath: 'id' });
  docs.createIndex('byUpdated', 'updatedAt');
  db.createObjectStore('blobs', { keyPath: 'id' });
  db.createObjectStore('thumbnails', { keyPath: 'docId' });
  const strokes = db.createObjectStore('strokes', { keyPath: 'id' });
  strokes.createIndex('byDoc', 'docId');
  strokes.createIndex('byPage', 'pageId');
  const tbs = db.createObjectStore('textBoxes', { keyPath: 'id' });
  tbs.createIndex('byDoc', 'docId');
  tbs.createIndex('byPage', 'pageId');
  db.createObjectStore('settings', { keyPath: 'key' });
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const db = await getDB();
  const all = await db.getAll('documents');
  return all.sort((a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt));
}

export async function getDocument(id: string): Promise<DocumentRecord | undefined> {
  return (await getDB()).get('documents', id);
}

export async function putDocument(doc: DocumentRecord): Promise<void> {
  await (await getDB()).put('documents', doc);
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await (await getDB()).put('blobs', { id, blob });
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await (await getDB()).get('blobs', id))?.blob;
}

export async function putThumbnail(docId: string, blob: Blob): Promise<void> {
  await (await getDB()).put('thumbnails', { docId, blob });
}

export async function getThumbnail(docId: string): Promise<Blob | undefined> {
  return (await (await getDB()).get('thumbnails', docId))?.blob;
}

export async function getStrokesForDoc(docId: string): Promise<Stroke[]> {
  return (await getDB()).getAllFromIndex('strokes', 'byDoc', docId);
}

export async function getTextBoxesForDoc(docId: string): Promise<TextBox[]> {
  return (await getDB()).getAllFromIndex('textBoxes', 'byDoc', docId);
}

export type WriteBatch = {
  document?: DocumentRecord;
  putStrokes?: Stroke[];
  deleteStrokes?: string[];
  putTextBoxes?: TextBox[];
  deleteTextBoxes?: string[];
};

/** Apply a batch of writes in one transaction. */
export async function writeBatch(b: WriteBatch): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['documents', 'strokes', 'textBoxes'], 'readwrite');
  const ps: Promise<unknown>[] = [];
  if (b.document) ps.push(tx.objectStore('documents').put(b.document));
  const ss = tx.objectStore('strokes');
  for (const s of b.putStrokes ?? []) ps.push(ss.put(s));
  for (const id of b.deleteStrokes ?? []) ps.push(ss.delete(id));
  const ts = tx.objectStore('textBoxes');
  for (const t of b.putTextBoxes ?? []) ps.push(ts.put(t));
  for (const id of b.deleteTextBoxes ?? []) ps.push(ts.delete(id));
  await Promise.all(ps);
  await tx.done;
}

export async function deleteDocumentCascade(doc: DocumentRecord): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['documents', 'blobs', 'thumbnails', 'strokes', 'textBoxes'], 'readwrite');
  const strokeIds = await tx.objectStore('strokes').index('byDoc').getAllKeys(doc.id);
  const tbIds = await tx.objectStore('textBoxes').index('byDoc').getAllKeys(doc.id);
  await Promise.all([
    tx.objectStore('documents').delete(doc.id),
    doc.pdfBlobId ? tx.objectStore('blobs').delete(doc.pdfBlobId) : Promise.resolve(),
    tx.objectStore('thumbnails').delete(doc.id),
    ...strokeIds.map((k) => tx.objectStore('strokes').delete(k)),
    ...tbIds.map((k) => tx.objectStore('textBoxes').delete(k)),
  ]);
  await tx.done;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await (await getDB()).get('settings', key))?.value as T | undefined;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('settings', { key, value });
}

export async function loadToolSettings(): Promise<Partial<ToolSettings> | undefined> {
  return getSetting<Partial<ToolSettings>>('toolSettings');
}
