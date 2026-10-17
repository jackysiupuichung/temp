import { getStroke } from 'perfect-freehand';
import type { Stroke, StrokePoint, TextBox } from '../model/types';

export type LiveStroke = { tool: 'pen' | 'highlighter'; color: string; opacity: number; baseWidth: number; points: StrokePoint[] };

const outlineCache = new WeakMap<Stroke, number[][]>();

export function strokeOutline(points: StrokePoint[], tool: 'pen' | 'highlighter', baseWidth: number, hasPressure: boolean, last = true): number[][] {
  const input = points.map((p) => [p.x, p.y, p.p]);
  if (tool === 'highlighter') {
    return getStroke(input, { size: baseWidth, thinning: 0, smoothing: 0.6, streamline: 0.4, simulatePressure: false, last, start: { cap: false }, end: { cap: false } });
  }
  return getStroke(input, {
    size: baseWidth * 1.6,
    thinning: hasPressure ? 0.6 : 0,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !hasPressure,
    last,
  });
}

export function strokeHasPressure(points: StrokePoint[]): boolean {
  for (let i = 0; i < Math.min(points.length, 20); i++) {
    const p = points[i].p;
    if (p !== 0.5 && p > 0 && p < 1) return true;
  }
  return false;
}

export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length === 0) return path;
  if (outline.length < 3) {
    const [x, y] = outline[0];
    path.arc(x, y, 1, 0, Math.PI * 2);
    return path;
  }
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function outlineToSvgPath(outline: number[][]): string {
  if (outline.length < 2) return '';
  let d = `M${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    d += ` Q${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`;
  }
  return d + ' Z';
}

export function getCachedOutline(s: Stroke): number[][] {
  let o = outlineCache.get(s);
  if (!o) {
    o = strokeOutline(s.points, s.tool, s.baseWidth, strokeHasPressure(s.points));
    outlineCache.set(s, o);
  }
  return o;
}

/** Draw a single finished or live stroke. ctx must already be scaled to page points. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: LiveStroke | Stroke, outline?: number[][]) {
  if (s.points.length === 0) return;
  const o = outline ?? ('id' in s ? getCachedOutline(s as Stroke) : strokeOutline(s.points, s.tool, s.baseWidth, strokeHasPressure(s.points), false));
  ctx.fillStyle = s.color;
  ctx.globalAlpha = s.tool === 'highlighter' ? 1 : s.opacity;
  if (s.points.length === 1 || o.length < 3) {
    const p = s.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, (s.baseWidth * (s.tool === 'highlighter' ? 1 : 0.8)) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fill(outlineToPath(o));
}

/**
 * Draw all highlighter strokes of a page as a group so overlaps don't darken:
 * strokes are drawn opaque, the whole layer gets the group alpha.
 */
export function drawHighlights(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, alpha = 0.4) {
  const hs = strokes.filter((s) => s.tool === 'highlighter');
  if (hs.length === 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Group by colour on a temp canvas so same-colour overlaps are flat.
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d')!;
  tctx.scale(scale, scale);
  for (const s of hs) drawStroke(tctx, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  tmp.width = 0; tmp.height = 0;
}

export function drawPenStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  for (const s of strokes) if (s.tool === 'pen') drawStroke(ctx, s);
}

/** Draw text boxes onto a canvas (used for image export only; on screen they are DOM). */
export function drawTextBoxes(ctx: CanvasRenderingContext2D, boxes: TextBox[]) {
  for (const t of boxes) {
    ctx.save();
    ctx.fillStyle = t.color;
    ctx.globalAlpha = 1;
    ctx.font = `${t.fontSize}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    const lines = wrapText(ctx, t.text, t.width - 8);
    const lh = t.fontSize * 1.3;
    lines.forEach((line, i) => ctx.fillText(line, t.x + 4, t.y + 4 + i * lh));
    ctx.restore();
  }
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

/** Full annotation composite for a page, in one call (used by image export). */
export function drawPageAnnotations(ctx: CanvasRenderingContext2D, strokes: Stroke[], boxes: TextBox[], scale: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  drawHighlights(ctx, strokes, scale);
  ctx.restore();
  ctx.save();
  ctx.scale(scale, scale);
  drawPenStrokes(ctx, strokes);
  drawTextBoxes(ctx, boxes);
  ctx.restore();
}
