import { describe, it, expect } from 'vitest';
import { pointInPolygon, strokeInLasso, strokeHitByCircle, splitStrokeByCircle, strokeBounds, scaleStroke } from './strokes';
import type { Stroke } from '../model/types';

const mk = (pts: [number, number][], w = 2): Stroke => ({
  id: 's', docId: 'd', pageId: 'p', tool: 'pen', color: '#000', opacity: 1, baseWidth: w,
  points: pts.map(([x, y], i) => ({ x, y, p: 0.5, t: i })), createdAt: 0,
});

describe('lasso', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  it('point in polygon', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
  });
  it('selects strokes mostly inside', () => {
    expect(strokeInLasso(mk([[10, 10], [20, 20], [30, 30]]), square)).toBe(true);
    expect(strokeInLasso(mk([[10, 10], [200, 200], [300, 300]]), square)).toBe(false);
  });
});

describe('eraser', () => {
  it('hits a stroke within radius including width', () => {
    const s = mk([[0, 0], [100, 0]], 4);
    expect(strokeHitByCircle(s, 50, 5, 2)).toBe(false); // 5 > radius 2 + half width 2
    expect(strokeHitByCircle(s, 50, 3, 2)).toBe(true);
    expect(strokeHitByCircle(s, 50, 20, 2)).toBe(false);
  });
  it('splits a stroke into pieces', () => {
    const s = mk(Array.from({ length: 11 }, (_, i) => [i * 10, 0] as [number, number]), 0);
    const pieces = splitStrokeByCircle(s, 50, 0, 5);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBe(2);
    expect(pieces![0].length).toBe(5);
    expect(pieces![1].length).toBe(5);
    expect(splitStrokeByCircle(s, 50, 100, 5)).toBeNull();
  });
});

describe('bounds and scaling', () => {
  it('computes padded bounds', () => {
    const b = strokeBounds(mk([[10, 10], [30, 40]], 4));
    expect(b).toEqual({ x: 8, y: 8, width: 24, height: 34 });
  });
  it('scales about an origin', () => {
    const s = scaleStroke(mk([[10, 10], [20, 20]], 2), 10, 10, 2, 2);
    expect(s.points[1]).toMatchObject({ x: 30, y: 30 });
    expect(s.baseWidth).toBe(4);
  });
});
