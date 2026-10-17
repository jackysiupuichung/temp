import { describe, it, expect } from 'vitest';
import { visibleRegions, joinTextInRect } from './capture';
import type { DocumentRecord } from '../model/types';

const doc: DocumentRecord = {
  id: 'd', title: 't', createdAt: 0, updatedAt: 0, lastOpenedAt: 0, pdfBlobId: null,
  pages: [{ id: 'a', kind: 'blank', width: 612, height: 792 }, { id: 'b', kind: 'blank', width: 612, height: 792 }, { id: 'c', kind: 'blank', width: 612, height: 792 }],
};

describe('visibleRegions', () => {
  it('returns the on-screen part of each visible page in page points', () => {
    // zoom 1: gap 16; page a at y=16..808, b at 824..1616
    const { regions, midIndex } = visibleRegions(doc, 1, { clientWidth: 800, clientHeight: 600, scrollTop: 500, scrollLeft: 0 });
    expect(regions.map((r) => r.pageId)).toEqual(['a', 'b']);
    expect(regions[0].rect).toEqual({ x: 0, y: 484, width: 612, height: 308 });
    expect(regions[1].rect).toEqual({ x: 0, y: 0, width: 612, height: 1100 - 824 });
    expect(midIndex).toBe(0); // viewport middle at 800 is still on page a
  });
  it('respects zoom and horizontal scroll', () => {
    const { regions } = visibleRegions(doc, 2, { clientWidth: 800, clientHeight: 400, scrollTop: 0, scrollLeft: 300 });
    // page width 1224 px at zoom 2, centred in content width 1224+2*32 = 1288 → x = 32; visible x from 300 to 1100
    expect(regions[0].rect.x).toBeCloseTo((300 - 32) / 2);
    expect(regions[0].rect.width).toBeCloseTo(800 / 2);
    expect(regions[0].rect.y).toBe(0);
  });
});

describe('joinTextInRect', () => {
  it('keeps items inside the rect, in reading order, with line breaks', () => {
    const items = [
      { str: 'world', x: 60, y: 100, width: 30, height: 10 }, { str: 'hello', x: 20, y: 100, width: 30, height: 10 },
      { str: 'second', x: 20, y: 120, width: 40, height: 10 }, { str: 'outside', x: 20, y: 500, width: 40, height: 10 },
    ];
    expect(joinTextInRect(items, { x: 0, y: 90, width: 200, height: 60 })).toBe('hello world\nsecond');
  });
});
