# PDF Notebook — Design Document

Companion to [`pdf-notebook-ui-requirements.md`](./pdf-notebook-ui-requirements.md). This document explains how the v0 web app in [`app/`](../app) is built: the architecture, the core design decisions and the reasons behind them, the data model, and the main runtime mechanisms (rendering, input, undo, persistence, export).

---

## 1. Overview

PDF Notebook is a local-only, single-page web app for reading research-paper PDFs and handwriting on them with an Apple Pencil (iPad Safari) or a mouse/trackpad (desktop). There is no backend: PDFs, annotations and settings live in the browser's IndexedDB. The app is installable as a PWA and its shell works offline.

The build has one overriding goal: **drawing must feel like a native notes app, not a web page.** Most design choices below (dedicated live-ink canvas, cached per-page ink, native finger scrolling, pdf.js worker rendering, vector data in page coordinates) follow from that goal.

### Stack

| Concern | Choice | Why |
|---|---|---|
| UI | TypeScript + React 19 + Vite | Fast iteration, type safety, trivial PWA integration via `vite-plugin-pwa`. |
| PDF rendering | `pdfjs-dist` 6 | Renders in a Web Worker so the main thread stays responsive; also provides the text layer and text positions needed later by the AI feature. |
| Ink outlines | `perfect-freehand` | Turns a pressure-annotated point list into a smooth filled outline; handles thinning, streamlining and simulated pressure for mouse input. |
| Storage | IndexedDB via `idb` | Only browser storage that comfortably holds multi-MB PDFs and thousands of stroke records; `idb` adds promises and typed schemas without a heavy ORM. |
| State | Zustand | Plain store outside React, readable by non-React modules (export, future AI). Selectors keep re-renders cheap. |
| Export | `pdf-lib` (PDF), `JSZip` (bundles) | `pdf-lib` edits the original bytes in memory and supports vector paths, opacity and blend modes. |

---

## 2. Architecture

```
src/
  model/        types.ts (data model, constants)      undo.ts (UndoStack, Action/Op)
  geometry/     transform.ts (layout, screen<->page, rotation)   strokes.ts (lasso, eraser, bounds)
  ink/          render.ts (perfect-freehand -> canvas / SVG path, highlight grouping)
  pdf/          pdf.ts (pdf.js wrapper: load/cache, render, text items, bitmap clamping)
  db/           db.ts (IndexedDB schema, batched writes, cascade delete)
  persist/      persist.ts (debounced autosave queue)
  store/        editorStore.ts (open document, strokes, selection, undo, tools, view)
                libraryStore.ts (document list, import, thumbnails, storage estimate)
  components/   Library, Editor, Toolbar, Viewer, PageView, usePageInput,
                SelectionOverlay, TextBoxView (+ PageOverlayObject), ThumbnailSidebar
  export/       pdfExport.ts, bundle.ts, download.ts
  api/          notebookApi.ts (stable entry points for a future AI module)
```

Dependency direction is strictly downward: components → store → (db, persist, pdf, geometry, ink) → model. Pure modules (`geometry/`, `model/undo.ts`) have no DOM dependency and are unit-tested in Node.

### Runtime structure

```
App (hash router: "#/doc/<id>" → Editor, else Library)
└─ Editor            keyboard shortcuts, opens/closes the document in the store
   ├─ Toolbar        tools, settings popovers, undo/redo, page indicator, zoom, export
   ├─ ThumbnailSidebar (lazy pdf.js thumbnails, jump to page, insert/delete blank pages)
   └─ Viewer         scroll container; layout, virtualisation, zoom/pinch, view-state persistence
      └─ PageView ×N (only pages near the viewport)
         ├─ <canvas.pdf>        pdf.js bitmap
         ├─ <div.textLayer>     pdf.js text layer (invisible)
         ├─ <canvas.highlights> highlighter strokes, mix-blend-mode: multiply
         ├─ <canvas.ink>        pen strokes (cached)
         ├─ SelectionOverlay    selected strokes on their own canvas + handles + mini toolbar
         ├─ <div.objects>       DOM text boxes (TextBoxView / PageOverlayObject)
         └─ <canvas.live>       in-progress stroke, lasso path, eraser cursor, Pencil hover dot
```

---

## 3. Core design decisions

### 3.1 Annotations are vector data in page coordinates

Every stroke point and text box rectangle is stored in **PDF points relative to the page's top-left corner, in the page's displayed (rotated) orientation**. Nothing is ever stored in screen pixels and nothing is flattened into the PDF while editing (D-1, D-3).

Consequences:
- Zooming only changes a scale factor at render time; stored data never changes.
- The same data renders identically on an iPad, a desktop and in the exported PDF.
- The original PDF bytes are immutable; export writes a new file.

Rotation is handled at the boundaries: pdf.js already reports rotated viewport sizes, so `PageRecord.width/height` are post-rotation. On export, `geometry/transform.ts` maps displayed coordinates back into unrotated PDF user space (see §8).

### 3.2 One store, outside React

`editorStore` holds the open document, strokes and text boxes grouped by page, the selection, the clipboard, tool state, zoom and undo/redo flags. Components subscribe with narrow selectors (`s.strokesByPage[pageId]`), so a stroke added on page 7 re-renders only page 7. Non-React code (export, `notebookApi`, tests via `window.__notebook`) reads the same store (X-6).

### 3.3 Three kinds of canvas per page

- **Finished ink is cached** (F-4). Each page has a highlight canvas and an ink canvas that are redrawn only when that page's stroke array changes (a new array reference), when the bitmap scale changes, or when the selection/erase preview changes. Scrolling never redraws ink.
- **The live stroke has its own canvas** (I-7). During a stroke only the small live canvas is cleared and redrawn once per animation frame, so latency is one frame regardless of how much ink the page already has.
- **Highlights are a separate layer with `mix-blend-mode: multiply`.** This makes highlighter ink look like it is under the printed text, and keeps pen ink (drawn on the layer above) crisp. Within the layer, highlighter strokes are first drawn opaque onto a temporary canvas and then composited once with the group alpha, so overlapping highlights do not darken each other (T-2).

### 3.4 Native finger scrolling, custom pinch zoom

Rather than reimplementing scrolling (and its momentum) in JavaScript, the viewer is an ordinary `overflow: auto` container with `touch-action: pan-x pan-y`. The trick that makes the Pencil draw instead of scroll is a non-passive `touchstart` listener that calls `preventDefault()` when the touch is a stylus (`Touch.touchType === "stylus"`), or when a pen stroke is already active (palm rejection). Pointer Events still fire for the Pencil, so drawing works while fingers keep the browser's native, momentum-driven scroll.

Two-finger pinch is detected from Touch Events (which report all active contacts even when one has been taken by native scrolling) and applied by the viewer itself; Safari's `gesturestart/gesturechange` are prevented so the whole page never zooms. On desktop, Ctrl/⌘ + wheel (which is also how trackpad pinch arrives in Chrome and Firefox) drives the same `zoomTo` function.

### 3.5 Zoom in two stages

`zoom` (CSS px per PDF point) changes continuously during a pinch or wheel gesture, re-laying out pages and resizing canvases via CSS only — the bitmaps are not touched, so the gesture stays smooth. `renderZoom` follows 220 ms after the last change and triggers re-rendering of the PDF bitmap and ink canvases at full `zoom × devicePixelRatio` resolution (V-2). Bitmap sizes are clamped (`clampBitmapScale`) so a page never exceeds ~14 M pixels, which Safari would refuse to allocate.

### 3.6 Virtualised page stack

`layoutPages` computes an absolute position for every page (centred, vertical stack, small gap) from the page records and the zoom. Only pages intersecting the viewport ± 60 % overscan are mounted (V-3). When a `PageView` unmounts it sets all its canvases to 0×0 to release GPU memory immediately, rather than waiting for garbage collection. A 200-page PDF therefore keeps about three to five pages' worth of bitmaps alive.

### 3.7 Undo is command-based and bounded

Every mutation is an `Action { forward: Op[]; backward: Op[] }`, built by the store method that performs it (draw, erase, move, paste, insert page, …). `UndoStack` (200 entries, pure, tested) just pops and re-applies op lists; it never needs to diff state. Because `backward` ops carry the full removed objects, undoing a delete is a plain `putStrokes`.

### 3.8 Autosave is a merge queue, not a snapshot

Saving the whole document on every stroke would serialise thousands of points each time. Instead the store applies each `Op` to memory and forwards it to a `Persister` that merges puts and deletes per record id. The queue flushes ≤ 600 ms after the last change, and immediately on `visibilitychange` (hidden), `pagehide` and `beforeunload`, writing one IndexedDB transaction (S-1).

---

## 4. Data model

Types live in `app/src/model/types.ts`. They follow §8 of the requirements with a few additions (marked ★).

```ts
DocumentRecord {
  id, title, createdAt, updatedAt,
  lastOpenedAt ★            // library sort order and "last opened" label
  pdfBlobId: string | null  // null for blank notebooks
  pages: PageRecord[]       // display order; blank pages can be interleaved
  viewState?: { pageIndex, offsetY, zoom }   // offsetY in PDF points from the page top
}
PageRecord { id, kind: "pdf" | "blank", pdfPageNumber?, width, height }   // size after rotation
Stroke     { id, docId ★, pageId, tool: "pen" | "highlighter", color, opacity, baseWidth,
             points: { x, y, p, t }[], createdAt }
TextBox    { id, docId ★, pageId, x, y, width, height, text, fontSize, color }
Selection  { pageId, boundingRect, strokeIds, textBoxIds }      // X-3
```

`docId` is denormalised onto strokes and text boxes so IndexedDB can load a document's annotations with one index query and delete them in one cascade.

### IndexedDB schema (`pdf-notebook`, version 1)

| Store | Key | Indexes | Contents |
|---|---|---|---|
| `documents` | `id` | `byUpdated` | `DocumentRecord` |
| `blobs` | `id` | | `{ id, blob }` — the original PDF bytes, never modified |
| `thumbnails` | `docId` | | first-page JPEG for the library |
| `strokes` | `id` | `byDoc`, `byPage` | one record per stroke |
| `textBoxes` | `id` | `byDoc`, `byPage` | one record per text box |
| `settings` | `key` | | tool settings (colours, widths, recent colours, eraser mode) |

Storing strokes individually (rather than one JSON blob per document) keeps writes proportional to the change and makes 5,000-stroke documents cheap to autosave.

### In-memory shape

The editor store keeps `strokesByPage: Record<pageId, Stroke[]>` and `textBoxesByPage`. Arrays are replaced immutably on change, so a page's `PageView` re-renders only when its own array reference changes. Strokes are kept in creation order, which is also draw order.

### Ids

All ids are UUIDs (`crypto.randomUUID()`), never indices. Page ids are stable across insertions and deletions, and bundle import remaps every id so importing the same backup twice cannot collide in the global `strokes` store.

---

## 5. Coordinate systems

There are three coordinate spaces, and `geometry/transform.ts` is the only place that converts between them.

| Space | Origin / units | Used for |
|---|---|---|
| **Page** | page top-left, PDF points, displayed orientation | all stored annotations, hit testing, selection rects |
| **Content** | top-left of the scrollable content, CSS px at current zoom | page layout (`PageLayout {x, y, width, height}`), scroll positions |
| **Client** | browser viewport, CSS px | pointer events |

Pointer → page: `(clientX − pageRect.left) / zoom`. The input hook caches the page element's bounding rect at `pointerdown`, so each of the hundreds of coalesced events in a stroke costs one subtraction and one division.

Page → PDF user space (export only): a page with `/Rotate 90` is displayed rotated clockwise, so displayed `(x, y)` corresponds to user-space `(y, x)`; 180° and 270° have analogous mappings (`displayToUserSpace`). Because `pdf-lib.drawSvgPath` applies `translate(x, y) · rotate(θ) · scale(1, −1)` to an SVG path, `svgPlacementForRotation` returns the origin and angle that make a path in page coordinates land correctly; the unit tests verify this composition algebraically against `displayToUserSpace` for all four rotations. Crop-box offsets are added on top.

Zoom keeps a focal point fixed by remembering *which page point* is under the finger/cursor, re-laying out at the new zoom, and solving for the scroll offset that puts that page point back under the same client position (`Viewer.zoomTo`). This single function serves wheel zoom, pinch (continuously, with the anchor captured at pinch start so panning and zooming combine), toolbar zoom buttons (anchored at the viewport centre) and fit-width/fit-page.

---

## 6. Rendering pipeline

1. **PDF bitmap.** `PageView` asks the cached `PDFPageProxy` to render at `clampBitmapScale(width, height, renderZoom × dpr)` into a *temporary* canvas. When the worker finishes, the result is blitted onto the visible canvas in one step, so a re-render at a new zoom never shows a blank page; the old bitmap stays until the new one is ready. Renders are cancellable and are cancelled when the page scrolls away or the scale changes again.
2. **Text layer.** pdf.js `TextLayer` renders once per page at scale 1 into an invisible `div`. pdf.js positions spans in percentages and sizes fonts with the `--total-scale-factor` CSS variable, so the layer follows zoom for free (V-9). It is `pointer-events: none`; v0 does not expose text selection.
3. **Highlights and ink** are drawn in page units through `ctx.scale(bitmapScale)`, using `perfect-freehand` outlines converted to a `Path2D` (quadratic curves through outline midpoints). Outlines are cached per stroke object in a `WeakMap`, so re-rendering a page is a sequence of `fill()` calls.
4. **Live canvas** draws the in-progress stroke every animation frame using the full point list plus up to two predicted points from `getPredictedEvents()`; for the highlighter it switches its own `mix-blend-mode` to multiply so the preview matches the final look.
5. **Thumbnails** (sidebar) render lazily via `IntersectionObserver` at 240 px wide and are cached as JPEG data URLs per `blobId:pageNumber`.

---

## 7. Input model

`components/usePageInput.ts` is a small state machine attached to each page element with Pointer Events. On `pointerdown` it decides what the pointer means:

| pointerType | Condition | Result |
|---|---|---|
| `pen` | always | current tool (pen, highlighter, eraser, lasso, text, hand). Marks `activePenPointer` so touches are ignored until `pointerup`. |
| `mouse` | button 0 | current tool; button 1, Space held, or Hand tool → pan |
| `touch` | "Draw with finger" off | ignored — the browser scrolls natively |
| `touch` | "Draw with finger" on, primary pointer, no pen active | current tool; a second finger cancels the stroke and the viewer takes over for pinch/pan |

Sessions:

- **draw** — appends points from `getCoalescedEvents()` (so 240 Hz Pencil samples are not lost at 60/120 Hz event delivery), clamps them to the page bounds (D-2), stores `pressure` (0.5 for mouse, which makes `perfect-freehand` simulate pressure from velocity), and schedules one live redraw per frame. On `pointerup` the stroke becomes one `addStroke` action.
- **erase** — on every sample, hit-tests the page's strokes against a circle (`strokeHitByCircle`, distance to each segment ≤ radius + half width), sampling intermediate points so fast swipes do not skip strokes. *Whole-stroke* mode accumulates ids; *partial* mode splits strokes into surviving pieces (`splitStrokeByCircle`). The page previews the result live and commits one `replaceStrokes` action on release.
- **lasso** — records the polygon; on release selects strokes with more than half their points inside (`strokeInLasso`) and text boxes whose centre is inside, and publishes a `Selection` through the store.
- **pan** — adjusts the scroller's `scrollLeft/Top`.
- **tap** (text tool) — creates a text box if the pointer moved less than 8 px.

Palm rejection has two layers: the viewer's `touchstart` handler prevents default for any touch while a pen stroke is active (so a palm cannot scroll), and the input hook ignores touch pointers while `activePenPointer` is set (so a palm cannot draw).

Safari behaviours are suppressed on the page element with `touch-action`, `-webkit-user-select: none`, `-webkit-touch-callout: none`, a `dblclick` preventDefault, and document-level `gesturestart`/multi-touch `touchmove` preventDefault inside the editor.

---

## 8. Selection and transforms

A selection is rendered as three things: the selected strokes on their own canvas (the page's ink canvas excludes them), a dashed box with four corner handles, and a floating mini toolbar (delete, duplicate, copy, cut, recolour). Dragging the box or a handle applies a **CSS transform** to the selection canvas, the box and any selected DOM text boxes — no stroke data changes and nothing is re-rendered during the drag. On release, `commitSelectionTransform(dx, dy, sx, sy, origin)` produces one undoable action that rewrites the affected strokes (`translateStroke`, `scaleStroke`; widths scale by the geometric mean of `sx, sy`).

Copy/cut keep the items and their bounding rect in the store's clipboard; paste onto any page creates new ids, re-targets `pageId`, clamps the rect into the page and selects the pasted items (T-4).

---

## 9. Persistence and view state

- `openDocument` loads the record, all strokes and text boxes for the document (two index queries) and the tool settings in parallel, then groups annotations by page. A monotonically increasing token discards the result of a superseded open (React StrictMode double-invokes effects; without the guard the second load could reset the zoom chosen by the first).
- View state is saved 400 ms after the last scroll or zoom change as `{ pageIndex, offsetY, zoom }` where `offsetY` is measured in PDF points from the top of the page at the viewport top, so it survives zoom changes and different screen sizes (V-11). On open, the viewer restores it before the first paint, otherwise it fits the current page's width.
- `navigator.storage.persist()` is requested on library load; the library shows a banner if persistence was denied or usage exceeds 85 % of quota (S-3).
- `closeDocument` and leaving the editor flush the queue; the pdf.js worker document is destroyed and its page caches released.

---

## 10. Export

**Annotated PDF** (`export/pdfExport.ts`): load the original bytes with `pdf-lib`, insert blank pages at their display positions (`insertPage`), then for each page draw highlighter strokes first (multiply blend, 40 % opacity) and pen strokes after, as filled SVG paths generated from the same `perfect-freehand` outlines used on screen — the export is vector and matches the screen exactly. Text boxes are wrapped with Helvetica metrics and drawn line by line; characters outside WinAnsi fall back to `?`. All positions go through the rotation mapping from §5, so annotations on rotated pages land correctly (verified by rendering the exported file with pdf.js and sampling pixels).

**Bundle** (`export/bundle.ts`): a zip with `document.json`, `strokes.json`, `textBoxes.json` and `original.pdf`. Import creates a new document with fresh ids.

**PNG** of the current page uses the AI-facing `renderPageImage`.

---

## 11. Hooks for the future AI feature (§12 of the requirements)

`src/api/notebookApi.ts` is the only module an assistant should need:

| Function | Purpose |
|---|---|
| `renderPageImage(pageId, scale)` | PDF bitmap + annotations → PNG `Blob` (X-1) |
| `renderRegionImage(pageId, rect, scale)` | cropped region of the above (X-2) |
| `getSelection()`, `subscribeSelection(cb)` | current lasso selection `{ pageId, boundingRect, strokeIds, textBoxIds }` (X-3) |
| `getPageText(pageId)` | pdf.js text items with positions in page coordinates (X-5) |
| `getOriginalPdfBytes(docId?)` | the stored, unmodified PDF bytes (X-5) |
| `getDocumentState()` | document, annotations by page, zoom, current page (X-6) |

`PageOverlayObject` (in `TextBoxView.tsx`) is the generic page-anchored, zoom-following, optionally collapsible container that text boxes already use and that answer cards can reuse (X-4). The same object is exposed as `window.__notebook` for tests and debugging.

The planned assistant built on these hooks is described in [`pdf-notebook-agent-design.md`](./pdf-notebook-agent-design.md).

---

## 12. Testing

- **Unit (Vitest, Node):** page layout and screen↔page round-trips with zoom and scroll; rotation mappings for 0/90/180/270 including the pdf-lib placement composition; zoom focal-point invariance; visible-range calculation; lasso point-in-polygon and majority rule; eraser hit test and stroke splitting; bounds and scaling; `UndoStack` ordering, redo invalidation and the 100+ step limit (Q-3).
- **End-to-end (Playwright, Chromium):** imports the generated 40-page fixture (mixed sizes, one rotated page) through the file picker, draws with synthetic *pen* pointer events via the Chrome DevTools Protocol, highlights, undoes/redoes, erases, lasso-selects and moves, inserts a blank page and draws on it, reloads, and checks that strokes and the scroll position survive (Q-4). The fixture is produced by `e2e/make-fixture.mjs`.
- **Manual on iPad:** pinch, palm rejection and Pencil latency cannot be driven by automation and still need a real device.

---

## 13. Performance notes

- pdf.js renders in its worker; the main thread only blits a finished bitmap (F-5).
- A page's ink is drawn once per change, not per frame; a 5,000-stroke document costs one `Path2D` fill per stroke on the pages that are mounted (F-3, F-4).
- Scrolling touches no canvases; zooming during a gesture only changes CSS sizes (F-2).
- Pointer handling does no allocation beyond pushing points; outline computation happens once per frame for the live stroke only.
- Bitmap memory is bounded by the virtualisation window and the per-canvas pixel clamp (V-3).

---

## 14. Known limitations and future work

- **Not implemented (COULD items):** folders/tags, clickable internal PDF links, KaTeX in text boxes, shape snapping, image insertion, two/three-finger tap undo/redo.
- **Mixed page sizes:** fit-width is computed for the current page; wider landscape pages overflow horizontally at that zoom, which is expected but could get per-page fit.
- **Pinch while a native scroll is already in flight** (first finger started scrolling before the second landed) can briefly combine native and custom panning. Starting both fingers together behaves correctly.
- **Text layer** is present but not interactive; text selection and link navigation are candidates for v1.
- **Export text** uses the Helvetica standard font; non-Latin text needs an embedded font.
- **Schema migrations:** the IndexedDB `upgrade` callback is versioned (v1); future field changes should bump the version and migrate in place rather than recreate stores.
