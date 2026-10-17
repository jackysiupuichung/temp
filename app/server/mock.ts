/** Mock backends for development and e2e tests (agent design §9 step 5): no network, deterministic output. */
import type { ScreenDescription } from '../src/agent/protocol';
import type { CaptureMap } from '../src/agent/protocol';

export function mockDescribe(capture: CaptureMap[], imageSize: { width: number; height: number }, visibleText: Array<{ pageNumber: number; text: string }>): ScreenDescription {
  const pages = capture.map((c) => c.pageNumber);
  const first = capture[0];
  const handwriting: ScreenDescription['handwriting'] = [];
  if (first && imageSize.width > 0 && imageSize.height > 0) {
    // One item in the middle of the first captured region: placement snaps it to any ink nearby.
    const r = first.imageRect;
    const cx = (r.x + r.width / 2) / imageSize.width * 1000, cy = (r.y + r.height / 2) / imageSize.height * 1000;
    handwriting.push({ text: 'why $\\sqrt{d_k}$?', box: { x0: cx - 80, y0: cy - 25, x1: cx + 80, y1: cy + 25 }, page: first.pageNumber, near: 'Eq. (1)' });
  }
  return {
    location: { pages, section: '3.2 Scaled Dot-Product Attention', summary: `Mock description of pages ${pages.join(', ')}.` },
    printedItems: visibleText.slice(0, 2).map((v) => ({ kind: 'paragraph' as const, label: null, page: v.pageNumber, text: v.text.slice(0, 120) })),
    handwriting,
    unreadable: null,
  };
}

export const MOCK_ANSWER = `**"why $\\sqrt{d_k}$?"**

The dot products $q \\cdot k$ grow with the dimension: for independent components with unit variance their variance is $d_k$ (p. 4). Dividing by $\\sqrt{d_k}$ keeps the logits at unit scale, so the softmax

$$\\mathrm{Attention}(Q,K,V) = \\mathrm{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V$$

does not saturate into regions with vanishing gradients.

**Background:** this is the standard variance argument; the paper states it in §3.2.1 (p. 4).`;

/** Stream the mock answer in small chunks. */
export async function* mockAnswerChunks(signal: AbortSignal, delayMs = 25): AsyncGenerator<string> {
  const words = MOCK_ANSWER.split(/(?<=\s)/);
  for (const w of words) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, delayMs));
    yield w;
  }
}
