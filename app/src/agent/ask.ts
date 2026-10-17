/**
 * The Ask flow (agent design §3–§7): capture → sync the paper → vision
 * description → place one card → stream the answer into it. Also retry,
 * cancel, edit-and-re-ask and "New conversation".
 */
import { useEditorStore } from '../store/editorStore';
import { newId, type DocumentRecord, type ScreenDescription, type TextBox } from '../model/types';
import { getOriginalPdfBytes } from '../api/notebookApi';
import { captureViewport, type Capture } from './capture';
import { placeAnswerCard, CARD_WIDTH, CARD_EST_HEIGHT } from './placement';
import { client, useAgentStore } from './client';
import { sha256Hex } from './sha256';
import type { AskRequest, ServerMessage } from './protocol';

const ANSWER_FONT_SIZE = 10.5;
const captures = new Map<string, Capture>(); // askId → capture, kept in memory for Retry
const cardByAsk = new Map<string, string>(); // askId → card (TextBox) id
const pdfSync = new Map<string, Promise<void>>(); // docId → sync in flight / done

function bytesToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  return btoa(s);
}

/** Make sure the server has this document's PDF (keyed by content hash, sent once). Resolves when the server reports it ready. */
export function ensurePdfSynced(doc: DocumentRecord): Promise<void> {
  const existing = pdfSync.get(doc.id);
  if (existing) return existing;
  const p = (async () => {
    if (!doc.pdfBlobId) return; // blank notebook: nothing to sync
    const bytes = await getOriginalPdfBytes(doc.id);
    if (!bytes) return;
    let sha = doc.pdfSha256;
    if (!sha) {
      sha = await sha256Hex(bytes);
      useEditorStore.getState().setPdfSha256(sha);
    }
    await client.ensureConnected();
    await new Promise<void>((resolve, reject) => {
      const off = client.onDoc(doc.id, (m: ServerMessage) => {
        if (m.type === 'need_pdf') { try { client.send({ type: 'sync_pdf', docId: doc.id, sha256: sha!, bytes: bytesToBase64(bytes), pageCount: doc.pages.length }); } catch (e) { off(); reject(e); } }
        else if (m.type === 'pdf_ready') { off(); resolve(); }
      });
      const offErr = client.onAny((m) => { if (m.type === 'error' && m.askId === null) { off(); offErr(); reject(new Error(m.message)); } });
      try { client.send({ type: 'sync_pdf', docId: doc.id, sha256: sha!, pageCount: doc.pages.length }); } catch (e) { off(); offErr(); reject(e); }
    });
  })();
  pdfSync.set(doc.id, p);
  p.catch(() => pdfSync.delete(doc.id));
  return p;
}

function summariseHandwriting(d: ScreenDescription): string {
  const items = d.handwriting.map((h) => h.text.trim()).filter(Boolean);
  if (items.length === 0) return 'Read: the page (no handwriting)';
  const shown = items.slice(0, 2).map((t) => `“${t.length > 28 ? t.slice(0, 27) + '…' : t}”`);
  const more = items.length - shown.length;
  return `Read: ${shown.join(', ')}${more > 0 ? ` +${more}` : ''}`;
}

/** Place and create the card for a description (one undo step). Returns the card id. */
function createCard(askId: string, cap: Capture, description: ScreenDescription): string {
  const st = useEditorStore.getState();
  const doc = st.doc!;
  const placement = placeAnswerCard({ pages: cap.pages, capture: cap.capture, imageSize: cap.imageSize, description, viewportMidPageId: cap.viewportMidPageId });
  const pageId = placement?.pageId ?? cap.viewportMidPageId;
  const rect = placement?.rect ?? { x: 20, y: 20, width: CARD_WIDTH, height: CARD_EST_HEIGHT };
  const tb: TextBox = {
    id: newId(), docId: doc.id, pageId, x: rect.x, y: rect.y, width: rect.width, height: 44,
    text: '', fontSize: ANSWER_FONT_SIZE, color: '#18181b', kind: 'answer', format: 'markdown',
    answer: {
      askId, description, status: 'answering', anchorRect: placement?.anchorRect ?? { x: rect.x, y: rect.y, width: 0, height: 0 },
      collapsed: false, maxHeight: placement?.maxHeight ?? CARD_EST_HEIGHT, floating: placement?.floating ?? false,
    },
  };
  // Not undoable yet: the one undo step for the card is recorded when the answer completes (see answer_done),
  // so undo removes the finished card and redo brings back its text, not an empty "Thinking…" card.
  st.putTextBoxSilently(tb);
  cardByAsk.set(askId, tb.id);
  return tb.id;
}

function findCard(id: string): TextBox | undefined {
  for (const arr of Object.values(useEditorStore.getState().textBoxesByPage)) { const t = arr.find((x) => x.id === id); if (t) return t; }
  return undefined;
}

function patchAnswer(cardId: string, patch: Partial<NonNullable<TextBox['answer']>>, text?: string) {
  const cur = findCard(cardId);
  if (!cur?.answer) return;
  useEditorStore.getState().updateTextBox(cardId, { ...(text !== undefined ? { text } : {}), answer: { ...cur.answer, ...patch } }, false);
}

/** Listen for one ask's messages and drive the card. `cardId` is set when re-using an existing card (retry / re-ask). */
function attachAskHandlers(askId: string, cap: Capture | null, existingCardId: string | null) {
  const agent = useAgentStore.getState();
  let cardId = existingCardId;
  let buffer = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!cardId || !buffer) return;
    const cur = findCard(cardId);
    if (!cur) return;
    const text = cur.text + buffer; buffer = '';
    useEditorStore.getState().updateTextBox(cardId, { text }, false);
  };
  const off = client.onAsk(askId, (m) => {
    switch (m.type) {
      case 'described': {
        if (!cardId) {
          if (!cap) break;
          cardId = createCard(askId, cap, m.description);
          cardByAsk.set(askId, cardId);
        } else patchAnswer(cardId, { askId, description: m.description, status: 'answering', error: undefined }, '');
        agent.setIndicator(null);
        break;
      }
      case 'status': {
        if (!cardId) useAgentStore.getState().setIndicator({ askId, text: m.text, canCancel: true });
        break;
      }
      case 'answer_delta': {
        if (!cardId) break;
        buffer += m.text;
        if (!raf) raf = requestAnimationFrame(flush);
        break;
      }
      case 'answer_done': {
        if (raf) cancelAnimationFrame(raf);
        flush();
        if (cardId) {
          patchAnswer(cardId, { status: 'done', costUsd: m.costUsd, error: undefined });
          if (!existingCardId) useEditorStore.getState().recordTextBox(cardId, 'Ask');
        }
        useEditorStore.getState().setAgentSession(m.sessionId);
        useAgentStore.setState({ lastCostUsd: m.costUsd, indicator: null });
        off();
        break;
      }
      case 'error': {
        if (raf) cancelAnimationFrame(raf);
        flush();
        if (cardId) patchAnswer(cardId, { status: 'error', error: m.message });
        else useAgentStore.getState().setIndicator({ askId, text: '', error: m.message, canRetry: m.retryable });
        off();
        break;
      }
      default: break;
    }
  });
  return { get cardId() { return cardId; }, off };
}

function docForAsk(): DocumentRecord {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error('No document open');
  return doc;
}

async function sendAsk(askId: string, cap: Capture, existingCardId: string | null): Promise<void> {
  const doc = docForAsk();
  const agent = useAgentStore.getState();
  agent.setIndicator({ askId, text: 'Reading the page…', canCancel: true });
  attachAskHandlers(askId, cap, existingCardId);
  try {
    await client.ensureConnected();
    void ensurePdfSynced(doc).catch((e) => console.warn('PDF sync failed', e));
    const req: AskRequest = {
      type: 'ask', askId, docId: doc.id, docTitle: doc.title, pageCount: doc.pages.length,
      image: cap.image, imageSize: cap.imageSize, capture: cap.capture, visibleText: cap.visibleText, sessionId: doc.agentSessionId ?? null,
    };
    client.send(req);
  } catch (e) {
    agent.setIndicator({ askId, text: '', error: (e as Error).message, canRetry: true });
  }
}

/** The Ask button: screenshot the viewport and start the pipeline. */
export async function ask(): Promise<string> {
  const doc = docForAsk();
  const askId = newId();
  useAgentStore.getState().setIndicator({ askId, text: 'Capturing…', canCancel: false });
  let cap: Capture;
  try { cap = await captureViewport(); } catch (e) {
    useAgentStore.getState().setIndicator({ askId, text: '', error: (e as Error).message, canRetry: false });
    throw e;
  }
  captures.set(askId, cap);
  if (useEditorStore.getState().doc?.id !== doc.id) throw new Error('Document changed');
  await sendAsk(askId, cap, null);
  return askId;
}

/** Retry with the stored capture (no new screenshot). Works from the indicator or from a card. */
export async function retryAsk(previousAskId: string): Promise<void> {
  const cap = captures.get(previousAskId);
  const cardId = cardByAsk.get(previousAskId) ?? null;
  if (!cap) {
    // capture gone (reload): if there is a card, re-ask from its description instead
    const card = cardId ? findCard(cardId) : undefined;
    if (card?.answer) return reAsk(cardId!, card.answer.description);
    await ask();
    return;
  }
  const askId = newId();
  captures.set(askId, cap);
  if (cardId) { cardByAsk.set(askId, cardId); patchAnswer(cardId, { askId, status: 'answering', error: undefined }, ''); }
  await sendAsk(askId, cap, cardId);
}

/** Edit-and-re-ask: send a corrected description straight to the main agent, replacing the card's content. */
export async function reAsk(cardId: string, description: ScreenDescription): Promise<void> {
  const doc = docForAsk();
  const card = findCard(cardId);
  if (!card?.answer) return;
  const askId = newId();
  const old = captures.get(card.answer.askId);
  if (old) captures.set(askId, old);
  cardByAsk.set(askId, cardId);
  patchAnswer(cardId, { askId, description, status: 'answering', error: undefined }, '');
  attachAskHandlers(askId, old ?? null, cardId);
  try {
    await client.ensureConnected();
    void ensurePdfSynced(doc).catch(() => {});
    client.send({ type: 'ask_text', askId, docId: doc.id, docTitle: doc.title, pageCount: doc.pages.length, description, visibleText: old?.visibleText ?? [], sessionId: doc.agentSessionId ?? null });
  } catch (e) {
    patchAnswer(cardId, { status: 'error', error: (e as Error).message });
  }
}

/** Abort the turn and remove the card (or the indicator). */
export function cancelAsk(askId: string): void {
  try { client.send({ type: 'cancel', askId }); } catch { /* not connected */ }
  const cardId = cardByAsk.get(askId);
  const card = cardId ? findCard(cardId) : undefined;
  if (card) {
    const st = useEditorStore.getState();
    if (card.answer?.status === 'answering' && card.text === '') st.applyAction({ label: 'Cancel ask', forward: [{ kind: 'deleteTextBoxes', ids: [card.id], pageIds: [card.pageId] }], backward: [{ kind: 'putTextBoxes', items: [card] }] });
    else st.deleteTextBox(card.id);
  }
  const ind = useAgentStore.getState().indicator;
  if (ind?.askId === askId) useAgentStore.getState().setIndicator(null);
}

/** "New conversation": the next Ask starts a fresh agent session for this document. */
export function newConversation(): void {
  useEditorStore.getState().setAgentSession(null);
  useAgentStore.setState({ lastCostUsd: null });
}

export const askApi = { ask, retryAsk, reAsk, cancelAsk, newConversation, ensurePdfSynced, summariseHandwriting };
export { summariseHandwriting };
