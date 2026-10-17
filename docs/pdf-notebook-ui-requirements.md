# PDF Notebook — UI Requirements (Web App, v0)

A Notability-style web app for reading and handwriting on research-paper PDFs with an Apple Pencil. This document covers the **UI and annotation layer only**. The AI assistant is **out of scope** for this build, but the architecture must make it easy to add later (see §12).

Priorities: **MUST** = required for v0 · **SHOULD** = expected unless it blocks v0 · **COULD** = nice to have.

---

## 1. Target platforms

| ID | Requirement | Priority |
|---|---|---|
| P-1 | Primary target: **iPad Safari (iPadOS 17+) with Apple Pencil**, landscape and portrait. | MUST |
| P-2 | Secondary target: desktop Chrome / Safari / Firefox with mouse or trackpad (and pen tablets via Pointer Events). | MUST |
| P-3 | Installable as a PWA ("Add to Home Screen") so it runs full-screen on iPad without Safari chrome. | SHOULD |
| P-4 | Works offline after first load (service worker caches the app shell; documents live locally). | COULD |

## 2. Suggested stack (builder may deviate with justification)

- TypeScript + React + Vite
- **pdf.js** (`pdfjs-dist`) for PDF rendering and the text layer
- **perfect-freehand** (or equivalent) for pressure-sensitive stroke outlines
- **IndexedDB** (e.g. via `idb` or Dexie) for local storage
- **pdf-lib** for exporting annotated PDFs
- No backend required for v0

## 3. Document library

| ID | Requirement | Priority |
|---|---|---|
| L-1 | Import a PDF via file picker. On desktop, drag-and-drop onto the library also works. | MUST |
| L-2 | Library view listing documents with a first-page thumbnail, title, and last-opened date. | MUST |
| L-3 | Rename and delete documents (delete asks for confirmation). | MUST |
| L-4 | Create a blank notebook (no PDF, just blank pages). | SHOULD |
| L-5 | Search documents by title. | COULD |
| L-6 | Folders or tags. | COULD |

## 4. Document viewer

| ID | Requirement | Priority |
|---|---|---|
| V-1 | Pages laid out in a **vertical, continuously scrolling stack**, centred, with a small gap between pages (Notability style). | MUST |
| V-2 | Pages rendered crisply at the current zoom × `devicePixelRatio`. Re-render at higher resolution after zoom settles. | MUST |
| V-3 | **Virtualised rendering**: only pages in or near the viewport are rendered. Off-screen page bitmaps are released so 200-page PDFs don't exhaust iPad memory. | MUST |
| V-4 | Zoom with two-finger pinch (iPad) and Ctrl/⌘ + scroll or trackpad pinch (desktop). Zoom range 50%–400%. Also provide "fit width" and "fit page" buttons. | MUST |
| V-5 | Scroll with one finger (iPad) or wheel/trackpad (desktop), with momentum. Scrolling must never draw ink. | MUST |
| V-6 | Page indicator ("4 / 32") and jump-to-page. | MUST |
| V-7 | Collapsible page-thumbnail sidebar; tapping a thumbnail jumps to that page. | SHOULD |
| V-8 | Insert a blank page after any page, and delete inserted blank pages (original PDF pages can't be deleted). | SHOULD |
| V-9 | Render the pdf.js **text layer** (invisible but present) so the PDF text and its positions are available to code. Users don't need to select text in v0. | SHOULD |
| V-10 | Handle rotated PDF pages and mixed page sizes correctly. | MUST |
| V-11 | Remember scroll position and zoom per document across sessions. | SHOULD |
| V-12 | Clickable internal PDF links (e.g. to equations, references, sections). | COULD |

## 5. Pencil and input handling

These requirements are critical: they decide whether the app feels like Notability or like a web page.

| ID | Requirement | Priority |
|---|---|---|
| I-1 | Use **Pointer Events**. Distinguish `pointerType` `pen` / `touch` / `mouse`. | MUST |
| I-2 | Default iPad mode: **Pencil draws, fingers scroll and zoom.** Ignore touches while a pen stroke is active (palm rejection). | MUST |
| I-3 | A "Draw with finger" toggle for users without a Pencil. When on, one finger draws and two fingers scroll/zoom. | SHOULD |
| I-4 | Desktop: mouse/trackpad drags draw when a drawing tool is selected; space + drag, or the Hand tool, pans. | MUST |
| I-5 | Suppress Safari behaviours on the drawing surface: `touch-action: none` on ink layers, no text-selection loupe or callout (`-webkit-user-select: none`, `-webkit-touch-callout: none`), no double-tap zoom, no page bounce while drawing, no iPadOS Scribble converting ink into text. | MUST |
| I-6 | Use `getCoalescedEvents()` where available for smooth, high-sample-rate strokes. Use `getPredictedEvents()` where available to reduce perceived latency. | SHOULD |
| I-7 | **Ink latency**: the live stroke follows the Pencil tip with no visible lag (target < 1–2 frames on a recent iPad). Draw the in-progress stroke on a dedicated overlay canvas, not by re-rendering the page. | MUST |
| I-8 | Pressure sensitivity: stroke width varies with `pressure`. Fall back to a constant width when pressure is unavailable (mouse). | MUST |
| I-9 | Apple Pencil hover preview (cursor dot) on supported iPads. | COULD |

## 6. Annotation tools

| ID | Requirement | Priority |
|---|---|---|
| T-1 | **Pen**: pressure-sensitive smooth ink, ≥ 8 preset colours plus a custom colour picker, 3–5 preset widths. | MUST |
| T-2 | **Highlighter**: semi-transparent, wide, flat tip. Overlapping highlight strokes don't darken each other (use a multiply blend or a per-stroke-group alpha). Drawn *under* pen ink. | MUST |
| T-3 | **Eraser**, with two modes: *stroke eraser* (removes whole strokes it touches) is MUST; *partial eraser* (splits strokes) is SHOULD. | MUST / SHOULD |
| T-4 | **Lasso select**: draw a freeform loop to select strokes (and text boxes). Selected items can be moved, deleted, recoloured, duplicated, copied and pasted (including across pages), and resized. | MUST |
| T-5 | **Text box**: tap to place typed text. Movable and resizable, with font size and colour. | SHOULD |
| T-6 | Math in text boxes: inline LaTeX between `$…$`, rendered with KaTeX. | COULD |
| T-7 | **Shape snapping**: hold the pen still at the end of a stroke to snap it to a straight line, rectangle, ellipse or arrow. | COULD |
| T-8 | **Undo / redo** for every annotation action, per document, at least 100 steps. Toolbar buttons plus ⌘Z / ⇧⌘Z; two-finger tap = undo and three-finger tap = redo on iPad is COULD. | MUST |
| T-9 | Recently used colours/widths remembered per tool. | SHOULD |
| T-10 | Insert an image (from the file picker) onto a page as a movable object. | COULD |

## 7. Toolbar and layout

| ID | Requirement | Priority |
|---|---|---|
| U-1 | Top toolbar: back to library, document title, tool buttons (pen, highlighter, eraser, lasso, text, hand), colour/width picker for the active tool, undo/redo, page thumbnails toggle, export. | MUST |
| U-2 | Active tool clearly indicated. Tool settings open in a small popover, not a modal. | MUST |
| U-3 | Touch targets ≥ 44×44 pt. | MUST |
| U-4 | The toolbar never covers page content when scrolled to the top; the layout adapts to portrait and landscape. | MUST |
| U-5 | Light theme required; dark theme (UI chrome only, PDF pages stay white) is COULD. | MUST / COULD |
| U-6 | Keyboard shortcuts on desktop/iPad keyboards: P pen, H highlighter, E eraser, L lasso, T text, space-drag pan. | SHOULD |

## 8. Data model

Annotations are stored as **vector data in page coordinates**, never as screen pixels and never flattened into the PDF while editing.

```ts
type DocumentRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pdfBlobId: string | null;         // null for blank notebooks
  pages: PageRecord[];               // display order
  viewState?: { pageIndex: number; offsetY: number; zoom: number };
};

type PageRecord = {
  id: string;                        // stable; never reuse indices as ids
  kind: "pdf" | "blank";
  pdfPageNumber?: number;            // 1-based, for kind === "pdf"
  width: number;                     // in PDF points (1/72 in), after rotation
  height: number;
};

type Stroke = {
  id: string;
  pageId: string;
  tool: "pen" | "highlighter";
  color: string;                     // #RRGGBB
  opacity: number;
  baseWidth: number;                 // in PDF points
  points: { x: number; y: number; p: number; t: number }[]; // x,y in PDF points, origin top-left
  createdAt: number;
};

type TextBox = {
  id: string; pageId: string;
  x: number; y: number; width: number; height: number; // PDF points
  text: string; fontSize: number; color: string;
};
```

| ID | Requirement | Priority |
|---|---|---|
| D-1 | All annotation coordinates are in **PDF points relative to the page's top-left corner**, so they stay correct at any zoom and on any device. | MUST |
| D-2 | Every annotation belongs to exactly one page (`pageId`). Strokes don't cross pages: a stroke started on page N is clipped to or stays on page N. | MUST |
| D-3 | The original PDF bytes are stored unchanged. | MUST |

## 9. Persistence and export

| ID | Requirement | Priority |
|---|---|---|
| S-1 | Autosave to IndexedDB, debounced (≤ 1 s after the last change), plus on `visibilitychange` / `pagehide`. No manual save button. | MUST |
| S-2 | Reloading the page or reopening the app restores all documents, annotations and view state. | MUST |
| S-3 | Request persistent storage (`navigator.storage.persist()`) and show a warning if storage is nearly full. | SHOULD |
| S-4 | **Export annotated PDF**: flatten ink/highlights/text into a copy of the PDF (pdf-lib), keeping vector quality. | SHOULD |
| S-5 | Export / import a document bundle (`.zip` with the original PDF + annotations JSON) for backup or moving between devices. | SHOULD |
| S-6 | Export the current page as PNG. | COULD |

## 10. Performance

| ID | Requirement | Priority |
|---|---|---|
| F-1 | Opening a 50-page paper shows page 1 in < 1.5 s on a recent iPad. | MUST |
| F-2 | Scrolling and zooming at ~60 fps with annotations on the visible pages. | MUST |
| F-3 | Handles 200+ page PDFs and ~5,000 strokes per document without crashes or noticeable slowdown. | MUST |
| F-4 | Finished strokes are cached per page (e.g. one ink canvas per page, redrawn only when that page's strokes change), not redrawn every frame. | MUST |
| F-5 | PDF rendering runs in the pdf.js worker; the main thread stays responsive while pages render. | MUST |

## 11. Accessibility and quality

| ID | Requirement | Priority |
|---|---|---|
| Q-1 | All toolbar controls have accessible labels and are keyboard-reachable. | SHOULD |
| Q-2 | Colour contrast of UI chrome meets WCAG AA. | SHOULD |
| Q-3 | Unit tests for coordinate transforms (screen ↔ page, with zoom, scroll and rotation) and the undo/redo stack. | MUST |
| Q-4 | End-to-end tests (e.g. Playwright) for import → draw → reload → strokes still present, using synthetic pen events. | SHOULD |

## 12. Hooks for the future AI feature — design for, do not build

The AI assistant will be added later. Don't build any AI or network features now, but structure the code so these are straightforward:

| ID | Requirement | Priority |
|---|---|---|
| X-1 | A function to render **any page with its annotations** to a PNG at a given scale: `renderPageImage(pageId, scale): Promise<Blob>`. | SHOULD |
| X-2 | A function to render a **cropped region of a page** with annotations: `renderRegionImage(pageId, rect, scale): Promise<Blob>`. | SHOULD |
| X-3 | The lasso selection exposes `{ pageId, boundingRect (PDF points), strokeIds, textBoxIds }` through a single app-level event or store, so a future "Ask" action can attach to it. | SHOULD |
| X-4 | A generic **page-anchored overlay object** (positioned in page coordinates, moves and zooms with the page, collapsible) that can later hold answer cards. A text box implementation that generalises to this is fine. | SHOULD |
| X-5 | Access to the original PDF bytes and the pdf.js text content (with positions) per page via a small API module. | SHOULD |
| X-6 | Keep app state in a well-defined store (e.g. Zustand/Redux) rather than inside components, so another module can read the document, selection and view state. | SHOULD |

## 13. Out of scope for v0

- Any AI / LLM features, chat, or network calls besides loading the app
- User accounts, cloud sync, collaboration or sharing
- Audio recording (Notability-style)
- OCR or handwriting recognition
- Editing the PDF's own content

## 14. Definition of done (acceptance checklist)

On an iPad with Apple Pencil in Safari (or installed as a PWA):

1. Import a 30+ page research PDF; it appears in the library with a thumbnail.
2. Open it; scroll with a finger and pinch-zoom smoothly; pages stay sharp after zooming.
3. Write with the Pencil: no lag, pressure-sensitive; resting a palm on the screen doesn't draw or scroll.
4. Highlight a line of an equation; erase a stroke; lasso some handwriting and move it; undo and redo each step.
5. Add a blank page after page 3 and write on it.
6. Close the tab, reopen the app: everything is exactly where it was, including the scroll position.
7. Export the annotated PDF and open it in another viewer: annotations appear in the right positions.
8. Repeat steps 1–4 on desktop Chrome with a mouse.
