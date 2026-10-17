import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PageRecord, ScreenDescription, TextBox } from '../model/types';
import { useEditorStore } from '../store/editorStore';
import { renderMarkdown } from '../agent/markdown';
import { connectorEndpoints } from '../agent/placement';
import { cancelAsk, reAsk, retryAsk, summariseHandwriting } from '../agent/ask';
import { PageOverlayObject } from './TextBoxView';
import { useAgentStore } from '../agent/client';
import { IconClose } from './icons';

const HEADER_PT = 18;
const MIN_HEIGHT_PT = 44;

/** Throttle Markdown rendering to one per animation frame while streaming (agent design §6.2). */
function useRenderedHtml(src: string): string {
  const [html, setHtml] = useState(() => renderMarkdown(src));
  const pending = useRef<number>(0);
  const latest = useRef(src);
  latest.current = src;
  useEffect(() => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => { pending.current = 0; setHtml(renderMarkdown(latest.current)); });
    return () => { /* keep the frame: it renders the latest source */ };
  }, [src]);
  return html;
}

export function AnswerCardView({ tb, zoom, selected, page }: { tb: TextBox; zoom: number; selected: boolean; page: PageRecord }) {
  const a = tb.answer!;
  const { updateTextBox, commitTextBoxEdit, deleteTextBox } = useEditorStore.getState();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState(false);
  const [draft, setDraft] = useState<ScreenDescription | null>(null);
  const drag = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number; orig: TextBox } | null>(null);
  const html = useRenderedHtml(tb.text);
  const flash = useAgentStore((s) => s.flashCardId === tb.id);
  const summary = useMemo(() => summariseHandwriting(a.description), [a.description]);

  // Grow with the content up to maxHeight; beyond that the body scrolls (§6.3 "Growth").
  useLayoutEffect(() => {
    if (a.collapsed) return;
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const contentPt = el.scrollHeight / zoom + HEADER_PT + 6;
      const h = Math.max(MIN_HEIGHT_PT, Math.min(a.maxHeight, contentPt));
      if (Math.abs(h - tb.height) > 0.5) updateTextBox(tb.id, { height: h }, false);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [html, zoom, a.collapsed, a.maxHeight, tb.height, tb.id, updateTextBox, details]);

  const startDrag = (e: RPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch' && useEditorStore.getState().penActive) return;
    e.stopPropagation(); e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    drag.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: tb.x, oy: tb.y, orig: tb };
  };
  const moveDrag = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - d.sx) / zoom, dy = (e.clientY - d.sy) / zoom;
    updateTextBox(tb.id, { x: Math.max(0, Math.min(page.width - tb.width, d.ox + dx)), y: Math.max(0, Math.min(page.height - tb.height, d.oy + dy)) }, false);
  };
  const endDrag = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4;
    if (moved) commitTextBoxEdit(d.orig);
    else setDetails((v) => !v);
  };

  const setCollapsed = (collapsed: boolean) => updateTextBox(tb.id, { answer: { ...a, collapsed } }, true);
  const onClose = () => { if (a.status === 'answering') cancelAsk(a.askId); else deleteTextBox(tb.id); };

  const cardRect = { x: tb.x, y: tb.y, width: tb.width, height: a.collapsed ? 24 / zoom : tb.height };
  const conn = connectorEndpoints(cardRect, a.anchorRect);
  const showConnector = a.anchorRect.width > 0 || a.anchorRect.height > 0;

  if (a.collapsed) {
    return (
      <>
        {showConnector && <Connector from={conn.from} to={conn.to} zoom={zoom} />}
        <PageOverlayObject x={tb.x} y={tb.y} width={28 / zoom} height={28 / zoom} zoom={zoom} dataId={tb.id} className={'answer-card collapsed' + (flash ? ' flash' : '')}>
          <button className="btn answer-pill" aria-label="Expand answer" title={summary} onPointerDown={(e) => e.stopPropagation()} onClick={() => setCollapsed(false)}>✦</button>
        </PageOverlayObject>
      </>
    );
  }

  const editing = details && draft ? draft : a.description;
  return (
    <>
      {showConnector && <Connector from={conn.from} to={conn.to} zoom={zoom} />}
      <PageOverlayObject
        x={tb.x} y={tb.y} width={tb.width} height={tb.height} zoom={zoom} dataId={tb.id}
        className={'answer-card' + (a.floating ? ' floating' : '') + (selected ? ' selected' : '') + (a.status === 'answering' ? ' answering' : '') + (flash ? ' flash' : '')}
        style={{ fontSize: tb.fontSize * zoom }}
      >
        <div className="answer-header" style={{ height: HEADER_PT * zoom }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <span className="answer-summary" title="Tap to see and correct what was read">{summary}</span>
          <button className="answer-tool" aria-label="Collapse answer" onPointerDown={(e) => e.stopPropagation()} onClick={() => setCollapsed(true)}>▾</button>
          <button className="answer-tool" aria-label={a.status === 'answering' ? 'Cancel' : 'Delete answer'} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}><IconClose /></button>
        </div>
        <div ref={bodyRef} className="answer-body" style={{ maxHeight: (a.maxHeight - HEADER_PT - 6) * zoom }} onPointerDown={(e) => e.stopPropagation()}>
          {details && (
            <div className="answer-details">
              <div className="hint">{editing.location.summary || (editing.location.section ? `§${editing.location.section}` : 'Location not identified')}</div>
              {editing.handwriting.length === 0 && <div className="hint">No handwriting was read.</div>}
              {editing.handwriting.map((h, i) => (
                <label key={i} className="answer-hw">
                  <span className="hint">p. {h.page}{h.near ? ` · near ${h.near}` : ''}</span>
                  <input className="input" value={h.text} aria-label={`Handwriting ${i + 1}`} onChange={(e) => {
                    const base = draft ?? a.description;
                    setDraft({ ...base, handwriting: base.handwriting.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) });
                  }} />
                </label>
              ))}
              {editing.unreadable && <div className="hint">Unreadable: {editing.unreadable}</div>}
              <div className="row">
                <button className="btn primary" style={{ minHeight: 32 }} onClick={() => { setDetails(false); void reAsk(tb.id, draft ?? a.description); setDraft(null); }}>Re-ask</button>
                <button className="btn" style={{ minHeight: 32 }} onClick={() => { setDetails(false); setDraft(null); }}>Close</button>
              </div>
            </div>
          )}
          {a.status === 'answering' && tb.text === '' && <div className="answer-status">Thinking…</div>}
          {a.status === 'error' && (
            <div className="answer-status error">
              {a.error || 'Something went wrong.'} <button className="btn" style={{ minHeight: 28 }} onClick={() => void retryAsk(a.askId)}>Retry</button>
            </div>
          )}
          <div className="answer-content markdown" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </PageOverlayObject>
    </>
  );
}

function Connector({ from, to, zoom }: { from: { x: number; y: number }; to: { x: number; y: number }; zoom: number }) {
  return (
    <svg className="answer-connector" aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
      <line x1={from.x * zoom} y1={from.y * zoom} x2={to.x * zoom} y2={to.y * zoom} />
      <circle cx={to.x * zoom} cy={to.y * zoom} r={2.5} />
    </svg>
  );
}
