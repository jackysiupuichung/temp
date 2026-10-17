import type { Rect, Stroke, StrokePoint, TextBox } from '../model/types';

export function strokeBounds(s: Stroke): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  const pad = s.baseWidth / 2;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

export function textBoxBounds(t: TextBox): Rect {
  return { x: t.x, y: t.y, width: t.width, height: t.height };
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A stroke is "in" the lasso if more than half of its points fall inside. */
export function strokeInLasso(s: Stroke, lasso: { x: number; y: number }[]): boolean {
  if (lasso.length < 3 || s.points.length === 0) return false;
  let inside = 0;
  for (const p of s.points) if (pointInPolygon(p.x, p.y, lasso)) inside++;
  return inside * 2 > s.points.length;
}

export function textBoxInLasso(t: TextBox, lasso: { x: number; y: number }[]): boolean {
  if (lasso.length < 3) return false;
  const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
  return pointInPolygon(cx, cy, lasso);
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

/** True if a circle (centre, radius) touches the stroke's path (including its width). */
export function strokeHitByCircle(s: Stroke, cx: number, cy: number, radius: number): boolean {
  const r = radius + s.baseWidth / 2;
  const r2 = r * r;
  const pts = s.points;
  if (pts.length === 1) {
    const dx = pts[0].x - cx, dy = pts[0].y - cy; return dx * dx + dy * dy <= r2;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(cx, cy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) return true;
  }
  return false;
}

/**
 * Partial eraser: remove the parts of a stroke within `radius` of (cx, cy) and
 * return the remaining pieces (each with >= 2 points). Returns null if untouched.
 */
export function splitStrokeByCircle(s: Stroke, cx: number, cy: number, radius: number): StrokePoint[][] | null {
  const r = radius + s.baseWidth / 2;
  const r2 = r * r;
  const pts = s.points;
  const keep: boolean[] = pts.map((p) => {
    const dx = p.x - cx, dy = p.y - cy; return dx * dx + dy * dy > r2;
  });
  // Also mark points whose adjacent segment passes through the circle as a cut.
  let touched = false;
  for (let i = 0; i < pts.length; i++) if (!keep[i]) { touched = true; break; }
  if (!touched) {
    // the path may still pass through the circle between two far-apart samples
    for (let i = 1; i < pts.length; i++) {
      if (distToSegmentSq(cx, cy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) {
        keep[i - 1] = false; touched = true;
      }
    }
    if (!touched) return null;
  }
  const pieces: StrokePoint[][] = [];
  let cur: StrokePoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) cur.push(pts[i]);
    else { if (cur.length >= 2) pieces.push(cur); cur = []; }
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}

export function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  return { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
}

/** Scale stroke about an origin by (sx, sy); width scales by the geometric mean. */
export function scaleStroke(s: Stroke, ox: number, oy: number, sx: number, sy: number): Stroke {
  const ws = Math.sqrt(Math.abs(sx * sy));
  return {
    ...s,
    baseWidth: s.baseWidth * ws,
    points: s.points.map((p) => ({ ...p, x: ox + (p.x - ox) * sx, y: oy + (p.y - oy) * sy })),
  };
}

export function translateTextBox(t: TextBox, dx: number, dy: number): TextBox {
  return { ...t, x: t.x + dx, y: t.y + dy };
}

export function scaleTextBox(t: TextBox, ox: number, oy: number, sx: number, sy: number): TextBox {
  const ws = Math.sqrt(Math.abs(sx * sy));
  return {
    ...t,
    x: ox + (t.x - ox) * sx, y: oy + (t.y - oy) * sy,
    width: t.width * sx, height: t.height * sy, fontSize: t.fontSize * ws,
  };
}
