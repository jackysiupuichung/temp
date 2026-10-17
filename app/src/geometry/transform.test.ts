import { describe, it, expect } from 'vitest';
import {
  layoutPages, screenToPage, pageToScreen, displayToUserSpace, userSpaceToDisplay, rotatedSize,
  zoomAroundPoint, visiblePageRange, svgPlacementForRotation,
} from './transform';
import type { PageRecord } from '../model/types';

const pages: PageRecord[] = [
  { id: 'a', kind: 'pdf', pdfPageNumber: 1, width: 612, height: 792 },
  { id: 'b', kind: 'pdf', pdfPageNumber: 2, width: 400, height: 300 },
  { id: 'c', kind: 'blank', width: 612, height: 792 },
];

describe('layoutPages', () => {
  it('stacks pages vertically and centres mixed sizes', () => {
    const l = layoutPages(pages, 1, 1000);
    expect(l.pages[0].y).toBeLessThan(l.pages[1].y);
    expect(l.pages[1].y).toBeGreaterThanOrEqual(l.pages[0].y + l.pages[0].height);
    // centred
    expect(l.pages[0].x + l.pages[0].width / 2).toBeCloseTo(500);
    expect(l.pages[1].x + l.pages[1].width / 2).toBeCloseTo(500);
    expect(l.contentHeight).toBeGreaterThan(l.pages[2].y + l.pages[2].height);
  });
  it('scales with zoom', () => {
    const l1 = layoutPages(pages, 1, 100);
    const l2 = layoutPages(pages, 2, 100);
    expect(l2.pages[0].width).toBeCloseTo(l1.pages[0].width * 2);
    expect(l2.pages[2].y).toBeGreaterThan(l1.pages[2].y * 1.9);
  });
});

describe('screen <-> page', () => {
  const rect = { left: 10, top: 50 };
  it('round-trips with zoom and scroll', () => {
    const l = layoutPages(pages, 1.5, 900);
    const page = l.pages[1];
    const pt = { x: 123.4, y: 56.7 };
    const s = pageToScreen(pt.x, pt.y, rect, 30, 1200, page, 1.5);
    const back = screenToPage(s.x, s.y, rect, 30, 1200, page, 1.5);
    expect(back.x).toBeCloseTo(pt.x, 6);
    expect(back.y).toBeCloseTo(pt.y, 6);
  });
  it('maps page origin correctly', () => {
    const l = layoutPages(pages, 2, 900);
    const page = l.pages[0];
    const s = pageToScreen(0, 0, rect, 0, 0, page, 2);
    expect(s.x).toBeCloseTo(page.x + rect.left);
    expect(s.y).toBeCloseTo(page.y + rect.top);
    const p = screenToPage(s.x + 20, s.y + 40, rect, 0, 0, page, 2);
    expect(p).toEqual({ x: 10, y: 20 });
  });
});

describe('rotation', () => {
  const W = 612, H = 792;
  it('rotatedSize swaps for 90/270', () => {
    expect(rotatedSize(W, H, 90)).toEqual({ width: H, height: W });
    expect(rotatedSize(W, H, 180)).toEqual({ width: W, height: H });
    expect(rotatedSize(W, H, 270)).toEqual({ width: H, height: W });
    expect(rotatedSize(W, H, -90)).toEqual({ width: H, height: W });
  });
  it('maps corners for each rotation', () => {
    // rotation 0: display top-left is user (0,H)
    expect(displayToUserSpace(0, 0, W, H, 0)).toEqual({ x: 0, y: H });
    expect(displayToUserSpace(W, H, W, H, 0)).toEqual({ x: W, y: 0 });
    // rotation 90 (clockwise): display top-left is user bottom-left (0,0); display top-right is user top-left
    expect(displayToUserSpace(0, 0, W, H, 90)).toEqual({ x: 0, y: 0 });
    expect(displayToUserSpace(H, 0, W, H, 90)).toEqual({ x: 0, y: H });
    expect(displayToUserSpace(0, W, W, H, 90)).toEqual({ x: W, y: 0 });
    // rotation 180: display top-left is user top-right (W,H)... in user coords that's (W, H)? top-right bottom-origin: (W,H)
    expect(displayToUserSpace(0, 0, W, H, 180)).toEqual({ x: W, y: 0 });
    expect(displayToUserSpace(W, H, W, H, 180)).toEqual({ x: 0, y: H });
    // rotation 270: display top-left is user top-right (W,H)
    expect(displayToUserSpace(0, 0, W, H, 270)).toEqual({ x: W, y: H });
    expect(displayToUserSpace(H, W, W, H, 270)).toEqual({ x: 0, y: 0 });
  });
  it('round-trips through userSpaceToDisplay', () => {
    for (const r of [0, 90, 180, 270]) {
      const u = displayToUserSpace(100, 250, W, H, r);
      const d = userSpaceToDisplay(u.x, u.y, W, H, r);
      expect(d.x).toBeCloseTo(100); expect(d.y).toBeCloseTo(250);
    }
  });
  it('svg placement composes to the same mapping as displayToUserSpace', () => {
    // pdf-lib applies translate(x,y) · rotate(θ) · scale(1,-1) to SVG (display) coords.
    for (const r of [0, 90, 180, 270]) {
      const pl = svgPlacementForRotation(W, H, r);
      const th = (pl.rotate * Math.PI) / 180;
      const apply = (dx: number, dy: number) => {
        const sx = dx, sy = -dy; // scale(1,-1)
        const rx = Math.cos(th) * sx - Math.sin(th) * sy;
        const ry = Math.sin(th) * sx + Math.cos(th) * sy;
        return { x: rx + pl.x, y: ry + pl.y };
      };
      for (const [dx, dy] of [[0, 0], [100, 50], [W, H], [37, 400]]) {
        const a = apply(dx, dy);
        const b = displayToUserSpace(dx, dy, W, H, r);
        expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6);
      }
    }
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the focal content point fixed', () => {
    const oldZoom = 1, newZoom = 2;
    const l1 = layoutPages(pages, oldZoom, 800);
    const l2 = layoutPages(pages, newZoom, 800);
    const scrollTop = 500, scrollLeft = 0;
    const focalX = 300, focalY = 200;
    // content point under focal before
    const cyBefore = scrollTop + focalY; // in old content px
    const pageIdx = 0;
    const pagePt = (cyBefore - l1.pages[pageIdx].y) / oldZoom;
    const r = zoomAroundPoint(scrollLeft, scrollTop, focalX, focalY, oldZoom, newZoom, l1, l2);
    const cyAfter = r.scrollTop + focalY;
    const pagePtAfter = (cyAfter - l2.pages[pageIdx].y) / newZoom;
    // gap scales too, so allow small tolerance from gap difference
    expect(pagePtAfter).toBeCloseTo(pagePt, -1);
  });
});

describe('visiblePageRange', () => {
  it('returns only pages intersecting the viewport', () => {
    const l = layoutPages(pages, 1, 800);
    const [a, b] = visiblePageRange(l, 0, 100);
    expect(a).toBe(0); expect(b).toBe(0);
    const [c, d] = visiblePageRange(l, l.pages[1].y + 10, l.pages[2].y + 10);
    expect(c).toBe(1); expect(d).toBe(2);
  });
});
