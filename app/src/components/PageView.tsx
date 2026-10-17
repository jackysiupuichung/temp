import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjs, getPage, renderPageToCanvas, clampBitmapScale } from '../pdf/pdf';
import type { PageRecord, Stroke, TextBox } from '../model/types';
import { useEditorStore } from '../store/editorStore';
import { drawHighlights, drawPenStrokes } from '../ink/render';
import type { PageLayout } from '../geometry/transform';
import { usePageInput, type EraseState } from './usePageInput';
import { SelectionOverlay } from './SelectionOverlay';
import { TextBoxView } from './TextBoxView';
import { IconPlus, IconTrash } from './icons';

const EMPTY_STROKES: Stroke[] = [];
const EMPTY_BOXES: TextBox[] = [];

export type PageViewProps = {
  page: PageRecord; index: number; total: number; layout: PageLayout; zoom: number; renderZoom: number; dpr: number;
  pdf: PDFDocumentProxy | null; onPanning: (v: boolean) => void;
};

export const PageView = memo(function PageView({ page, index, total, layout, zoom, renderZoom, dpr, pdf, onPanning }: PageViewProps) {
  const strokes = useEditorStore((s) => s.strokesByPage[page.id] ?? EMPTY_STROKES);
  const textBoxes = useEditorStore((s) => s.textBoxesByPage[page.id] ?? EMPTY_BOXES);
  const selection = useEditorStore((s) => (s.selection?.pageId === page.id ? s.selection : null));
  const tool = useEditorStore((s) => s.tool);
  const editingTextBoxId = useEditorStore((s) => s.editingTextBoxId);
  const insertBlankPageAfter = useEditorStore((s) => s.insertBlankPageAfter);
  const deleteBlankPage = useEditorStore((s) => s.deleteBlankPage);

  const rootRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLCanvasElement>(null);
  const hlRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [erase, setErase] = useState<EraseState>(null);
  const [rendered, setRendered] = useState(false);

  const bitmapScale = clampBitmapScale(page.width, page.height, renderZoom * dpr);
  const bw = Math.ceil(page.width * bitmapScale), bh = Math.ceil(page.height * bitmapScale);

  // --- PDF bitmap (rendered in the pdf.js worker; old bitmap stays until the new one is ready) ---
  useEffect(() => {
    if (!pdf || page.kind !== 'pdf' || !page.pdfPageNumber) return;
    let cancelled = false;
    let cancelRender: (() => void) | null = null;
    getPage(pdf, page.pdfPageNumber).then((p) => {
      if (cancelled) return;
      const r = renderPageToCanvas(p, bitmapScale);
      cancelRender = r.cancel;
      r.promise.then((tmp) => {
        if (cancelled) { tmp.width = 0; tmp.height = 0; return; }
        const c = pdfRef.current!;
        c.width = tmp.width; c.height = tmp.height;
        c.getContext('2d', { alpha: false })!.drawImage(tmp, 0, 0);
        tmp.width = 0; tmp.height = 0;
        setRendered(true);
      }).catch(() => { /* cancelled */ });
    });
    return () => { cancelled = true; cancelRender?.(); };
  }, [pdf, page.kind, page.pdfPageNumber, bitmapScale]);

  // Release bitmaps when the page leaves the viewport (V-3).
  useEffect(() => () => {
    for (const r of [pdfRef, hlRef, inkRef, liveRef]) { const c = r.current; if (c) { c.width = 0; c.height = 0; } }
  }, []);

  // --- Text layer (invisible, V-9) ---
  useEffect(() => {
    if (!pdf || page.kind !== 'pdf' || !page.pdfPageNumber || !textRef.current) return;
    const container = textRef.current;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let cancelled = false;
    getPage(pdf, page.pdfPageNumber).then((p) => {
      if (cancelled) return;
      container.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container, viewport: p.getViewport({ scale: 1 }) });
      layer.render().catch(() => {});
    });
    return () => { cancelled = true; layer?.cancel(); container.replaceChildren(); };
  }, [pdf, page.kind, page.pdfPageNumber]);

  // --- Finished ink, cached per page (F-4) ---
  const selectedIds = selection ? new Set([...selection.strokeIds]) : null;
  const selKey = selection ? selection.strokeIds.join(',') : '';
  useLayoutEffect(() => {
    const hl = hlRef.current!, ink = inkRef.current!;
    hl.width = bw; hl.height = bh; ink.width = bw; ink.height = bh;
    let visible = strokes;
    if (selectedIds) visible = visible.filter((s) => !selectedIds.has(s.id));
    if (erase) visible = [...visible.filter((s) => !erase.removed.has(s.id)), ...erase.added];
    const hctx = hl.getContext('2d')!;
    hctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHighlights(hctx, visible, bitmapScale);
    const ictx = ink.getContext('2d')!;
    ictx.setTransform(bitmapScale, 0, 0, bitmapScale, 0, 0);
    drawPenStrokes(ictx, visible);
  }, [strokes, bw, bh, bitmapScale, selKey, erase]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const live = liveRef.current!;
    live.width = bw; live.height = bh;
  }, [bw, bh]);

  const onEraseChange = useCallback((s: EraseState) => setErase(s), []);
  const handlers = usePageInput({ rootRef, liveRef, page, zoom, bitmapScale, onEraseChange, onPanning });

  const w = layout.width, h = layout.height;
  const objectsInert = !(tool === 'text' || tool === 'lasso');

  return (
    <div
      ref={rootRef}
      className={'page' + (page.kind === 'blank' ? ' blank' : '')}
      data-page-index={index}
      data-page-id={page.id}
      style={{ left: layout.x, top: layout.y, width: w, height: h, cursor: tool === 'hand' ? undefined : tool === 'text' ? 'text' : 'crosshair' }}
      {...handlers}
    >
      {page.kind === 'pdf' && <canvas ref={pdfRef} className="pdf" aria-hidden="true" />}
      {page.kind === 'pdf' && !rendered && <div className="pending">Rendering page {index + 1}…</div>}
      <div ref={textRef} className="textLayer layer" style={{ ['--total-scale-factor' as string]: String(zoom), ['--min-font-size' as string]: '1' }} />
      <canvas ref={hlRef} className="highlights" aria-hidden="true" />
      <canvas ref={inkRef} className="ink" aria-hidden="true" />
      {selection && <SelectionOverlay page={page} zoom={zoom} bitmapScale={bitmapScale} selection={selection} strokes={strokes} textBoxes={textBoxes} />}
      <div className={'objects layer' + (objectsInert ? ' inert' : '')}>
        {textBoxes.map((tb) => (
          <TextBoxView key={tb.id} tb={tb} zoom={zoom} tool={tool} editing={editingTextBoxId === tb.id} selected={!!selection?.textBoxIds.includes(tb.id)} page={page} />
        ))}
      </div>
      <canvas ref={liveRef} className="live" aria-hidden="true" style={{ pointerEvents: 'none' }} />
      <div className="page-tools">
        <button className="btn icon-btn" title="Insert blank page after this page" aria-label="Insert blank page after this page" onPointerDown={(e) => e.stopPropagation()} onClick={() => insertBlankPageAfter(index)}><IconPlus /></button>
        {page.kind === 'blank' && (
          <button className="btn icon-btn danger" title="Delete this blank page" aria-label="Delete this blank page" onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (strokes.length === 0 && textBoxes.length === 0 || window.confirm('Delete this page and its annotations?')) deleteBlankPage(page.id); }}><IconTrash /></button>
        )}
      </div>
      <div className="page-number-badge">{index + 1} / {total}</div>
    </div>
  );
});
