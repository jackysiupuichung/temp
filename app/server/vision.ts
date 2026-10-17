/**
 * Step 2: the vision interpreter (agent design §4). One stateless call that
 * returns a ScreenDescription. Two backends: the Messages API with structured
 * output (needs ANTHROPIC_API_KEY) or the Agent SDK with a JSON schema (works
 * with a `claude login` session).
 */
import type { ScreenDescription } from '../src/agent/protocol';
import type { Config } from './config';
import { SCREEN_DESCRIPTION_JSON_SCHEMA, VISION_SYSTEM_PROMPT, visionUserText } from './prompt';

export type VisionInput = { image: string; pages: number[]; pageCount: number; visibleText: Array<{ pageNumber: number; text: string }> };

export function normaliseDescription(raw: unknown): ScreenDescription {
  const d = (raw ?? {}) as Partial<ScreenDescription>;
  const num = (v: unknown, dflt = 0) => (typeof v === 'number' && isFinite(v) ? v : dflt);
  return {
    location: {
      pages: Array.isArray(d.location?.pages) ? d.location!.pages.map((p) => num(p)).filter((p) => p > 0) : [],
      section: typeof d.location?.section === 'string' ? d.location.section : null,
      summary: typeof d.location?.summary === 'string' ? d.location.summary : '',
    },
    printedItems: Array.isArray(d.printedItems) ? d.printedItems.map((p) => ({ kind: p?.kind ?? 'other', label: typeof p?.label === 'string' ? p.label : null, page: num(p?.page, 1), text: String(p?.text ?? '') })) : [],
    handwriting: Array.isArray(d.handwriting) ? d.handwriting.map((h) => ({
      text: String(h?.text ?? ''),
      box: { x0: num(h?.box?.x0), y0: num(h?.box?.y0), x1: num(h?.box?.x1, 1000), y1: num(h?.box?.y1, 1000) },
      page: num(h?.page, 1),
      near: typeof h?.near === 'string' ? h.near : null,
    })) : [],
    unreadable: typeof d.unreadable === 'string' && d.unreadable.trim() ? d.unreadable : null,
  };
}

async function describeWithMessagesApi(input: VisionInput, cfg: Config, signal: AbortSignal): Promise<ScreenDescription> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const res = await client.messages.create({
    model: cfg.visionModel,
    max_tokens: 1500,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCREEN_DESCRIPTION_JSON_SCHEMA } },
    system: [{ type: 'text', text: VISION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.image } },
        { type: 'text', text: visionUserText(input.pages, input.pageCount, input.visibleText) },
      ],
    }],
  }, { signal });
  if (res.stop_reason === 'refusal') throw new Error('The vision model declined to describe this screenshot');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normaliseDescription(JSON.parse(text));
}

async function describeWithAgentSdk(input: VisionInput, cfg: Config, signal: AbortSignal): Promise<ScreenDescription> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  signal.addEventListener('abort', () => abort.abort(), { once: true });
  async function* prompt() {
    yield {
      type: 'user' as const,
      parent_tool_use_id: null,
      message: {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: input.image } },
          { type: 'text' as const, text: visionUserText(input.pages, input.pageCount, input.visibleText) },
        ],
      },
    };
  }
  const q = query({
    prompt: prompt(),
    options: {
      systemPrompt: VISION_SYSTEM_PROMPT, model: cfg.visionModel, tools: [], settingSources: [], maxTurns: 2,
      mcpServers: {}, strictMcpConfig: true, settings: { disableClaudeAiConnectors: true },
      thinking: { type: 'disabled' }, abortController: abort, persistSession: false,
      outputFormat: { type: 'json_schema', schema: SCREEN_DESCRIPTION_JSON_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  let text = '';
  for await (const m of q) {
    if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') text += b.text;
    if (m.type === 'result') {
      if (m.subtype !== 'success') throw new Error(`Vision step failed: ${m.subtype}${m.errors?.length ? ' – ' + m.errors.join('; ') : ''}`);
      if (m.structured_output) return normaliseDescription(m.structured_output);
      break;
    }
  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(text.trim() ? `Vision step: ${text.trim().slice(0, 300)}` : 'Vision step returned no JSON');
  return normaliseDescription(JSON.parse(text.slice(start, end + 1)));
}

export async function describeScreen(input: VisionInput, cfg: Config, signal: AbortSignal): Promise<ScreenDescription> {
  return cfg.visionBackend === 'messages' ? describeWithMessagesApi(input, cfg, signal) : describeWithAgentSdk(input, cfg, signal);
}
