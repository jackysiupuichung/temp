import { create } from 'zustand';
import {
  DEFAULT_TOOL_SETTINGS, newId, ZOOM_MAX, ZOOM_MIN,
  type DocumentRecord, type PageRecord, type Rect, type Selection, type Stroke, type TextBox, type ToolId, type ToolSettings, type ViewState,
} from '../model/types';
import { UndoStack, type Action, type Op } from '../model/undo';
import { getDocument, getStrokesForDoc, getTextBoxesForDoc, loadToolSettings, putSetting } from '../db/db';
import { persister } from '../persist/persist';
import { rectUnion, clamp } from '../geometry/transform';
import { strokeBounds, textBoxBounds, translateStroke, translateTextBox, scaleStroke, scaleTextBox } from '../geometry/strokes';

export type Clipboard = { strokes: Stroke[]; textBoxes: TextBox[]; rect: Rect };

export type EditorState = {
  doc: DocumentRecord | null;
  loading: boolean;
  error: string | null;
  strokesByPage: Record<string, Stroke[]>;
  textBoxesByPage: Record<string, TextBox[]>;
  selection: Selection | null;
  clipboard: Clipboard | null;
  tool: ToolId;
  toolSettings: ToolSettings;
  fingerDraws: boolean;
  zoom: number;
  currentPageIndex: number;
  sidebarOpen: boolean;
  editingTextBoxId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  penActive: boolean; // a pen stroke is in progress (for palm rejection)
  jumpToPage: { index: number; nonce: number } | null;
  fitRequest: { mode: 'width' | 'page'; nonce: number } | null;

  openDocument(id: string): Promise<void>;
  closeDocument(): void;
  applyAction(action: Action): void;
  undo(): void;
  redo(): void;
  addStroke(stroke: Stroke): void;
  eraseStrokes(pageId: string, ids: string[]): void;
  replaceStrokes(pageId: string, removed: Stroke[], added: Stroke[]): void;
  setSelection(sel: Selection | null): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  recolorSelection(color: string): void;
  copySelection(): void;
  cutSelection(): void;
  paste(pageId: string, at?: { x: number; y: number }): void;
  commitSelectionTransform(dx: number, dy: number, sx: number, sy: number, origin: { x: number; y: number }): void;
  addTextBox(tb: TextBox): void;
  /** Put a text box without an undo entry (answer cards while streaming; see recordTextBox). */
  putTextBoxSilently(tb: TextBox): void;
  /** Record the creation of an existing text box as one undo step (used when an answer card finishes). */
  recordTextBox(id: string, label: string): void;
  updateTextBox(id: string, patch: Partial<TextBox>, undoable: boolean): void;
  deleteTextBox(id: string): void;
  /** Record an undo entry for an edit session that was applied live (non-undoable) step by step. */
  commitTextBoxEdit(original: TextBox): void;
  setEditingTextBox(id: string | null): void;
  insertBlankPageAfter(index: number): void;
  deleteBlankPage(pageId: string): void;
  setTool(tool: ToolId): void;
  setToolSettings(patch: Partial<ToolSettings>): void;
  setFingerDraws(v: boolean): void;
  setZoom(z: number): void;
  setCurrentPageIndex(i: number): void;
  setSidebarOpen(v: boolean): void;
  requestJumpToPage(index: number): void;
  requestFit(mode: 'width' | 'page'): void;
  saveViewState(vs: ViewState): void;
  setPenActive(v: boolean): void;
  renameDoc(title: string): void;
  setAgentSession(sessionId: string | null): void;
  setPdfSha256(sha: string): void;
  getSelectedItems(): { strokes: Stroke[]; textBoxes: TextBox[] };
};

const undoStacks = new Map<string, UndoStack<Action>>();
function stackFor(docId: string): UndoStack<Action> {
  let s = undoStacks.get(docId);
  if (!s) { s = new UndoStack<Action>(200); undoStacks.set(docId, s); }
  return s;
}

function upsert<T extends { id: string }>(arr: T[] | undefined, items: T[]): T[] {
  const out = arr ? [...arr] : [];
  for (const it of items) {
    const i = out.findIndex((x) => x.id === it.id);
    if (i >= 0) out[i] = it; else out.push(it);
  }
  return out;
}

function applyOps(state: EditorState, ops: Op[]): Partial<EditorState> {
  let strokesByPage = state.strokesByPage;
  let textBoxesByPage = state.textBoxesByPage;
  let doc = state.doc;
  for (const op of ops) {
    switch (op.kind) {
      case 'putStrokes': {
        strokesByPage = { ...strokesByPage };
        const byPage = new Map<string, Stroke[]>();
        for (const s of op.items) { const a = byPage.get(s.pageId) ?? []; a.push(s); byPage.set(s.pageId, a); }
        for (const [pid, items] of byPage) strokesByPage[pid] = upsert(strokesByPage[pid], items);
        persister.putStrokes(op.items);
        break;
      }
      case 'deleteStrokes': {
        strokesByPage = { ...strokesByPage };
        const ids = new Set(op.ids);
        for (const pid of new Set(op.pageIds)) strokesByPage[pid] = (strokesByPage[pid] ?? []).filter((s) => !ids.has(s.id));
        persister.deleteStrokes(op.ids);
        break;
      }
      case 'putTextBoxes': {
        textBoxesByPage = { ...textBoxesByPage };
        const byPage = new Map<string, TextBox[]>();
        for (const t of op.items) { const a = byPage.get(t.pageId) ?? []; a.push(t); byPage.set(t.pageId, a); }
        for (const [pid, items] of byPage) textBoxesByPage[pid] = upsert(textBoxesByPage[pid], items);
        persister.putTextBoxes(op.items);
        break;
      }
      case 'deleteTextBoxes': {
        textBoxesByPage = { ...textBoxesByPage };
        const ids = new Set(op.ids);
        for (const pid of new Set(op.pageIds)) textBoxesByPage[pid] = (textBoxesByPage[pid] ?? []).filter((t) => !ids.has(t.id));
        persister.deleteTextBoxes(op.ids);
        break;
      }
      case 'setPages': {
        if (doc) { doc = { ...doc, pages: op.pages, updatedAt: Date.now() }; persister.document(doc); }
        break;
      }
    }
  }
  if (doc && doc !== state.doc) { /* already persisted */ }
  else if (doc) { doc = { ...doc, updatedAt: Date.now() }; persister.document(doc); }
  return { strokesByPage, textBoxesByPage, doc };
}

function selectionRect(strokes: Stroke[], boxes: TextBox[]): Rect {
  let r: Rect | null = null;
  for (const s of strokes) r = rectUnion(r, strokeBounds(s));
  for (const t of boxes) r = rectUnion(r, textBoxBounds(t));
  return r ?? { x: 0, y: 0, width: 0, height: 0 };
}

let toolSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let openToken = 0;

export const useEditorStore = create<EditorState>((set, get) => ({
  doc: null,
  loading: false,
  error: null,
  strokesByPage: {},
  textBoxesByPage: {},
  selection: null,
  clipboard: null,
  tool: 'pen',
  toolSettings: DEFAULT_TOOL_SETTINGS,
  fingerDraws: false,
  zoom: 1,
  currentPageIndex: 0,
  sidebarOpen: false,
  editingTextBoxId: null,
  canUndo: false,
  canRedo: false,
  penActive: false,
  jumpToPage: null,
  fitRequest: null,

  async openDocument(id) {
    const token = ++openToken;
    set({ loading: true, error: null, doc: null, strokesByPage: {}, textBoxesByPage: {}, selection: null, editingTextBoxId: null });
    try {
      const [doc, strokes, boxes, settings] = await Promise.all([getDocument(id), getStrokesForDoc(id), getTextBoxesForDoc(id), loadToolSettings()]);
      if (token !== openToken) return; // superseded by a newer open/close
      if (!doc) throw new Error('Document not found');
      const strokesByPage: Record<string, Stroke[]> = {};
      for (const s of strokes.sort((a, b) => a.createdAt - b.createdAt)) (strokesByPage[s.pageId] ??= []).push(s);
      const textBoxesByPage: Record<string, TextBox[]> = {};
      for (const t of boxes) {
        // An answer card still streaming when the page was closed can't resume: show it as interrupted, with Retry.
        const tb = t.kind === 'answer' && t.answer?.status === 'answering' ? { ...t, answer: { ...t.answer, status: 'error' as const, error: 'Interrupted' } } : t;
        (textBoxesByPage[tb.pageId] ??= []).push(tb);
      }
      const stack = stackFor(id);
      const opened = { ...doc, lastOpenedAt: Date.now() };
      persister.document(opened);
      const merged: ToolSettings = {
        ...DEFAULT_TOOL_SETTINGS, ...(settings ?? {}),
        pen: { ...DEFAULT_TOOL_SETTINGS.pen, ...(settings?.pen ?? {}) },
        highlighter: { ...DEFAULT_TOOL_SETTINGS.highlighter, ...(settings?.highlighter ?? {}) },
        eraser: { ...DEFAULT_TOOL_SETTINGS.eraser, ...(settings?.eraser ?? {}) },
        text: { ...DEFAULT_TOOL_SETTINGS.text, ...(settings?.text ?? {}) },
      };
      set({
        doc: opened, strokesByPage, textBoxesByPage, loading: false,
        zoom: clamp(doc.viewState?.zoom ?? 1, ZOOM_MIN, ZOOM_MAX),
        currentPageIndex: doc.viewState?.pageIndex ?? 0,
        canUndo: stack.canUndo, canRedo: stack.canRedo, toolSettings: merged,
      });
    } catch (e) {
      if (token === openToken) set({ loading: false, error: (e as Error).message });
    }
  },

  closeDocument() {
    openToken++;
    void persister.flush();
    set({ doc: null, strokesByPage: {}, textBoxesByPage: {}, selection: null, editingTextBoxId: null, clipboard: get().clipboard });
  },

  applyAction(action) {
    const st = get();
    if (!st.doc) return;
    const stack = stackFor(st.doc.id);
    stack.push(action);
    set({ ...applyOps(st, action.forward), canUndo: stack.canUndo, canRedo: stack.canRedo });
  },

  undo() {
    const st = get();
    if (!st.doc) return;
    const stack = stackFor(st.doc.id);
    const a = stack.undo();
    if (!a) return;
    set({ ...applyOps(st, a.backward), selection: null, editingTextBoxId: null, canUndo: stack.canUndo, canRedo: stack.canRedo });
  },

  redo() {
    const st = get();
    if (!st.doc) return;
    const stack = stackFor(st.doc.id);
    const a = stack.redo();
    if (!a) return;
    set({ ...applyOps(st, a.forward), selection: null, editingTextBoxId: null, canUndo: stack.canUndo, canRedo: stack.canRedo });
  },

  addStroke(stroke) {
    get().applyAction({
      label: 'Draw',
      forward: [{ kind: 'putStrokes', items: [stroke] }],
      backward: [{ kind: 'deleteStrokes', ids: [stroke.id], pageIds: [stroke.pageId] }],
    });
  },

  eraseStrokes(pageId, ids) {
    if (ids.length === 0) return;
    const existing = (get().strokesByPage[pageId] ?? []).filter((s) => ids.includes(s.id));
    if (existing.length === 0) return;
    get().applyAction({
      label: 'Erase',
      forward: [{ kind: 'deleteStrokes', ids: existing.map((s) => s.id), pageIds: [pageId] }],
      backward: [{ kind: 'putStrokes', items: existing }],
    });
  },

  replaceStrokes(pageId, removed, added) {
    if (removed.length === 0 && added.length === 0) return;
    get().applyAction({
      label: 'Erase',
      forward: [
        { kind: 'deleteStrokes', ids: removed.map((s) => s.id), pageIds: [pageId] },
        { kind: 'putStrokes', items: added },
      ],
      backward: [
        { kind: 'deleteStrokes', ids: added.map((s) => s.id), pageIds: [pageId] },
        { kind: 'putStrokes', items: removed },
      ],
    });
  },

  setSelection(sel) { set({ selection: sel, editingTextBoxId: null }); },

  getSelectedItems() {
    const { selection, strokesByPage, textBoxesByPage } = get();
    if (!selection) return { strokes: [], textBoxes: [] };
    const sid = new Set(selection.strokeIds), tid = new Set(selection.textBoxIds);
    return {
      strokes: (strokesByPage[selection.pageId] ?? []).filter((s) => sid.has(s.id)),
      textBoxes: (textBoxesByPage[selection.pageId] ?? []).filter((t) => tid.has(t.id)),
    };
  },

  deleteSelection() {
    const sel = get().selection;
    if (!sel) return;
    const { strokes, textBoxes } = get().getSelectedItems();
    get().applyAction({
      label: 'Delete selection',
      forward: [
        { kind: 'deleteStrokes', ids: strokes.map((s) => s.id), pageIds: [sel.pageId] },
        { kind: 'deleteTextBoxes', ids: textBoxes.map((t) => t.id), pageIds: [sel.pageId] },
      ],
      backward: [{ kind: 'putStrokes', items: strokes }, { kind: 'putTextBoxes', items: textBoxes }],
    });
    set({ selection: null });
  },

  duplicateSelection() {
    const sel = get().selection;
    if (!sel) return;
    const { strokes, textBoxes } = get().getSelectedItems();
    const off = 20;
    const ns = strokes.map((s) => ({ ...translateStroke(s, off, off), id: newId(), createdAt: Date.now() }));
    const nt = textBoxes.map((t) => ({ ...translateTextBox(t, off, off), id: newId() }));
    get().applyAction({
      label: 'Duplicate',
      forward: [{ kind: 'putStrokes', items: ns }, { kind: 'putTextBoxes', items: nt }],
      backward: [
        { kind: 'deleteStrokes', ids: ns.map((s) => s.id), pageIds: [sel.pageId] },
        { kind: 'deleteTextBoxes', ids: nt.map((t) => t.id), pageIds: [sel.pageId] },
      ],
    });
    set({ selection: { pageId: sel.pageId, strokeIds: ns.map((s) => s.id), textBoxIds: nt.map((t) => t.id), boundingRect: selectionRect(ns, nt) } });
  },

  recolorSelection(color) {
    const sel = get().selection;
    if (!sel) return;
    const { strokes, textBoxes } = get().getSelectedItems();
    const ns = strokes.map((s) => ({ ...s, color }));
    const nt = textBoxes.map((t) => ({ ...t, color }));
    get().applyAction({
      label: 'Recolour',
      forward: [{ kind: 'putStrokes', items: ns }, { kind: 'putTextBoxes', items: nt }],
      backward: [{ kind: 'putStrokes', items: strokes }, { kind: 'putTextBoxes', items: textBoxes }],
    });
  },

  copySelection() {
    const sel = get().selection;
    if (!sel) return;
    const { strokes, textBoxes } = get().getSelectedItems();
    set({ clipboard: { strokes, textBoxes, rect: sel.boundingRect } });
  },

  cutSelection() { get().copySelection(); get().deleteSelection(); },

  paste(pageId, at) {
    const { clipboard, doc } = get();
    if (!clipboard || !doc) return;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    const r = clipboard.rect;
    let dx = 0, dy = 0;
    if (at) { dx = at.x - r.x; dy = at.y - r.y; }
    else if (clipboard.strokes.some((s) => s.pageId === pageId) || clipboard.textBoxes.some((t) => t.pageId === pageId)) { dx = 20; dy = 20; }
    // keep inside page
    dx = clamp(r.x + dx, 0, Math.max(0, page.width - r.width)) - r.x;
    dy = clamp(r.y + dy, 0, Math.max(0, page.height - r.height)) - r.y;
    const ns = clipboard.strokes.map((s) => ({ ...translateStroke(s, dx, dy), id: newId(), pageId, docId: doc.id, createdAt: Date.now() }));
    const nt = clipboard.textBoxes.map((t) => ({ ...translateTextBox(t, dx, dy), id: newId(), pageId, docId: doc.id }));
    get().applyAction({
      label: 'Paste',
      forward: [{ kind: 'putStrokes', items: ns }, { kind: 'putTextBoxes', items: nt }],
      backward: [
        { kind: 'deleteStrokes', ids: ns.map((s) => s.id), pageIds: [pageId] },
        { kind: 'deleteTextBoxes', ids: nt.map((t) => t.id), pageIds: [pageId] },
      ],
    });
    set({ selection: { pageId, strokeIds: ns.map((s) => s.id), textBoxIds: nt.map((t) => t.id), boundingRect: selectionRect(ns, nt) }, tool: 'lasso' });
  },

  commitSelectionTransform(dx, dy, sx, sy, origin) {
    const sel = get().selection;
    if (!sel) return;
    if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return;
    const { strokes, textBoxes } = get().getSelectedItems();
    const ns = strokes.map((s) => translateStroke(scaleStroke(s, origin.x, origin.y, sx, sy), dx, dy));
    const nt = textBoxes.map((t) => translateTextBox(scaleTextBox(t, origin.x, origin.y, sx, sy), dx, dy));
    get().applyAction({
      label: 'Move',
      forward: [{ kind: 'putStrokes', items: ns }, { kind: 'putTextBoxes', items: nt }],
      backward: [{ kind: 'putStrokes', items: strokes }, { kind: 'putTextBoxes', items: textBoxes }],
    });
    set({ selection: { ...sel, boundingRect: selectionRect(ns, nt) } });
  },

  addTextBox(tb) {
    get().applyAction({
      label: 'Add text',
      forward: [{ kind: 'putTextBoxes', items: [tb] }],
      backward: [{ kind: 'deleteTextBoxes', ids: [tb.id], pageIds: [tb.pageId] }],
    });
    set({ editingTextBoxId: tb.id, selection: null });
  },

  putTextBoxSilently(tb) {
    set(applyOps(get(), [{ kind: 'putTextBoxes', items: [tb] }]));
  },

  recordTextBox(id, label) {
    const st = get();
    let existing: TextBox | undefined;
    for (const arr of Object.values(st.textBoxesByPage)) { existing = arr.find((t) => t.id === id); if (existing) break; }
    if (!existing) return;
    st.applyAction({ label, forward: [{ kind: 'putTextBoxes', items: [existing] }], backward: [{ kind: 'deleteTextBoxes', ids: [id], pageIds: [existing.pageId] }] });
  },

  updateTextBox(id, patch, undoable) {
    const st = get();
    let existing: TextBox | undefined;
    for (const arr of Object.values(st.textBoxesByPage)) { existing = arr.find((t) => t.id === id); if (existing) break; }
    if (!existing) return;
    const next = { ...existing, ...patch };
    if (undoable) {
      st.applyAction({ label: 'Edit text', forward: [{ kind: 'putTextBoxes', items: [next] }], backward: [{ kind: 'putTextBoxes', items: [existing] }] });
    } else {
      set(applyOps(st, [{ kind: 'putTextBoxes', items: [next] }]));
    }
  },

  deleteTextBox(id) {
    const st = get();
    let existing: TextBox | undefined;
    for (const arr of Object.values(st.textBoxesByPage)) { existing = arr.find((t) => t.id === id); if (existing) break; }
    if (!existing) return;
    st.applyAction({ label: 'Delete text', forward: [{ kind: 'deleteTextBoxes', ids: [id], pageIds: [existing.pageId] }], backward: [{ kind: 'putTextBoxes', items: [existing] }] });
    set({ editingTextBoxId: null, selection: null });
  },

  commitTextBoxEdit(original) {
    const st = get();
    const current = (st.textBoxesByPage[original.pageId] ?? []).find((t) => t.id === original.id);
    if (!current || current === original) return;
    if (current.text === original.text && current.x === original.x && current.y === original.y && current.width === original.width && current.height === original.height && current.fontSize === original.fontSize && current.color === original.color) return;
    st.applyAction({ label: 'Edit text', forward: [{ kind: 'putTextBoxes', items: [current] }], backward: [{ kind: 'putTextBoxes', items: [original] }] });
  },

  setEditingTextBox(id) { set({ editingTextBoxId: id }); },

  insertBlankPageAfter(index) {
    const doc = get().doc;
    if (!doc) return;
    const ref = doc.pages[index] ?? doc.pages[doc.pages.length - 1] ?? { width: 612, height: 792 };
    const page: PageRecord = { id: newId(), kind: 'blank', width: ref.width, height: ref.height };
    const pages = [...doc.pages];
    pages.splice(index + 1, 0, page);
    get().applyAction({ label: 'Insert page', forward: [{ kind: 'setPages', pages }], backward: [{ kind: 'setPages', pages: doc.pages }] });
  },

  deleteBlankPage(pageId) {
    const st = get();
    const doc = st.doc;
    if (!doc) return;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page || page.kind !== 'blank') return;
    const strokes = st.strokesByPage[pageId] ?? [];
    const boxes = st.textBoxesByPage[pageId] ?? [];
    const pages = doc.pages.filter((p) => p.id !== pageId);
    st.applyAction({
      label: 'Delete page',
      forward: [
        { kind: 'deleteStrokes', ids: strokes.map((s) => s.id), pageIds: [pageId] },
        { kind: 'deleteTextBoxes', ids: boxes.map((t) => t.id), pageIds: [pageId] },
        { kind: 'setPages', pages },
      ],
      backward: [{ kind: 'setPages', pages: doc.pages }, { kind: 'putStrokes', items: strokes }, { kind: 'putTextBoxes', items: boxes }],
    });
    if (st.selection?.pageId === pageId) set({ selection: null });
  },

  setTool(tool) {
    set({ tool, editingTextBoxId: null, selection: tool === 'lasso' ? get().selection : null });
  },

  setToolSettings(patch) {
    const next = { ...get().toolSettings, ...patch };
    set({ toolSettings: next });
    if (toolSettingsSaveTimer) clearTimeout(toolSettingsSaveTimer);
    toolSettingsSaveTimer = setTimeout(() => { void putSetting('toolSettings', next); }, 500);
  },

  setFingerDraws(v) { set({ fingerDraws: v }); },
  setZoom(z) { set({ zoom: clamp(z, ZOOM_MIN, ZOOM_MAX) }); },
  setCurrentPageIndex(i) { if (get().currentPageIndex !== i) set({ currentPageIndex: i }); },
  setSidebarOpen(v) { set({ sidebarOpen: v }); },
  requestJumpToPage(index) { set({ jumpToPage: { index, nonce: Math.random() } }); },
  requestFit(mode) { set({ fitRequest: { mode, nonce: Math.random() } }); },
  saveViewState(vs) {
    const doc = get().doc;
    if (!doc) return;
    const next = { ...doc, viewState: vs };
    set({ doc: next });
    persister.document(next);
  },
  setPenActive(v) { if (get().penActive !== v) set({ penActive: v }); },
  setAgentSession(sessionId) {
    const doc = get().doc;
    if (!doc || doc.agentSessionId === sessionId) return;
    const next = { ...doc, agentSessionId: sessionId };
    set({ doc: next });
    persister.document(next);
  },
  setPdfSha256(sha) {
    const doc = get().doc;
    if (!doc || doc.pdfSha256 === sha) return;
    const next = { ...doc, pdfSha256: sha };
    set({ doc: next });
    persister.document(next);
  },
  renameDoc(title) {
    const doc = get().doc;
    if (!doc) return;
    const next = { ...doc, title, updatedAt: Date.now() };
    set({ doc: next });
    persister.document(next);
  },
}));

/** Remember a colour as recently used for a tool (T-9). */
export function rememberColor(tool: 'pen' | 'highlighter', color: string) {
  const st = useEditorStore.getState();
  const cur = st.toolSettings[tool];
  const recent = [color, ...cur.recentColors.filter((c) => c !== color)].slice(0, 6);
  st.setToolSettings({ [tool]: { ...cur, color, recentColors: recent } } as Partial<ToolSettings>);
}
