/**
 * Step 3: the main agent (agent design §5), built on the Claude Agent SDK.
 * One resumable session per document, streamed text deltas. The paper is in
 * context at most once: as a PDF block attached on the session's first turn,
 * or, when that isn't possible, read on demand with Read/Grep/Glob confined
 * to the paper's own files.
 */
import path from 'node:path';
import type { AnswerUsage } from '../src/agent/protocol';
import type { Config } from './config';
import type { Paper } from './paper';
import { buildSystemPrompt, type PaperMode } from './prompt';

export type AgentTurnInput = {
  docId: string;
  docTitle: string;
  sessionId: string | null;
  screenText: string;
  paper: Paper | null;
  mode: PaperMode;
  pdfBase64: string | null; // set when the PDF should be attached to this turn
  signal: AbortSignal;
};

export type AgentTurnEvents = {
  onDelta: (text: string) => void;
  onStatus?: (text: string) => void;
  onCompaction?: () => void;
};

export type AgentTurnResult = { sessionId: string; usage: AnswerUsage; costUsd: number };

const PAPER_TOOLS = ['Read', 'Grep', 'Glob'];

/** Keep the paper tools inside the paper's files: the data directory also holds the pairing token and other papers. */
export function paperToolGuard(paper: Paper) {
  const allowed = [path.resolve(paper.pageDir), path.resolve(paper.pdfPath)];
  const inside = (p: string) => { const r = path.resolve(paper.pageDir, p); return allowed.some((a) => r === a || r.startsWith(a + path.sep)); };
  return async (input: unknown) => {
    const { tool_name: tool, tool_input: raw } = input as { tool_name: string; tool_input: Record<string, unknown> };
    const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } });
    if (!PAPER_TOOLS.includes(tool)) return deny(`${tool} is not available`);
    const target = tool === 'Read' ? raw.file_path : raw.path;
    if (target === undefined && tool !== 'Read') {
      // Grep/Glob default to the cwd (the data directory); point them at the page files instead.
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, updatedInput: { ...raw, path: paper.pageDir } } };
    }
    if (typeof target !== 'string' || !inside(target)) return deny(`Only the paper's files can be read: ${paper.pageDir} and ${paper.pdfPath}`);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const } };
  };
}

export async function runAgentTurn(input: AgentTurnInput, cfg: Config, ev: AgentTurnEvents): Promise<AgentTurnResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  input.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const tools = input.mode === 'tools' && !!input.paper;
  const content: Array<Record<string, unknown>> = [];
  if (input.pdfBase64) {
    // No cache_control here: the CLI places its own cache breakpoints (with a 1h TTL); an explicit 5m block
    // before them is rejected by the API ("a ttl='1h' cache_control block must not come after a ttl='5m' block").
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdfBase64 }, title: input.docTitle });
  }
  content.push({ type: 'text', text: input.screenText });
  async function* prompt() {
    yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: content as never } };
  }
  const q = query({
    prompt: input.pdfBase64 ? prompt() : input.screenText,
    options: {
      systemPrompt: { type: 'custom', prompt: buildSystemPrompt(input.paper, input.docTitle, input.mode) },
      model: cfg.agentModel,
      effort: cfg.agentEffort,
      tools: tools ? PAPER_TOOLS : [],
      ...(tools ? { allowedTools: PAPER_TOOLS, hooks: { PreToolUse: [{ hooks: [paperToolGuard(input.paper!)] }] } } : {}),
      settingSources: [],
      // No MCP servers, including the claude.ai connectors of the logged-in account: they would give the agent
      // tools outside the paper, and their late arrival changes the tool list, which invalidates the prompt cache.
      mcpServers: {},
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      maxTurns: tools ? 12 : 3,
      includePartialMessages: true,
      abortController: abort,
      cwd: cfg.dataDir,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'pdf-notebook-agent/0.1' },
      ...(input.sessionId ? { resume: input.sessionId } : {}),
    },
  });
  let sessionId = input.sessionId ?? '';
  let sawText = false;
  let apiError: string | null = null; // an API error ends the turn as a 'success' result with is_error; the error text arrives as assistant text
  for await (const m of q) {
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') { sawText = true; ev.onDelta(e.delta.text); }
      else if (e.type === 'content_block_start' && e.content_block.type === 'thinking') ev.onStatus?.('Thinking…');
      else if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') ev.onStatus?.('Looking it up in the paper…');
      continue;
    }
    if (m.type === 'system' && m.subtype === 'init') { sessionId = m.session_id; continue; }
    if (m.type === 'system' && m.subtype === 'compact_boundary') { ev.onCompaction?.(); continue; }
    if (m.type === 'assistant' && m.error) {
      apiError = `${m.error}: ${m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()}`;
      continue;
    }
    if (m.type === 'assistant' && !sawText) {
      // No partial events (older CLI): forward the whole text.
      for (const b of m.message.content) if (b.type === 'text' && b.text) ev.onDelta(b.text);
      continue;
    }
    if (m.type === 'result') {
      sessionId = m.session_id || sessionId;
      if (m.subtype !== 'success' || m.is_error || apiError) {
        const detail = apiError ?? (m.subtype === 'success' ? m.result : m.errors?.length ? m.errors.join('; ') : m.subtype);
        throw new Error(`Agent turn failed: ${detail}`);
      }
      const u = m.usage;
      return {
        sessionId,
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 },
        costUsd: m.total_cost_usd,
      };
    }
  }
  throw new Error('Agent turn ended without a result');
}
