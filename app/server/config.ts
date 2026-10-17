/** Agent server configuration (agent design §2): env vars and flags. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  token: string;
  mock: boolean;
  visionModel: string;
  agentModel: string;
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Vision backend: Messages API (needs ANTHROPIC_API_KEY) or the Agent SDK (works with `claude login`). */
  visionBackend: 'messages' | 'agent-sdk';
  maxPdfPagesAttached: number;
  maxPdfBytesAttached: number;
  maxPaperChars: number;
};

export const SERVER_VERSION = '0.1.0';

function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }

export function loadConfig(): Config {
  const dataDir = path.resolve(arg('data') ?? process.env.AGENT_SERVER_DATA ?? path.join(os.homedir(), '.pdf-notebook-agent'));
  fs.mkdirSync(path.join(dataDir, 'papers'), { recursive: true });
  const tokenFile = path.join(dataDir, 'token');
  let token = process.env.AGENT_SERVER_TOKEN ?? '';
  if (!token) {
    if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) { token = crypto.randomBytes(9).toString('base64url'); fs.writeFileSync(tokenFile, token, { mode: 0o600 }); }
  }
  const mock = flag('mock') || process.env.AGENT_SERVER_MOCK === '1';
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const effort = (process.env.AGENT_EFFORT ?? 'medium') as Config['agentEffort'];
  return {
    port: Number(arg('port') ?? process.env.AGENT_SERVER_PORT ?? 8787),
    host: arg('host') ?? process.env.AGENT_SERVER_HOST ?? '0.0.0.0',
    dataDir,
    token,
    mock,
    visionModel: process.env.VISION_MODEL ?? 'claude-haiku-5-5',
    agentModel: process.env.AGENT_MODEL ?? 'claude-opus-5-5',
    agentEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'medium',
    visionBackend: (process.env.VISION_BACKEND as Config['visionBackend']) ?? (hasApiKey ? 'messages' : 'agent-sdk'),
    maxPdfPagesAttached: 100,
    maxPdfBytesAttached: 24 * 1024 * 1024,
    maxPaperChars: 400_000,
  };
}

/** LAN addresses to show the user for pairing. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}
