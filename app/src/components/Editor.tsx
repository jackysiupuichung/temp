import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Toolbar } from './Toolbar';
import { Viewer } from './Viewer';
import { ThumbnailSidebar } from './ThumbnailSidebar';
import { inputState } from './inputState';
import { releasePdf } from '../pdf/pdf';
import { persister } from '../persist/persist';
import type { ToolId } from '../model/types';
import { useAgentStore } from '../agent/client';
import { ask } from '../agent/ask';

export function Editor({ docId, onBack }: { docId: string; onBack: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const loading = useEditorStore((s) => s.loading);
  const error = useEditorStore((s) => s.error);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const openDocument = useEditorStore((s) => s.openDocument);
  const closeDocument = useEditorStore((s) => s.closeDocument);
  const renameDoc = useEditorStore((s) => s.renameDoc);

  useEffect(() => {
    void openDocument(docId);
    return () => {
      const d = useEditorStore.getState().doc;
      closeDocument();
      if (d?.pdfBlobId) releasePdf(d.pdfBlobId);
    };
  }, [docId, openDocument, closeDocument]);

  // Keyboard shortcuts (U-6, T-8).
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isTyping(e)) { inputState.spaceDown = true; if (!e.repeat) e.preventDefault(); return; }
      if (isTyping(e)) return;
      const st = useEditorStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); st.redo(); return; }
      if (mod && e.key.toLowerCase() === 'c') { if (st.selection) { e.preventDefault(); st.copySelection(); } return; }
      if (mod && e.key.toLowerCase() === 'x') { if (st.selection) { e.preventDefault(); st.cutSelection(); } return; }
      if (mod && e.key.toLowerCase() === 'v') { if (st.clipboard && st.doc) { e.preventDefault(); st.paste(st.doc.pages[st.currentPageIndex].id); } return; }
      if (mod && e.key.toLowerCase() === 'd') { if (st.selection) { e.preventDefault(); st.duplicateSelection(); } return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); st.setZoom(st.zoom * 1.2); return; }
      if (mod && e.key === '-') { e.preventDefault(); st.setZoom(st.zoom / 1.2); return; }
      if (mod && e.key === '0') { e.preventDefault(); st.requestFit('width'); return; }
      if (mod) return;
      if (e.key === 'Escape') { st.setSelection(null); st.setEditingTextBox(null); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection) { e.preventDefault(); st.deleteSelection(); return; }
      if (e.key.toLowerCase() === 'a') { e.preventDefault(); void ask().catch(() => {}); return; }
      const map: Record<string, ToolId> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text', v: 'hand' };
      const t = map[e.key.toLowerCase()];
      if (t) { st.setTool(t); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') inputState.spaceDown = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => { inputState.spaceDown = false; });
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  // Autosave on hide (S-1) is handled by the persister; also flush when leaving the editor.
  useEffect(() => () => { void persister.flush(); }, []);

  // Agent server pairing settings (agent design §2).
  useEffect(() => { void useAgentStore.getState().loadSettings(); }, []);

  if (error) return <div className="loading">Could not open document: {error} <button className="btn" onClick={onBack}>Back</button></div>;
  if (loading || !doc) return <div className="loading">Opening…</div>;

  return (
    <div className="editor">
      <Toolbar onBack={() => { void persister.flush(); onBack(); }} docTitle={doc.title} onRename={renameDoc} />
      <div className="editor-body">
        {sidebarOpen && <ThumbnailSidebar />}
        <Viewer />
      </div>
    </div>
  );
}
