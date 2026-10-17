import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

/** Dispatch a synthetic Apple-Pencil-like stroke through CDP so the app sees real `pointerType: "pen"` events. */
async function penStroke(page: Page, points: [number, number][], pressure = 0.6) {
  const cdp = await page.context().newCDPSession(page);
  const [x0, y0] = points[0];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, pointerType: 'pen', force: pressure });
  for (const [x, y] of points.slice(1)) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', pointerType: 'pen', force: pressure });
  }
  const [xl, yl] = points[points.length - 1];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xl, y: yl, button: 'left', clickCount: 1, pointerType: 'pen', force: 0 });
  await cdp.detach();
}

const strokeCount = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __notebook: { store: { getState(): { strokesByPage: Record<string, unknown[]> } } } }).__notebook.store.getState();
  return Object.values(s.strokesByPage).flat().length;
});

test('import → draw with pen → reload → strokes still present', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PDF Notebook' })).toBeVisible();

  // L-1: import via the file picker
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import PDF' }).click();
  await (await chooser).setFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixture) });
  const card = page.getByRole('button', { name: 'Open sample' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('40 pages')).toBeVisible();
  await expect(card.locator('img')).toBeVisible(); // thumbnail

  // open and wait for page 1 to render
  await card.click();
  const firstPage = page.locator('.page[data-page-index="0"]');
  await expect(firstPage).toBeVisible();
  await expect(firstPage.locator('.pending')).toHaveCount(0, { timeout: 20_000 });

  // draw with the pen tool
  const box = (await firstPage.boundingBox())!;
  const pts: [number, number][] = Array.from({ length: 25 }, (_, i) => [box.x + 80 + i * 10, box.y + 200 + Math.sin(i / 3) * 20]);
  await penStroke(page, pts);
  await expect.poll(() => strokeCount(page)).toBe(1);

  // highlight
  await page.keyboard.press('h');
  await penStroke(page, [[box.x + 80, box.y + 150], [box.x + 300, box.y + 150]]);
  await expect.poll(() => strokeCount(page)).toBe(2);

  // undo / redo
  await page.keyboard.press('Meta+z');
  await expect.poll(() => strokeCount(page)).toBe(1);
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(() => strokeCount(page)).toBe(2);

  // erase the pen stroke
  await page.keyboard.press('e');
  await penStroke(page, [[box.x + 150, box.y + 190], [box.x + 150, box.y + 240]]);
  await expect.poll(() => strokeCount(page)).toBe(1);

  // lasso the highlight and move it
  await page.keyboard.press('l');
  const loop: [number, number][] = Array.from({ length: 30 }, (_, i) => { const a = (i / 30) * Math.PI * 2; return [box.x + 190 + 150 * Math.cos(a), box.y + 150 + 40 * Math.sin(a)]; });
  await penStroke(page, loop);
  const selBox = page.locator('.selection-box');
  await expect(selBox).toBeVisible();
  const sb = (await selBox.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 40, sb.y + sb.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  const sb2 = (await selBox.boundingBox())!;
  expect(sb2.y).toBeGreaterThan(sb.y + 30);

  // insert a blank page after page 1 and draw on it
  await firstPage.getByRole('button', { name: 'Insert blank page after this page' }).click();
  // pages are virtualised, so scroll the new page into view first
  await page.evaluate(() => (window as unknown as { __notebook: { store: { getState(): { requestJumpToPage(i: number): void } } } }).__notebook.store.getState().requestJumpToPage(1));
  const blank = page.locator('.page.blank[data-page-index="1"]');
  await expect(blank).toBeVisible();
  await page.keyboard.press('p');
  const bb = (await blank.boundingBox())!;
  await penStroke(page, [[bb.x + 50, bb.y + 50], [bb.x + 150, bb.y + 80], [bb.x + 250, bb.y + 60]]);
  await expect.poll(() => strokeCount(page)).toBe(2);

  // S-1/S-2: autosave is debounced; wait then reload
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.page[data-page-index="0"]')).toBeVisible();
  await expect.poll(() => strokeCount(page)).toBe(2);
  await expect(page.getByRole('button', { name: /Page 2 of 41/ })).toBeVisible(); // V-11: scroll position restored to the page we were on
});

test('a finished text box can be edited again (text tool click, lasso double-click)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Blank notebook' }).click();
  await page.getByRole('button', { name: /Open Untitled notebook/ }).first().click();
  const pg = page.locator('.page[data-page-index="0"]');
  await expect(pg).toBeVisible();
  const box = (await pg.boundingBox())!;

  await page.keyboard.press('t');
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.keyboard.type('hello');
  await page.keyboard.press('Escape');
  const tb = page.locator('.textbox');
  await expect(tb).toHaveText('hello');

  // single click with the text tool reopens it
  await tb.click();
  await page.keyboard.type(' world');
  await page.keyboard.press('Escape');
  await expect(tb).toHaveText('hello world');

  // double-click with the lasso switches to the text tool and edits
  await page.keyboard.press('l');
  await tb.dblclick();
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(tb).toHaveText('hello world!');
});

test('empty text boxes are removed however editing ends', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Blank notebook' }).click();
  await page.getByRole('button', { name: /Open Untitled notebook/ }).first().click();
  const pg = page.locator('.page[data-page-index="0"]');
  await expect(pg).toBeVisible();
  const box = (await pg.boundingBox())!;
  const tb = page.locator('.textbox');
  const canUndo = () => page.evaluate(() => (window as unknown as { __notebook: { store: { getState(): { canUndo: boolean } } } }).__notebook.store.getState().canUndo);

  // Esc, switching tools, and clicking elsewhere on the page all drop an untouched box, with no undo step
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 100, box.y + 100);
  await expect(page.getByRole('textbox', { name: 'Text box' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tb).toHaveCount(0);

  await page.mouse.click(box.x + 100, box.y + 100);
  await expect(tb).toHaveCount(1);
  await page.locator('[data-tool="pen"]').click();
  await expect(tb).toHaveCount(0);

  await page.keyboard.press('t');
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.mouse.click(box.x + 100, box.y + 300); // ends the first (empty) box, starts a second one
  await page.keyboard.press('Escape');
  await expect(tb).toHaveCount(0);
  expect(await canUndo()).toBe(false);

  // a box that had text and was cleared is deleted; one undo brings the text back
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.keyboard.type('keep me');
  await page.keyboard.press('Escape');
  await expect(tb).toHaveText('keep me');
  await tb.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.locator('[data-tool="lasso"]').click();
  await expect(tb).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(tb).toHaveText('keep me');
  await page.keyboard.press('Meta+z'); // and one more removes the original "Add text"
  await expect(tb).toHaveCount(0);
});
