# PDF Notebook

A Notability-style web app for reading and handwriting on research-paper PDFs with an Apple Pencil (iPad Safari) or a mouse/trackpad (desktop). Local-only: documents and annotations live in IndexedDB; there is no backend. Built against `docs/pdf-notebook-ui-requirements.md`; the architecture and design decisions are described in `docs/pdf-notebook-design.md`.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable on your LAN for iPad testing)
npm run build      # production build + PWA service worker in dist/
npm run preview    # serve the production build
npm test           # vitest unit tests (transforms, undo stack, lasso/eraser geometry, placement, markdown)
npm run test:e2e   # Playwright: import → draw → reload, plus Ask against the mocked agent server
npm run server     # agent server for Ask (ws://<this-mac>:8787); prints the pairing token
npm run server:mock  # the same server with fake vision/agent output, for UI work without a model
npm run check      # type-check the app and the server
```

## Ask (assistant)

Write on the page and tap **Ask** (or press `A`). The app screenshots the viewport, a vision step describes it (where in the paper, what the handwriting says), and a conversational agent built on the Claude Agent SDK answers in one Markdown + KaTeX card placed next to the handwriting. Design: `docs/pdf-notebook-agent-design.md`.

The model calls run in a small server on your Mac (`server/`), so the API key never reaches the browser:

1. `npm run server` in `app/`. It prints a pairing token and the LAN address to use from the iPad.
2. In the editor: **⋯ → Assistant settings…**, enter the URL (`ws://your-mac.local:8787`) and the token, **Save & connect**. If the PWA is served over HTTPS the URL must be `wss://`.
3. Credentials: set `ANTHROPIC_API_KEY` (the vision step then uses the Messages API with structured output), or rely on a `claude login` session (both steps then run through the Agent SDK). Models and effort are configurable: `VISION_MODEL` (default `claude-haiku-5-5`), `AGENT_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `medium`), `VISION_BACKEND=messages|agent-sdk`.

The server keeps PDFs by content hash with their extracted text under `~/.pdf-notebook-agent/` (override with `--data <dir>`), one Agent SDK session per document (resumed on every Ask; **⋯ → New conversation** starts over), and re-attaches the PDF after the SDK compacts a long conversation. Cards are ordinary text boxes with `kind: 'answer'`: undo removes them, they persist, move and export (as plain text with the LaTeX source).

Verified live on 2026-10-17 against real models with a `claude login` session (so vision ran through the Agent SDK): handwriting is transcribed and boxed accurately, the card anchors to the ink, and answers cite pages outside the view (resume carries the conversation across follow-up Asks). Two notes: with no `ANTHROPIC_API_KEY` the vision step takes ~9–11 s (it spawns a CLI subprocess; an API key switches it to the faster Messages API backend), and a single Ask costs roughly **$1–2** because the agent is Opus with the whole paper text in the system prompt and the PDF attached — set `AGENT_MODEL` to a cheaper model to reduce it. See design doc §12 for the measured numbers and the one API fix (the PDF document block must not carry an explicit `cache_control`).

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
| `api/` | `notebookApi` — the hooks the assistant uses (§12): `renderPageImage`, `renderRegionImage`, `getPageText`, `getOriginalPdfBytes`, `getSelection`/`subscribeSelection`, `getDocumentState`, plus `ask`, `agent`, `captureViewport`. Also exposed as `window.__notebook` for tests. |
| `agent/` | Ask client: `protocol.ts` (shared WebSocket messages), `capture.ts` (viewport screenshot + CaptureMap + visible text), `placement.ts` (pure card placement, unit-tested), `markdown.ts` (Markdown + KaTeX with streaming-safe delimiters), `client.ts` (WebSocket + settings store), `ask.ts` (the flow: capture → sync PDF → described → card → stream; retry, cancel, re-ask, new conversation). |
| `../server/` | Agent server (Node + TypeScript, run with `tsx`): `ws.ts` protocol, `vision.ts` interpreter, `agent.ts` main agent on the Claude Agent SDK, `paper.ts` PDF store + pdf.js text extraction, `prompt.ts`, `mock.ts`. |

## Input model (iPad)

* Pointer Events everywhere; `pointerType` decides behaviour. Pen draws; one finger scrolls natively (momentum); two fingers pinch-zoom (handled by the viewer, re-rendered at full resolution once the gesture settles).
* Stylus `touchstart` is `preventDefault`ed so the Pencil never scrolls; while a pen stroke is active all touches are ignored (palm rejection).
* "Draw with finger" toggle: one finger draws, two fingers pan/zoom.
* Live stroke is drawn on a dedicated per-page overlay canvas using `getCoalescedEvents()` and `getPredictedEvents()`; finished strokes are cached on per-page canvases and only redrawn when that page's strokes change.
* Desktop: drag draws with a drawing tool; Space+drag or the Hand tool pans; Ctrl/⌘+wheel and trackpad pinch zoom.

## Coordinates

All annotation coordinates are PDF points relative to the page's top-left corner in the page's displayed orientation. On export, `geometry/transform.ts` maps them into unrotated PDF user space (`displayToUserSpace`, `svgPlacementForRotation`) so annotations land correctly on rotated pages.

## Requirement coverage

All MUSTs and SHOULDs are implemented. Of the COULDs: offline PWA shell (P-4), title search (L-5), dark chrome (U-5), Pencil hover dot (I-9) and page PNG export (S-6) are included. Not built: folders/tags (L-6), internal PDF links (V-12), KaTeX in plain text boxes (T-6; answer cards do render KaTeX), shape snapping (T-7), image insertion (T-10), multi-finger tap undo/redo (T-8 extra).
