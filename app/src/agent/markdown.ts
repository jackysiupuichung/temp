/**
 * Markdown + KaTeX rendering for answer cards (agent design §6.2).
 * - `$…$` inline and `$$…$$` display maths go through KaTeX (throwOnError: false).
 * - Unclosed delimiters are left as plain text so half-streamed formulas don't flicker.
 * - Raw HTML in the Markdown is escaped, never injected.
 */
import { Marked } from 'marked';
import katex from 'katex';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type MathSegment = { kind: 'text'; text: string } | { kind: 'math'; tex: string; display: boolean };

/**
 * Split Markdown source into text and maths segments. `$$…$$` first, then `$…$`.
 * A `$` that has no closing partner (yet) stays text. Escaped `\$` is not a delimiter.
 */
export function splitMath(src: string): MathSegment[] {
  const out: MathSegment[] = [];
  let i = 0, textStart = 0;
  const pushText = (end: number) => { if (end > textStart) out.push({ kind: 'text', text: src.slice(textStart, end) }); };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' ) { i += 2; continue; }
    if (c === '`') { // skip code spans / fences: maths inside code is literal
      const fence = src.startsWith('```', i);
      const close = fence ? src.indexOf('```', i + 3) : src.indexOf('`', i + 1);
      if (close < 0) break;
      i = close + (fence ? 3 : 1);
      continue;
    }
    if (c === '$') {
      const display = src.startsWith('$$', i);
      const open = display ? '$$' : '$';
      const start = i + open.length;
      let close = -1;
      if (display) close = src.indexOf('$$', start);
      else if (/\s/.test(src[start] ?? ' ')) {
        i = start; continue; // "$ 5": an opener followed by whitespace is a literal dollar
      } else {
        // inline: the closing $ is not preceded by whitespace or a backslash, is not followed by a digit, and sits in the same paragraph
        for (let j = start; j < src.length; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '\n' && src[j + 1] === '\n') break;
          if (src[j] === '$' && !/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] ?? '')) { close = j; break; }
        }
      }
      if (close < 0 || close === start) { i = start; continue; } // unclosed or empty: literal
      const tex = src.slice(start, close);
      if (!display && (tex.startsWith(' ') && tex.endsWith(' ') && tex.trim() === '')) { i = start; continue; }
      pushText(i);
      out.push({ kind: 'math', tex, display });
      i = close + open.length;
      textStart = i;
      continue;
    }
    i++;
  }
  pushText(src.length);
  return out;
}

const marked = new Marked({
  gfm: true, breaks: false,
  renderer: {
    html({ text }) { return escapeHtml(text); },
  },
});

function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display, output: 'htmlAndMathml', strict: 'ignore' });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/** Render Markdown with maths to HTML. Safe to call on every streamed partial. */
export function renderMarkdown(src: string): string {
  const segs = splitMath(src);
  // Replace maths with placeholders, run Markdown, then substitute the KaTeX HTML back.
  const slots: string[] = [];
  let md = '';
  for (const s of segs) {
    if (s.kind === 'text') md += s.text;
    else {
      const id = slots.length;
      slots.push(renderTex(s.tex, s.display));
      md += s.display ? `\n\n\u0000MATH${id}\u0000\n\n` : `\u0000MATH${id}\u0000`;
    }
  }
  let html = marked.parse(md, { async: false }) as string;
  html = html.replace(/\u0000MATH(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? '');
  // A display formula wrapped in a paragraph by marked: unwrap so it can centre.
  html = html.replace(/<p>(<span class="katex-display">[\s\S]*?<\/span>)<\/p>/g, '$1');
  return html;
}

/** Plain-text approximation of an answer (for export and the collapsed card): maths kept as its source. */
export function markdownToPlainText(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}
