import type { PageRecord, Rect } from '../model/types';
import { PAGE_GAP } from '../model/types';

/** Position of a page in the scroll content, in CSS px at the given zoom. */
export type PageLayout = { index: number; x: number; y: number; width: number; height: number };

export type Layout = { pages: PageLayout[]; contentWidth: number; contentHeight: number };

/**
 * Lay out pages as a centred vertical stack. `zoom` is CSS px per PDF point.
 * `viewportWidth` is the scroller's client width so narrow pages are centred.
 */
export function layoutPages(pages: PageRecord[], zoom: number, viewportWidth: number): Layout {
  const gap = PAGE_GAP * Math.max(0.5, Math.min(zoom, 2));
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.width * zoom);
  const contentWidth = Math.max(viewportWidth, maxW + gap * 2);
  let y = gap;
  const out: PageLayout[] = [];
  pages.forEach((p, index) => {
    const width = p.width * zoom;
    const height = p.height * zoom;
    const x = (contentWidth - width) / 2;
    out.push({ index, x, y, width, height });
    y += height + gap;
  });
  return { pages: out, contentWidth, contentHeight: y };
}

/** Screen (client) point -> page point (PDF points, top-left origin). */
export function screenToPage(
  clientX: number, clientY: number,
  scrollerRect: { left: number; top: number }, scrollLeft: number, scrollTop: number,
  page: PageLayout, zoom: number,
): { x: number; y: number } {
  const cx = clientX - scrollerRect.left + scrollLeft;
  const cy = clientY - scrollerRect.top + scrollTop;
  return { x: (cx - page.x) / zoom, y: (cy - page.y) / zoom };
}

/** Page point -> screen (client) point. */
export function pageToScreen(
  x: number, y: number,
  scrollerRect: { left: number; top: number }, scrollLeft: number, scrollTop: number,
  page: PageLayout, zoom: number,
): { x: number; y: number } {
  return {
    x: page.x + x * zoom - scrollLeft + scrollerRect.left,
    y: page.y + y * zoom - scrollTop + scrollerRect.top,
  };
}

/** Which page index is at (or nearest to) a content y coordinate. */
export function pageIndexAtContentY(layout: Layout, y: number): number {
  const ps = layout.pages;
  if (ps.length === 0) return 0;
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].y + ps[mid].height < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Range [first, last] of page indices intersecting [top, bottom] in content coords, with overscan px. */
export function visiblePageRange(layout: Layout, top: number, bottom: number, overscan = 0): [number, number] {
  if (layout.pages.length === 0) return [0, -1];
  const first = pageIndexAtContentY(layout, top - overscan);
  let last = first;
  while (last + 1 < layout.pages.length && layout.pages[last + 1].y < bottom + overscan) last++;
  return [first, last];
}

/** New scrollTop/scrollLeft that keep the content point under (focalX, focalY) fixed when zoom changes. */
export function zoomAroundPoint(
  scrollLeft: number, scrollTop: number, focalX: number, focalY: number, oldZoom: number, newZoom: number,
  oldLayout: Layout, newLayout: Layout,
): { scrollLeft: number; scrollTop: number } {
  const ratio = newZoom / oldZoom;
  // Horizontal: content is centred, so work relative to the content centre.
  const oldCx = (scrollLeft + focalX) - oldLayout.contentWidth / 2;
  const newLeft = oldCx * ratio + newLayout.contentWidth / 2 - focalX;
  const newTop = (scrollTop + focalY) * ratio - focalY;
  return { scrollLeft: Math.max(0, newLeft), scrollTop: Math.max(0, newTop) };
}

/**
 * Map a displayed-page point (top-left origin, after rotation) to PDF user space
 * (bottom-left origin, y up, before rotation). `userW/userH` are the unrotated
 * view-box dimensions; `rotation` is the page /Rotate normalised to 0|90|180|270.
 */
export function displayToUserSpace(
  x: number, y: number, userW: number, userH: number, rotation: number,
): { x: number; y: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: y, y: x };
    case 180: return { x: userW - x, y: y };
    case 270: return { x: userW - y, y: userH - x };
    default: return { x: x, y: userH - y };
  }
}

/** Inverse of displayToUserSpace. */
export function userSpaceToDisplay(
  ux: number, uy: number, userW: number, userH: number, rotation: number,
): { x: number; y: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: uy, y: ux };
    case 180: return { x: userW - ux, y: uy };
    case 270: return { x: userH - uy, y: userW - ux };
    default: return { x: ux, y: userH - uy };
  }
}

/** Displayed page size for a given rotation. */
export function rotatedSize(userW: number, userH: number, rotation: number): { width: number; height: number } {
  const r = ((rotation % 360) + 360) % 360;
  return r === 90 || r === 270 ? { width: userH, height: userW } : { width: userW, height: userH };
}

/**
 * pdf-lib `drawSvgPath` origin+rotation such that SVG coords (display space, y
 * down) land on the right user-space location for a rotated page.
 */
export function svgPlacementForRotation(userW: number, userH: number, rotation: number): { x: number; y: number; rotate: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: 0, y: 0, rotate: 90 };
    case 180: return { x: userW, y: 0, rotate: 180 };
    case 270: return { x: userW, y: userH, rotate: 270 };
    default: return { x: 0, y: userH, rotate: 0 };
  }
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.width, b.x + b.width), bt = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: r - x, height: bt - y };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
