import { useEffect, useState } from 'react';
import { useAgentStore, client, defaultServerUrl } from '../agent/client';

/** Pairing with the agent server (agent design §2 "Where the server runs"): URL + token, stored locally. */
export function AgentSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useAgentStore((s) => s.settings);
  const status = useAgentStore((s) => s.status);
  const serverInfo = useAgentStore((s) => s.serverInfo);
  const lastError = useAgentStore((s) => s.lastError);
  const saveSettings = useAgentStore((s) => s.saveSettings);
  const [url, setUrl] = useState(settings.url || defaultServerUrl());
  const [token, setToken] = useState(settings.token);
  const [testing, setTesting] = useState(false);
  useEffect(() => { setUrl(settings.url); setToken(settings.token); }, [settings]);

  const save = async (connect: boolean) => {
    await saveSettings({ url: url.trim(), token: token.trim() });
    if (connect) {
      setTesting(true);
      try { await client.ensureConnected(); } catch { /* status shows the error */ } finally { setTesting(false); }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <h3 id="agent-settings-title">Assistant server</h3>
        <p>Ask needs the agent server running on your Mac (<code>npm run server</code> in <code>app/</code>). Enter its address and the pairing token it printed.</p>
        <label className="row" style={{ marginBottom: 8 }}>
          <span style={{ width: 60 }}>URL</span>
          <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://your-mac.local:8787" aria-label="Agent server URL" />
        </label>
        <label className="row" style={{ marginBottom: 12 }}>
          <span style={{ width: 60 }}>Token</span>
          <input className="input" style={{ flex: 1 }} value={token} onChange={(e) => setToken(e.target.value)} placeholder="pairing token" aria-label="Pairing token" autoCapitalize="off" autoCorrect="off" />
        </label>
        <div className="hint" style={{ marginBottom: 12 }} data-testid="agent-status">
          Status: {testing ? 'connecting…' : status}
          {serverInfo && <> · server {serverInfo.serverVersion}{serverInfo.mock ? ' (mock)' : ''} · vision {serverInfo.models.vision} · agent {serverInfo.models.agent}</>}
          {lastError && <span style={{ color: 'var(--danger)' }}> · {lastError}</span>}
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" onClick={() => void save(false)}>Save</button>
          <button className="btn primary" onClick={() => void save(true)}>Save &amp; connect</button>
        </div>
      </div>
    </div>
  );
}
