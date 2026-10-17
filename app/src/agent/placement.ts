/**
 * Automatic placement of the single answer card (agent design §6.3–6.4).
 * Pure: no DOM, no store. Unit-tested in placement.test.ts.
 *
 * All rects are in page points (top-left origin) unless named otherwise.
 */
import type { Rect, ScreenDescription } from '../model/types';
import type { CaptureMap } from './protocol';

export const CARD_WIDTH = 240;
export const CARD_EST_HEIGHT = 160;
export const CARD_MAX_HEIGHT = 320;
export const CARD_GAP = 8;
export const SNAP_PAD = 12;

export type PlacementPage = {
  pageId: string;
  pageNumber: number;
  width: number;
  height: number;
  /** The part of the page inside the viewport, or null when the page is off screen. */
  visible: Rect | null;
  /** pdf.js text item rects. */
  textItems: Rect[];
  /** Bounds of every pen/highlighter stroke on the page. */
  strokes: Array<{ rect: Rect; tool: 'pen' | 'highlighter' }>;
  /** Existing text boxes and answer cards. */
  textBoxes: Rect[];
};

export type PlacementInput = {
  pages: PlacementPage[];
  capture: CaptureMap[];
  imageSize: { width: number; height: number };
  description: ScreenDescription;
  /** The page occupying the middle of the viewport (tie-break and no-handwriting fallback). */
  viewportMidPageId: string;
  cardWidth?: number;
  estimatedHeight?: number;
  maxHeight?: number;
};

export type HandwritingRect = { pageId: string; rect: Rect; index: number };

export type Placement = {
  pageId: string;
  rect: Rect; // where the card goes, using the estimated height
  anchorRect: Rect;
  handwriting: HandwritingRect[];
  maxHeight: number; // growth limit (§6.3 "Growth")
  floating: boolean; // every candidate overlapped text heavily (§6.3 fallbacks)
  candidate: 'right' | 'below' | 'left' | 'above' | 'margin' | 'none';
};

// ---------- small rect helpers ----------

export function rectArea(r: Rect): number { return Math.max(0, r.width) * Math.max(0, r.height); }

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function rectsOverlap(a: Rect, b: Rect): boolean { return intersectArea(a, b) > 0; }

export function unionRects(rs: Rect[]): Rect | null {
  if (rs.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function expandRect(r: Rect, pad: number): Rect { return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }; }

function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

// ---------- step 1: image boxes -> page rects ----------

/** Map a vision box (0–1000 image coordinates) to a page and a page rect via the capture map. */
export function mapBoxToPage(box: { x0: number; y0: number; x1: number; y1: number }, capture: CaptureMap[], imageSize: { width: number; height: number }): { pageId: string; rect: Rect } | null {
  if (capture.length === 0 || imageSize.width <= 0 || imageSize.height <= 0) return null;
  const px = {
    x0: (Math.min(box.x0, box.x1) / 1000) * imageSize.width, x1: (Math.max(box.x0, box.x1) / 1000) * imageSize.width,
    y0: (Math.min(box.y0, box.y1) / 1000) * imageSize.height, y1: (Math.max(box.y0, box.y1) / 1000) * imageSize.height,
  };
  const cx = (px.x0 + px.x1) / 2, cy = (px.y0 + px.y1) / 2;
  // Region containing the centre, else the nearest region vertically.
  let region = capture.find((c) => cx >= c.imageRect.x && cx <= c.imageRect.x + c.imageRect.width && cy >= c.imageRect.y && cy <= c.imageRect.y + c.imageRect.height);
  if (!region) {
    let best = Infinity;
    for (const c of capture) {
      const d = Math.abs(cy - (c.imageRect.y + c.imageRect.height / 2));
      if (d < best) { best = d; region = c; }
    }
  }
  if (!region) return null;
  const sx = region.pageRect.width / region.imageRect.width, sy = region.pageRect.height / region.imageRect.height;
  // Clip to the region in image space, then convert.
  const ix0 = Math.max(px.x0, region.imageRect.x), ix1 = Math.min(px.x1, region.imageRect.x + region.imageRect.width);
  const iy0 = Math.max(px.y0, region.imageRect.y), iy1 = Math.min(px.y1, region.imageRect.y + region.imageRect.height);
  const x = region.pageRect.x + (ix0 - region.imageRect.x) * sx;
  const y = region.pageRect.y + (iy0 - region.imageRect.y) * sy;
  const rect: Rect = { x, y, width: Math.max(1, (ix1 - ix0) * sx), height: Math.max(1, (iy1 - iy0) * sy) };
  return { pageId: region.pageId, rect };
}

/** Snap a rough box to the ink: the union of all strokes intersecting the box expanded by `pad` (§6.3 step 1). */
export function snapToInk(rect: Rect, strokes: Array<{ rect: Rect }>, pad = SNAP_PAD): Rect {
  const probe = expandRect(rect, pad);
  const hits = strokes.filter((s) => rectsOverlap(probe, s.rect)).map((s) => s.rect);
  return unionRects(hits) ?? rect;
}

export function handwritingRects(description: ScreenDescription, capture: CaptureMap[], imageSize: { width: number; height: number }, pages: PlacementPage[]): HandwritingRect[] {
  const out: HandwritingRect[] = [];
  description.handwriting.forEach((h, index) => {
    const m = mapBoxToPage(h.box, capture, imageSize);
    if (!m) return;
    const page = pages.find((p) => p.pageId === m.pageId);
    const rect = page ? snapToInk(m.rect, page.strokes.filter((s) => s.tool === 'pen')) : m.rect;
    out.push({ pageId: m.pageId, rect, index });
  });
  return out;
}

// ---------- step 2: anchor ----------

export function chooseAnchor(hw: HandwritingRect[], pages: PlacementPage[], viewportMidPageId: string): { pageId: string; anchorRect: Rect; tall: boolean } | null {
  if (hw.length === 0) return null;
  const area = new Map<string, number>();
  for (const h of hw) area.set(h.pageId, (area.get(h.pageId) ?? 0) + rectArea(h.rect));
  let focus: string | null = null, best = -1;
  for (const [pid, a] of area) {
    if (a > best * 1.01 || (Math.abs(a - best) <= best * 0.01 && pid === viewportMidPageId)) { best = a; focus = pid; }
  }
  if (!focus) return null;
  const page = pages.find((p) => p.pageId === focus);
  const union = unionRects(hw.filter((h) => h.pageId === focus).map((h) => h.rect))!;
  const visibleH = page?.visible?.height ?? page?.height ?? Infinity;
  if (union.height > 0.5 * visibleH && page) {
    // Very tall: anchor to the right margin, level with the middle of the handwriting.
    const cr = contentBox(page.textItems, page);
    const right = cr ? cr.x + cr.width : page.width;
    const midY = union.y + union.height / 2;
    return { pageId: focus, anchorRect: { x: Math.min(right, page.width - 1), y: midY - 1, width: 1, height: 2 }, tall: true };
  }
  return { pageId: focus, anchorRect: union, tall: false };
}

// ---------- obstacles ----------

/** Merge text items into line rects (items on the same baseline that are close horizontally). */
export function mergeTextLines(items: Rect[]): Rect[] {
  const sorted = [...items].filter((r) => r.width > 0 && r.height > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Rect[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last) {
      const sameLine = Math.abs(last.y - it.y) < Math.max(2, it.height * 0.4) && it.x - (last.x + last.width) < it.height * 2.5 && it.x >= last.x - 2;
      if (sameLine) { lines[lines.length - 1] = unionRects([last, it])!; continue; }
    }
    lines.push({ ...it });
  }
  return lines;
}

/** Cluster rects that are within `gap` of each other (used for ink). */
export function clusterRects(rects: Rect[], gap = 10): Rect[] {
  const clusters: Rect[] = [];
  for (const r of rects) {
    let merged: Rect = { ...r };
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = clusters.length - 1; i >= 0; i--) {
        if (rectsOverlap(expandRect(clusters[i], gap), merged)) { merged = unionRects([merged, clusters[i]])!; clusters.splice(i, 1); changed = true; }
      }
    }
    clusters.push(merged);
  }
  return clusters;
}

/** Extent of the printed content; the space outside it is the margins. */
export function contentBox(items: Rect[], page: { width: number; height: number }): Rect | null {
  const u = unionRects(items.filter((r) => r.width > 0 && r.height > 0));
  if (!u) return null;
  return { x: Math.max(0, u.x), y: Math.max(0, u.y), width: Math.min(page.width, u.x + u.width) - Math.max(0, u.x), height: Math.min(page.height, u.y + u.height) - Math.max(0, u.y) };
}

// ---------- step 3: candidates and scoring ----------

type Obstacles = { text: Rect[]; ink: Rect[]; boxes: Rect[]; content: Rect | null };

function obstaclesFor(page: PlacementPage): Obstacles {
  return {
    text: mergeTextLines(page.textItems),
    ink: clusterRects(page.strokes.map((s) => s.rect)),
    boxes: page.textBoxes,
    content: contentBox(page.textItems, page),
  };
}

function clampToPage(r: Rect, page: { width: number; height: number }): Rect {
  const w = Math.min(r.width, page.width), h = Math.min(r.height, page.height);
  return { x: Math.max(0, Math.min(r.x, page.width - w)), y: Math.max(0, Math.min(r.y, page.height - h)), width: w, height: h };
}

export function candidateRects(anchor: Rect, page: PlacementPage, size: { width: number; height: number }, gap = CARD_GAP): Array<{ name: Placement['candidate']; rect: Rect }> {
  const { width: w, height: h } = size;
  const out: Array<{ name: Placement['candidate']; rect: Rect }> = [
    { name: 'right', rect: { x: anchor.x + anchor.width + gap, y: anchor.y, width: w, height: h } },
    { name: 'below', rect: { x: anchor.x, y: anchor.y + anchor.height + gap, width: w, height: h } },
    { name: 'left', rect: { x: anchor.x - gap - w, y: anchor.y, width: w, height: h } },
    { name: 'above', rect: { x: anchor.x, y: anchor.y - gap - h, width: w, height: h } },
  ];
  // Nearest page margin, level with the anchor.
  const cb = contentBox(page.textItems, page);
  const leftMargin = cb ? cb.x : 0, rightMargin = cb ? page.width - (cb.x + cb.width) : 0;
  const anchorMid = anchor.x + anchor.width / 2;
  const preferRight = rightMargin >= leftMargin ? anchorMid >= page.width / 2 || rightMargin > leftMargin : false;
  const marginX = preferRight ? page.width - w - 4 : 4;
  out.push({ name: 'margin', rect: { x: marginX, y: anchor.y, width: w, height: h } });
  // If the anchor is at a page edge, prefer the side with more room (§6.3 fallbacks).
  const roomRight = page.width - (anchor.x + anchor.width), roomLeft = anchor.x;
  if (roomRight < w + gap && roomLeft >= w + gap) {
    const i = out.findIndex((c) => c.name === 'left'); const [c] = out.splice(i, 1); out.unshift(c);
  }
  return out.map((c) => ({ ...c, rect: clampToPage(c.rect, page) }));
}

export function scoreCandidate(rect: Rect, anchor: Rect, page: PlacementPage, obs: Obstacles): { score: number; textFrac: number } {
  const area = rectArea(rect) || 1;
  const frac = (rs: Rect[]) => rs.reduce((s, r) => s + intersectArea(rect, r), 0) / area;
  const textFrac = Math.min(1, frac(obs.text));
  const inkFrac = Math.min(1, frac(obs.ink));
  const boxFrac = Math.min(1, frac(obs.boxes));
  const contentFrac = obs.content ? intersectArea(rect, obs.content) / area : 0;
  const viewFrac = page.visible ? intersectArea(rect, page.visible) / area : 0;
  const dist = rectDistance(rect, anchor);
  const score = 3 * textFrac + 2 * inkFrac + 3 * boxFrac + 0.3 * contentFrac + 0.002 * dist + 1.0 * (1 - viewFrac);
  return { score, textFrac };
}

/** Largest height (≤ maxHeight) the card can grow to before hitting an obstacle below or the page edge. */
export function growthLimit(rect: Rect, page: PlacementPage, hw: Rect[], obs: Obstacles, maxHeight = CARD_MAX_HEIGHT, gap = 4): number {
  const bottomOfPage = page.height - rect.y;
  let limit = Math.min(maxHeight, bottomOfPage);
  const xOverlap = (r: Rect) => r.x < rect.x + rect.width && r.x + r.width > rect.x;
  const currentBottom = rect.y + rect.height;
  for (const r of [...obs.text, ...obs.ink, ...obs.boxes, ...hw]) {
    if (!xOverlap(r)) continue;
    if (r.y >= currentBottom - 0.5) limit = Math.min(limit, r.y - gap - rect.y);
  }
  return Math.max(rect.height, limit);
}

/** Choose where the single card goes (§6.3 step 3). */
export function placeCard(anchor: Rect, page: PlacementPage, hwOnPage: Rect[], size: { width: number; height: number }, maxHeight = CARD_MAX_HEIGHT): Omit<Placement, 'pageId' | 'handwriting' | 'anchorRect'> {
  const obs = obstaclesFor(page);
  const cands = candidateRects(anchor, page, size);
  type Scored = { name: Placement['candidate']; rect: Rect; score: number; textFrac: number; hitsHandwriting: boolean };
  const scored: Scored[] = cands.map((c) => {
    const hits = hwOnPage.some((h) => rectsOverlap(c.rect, h));
    const s = scoreCandidate(c.rect, anchor, page, obs);
    return { ...c, ...s, hitsHandwriting: hits };
  });
  let pool = scored.filter((c) => !c.hitsHandwriting);
  if (pool.length === 0) pool = scored; // every candidate covers handwriting (tiny page): take the least bad
  let best = pool[0];
  for (const c of pool) if (c.score < best.score - 1e-9) best = c;
  const nudged = nudge(best.rect, best.score, anchor, page, hwOnPage, obs);
  return {
    rect: nudged.rect,
    maxHeight: growthLimit(nudged.rect, page, hwOnPage, obs, maxHeight),
    floating: nudged.textFrac > 0.3,
    candidate: best.name,
  };
}

/**
 * Slide the chosen rect by up to `range` pt in each direction and keep the
 * best-scoring position that still obeys the hard rule. The candidate order
 * decides the side; this only clears obstacles the fixed candidates land on.
 */
function nudge(rect: Rect, score: number, anchor: Rect, page: PlacementPage, hw: Rect[], obs: Obstacles, range = 200, step = 20): { rect: Rect; textFrac: number } {
  let best = { rect, score, textFrac: scoreCandidate(rect, anchor, page, obs).textFrac };
  for (let dy = -range; dy <= range; dy += step) {
    for (let dx = -range; dx <= range; dx += step) {
      if (dx === 0 && dy === 0) continue;
      const r = clampToPage({ ...rect, x: rect.x + dx, y: rect.y + dy }, page);
      if (hw.some((h) => rectsOverlap(r, h))) continue;
      const s = scoreCandidate(r, anchor, page, obs);
      if (s.score < best.score - 1e-6) best = { rect: r, score: s.score, textFrac: s.textFrac };
    }
  }
  return best;
}

/** §6.4: no handwriting → right margin of the page in the middle of the viewport, vertically centred in its visible part. */
export function placeWithoutHandwriting(pages: PlacementPage[], viewportMidPageId: string, size: { width: number; height: number }, maxHeight = CARD_MAX_HEIGHT): Placement | null {
  const page = pages.find((p) => p.pageId === viewportMidPageId) ?? pages.find((p) => p.visible) ?? pages[0];
  if (!page) return null;
  const vis = page.visible ?? { x: 0, y: 0, width: page.width, height: page.height };
  const cb = contentBox(page.textItems, page);
  const x = cb ? Math.min(cb.x + cb.width + CARD_GAP, page.width - size.width - 4) : page.width - size.width - 4;
  const y = vis.y + vis.height / 2 - size.height / 2;
  const rect = clampToPage({ x, y, width: size.width, height: size.height }, page);
  const obs = obstaclesFor(page);
  const anchorRect: Rect = { x: rect.x - 1, y: rect.y + rect.height / 2, width: 1, height: 1 };
  return {
    pageId: page.pageId, rect, anchorRect, handwriting: [], candidate: 'margin',
    maxHeight: growthLimit(rect, page, [], obs, maxHeight),
    floating: scoreCandidate(rect, anchorRect, page, obs).textFrac > 0.3,
  };
}

/** Whole pipeline: description + capture map + page info → placement. */
export function placeAnswerCard(input: PlacementInput): Placement | null {
  const size = { width: input.cardWidth ?? CARD_WIDTH, height: input.estimatedHeight ?? CARD_EST_HEIGHT };
  const maxHeight = input.maxHeight ?? CARD_MAX_HEIGHT;
  const hw = handwritingRects(input.description, input.capture, input.imageSize, input.pages);
  const anchor = chooseAnchor(hw, input.pages, input.viewportMidPageId);
  if (!anchor) return placeWithoutHandwriting(input.pages, input.viewportMidPageId, size, maxHeight);
  const page = input.pages.find((p) => p.pageId === anchor.pageId);
  if (!page) return placeWithoutHandwriting(input.pages, input.viewportMidPageId, size, maxHeight);
  const hwOnPage = hw.filter((h) => h.pageId === page.pageId).map((h) => h.rect);
  const placed = placeCard(anchor.anchorRect, page, hwOnPage, size, maxHeight);
  return { pageId: page.pageId, anchorRect: anchor.anchorRect, handwriting: hw, ...placed };
}

/** Where the connector line starts: the card corner nearest the anchor (§6.3 "Connector"). */
export function connectorEndpoints(card: Rect, anchor: Rect): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const corners = [
    { x: card.x, y: card.y }, { x: card.x + card.width, y: card.y },
    { x: card.x, y: card.y + card.height }, { x: card.x + card.width, y: card.y + card.height },
  ];
  const ax = Math.max(anchor.x, Math.min(anchor.x + anchor.width, card.x + card.width / 2));
  const ay = Math.max(anchor.y, Math.min(anchor.y + anchor.height, card.y + card.height / 2));
  let from = corners[0], best = Infinity;
  for (const c of corners) { const d = Math.hypot(c.x - ax, c.y - ay); if (d < best) { best = d; from = c; } }
  return { from, to: { x: ax, y: ay } };
}
