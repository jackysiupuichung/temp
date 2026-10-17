/**
 * WebSocket protocol between the PWA and the agent server (agent design §8).
 * Shared by the client (src/agent) and the server (server/).
 */
import type { ScreenDescription } from '../model/types';

export type { ScreenDescription };

/** One captured page region: where it is on the page and where it landed in the composite image (§3.1). */
export type CaptureMap = {
  pageId: string;
  pageNumber: number; // 1-based display page number
  pageRect: { x: number; y: number; width: number; height: number }; // page points
  imageRect: { x: number; y: number; width: number; height: number }; // pixels in the composite image
};

export type AskRequest = {
  type: 'ask';
  askId: string;
  docId: string;
  docTitle: string;
  pageCount: number;
  image: string; // base64 PNG of the composite capture
  imageSize: { width: number; height: number };
  capture: CaptureMap[];
  visibleText: Array<{ pageNumber: number; text: string }>;
  sessionId?: string | null;
};

export type ClientMessage =
  | { type: 'hello'; token: string; clientVersion: string }
  | { type: 'sync_pdf'; docId: string; sha256: string; bytes?: string; pageCount?: number }
  | AskRequest
  | { type: 'ask_text'; askId: string; docId: string; docTitle: string; pageCount: number; description: ScreenDescription; visibleText: Array<{ pageNumber: number; text: string }>; sessionId?: string | null }
  | { type: 'cancel'; askId: string };

export type AnswerUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type ServerMessage =
  | { type: 'hello_ok'; serverVersion: string; mock: boolean; models: { vision: string; agent: string } }
  | { type: 'need_pdf'; docId: string; sha256: string }
  | { type: 'pdf_ready'; docId: string; sha256: string; pageCount: number; textChars: number }
  | { type: 'described'; askId: string; description: ScreenDescription }
  | { type: 'status'; askId: string; text: string }
  | { type: 'answer_delta'; askId: string; text: string }
  | { type: 'answer_done'; askId: string; sessionId: string; usage: AnswerUsage; costUsd: number }
  | { type: 'error'; askId: string | null; message: string; retryable: boolean };

export const PROTOCOL_VERSION = '1';
