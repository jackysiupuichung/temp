import { describe, it, expect } from 'vitest';
import {
  mapBoxToPage, snapToInk, chooseAnchor, mergeTextLines, clusterRects, contentBox,
  candidateRects, placeCard, placeAnswerCard, placeWithoutHandwriting, growthLimit, connectorEndpoints, rectsOverlap,
  CARD_WIDTH, CARD_EST_HEIGHT, CARD_MAX_HEIGHT, type PlacementPage,
} from './placement';
import type { CaptureMap } from './protocol';
import type { Rect, ScreenDescription } from '../model/types';

const W = 612, H = 792;
/** A typical page: 12 pt text lines in a 60..550 column, from y=80 to 700. */
function textLines(from = 80, to = 700, x = 60, width = 490): Rect[] {
  const out: Rect[] = [];
  for (let y = from; y < to; y += 14) {
    // three "words" per line so merging has something to do
    out.push({ x, y, width: width * 0.3, height: 10 }, { x: x + width * 0.33, y, width: width * 0.3, height: 10 }, { x: x + width * 0.66, y, width: width * 0.34, height: 10 });
  }
  return out;
}
function page(over: Partial<PlacementPage> = {}): PlacementPage {
  return { pageId: 'p1', pageNumber: 1, width: W, height: H, visible: { x: 0, y: 0, width: W, height: 500 }, textItems: textLines(), strokes: [], textBoxes: [], ...over };
}
/** One full page captured 1:1 into a 612×792 image. */
const capture1: CaptureMap[] = [{ pageId: 'p1', pageNumber: 1, pageRect: { x: 0, y: 0, width: W, height: H }, imageRect: { x: 0, y: 0, width: W, height: H } }];
const img1 = { width: W, height: H };
function desc(hw: ScreenDescription['handwriting']): ScreenDescription {
  return { location: { pages: [1], section: null, summary: '' }, printedItems: [], handwriting: hw, unreadable: null };
}
const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

describe('mapBoxToPage', () => {
  it('maps normalised image coordinates to page points for a 1:1 capture', () => {
    const m = mapBoxToPage(box(100, 250, 200, 300), capture1, img1)!;
    expect(m.pageId).toBe('p1');
    expect(m.rect.x).toBeCloseTo(61.2); expect(m.rect.y).toBeCloseTo(198);
    expect(m.rect.width).toBeCloseTo(61.2); expect(m.rect.height).toBeCloseTo(39.6);
  });
  it('handles a two-page composite and a scaled region', () => {
    const cap: CaptureMap[] = [
      { pageId: 'a', pageNumber: 3, pageRect: { x: 0, y: 400, width: W, height: 392 }, imageRect: { x: 0, y: 0, width: 1224, height: 784 } },
      { pageId: 'b', pageNumber: 4, pageRect: { x: 0, y: 0, width: W, height: 300 }, imageRect: { x: 0, y: 790, width: 1224, height: 600 } },
    ];
    const img = { width: 1224, height: 1390 };
    const a = mapBoxToPage(box(0, 0, 500, 100), cap, img)!;
    expect(a.pageId).toBe('a');
    expect(a.rect).toEqual({ x: 0, y: 400, width: 306, height: 69.5 });
    const b = mapBoxToPage(box(500, 800, 1000, 900), cap, img)!;
    expect(b.pageId).toBe('b');
    expect(b.rect.y).toBeCloseTo(((0.8 * 1390 - 790) * 300) / 600);
  });
  it('swaps inverted boxes and falls back to the nearest region for a box in the separator', () => {
    const cap: CaptureMap[] = [
      { pageId: 'a', pageNumber: 1, pageRect: { x: 0, y: 0, width: W, height: H }, imageRect: { x: 0, y: 0, width: W, height: 100 } },
      { pageId: 'b', pageNumber: 2, pageRect: { x: 0, y: 0, width: W, height: H }, imageRect: { x: 0, y: 110, width: W, height: 100 } },
    ];
    const m = mapBoxToPage(box(300, 540, 100, 490), cap, { width: W, height: 210 })!; // centre at y=108 px: in the separator, nearer b
    expect(m.pageId).toBe('b');
    expect(m.rect.width).toBeGreaterThan(0);
  });
  it('returns null without a capture', () => { expect(mapBoxToPage(box(0, 0, 1, 1), [], img1)).toBeNull(); });
});

describe('snapToInk', () => {
  it('expands to the bounds of every stroke the padded box touches, whatever its age', () => {
    const rough = { x: 100, y: 100, width: 40, height: 20 };
    // the padded probe is x 88..152, y 88..132: the first two strokes touch it, the third does not
    const strokes = [{ rect: { x: 90, y: 95, width: 80, height: 30 } }, { rect: { x: 70, y: 120, width: 25, height: 10 } }, { rect: { x: 400, y: 400, width: 10, height: 10 } }];
    const r = snapToInk(rough, strokes);
    expect(r).toEqual({ x: 70, y: 95, width: 100, height: 35 });
  });
  it('keeps the mapped box when no stroke is near', () => {
    const rough = { x: 100, y: 100, width: 40, height: 20 };
    expect(snapToInk(rough, [{ rect: { x: 300, y: 300, width: 10, height: 10 } }])).toEqual(rough);
  });
});

describe('chooseAnchor', () => {
  it('picks the page with the most handwriting area and unions its rects', () => {
    const hw = [
      { pageId: 'p1', rect: { x: 10, y: 10, width: 10, height: 10 }, index: 0 },
      { pageId: 'p2', rect: { x: 10, y: 10, width: 50, height: 50 }, index: 1 },
      { pageId: 'p2', rect: { x: 100, y: 100, width: 10, height: 10 }, index: 2 },
    ];
    const pages = [page(), page({ pageId: 'p2' })];
    const a = chooseAnchor(hw, pages, 'p1')!;
    expect(a.pageId).toBe('p2');
    expect(a.anchorRect).toEqual({ x: 10, y: 10, width: 100, height: 100 });
    expect(a.tall).toBe(false);
  });
  it('breaks ties towards the page in the middle of the viewport', () => {
    const hw = [{ pageId: 'p1', rect: { x: 0, y: 0, width: 10, height: 10 }, index: 0 }, { pageId: 'p2', rect: { x: 0, y: 0, width: 10, height: 10 }, index: 1 }];
    expect(chooseAnchor(hw, [page(), page({ pageId: 'p2' })], 'p2')!.pageId).toBe('p2');
    expect(chooseAnchor(hw, [page(), page({ pageId: 'p2' })], 'p1')!.pageId).toBe('p1');
  });
  it('anchors a very tall union to the right margin, level with its middle', () => {
    const hw = [{ pageId: 'p1', rect: { x: 60, y: 100, width: 100, height: 20 }, index: 0 }, { pageId: 'p1', rect: { x: 60, y: 460, width: 100, height: 20 }, index: 1 }];
    const a = chooseAnchor(hw, [page()], 'p1')!;
    expect(a.tall).toBe(true);
    expect(a.anchorRect.x).toBeCloseTo(550); // content box right edge
    expect(a.anchorRect.y + a.anchorRect.height / 2).toBeCloseTo(290);
  });
  it('returns null with no handwriting', () => { expect(chooseAnchor([], [page()], 'p1')).toBeNull(); });
});

describe('obstacles', () => {
  it('merges text items on one baseline into a line rect', () => {
    const lines = mergeTextLines(textLines(80, 108));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ x: 60, y: 80, width: 490, height: 10 });
  });
  it('clusters nearby ink and keeps distant ink apart', () => {
    const c = clusterRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: 15, y: 2, width: 10, height: 10 }, { x: 200, y: 200, width: 5, height: 5 }]);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ x: 0, y: 0, width: 25, height: 12 });
  });
  it('content box is the extent of the text, clipped to the page', () => {
    expect(contentBox(textLines(), { width: W, height: H })).toEqual({ x: 60, y: 80, width: 490, height: 10 + 14 * 44 });
    expect(contentBox([], { width: W, height: H })).toBeNull();
  });
});

describe('candidates and scoring', () => {
  it('tries right, below, left, above, margin in that order and clamps to the page', () => {
    const anchor = { x: 300, y: 200, width: 40, height: 20 };
    const c = candidateRects(anchor, page(), { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    expect(c.map((x) => x.name)).toEqual(['right', 'below', 'left', 'above', 'margin']);
    expect(c[0].rect).toEqual({ x: 348, y: 200, width: 240, height: 160 });
    expect(c[1].rect).toEqual({ x: 300, y: 228, width: 240, height: 160 });
    expect(c[2].rect).toEqual({ x: 52, y: 200, width: 240, height: 160 });
    expect(c[3].rect).toEqual({ x: 300, y: 32, width: 240, height: 160 });
    for (const x of c) { expect(x.rect.x).toBeGreaterThanOrEqual(0); expect(x.rect.x + x.rect.width).toBeLessThanOrEqual(W); expect(x.rect.y).toBeGreaterThanOrEqual(0); }
  });
  it('an anchor at the right page edge prefers the left side', () => {
    const anchor = { x: 560, y: 200, width: 40, height: 20 };
    const c = candidateRects(anchor, page(), { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    expect(c[0].name).toBe('left');
  });
  it('never covers handwriting and prefers whitespace over text', () => {
    // Handwriting in the right margin next to text; the empty space below the text column should win.
    const hw = { x: 560, y: 300, width: 40, height: 30 };
    const p = page({ textItems: textLines(80, 400), strokes: [{ rect: hw, tool: 'pen' }], visible: { x: 0, y: 0, width: W, height: H } });
    const r = placeCard(hw, p, [hw], { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    expect(rectsOverlap(r.rect, hw)).toBe(false);
    expect(r.floating).toBe(false);
    // the whitespace below the text column (y > 400) is reachable by nudging, so no text line is covered
    const textOverlap = mergeTextLines(p.textItems).some((t) => rectsOverlap(t, r.rect));
    expect(textOverlap).toBe(false);
  });
  it('on a dense page every candidate overlaps text: still returns one, marked floating', () => {
    const hw = { x: 200, y: 300, width: 60, height: 30 };
    const dense = page({ textItems: textLines(10, 790, 10, 592), strokes: [{ rect: hw, tool: 'pen' }] });
    const r = placeCard(hw, dense, [hw], { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    expect(r.floating).toBe(true);
    expect(rectsOverlap(r.rect, hw)).toBe(false);
  });
  it('prefers a candidate inside the viewport', () => {
    const hw = { x: 300, y: 480, width: 40, height: 10 };
    const p = page({ textItems: [], strokes: [{ rect: hw, tool: 'pen' }], visible: { x: 0, y: 200, width: W, height: 300 } });
    const r = placeCard(hw, p, [hw], { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    // "below" would start at y=498 and be fully outside the visible rect (ends at 500); expect right/left/above instead
    expect(r.candidate).not.toBe('below');
    expect(r.rect.y).toBeLessThan(490);
  });
  it('avoids existing text boxes and answer cards', () => {
    const hw = { x: 100, y: 100, width: 40, height: 20 };
    const existing = { x: 148, y: 100, width: 240, height: 160 }; // exactly where "right" would go
    const p = page({ textItems: [], strokes: [{ rect: hw, tool: 'pen' }], textBoxes: [existing] });
    const r = placeCard(hw, p, [hw], { width: CARD_WIDTH, height: CARD_EST_HEIGHT });
    expect(rectsOverlap(r.rect, existing)).toBe(false);
  });
});

describe('growth', () => {
  it('lets the card grow to the max when nothing is below it', () => {
    const p = page({ textItems: [] });
    const rect = { x: 300, y: 100, width: 240, height: 160 };
    expect(growthLimit(rect, p, [], { text: [], ink: [], boxes: [], content: null })).toBe(CARD_MAX_HEIGHT);
  });
  it('stops before an obstacle below and before the page edge', () => {
    const p = page({ textItems: [] });
    const rect = { x: 300, y: 100, width: 240, height: 160 };
    const obs = { text: [{ x: 320, y: 350, width: 100, height: 10 }], ink: [], boxes: [], content: null };
    expect(growthLimit(rect, p, [], obs)).toBe(350 - 4 - 100);
    expect(growthLimit({ ...rect, y: 700 }, p, [], { text: [], ink: [], boxes: [], content: null })).toBe(160); // page bottom at 792 → 92 < est height → est height
  });
  it('ignores obstacles that are beside the card or already overlapped', () => {
    const p = page({ textItems: [] });
    const rect = { x: 300, y: 100, width: 240, height: 160 };
    const obs = { text: [{ x: 10, y: 300, width: 100, height: 10 }, { x: 320, y: 150, width: 10, height: 10 }], ink: [], boxes: [], content: null };
    expect(growthLimit(rect, p, [], obs)).toBe(CARD_MAX_HEIGHT);
  });
});

describe('placeAnswerCard (whole pipeline)', () => {
  it('maps, snaps, anchors and places one card for several handwriting items', () => {
    const strokes = [
      { rect: { x: 560, y: 200, width: 40, height: 20 }, tool: 'pen' as const },
      { rect: { x: 560, y: 260, width: 45, height: 25 }, tool: 'pen' as const },
    ];
    const p = page({ textItems: textLines(80, 400), strokes, visible: { x: 0, y: 0, width: W, height: H } });
    const d = desc([
      { text: 'why?', box: box(905, 250, 985, 280), page: 1, near: 'Eq. (1)' },
      { text: 'faster?', box: box(910, 330, 990, 360), page: 1, near: null },
    ]);
    const r = placeAnswerCard({ pages: [p], capture: capture1, imageSize: img1, description: d, viewportMidPageId: 'p1' })!;
    expect(r.pageId).toBe('p1');
    expect(r.handwriting).toHaveLength(2);
    expect(r.handwriting[0].rect).toEqual(strokes[0].rect); // snapped to the ink
    expect(r.anchorRect).toEqual({ x: 560, y: 200, width: 45, height: 85 });
    for (const h of r.handwriting) expect(rectsOverlap(r.rect, h.rect)).toBe(false);
    expect(r.rect.width).toBe(CARD_WIDTH);
    expect(r.maxHeight).toBeGreaterThanOrEqual(CARD_EST_HEIGHT);
  });
  it('with no handwriting, goes to the right margin of the middle page, centred in its visible part', () => {
    const p = page({ visible: { x: 0, y: 100, width: W, height: 400 } });
    const r = placeAnswerCard({ pages: [p], capture: capture1, imageSize: img1, description: desc([]), viewportMidPageId: 'p1' })!;
    expect(r.candidate).toBe('margin');
    expect(r.rect.x).toBe(W - CARD_WIDTH - 4);
    expect(r.rect.y).toBe(300 - CARD_EST_HEIGHT / 2);
    expect(placeWithoutHandwriting([], 'x', { width: 1, height: 1 })).toBeNull();
  });
  it('handwriting on a page that is not in the page list still places on the viewport page', () => {
    const d = desc([{ text: 'x', box: box(0, 0, 10, 10), page: 9, near: null }]);
    const cap: CaptureMap[] = [{ ...capture1[0], pageId: 'missing' }];
    const r = placeAnswerCard({ pages: [page()], capture: cap, imageSize: img1, description: d, viewportMidPageId: 'p1' })!;
    expect(r.pageId).toBe('p1');
  });
});

describe('connectorEndpoints', () => {
  it('starts at the card corner nearest the anchor', () => {
    const { from, to } = connectorEndpoints({ x: 300, y: 200, width: 240, height: 160 }, { x: 100, y: 100, width: 50, height: 20 });
    expect(from).toEqual({ x: 300, y: 200 });
    expect(to).toEqual({ x: 150, y: 120 });
  });
});
