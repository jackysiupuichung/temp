import { useCallback, useEffect, useRef, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import type { PageRecord, Stroke, StrokePoint, TextBox } from '../model/types';
import { newId } from '../model/types';
import { useEditorStore, rememberColor } from '../store/editorStore';
import { drawStroke, type LiveStroke } from '../ink/render';
import { strokeHitByCircle, splitStrokeByCircle, strokeInLasso, textBoxInLasso, strokeBounds, textBoxBounds } from '../geometry/strokes';
import { rectUnion, clamp } from '../geometry/transform';
import { inputState } from './inputState';

type Session =
  | { kind: 'draw'; pointerId: number; stroke: LiveStroke; predicted: StrokePoint[]; raf: number; t0: number; pointerType: string }
  | { kind: 'erase'; pointerId: number; removed: Map<string, Stroke>; added: Stroke[]; last: { x: number; y: number } | null; raf: number; cursor: { x: number; y: number } }
  | { kind: 'lasso'; pointerId: number; points: { x: number; y: number }[]; raf: number }
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; scroller: HTMLElement }
  | { kind: 'tap'; pointerId: number; x: number; y: number; cx: number; cy: number };

export type EraseState = { removed: Set<string>; added: Stroke[] } | null;

export function usePageInput(opts: {
  rootRef: RefObject<HTMLDivElement | null>;
  liveRef: RefObject<HTMLCanvasElement | null>;
  page: PageRecord;
  zoom: number;
  bitmapScale: number;
  onEraseChange: (s: EraseState) => void;
  onPanning: (v: boolean) => void;
}) {
  const { rootRef, liveRef, page, onEraseChange, onPanning } = opts;
  const zoomRef = useRef(opts.zoom); zoomRef.current = opts.zoom;
  const scaleRef = useRef(opts.bitmapScale); scaleRef.current = opts.bitmapScale;
  const session = useRef<Session | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const hoverRaf = useRef(0);

  const toPage = useCallback((clientX: number, clientY: number) => {
    const r = rectRef.current ?? rootRef.current!.getBoundingClientRect();
    const z = zoomRef.current;
    return { x: clamp((clientX - r.left) / z, 0, page.width), y: clamp((clientY - r.top) / z, 0, page.height) };
  }, [page.width, page.height, rootRef]);

  const liveCtx = useCallback(() => {
    const c = liveRef.current;
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(scaleRef.current, scaleRef.current);
    return ctx;
  }, [liveRef]);

  const clearLive = useCallback(() => {
    const c = liveRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    c.style.mixBlendMode = 'normal';
  }, [liveRef]);

  const drawLive = useCallback(() => {
    const s = session.current;
    const ctx = liveCtx();
    if (!ctx || !s) return;
    if (s.kind === 'draw') {
      s.raf = 0;
      const pts = s.predicted.length ? s.stroke.points.concat(s.predicted) : s.stroke.points;
      if (s.stroke.tool === 'highlighter') { ctx.globalAlpha = 0.4; liveRef.current!.style.mixBlendMode = 'multiply'; }
      drawStroke(ctx, { ...s.stroke, points: pts });
    } else if (s.kind === 'lasso') {
      s.raf = 0;
      if (s.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.closePath();
      ctx.lineWidth = 1.5 / zoomRef.current;
      ctx.setLineDash([6 / zoomRef.current, 4 / zoomRef.current]);
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = 'rgba(37,99,235,0.08)';
      ctx.fill(); ctx.stroke();
    } else if (s.kind === 'erase') {
      s.raf = 0;
      const r = eraserRadius();
      ctx.beginPath(); ctx.arc(s.cursor.x, s.cursor.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 1 / zoomRef.current; ctx.strokeStyle = '#64748b'; ctx.fillStyle = 'rgba(100,116,139,0.15)';
      ctx.fill(); ctx.stroke();
    }
  }, [liveCtx, liveRef]);

  const scheduleDraw = useCallback(() => {
    const s = session.current;
    if (!s || !('raf' in s) || s.raf) return;
    s.raf = requestAnimationFrame(drawLive);
  }, [drawLive]);

  function eraserRadius() {
    const r = useEditorStore.getState().toolSettings.eraser.radius;
    return Math.max(r, 6 / zoomRef.current);
  }

  const endSession = useCallback((commit: boolean) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    const st = useEditorStore.getState();
    if ('raf' in s && s.raf) cancelAnimationFrame(s.raf);
    if (s.kind === 'draw') {
      clearLive();
      if (commit && s.stroke.points.length > 0) {
        const stroke: Stroke = {
          id: newId(), docId: st.doc!.id, pageId: page.id, tool: s.stroke.tool, color: s.stroke.color, opacity: s.stroke.opacity,
          baseWidth: s.stroke.baseWidth, points: s.stroke.points, createdAt: Date.now(),
        };
        st.addStroke(stroke);
        rememberColor(stroke.tool, stroke.color);
      }
    } else if (s.kind === 'erase') {
      clearLive();
      onEraseChange(null);
      if (commit) st.replaceStrokes(page.id, [...s.removed.values()], s.added);
    } else if (s.kind === 'lasso') {
      clearLive();
      if (commit) {
        const strokes = (st.strokesByPage[page.id] ?? []).filter((x) => strokeInLasso(x, s.points));
        const boxes = (st.textBoxesByPage[page.id] ?? []).filter((t) => textBoxInLasso(t, s.points));
        if (strokes.length === 0 && boxes.length === 0) st.setSelection(null);
        else {
          let r = null as ReturnType<typeof strokeBounds> | null;
          for (const x of strokes) r = rectUnion(r, strokeBounds(x));
          for (const t of boxes) r = rectUnion(r, textBoxBounds(t));
          st.setSelection({ pageId: page.id, boundingRect: r!, strokeIds: strokes.map((x) => x.id), textBoxIds: boxes.map((t) => t.id) });
        }
      }
    } else if (s.kind === 'pan') {
      onPanning(false);
    } else if (s.kind === 'tap') {
      if (commit) {
        const fs = st.toolSettings.text.fontSize;
        const width = Math.min(220, page.width - s.x);
        const tb: TextBox = {
          id: newId(), docId: st.doc!.id, pageId: page.id, x: Math.max(0, Math.min(s.x, page.width - width)), y: Math.max(0, Math.min(s.y, page.height - fs * 1.3 - 8)),
          width, height: fs * 1.3 + 8, text: '', fontSize: fs, color: st.toolSettings.text.color,
        };
        st.addTextBox(tb);
      }
    }
    if (inputState.activePenPointer === s.pointerId) { inputState.activePenPointer = null; st.setPenActive(false); }
  }, [clearLive, onEraseChange, onPanning, page]);

  const eraseAt = useCallback((s: Extract<Session, { kind: 'erase' }>, x: number, y: number) => {
    const st = useEditorStore.getState();
    const mode = st.toolSettings.eraser.mode;
    const r = eraserRadius();
    const base = (st.strokesByPage[page.id] ?? []);
    // sample along the segment so fast moves don't skip strokes
    const samples: { x: number; y: number }[] = [];
    if (s.last) {
      const d = Math.hypot(x - s.last.x, y - s.last.y);
      const n = Math.min(12, Math.max(1, Math.ceil(d / r)));
      for (let i = 1; i <= n; i++) samples.push({ x: s.last.x + ((x - s.last.x) * i) / n, y: s.last.y + ((y - s.last.y) * i) / n });
    } else samples.push({ x, y });
    s.last = { x, y };
    let changed = false;
    for (const pt of samples) {
      if (mode === 'stroke') {
        for (const stroke of base) {
          if (s.removed.has(stroke.id)) continue;
          if (strokeHitByCircle(stroke, pt.x, pt.y, r)) { s.removed.set(stroke.id, stroke); changed = true; }
        }
      } else {
        const working: Stroke[] = [...base.filter((b) => !s.removed.has(b.id)), ...s.added];
        for (const stroke of working) {
          const pieces = splitStrokeByCircle(stroke, pt.x, pt.y, r);
          if (!pieces) continue;
          changed = true;
          const isAdded = s.added.some((a) => a.id === stroke.id);
          if (isAdded) s.added = s.added.filter((a) => a.id !== stroke.id); else s.removed.set(stroke.id, stroke);
          for (const pc of pieces) s.added.push({ ...stroke, id: newId(), points: pc, createdAt: Date.now() });
        }
      }
    }
    if (changed) onEraseChange({ removed: new Set(s.removed.keys()), added: s.added });
  }, [onEraseChange, page.id]);

  const onPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const st = useEditorStore.getState();
    const type = e.pointerType;
    if (session.current) {
      // a second contact while drawing: a finger landing is ignored (palm); a second finger in finger-draw mode cancels for pinch
      if (type === 'touch' && st.fingerDraws && session.current.kind !== 'pan') endSession(false);
      return;
    }
    if (type === 'touch') {
      if (inputState.activePenPointer !== null) return;
      if (!st.fingerDraws) return; // one finger scrolls natively; two fingers pinch (Viewer)
      if (!e.isPrimary) return;
    }
    if (type === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest('.page-tools, .selection-box, .selection-toolbar, .textbox')) return;
    if (st.editingTextBoxId) { st.setEditingTextBox(null); }
    rectRef.current = rootRef.current!.getBoundingClientRect();
    const tool = st.tool;
    const pan = tool === 'hand' || inputState.spaceDown || (type === 'mouse' && e.button === 1);
    const root = rootRef.current!;
    try { root.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    if (type === 'pen') { inputState.activePenPointer = e.pointerId; st.setPenActive(true); }
    const { x, y } = toPage(e.clientX, e.clientY);
    if (pan) {
      const scroller = root.closest('.viewer') as HTMLElement;
      session.current = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, scroller };
      onPanning(true);
      e.preventDefault();
      return;
    }
    if (tool === 'pen' || tool === 'highlighter') {
      const ts = st.toolSettings[tool];
      const p = type === 'mouse' ? 0.5 : e.pressure > 0 ? e.pressure : 0.5;
      session.current = {
        kind: 'draw', pointerId: e.pointerId, pointerType: type, t0: e.timeStamp, predicted: [], raf: 0,
        stroke: { tool, color: ts.color, opacity: tool === 'highlighter' ? 0.4 : 1, baseWidth: ts.width, points: [{ x, y, p, t: 0 }] },
      };
      if (st.selection) st.setSelection(null);
      scheduleDraw();
    } else if (tool === 'eraser') {
      session.current = { kind: 'erase', pointerId: e.pointerId, removed: new Map(), added: [], last: null, raf: 0, cursor: { x, y } };
      eraseAt(session.current, x, y);
      scheduleDraw();
    } else if (tool === 'lasso') {
      session.current = { kind: 'lasso', pointerId: e.pointerId, points: [{ x, y }], raf: 0 };
    } else if (tool === 'text') {
      session.current = { kind: 'tap', pointerId: e.pointerId, x, y, cx: e.clientX, cy: e.clientY };
    }
    e.preventDefault();
  }, [endSession, eraseAt, onPanning, rootRef, scheduleDraw, toPage]);

  const onPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s) {
      // Pencil hover preview
      if (e.pointerType === 'pen' && e.buttons === 0 && useEditorStore.getState().tool !== 'hand') {
        if (hoverRaf.current) return;
        hoverRaf.current = requestAnimationFrame(() => {
          hoverRaf.current = 0;
          const ctx = liveCtx(); if (!ctx) return;
          rectRef.current = null;
          const { x, y } = toPage(e.clientX, e.clientY);
          const st = useEditorStore.getState();
          const t = st.tool;
          const r = t === 'eraser' ? eraserRadius() : t === 'highlighter' ? st.toolSettings.highlighter.width / 2 : Math.max(1.5, st.toolSettings.pen.width / 2);
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = t === 'eraser' ? 'rgba(100,116,139,0.2)' : t === 'highlighter' ? st.toolSettings.highlighter.color : st.toolSettings.pen.color;
          ctx.globalAlpha = t === 'highlighter' ? 0.4 : 0.7; ctx.fill();
        });
      }
      return;
    }
    if (e.pointerId !== s.pointerId) return;
    if (s.kind === 'pan') {
      s.scroller.scrollLeft -= e.clientX - s.lastX;
      s.scroller.scrollTop -= e.clientY - s.lastY;
      s.lastX = e.clientX; s.lastY = e.clientY;
      return;
    }
    const native = e.nativeEvent as PointerEvent;
    if (s.kind === 'draw') {
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const list = events.length ? events : [native];
      for (const ev of list) {
        const { x, y } = toPage(ev.clientX, ev.clientY);
        const last = s.stroke.points[s.stroke.points.length - 1];
        if (last && Math.abs(last.x - x) < 0.05 && Math.abs(last.y - y) < 0.05) continue;
        const p = s.pointerType === 'mouse' ? 0.5 : ev.pressure > 0 ? ev.pressure : 0.5;
        s.stroke.points.push({ x, y, p, t: Math.round(ev.timeStamp - s.t0) });
      }
      s.predicted = [];
      if (typeof native.getPredictedEvents === 'function') {
        for (const ev of native.getPredictedEvents().slice(0, 2)) {
          const { x, y } = toPage(ev.clientX, ev.clientY);
          s.predicted.push({ x, y, p: ev.pressure > 0 ? ev.pressure : 0.5, t: 0 });
        }
      }
      scheduleDraw();
    } else if (s.kind === 'erase') {
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const list = events.length ? events : [native];
      for (const ev of list) { const { x, y } = toPage(ev.clientX, ev.clientY); eraseAt(s, x, y); }
      s.cursor = toPage(e.clientX, e.clientY);
      scheduleDraw();
    } else if (s.kind === 'lasso') {
      const { x, y } = toPage(e.clientX, e.clientY);
      const last = s.points[s.points.length - 1];
      if (Math.hypot(last.x - x, last.y - y) > 1.5 / zoomRef.current) s.points.push({ x, y });
      scheduleDraw();
    } else if (s.kind === 'tap') {
      if (Math.hypot(e.clientX - s.cx, e.clientY - s.cy) > 8) { endSession(false); }
    }
  }, [endSession, eraseAt, liveCtx, scheduleDraw, toPage]);

  const onPointerUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (s.kind === 'draw') {
      const { x, y } = toPage(e.clientX, e.clientY);
      const last = s.stroke.points[s.stroke.points.length - 1];
      if (!last || Math.abs(last.x - x) > 0.05 || Math.abs(last.y - y) > 0.05) s.stroke.points.push({ x, y, p: s.pointerType === 'mouse' ? 0.5 : e.pressure > 0 ? e.pressure : last?.p ?? 0.5, t: Math.round(e.timeStamp - s.t0) });
    }
    endSession(true);
  }, [endSession, toPage]);

  const onPointerCancel = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    // Keep ink drawn so far rather than losing it on a stray cancel.
    endSession(s.kind === 'draw' && s.stroke.points.length > 2);
  }, [endSession]);

  const onPointerLeave = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!session.current && e.pointerType === 'pen') clearLive();
  }, [clearLive]);

  useEffect(() => () => { if (session.current) endSession(false); }, [endSession]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave };
}
