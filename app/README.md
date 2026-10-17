# PDF Notebook

A Notability-style web app for reading and handwriting on research-paper PDFs with an Apple Pencil (iPad Safari) or a mouse/trackpad (desktop). Local-only: documents and annotations live in IndexedDB; there is no backend. Built against `docs/pdf-notebook-ui-requirements.md`; the architecture and design decisions are described in `docs/pdf-notebook-design.md`.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable on your LAN for iPad testing)
npm run build      # production build + PWA service worker in dist/
npm run preview    # serve the production build
npm test           # vitest unit tests (transforms, undo stack, lasso/eraser geometry)
npm run test:e2e   # Playwright: import → draw with synthetic pen events → reload
```

To test on an iPad, open the LAN URL printed by `npm run dev` in Safari (the PWA install needs HTTPS or localhost, so use `npm run build && npm run preview` behind an HTTPS proxy, or deploy `dist/` to any static host).

## Stack

TypeScript + React + Vite · pdf.js (`pdfjs-dist`, rendering in the worker, text layer) · perfect-freehand (pressure-sensitive outlines) · IndexedDB via `idb` · pdf-lib (export) · JSZip (bundles) · Zustand (store) · vite-plugin-pwa.

## Layout of `src/`

| Folder | What lives there |
|---|---|
| `model/` | Data types (`DocumentRecord`, `PageRecord`, `Stroke`, `TextBox`, …) and the generic `UndoStack` + `Action`/`Op` types. |
| `geometry/` | Pure maths: page layout, screen↔page transforms, rotation mapping to PDF user space, lasso hit-testing, stroke eraser / partial eraser splitting. Unit-tested. |
| `ink/` | Canvas drawing of strokes (perfect-freehand outlines), highlighter group alpha, text boxes for image export. |
| `pdf/` | pdf.js wrapper: document/page caching, bitmap size clamping, render helper, text content with positions. |
| `db/` | IndexedDB schema and batched writes. |
| `persist/` | Debounced autosave queue (≤ 600 ms, plus `visibilitychange`/`pagehide`). |
| `store/` | `editorStore` (document, strokes by page, selection, clipboard, tools, undo/redo, view state) and `libraryStore`. |
| `components/` | Library, Editor, Toolbar, Viewer (virtualised stack, zoom/pinch/scroll), PageView (pdf/highlight/ink/live canvases + text layer), `usePageInput` (Pointer Events state machine), SelectionOverlay, TextBoxView / PageOverlayObject, ThumbnailSidebar. |
| `export/` | Annotated PDF (pdf-lib, vector), backup bundle (.zip), download helper. |
| `api/` | `notebookApi` — the hooks for a future AI feature (§12): `renderPageImage`, `renderRegionImage`, `getPageText`, `getOriginalPdfBytes`, `getSelection`/`subscribeSelection`, `getDocumentState`. Also exposed as `window.__notebook` for tests. |

## Input model (iPad)

* Pointer Events everywhere; `pointerType` decides behaviour. Pen draws; one finger scrolls natively (momentum); two fingers pinch-zoom (handled by the viewer, re-rendered at full resolution once the gesture settles).
* Stylus `touchstart` is `preventDefault`ed so the Pencil never scrolls; while a pen stroke is active all touches are ignored (palm rejection).
* "Draw with finger" toggle: one finger draws, two fingers pan/zoom.
* Live stroke is drawn on a dedicated per-page overlay canvas using `getCoalescedEvents()` and `getPredictedEvents()`; finished strokes are cached on per-page canvases and only redrawn when that page's strokes change.
* Desktop: drag draws with a drawing tool; Space+drag or the Hand tool pans; Ctrl/⌘+wheel and trackpad pinch zoom.

## Coordinates

All annotation coordinates are PDF points relative to the page's top-left corner in the page's displayed orientation. On export, `geometry/transform.ts` maps them into unrotated PDF user space (`displayToUserSpace`, `svgPlacementForRotation`) so annotations land correctly on rotated pages.

## Requirement coverage

All MUSTs and SHOULDs are implemented. Of the COULDs: offline PWA shell (P-4), title search (L-5), dark chrome (U-5), Pencil hover dot (I-9) and page PNG export (S-6) are included. Not built: folders/tags (L-6), internal PDF links (V-12), KaTeX in text boxes (T-6), shape snapping (T-7), image insertion (T-10), multi-finger tap undo/redo (T-8 extra).
