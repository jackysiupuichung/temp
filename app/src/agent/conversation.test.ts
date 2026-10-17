import { describe, expect, it } from 'vitest';
import type { PageRecord, TextBox } from '../model/types';
import { answerExcerpt, conversationEntries, conversationStats, groupConversations, matchesQuery } from './conversation';

const pages: PageRecord[] = [{ id: 'p1', kind: 'pdf', pdfPageNumber: 1, width: 600, height: 800 }, { id: 'p2', kind: 'pdf', pdfPageNumber: 2, width: 600, height: 800 }];

function card(id: string, pageId: string, o: { y?: number; sessionId?: string; askedAt?: number; status?: 'answering' | 'done' | 'error'; hw?: string[]; text?: string } = {}): TextBox {
  return {
    id, docId: 'd', pageId, x: 0, y: o.y ?? 0, width: 200, height: 50, text: o.text ?? '', fontSize: 10, color: '#000', kind: 'answer', format: 'markdown',
    answer: {
      askId: id, status: o.status ?? 'done', anchorRect: { x: 0, y: 0, width: 0, height: 0 }, collapsed: false, maxHeight: 300,
      sessionId: o.sessionId, askedAt: o.askedAt,
      description: { location: { pages: [1], section: null, summary: '' }, printedItems: [], unreadable: null, handwriting: (o.hw ?? []).map((text) => ({ text, page: 1, near: null, box: { x0: 0, y0: 0, x1: 1, y1: 1 } })) },
    },
  };
}

describe('conversation', () => {
  it('lists answer cards in ask order, undated ones first in page order', () => {
    const plain: TextBox = { ...card('t', 'p1'), kind: 'text', answer: undefined };
    const byPage = { p1: [card('c', 'p1', { askedAt: 30 }), plain, card('u2', 'p1', { y: 50 })], p2: [card('a', 'p2', { askedAt: 10 }), card('u1', 'p2')] };
    byPage.p1.push(card('u0', 'p1', { y: 10 }));
    expect(conversationEntries(pages, byPage).map((e) => e.card.id)).toEqual(['u0', 'u2', 'u1', 'a', 'c']);
  });

  it('groups the current conversation first, then earlier ones newest first, then undated cards', () => {
    const byPage = { p1: [card('a1', 'p1', { sessionId: 'A', askedAt: 1 }), card('b1', 'p1', { sessionId: 'B', askedAt: 5 }), card('old', 'p1'), card('c1', 'p1', { sessionId: 'C', askedAt: 9 })] };
    const groups = groupConversations(conversationEntries(pages, byPage), 'A');
    expect(groups.map((g) => [g.sessionId, g.current])).toEqual([['A', true], ['C', false], ['B', false], [null, false]]);
    expect(groupConversations(conversationEntries(pages, byPage), null).every((g) => !g.current)).toBe(true);
  });

  it('counts the asks in the current conversation', () => {
    const byPage = { p1: [card('a1', 'p1', { sessionId: 'A', askedAt: 1 }), card('a2', 'p1', { sessionId: 'A', askedAt: 2 }), card('a3', 'p1', { sessionId: 'A', askedAt: 3, status: 'answering' }), card('b', 'p1', { sessionId: 'B' })] };
    expect(conversationStats(conversationEntries(pages, byPage), 'A')).toEqual({ asks: 3, startedAt: 1 });
    expect(conversationStats(conversationEntries(pages, byPage), null)).toEqual({ asks: 0, startedAt: null });
  });


  it('makes a plain-text excerpt from Markdown with maths', () => {
    expect(answerExcerpt('**"why $\\sqrt{d_k}$?"**\n\n- It keeps the *softmax* of $q \\cdot k$ in range (p. 4).\n\n$$a = b$$')).toBe('It keeps the softmax of $q \\cdot k$ in range (p. 4). $a = b$');
    expect(answerExcerpt('x'.repeat(200), 20)).toHaveLength(20);
    // never cuts inside a formula
    expect(answerExcerpt(`${'y'.repeat(15)} $\\frac{a}{b}$ tail`, 18)).toBe(`${'y'.repeat(15)}…`);
  });

  it('searches the handwriting and the answer', () => {
    const [e] = conversationEntries(pages, { p1: [card('a', 'p1', { hw: ['Why scale?'], text: 'Because of variance.' })] });
    expect([matchesQuery(e, 'scale'), matchesQuery(e, 'VARIANCE'), matchesQuery(e, 'gradient'), matchesQuery(e, ' ')]).toEqual([true, true, false, true]);
  });
});
