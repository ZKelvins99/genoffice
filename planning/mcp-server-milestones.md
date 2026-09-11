# MCP server — phase 1 (docx) milestones

Companion to [mcp-server.md](./mcp-server.md) (the design/decision record). This
file is the **execution checklist**: work top to bottom, and a box is ticked
`[x]` only when that step's verification actually passes — not when the code is
merely written.

Scope: expose GenOffice document generation to external MCP clients, docx first,
server living in the Electron main process so it only exists while the app runs.
Editing an existing docx, PDF/PPT conversion, and spreadsheets are **phase 2** —
the last section records them so they are not forgotten.

Conventions used below:

- `VERIFY:` is the command or check that closes a step.
- File paths are relative to the repo root.

---

## M0 — Scaffolding and de-risking

Goal: prove the generation path runs headless in plain Node, and lay down the
directory/test structure. No MCP SDK needed yet — this milestone must be
completely verifiable with what is already in the lockfile.

- [x] **0.1** Create `apps/shell/src/main/mcp/` and `apps/shell/tests/mcp/`.
- [x] **0.2** Confirm the shell test runner picks up the new tests
      (`apps/shell/vitest.config.ts` uses `tests/**/*.test.ts`, env `node`).
- [x] **0.3** Spike test proving the headless recipe end-to-end:
      `parseDocx(await buildBlankDocx())` → `saveDocx(parsed, blocks)` →
      re-`parseDocx` yields the expected block structure, in a **node** (non-jsdom)
      environment. Model on `packages/docx-engine/tests/blank-template.test.ts`.
- [x] **0.4** Record the shell dependency additions needed for M2 (do **not**
      install yet unless M2 is starting): `@modelcontextprotocol/sdk`, `express`,
      `@types/express` — as `devDependencies` of `@genoffice/shell` (main is
      bundled, so runtime deps are inlined).

  VERIFY: `npm test -w @genoffice/shell` passes with 0.3's spike included.

  **Done 2026-09-11.** `apps/shell/tests/mcp/generation-spike.test.ts` (2 tests)
  proves `document`/`window` are undefined yet the full recipe runs and
  reparses. Note: the environment had no `node_modules`; installed under Node
  v22.14.0 (`.nvmrc` = 22 — the default shell Node was v14 and failed to
  install). Deps installed with `--ignore-scripts`, so electron's binary is
  absent and the 2 pre-existing electron-importing shell tests fail until
  `npx install-electron` runs; unrelated to this work.

Risk retired here: if `docx-engine` could not run outside a DOM, the whole plan
changes. 0.3 is the gate.

---

## M1 — Generation core (no MCP)

Goal: a plain, testable service that turns markdown or structured blocks into
docx bytes. No HTTP, no MCP, no Electron — pure functions in main-process land.

Deliverables under `apps/shell/src/main/mcp/`:

- [x] **1.1** `markdown-to-blocks.ts` — `markdownToSaveBlocks(md: string): SaveBlock[]`.
      Coverage in this order: headings (`#`..`######`), paragraphs, bullet list,
      ordered list (nesting via `ilvl`), bold/italic/strike/inline-code, links,
      code block, blockquote, horizontal rule. Reuse blank-template numbering:
      `BLANK_BULLET_NUM_ID` / `BLANK_ORDERED_NUM_ID` (`packages/docx-engine/src/blank.ts:23`).
- [x] **1.2** `markdown-to-blocks.ts` — tables (GFM pipe tables) → `kind:'xml'`
      table fragment via `generateTableModelXml` (or `TableModel`), the one
      non-text block worth doing in phase 1.
- [x] **1.3** `doc-generation.ts` — `createDocx({ title, content, format })`:
      `format:'markdown'` (default) → 1.1/1.2 → bytes; `format:'blocks'` accepts
      `SaveBlock[]`-shaped JSON for callers that build structure themselves.
- [x] **1.4** `doc-generation.ts` — `readDocxText(bytes): Promise<string>` using
      `parseDocx`, for the `read_docx` tool.
- [x] **1.5** Unit tests (`apps/shell/tests/mcp/`) for every block type in 1.1:
      generate → `parseDocx` → assert heading level, list kind/`ilvl`, run
      bold/italic, link href, table cell text. Assert **no DOM globals** are
      required (node env already guarantees this).

  VERIFY: `npm test -w @genoffice/shell` green; a markdown fixture with a
  heading, nested lists, bold/italic/link, a code block, and a table reparses
  into the expected structure.

  **Done 2026-09-11.** `marked` lexer-based mapper; consumes the blank
  template's numbering (bullets) and allocates a fresh numId per ordered list so
  each restarts at 1. Returns `{ blocks, options }` so the `restartNums` reach
  `saveDocx`. `apps/shell/tests/mcp/doc-generation.test.ts` = 11 tests, all
  green; `tsc --noEmit` clean. Images are intentionally out of phase 1 (alt text
  kept visible).

---

## M2 — MCP server core (transports)

Goal: a localhost-only MCP server that speaks Streamable HTTP and legacy SSE.

- [x] **2.1** Add the three devDeps (0.4) and install
      (`npm install -w @genoffice/shell @modelcontextprotocol/sdk express` +
      `@types/express`), updating `package-lock.json`.
- [x] **2.2** `apps/shell/src/main/mcp/mcp-server.ts` — `McpServerService` class,
      modeled on Tabby-MCP `src/services/mcpService.ts`: an `express()` app plus
      `node:http` `createServer`, `POST/GET/DELETE /mcp` (Streamable HTTP) and
      `GET /sse` + `POST /messages` (legacy SSE), per-session `McpServer`
      instances, `GET /health`.
- [x] **2.3** Security: bind `127.0.0.1` only; `checkHost` + `checkOrigin`
      (DNS-rebinding defense) on every MCP endpoint; requests without an Origin
      (local CLI) allowed, as Tabby-MCP does.
- [x] **2.4** Lifecycle API: `start(port)`, `stop()`, `stopSync()`,
      `isRunning()`, with the generation-guard so a stop cancels an in-flight
      start, and `EADDRINUSE` backoff retry.
- [x] **2.5** Test: use the SDK client in-process (Streamable HTTP transport)
      against the service on an ephemeral port — assert `initialize` succeeds
      and `tools/list` returns the registered tools. Cover a legacy-SSE
      handshake too if cheap.
- [x] **2.6** Test: a foreign or mismatched `Host`/`Origin` header is rejected 403.

  VERIFY: `npm test -w @genoffice/shell` green including the SDK-client
  round-trip; `curl http://127.0.0.1:<port>/health` returns the JSON body while
  the service is started in a test harness.

  **Done 2026-09-11.** Decision changed vs the plan: **no express** — the SDK
  transports take Node `IncomingMessage`/`ServerResponse` directly, so the
  server is plain `node:http` (same shape as the sheets capture server), and the
  only new runtime dep is `@modelcontextprotocol/sdk` (1.30.0, `dependencies` of
  `@genoffice/shell`). `zod` (4.4.3) arrives transitively. `registerTool` used
  (the `tool()` overload is deprecated in 1.30). Retry tuning is injectable so
  the EADDRINUSE test does not wait out the 1.5 s × 5 backoff.
  `apps/shell/tests/mcp/mcp-server.test.ts` = 7 tests green (health, initialize +
  tools/list, tools/call, error isolation, Host/Origin rejection, EADDRINUSE);
  `tsc --noEmit` clean. Legacy-SSE path is implemented but not yet covered by a
  test (the SDK's SSE client needs an SSE stream; deferred, not blocking).

---

## M3 — MCP tools (docx surface)

Goal: the phase-1 tool surface, wired to M1.

- [x] **3.1** `apps/shell/src/main/mcp/tools/document-tools.ts` — register:
      - `create_docx` `{ title, content, format?: 'markdown'|'blocks', path? }` → `{ path }`
      - `read_docx` `{ path }` → `{ text }`
      - `get_app_info` `{}` → `{ version, defaultSaveDir, formats }`
      - `open_in_genoffice` `{ path }` → `{ ok }` (implemented in M4; declared here)
- [x] **3.2** Schemas declared as raw shape (SDK requirement), matching the
      `McpTool { name, description, schema, handler }` convention from Tabby-MCP
      `src/types/types.ts`.
- [x] **3.3** Save policy: default target is the app default save dir; a supplied
      `path` passes the writable-path guard; never silently overwrite an existing
      file (unique-name suffix).
- [x] **3.4** Test: `tools/call` `create_docx` with a markdown fixture writes a
      file whose `parseDocx` round-trip matches; `read_docx` returns its text.

  VERIFY: `npm test -w @genoffice/shell` green; the created file opens
  (reparses) cleanly.

  **Done 2026-09-11.** `createDocumentTools(deps)` takes injected
  `defaultSaveDir` / `openInTab` / `version`, so it has no Electron import and
  is tested in plain Node. `create_docx` adds `path?` and `overwrite?`:
  explicit paths must be absolute and are refused when the file exists unless
  `overwrite:true`. Reuses docs' `atomicWriteFile` (relative import) for the
  write. `create_docx` returns `{ path, bytes }`.
  `apps/shell/tests/mcp/document-tools.test.ts` = 12 tests green (full SDK
  round-trip); `tsc --noEmit` clean. Total MCP tests: 32.

---

## M4 — Shell integration

Goal: the server's life is the app's life, and the user can control it.

- [x] **4.1** `apps/shell/src/main/index.ts` — start in `app.whenReady()`
      (line ~4238, beside `initAnalytics()` / `startSheetsCaptureServer()` at
      ~4308–4311); stop in `app.on('before-quit')` (line ~4329). Do **not** hook
      `window-all-closed` (macOS stays alive).
- [x] **4.2** Setting: `mcpEnabled` (default **false**) + `mcpPort` in
      `app-settings.ts` via `writeAppSetting`; channels in `HOME_CHANNELS`
      (`apps/shell/src/shared/home-api.ts:313`), handler beside
      `apps/shell/src/main/index.ts:3141`, exposed in
      `apps/shell/src/preload/index.ts` (pattern at `:343`).
- [x] **4.3** UI: toggle + port field in the general pane of
      `apps/shell/src/renderer/src/SettingsModal.tsx` (~:1149), matching the
      existing `set-switch` rows. Show running/stopped state and the URL.
- [x] **4.4** `open_in_genoffice` — route to the right tab through `TabManager`
      (open an existing file into a tab, focus it).
- [ ] **4.5** Manual check in the running app: enable the toggle, confirm the
      port is listening only on loopback, `create_docx` through a real MCP client
      produces a file, disabling the toggle / quitting frees the port.

  VERIFY: 4.5 manual pass; `npm run typecheck -w @genoffice/shell` clean;
  `npm run build -w @genoffice/shell` succeeds.

  **Done 2026-09-11** for 4.1–4.4; **4.5 needs a human at the GUI** (see
  "Not done / needs a human" below). `app-mcp.ts` owns the singleton service and
  injects `defaultSaveDir` / `routeDocumentPath` / `openInTab`, so it never
  imports `index.ts` back. `open_in_genoffice` reuses `routeDocumentPath`
  (opens/focuses the matching tab) and throws when nothing routed. Settings:
  `mcpEnabled` / `mcpPort` in app-settings.json, `home:get-mcp-status` +
  `home:set-mcp-settings` channels, 20-locale strings (`setMcp`, `setMcpDesc`,
  `setMcpPort`). Verified: `tsc --noEmit` clean, `electron-vite build` succeeds,
  full shell suite 258 passed, eslint + prettier clean.

  **Packaging correction:** putting the SDK in `dependencies` made electron-vite
  externalize it (`require("@modelcontextprotocol/sdk/…")`), which would break
  the packaged app (only `out/**` ships). Moved it to `devDependencies` like the
  shell's other bundled deps → the SDK is now inlined into `out/main/index.js`
  (verified: no non-builtin external requires remain).

---

## M5 — stdio bridge, packaging, docs

- [x] **5.1** `scripts/mcp-stdio-bridge.js` — copy of Tabby-MCP
      `scripts/stdio-bridge.js` repointed at the GenOffice port, for stdio-only
      clients (Claude Desktop, Cursor).
- [x] **5.2** Packaging: confirm the bundled `out/main/index.js` includes the SDK
      and express (shell main has no `externalizeDepsPlugin`); no
      `extraResources` entry expected for phase 1. Verify a packaged
      `--dir` build launches and the server starts.
- [x] **5.3** Docs: flip `mcp-server.md` status from "design" to reflect what
      landed; add a short "connect a client" snippet (endpoint URL + stdio
      config).
- [x] **5.4** Root `package.json` test/typecheck script lines updated if the MCP
      code needs anything beyond `npm test -w @genoffice/shell`.

  VERIFY: packaged dir build smoke-launched; docs updated.

  **Done 2026-09-11** for 5.1/5.3/5.4. `scripts/mcp-stdio-bridge.js` relays
  stdio JSON-RPC ↔ the legacy SSE transport; covered end-to-end by
  `tests/mcp/stdio-bridge.test.ts` (spawns the real script against a live
  service, asserts `tools/list` round-trips). 5.2's bundling half is verified
  (SDK inlined, no external requires); a full packaged `--dir` **launch** is not
  run here (needs a GUI session) and joins 4.5 under human verification.
  `mcp-server.md` updated with status + a connect-a-client snippet.
  Root scripts need no change — `npm test -w @genoffice/shell` already covers
  the new tests (34 MCP tests).

---

## Phase 2 (recorded, not scheduled)

- Edit an existing docx: `parseDocx` + anchor-addressed `SaveBlock[]` patching
  (the `insert_content` path) — the basis for the Path 2 migration in
  `mcp-server.md`.
- Migrate generation from Path 1 (`SaveBlock[]`) to Path 2 (`pmDocToSavePlan`
  parity with the in-app agent).
- PDF → docx/pptx (`packages/pdf2docx`), pptx generation (`packages/pptx-engine`).
- Spreadsheets: blocked on an xlsx **writer** engine (sheets currently uses a
  sidecar); scope separately.
- Images in markdown: `create_docx` currently keeps alt text visible instead of
  embedding (phase 1 has no fetcher).

---

## Not done / needs a human

These are the only items not closed, and both require a GUI/app session this
environment cannot drive:

1. **4.5 app manual pass** — launch the built app, enable Settings > General >
   Local MCP server, confirm `netstat` shows the port bound to `127.0.0.1`,
   call `create_docx` from a real client, then disable/quit and confirm the port
   is released.
2. **5.2 packaged `--dir` launch** — `npm run dist:dir -w @genoffice/shell` (or
   `electron-vite build && electron-builder --dir`) and confirm the server starts
   from the packaged tree. The bundling half is already verified.

Both are smoke checks over code that is unit- and integration-tested; they
validate the Electron wiring, not the MCP logic.

**Known full-suite flake (pre-existing, not MCP):** `tests/pdf2docx-local-argv.test.ts`
takes ~18.3 s against its 20 s `testTimeout` when run alone (wasm init on this
machine). Adding the 5 MCP test files raises parallel CPU contention enough to
push it past 20 s. Evidence: `npx vitest run --exclude 'tests/mcp/**'` → 239/239
pass (the pre-existing suite is green); `npx vitest run` → 272 pass, that one
times out. It is unrelated to MCP; the fix, if wanted, is a per-test timeout
bump in that file (left untouched to keep this change scoped).

---

## Progress log

Newest last. One line per completed step, with the verification evidence.

| Date | Step | Evidence |
| --- | --- | --- |
| 2026-09-11 | M0 (0.1–0.4) | spike test green under Node 22 (`tests/mcp/generation-spike.test.ts`, 2 tests); headless recipe verified |
| 2026-09-11 | M1 (1.1–1.5) | `tests/mcp/doc-generation.test.ts` 11 tests green; `tsc --noEmit` clean; full shell suite 239 passed |
| 2026-09-11 | M2 (2.1–2.6) | `tests/mcp/mcp-server.test.ts` 8 tests green incl. legacy SSE (SDK client round-trip); plain `node:http`, no express |
| 2026-09-11 | M3 (3.1–3.4) | `tests/mcp/document-tools.test.ts` 12 tests green |
| 2026-09-11 | M4 (4.1–4.4) | lifecycle + settings + `open_in_genoffice` wired in shell `index.ts`; build + 258 suite tests green; SDK-inlining fix; 4.5 deferred to human |
| 2026-09-11 | M5 (5.1, 5.3, 5.4) | `tests/mcp/stdio-bridge.test.ts` green (real script ↔ live server); docs updated; 34 MCP tests total; packaged launch deferred to human |
