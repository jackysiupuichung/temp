/**
 * The document's Ask conversations, derived from its answer cards: what the
 * conversation chip by the Ask button and the conversation panel show.
 */
import type { PageRecord, TextBox } from '../model/types';
import { splitMath } from './markdown';

export type ConversationEntry = { card: TextBox; pageIndex: number };
export type ConversationGroup = {
  /** null for cards made before cards recorded their session. */
  sessionId: string | null;
  current: boolean;
  entries: ConversationEntry[];
};
export type ConversationStats = { asks: number; startedAt: number | null };

/** Every answer card, in the order they were asked (cards without a time fall back to page order, then top to bottom). */
export function conversationEntries(pages: PageRecord[], textBoxesByPage: Record<string, TextBox[]>): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  pages.forEach((p, pageIndex) => {
    for (const tb of textBoxesByPage[p.id] ?? []) if (tb.kind === 'answer' && tb.answer) out.push({ card: tb, pageIndex });
  });
  return out.sort((a, b) => {
    const ta = a.card.answer!.askedAt, tb = b.card.answer!.askedAt;
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    if ((ta == null) !== (tb == null)) return ta == null ? -1 : 1; // undated (older) cards first
    return a.pageIndex - b.pageIndex || a.card.y - b.card.y;
  });
}

/** Group entries by conversation: the current one first, then earlier ones newest first, then undated cards. */
export function groupConversations(entries: ConversationEntry[], currentSessionId: string | null): ConversationGroup[] {
  const bySession = new Map<string | null, ConversationEntry[]>();
  for (const e of entries) {
    const k = e.card.answer!.sessionId ?? null;
    const arr = bySession.get(k) ?? [];
    arr.push(e);
    bySession.set(k, arr);
  }
  const last = (es: ConversationEntry[]) => es[es.length - 1].card.answer!.askedAt ?? 0;
  const groups: ConversationGroup[] = [...bySession].map(([sessionId, es]) => ({ sessionId, current: !!currentSessionId && sessionId === currentSessionId, entries: es }));
  return groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if ((a.sessionId == null) !== (b.sessionId == null)) return a.sessionId == null ? 1 : -1;
    return last(b.entries) - last(a.entries);
  });
}

/** Asks in one conversation and when it started. */
export function conversationStats(entries: ConversationEntry[], sessionId: string | null): ConversationStats {
  const mine = sessionId ? entries.filter((e) => e.card.answer!.sessionId === sessionId) : [];
  const times = mine.map((e) => e.card.answer!.askedAt).filter((t): t is number => t != null);
  return { asks: mine.length, startedAt: times.length ? Math.min(...times) : null };
}

export function formatAskTime(t: number | undefined, now = Date.now()): string {
  if (t == null) return '';
  const d = new Date(t), n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The start of an answer as one line: Markdown marks removed, maths kept as `$…$` (render with renderInlineMath),
 * and the bold labels that repeat the handwriting (**"why √d_k?"**) skipped. Cut at `max` characters, never inside a formula.
 */
export function answerExcerpt(markdown: string, max = 160): string {
  const body = markdown.split(/\n\s*\n/).filter((p) => !/^\s*\*\*[^*]+\*\*:?\s*$/.test(p)).join(' ');
  let out = '';
  let len = 0;
  for (const seg of splitMath(body.replace(/\s+/g, ' '))) {
    const piece = seg.kind === 'math' ? `$${seg.tex.trim()}$` : stripMarks(seg.text);
    const cost = seg.kind === 'math' ? Math.ceil(seg.tex.length / 2) : piece.length; // a formula renders shorter than its source
    if (len + cost > max) {
      if (seg.kind === 'text') out += piece.slice(0, Math.max(0, max - len - 1)).trimEnd();
      return `${out.trimEnd()}…`;
    }
    out += piece;
    len += cost;
  }
  return out.trim();
}

function stripMarks(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s+/g, '$1')
    .replace(/(\*\*|\*|~~)/g, '')
    .replace(/(^|\s)__?(\S[^_]*?)__?(?=\s|$|[.,;:!?])/g, '$1$2');
}

/** The handwriting an answer responded to, for display ("The page (no handwriting)" when there was none). */
export function askedQuotes(card: TextBox): string[] {
  const items = card.answer?.description.handwriting.map((h) => h.text.trim()).filter(Boolean) ?? [];
  return items.length ? items : ['The page (no handwriting)'];
}

export function matchesQuery(e: ConversationEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return askedQuotes(e.card).some((t) => t.toLowerCase().includes(needle)) || e.card.text.toLowerCase().includes(needle);
}
