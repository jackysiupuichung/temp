import { describe, it, expect } from 'vitest';
import { splitMath, renderMarkdown, escapeHtml, markdownToPlainText } from './markdown';

describe('splitMath', () => {
  it('finds inline and display maths', () => {
    const segs = splitMath('Scale by $\\sqrt{d_k}$ because $$q \\cdot k$$ grows.');
    expect(segs).toEqual([
      { kind: 'text', text: 'Scale by ' },
      { kind: 'math', tex: '\\sqrt{d_k}', display: false },
      { kind: 'text', text: ' because ' },
      { kind: 'math', tex: 'q \\cdot k', display: true },
      { kind: 'text', text: ' grows.' },
    ]);
  });
  it('leaves an unclosed delimiter as text (streaming)', () => {
    expect(splitMath('costs $5 and $\\sqrt{')).toEqual([{ kind: 'text', text: 'costs $5 and $\\sqrt{' }]);
    expect(splitMath('half $$x^2')).toEqual([{ kind: 'text', text: 'half $$x^2' }]);
  });
  it('ignores escaped dollars and dollars inside code', () => {
    expect(splitMath('\\$5 and `$x$`')).toEqual([{ kind: 'text', text: '\\$5 and `$x$`' }]);
  });
  it('does not pair across a paragraph break', () => {
    expect(splitMath('a $b\n\nc$ d')).toEqual([{ kind: 'text', text: 'a $b\n\nc$ d' }]);
  });
});

describe('renderMarkdown', () => {
  it('renders Markdown with KaTeX for maths', () => {
    const html = renderMarkdown('**"why √d_k?"**\n\nBecause $q\\cdot k$ has variance $d_k$.\n\n$$\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$$');
    expect(html).toContain('<strong>');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('<p><span class="katex-display"');
  });
  it('escapes raw HTML instead of injecting it', () => {
    const html = renderMarkdown('hi <script>alert(1)</script> <b>x</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('shows a half-streamed formula as text without errors', () => {
    const html = renderMarkdown('Thus $\\frac{1}{');
    expect(html).toContain('$\\frac{1}{');
    expect(html).not.toContain('katex-error');
  });
  it('does not throw on invalid TeX', () => {
    expect(() => renderMarkdown('$\\invalidcmd{$')).not.toThrow();
    expect(renderMarkdown('$\\invalidcmd$')).toContain('katex');
  });
});

describe('helpers', () => {
  it('escapeHtml', () => { expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'); });
  it('markdownToPlainText strips emphasis and bullets', () => {
    expect(markdownToPlainText('**bold** and *it*\n- a\n- b')).toBe('bold and it\n• a\n• b');
  });
});
