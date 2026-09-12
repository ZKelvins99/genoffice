# MCP phase 2 feasibility: Sheets · Slides · PDF

Status: **investigation** (no code). Answers three questions for the
"coming soon" capability rows in the MCP settings pane: can each be
implemented, is i18n covered, and how should it be modularized. Companion to
[mcp-server.md](./mcp-server.md) (phase 1 + visible docx sessions).

## Verdict at a glance

| Capability    | Headless generation                                         | Visible session (drive the UI)                               | Relative effort |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| Slides (pptx) | yes — engine is Node-safe                                   | **yes — simplest of all**: sessions live in the main process | M / M           |
| PDF           | yes — print pipeline already headless-capable               | n/a (PDF app is a viewer; "capability" = generation/export)  | S               |
| Sheets (xlsx) | yes — values-only today; full fidelity via the Rust sidecar | needs a **new** renderer ops channel (biggest gap)           | S–M / L         |

Recommended order: **PDF → Slides → Sheets headless → Sheets visible** (each
step ships user value; the last item is the only one needing new
cross-process plumbing). Execution is tracked as two milestones in
[mcp-phase2-plan.md](./mcp-phase2-plan.md) (M1 = Slides, M2 = Sheets); PDF is
a small standalone add-on, deliberately left out of the two milestones to keep
them reviewable.

## 1. Slides (pptx) — feasible both ways

**Headless.** `packages/pptx-engine` is pure Node (jszip + fast-xml-parser,
no DOM/Electron): `createBlankPptx()` (`src/blank.ts:138`), `openPptx()`
(`src/index.ts:615`), `savePptx()` / `savePptxToFile()` (`:657`/`:675`).
Editing uses the canonical op registry — `runTxn(opened, req)` (`apps/slides/src/main/ops/executor.ts:159`),
~60 ops: `addSlideWithLayout`, `addElement`, `setText`, `setFont`,
`applyTheme`, `findReplace`, `addTable`, `addChart`, … — plan-validated,
atomic, `dryRun` supported, **proven in plain-Node tests**
(`apps/slides/tests/edit-ops.test.ts` runs it over a blank deck in vitest).
An MCP `create_pptx` maps an outline (markdown or JSON) → op sequence →
bytes, exactly like docx phase 1.

**Visible.** Slides is the outlier in a good way: the editing session lives
in the **main process** (`Session { opened: OpenedPptx, undoStack, opLog }`,
`apps/slides/src/main/session-state.ts:50-79`), keyed by webContents id; the
renderer is a Konva view that renders whatever main broadcasts. So an MCP
visible session needs **no renderer bridge**: shell main → slides-main
session → `runTxn` → `rebuildSlide`/`buildAllRenderSlides` +
`scheduleDeckBroadcast` (`session-state.ts:199-212`) — precisely what the
existing `slides:apply-txn` handler does (`slides-main.ts:1449-1535`), which
is also what the built-in AI agent's `apply_ops` tool uses
(`apps/slides/src/renderer/ai/slides-skill.ts:674`; slides **does** have a
full AgentLoop + skill today). Readiness: `openSlidesTab`
(`tab-manager.ts:207`) + the renderer's `slides:new-blank` pull
(`slides-main.ts:1910`) — a `slides:mcp-ready`-style announce can mirror the
docs bridge if needed, or the control can simply target the active slides
webContents after `openSlidesTab`.

## 2. PDF — feasible, smallest scope

The PDF app itself is a viewer/markup editor, so the MCP capability is
**generation**, and the pipeline already exists:
`buildPrintableHtml` + `printHtmlToPdf`
(`packages/electron-utils/src/print-html-pdf.ts:157`/`:177`) render
restricted HTML to PDF through an offscreen window (caller supplies a
`createWindow()` factory; shell main can pass a `show:false` BrowserWindow).
This is exactly what the built-in `create_document type:"pdf"` does today
(`apps/docs/src/main/docs-main.ts:3953`). An MCP `create_pdf` tool =
markdown/HTML → `printHtmlToPdf` → atomic write to the requested path —
headless, no visible session required (though an "export the current visible
docx as PDF" variant can reuse the docs save pipeline later).

## 3. Sheets (xlsx) — feasible; the visible path is the real work

**Headless.** Two tiers:

- _Values-only (cheap, ship first)_: `blankXlsxBuffer` /
  `sheetCsvToXlsxBuffer` (`apps/sheets/src/gateway/csv-import.ts:211-270`)
  build minimal OOXML zips with JSZip — pure Node, **already imported by the
  shell main process** (`apps/shell/src/main/index.ts:120`). Precedent: the
  `workbook:create-document` handler (`sheets-main.ts:2670`) writes xlsx/csv
  headlessly today.
- _Full fidelity (formulas, styles, charts)_: the writer is a Rust sidecar
  driven from plain Node — `XlsxSidecarClient` (`open`, `recalc_cells`
  IronCalc-backed, `save_archive`; `apps/sheets/src/main/xlsx-sidecar-client.ts:34`)
  - `saveWorkbookViaSidecar` (`apps/sheets/src/gateway/xlsx-package-io.ts:140`),
    exercised without Electron in `apps/sheets/tests/xlsx-sidecar.test.ts`.
    Caveat: formula cells need a sidecar `recalc` pass so cached values exist
    for viewers that don't recalculate.

**Visible.** The gap: sheets' only main→renderer command channel is
`menu:action` with 7 file-menu actions (`apps/sheets/src/shared/ipc-channels.ts:82`);
there is no ops channel. But the renderer already owns a complete, zod-validated
op vocabulary (`apps/sheets/src/domain/workbook-dsl.ts`: `set_cell`,
`set_formula`, `fill_range`, `insert/delete_rows/cols`, `add_sheet`,
`add_chart`, `add_table`, `set_filter`, …) applied via `planFromOps` +
`applyChangePlan` (`apps/sheets/src/renderer/op-executor.ts:300`/`:338`) —
the same executors the in-app AI uses (`App.tsx:3112`). A sheets visible
session = docs-bridge pattern again: open a tab (`openSheetsTab`,
`tab-manager.ts:185`), add a `sheets:mcp-command`-style channel that forwards
DSL ops to `applyChangePlan`, plus a ready signal (the queued-workbook nudge
loop, `shell index.ts:2862`, shows the poll precedent; a docs-style
`signalMcpReady` announce is cleaner). Read + recalc without the grid is
also possible headlessly per file via sidecar `read_range`/`recalc_cells`.

## 4. i18n — covered, with one convention to keep

- **UI strings**: every relevant app already ships 20 locales
  (ar cs de en es fr he hi id it ja ko ms nl pl pt ru th zh-TW zh) in the
  same shape — zh defines the key set, each shard `satisfies Record<keyof
typeof zh, string>` so a missing key is a type error: shell
  `strings.ts`, docs `renderer/i18n/app/*`, sheets
  `renderer/i18n/{app,ai,dialogs}/*`, slides `renderer/i18n/{app,ai,…}/*`,
  pdf `renderer/i18n/strings.ts`. The MCP settings pane's capability rows
  are already localized in all 20. New settings rows/status lines follow the
  same pattern; nothing structural is missing.
- **Visible-session user feedback**: docs tool summaries already translate
  through the renderer's `t()`; sheets/slides have dedicated `ai/` i18n
  namespaces for the same purpose.
- **MCP tool descriptions** (`name`/`description`/schema `describe()`s) are
  intentionally **English-only** — they are read by models, not rendered in
  the UI; this matches the existing docx tools and the slides AI skill.

## 5. Modularization — extends the existing seams, no new shape

Phase 1 already established the pattern; phase 2 adds instances, not
concepts:

```
apps/shell/src/main/mcp/
  app-mcp.ts              # McpRuntimeDeps gains optional sheetsControl/slidesControl/…; buildTools() composes
  docs-bridge.ts          # (exists) request/response plumbing for the docs renderer
  sheets-bridge.ts        # (new) same shape: open tab, forward workbook-dsl ops, await result
  tools/
    document-tools.ts     # (exists) docx: headless + visible session tools
    slides-tools.ts       # (new) create_pptx (headless) + deck session tools (main-side runTxn)
    sheets-tools.ts       # (new) create_xlsx (headless) + grid session tools (via sheets-bridge)
    pdf-tools.ts          # (new) create_pdf (headless print pipeline)
```

- **Per-capability controls**: `DocsControl` generalizes to
  `SlidesControl`/`SheetsControl` — `{ openBlankTab, runCommand }`-shaped
  deps injected through `configureMcpRuntime`, headless/unit runs omit them
  and the tools unregister (same rule as today).
- **Background gating** generalizes: one `mcpBackground` today; either a
  single switch or per-capability keys (`mcpSheets`, `mcpSlides`, `mcpPdf`)
  in `app-settings.json`, each gating its tool module at `buildTools()` and
  restarting the server on flip (the fixed restart path).
- **Settings capabilities section** becomes data-driven: rows derived from
  registered capabilities instead of the static "coming soon" rows; the
  "upcoming" row disappears as families land.
- **Slides special case**: no renderer bridge — the control calls
  slides-main session functions directly (they compile into the shell build
  per CLAUDE.md, same as docs-main today).

## 6. Risks / gotchas

- Sheets full-fidelity headless writes need the sidecar binary present
  (packaging already ships it; tests drive it from Node) and a recalc pass
  for formula caches.
- `printHtmlToPdf` needs an offscreen window factory — pass `show:false` and
  never focus it; PDF printing is the one path that spins a BrowserWindow.
- Slides op vocabulary is large (~60 ops); phase-2 tool surface should stay
  small like docs did: outline → deck headless, plus `apply_ops`-style
  batch visible editing, not 1:1 op exposure.
- Multi-capability visible sessions: keep one active session **per app**
  (docs session state is independent of slides/sheets), matching today's
  single-session simplification.
