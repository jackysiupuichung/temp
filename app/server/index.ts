/**
 * PDF Notebook agent server (agent design §2). Run with `npm run server` in app/.
 *   --port 8787   --host 0.0.0.0   --data <dir>   --mock
 * Env: ANTHROPIC_API_KEY (vision via Messages API; otherwise the Agent SDK's `claude login` session is used),
 *      VISION_MODEL, AGENT_MODEL, AGENT_EFFORT, VISION_BACKEND=messages|agent-sdk, AGENT_SERVER_TOKEN.
 */
import { loadConfig, lanAddresses } from './config';
import { AgentServer } from './ws';

const cfg = loadConfig();
const server = new AgentServer(cfg);
server.wss.on('listening', () => {
  const addrs = lanAddresses();
  console.log(`PDF Notebook agent server ${cfg.mock ? '(MOCK mode) ' : ''}listening on ws://${cfg.host}:${cfg.port}`);
  console.log(`  pairing token: ${cfg.token}`);
  console.log(`  from the iPad use: ${addrs.map((a) => `ws://${a}:${cfg.port}`).join('  or  ') || `ws://<this-mac>:${cfg.port}`}`);
  if (!cfg.mock) console.log(`  vision: ${cfg.visionModel} via ${cfg.visionBackend}; agent: ${cfg.agentModel} (effort ${cfg.agentEffort}); data: ${cfg.dataDir}`);
});
server.wss.on('error', (e) => { console.error('server error', e); process.exit(1); });
process.on('SIGINT', () => { void server.close().then(() => process.exit(0)); });
