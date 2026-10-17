import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PageRecord, Selection, Stroke, TextBox } from '../model/types';
import { PRESET_COLORS, HIGHLIGHT_COLORS } from '../model/types';
import { useEditorStore } from '../store/editorStore';
import { drawHighlights, drawPenStrokes } from '../ink/render';
import { IconCopy, IconDuplicate, IconPalette, IconScissors, IconTrash } from './icons';
import { Popover } from './Popover';

type Drag = { mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; pointerId: number; startX: number; startY: number; dx: number; dy: number; sx: number; sy: number };

export function SelectionOverlay({ page, zoom, bitmapScale, selection, strokes, textBoxes }: {
  page: PageRecord; zoom: number; bitmapScale: number; selection: Selection; strokes: Stroke[]; textBoxes: TextBox[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const { deleteSelection, duplicateSelection, copySelection, cutSelection, recolorSelection, commitSelectionTransform } = useEditorStore.getState();
  const r = selection.boundingRect;
  const sel = new Set(selection.strokeIds);
  const selected = strokes.filter((s) => sel.has(s.id));
  const selKey = selection.strokeIds.join(',');

  // Draw the selected strokes on their own canvas so moving them is a CSS transform, not a redraw.
  useLayoutEffect(() => {
    const c = canvasRef.current!;
    c.width = Math.ceil(page.width * bitmapScale); c.height = Math.ceil(page.height * bitmapScale);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHighlights(ctx, selected, bitmapScale);
    ctx.setTransform(bitmapScale, 0, 0, bitmapScale, 0, 0);
    drawPenStrokes(ctx, selected);
  }, [strokes, selKey, bitmapScale, page.width, page.height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { const c = canvasRef.current; if (c) { c.width = 0; c.height = 0; } }, []);

  const applyTransform = (d: Drag) => {
    const t = `translate(${d.dx * zoom}px, ${d.dy * zoom}px)`;
    const originX = d.mode === 'nw' || d.mode === 'sw' ? r.x + r.width : r.x;
    const originY = d.mode === 'nw' || d.mode === 'ne' ? r.y + r.height : r.y;
    const c = canvasRef.current!, b = boxRef.current!;
    if (d.mode === 'move') {
      c.style.transformOrigin = '0 0'; c.style.transform = t;
      b.style.transform = t;
    } else {
      c.style.transformOrigin = `${originX * zoom}px ${originY * zoom}px`;
      c.style.transform = `scale(${d.sx}, ${d.sy})`;
      b.style.transformOrigin = `${(originX - r.x) * zoom}px ${(originY - r.y) * zoom}px`;
      b.style.transform = `scale(${d.sx}, ${d.sy})`;
    }
    // move the text boxes too (they are DOM)
    for (const id of selection.textBoxIds) {
      const el = document.querySelector<HTMLElement>(`[data-textbox-id="${id}"]`);
      if (!el) continue;
      if (d.mode === 'move') el.style.transform = t;
      else { el.style.transformOrigin = `${(originX - (textBoxes.find((x) => x.id === id)?.x ?? 0)) * zoom}px ${(originY - (textBoxes.find((x) => x.id === id)?.y ?? 0)) * zoom}px`; el.style.transform = `scale(${d.sx}, ${d.sy})`; }
    }
  };
  const clearTransform = () => {
    for (const el of [canvasRef.current, boxRef.current]) if (el) { el.style.transform = ''; el.style.transformOrigin = ''; }
    for (const id of selection.textBoxIds) { const el = document.querySelector<HTMLElement>(`[data-textbox-id="${id}"]`); if (el) { el.style.transform = ''; el.style.transformOrigin = ''; } }
  };

  const start = (mode: Drag['mode']) => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && useEditorStore.getState().penActive) return;
    e.stopPropagation(); e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    drag.current = { mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, sx: 1, sy: 1 };
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - d.startX) / zoom, dy = (e.clientY - d.startY) / zoom;
    if (d.mode === 'move') {
      d.dx = Math.max(-r.x, Math.min(page.width - r.x - r.width, dx));
      d.dy = Math.max(-r.y, Math.min(page.height - r.y - r.height, dy));
    } else {
      const signX = d.mode === 'ne' || d.mode === 'se' ? 1 : -1;
      const signY = d.mode === 'sw' || d.mode === 'se' ? 1 : -1;
      d.sx = Math.max(0.05, (r.width + signX * dx) / Math.max(r.width, 1));
      d.sy = Math.max(0.05, (r.height + signY * dy) / Math.max(r.height, 1));
      if (e.shiftKey) { const s = Math.max(d.sx, d.sy); d.sx = s; d.sy = s; }
    }
    applyTransform(d);
  };
  const end = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    clearTransform();
    const originX = d.mode === 'nw' || d.mode === 'sw' ? r.x + r.width : r.x;
    const originY = d.mode === 'nw' || d.mode === 'ne' ? r.y + r.height : r.y;
    commitSelectionTransform(d.dx, d.dy, d.sx, d.sy, { x: originX, y: originY });
  };

  const left = r.x * zoom, top = r.y * zoom;
  const toolbarTop = top > 56 ? top - 52 : top + r.height * zoom + 8;
  const anyHighlight = selected.some((s) => s.tool === 'highlighter');

  return (
    <>
      <canvas ref={canvasRef} className="sel layer" style={{ pointerEvents: 'none', mixBlendMode: anyHighlight && selected.every((s) => s.tool === 'highlighter') ? 'multiply' : 'normal' }} aria-hidden="true" />
      <div
        ref={boxRef} className="selection-box" role="group" aria-label="Selection"
        style={{ left, top, width: r.width * zoom, height: r.height * zoom }}
        onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
          <div key={h} className={'handle ' + h} role="button" aria-label={`Resize ${h}`} onPointerDown={start(h)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
        ))}
      </div>
      <div className="selection-toolbar group" style={{ left: Math.max(0, Math.min(left, page.width * zoom - 240)), top: toolbarTop }} onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn icon-btn" title="Delete" aria-label="Delete selection" onClick={deleteSelection}><IconTrash /></button>
        <button className="btn icon-btn" title="Duplicate" aria-label="Duplicate selection" onClick={duplicateSelection}><IconDuplicate /></button>
        <button className="btn icon-btn" title="Copy" aria-label="Copy selection" onClick={copySelection}><IconCopy /></button>
        <button className="btn icon-btn" title="Cut" aria-label="Cut selection" onClick={cutSelection}><IconScissors /></button>
        <button className="btn icon-btn" title="Colour" aria-label="Recolour selection" data-popover-anchor aria-expanded={colorOpen} onClick={() => setColorOpen((v) => !v)}><IconPalette /></button>
        <Popover open={colorOpen} onClose={() => setColorOpen(false)}>
          <h4>Recolour</h4>
          <div className="swatches">
            {(anyHighlight ? HIGHLIGHT_COLORS : PRESET_COLORS).map((c) => (
              <button key={c} className="swatch" aria-label={c} onClick={() => { recolorSelection(c); setColorOpen(false); }}><span style={{ background: c }} /></button>
            ))}
          </div>
        </Popover>
      </div>
    </>
  );
}
