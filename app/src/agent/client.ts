/**
 * WebSocket connection to the agent server (agent design §2, §8) and the small
 * UI store for Ask: connection settings, status, and the indicator by the Ask button.
 */
import { create } from 'zustand';
import { getSetting, putSetting } from '../db/db';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './protocol';

export type AgentSettings = { url: string; token: string };
export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ServerInfo = { serverVersion: string; mock: boolean; models: { vision: string; agent: string } };

export type Indicator = { askId: string; text: string; error?: string; canRetry?: boolean; canCancel?: boolean };

export type AgentState = {
  settings: AgentSettings;
  settingsLoaded: boolean;
  status: ConnStatus;
  serverInfo: ServerInfo | null;
  lastError: string | null;
  indicator: Indicator | null;
  /** Running conversation cost reported by the last answer_done (shown in debug). */
  lastCostUsd: number | null;
  settingsOpen: boolean;
  loadSettings(): Promise<void>;
  saveSettings(s: AgentSettings): Promise<void>;
  setIndicator(i: Indicator | null): void;
  setSettingsOpen(v: boolean): void;
};

export function defaultServerUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8787';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname || 'localhost'}:8787`;
}

export const useAgentStore = create<AgentState>((set) => ({
  settings: { url: defaultServerUrl(), token: '' },
  settingsLoaded: false,
  status: 'disconnected',
  serverInfo: null,
  lastError: null,
  indicator: null,
  lastCostUsd: null,
  settingsOpen: false,
  async loadSettings() {
    const s = await getSetting<AgentSettings>('agentServer');
    set({ settings: { url: s?.url || defaultServerUrl(), token: s?.token ?? '' }, settingsLoaded: true });
  },
  async saveSettings(s) {
    set({ settings: s });
    await putSetting('agentServer', s);
    client.disconnect();
  },
  setIndicator(indicator) { set({ indicator }); },
  setSettingsOpen(settingsOpen) { set({ settingsOpen }); },
}));

type Listener = (m: ServerMessage) => void;

class AgentClient {
  private ws: WebSocket | null = null;
  private helloPromise: Promise<void> | null = null;
  private askListeners = new Map<string, Listener>();
  private docListeners = new Map<string, Listener>();
  private anyListeners = new Set<Listener>();

  /** Connect (if needed) and resolve once the server accepted the pairing token. */
  ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.helloPromise) return this.helloPromise;
    if (this.helloPromise && this.ws && this.ws.readyState === WebSocket.CONNECTING) return this.helloPromise;
    const { settings } = useAgentStore.getState();
    if (!settings.url) return Promise.reject(new Error('No agent server configured'));
    useAgentStore.setState({ status: 'connecting', lastError: null });
    let ws: WebSocket;
    try { ws = new WebSocket(settings.url); } catch (e) {
      useAgentStore.setState({ status: 'error', lastError: (e as Error).message });
      return Promise.reject(e);
    }
    this.ws = ws;
    this.helloPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (!settled) { settled = true; reject(new Error(msg)); }
        useAgentStore.setState({ status: 'error', lastError: msg });
        if (this.ws === ws) { this.ws = null; this.helloPromise = null; }
      };
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token: settings.token, clientVersion: PROTOCOL_VERSION } satisfies ClientMessage)); };
      ws.onerror = () => fail('Could not reach the agent server at ' + settings.url);
      ws.onclose = (ev) => {
        const why = ev.reason || (ev.code === 1008 ? 'Pairing token rejected' : `Connection closed (${ev.code})`);
        if (!settled) fail(why);
        else { useAgentStore.setState({ status: 'disconnected', lastError: ev.code === 1000 ? null : why }); if (this.ws === ws) { this.ws = null; this.helloPromise = null; } }
        // Tell in-flight asks the socket went away.
        const m: ServerMessage = { type: 'error', askId: null, message: why, retryable: true };
        for (const l of this.askListeners.values()) l(m);
      };
      ws.onmessage = (ev) => {
        let m: ServerMessage;
        try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
        if (m.type === 'hello_ok') {
          useAgentStore.setState({ status: 'connected', serverInfo: { serverVersion: m.serverVersion, mock: m.mock, models: m.models }, lastError: null });
          if (!settled) { settled = true; resolve(); }
          return;
        }
        if (m.type === 'error' && m.askId === null && !settled) { fail(m.message); return; }
        this.dispatch(m);
      };
    });
    return this.helloPromise;
  }

  private dispatch(m: ServerMessage) {
    for (const l of this.anyListeners) l(m);
    if ('askId' in m && m.askId) { this.askListeners.get(m.askId)?.(m); return; }
    if ('docId' in m) { this.docListeners.get(m.docId)?.(m); return; }
    if (m.type === 'error') for (const l of this.askListeners.values()) l(m);
  }

  send(m: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected to the agent server');
    this.ws.send(JSON.stringify(m));
  }

  onAsk(askId: string, l: Listener): () => void { this.askListeners.set(askId, l); return () => { if (this.askListeners.get(askId) === l) this.askListeners.delete(askId); }; }
  onDoc(docId: string, l: Listener): () => void { this.docListeners.set(docId, l); return () => { if (this.docListeners.get(docId) === l) this.docListeners.delete(docId); }; }
  onAny(l: Listener): () => void { this.anyListeners.add(l); return () => this.anyListeners.delete(l); }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null; this.helloPromise = null;
    if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
    useAgentStore.setState({ status: 'disconnected', serverInfo: null });
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN && useAgentStore.getState().status === 'connected'; }
}

export const client = new AgentClient();
