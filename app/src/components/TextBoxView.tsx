import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { PageRecord, TextBox, ToolId } from '../model/types';
import { useEditorStore } from '../store/editorStore';

/**
 * X-4: generic page-anchored overlay. Positioned in page coordinates, moves and
 * zooms with the page, optionally collapsible. Text boxes build on it.
 */
export function PageOverlayObject({ x, y, width, height, zoom, collapsible, collapsed, onToggle, children, className, dataId, style }: {
  x: number; y: number; width: number; height: number; zoom: number; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void;
  children: ReactNode; className?: string; dataId?: string; style?: React.CSSProperties;
}) {
  return (
    <div className={'overlay-object ' + (className ?? '')} data-textbox-id={dataId} style={{ left: x * zoom, top: y * zoom, width: width * zoom, height: collapsed ? 24 : height * zoom, ...style }}>
      {collapsible && <button className="btn" style={{ minHeight: 24, height: 24, position: 'absolute', right: 0, top: -24 }} onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '▸' : '▾'}</button>}
      {!collapsed && children}
    </div>
  );
}

// Shared between the text box and the selection overlay that covers it once the lasso selects it,
// so the two clicks of a double-click count together even though they land on different elements.
// (dblclick itself is unreliable for touch and Pencil.)
let lastTap: { id: string; t: number } | null = null;
export function isDoubleTap(id: string, t: number): boolean {
  const double = lastTap !== null && lastTap.id === id && t - lastTap.t < 400;
  lastTap = double ? null : { id, t };
  return double;
}

/** Switch to the text tool and start editing a box. Call from a pointerdown and pass the event:
 *  without preventDefault the browser's mousedown moves focus to <body> right after the textarea
 *  mounts and focuses, which blurs it and immediately ends the edit. */
export function editTextBox(id: string, e: { preventDefault(): void }) {
  e.preventDefault();
  const st = useEditorStore.getState();
  if (st.tool !== 'text') st.setTool('text');
  st.setEditingTextBox(id);
}

export function TextBoxView({ tb, zoom, tool, editing, selected, page }: { tb: TextBox; zoom: number; tool: ToolId; editing: boolean; selected: boolean; page: PageRecord }) {
  const { updateTextBox, commitTextBoxEdit, endTextEdit, setSelection } = useEditorStore.getState();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const origRef = useRef<TextBox | null>(null);
  const drag = useRef<{ kind: 'move' | 'resize'; pointerId: number; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [, force] = useState(0);
  const active = editing || (selected && tool === 'text');

  useEffect(() => {
    if (editing) {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit the box to its text, shrinking as well as growing. scrollHeight never reports less than the
  // textarea's current height, so collapse it for the measurement.
  const autoHeight = () => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = '0px';
    const box = ta.closest<HTMLElement>('.textbox');
    const content = ta.scrollHeight + (box ? box.offsetHeight - box.clientHeight : 0); // + the box's border
    ta.style.height = '';
    const cur = useEditorStore.getState().textBoxesByPage[tb.pageId]?.find((t) => t.id === tb.id);
    if (!cur) return;
    const h = Math.max(cur.fontSize * 1.3 + 8, content / zoom);
    if (Math.abs(h - cur.height) > 0.5) updateTextBox(tb.id, { height: h }, false);
  };


  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && useEditorStore.getState().penActive) return;
    e.stopPropagation();
    if (tool === 'lasso') {
      if (isDoubleTap(tb.id, e.timeStamp)) { editTextBox(tb.id, e); return; }
      setSelection({ pageId: tb.pageId, strokeIds: [], textBoxIds: [tb.id], boundingRect: { x: tb.x, y: tb.y, width: tb.width, height: tb.height } });
      return;
    }
    if (tool === 'text' && !editing) editTextBox(tb.id, e);
  };

  const startDrag = (kind: 'move' | 'resize') => (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    origRef.current = tb;
    drag.current = { kind, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: tb.x, oy: tb.y, ow: tb.width, oh: tb.height };
  };
  const moveDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - d.sx) / zoom, dy = (e.clientY - d.sy) / zoom;
    if (d.kind === 'move') {
      updateTextBox(tb.id, { x: Math.max(0, Math.min(page.width - tb.width, d.ox + dx)), y: Math.max(0, Math.min(page.height - tb.height, d.oy + dy)) }, false);
    } else {
      updateTextBox(tb.id, { width: Math.max(40, Math.min(page.width - tb.x, d.ow + dx)), height: Math.max(tb.fontSize * 1.3 + 8, Math.min(page.height - tb.y, d.oh + dy)) }, false);
    }
    force((n) => n + 1);
  };
  const endDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    // while editing, endTextEdit records the move/resize together with the typing
    if (!editing && origRef.current) commitTextBoxEdit(origRef.current);
    origRef.current = null;
  };

  return (
    <PageOverlayObject x={tb.x} y={tb.y} width={tb.width} height={tb.height} zoom={zoom} dataId={tb.id} className={'textbox' + (active ? ' active' : '') + (selected ? ' selected' : '')} style={{ color: tb.color }}>
      <div style={{ position: 'absolute', inset: 0 }} onPointerDown={onDown}>
        {editing ? (
          <textarea
            ref={taRef}
            aria-label="Text box"
            value={tb.text}
            style={{ fontSize: tb.fontSize * zoom }}
            onChange={(e) => { updateTextBox(tb.id, { text: e.target.value }, false); requestAnimationFrame(autoHeight); }}
            onBlur={() => endTextEdit(tb.id)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } e.stopPropagation(); }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="content" style={{ fontSize: tb.fontSize * zoom }}>{tb.text || ' '}</div>
        )}
      </div>
      {active && (
        <>
          <div className="grip" role="button" aria-label="Move text box" onPointerDown={startDrag('move')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>⋮⋮</div>
          <div className="resize" role="button" aria-label="Resize text box" onPointerDown={startDrag('resize')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
        </>
      )}
    </PageOverlayObject>
  );
}
