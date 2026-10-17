# PDF Notebook — Merge Plan: human-pretraining Plugins

Companion to [`pdf-notebook-design.md`](./pdf-notebook-design.md) (§11, `notebookApi`) and [`pdf-notebook-agent-design.md`](./pdf-notebook-agent-design.md) (Ask). This plan brings the useful features of [Chiyun-Lee/human-pretraining](https://github.com/Chiyun-Lee/human-pretraining) into the PDF Notebook as **plugins**. In human-pretraining these features currently run in a desktop reader written in plain JS, backed by a FastAPI service.

Status: **plan** (2026-10-17). Nothing is built yet.

---

## 1. What comes in, and what doesn't

Each row is a **pillar**: a module you can turn on or off on its own (§4.1). No pillar needs another to be on.

| Pillar | From human-pretraining | Where it appears in the Notebook | Phase |
|---|---|---|---|
| **Methods pins** | `app/pins.py`, `app/pins/*.json`, `web/pins.js` | A page layer: ■ ● ▲ buttons beside figures and tables, each opening a card | 1 |
| **Doodle notes** | `app/summarize.py`, `web/reader.js`, the note-edit route | A page layer: handwritten-style bullets over the original paragraphs, which are blurred, with a switch on each note and an all-notes switch in the toolbar | 2 |
| **Graphical abstract** | `app/abstract.py`, `web/abstract.js` | A toolbar button that opens a panel with an SVG slide and Export SVG | 3a |
| **Quiz** (with "Show me the proof") | `app/quiz.py`, `app/proof.py`, `web/quiz.js` | A toolbar button that opens a panel; "Show me the proof" scrolls to the paragraph | 3b |
| **For you feed** | `app/feed.py`, `ranker.py`, `arxiv.py`, `pitch.py`, `profiles.py`, `zotero.py`, `web/foryou.js` | A second tab in the Library; "Add" imports the PDF into the Notebook | 4 |
| **Saved papers** (Chrome extension) | `extension/` | Saves to the service; a Library tab lists the saved papers and imports them | 4 |

**Left out: the highlight tutor** (`app/tutor.py`, `web/chat.js`, `POST /papers/{id}/pages/{page}/ask`). It is a second chat with its own model, memory and UI, and it overlaps with Ask. That means two consequences:
- The tutor's "fold what you learned back into the note" feature goes away.
- You can still edit notes by hand (phase 2).

If highlight-to-ask is wanted later, it should feed the existing Ask agent session rather than come back as a separate tutor.

## 2. Architecture

```
 PDF Notebook (React PWA, iPad)                        human-pretraining service (FastAPI, Python)
 ──────────────────────────────                        ───────────────────────────────────────────
 src/plugins/
   registry.ts   ← plugins register layers, buttons, panels
   service.ts    ── HTTP (CORS + token) ────────────►  PUT  /docs/{sha256}            (new: upload PDF, extract)
   pins/         ◄── PaperPins ───────────────────────  GET  /docs/{sha256}/pins
   doodles/      ◄── PageSummary + block bboxes ──────  GET  /docs/{sha256}/pages/{n}/summary
   abstract/     ◄── GraphicalAbstract ───────────────  POST /docs/{sha256}/abstract
   quiz/         ◄── Quiz, Proof ─────────────────────  POST /docs/{sha256}/quiz, /proof
   (Library) foryou/ ◄── feed ────────────────────────  GET  /feed …  (unchanged)
 IndexedDB: pluginData (cache, works offline)

 app/server/ (Node, Ask agent) is unchanged and runs alongside it.
```

**Decisions:**

1. **Keep their backend as a separate service, and don't port it yet.**
   - The note layout depends on pymupdf's text blocks. Moving to pdf.js text items would change how paragraphs are grouped, and every prompt and test would need redoing.
   - The feed's ranker uses scikit-learn.
   - The hackathon team keeps ownership of their code. The two codebases meet at the HTTP contract in §3.
   - Moving the prompts into `app/server/` can come later, once the features are settled.
2. **Identify papers by the PDF's sha256.** The Notebook already computes it in [`sha256.ts`](../app/src/agent/sha256.ts), and the Ask server uses it to key `papers/<sha>/`. The service gains sha-keyed routes, so the same PDF never needs a second id.
3. **Plugins are typed modules in this repo, not code loaded at runtime.** That keeps the build, types and tests simple.
4. **Every feature is a pillar you can switch on or off.** Pillars sit on a small shared core (service client, upload, cache). The core is not a pillar and runs only while at least one pillar is on. Pillars never import each other, and server-side dependencies are removed (S-6), so any combination works. See §4.1.
5. **Plugin output is a view on the page, not part of the notebook.** Notes and pins are not strokes or text boxes:
   - They are not part of undo.
   - They are not baked into PDF export, though export could offer this later as an option.
   - They are cached per document, so a paper that has been read once still shows its notes offline.

## 3. Changes on the human-pretraining side (PRs to their repo)

| # | Change | Why |
|---|---|---|
| S-1 | `PUT /docs/{sha256}` with the PDF bytes as the body. It runs `extract.extract`, then stores the paper with a new `sha256` column. It is idempotent and returns `{ id, title, arxiv_id, n_pages }`. | Notebook papers live on the device, with no URL. |
| S-2 | `/docs/{sha256}/…` versions of `pages/{n}/summary`, `pins`, `abstract`, `quiz`, `proof`, and `PUT pages/{n}/notes/{i}`. These are thin wrappers that resolve sha → id. | One id on both sides. |
| S-3 | `GET /docs/{sha256}/pages/{n}/blocks` returns `Page` (`blocks[].bbox`, `width`, `height`). Alternatively, the summary response can include a `bbox` per note (the union of its blocks). | The client needs geometry to place notes. |
| S-4 | CORS: allow the PWA's origin (and `http://localhost:5173` in dev) as well as `chrome-extension://`. Add a bearer token (`SERVICE_TOKEN` in `.env`), checked on every route. | The iPad reaches the service over the LAN, like the Ask server. |
| S-5 | The pins lookup needs the arXiv id. `pins.for_paper` already falls back to the `arxiv_id` Claude reads from the PDF, so check that this works for papers uploaded without a URL. | Pins for papers that weren't saved from arXiv. |
| S-6 | Remove dependencies between features. Today `POST /quiz` returns 409 until an abstract exists. Instead, the quiz should be built from the notes alone, and use the abstract only if one has already been made. Abstract and quiz already write any missing notes themselves (`all_summaries`), so neither needs the Doodle notes layer. | Each pillar works with any of the others switched off. |

Their reader keeps working, so none of this breaks their app.

## 4. Changes on the Notebook side

### 4.1 Plugin host and pillars (phase 0)

**Turning pillars on and off:**
- A **Plugins** section in settings has one switch per pillar, and the choice is remembered on this device. Every pillar starts off; the user turns on the ones they want.
- Switching takes effect immediately, without a reload. Turning a pillar off unmounts its layer, buttons, panel and Library tab, and stops its network calls, including any in flight (aborted).
- Turning a pillar off keeps its cached data, so turning it back on is instant and works offline. A separate "Clear data" button next to each switch deletes it.
- *Later:* a per-document override, such as notes on for this paper only.

**Rules every pillar follows:**
- **It lives in its own folder** (`src/plugins/<id>/`) and exports one `NotebookPlugin`. It imports only the core (`src/plugins/core/`), `notebookApi` and shared UI, never another pillar. A lint rule (`no-restricted-imports`) enforces this.
- **It owns its data.** It reads and writes only its own `pluginData` namespace (`[pluginId, docId, key]`).
- **It calls only its own routes.** Any work it needs from another feature happens on the service. For example, the quiz needs notes, and the service writes them itself (S-6), whether or not Doodle notes is on.
- **It fails on its own.** If one pillar errors (service down, bad JSON), only that pillar shows an error state. The reader and the other pillars keep working, and each layer is wrapped in an error boundary.
- **It can be deleted.** Removing its folder and its line in the registry list must leave everything else building and passing tests.

`src/plugins/types.ts`:

```ts
export interface NotebookPlugin {
  id: string;                                   // 'pins', 'doodles', 'abstract', 'quiz', 'foryou', 'saved'
  label: string;                                // shown next to its switch in settings
  description: string;
  /** Library tab (For you, Saved papers). */
  LibraryTab?: React.ComponentType;
  /** Drawn inside each PageView, in page points, between the text layer and the highlights. */
  PageLayer?: React.ComponentType<{ page: PageRecord; doc: DocumentRecord; zoom: number }>;
  /** Buttons in the toolbar's plugin group. */
  toolbar?: Array<{ id: string; icon: React.ReactNode; label: string; run: () => void; pressed?: () => boolean }>;
  /** Side panel, mounted by Editor like ConversationPanel. */
  Panel?: React.ComponentType<{ doc: DocumentRecord; onClose: () => void }>;
  onDocumentOpen?: (doc: DocumentRecord) => void | Promise<void>;
}
```

Work items:

| # | Change | Files |
|---|---|---|
| H-1 | Registry (a static list of pillars) plus a `usePlugins()` hook that returns the enabled ones. Switches are stored in the `settings` store and edited in a new Plugins section of settings, with a "Clear data" button for each pillar. | `src/plugins/registry.ts` (new), `src/components/PluginSettings.tsx` (new) |
| H-1b | Shared core: the service client and upload (H-4), `pluginData` access (H-5), an error boundary for each layer and panel, and an `AbortSignal` that fires when a pillar is switched off. | `src/plugins/core/` (new) |
| H-2 | `PageView` renders each enabled plugin's `PageLayer` in a `plugin layer` div between `.textLayer` and `.highlights`. The layer is `pointer-events: none`, and its own buttons opt back in and `stopPropagation` on `pointerdown`, the same way `page-tools` does. Ink always draws above plugin layers, so you can write over a note. | `components/PageView.tsx`, `styles.css` |
| H-3 | A plugin group in the toolbar, and a slot for the open plugin panel in the Editor. | `components/Toolbar.tsx`, `components/Editor.tsx` |
| H-4 | Service client: URL and token stored in settings and edited in a "Paper service" section next to Assistant settings; `ensureUploaded(doc)` runs `PUT /docs/{sha}` once per document; typed fetch helpers validated with zod. | `src/plugins/service.ts` (new), `components/AgentSettings.tsx` |
| H-5 | IndexedDB store `pluginData` keyed by `[pluginId, docId, key]`, which needs a DB version bump to 2 with a migration. | `src/db/db.ts` |
| H-6 | Expose `pdfPointToPage(pageId, [x0,y0,x1,y1])` in `notebookApi`. pymupdf bboxes use PDF points from the top-left of the unrotated page, so rotated pages need the same transform the text layer uses. | `api/notebookApi.ts`, `geometry/transform.ts` |
| H-7 | Mock service for tests (fixed JSON for one sample PDF), started by Playwright like the mock Ask server. | `e2e/mock-service.ts` (new), `playwright.config.ts` |

### 4.2 Methods pins (phase 1)

- On document open: `GET /docs/{sha}/pins`, cached in `pluginData`.
- `PageLayer` draws each target's buttons beside its bbox. Port `pinSpot` from `web/pins.js`, which places pins in free space next to the figure.
- Tapping a pin opens a card showing the plain line, the researcher line and the evidence badge, using the popover style from `Popover.tsx`.
- Pins only exist for papers that were reviewed offline (today, one demo: arXiv 2506.22373v2). The plugin shows nothing on other papers.

### 4.3 Doodle notes (phase 2)

- Notes are fetched page by page as pages enter the viewport, using the virtualisation the Viewer already does, and cached in `pluginData`.
- How each note looks:
  - It covers the union of its blocks' bboxes, with `backdrop-filter: blur()` over the PDF canvas.
  - The text is handwritten-style and sized to fit, using `fit()` from `reader.js`.
  - Asides are blurred only.
- Each note has its own switch, and a toolbar toggle shows or hides all notes. The default is off: the Notebook is for close reading, and notes are opt-in.
- Notes can be edited by hand (✎ → `PUT /docs/{sha}/pages/{n}/notes/{i}`). This kind of edit is not part of notebook undo.
- **Ask integration:** Ask's screenshot is built from the page canvases ([`capture.ts`](../app/src/agent/capture.ts)), so the vision step sees the original paper, not the notes. Add a `visibleNotes` field (heading and bullets of the notes on screen) to the ask payload. That lets the main agent answer questions written next to a note.
- **Font:** xkcd-script is CC BY-NC 3.0, which is fine for the hackathon but not for anything commercial. Keep the font family in one CSS variable so it's easy to swap.

### 4.4 Graphical abstract (phase 3a)

- A toolbar button opens its own panel. `POST /docs/{sha}/abstract` returns the slide, which is rendered as SVG by a port of `web/abstract.js`, with Export SVG.
- Before the first run, it warns that this writes notes for every page, which costs one model call per unread page. The notes are written whether or not Doodle notes is on.

### 4.5 Quiz (phase 3b)

- A toolbar button opens its own panel. `POST /docs/{sha}/quiz` works on any paper, with or without an abstract (S-6). Missed questions come back until answered correctly.
- **Show me the proof:** calls `/proof`, scrolls the Viewer to the page and highlights the quoted words briefly, using text-layer positions from `getPageText`. It shows the original paragraph and the note's text inside the quiz panel, so it doesn't need the Doodle notes layer.
- **Later:** pass the document's Ask history (questions only) to the quiz, so it can cover what the reader struggled with. This needs a new optional field on the quiz endpoint.

### 4.6 For you feed and saved papers (phase 4)

These are two separate pillars.

- **Library tab "For you":** a port of `web/foryou.js` with the same `j`/`k`/`a`/`m`/`n` keys, plus tap targets for the iPad. **Add** fetches `GET /papers/{id}/pdf` and runs the normal import (`libraryStore`), so the paper lands in IndexedDB like any other.
- **Library tab "Saved":** `GET /papers` lists what the Chrome extension saved, with the same Import action.
- The extension itself is unchanged, and its "Open library" link can point at the Notebook.
- Profiles, Zotero and feedback stay on the service.

## 5. Phases and done-when

| Phase | Done when | Size |
|---|---|---|
| 0. Plugin host + S-1…S-4, S-6 | A test pillar with an empty layer and one button appears when switched on and disappears when switched off, without a reload. The app uploads a PDF to the service once, and only while some pillar is on. The mock-service e2e test passes. | M |
| 1. Pins | Pins appear on 2506.22373v2 and show nothing on other versions or papers. The cards open on iPad and desktop. Pencil ink still draws over pinned areas. | S |
| 2. Doodle notes | Notes appear as you scroll, flip back to the original, can be edited, are cached offline, and are included in Ask's context. Scrolling stays smooth on a real iPad. | L |
| 3a. Abstract | Abstract renders and exports with every other pillar off. | S |
| 3b. Quiz | The quiz works with every other pillar off and repeats missed questions. Proof jumps to the right paragraph. | S |
| 4. For you, Saved papers | Adding from either tab imports the PDF into the Library. Each tab works with the other off. | M |

After phase 0, phases can land in any order, because pillars don't depend on each other. Each phase is a separate PR and keeps `npm test`, `npm run check` and `npm run test:e2e` green. Phase 2 also needs a check on a real iPad.

**Independence tests** (added in phase 0, extended by each pillar):
- **Each alone:** an e2e test turns on one pillar, with all others off, and checks that its feature works.
- **All on, then each off:** with every pillar on, switching one off removes all of its UI (layer, buttons, panel, tab) and makes no further requests to its routes.
- **Failure is contained:** with the mock service failing one pillar's routes, the reader and the other pillars still work.
- **Lint:** no pillar imports another pillar's folder.

## 6. Risks

- **iPad performance:** many `backdrop-filter` elements over a large canvas can be slow in Safari. If they are, draw one blurred copy of the page canvas and clip it to the note rects.
- **Two servers to run:** the Ask server (Node) and the paper service (Python). Add both to `.claude/launch.json` and the README, each with its own token.
- **Cost:** notes use `SUMMARY_MODEL` (Opus by default) once per page, and the abstract summarises every page. Set the service's model to Sonnet or Haiku for daily use.
- **Coordinate drift:** pymupdf and pdf.js can disagree on rotated or cropped pages (CropBox ≠ MediaBox). Test H-6 against such a PDF.
- **Auth:** like the Ask server, the service uses an API key or a local `claude login`. Neither can be offered as claude.ai login in a product you distribute.
