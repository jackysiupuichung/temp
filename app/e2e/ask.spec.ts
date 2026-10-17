import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Ask against the mocked agent server (agent design §9 step 5):
 * write → Ask → card placed near the ink → text streamed with maths → undo removes the card.
 */
const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));
const MOCK_URL = 'ws://127.0.0.1:8791';
const MOCK_TOKEN = 'e2e-token';

type Store = { getState(): Record<string, any> };
type NB = { store: Store; agent: Store; ask: { ask(): Promise<string> } };
const nb = (page: Page) => page.evaluate(() => (window as unknown as { __notebook: NB }).__notebook as never) as unknown as NB; // typing helper only

async function penStroke(page: Page, points: [number, number][], pressure = 0.6) {
  const cdp = await page.context().newCDPSession(page);
  const [x0, y0] = points[0];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, pointerType: 'pen', force: pressure });
  for (const [x, y] of points.slice(1)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', pointerType: 'pen', force: pressure });
  const [xl, yl] = points[points.length - 1];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xl, y: yl, button: 'left', clickCount: 1, pointerType: 'pen', force: 0 });
  await cdp.detach();
}

const answerCards = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __notebook: NB }).__notebook.store.getState();
  return (Object.values(s.textBoxesByPage as Record<string, Array<{ kind?: string; text: string; pageId: string; x: number; y: number; width: number; height: number; answer?: { status: string; anchorRect: { x: number; y: number; width: number; height: number } } }>>).flat()).filter((t) => t.kind === 'answer');
});

test('write → Ask → one card placed near the ink, answer streamed, undo removes it', async ({ page }) => {
  void nb;
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import PDF' }).click();
  await (await chooser).setFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixture) });
  const card = page.getByRole('button', { name: 'Open sample' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const firstPage = page.locator('.page[data-page-index="0"]');
  await expect(firstPage.locator('.pending')).toHaveCount(0, { timeout: 20_000 });

  // pair with the mock server
  await page.evaluate(({ url, token }) => (window as unknown as { __notebook: NB }).__notebook.agent.getState().saveSettings({ url, token }), { url: MOCK_URL, token: MOCK_TOKEN });

  // handwriting in the middle of page 1 (where the mock interpreter reports it)
  const box = (await firstPage.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 300);
  await penStroke(page, Array.from({ length: 20 }, (_, i) => [cx - 50 + i * 5, cy + Math.sin(i / 2) * 8] as [number, number]));
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as { __notebook: NB }).__notebook.store.getState().strokesByPage as Record<string, unknown[]>).flat().length)).toBe(1);

  await page.getByTestId('ask-btn').click(); // the "Reading the page…" indicator is too brief to assert against the mock

  // exactly one card, on page 1, not covering the ink, anchored to it
  await expect.poll(async () => (await answerCards(page)).length, { timeout: 15_000 }).toBe(1);
  const [c] = await answerCards(page);
  expect(c.pageId).toBe((await page.evaluate(() => (window as unknown as { __notebook: NB }).__notebook.store.getState().doc.pages[0].id)));
  const stroke = await page.evaluate(() => Object.values((window as unknown as { __notebook: NB }).__notebook.store.getState().strokesByPage as Record<string, Array<{ points: { x: number; y: number }[] }>>).flat()[0]);
  const xs = stroke.points.map((p) => p.x), ys = stroke.points.map((p) => p.y);
  const ink = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  expect(c.answer!.anchorRect.y).toBeLessThanOrEqual(ink.y + 2);
  expect(c.answer!.anchorRect.y + c.answer!.anchorRect.height).toBeGreaterThanOrEqual(ink.y + ink.height - 2);
  const overlaps = c.x < ink.x + ink.width && c.x + c.width > ink.x && c.y < ink.y + ink.height && c.y + c.height > ink.y;
  expect(overlaps).toBe(false);

  // the answer streams in and renders maths
  const cardEl = page.locator('.answer-card');
  await expect(cardEl).toBeVisible();
  await expect(cardEl.locator('.answer-summary')).toContainText('Read:');
  await expect.poll(async () => (await answerCards(page))[0]?.answer?.status, { timeout: 20_000 }).toBe('done');
  await expect(cardEl.locator('.katex').first()).toBeVisible();
  await expect(cardEl.locator('.katex-display')).toHaveCount(1);
  expect((await answerCards(page))[0].text).toContain('\\sqrt{d_k}');
  await expect(page.getByTestId('ask-indicator')).toHaveCount(0);

  // the session id was stored on the document
  expect(await page.evaluate(() => (window as unknown as { __notebook: NB }).__notebook.store.getState().doc.agentSessionId)).toBe('mock-session-' + (await page.evaluate(() => (window as unknown as { __notebook: NB }).__notebook.store.getState().doc.id)));

  // undo removes the card in one step (streaming did not flood the stack)
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await answerCards(page)).length).toBe(0);
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(async () => (await answerCards(page)).length).toBe(1);
  expect((await answerCards(page))[0].text).toContain('\\sqrt{d_k}');

  // survives a reload
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.answer-card')).toBeVisible({ timeout: 20_000 });
});

test('a wrong pairing token shows an error with Retry and Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Blank notebook' }).click();
  await page.getByRole('button', { name: /Open Untitled notebook/ }).first().click();
  await expect(page.locator('.page[data-page-index="0"]')).toBeVisible();
  await page.evaluate(({ url }) => (window as unknown as { __notebook: NB }).__notebook.agent.getState().saveSettings({ url, token: 'nope' }), { url: MOCK_URL });
  await page.getByTestId('ask-btn').click();
  const ind = page.getByTestId('ask-indicator');
  await expect(ind).toContainText(/rejected|closed|reach/i, { timeout: 10_000 });
  await expect(ind.getByRole('button', { name: 'Retry' })).toBeVisible();
  await ind.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Assistant server' })).toBeVisible();
  await expect(page.getByTestId('agent-status')).toContainText('error');
  expect(await answerCards(page)).toHaveLength(0);
});
