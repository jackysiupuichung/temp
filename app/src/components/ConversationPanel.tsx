import { useMemo, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useAgentStore } from '../agent/client';
import { newConversation, showCard } from '../agent/ask';
import {
  answerExcerpt, askedQuotes, conversationEntries, conversationStats, formatAskTime, groupConversations, matchesQuery,
  type ConversationEntry, type ConversationGroup,
} from '../agent/conversation';
import { renderInlineMath } from '../agent/markdown';
import { IconClose, IconPlus } from './icons';

const SEARCH_FROM = 5; // show the search box once there are more entries than this

/** The document's Ask history beside the pages: every answer, grouped by conversation; tap one to jump to its card. */
export function ConversationPanel() {
  const doc = useEditorStore((s) => s.doc)!;
  const textBoxesByPage = useEditorStore((s) => s.textBoxesByPage);
  const setOpen = useAgentStore((s) => s.setConversationOpen);
  const [query, setQuery] = useState('');
  const sessionId = doc.agentSessionId ?? null;
  const entries = useMemo(() => conversationEntries(doc.pages, textBoxesByPage), [doc.pages, textBoxesByPage]);
  const stats = useMemo(() => conversationStats(entries, sessionId), [entries, sessionId]);
  const groups = useMemo(() => groupConversations(entries.filter((e) => matchesQuery(e, query)), sessionId), [entries, sessionId, query]);
  const hasCurrent = groups.some((g) => g.current);

  return (
    <aside className="conversation-panel" aria-label="Conversation" data-testid="conversation-panel">
      <header className="conversation-head">
        <h2>Conversation</h2>
        <button className="btn icon-btn" aria-label="Close conversation" title="Close" onClick={() => setOpen(false)}><IconClose /></button>
      </header>
      <div className="conversation-current">
        <div>
          <div className="conversation-summary">
            {sessionId ? `${stats.asks} ${stats.asks === 1 ? 'ask' : 'asks'}` : 'No conversation yet'}
          </div>
          <div className="hint">{sessionId ? 'The assistant remembers these asks.' : 'The next Ask starts a new conversation.'}</div>
        </div>
        <button className="btn" onClick={() => newConversation()} disabled={!sessionId} title="The next Ask starts a fresh conversation about this paper"><IconPlus /> New</button>
      </div>
      {entries.length > SEARCH_FROM && (
        <input className="input conversation-search" type="search" placeholder="Search questions and answers" aria-label="Search the conversation" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div className="conversation-list">
        {entries.length === 0 && <p className="empty-note">No answers yet. Write a question on the page, then tap Ask.</p>}
        {entries.length > 0 && groups.length === 0 && <p className="empty-note">Nothing matches “{query}”.</p>}
        {sessionId && !hasCurrent && !query && entries.length > 0 && <p className="empty-note">Nothing asked in this conversation yet.</p>}
        {groups.map((g) => <Group key={g.sessionId ?? 'undated'} group={g} />)}
      </div>
    </aside>
  );
}

function groupTitle(g: ConversationGroup): string {
  if (g.current) return 'This conversation';
  if (g.sessionId == null) return 'Earlier answers';
  return 'Earlier conversation';
}

function Group({ group }: { group: ConversationGroup }) {
  const n = group.entries.length;
  const started = group.entries[0].card.answer!.askedAt;
  return (
    <section className={'conversation-group' + (group.current ? ' current' : '')} aria-label={groupTitle(group)}>
      <h3>
        <span>{groupTitle(group)}</span>
        <span className="hint">{n} {n === 1 ? 'ask' : 'asks'}{!group.current && started != null ? ` · ${formatAskTime(started)}` : ''}</span>
      </h3>
      <ol>{group.entries.map((e) => <Entry key={e.card.id} entry={e} />)}</ol>
    </section>
  );
}

function Entry({ entry }: { entry: ConversationEntry }) {
  const { card, pageIndex } = entry;
  const a = card.answer!;
  const quotes = askedQuotes(card);
  return (
    <li>
      <button className="conversation-entry" onClick={() => showCard(card.id)} aria-label={`Page ${pageIndex + 1}: ${quotes.join(', ')}. Show the answer`}>
        <span className="meta">
          <span>p. {pageIndex + 1}</span>
          {a.askedAt != null && <span>{formatAskTime(a.askedAt)}</span>}
          {a.status === 'answering' && <span className="status"><span className="spinner" aria-hidden="true" /> Answering</span>}
          {a.status === 'error' && <span className="status error">Failed</span>}
        </span>
        <span className="quotes">{quotes.map((q, i) => <q key={i} dangerouslySetInnerHTML={{ __html: renderInlineMath(q) }} />)}</span>
        {card.text && <span className="excerpt" dangerouslySetInnerHTML={{ __html: renderInlineMath(answerExcerpt(card.text)) }} />}
      </button>
    </li>
  );
}
