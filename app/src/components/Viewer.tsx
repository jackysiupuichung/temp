import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEditorStore } from '../store/editorStore';
import { layoutPages, pageIndexAtContentY, visiblePageRange, clamp, type Layout } from '../geometry/transform';
import { ZOOM_MAX, ZOOM_MIN, PAGE_GAP } from '../model/types';
import { loadPdf } from '../pdf/pdf';
import { PageView } from './PageView';
import { inputState } from './inputState';

type Anchor = { idx: number; px: number; py: number };

export function Viewer() {
  const doc = useEditorStore((s) => s.doc)!;
  const zoom = useEditorStore((s) => s.zoom);
  const tool = useEditorStore((s) => s.tool);
  const fingerDraws = useEditorStore((s) => s.fingerDraws);
  const jumpToPage = useEditorStore((s) => s.jumpToPage);
  const fitRequest = useEditorStore((s) => s.fitRequest);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setCurrentPageIndex = useEditorStore((s) => s.setCurrentPageIndex);
  const saveViewState = useEditorStore((s) => s.saveViewState);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [renderZoom, setRenderZoom] = useState(zoom);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [panning, setPanning] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const pages = doc.pages;
  const layout = useMemo(() => layoutPages(pages, zoom, size.w), [pages, zoom, size.w]);
  const layoutRef = useRef<Layout>(layout); layoutRef.current = layout;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const prevZoom = useRef(zoom);
  const restored = useRef(false);

  // Load the pdf.js document (rendering runs in the worker).
  useEffect(() => {
    let alive = true;
    setPdf(null);
    if (!doc.pdfBlobId) return;
    loadPdf(doc.pdfBlobId).then((p) => { if (alive) setPdf(p); }).catch((e) => { if (alive) setPdfError((e as Error).message); });
    return () => { alive = false; };
  }, [doc.pdfBlobId]);

  // Track scroller size.
  useLayoutEffect(() => {
    const el = scrollerRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Scroll tracking (rAF-throttled).
  useEffect(() => {
    const el = scrollerRef.current!;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setScroll({ top: el.scrollTop, left: el.scrollLeft }); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  /** Change zoom keeping a page point under a client position. */
  const zoomTo = useCallback((newZoom: number, clientX: number, clientY: number, anchor?: Anchor) => {
    const el = scrollerRef.current!;
    const r = el.getBoundingClientRect();
    const z0 = zoomRef.current, l0 = layoutRef.current;
    if (l0.pages.length === 0) return;
    let a = anchor;
    if (!a) {
      const cx = el.scrollLeft + clientX - r.left, cy = el.scrollTop + clientY - r.top;
      const idx = pageIndexAtContentY(l0, cy);
      const p0 = l0.pages[idx];
      a = { idx, px: (cx - p0.x) / z0, py: (cy - p0.y) / z0 };
    }
    const z1 = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);
    const l1 = z1 === z0 ? l0 : layoutPages(pages, z1, r.width);
    const p1 = l1.pages[Math.min(a.idx, l1.pages.length - 1)];
    const target = { left: p1.x + a.px * z1 - (clientX - r.left), top: p1.y + a.py * z1 - (clientY - r.top) };
    if (z1 === z0) { el.scrollLeft = target.left; el.scrollTop = target.top; return; }
    pendingScroll.current = target;
    prevZoom.current = z1;
    setZoom(z1);
  }, [pages, setZoom]);

  // Apply pending scroll after a zoom-driven relayout; keep centre if zoom changed externally.
  useLayoutEffect(() => {
    const el = scrollerRef.current!;
    if (pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left; el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    } else if (prevZoom.current !== zoom && restored.current) {
      // external zoom change (toolbar / keyboard): anchor at viewport centre
      const z0 = prevZoom.current;
      const l0 = layoutPages(pages, z0, size.w);
      const cy = el.scrollTop + size.h / 2, cx = el.scrollLeft + size.w / 2;
      const idx = pageIndexAtContentY(l0, cy);
      const p0 = l0.pages[idx];
      if (p0) {
        const px = (cx - p0.x) / z0, py = (cy - p0.y) / z0;
        const p1 = layout.pages[idx];
        el.scrollLeft = p1.x + px * zoom - size.w / 2;
        el.scrollTop = p1.y + py * zoom - size.h / 2;
      }
    }
    prevZoom.current = zoom;
  }, [zoom, layout, pages, size.w, size.h]);

  // Restore view state (or fit width) once we know the viewport size.
  const fitWidthZoom = useCallback((mode: 'width' | 'page') => {
    const el = scrollerRef.current!;
    const w = el.clientWidth, h = el.clientHeight;
    const idx = clamp(pageIndexAtContentY(layoutRef.current, el.scrollTop + h / 2), 0, pages.length - 1);
    const p = pages[idx] ?? pages[0];
    if (!p) return 1;
    let z = (w - PAGE_GAP * 2 - 8) / p.width;
    if (mode === 'page') z = Math.min(z, (h - PAGE_GAP * 2) / p.height);
    return clamp(z, ZOOM_MIN, ZOOM_MAX);
  }, [pages]);

  useLayoutEffect(() => {
    if (restored.current || size.w === 0 || pages.length === 0) return;
    restored.current = true;
    const el = scrollerRef.current!;
    const vs = doc.viewState;
    if (vs && vs.pageIndex < pages.length) {
      const z = clamp(vs.zoom, ZOOM_MIN, ZOOM_MAX);
      const l = layoutPages(pages, z, size.w);
      const p = l.pages[vs.pageIndex];
      pendingScroll.current = { left: Math.max(0, (l.contentWidth - size.w) / 2), top: p.y + vs.offsetY * z };
      prevZoom.current = z;
      if (z !== zoomRef.current) setZoom(z);
      else { el.scrollLeft = pendingScroll.current.left; el.scrollTop = pendingScroll.current.top; pendingScroll.current = null; }
    } else {
      const z = fitWidthZoom('width');
      prevZoom.current = z;
      const l = layoutPages(pages, z, size.w);
      pendingScroll.current = { left: Math.max(0, (l.contentWidth - size.w) / 2), top: 0 };
      setZoom(z);
      setRenderZoom(z);
    }
  }, [size.w, pages, doc.viewState, setZoom, fitWidthZoom]);

  // Settle: re-render bitmaps at full resolution after zoom stops changing.
  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), 220);
    return () => clearTimeout(t);
  }, [zoom]);

  // Fit requests from the toolbar.
  useEffect(() => {
    if (!fitRequest) return;
    const el = scrollerRef.current!;
    const z = fitWidthZoom(fitRequest.mode);
    const idx = clamp(pageIndexAtContentY(layoutRef.current, el.scrollTop + size.h / 2), 0, pages.length - 1);
    zoomTo(z, el.getBoundingClientRect().left + size.w / 2, el.getBoundingClientRect().top + size.h / 2);
    const l1 = layoutPages(pages, z, size.w);
    const left = Math.max(0, (l1.contentWidth - size.w) / 2);
    if (fitRequest.mode === 'page') {
      // align the current page's top with the viewport
      pendingScroll.current = { left, top: Math.max(0, l1.pages[idx].y - PAGE_GAP / 2) };
    } else if (pendingScroll.current) pendingScroll.current.left = left;
    else el.scrollLeft = left;
  }, [fitRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to page.
  useEffect(() => {
    if (!jumpToPage) return;
    const el = scrollerRef.current!;
    const p = layoutRef.current.pages[jumpToPage.index];
    if (!p) return;
    const t = jumpToPage.target, z = zoomRef.current;
    if (!t) { el.scrollTo({ top: Math.max(0, p.y - PAGE_GAP / 2), behavior: 'auto' }); return; }
    // Bring the box in horizontally only if it isn't already fully visible.
    const x0 = p.x + t.x * z, x1 = p.x + (t.x + t.width) * z;
    let left = el.scrollLeft;
    if (x1 > left + el.clientWidth) left = x1 - el.clientWidth + 16;
    if (x0 < left) left = x0 - 16;
    el.scrollTo({ top: Math.max(0, p.y + t.y * z - 80), left: Math.max(0, left), behavior: 'auto' });
  }, [jumpToPage]);

  // Current page + persisted view state (debounced).
  useEffect(() => {
    if (layout.pages.length === 0 || size.h === 0) return;
    const centre = pageIndexAtContentY(layout, scroll.top + size.h / 2);
    setCurrentPageIndex(clamp(centre, 0, pages.length - 1));
    const t = setTimeout(() => {
      const idx = clamp(pageIndexAtContentY(layout, scroll.top + 1), 0, pages.length - 1);
      const p = layout.pages[idx];
      saveViewState({ pageIndex: idx, offsetY: (scroll.top - p.y) / zoom, zoom });
    }, 400);
    return () => clearTimeout(t);
  }, [scroll.top, zoom, layout, size.h, pages.length, setCurrentPageIndex, saveViewState]);

  // Wheel zoom (Ctrl/⌘ + wheel, trackpad pinch in Chrome/Firefox) and Safari gesture events.
  useEffect(() => {
    const el = scrollerRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      zoomTo(zoomRef.current * factor, e.clientX, e.clientY);
    };
    let gestureStartZoom = 1; let gestureAnchor: Anchor | undefined;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStartZoom = zoomRef.current;
      const ge = e as unknown as { clientX: number; clientY: number };
      const r = el.getBoundingClientRect();
      const l0 = layoutRef.current;
      const cx = el.scrollLeft + ge.clientX - r.left, cy = el.scrollTop + ge.clientY - r.top;
      const idx = pageIndexAtContentY(l0, cy); const p0 = l0.pages[idx];
      gestureAnchor = p0 ? { idx, px: (cx - p0.x) / gestureStartZoom, py: (cy - p0.y) / gestureStartZoom } : undefined;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (touchPinch.current) return; // touch pinch handled via touch events
      const ge = e as unknown as { scale: number; clientX: number; clientY: number };
      zoomTo(gestureStartZoom * ge.scale, ge.clientX, ge.clientY, gestureAnchor);
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false });
    el.addEventListener('gesturechange', onGestureChange, { passive: false });
    el.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [zoomTo]);

  // Touch handling: fingers scroll natively (one finger) and pinch-zoom (two fingers, handled here);
  // the Pencil never scrolls; touches are ignored while a pen stroke is active (palm rejection).
  const touchPinch = useRef<{ startDist: number; startZoom: number; anchor: Anchor } | null>(null);
  useEffect(() => {
    const el = scrollerRef.current!;
    const isStylus = (t: Touch) => (t as Touch & { touchType?: string }).touchType === 'stylus';
    const penActive = () => inputState.activePenPointer !== null;
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const onStart = (e: TouchEvent) => {
      const stylus = Array.from(e.changedTouches).some(isStylus);
      if (stylus || penActive()) { e.preventDefault(); return; }
      const fingers = Array.from(e.touches).filter((t) => !isStylus(t));
      if (fingers.length >= 2) {
        e.preventDefault();
        const [a, b] = fingers;
        const m = mid(a, b);
        const r = el.getBoundingClientRect();
        const l0 = layoutRef.current; const z0 = zoomRef.current;
        const cx = el.scrollLeft + m.x - r.left, cy = el.scrollTop + m.y - r.top;
        const idx = pageIndexAtContentY(l0, cy); const p0 = l0.pages[idx];
        if (!p0) return;
        touchPinch.current = { startDist: dist(a, b), startZoom: z0, anchor: { idx, px: (cx - p0.x) / z0, py: (cy - p0.y) / z0 } };
        return;
      }
      if (fingers.length === 1 && useEditorStore.getState().fingerDraws && (e.target as HTMLElement).closest('.page')) {
        const t = useEditorStore.getState().tool;
        if (t !== 'hand') e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      const fingers = Array.from(e.touches).filter((t) => !isStylus(t));
      if (touchPinch.current && fingers.length >= 2) {
        e.preventDefault();
        const [a, b] = fingers;
        const m = mid(a, b);
        const p = touchPinch.current;
        zoomTo(p.startZoom * (dist(a, b) / p.startDist), m.x, m.y, p.anchor);
        return;
      }
      if (penActive() || Array.from(e.changedTouches).some(isStylus)) e.preventDefault();
    };
    const onEnd = (e: TouchEvent) => {
      const fingers = Array.from(e.touches).filter((t) => !isStylus(t));
      if (fingers.length < 2) touchPinch.current = null;
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo]);

  // Block the browser's double-tap zoom on the scroller.
  useEffect(() => {
    const el = scrollerRef.current!;
    const onDblClick = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('dblclick', onDblClick);
    return () => el.removeEventListener('dblclick', onDblClick);
  }, []);

  const [first, last] = visiblePageRange(layout, scroll.top, scroll.top + size.h, size.h * 0.6);
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;

  return (
    <div
      ref={scrollerRef}
      className={'viewer' + (tool === 'hand' ? ' hand' : '') + (panning ? ' panning' : '')}
      data-testid="viewer"
      data-finger-draws={fingerDraws ? '1' : '0'}
    >
      <div className="viewer-content" style={{ width: layout.contentWidth, height: layout.contentHeight }}>
        {pdfError && <div className="pending" style={{ color: 'var(--danger)' }}>Could not load PDF: {pdfError}</div>}
        {layout.pages.slice(first, last + 1).map((pl) => (
          <PageView
            key={pages[pl.index].id}
            page={pages[pl.index]}
            index={pl.index}
            total={pages.length}
            layout={pl}
            zoom={zoom}
            renderZoom={renderZoom}
            dpr={dpr}
            pdf={pages[pl.index].kind === 'pdf' ? pdf : null}
            onPanning={setPanning}
          />
        ))}
      </div>
    </div>
  );
}
