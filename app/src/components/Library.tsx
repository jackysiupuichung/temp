import { useEffect, useRef, useState } from 'react';
import { useLibraryStore } from '../store/libraryStore';
import { importBundle } from '../export/bundle';
import type { DocumentRecord } from '../model/types';
import { IconPlus } from './icons';

function fmtDate(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const { documents, thumbnails, loaded, busy, storage, refresh, importPdf, createBlankNotebook, rename, remove, checkStorage } = useLibraryStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const bundleRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<DocumentRecord | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { void refresh(); void checkStorage(); }, [refresh, checkStorage]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);

  const handleFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        if (/\.zip$/i.test(f.name)) { await importBundle(f); setToast(`Imported bundle ${f.name}`); }
        else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') { await importPdf(f); }
        else setToast(`Skipped ${f.name}: not a PDF`);
      } catch (e) {
        setToast(`Import failed: ${(e as Error).message}`);
      }
    }
  };

  const filtered = query ? documents.filter((d) => d.title.toLowerCase().includes(query.toLowerCase())) : documents;
  const nearlyFull = storage && storage.quota > 0 && storage.usage / storage.quota > 0.85;

  return (
    <div
      className={'library' + (dragOver ? ' drag-over' : '')}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
    >
      <header className="library-header">
        <h1>PDF Notebook</h1>
        <input className="input" type="search" placeholder="Search by title" aria-label="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" onClick={() => void createBlankNotebook()}><IconPlus /><span className="label">Blank notebook</span></button>
        <button className="btn primary" onClick={() => fileRef.current?.click()}><span className="label">Import PDF</span></button>
        <button className="btn" onClick={() => bundleRef.current?.click()}><span className="label">Import bundle</span></button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); e.target.value = ''; }} />
        <input ref={bundleRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); e.target.value = ''; }} />
      </header>
      {nearlyFull && <div className="banner">Storage is nearly full ({Math.round(storage!.usage / 1e6)} MB of {Math.round(storage!.quota / 1e6)} MB). Delete documents you no longer need.</div>}
      {storage && storage.persisted === false && <div className="banner">The browser may evict local data under storage pressure. Add this app to your Home Screen to keep documents safe.</div>}
      <div className="library-body">
        {!loaded ? <div className="empty">Loading…</div> : filtered.length === 0 ? (
          <div className="empty">
            {documents.length === 0 ? <>No documents yet. Import a PDF, drop one here, or create a blank notebook.</> : <>No documents match “{query}”.</>}
          </div>
        ) : (
          <div className="doc-grid">
            {filtered.map((d) => (
              <div key={d.id} className="doc-card" role="group" aria-label={d.title}>
                <button className="doc-thumb btn" style={{ borderRadius: 0, padding: 0, minHeight: 0 }} onClick={() => onOpen(d.id)} aria-label={`Open ${d.title}`}>
                  {thumbnails[d.id] ? <img src={thumbnails[d.id]} alt="" /> : <div style={{ color: '#94a3b8', padding: 16 }}>No preview</div>}
                </button>
                <div className="doc-meta" onClick={() => onOpen(d.id)}>
                  <div className="doc-title" title={d.title}>{d.title}</div>
                  <div className="doc-date">{d.pages.length} pages · opened {fmtDate(d.lastOpenedAt || d.updatedAt)}</div>
                </div>
                <div className="doc-actions">
                  <button className="btn" onClick={() => { const t = window.prompt('Rename document', d.title); if (t && t.trim()) void rename(d.id, t.trim()); }}>Rename</button>
                  <button className="btn danger" onClick={() => setConfirmDelete(d)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {busy && <div className="toast">{busy}</div>}
      {toast && <div className="toast">{toast}</div>}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="del-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="del-title">Delete “{confirmDelete.title}”?</h3>
            <p>This removes the document and all of its annotations from this device. This can't be undone.</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn primary" style={{ background: 'var(--danger)' }} onClick={() => { void remove(confirmDelete.id); setConfirmDelete(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
