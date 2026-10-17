// Core data model. All annotation coordinates are PDF points relative to the
// page's top-left corner, in the page's *displayed* orientation (after /Rotate).

export type ViewState = { pageIndex: number; offsetY: number; zoom: number };

export type DocumentRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  pdfBlobId: string | null; // null for blank notebooks
  pages: PageRecord[]; // display order
  viewState?: ViewState;
  /** Agent SDK session for this document's Ask conversation (agent design §5.1). Cleared by "New conversation". */
  agentSessionId?: string | null;
  /** Content hash of the PDF bytes, computed once and used to sync the paper to the agent server. */
  pdfSha256?: string;
};

export type PageRecord = {
  id: string; // stable; never reuse indices as ids
  kind: 'pdf' | 'blank';
  pdfPageNumber?: number; // 1-based, for kind === "pdf"
  width: number; // PDF points, after rotation
  height: number;
};

export type StrokePoint = { x: number; y: number; p: number; t: number };

export type Stroke = {
  id: string;
  docId: string;
  pageId: string;
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB
  opacity: number;
  baseWidth: number; // PDF points
  points: StrokePoint[];
  createdAt: number;
};

export type TextBox = {
  id: string;
  docId: string;
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  /** 'answer' cards come from Ask (agent design §6.1); existing records have no kind and mean 'text'. */
  kind?: 'text' | 'answer';
  format?: 'plain' | 'markdown';
  answer?: AnswerMeta;
};

/** What an answer card remembers about the Ask that produced it. */
export type AnswerMeta = {
  askId: string;
  description: ScreenDescription; // what the vision step read, kept for edit-and-re-ask
  status: 'answering' | 'done' | 'error';
  error?: string;
  anchorRect: Rect; // the handwriting the card is attached to
  collapsed: boolean;
  /** Largest height the card may grow to in place before its body scrolls (set by placement). */
  maxHeight: number;
  floating?: boolean; // placed over dense text: drawn opaque with a shadow
  costUsd?: number;
};

/** Output of the vision interpreter (agent design §4.3). */
export type ScreenDescription = {
  location: { pages: number[]; section: string | null; summary: string };
  printedItems: Array<{ kind: 'paragraph' | 'equation' | 'figure' | 'table' | 'heading' | 'other'; label: string | null; page: number; text: string }>;
  handwriting: Array<{ text: string; box: { x0: number; y0: number; x1: number; y1: number }; page: number; near: string | null }>;
  unreadable: string | null;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type Selection = {
  pageId: string;
  boundingRect: Rect; // PDF points
  strokeIds: string[];
  textBoxIds: string[];
};

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'hand';

export type ToolSettings = {
  pen: { color: string; width: number; recentColors: string[] };
  highlighter: { color: string; width: number; recentColors: string[] };
  eraser: { mode: 'stroke' | 'partial'; radius: number };
  text: { color: string; fontSize: number };
};

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const PAGE_GAP = 16; // CSS px at zoom 1 (scaled with zoom)

export const PEN_WIDTHS = [1, 2, 3.5, 6, 10];
export const HIGHLIGHTER_WIDTHS = [10, 16, 24, 36];
export const PRESET_COLORS = [
  '#1f2937', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#2563eb', '#a855f7', '#ec4899', '#ffffff',
];
export const HIGHLIGHT_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd', '#67e8f9', '#d1d5db'];

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  pen: { color: '#1f2937', width: 2, recentColors: [] },
  highlighter: { color: '#fde047', width: 16, recentColors: [] },
  eraser: { mode: 'stroke', radius: 8 },
  text: { color: '#1f2937', fontSize: 14 },
};

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
