# MCP server: exposing GenOffice document generation to external agents

Status: **phase 1 implemented** (docx generation). The MCP server lives in the
shell main process and only runs while the app is running; it is disabled by
default and turned on in Settings > General > "Local MCP server". See
[mcp-server-milestones.md](./mcp-server-milestones.md) for the step-by-step
execution record.

What landed (all unit/integration tested; see the milestones doc for the file
map): `apps/shell/src/main/mcp/{mcp-server,doc-generation,markdown-to-blocks,app-mcp}.ts`,
tools in `.../mcp/tools/document-tools.ts`, the stdio bridge at
`scripts/mcp-stdio-bridge.js`, and shell wiring in `apps/shell/src/main/index.ts`.

Deliberately deferred: editing an existing docx, PDF/PPT conversion,
spreadsheets, and image fetching in markdown (phase 2 below). Feasibility for
the Sheets/Slides/PDF capability rows is worked out in
[mcp-phase2-feasibility.md](./mcp-phase2-feasibility.md).

The reference implementation is the sibling project **Tabby-MCP** (a Tabby
terminal plugin that embeds an MCP server). We copied its server shape, not its
tool surface.

## Connect a client

Enable the server in **Settings > General > Local MCP server**, then point a
client at it. Both transports are served on loopback:

- Streamable HTTP (recommended): `http://127.0.0.1:3093/mcp`
- Legacy SSE: `http://127.0.0.1:3093/sse`
- Health check: `http://127.0.0.1:3093/health`

For clients that only speak stdio (Claude Desktop, Cursor), bridge to the SSE
transport with the bundled script:

```json
{
  "mcpServers": {
    "genoffice": {
      "command": "node",
      "args": ["/absolute/path/to/genoffice/scripts/mcp-stdio-bridge.js", "--port", "3093"]
    }
  }
}
```

Tools exposed in phase 1: `create_docx` (markdown or `SaveBlock[]` → a file on
disk), `read_docx` (visible text), `open_in_genoffice` (focus the file in a
tab), `get_app_info`. Phase 1.5 adds the visible docs session; phase 2 (M1)
adds Slides and (M2) Sheets — each with a headless `create_*` tool plus the
visible session described below. The create/save lifecycle for all three
families was later folded into the shared `create_session` / `save_session`
pair; see the note at the top of the Phase 1.5 section for the current surface.

## Client concurrency

Each connected client session gets its own tool instances (`toolsFactory` in
`mcp-server.ts`), so the active editing session is per-connection: two clients
can each hold a different family open without clobbering each other. Within one
connection there is still a single active session — `create_session` replaces
the previous one.

## Phase 1.5: visible editing (external agent drives the UI)

`create_docx` writes bytes behind the UI. To let an external agent build a
document the user can _watch_ — the same way the built-in agent works — a
visible session was added:

> **Tool surface merge (later revision).** The per-family `create_*` / `save_*`
> pairs below were folded into one shared pair, `create_session { family }` and
> `save_session { path, overwrite? }`, with a single active session at a time
> (`apps/shell/src/main/mcp/tools/session-tools.ts`). Each family module now
> exposes a `FamilyDriver` (open + save) instead of its own lifecycle tools, and
> the default surface dropped from 17 tools to 13 (later 14 with the read-only
> `read_pdf`, see the PDF section below). The per-family content tools
> (`insert_content`, `read_document`, `apply_ops`, …) are unchanged. Where this
> document says `create_document` / `save_document` / `create_deck` /
> `save_deck` / `create_sheet` / `save_sheet`, read the merged pair with the
> matching `family` (`docx` / `pptx` / `xlsx`).
>
> **Format registry.** Family ids, labels, saveable extensions and the headless
> `create_*` output extensions all come from `tools/formats.ts`, which mirrors the
> shell's open routing (`routeDocumentPath`) and each editor's Save-As dialog.
> `get_app_info` reports that editor matrix next to the MCP subset, so drift is
> visible rather than silent, and `save_session` refuses a path whose extension
> does not match the active family. Adding a family or format is a registry entry
> plus a driver — nothing else in the MCP layer changes. The registry also records
> editor capability MCP does not drive yet (the markdown / HTML editors, the
> pdf _editor_, and each editor's PDF export), which is where a future family or
> export tool plugs in. Where the editor can do more than MCP exposes (e.g.
> Sheets Save-As offers `.xlsm`/`.csv` but the explicit-path save bridge writes
> `.xlsx` only), the `mcp` block lists the narrower truth — the `pdf` family
> carries `mcp.read` only until MCP drives its editor.

| Tool             | Input                                      | Effect                                                         |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `create_session` | `{ family: "docx" }`                       | opens a new blank docs tab; starts the session                 |
| `insert_content` | `{ html, afterBlockIndex? }`               | appends/inserts restricted HTML into that tab                  |
| `replace_blocks` | `{ startBlockIndex, endBlockIndex, html }` | replaces a block range                                         |
| `apply_ops`      | `{ ops, dryRun? }`                         | applies a formatting batch (font, paragraph, heading, …)       |
| `read_document`  | `{}`                                       | returns the live document's blocks/indexes/text                |
| `save_session`   | `{ path, overwrite? }`                     | writes the live document to an absolute path, ends the session |

Architecture (mirrors the built-in agent, per the analysis above):

```
MCP tool → DocsControl (apps/shell/src/main/mcp/docs-bridge.ts)
         → webContents.send('docs:mcp-command', {requestId, command, payload})
         → renderer apps/docs/src/renderer/mcp-bridge.ts
              ├─ insert_content / replace_blocks / read_document → executeTool()   (agent tools.ts)
              ├─ apply_ops                                      → executeOps()    (agent ops.ts)
              └─ save_document                                  → save(ctx, …, {path, overwrite})
         → webContents.send('docs:mcp-result', {requestId, ok, result})
```

The renderer reuses the agent's own executors, so external edits get the same
HTML parser, atomic ops and formatting rules. `save_document` goes through a new
`docs:save-to` main-process handler (explicit path, no dialog, refuses to
clobber unless `overwrite:true`; same write allowlist / disk-state / recents
bookkeeping as `docs:save-new`).

These tools are only registered when the shell wired a `DocsControl`; headless
and unit runs keep the file-only surface. Covered by
`apps/shell/tests/mcp/document-tools.test.ts` (routing) and
`e2e/mcp-visible-doc.spec.ts` (real app: visible tab → edits → saved docx).

## Phase 2, milestone 1: Slides (pptx)

Both paths reuse the slides main process — no renderer bridge needed, because a
slides editing session already lives in main (`Session` keyed by the tab's
webContents id, `apps/slides/src/main/session-state.ts`).

**Headless.** `create_pptx` maps an outline to two op batches (the executor
plans each transaction against pre-transaction state, so pages are created first
and filled second) and runs them over `createBlankPptx()` via the canonical ops
executor (`runTxn`), then streams the deck to disk with `savePptxToFile`.
Registered behind the same `background` switch as `create_docx`.

**Visible deck session** — `apps/shell/src/main/mcp/slides-bridge.ts` +
`tools/slides-tools.ts`:

| Tool              | Input                                              | Effect                                                                                                             |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `create_session`  | `{ family: "pptx" }`                               | opens a new blank slides tab, waits for the renderer's session                                                     |
| `apply_slide_ops` | `{ ops, isolation?, dryRun? }` (≤50, EMU geometry) | applies one transaction via `applySessionTxn` — the exact `slides:apply-txn` code path (history, journal, autofit) |
| `read_deck`       | `{}`                                               | element inventory of every slide (durable ids, text, EMU geometry)                                                 |
| `save_session`    | `{ path, overwrite? }`                             | writes via `saveSessionDeckTo` (recents, tab title, dirty reset), ends the session                                 |

`applySessionTxn` is extracted from the `slides:apply-txn` IPC handler
(`apps/slides/src/main/slides-main.ts`) so the app's AI surface and the MCP
tools share one implementation. Because MCP runs in the main process with no
originating renderer, a successful transaction is also pushed straight to the
tab's webContents as `slides:deck-changed` (the shared `scheduleDeckBroadcast`
no-ops for single-window sessions; the renderer applies the payload
idempotently, and multi-window sessions keep getting the scheduled broadcast).
Session lifecycle matches docs: one session at
a time, `save_session` ends it, further edits ask for `create_session`.

Covered by `apps/shell/tests/mcp/slides-tools.test.ts` (headless + session
routing) and `e2e/mcp-visible-deck.spec.ts` (real app: visible slides tab →
ops → saved pptx unpacked and verified). Execution tracked in
[mcp-phase2-plan.md](./mcp-phase2-plan.md) (M2 = Sheets).

## Phase 2, milestone 2: Sheets (xlsx)

**Headless (values-only).** `create_xlsx` writes a 2D row matrix through the
same minimal OOXML builder the app's AI `create_document` uses
(`rowsToXlsxBuffer`, `apps/sheets/src/gateway/csv-import.ts`) — numbers become
numeric cells, text stays text. Registered behind the `background` switch.
Formula-fidelity headless writes would need the Rust sidecar pipeline
(`saveWorkbookViaSidecar`); deliberately deferred (M2.2 in the plan).

**Visible grid session** — the workbook lives in the **renderer** (Univer), so
unlike slides this needs the docs-style request/response channel:

```
MCP tool → SheetsControl (apps/shell/src/main/mcp/sheets-bridge.ts)
         → webContents.send('sheets:mcp-command', {requestId, command, payload})
         → renderer apps/sheets/src/renderer/mcp-bridge.ts
              ├─ read_sheet   → AI workbook readers (ai/workbook-readers.ts)
              ├─ apply_ops    → planFromOps() + applyChangePlan()   (op-executor.ts)
              └─ save_sheet   → handleSave(…, {path, overwrite})    (save-actions.ts)
         → webContents.send('sheets:mcp-result', {requestId, ok, result})
```

| Tool              | Input                      | Effect                                                                                                                                                            |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_session`  | `{ family: "xlsx" }`       | opens a sheets tab on a fresh blank .xlsx (like the app's "new spreadsheet"; the save pipeline needs a real file), waits for the renderer's ready announce        |
| `read_sheet`      | `{ addresses?, sheetId? }` | workbook overview (sheet ids/names/extents) or cell values + formulas                                                                                             |
| `apply_sheet_ops` | `{ ops, dryRun? }`         | applies the workbook DSL (set_cell/set_formula/fill_range/add_sheet/add_chart/…) as one undo batch via `applyChangePlan`                                          |
| `save_session`    | `{ path, overwrite? }`     | explicit-path save through the regular sidecar pipeline (new `targetPath`/`overwrite` fields on the save request; dialog-free, clobber-guarded), ends the session |

Ops address sheets by id (learn it from `read_sheet`), cells by A1. Covering
tests: `apps/shell/tests/mcp/sheets-tools.test.ts` and
`e2e/mcp-visible-sheet.spec.ts` (real app: visible tab → values + formula →
saved xlsx with the formula intact).

## PDF reading (read-only)

The pdf app is a viewer/editor whose text engine already runs in the shell main
process (`apps/pdf/src/main/text-edit.ts` loads the `@embedpdf/pdfium` WASM for
text editing), so MCP gets PDF **reading** without any new dependency:
`apps/pdf/src/main/read-text.ts` walks pdfium textpages over the shared
`chainPdfium`/`withDocument` helpers, and `tools/pdf-tools.ts` exposes it as a
headless, session-free tool — always registered, like `read_docx`. The registry
records the family as `mcp: { read: 'pdf' }` (no generate/save) and the settings
pane keeps the PDF row "coming soon" until the editor itself is driven.

| Tool       | Input                       | Effect                                                                                                                                       |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_pdf` | `{ path, pages?: "1-5,8" }` | page count, info-dictionary title/author, per-page size + text (content order, `\n` line breaks); scanned pages return `hasTextLayer: false` |

Text extraction caps at 80k chars (`truncated: true` when the cap bit) so one
huge PDF cannot flood the agent's context; `pages` bounds it further. Three
embedpdf wasm quirks are load-bearing: `FPDFText_GetText` takes 4 args (the
build drops `buffer_size` — it copies exactly `count` chars, NUL included, so
the terminator is stripped client-side), `FPDF_GetMetaText` takes the tag as an
ASCII BYTESTRING while the value comes back UTF-16LE with a byte length (NUL
included), and encrypted/corrupt files surface as a clean "could not open the
PDF" tool error. Covering tests: `apps/shell/tests/mcp/pdf-tools.test.ts`, the
read_pdf step in `mcp-http-surface.test.ts`, and `e2e/mcp-read-pdf.spec.ts`
(real app).

## Goal

Let other agents (Claude Desktop, Cursor, any MCP client) call into a **running
GenOffice app** to create documents — starting with Word `.docx`. The server
lives in the Electron main process, so it only exists while the app runs: no app,
no port, no access. That is the intended semantics, not a limitation.

## Key finding: the generation engines are already Node-safe

Everything below the editor UI is plain TypeScript with **no DOM and no Electron
dependency**, and returns bytes rather than writing files:

| Capability               | Entry                                                                         | Node-safe                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Build a blank template   | `buildBlankDocx()` — `packages/docx-engine/src/blank.ts:154`                  | yes                                                                                                             |
| Parse existing docx      | `parseDocx(bytes)` — `packages/docx-engine/src/parse.ts:261`                  | yes                                                                                                             |
| **Serialize docx**       | `saveDocx(parsed, blocks, options)` — `packages/docx-engine/src/patch.ts:380` | yes                                                                                                             |
| Blank pptx / open / save | `packages/pptx-engine/src/index.ts:615` / `:657`, `blank.ts:138`              | yes                                                                                                             |
| PDF → docx / pptx / xlsx | `packages/pdf2docx/src/index.ts:43`                                           | yes (caller inits pdfium wasm)                                                                                  |
| HTML → docx              | `packages/html2docx/src/convert.ts:41`                                        | needs a browser driver; main already has `ElectronBrowserDriver` at `apps/html/src/main/html2docx-driver.ts:17` |

`saveDocx` is **the only thing in the codebase that writes OOXML bytes.** Both
the manual save path and the built-in AI agent funnel through it. That makes it
the correct foundation for MCP generation — the app and the external agent then
produce documents through the same engine.

## How the built-in agent "writes docx" today

Worth stating precisely, because it shapes the plan: **the built-in agent never
writes a docx.** It edits the live editor; the normal save path persists it.

The agent is `AgentLoop` (`packages/agent-core`) driven by
`createDocsSkill(...)` (`apps/docs/src/renderer/ai/docs-skill.ts:27`), running in
the **renderer**. Its tools (`apps/docs/src/renderer/ai/tools.ts`) only mutate
editor state:

1. **Edit the open document** — `insert_content` / `replace_blocks` / `apply_ops`
   / `set_header_footer`: the model emits restricted HTML, the renderer turns it
   into editor nodes via `parseHtmlFragment` (`ai/protocol.ts:1022`) and calls
   `replaceBlockRange` (`tools.ts:815`, `:850`). No file is touched.
2. **Create a new document** — `create_document` (`tools.ts:322`, executed at
   `:598`): the main process `createAiDocument` (`apps/docs/src/main/docs-main.ts:3881`)
   does **not** build a file either. It opens a new docs tab and queues
   `{title, html}` (`queueDocsAiContent`, `docs-main.ts:2131`); the new tab later
   runs `applyAiDocContent` (`apps/docs/src/renderer/file-actions.ts:810`) →
   `parseHtmlFragment` → `replaceBlockRange` → `save(...)`.

Both routes converge on the save pipeline:

```
editor.getJSON()                                  // editor doc tree
      │
      ▼
pmDocToSavePlan(doc, parsed.blocks)               // convert.ts:1389  → SaveBlock[]
      │
      ▼
saveDocx(parsed, saveBlocks, options)             // docx-engine      → Uint8Array
      │
      ▼
docs:save | docs:save-as | docs:save-new          // docs-main.ts:3314/:3433/:3476
      │                                              (atomicWriteFile)
```

The serialization core is `buildDocBytes` (`apps/docs/src/renderer/file-actions.ts:558`);
the editor-doc → `SaveBlock[]` mapper is `pmDocToSavePlan`
(`apps/docs/src/renderer/editor/convert.ts:1389`, ~830 lines).

### The reusable seam

`pmDocToSavePlan` consumes **`PmNode`** — a plain JSON structure defined by this
repo, _not_ a ProseMirror library object:

```ts
// apps/docs/src/renderer/editor/convert.ts:63
interface PmNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  text?: string
  marks?: PmMark[]
}
```

Its only non-pure dependency is font metrics, injected as `FontMetricsProvider`
and defaulted to `canvasMetrics()`, which **already returns `null` in Node/jsdom**
(`apps/docs/src/renderer/line-metrics.ts:168`). A Node caller passes
`HeuristicMetrics` (`:91`) or `OpentypeMetrics` (`:404`) instead. The docs and
markdown test suites already exercise this conversion under jsdom.

Two small couplings to be aware of when reusing `convert.ts` from main-process
code: a single i18n call `t('editorChartSeries', ...)` (`convert.ts:1798`) and a
`TextSelection`-free surface otherwise. Neither blocks Node use, but the module
was not written to be imported from main.

## Why not reuse the agent's tool executors

`executeTool` and the `AGENT_TOOLS` executors depend on the Tiptap `Editor`, DOM
APIs (`DOMParser`), and `window.desktop` IPC — none available to an MCP tool in
main. They are not portable. The **engine layer below them is portable**, which
is where phase 1 will attach.

## Architecture

```
external MCP client (Claude Desktop / Cursor / …)
   ├── stdio-only clients ──► scripts/mcp-stdio-bridge.js ──┐
   └── HTTP/SSE clients ──────────────────────────────────┼──► 127.0.0.1:<port>
                                                          ▼
GenOffice Electron main process (apps/shell)
  McpServerService (new)
   ├── Streamable HTTP  POST/GET/DELETE /mcp
   ├── Legacy SSE       GET /sse  +  POST /messages
   ├── bind 127.0.0.1 only; Host + Origin validation
   └── tool handlers ──► DocGenerationService (new)
                           ├── docx-engine        (Word)
                           ├── pptx-engine        (PPT, phase 2)
                           ├── pdf2docx           (PDF → Word/PPT, phase 2)
                           └── optional: open the result in a GenOffice tab
  start: app.whenReady()          stop: app.on('before-quit')
```

The server is transport-only; generation is a plain service it calls. Tools are
registered as `{ name, description, schema, handler }`, the same shape Tabby-MCP
uses (`src/types/types.ts`), so the registration code transfers nearly verbatim.

## Phase 1 scope (docx)

Tools exposed:

| Tool                | Input                                                                                   | Output                                                 |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `create_docx`       | `{ title, content, format?: 'markdown' \| 'blocks' }`, `content` is markdown by default | `{ path }`                                             |
| `read_docx`         | `{ path }`                                                                              | extracted text / block structure (`parseDocx`)         |
| `open_in_genoffice` | `{ path }`                                                                              | focuses the file in a GenOffice tab (via `TabManager`) |
| `get_app_info`      | `{}`                                                                                    | version, default save dir, supported formats           |

Deliberately **out of phase 1**: editing an existing docx (`insert_content`-style
patching needs `parsed.blocks` anchors, revisions, content controls), PDF/PPT
conversion, and spreadsheet generation (there is no xlsx writer engine — sheets
uses a sidecar).

### Input format: two builder paths

The open question is what the model feeds in. LLMs produce **markdown** most
naturally, but the existing mapper `mapDocToSaveBlocks`
(`apps/markdown/src/renderer/export/docxExport.ts`) consumes Tiptap `JSONContent`,
and the HTML→blocks parser `parseHtmlFragment` needs `DOMParser`.

- **Path 1 — build `SaveBlock[]` directly (phase 1).** Skip `PmNode` entirely and
  drive `docx-engine`: `parseDocx(await buildBlankDocx())` → `saveDocx(...)`. This
  is exactly the recipe `exportDocxBytes` already uses
  (`apps/markdown/src/renderer/export/docxExport.ts:313`). Fewest dependencies,
  byte-for-byte the engine's own contract. Add `markdown → SaveBlock[]` mapping
  (~200–300 lines; `marked` is already a dependency of `apps/docs`) covering
  headings, paragraphs, bold/italic/code, lists, links, tables. `BLANK_BULLET_NUM_ID`
  (`'1'`) and `BLANK_ORDERED_NUM_ID` (`'2'`, `packages/docx-engine/src/blank.ts:23/25`)
  back the blank template's numbering.
- **Path 2 — reuse `pmDocToSavePlan` (target state).** Construct `PmNode` JSON in
  Node and call the same mapper the editor uses, so MCP and the in-app agent
  produce identical bytes. Requires a Node HTML parser (jsdom, already a devDep
  of the apps) or a pure-JS markdown→`PmNode` mapping, plus supplying a
  `FontMetricsProvider`. Higher fidelity, more moving parts.

**Decision: ship phase 1 via Path 1, but shape the intermediate structure so
migrating to Path 2 later is additive.** Path 1 gets a working
`markdown → .docx` loop fastest; Path 2 is what makes "edit an existing file"
and exact parity with the app possible.

## Implementation plan

### New files (main process)

- `apps/shell/src/main/mcp/mcp-server.ts` — express + `@modelcontextprotocol/sdk`
  (`StreamableHTTPServerTransport`, `SSEServerTransport`). Model on Tabby-MCP
  `src/services/mcpService.ts`: per-session `McpServer` instances, loopback-only
  bind, `checkHost` / `checkOrigin`, `/health`, generation-guarded start/stop.
- `apps/shell/src/main/mcp/tools/document-tools.ts` — tool definitions + schemas.
- `apps/shell/src/main/mcp/doc-generation.ts` — engine wrappers.
- `apps/shell/src/main/mcp/markdown-to-blocks.ts` — Path 1 mapper.
- `scripts/mcp-stdio-bridge.js` — copy of Tabby-MCP `scripts/stdio-bridge.js`,
  repointed at the GenOffice port.

### Lifecycle hooks (`apps/shell/src/main/index.ts`)

- Start inside `app.whenReady()` (line 4238), next to `initAnalytics()` /
  `startSheetsCaptureServer()` (lines 4308–4311).
- Stop in `app.on('before-quit')` (line 4329), beside `stopSheetsSidecar()`.
  **Do not rely on `window-all-closed`** (line 4325): macOS keeps running after
  the last window closes.
- The existing `node:http` capture server (`apps/sheets/src/main/sheets-main.ts:1810`,
  bound at `:1859`) is the closest local-server template; reuse its shape.

### Settings (enable toggle, port)

- Persist via `writeAppSetting(APP_SETTINGS_PATH(), key, value)`
  (`apps/shell/src/main/app-settings.ts`; `APP_SETTINGS_PATH` at
  `apps/shell/src/main/index.ts:317`).
- Add channels to `HOME_CHANNELS` (`apps/shell/src/shared/home-api.ts:313`),
  register with `ipcMain.handle` (pattern at `apps/shell/src/main/index.ts:3141`),
  expose in `apps/shell/src/preload/index.ts` (pattern at `:343`).
- UI: the MCP pane in `apps/shell/src/renderer/src/SettingsModal.tsx`
  (`setSecMcp` nav item; originally a General-pane toggle, now its own section).
  It carries the enable switch with a running/stopped status dot, the port
  field, a **Background generation** toggle (off by default: the default
  surface is the visible document session; on: the headless `create_docx` is
  registered too — a flip restarts the server so `tools/list` updates), a
  **Connection** group (Streamable HTTP + SSE + health URLs and a client
  `mcp.json` example, each with a copy button), a **Logging** toggle with an
  in-pane log viewer (tail of `userData/mcp-log.txt`; 2s poll + manual
  refresh, auto-follows the tail; reveal-in-file-manager and clear actions;
  `McpLogger` ring + append in `apps/shell/src/main/mcp/mcp-logger.ts` with
  device-local timestamps — the file covers the current app launch only, it is
  reset at startup, tool calls logged by `mcp-server.ts`)
  and an **Available capabilities** group (rows driven by
  `McpStatus.capabilities` — Documents/Slides/Sheets live per registered
  control; PDF announced as upcoming) so future tool families slot in as new
  rows.
  Default **off**.

## Security

- **Bind `127.0.0.1` only.** The server has no authentication, so it must never
  be reachable off-host.
- **Host + Origin validation** on every endpoint (DNS-rebinding defense) —
  Tabby-MCP's `checkHost` / `checkOrigin` are the reference.
- **Write confinement.** Generation targets the app's default save directory by
  default; any explicit path goes through the same writable-path guard the docs
  main process uses, and existing files are never silently overwritten.
- Port contention: a stale instance holding the port must be handled (backoff
  retry, or Tabby-MCP's loopback `/internal/shutdown` handover with a persisted
  control token). Best-effort synchronous stop in `before-quit` avoids most of it.

## Packaging notes

- The shell main build has **no `externalizeDepsPlugin`**, so everything is
  bundled into `out/main/index.js`; `@modelcontextprotocol/sdk` and `express`
  inline automatically and need no `extraResources` entry.
- pdfium (phase 2) is wasm: follow the existing `wasm/*` `extraResources` pattern
  in `apps/shell/electron-builder.cjs` (lines 276–309) and its `beforePack`
  existence assertions (lines 214–229).
- Phase 1 touches main-process code, which compiles into the **shell** build —
  rebuild the shell after changes (CLAUDE.md "Build gotchas").

## Open questions

1. `read_docx` fidelity: return plain text only, or structured blocks?
2. Should `create_docx` open the result in a tab by default, or only on request?
3. Port: fixed default (e.g. 3093) or ephemeral with discovery? — **decided:
   fixed default `3093`** (`DEFAULT_MCP_PORT`), user-overridable in Settings >
   General.
4. Does the stdio bridge ship for every platform, or is it a documented
   copy-paste for stdio-only clients?

## Reference map (file:line)

- Serialize: `packages/docx-engine/src/patch.ts:380`, blank at `blank.ts:154`,
  parse at `parse.ts:261`; exports in `packages/docx-engine/src/index.ts`.
- Editor→blocks mapper: `apps/docs/src/renderer/editor/convert.ts:1389`
  (`pmDocToSavePlan`), `:2425` (`pmNodeToGeneratedBlock`), `:63` (`PmNode`).
- Save pipeline: `apps/docs/src/renderer/file-actions.ts:558` (`buildDocBytes`),
  `:628` (`saveDocx` call), `:825` (`saveOnce`), `:810` (`applyAiDocContent`).
- Save IPC: `apps/docs/src/main/docs-main.ts:3314` / `:3433` / `:3476`.
- Built-in agent: `apps/docs/src/renderer/ai/docs-skill.ts:27`,
  `.../ai/tools.ts:322` + `:598`, `.../ai/protocol.ts:1022`.
- Markdown→docx precedent: `apps/markdown/src/renderer/export/docxExport.ts:313`.
- Lifecycle: `apps/shell/src/main/index.ts:4238`, `:4308`, `:4325`, `:4329`.
- Local server template: `apps/sheets/src/main/sheets-main.ts:1810`.
- Settings: `apps/shell/src/main/app-settings.ts`,
  `apps/shell/src/main/index.ts:317`, `apps/shell/src/shared/home-api.ts:313`,
  `apps/shell/src/renderer/src/SettingsModal.tsx:1149`.
- Font metrics: `apps/docs/src/renderer/line-metrics.ts:43` (`FontMetricsProvider`),
  `:168` (`canvasMetrics` → null in Node), `:91` / `:404` (Node-safe providers).
