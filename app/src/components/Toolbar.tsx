import { useMemo, useState, type ReactNode } from 'react';
import { useEditorStore, rememberColor } from '../store/editorStore';
import { HIGHLIGHTER_WIDTHS, HIGHLIGHT_COLORS, PEN_WIDTHS, PRESET_COLORS, ZOOM_MAX, ZOOM_MIN, type ToolId } from '../model/types';
import { Popover } from './Popover';
import {
  IconBack, IconPen, IconHighlighter, IconEraser, IconLasso, IconText, IconHand, IconUndo, IconRedo, IconPages, IconExport, IconMore,
  IconPlus, IconMinus, IconFitWidth, IconFitPage, IconPaste, IconFinger, IconSpark, IconChat,
} from './icons';
import { exportAnnotatedPdf } from '../export/pdfExport';
import { exportBundle } from '../export/bundle';
import { renderPageImage } from '../api/notebookApi';
import { downloadBlob, safeFilename } from '../export/download';
import { ask, cancelAsk, newConversation, retryAsk } from '../agent/ask';
import { useAgentStore } from '../agent/client';
import { AgentSettingsModal } from './AgentSettings';
import { conversationEntries, conversationStats, formatAskTime } from '../agent/conversation';

const TOOLS: { id: ToolId; label: string; key: string; icon: ReactNode }[] = [
  { id: 'pen', label: 'Pen', key: 'P', icon: <IconPen /> },
  { id: 'highlighter', label: 'Highlighter', key: 'H', icon: <IconHighlighter /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <IconEraser /> },
  { id: 'lasso', label: 'Lasso select', key: 'L', icon: <IconLasso /> },
  { id: 'text', label: 'Text box', key: 'T', icon: <IconText /> },
  { id: 'hand', label: 'Hand (pan)', key: 'Space', icon: <IconHand /> },
];

function ColorGrid({ colors, value, onPick, recent }: { colors: string[]; value: string; onPick: (c: string) => void; recent: string[] }) {
  return (
    <>
      {recent.length > 0 && (
        <>
          <h4>Recent</h4>
          <div className="swatches">{recent.map((c) => <button key={c} className="swatch" aria-label={`Colour ${c}`} aria-pressed={c === value} onClick={() => onPick(c)}><span style={{ background: c }} /></button>)}</div>
        </>
      )}
      <h4>Colour</h4>
      <div className="swatches">
        {colors.map((c) => <button key={c} className="swatch" aria-label={`Colour ${c}`} aria-pressed={c === value} onClick={() => onPick(c)}><span style={{ background: c }} /></button>)}
        <label className="swatch custom" aria-label="Custom colour" title="Custom colour">
          <span style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} />
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </>
  );
}

export function Toolbar({ onBack, docTitle, onRename }: { onBack: () => void; docTitle: string; onRename: (t: string) => void }) {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const ts = useEditorStore((s) => s.toolSettings);
  const setToolSettings = useEditorStore((s) => s.setToolSettings);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const zoom = useEditorStore((s) => s.zoom);
  const setZoom = useEditorStore((s) => s.setZoom);
  const requestFit = useEditorStore((s) => s.requestFit);
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const pageCount = useEditorStore((s) => s.doc?.pages.length ?? 0);
  const requestJumpToPage = useEditorStore((s) => s.requestJumpToPage);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const fingerDraws = useEditorStore((s) => s.fingerDraws);
  const setFingerDraws = useEditorStore((s) => s.setFingerDraws);
  const clipboard = useEditorStore((s) => s.clipboard);
  const paste = useEditorStore((s) => s.paste);
  const indicator = useAgentStore((s) => s.indicator);
  const agentStatus = useAgentStore((s) => s.status);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const sessionId = useEditorStore((s) => s.doc?.agentSessionId ?? null);
  const hasSession = !!sessionId;
  const pages = useEditorStore((s) => s.doc?.pages);
  const textBoxesByPage = useEditorStore((s) => s.textBoxesByPage);
  const entries = useMemo(() => (pages ? conversationEntries(pages, textBoxesByPage) : []), [pages, textBoxesByPage]);
  const stats = useMemo(() => conversationStats(entries, sessionId), [entries, sessionId]);
  const conversationOpen = useAgentStore((s) => s.conversationOpen);
  const setConversationOpen = useAgentStore((s) => s.setConversationOpen);
  const notice = useAgentStore((s) => s.notice);
  const [open, setOpen] = useState<null | 'tool' | 'zoom' | 'export' | 'more' | 'page' | 'conversation'>(null);
  const [pageInput, setPageInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = (k: typeof open) => setOpen((o) => (o === k ? null : k));

  const onToolClick = (id: ToolId) => {
    if (tool === id && (id === 'pen' || id === 'highlighter' || id === 'eraser' || id === 'text')) toggle('tool');
    else { setTool(id); setOpen(null); }
  };

  const doExport = async (kind: 'pdf' | 'bundle' | 'png') => {
    const st = useEditorStore.getState();
    if (!st.doc) return;
    setOpen(null);
    setBusy('Exporting…');
    try {
      const name = safeFilename(st.doc.title);
      if (kind === 'pdf') downloadBlob(await exportAnnotatedPdf(st.doc, st.strokesByPage, st.textBoxesByPage), `${name} (annotated).pdf`);
      else if (kind === 'bundle') downloadBlob(await exportBundle(st.doc), `${name}.notebook.zip`);
      else { const p = st.doc.pages[st.currentPageIndex]; downloadBlob(await renderPageImage(p.id, 2), `${name} p${st.currentPageIndex + 1}.png`); }
    } catch (e) {
      alert('Export failed: ' + (e as Error).message);
    } finally { setBusy(null); }
  };

  const dotColor = tool === 'pen' ? ts.pen.color : tool === 'highlighter' ? ts.highlighter.color : tool === 'text' ? ts.text.color : null;

  return (
    <div className="toolbar" role="toolbar" aria-label="Editor toolbar">
      <div className="group">
        <button className="btn icon-btn" onClick={onBack} aria-label="Back to library" title="Back to library"><IconBack /></button>
        <button className="btn title" onClick={() => { const t = window.prompt('Rename document', docTitle); if (t && t.trim()) onRename(t.trim()); }} title="Rename">{docTitle}</button>
      </div>
      <div className="spacer" />
      <div className="group" role="radiogroup" aria-label="Tools">
        {TOOLS.map((t) => (
          <button
            key={t.id} className="btn icon-btn tool-btn" role="radio" aria-checked={tool === t.id} aria-pressed={tool === t.id} aria-label={t.label}
            title={`${t.label} (${t.key})`} data-popover-anchor data-tool={t.id} onClick={() => onToolClick(t.id)}
          >
            {t.icon}
            {tool === t.id && dotColor && <span className="dot" style={{ background: dotColor }} />}
          </button>
        ))}
        <Popover open={open === 'tool'} onClose={() => setOpen(null)}>
          {tool === 'pen' && (
            <>
              <ColorGrid colors={PRESET_COLORS} value={ts.pen.color} recent={ts.pen.recentColors} onPick={(c) => rememberColor('pen', c)} />
              <h4>Width</h4>
              <div className="widths">{PEN_WIDTHS.map((w) => <button key={w} className="width-btn" aria-label={`Width ${w}`} aria-pressed={ts.pen.width === w} onClick={() => setToolSettings({ pen: { ...ts.pen, width: w } })}><i style={{ width: Math.max(4, w * 2.2), height: Math.max(4, w * 2.2) }} /></button>)}</div>
            </>
          )}
          {tool === 'highlighter' && (
            <>
              <ColorGrid colors={HIGHLIGHT_COLORS} value={ts.highlighter.color} recent={ts.highlighter.recentColors} onPick={(c) => rememberColor('highlighter', c)} />
              <h4>Width</h4>
              <div className="widths">{HIGHLIGHTER_WIDTHS.map((w) => <button key={w} className="width-btn" aria-label={`Width ${w}`} aria-pressed={ts.highlighter.width === w} onClick={() => setToolSettings({ highlighter: { ...ts.highlighter, width: w } })}><i style={{ width: 28, height: Math.max(4, w * 0.7), borderRadius: 2 }} /></button>)}</div>
            </>
          )}
          {tool === 'eraser' && (
            <>
              <h4>Mode</h4>
              <div className="seg">
                <button aria-pressed={ts.eraser.mode === 'stroke'} onClick={() => setToolSettings({ eraser: { ...ts.eraser, mode: 'stroke' } })}>Whole stroke</button>
                <button aria-pressed={ts.eraser.mode === 'partial'} onClick={() => setToolSettings({ eraser: { ...ts.eraser, mode: 'partial' } })}>Partial</button>
              </div>
              <h4>Size</h4>
              <div className="widths">{[4, 8, 14, 24].map((r) => <button key={r} className="width-btn" aria-label={`Eraser size ${r}`} aria-pressed={ts.eraser.radius === r} onClick={() => setToolSettings({ eraser: { ...ts.eraser, radius: r } })}><i style={{ width: r + 6, height: r + 6, background: 'transparent', border: '2px solid currentColor' }} /></button>)}</div>
            </>
          )}
          {tool === 'text' && (
            <>
              <ColorGrid colors={PRESET_COLORS} value={ts.text.color} recent={[]} onPick={(c) => setToolSettings({ text: { ...ts.text, color: c } })} />
              <h4>Font size</h4>
              <div className="seg">{[10, 12, 14, 18, 24, 32].map((f) => <button key={f} aria-pressed={ts.text.fontSize === f} onClick={() => setToolSettings({ text: { ...ts.text, fontSize: f } })}>{f}</button>)}</div>
            </>
          )}
        </Popover>
      </div>
      <div className="divider" />
      <div className="group">
        <button className="btn icon-btn" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"><IconUndo /></button>
        <button className="btn icon-btn" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><IconRedo /></button>
        {clipboard && <button className="btn icon-btn" onClick={() => { const d = useEditorStore.getState().doc; if (d) paste(d.pages[currentPageIndex].id); }} aria-label="Paste" title="Paste (⌘V)"><IconPaste /></button>}
      </div>
      <div className="divider" />
      <div className="group ask-group">
        <button className="btn ask-btn" onClick={() => void ask().catch(() => {})} disabled={!!indicator && !indicator.error} aria-label="Ask" title="Ask about what is on screen (A)" data-testid="ask-btn">
          <IconSpark />
          <span className="label">Ask</span>
        </button>
        {hasSession && (
          <button className="btn conversation-chip" data-popover-anchor aria-expanded={open === 'conversation'} onClick={() => toggle('conversation')} data-testid="conversation-chip"
            aria-label={`This conversation: ${stats.asks} ${stats.asks === 1 ? 'ask' : 'asks'}`} title="This conversation">
            {stats.asks} {stats.asks === 1 ? 'ask' : 'asks'}
          </button>
        )}
        <Popover open={open === 'conversation' && hasSession} onClose={() => setOpen(null)}>
          <h4>This conversation</h4>
          <div className="conversation-summary">
            {stats.asks} {stats.asks === 1 ? 'ask' : 'asks'}{stats.startedAt != null && ` · since ${formatAskTime(stats.startedAt)}`}
          </div>
          <p className="hint conversation-explain">The assistant remembers the earlier asks in this conversation. A new conversation starts from just the paper.</p>
          <div className="menu">
            <button className="btn" onClick={() => { setConversationOpen(true); setOpen(null); }}><IconChat /> Show conversation</button>
            <button className="btn" onClick={() => { newConversation(); setOpen(null); }} data-testid="new-conversation"><IconPlus /> New conversation</button>
          </div>
        </Popover>
        {indicator && (
          <div className={'ask-indicator' + (indicator.error ? ' error' : '')} role="status" data-testid="ask-indicator">
            {indicator.error ? <span>{indicator.error}</span> : <span><span className="spinner" aria-hidden="true" /> {indicator.text}</span>}
            {indicator.error && indicator.canRetry && <button className="btn mini" onClick={() => void retryAsk(indicator.askId)}>Retry</button>}
            {indicator.error && agentStatus !== 'connected' && <button className="btn mini" onClick={() => setSettingsOpen(true)}>Settings</button>}
            <button className="btn mini" aria-label="Cancel" onClick={() => cancelAsk(indicator.askId)}>×</button>
          </div>
        )}
      </div>
      <div className="spacer" />
      <div className="group">
        <button className="btn page-indicator" data-popover-anchor aria-label={`Page ${currentPageIndex + 1} of ${pageCount}. Jump to page`} title="Jump to page" onClick={() => { setPageInput(String(currentPageIndex + 1)); toggle('page'); }}>
          {currentPageIndex + 1} / {pageCount}
        </button>
        <Popover open={open === 'page'} onClose={() => setOpen(null)} align="right">
          <form className="row" onSubmit={(e) => { e.preventDefault(); const n = parseInt(pageInput, 10); if (n >= 1 && n <= pageCount) { requestJumpToPage(n - 1); setOpen(null); } }}>
            <label className="hint" htmlFor="jump-page">Go to page</label>
            <input id="jump-page" className="input" type="number" min={1} max={pageCount} value={pageInput} onChange={(e) => setPageInput(e.target.value)} style={{ width: 80 }} autoFocus />
            <button className="btn primary" type="submit">Go</button>
          </form>
        </Popover>
      </div>
      <div className="group">
        <button className="btn icon-btn" onClick={() => setZoom(zoom / 1.2)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (⌘-)"><IconMinus /></button>
        <button className="btn zoom-label" data-popover-anchor aria-label="Zoom options" onClick={() => toggle('zoom')}>{Math.round(zoom * 100)}%</button>
        <button className="btn icon-btn" onClick={() => setZoom(zoom * 1.2)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (⌘+)"><IconPlus /></button>
        <button className="btn icon-btn" onClick={() => requestFit('width')} aria-label="Fit width" title="Fit width (⌘0)"><IconFitWidth /></button>
        <button className="btn icon-btn" onClick={() => requestFit('page')} aria-label="Fit page" title="Fit page"><IconFitPage /></button>
        <Popover open={open === 'zoom'} onClose={() => setOpen(null)} align="right">
          <div className="menu">
            {[0.5, 0.75, 1, 1.5, 2, 3, 4].map((z) => <button key={z} className="btn" aria-pressed={Math.abs(zoom - z) < 0.01} onClick={() => { setZoom(z); setOpen(null); }}>{Math.round(z * 100)}%</button>)}
          </div>
        </Popover>
      </div>
      <div className="divider" />
      <div className="group">
        <button className="btn icon-btn" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle page thumbnails" title="Page thumbnails"><IconPages /></button>
        <button className="btn icon-btn" aria-pressed={conversationOpen} onClick={() => setConversationOpen(!conversationOpen)} aria-label="Toggle conversation" title="Conversation" data-testid="conversation-toggle"><IconChat /></button>
        <button className="btn icon-btn" aria-pressed={fingerDraws} onClick={() => setFingerDraws(!fingerDraws)} aria-label="Draw with finger" title="Draw with finger (one finger draws, two fingers scroll)"><IconFinger /></button>
        <button className="btn icon-btn" data-popover-anchor aria-expanded={open === 'export'} onClick={() => toggle('export')} aria-label="Export" title="Export"><IconExport /></button>
        <Popover open={open === 'export'} onClose={() => setOpen(null)} align="right">
          <div className="menu">
            <button className="btn" onClick={() => void doExport('pdf')}>Export annotated PDF</button>
            <button className="btn" onClick={() => void doExport('bundle')}>Export backup bundle (.zip)</button>
            <button className="btn" onClick={() => void doExport('png')}>Export current page as PNG</button>
          </div>
        </Popover>
        <button className="btn icon-btn" data-popover-anchor aria-expanded={open === 'more'} onClick={() => toggle('more')} aria-label="More" title="More"><IconMore /></button>
        <Popover open={open === 'more'} onClose={() => setOpen(null)} align="right">
          <div className="menu">
            <button className="btn" onClick={() => { const d = useEditorStore.getState(); d.insertBlankPageAfter(d.currentPageIndex); setOpen(null); }}>Insert blank page after current</button>
            <button className="btn" onClick={() => { newConversation(); setOpen(null); }} disabled={!hasSession} title="The next Ask starts a fresh conversation about this paper">New conversation</button>
            <button className="btn" onClick={() => { setSettingsOpen(true); setOpen(null); }}>Assistant settings…</button>
            <div className="hint" style={{ padding: '8px 10px' }}>Shortcuts: P pen · H highlighter · E eraser · L lasso · T text · A ask · Space+drag pan · ⌘Z undo · ⇧⌘Z redo · ⌘C/⌘X/⌘V copy/cut/paste · double-click a text box to edit it</div>
          </div>
        </Popover>
      </div>
      {busy ? <div className="toast">{busy}</div> : notice && (
        <div className="toast notice" role="status" data-testid="notice">
          <span>{notice.text}</span>
          {notice.undo && <button className="btn mini" onClick={() => { notice.undo!(); useAgentStore.getState().setNotice(null); }}>Undo</button>}
        </div>
      )}
      {settingsOpen && <AgentSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
