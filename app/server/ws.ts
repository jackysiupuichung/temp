/** WebSocket protocol handling (agent design §8): pairing, PDF sync, ask / ask_text / cancel. */
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, AskRequest, ScreenDescription } from '../src/agent/protocol';
import { SERVER_VERSION, type Config } from './config';
import { PaperStore, type Paper } from './paper';
import { StateStore } from './state';
import { describeScreen } from './vision';
import { runAgentTurn } from './agent';
import { formatScreen } from './prompt';
import { mockAnswerChunks, mockDescribe } from './mock';

const HELLO_TIMEOUT_MS = 5000;
const PAPER_WAIT_MS = 90_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class AgentServer {
  readonly wss: WebSocketServer;
  readonly papers: PaperStore;
  readonly state: StateStore;
  /** A PDF sync in flight for a document; asks wait on it before the agent step. */
  private pendingSync = new Map<string, Promise<Paper | null>>();
  private pendingResolve = new Map<string, (p: Paper | null) => void>();
  /** Serialise agent turns per document: one session can run one turn at a time. */
  private docQueue = new Map<string, Promise<void>>();

  constructor(readonly cfg: Config) {
    this.papers = new PaperStore(cfg.dataDir);
    this.state = new StateStore(cfg.dataDir);
    this.wss = new WebSocketServer({ port: cfg.port, host: cfg.host, maxPayload: 120 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? '?'));
  }

  /** Stop listening and drop every client: `wss.close()` alone only resolves once all clients have gone, which hung Ctrl-C. */
  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }

  private onConnection(ws: WebSocket, remote: string) {
    const send = (m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    let paired = false;
    const asks = new Map<string, AbortController>();
    const helloTimer = setTimeout(() => { if (!paired) ws.close(1008, 'No hello'); }, HELLO_TIMEOUT_MS);
    ws.on('close', () => { clearTimeout(helloTimer); for (const a of asks.values()) a.abort(); });
    ws.on('message', (data) => {
      let m: ClientMessage;
      try { m = JSON.parse(data.toString()) as ClientMessage; } catch { send({ type: 'error', askId: null, message: 'Bad JSON', retryable: false }); return; }
      if (!paired) {
        if (m.type !== 'hello') { ws.close(1008, 'Hello first'); return; }
        if (!safeEqual(m.token ?? '', this.cfg.token)) { ws.close(1008, 'Pairing token rejected'); return; }
        paired = true;
        clearTimeout(helloTimer);
        console.log(`[ws] paired ${remote} (client ${m.clientVersion})`);
        send({ type: 'hello_ok', serverVersion: SERVER_VERSION, mock: this.cfg.mock, models: { vision: this.cfg.mock ? 'mock' : this.cfg.visionModel, agent: this.cfg.mock ? 'mock' : this.cfg.agentModel } });
        return;
      }
      switch (m.type) {
        case 'sync_pdf': void this.onSyncPdf(m, send); break;
        case 'ask': void this.onAsk(m, send, asks); break;
        case 'ask_text': void this.onAskText(m, send, asks); break;
        case 'cancel': asks.get(m.askId)?.abort(); asks.delete(m.askId); break;
        default: send({ type: 'error', askId: null, message: `Unknown message type ${(m as { type: string }).type}`, retryable: false });
      }
    });
  }

  private async onSyncPdf(m: Extract<ClientMessage, { type: 'sync_pdf' }>, send: (m: ServerMessage) => void) {
    try {
      if (!this.pendingSync.has(m.docId)) {
        let resolve!: (p: Paper | null) => void;
        this.pendingSync.set(m.docId, new Promise<Paper | null>((r) => { resolve = r; }));
        this.pendingResolve.set(m.docId, resolve);
      }
      let paper = await this.papers.get(m.sha256);
      if (!paper) {
        if (!m.bytes) { send({ type: 'need_pdf', docId: m.docId, sha256: m.sha256 }); return; }
        const t0 = Date.now();
        paper = await this.papers.put(m.sha256, Buffer.from(m.bytes, 'base64'));
        console.log(`[paper] stored ${m.sha256.slice(0, 12)} (${paper.pageCount} pages, ${Math.round(paper.bytes / 1024)} KB, text ${paper.pages.join('').length} chars) in ${Date.now() - t0} ms`);
      }
      const prev = this.state.get(m.docId);
      this.state.update(m.docId, { sha256: m.sha256, pdfReattach: prev.sha256 !== m.sha256 ? true : prev.pdfReattach });
      this.pendingResolve.get(m.docId)?.(paper);
      this.pendingResolve.delete(m.docId);
      send({ type: 'pdf_ready', docId: m.docId, sha256: m.sha256, pageCount: paper.pageCount, textChars: paper.pages.join('').length });
    } catch (e) {
      this.pendingResolve.get(m.docId)?.(null);
      this.pendingResolve.delete(m.docId);
      this.pendingSync.delete(m.docId);
      send({ type: 'error', askId: null, message: `PDF sync failed: ${(e as Error).message}`, retryable: true });
    }
  }

  /** The paper for a document: wait for a sync in flight, else use the stored mapping, else none. */
  private async paperFor(docId: string): Promise<Paper | null> {
    const pending = this.pendingSync.get(docId);
    if (pending) {
      const timeout = new Promise<Paper | null>((r) => setTimeout(() => r(null), PAPER_WAIT_MS));
      const p = await Promise.race([pending, timeout]);
      if (p) return p;
    }
    const sha = this.state.get(docId).sha256;
    return sha ? this.papers.get(sha) : null;
  }

  private async onAsk(m: AskRequest, send: (m: ServerMessage) => void, asks: Map<string, AbortController>) {
    const ac = new AbortController();
    asks.set(m.askId, ac);
    const t0 = Date.now();
    try {
      send({ type: 'status', askId: m.askId, text: 'Reading the page…' });
      const pages = m.capture.map((c) => c.pageNumber);
      const description = this.cfg.mock
        ? mockDescribe(m.capture, m.imageSize, m.visibleText)
        : await describeScreen({ image: m.image, pages, pageCount: m.pageCount, visibleText: m.visibleText }, this.cfg, ac.signal);
      if (ac.signal.aborted) return;
      console.log(`[ask ${m.askId.slice(0, 8)}] described in ${Date.now() - t0} ms: ${description.handwriting.length} handwriting item(s), pages ${pages.join(',')}`);
      send({ type: 'described', askId: m.askId, description });
      await this.answer(m.askId, m.docId, m.docTitle, m.pageCount, description, m.visibleText, m.sessionId ?? null, ac, send);
    } catch (e) {
      if (ac.signal.aborted) return;
      console.warn(`[ask ${m.askId.slice(0, 8)}] failed:`, (e as Error).message);
      send({ type: 'error', askId: m.askId, message: (e as Error).message, retryable: true });
    } finally { asks.delete(m.askId); }
  }

  private async onAskText(m: Extract<ClientMessage, { type: 'ask_text' }>, send: (m: ServerMessage) => void, asks: Map<string, AbortController>) {
    const ac = new AbortController();
    asks.set(m.askId, ac);
    try {
      send({ type: 'described', askId: m.askId, description: m.description });
      await this.answer(m.askId, m.docId, m.docTitle, m.pageCount, m.description, m.visibleText, m.sessionId ?? null, ac, send);
    } catch (e) {
      if (ac.signal.aborted) return;
      send({ type: 'error', askId: m.askId, message: (e as Error).message, retryable: true });
    } finally { asks.delete(m.askId); }
  }

  private answer(askId: string, docId: string, docTitle: string, pageCount: number, description: ScreenDescription, visibleText: Array<{ pageNumber: number; text: string }>, sessionId: string | null, ac: AbortController, send: (m: ServerMessage) => void): Promise<void> {
    const prev = this.docQueue.get(docId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.answerNow(askId, docId, docTitle, pageCount, description, visibleText, sessionId, ac, send));
    this.docQueue.set(docId, run);
    return run;
  }

  private async answerNow(askId: string, docId: string, docTitle: string, pageCount: number, description: ScreenDescription, visibleText: Array<{ pageNumber: number; text: string }>, sessionId: string | null, ac: AbortController, send: (m: ServerMessage) => void): Promise<void> {
    if (ac.signal.aborted) return;
    send({ type: 'status', askId, text: 'Thinking…' });
    const screenText = formatScreen(description, pageCount, visibleText);
    const t0 = Date.now();
    if (this.cfg.mock) {
      let n = 0;
      for await (const chunk of mockAnswerChunks(ac.signal)) { send({ type: 'answer_delta', askId, text: chunk }); n += chunk.length; }
      if (ac.signal.aborted) return;
      send({ type: 'answer_done', askId, sessionId: sessionId ?? `mock-session-${docId}`, usage: { inputTokens: 1200, outputTokens: Math.ceil(n / 4), cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.0123 });
      return;
    }
    const paper = await this.paperFor(docId);
    const st = this.state.get(docId);
    const fresh = !sessionId;
    const attach = !!paper && (fresh || st.pdfReattach) && paper.pageCount <= this.cfg.maxPdfPagesAttached && paper.bytes <= this.cfg.maxPdfBytesAttached;
    const pdfBase64 = attach && paper ? this.papers.readPdfBase64(paper.sha256) : null;
    let compacted = false;
    let chars = 0;
    const res = await runAgentTurn(
      { docId, docTitle, sessionId, screenText, paper, pdfBase64, signal: ac.signal },
      this.cfg,
      {
        onDelta: (text) => { chars += text.length; send({ type: 'answer_delta', askId, text }); },
        onStatus: (text) => send({ type: 'status', askId, text }),
        onCompaction: () => { compacted = true; },
      },
    );
    if (ac.signal.aborted) return;
    // After a successful attachment the PDF is in context until the next compaction.
    this.state.update(docId, { pdfReattach: compacted ? true : attach ? false : st.pdfReattach, sessionIds: Array.from(new Set([...st.sessionIds, res.sessionId])) });
    console.log(`[ask ${askId.slice(0, 8)}] answered ${chars} chars in ${Date.now() - t0} ms (paper ${paper ? `${paper.pageCount}p` : 'none'}, pdf ${attach ? 'attached' : 'cached'}, $${res.costUsd.toFixed(4)})`);
    send({ type: 'answer_done', askId, sessionId: res.sessionId, usage: res.usage, costUsd: res.costUsd });
  }
}
