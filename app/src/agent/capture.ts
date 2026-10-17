/**
 * Step 1 of Ask (agent design §3): a screenshot of what is on screen, built by
 * the app itself from the mounted page canvases, plus the text under it and a
 * CaptureMap for converting image coordinates back to page coordinates.
 */
import { useEditorStore } from '../store/editorStore';
import { layoutPages, pageIndexAtContentY, visiblePageRange } from '../geometry/transform';
import { getPageText, renderRegionImage } from '../api/notebookApi';
import { strokeBounds } from '../geometry/strokes';
import { drawTextBoxes } from '../ink/render';
import type { DocumentRecord, Rect } from '../model/types';
import type { CaptureMap } from './protocol';
import type { PlacementPage } from './placement';

export type Capture = {
  image: string; // base64 PNG
  imageSize: { width: number; height: number };
  capture: CaptureMap[];
  visibleText: Array<{ pageNumber: number; text: string }>;
  pages: PlacementPage[];
  viewportMidPageId: string;
};

export const CAPTURE_MAX_EDGE = 1568;
const SEPARATOR_PT = 6;
const VISIBLE_TEXT_MAX_CHARS = 6000; // about 1,500 tokens

type Region = { pageId: string; pageNumber: number; index: number; rect: Rect };

/** Which parts of which pages are on screen, in page points. */
export function visibleRegions(doc: DocumentRecord, zoom: number, scroller: { clientWidth: number; clientHeight: number; scrollTop: number; scrollLeft: number }): { regions: Region[]; midIndex: number } {
  const layout = layoutPages(doc.pages, zoom, scroller.clientWidth);
  const top = scroller.scrollTop, bottom = top + scroller.clientHeight, left = scroller.scrollLeft, right = left + scroller.clientWidth;
  const [first, last] = visiblePageRange(layout, top, bottom);
  const regions: Region[] = [];
  for (let i = first; i <= last; i++) {
    const pl = layout.pages[i];
    if (!pl) continue;
    const x0 = Math.max(pl.x, left), x1 = Math.min(pl.x + pl.width, right);
    const y0 = Math.max(pl.y, top), y1 = Math.min(pl.y + pl.height, bottom);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    regions.push({ pageId: doc.pages[i].id, pageNumber: i + 1, index: i, rect: { x: (x0 - pl.x) / zoom, y: (y0 - pl.y) / zoom, width: (x1 - x0) / zoom, height: (y1 - y0) / zoom } });
  }
  const midIndex = Math.max(0, Math.min(doc.pages.length - 1, pageIndexAtContentY(layout, top + scroller.clientHeight / 2)));
  return { regions, midIndex };
}

/** Text items inside a rect, joined in reading order. */
export function joinTextInRect(items: Array<{ str: string; x: number; y: number; width: number; height: number }>, rect: Rect): string {
  const inside = items.filter((t) => t.str.trim() && t.x + t.width > rect.x && t.x < rect.x + rect.width && t.y + t.height > rect.y && t.y < rect.y + rect.height);
  inside.sort((a, b) => (Math.abs(a.y - b.y) < Math.max(2, Math.min(a.height, b.height) * 0.5) ? a.x - b.x : a.y - b.y));
  let out = '';
  let lastY = -Infinity, lastH = 0;
  for (const t of inside) {
    if (out && Math.abs(t.y - lastY) >= Math.max(2, lastH * 0.5)) out += '\n';
    else if (out && !out.endsWith(' ')) out += ' ';
    out += t.str;
    lastY = t.y; lastH = t.height;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

async function drawRegion(ctx: CanvasRenderingContext2D, doc: DocumentRecord, r: Region, scale: number, dx: number, dy: number): Promise<void> {
  const page = doc.pages[r.index];
  const dw = r.rect.width * scale, dh = r.rect.height * scale;
  const st = useEditorStore.getState();
  const el = typeof document !== 'undefined' ? document.querySelector<HTMLElement>(`.page[data-page-id="${r.pageId}"]`) : null;
  const pdfCanvas = el?.querySelector<HTMLCanvasElement>('canvas.pdf') ?? null;
  const fastPath = page.kind === 'blank' || (pdfCanvas && pdfCanvas.width > 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(dx, dy, dw, dh);
  if (fastPath) {
    const copy = (c: HTMLCanvasElement | null, blend: GlobalCompositeOperation = 'source-over') => {
      if (!c || c.width === 0) return;
      const s = c.width / page.width;
      ctx.save();
      ctx.globalCompositeOperation = blend;
      ctx.drawImage(c, r.rect.x * s, r.rect.y * s, r.rect.width * s, r.rect.height * s, dx, dy, dw, dh);
      ctx.restore();
    };
    copy(pdfCanvas);
    copy(el?.querySelector<HTMLCanvasElement>('canvas.highlights') ?? null, 'multiply');
    copy(el?.querySelector<HTMLCanvasElement>('canvas.ink') ?? null);
    // Plain text boxes are DOM, not canvas; answer cards are left out so the interpreter sees the page, not earlier answers.
    const boxes = (st.textBoxesByPage[r.pageId] ?? []).filter((t) => (t.kind ?? 'text') === 'text');
    if (boxes.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
      ctx.translate(dx - r.rect.x * scale, dy - r.rect.y * scale);
      ctx.scale(scale, scale);
      drawTextBoxes(ctx, boxes);
      ctx.restore();
    }
  } else {
    const blob = await renderRegionImage(r.pageId, r.rect, scale);
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, dx, dy, dw, dh);
    bmp.close();
  }
}

/** Capture the viewport as it is (§3.1–3.2). */
export async function captureViewport(): Promise<Capture> {
  const st = useEditorStore.getState();
  const doc = st.doc;
  if (!doc) throw new Error('No document open');
  const scroller = document.querySelector<HTMLElement>('.viewer');
  if (!scroller) throw new Error('Viewer not mounted');
  const { regions, midIndex } = visibleRegions(doc, st.zoom, scroller);
  if (regions.length === 0) throw new Error('Nothing on screen to capture');
  const widthPt = Math.max(...regions.map((r) => r.rect.width));
  const heightPt = regions.reduce((s, r) => s + r.rect.height, 0) + SEPARATOR_PT * (regions.length - 1);
  const scale = Math.max(0.5, Math.min(3, CAPTURE_MAX_EDGE / Math.max(widthPt, heightPt)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPt * scale));
  canvas.height = Math.max(1, Math.round(heightPt * scale));
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const capture: CaptureMap[] = [];
  let y = 0;
  for (const r of regions) {
    const dh = r.rect.height * scale, dw = r.rect.width * scale;
    await drawRegion(ctx, doc, r, scale, 0, y);
    capture.push({ pageId: r.pageId, pageNumber: r.pageNumber, pageRect: { ...r.rect }, imageRect: { x: 0, y, width: dw, height: dh } });
    y += dh + SEPARATOR_PT * scale;
  }
  const image = canvas.toDataURL('image/png').split(',')[1];
  canvas.width = 0; canvas.height = 0;

  const visibleText: Capture['visibleText'] = [];
  const pages: PlacementPage[] = [];
  let budget = VISIBLE_TEXT_MAX_CHARS;
  for (const r of regions) {
    const page = doc.pages[r.index];
    const items = await getPageText(r.pageId);
    let text = joinTextInRect(items, r.rect);
    if (text.length > budget) text = text.slice(0, Math.max(0, budget)) + (budget > 0 ? ' …' : '');
    budget -= text.length;
    if (text) visibleText.push({ pageNumber: r.pageNumber, text });
    pages.push({
      pageId: r.pageId, pageNumber: r.pageNumber, width: page.width, height: page.height, visible: { ...r.rect },
      textItems: items.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
      strokes: (st.strokesByPage[r.pageId] ?? []).map((s) => ({ rect: strokeBounds(s), tool: s.tool })),
      textBoxes: (st.textBoxesByPage[r.pageId] ?? []).map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
    });
  }
  return { image, imageSize: { width: Math.round(widthPt * scale), height: Math.round(heightPt * scale) }, capture, visibleText, pages, viewportMidPageId: doc.pages[midIndex].id };
}
