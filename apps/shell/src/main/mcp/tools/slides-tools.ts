import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { createBlankPptx, openPptx, savePptxToFile } from '@genoffice/pptx-engine'
// the ops index (not executor directly): importing it registers the whole op
// vocabulary the executor validates against
import { runTxn } from '../../../../../slides/src/main/ops'
import { outlineToTxns, parsePptxOutline, type PptxSourceFormat } from '../pptx-outline'
import { resolveOutputPath } from './document-tools'
import type { McpToolDefinition } from '../mcp-server'

/**
 * Slides (pptx) tool surface for the MCP server.
 *
 * Two paths, mirroring the docx tools:
 * - headless `create_pptx`: outline -> ops -> engine bytes on disk, gated behind
 *   the "background generation" setting;
 * - a visible deck session: the tools drive a real slides tab the user watches.
 *   Slides sessions live in the slides main process, so the control talks to
 *   main-process state directly (no renderer bridge) — see
 *   `apps/shell/src/main/mcp/slides-bridge.ts`.
 *
 * This module stays free of Electron: the engine, the ops executor and the
 * outline mapping are plain Node, and the visible path hides behind the
 * injected SlidesControl.
 */

export interface SlidesToolDeps {
  /** directory generated files land in when the caller gives no path */
  defaultSaveDir: () => string
  /** expose the headless create_pptx tool; default true — the shell passes the user's setting */
  background?: boolean
  /** visible-deck control; absent in headless/unit runs, which drops the session tools */
  slides?: SlidesControl
}

/** transaction request for the visible deck (executor semantics, ops are EMU-space) */
export interface SlidesTxnRequest {
  ops: unknown[]
  isolation?: 'atomic' | 'per_op'
  dryRun?: boolean
}

/**
 * Visible-deck control implemented in the shell main process against the slides
 * main-process sessions (`slides-bridge.ts`).
 */
export interface SlidesControl {
  /** open a fresh blank slides tab; resolves to its webContents id */
  openBlankTab: () => Promise<number>
  /** apply one transaction to the tab's session (history + journal + live render included) */
  runTxn: (wcId: number, req: SlidesTxnRequest) => Promise<unknown>
  /** read the visible deck (slides/elements with ids and geometry) */
  readDeck: (wcId: number) => Promise<unknown>
  /** save the session's deck to an absolute path */
  saveDeck: (wcId: number, path: string, overwrite: boolean) => Promise<{ path: string }>
}

const PPTX_EXT = '.pptx'

/** the headless tool: outline -> ops -> pptx bytes written straight to disk */
function createHeadlessPptxTool(deps: SlidesToolDeps): McpToolDefinition {
  return {
    name: 'create_pptx',
    description:
      'Create a PowerPoint .pptx file from an outline and save it to disk without opening the app UI. ' +
      'By default `outline` is Markdown where `# Title` starts each slide, `## text` adds a bold line, ' +
      '`- text` a bullet (indent two spaces per level) and `1. text` a numbered bullet. Use ' +
      'format:"json" to pass {"slides":[{"title":"...","bullets":["...","...",{"text":"...","level":1}]}]} instead. ' +
      'Returns the absolute path of the written file.',
    inputSchema: {
      title: z.string().describe('presentation title, used as the file name'),
      outline: z
        .string()
        .describe(
          'Markdown outline (default) or a JSON string of {"slides":[...]} when format is "json"',
        ),
      format: z
        .enum(['markdown', 'json'])
        .optional()
        .describe('outline format; default markdown'),
      path: z
        .string()
        .optional()
        .describe('absolute output path; default is a new file in the default save folder'),
      overwrite: z
        .boolean()
        .optional()
        .describe('allow replacing an existing file at `path`; default false'),
    },
    handler: async (args) => {
      const title = String(args.title ?? '').trim()
      if (!title) throw new Error('title must not be empty')
      if (typeof args.outline !== 'string') {
        throw new Error('outline must be a string (markdown by default, JSON with format:"json")')
      }
      const format: PptxSourceFormat = args.format === 'json' ? 'json' : 'markdown'
      const slides = parsePptxOutline(format, args.outline)
      const txns = outlineToTxns(slides)

      const targetPath = resolveOutputPath({
        defaultSaveDir: deps.defaultSaveDir,
        ext: PPTX_EXT,
        title,
        requestedPath: typeof args.path === 'string' ? args.path : undefined,
        overwrite: args.overwrite === true,
      })

      const opened = await openPptx(await createBlankPptx())
      for (const ops of txns) {
        const result = runTxn(opened, { ops })
        if (!result.applied) {
          const first = result.failures?.[0]?.error ?? 'the outline could not be applied'
          throw new Error(first)
        }
      }
      await savePptxToFile(opened, targetPath)
      return { path: targetPath, slides: opened.deck.slides.length, bytes: statSync(targetPath).size }
    },
  }
}

export function createSlidesTools(deps: SlidesToolDeps): McpToolDefinition[] {
  return [
    // headless generation is opt-in, same rule as create_docx
    ...(deps.background === false ? [] : [createHeadlessPptxTool(deps)]),
    ...createDeckSessionTools(deps),
  ]
}

/**
 * Visible-deck session: build a presentation inside a real GenOffice slides tab
 * so the user watches each page take shape, then write it to a chosen path. The
 * control mutates the main-process session (the same one the app's own editing
 * and built-in AI use), so every step lands in the app's undo history and the
 * tab re-renders live.
 *
 * Only registered when the shell wired a SlidesControl — headless/unit runs
 * keep the file-only surface.
 */
function createDeckSessionTools(deps: SlidesToolDeps): McpToolDefinition[] {
  const slides = deps.slides
  if (!slides) return []

  /** the tab the current visible session edits; one session at a time */
  let activeDeckWc: number | null = null

  const requireActive = (): number => {
    if (activeDeckWc === null) {
      throw new Error('no deck is open — call create_deck first')
    }
    return activeDeckWc
  }

  return [
    {
      name: 'create_deck',
      description:
        'Open a new empty presentation in a visible GenOffice tab and start an editing session. ' +
        'Follow it with apply_slide_ops to build the slides, then save_deck to write the file. ' +
        'The user sees each step happen in the app.',
      inputSchema: {},
      handler: async () => {
        activeDeckWc = await slides.openBlankTab()
        return {
          ok: true,
          deckId: activeDeckWc,
          message: 'A new empty presentation is open in GenOffice. Build slides, then call save_deck.',
        }
      },
    },
    {
      name: 'read_deck',
      description:
        'Read the visible presentation: every slide with its elements (ids, types, text, geometry) ' +
        'so you can target follow-up edits. Element ids and slide indexes are what apply_slide_ops ' +
        'addresses; geometry is document-space EMU (1 px = 9525 EMU on a standard 16:9 deck).',
      inputSchema: {},
      handler: async () => slides.readDeck(requireActive()),
    },
    {
      name: 'apply_slide_ops',
      description:
        'Apply slide editing ops to the visible presentation as one transaction (atomic by default, ' +
        'plan-validated with snapshot rollback; per_op isolation skips failures instead). Ops address ' +
        '{slide, el} and use document-space EMU. Common ops: setText, setFont, setParagraphFormat, ' +
        'addElement (textbox/shapes/lines), addTable, addChart, addBlankSlide, deleteSlide, moveSlide, ' +
        'duplicateSlide, deleteElement, setFill, setStroke, setTransform, setBackground, applyTheme, ' +
        'findReplace, setTableCell, tableStructure, setTransition, setNotes. A failing atomic batch ' +
        'changes nothing — fix the op named in the error and resend the whole batch. ' +
        'Use read_deck for ids and geometry first.',
      inputSchema: {
        ops: z
          .array(z.any())
          .describe('array of op objects (at most 50 per transaction)')
          .max(50),
        isolation: z
          .enum(['atomic', 'per_op'])
          .optional()
          .describe('atomic (default) applies all-or-nothing; per_op applies independently'),
        dryRun: z
          .boolean()
          .optional()
          .describe('validate and plan the batch without changing the deck'),
      },
      handler: async (args) => {
        const wc = requireActive()
        const result = (await slides.runTxn(wc, {
          ops: (Array.isArray(args.ops) ? args.ops : []) as unknown[],
          isolation:
            args.isolation === 'per_op' || args.isolation === 'atomic' ? args.isolation : undefined,
          dryRun: args.dryRun === true,
        })) as { applied?: boolean; failures?: Array<{ index: number; error: string }> }
        // a rejected transaction is a tool-level error so the caller reacts to it;
        // dry-run results (plan + failures) stay a normal response
        if (result?.applied === false && args.dryRun !== true) {
          const details = (result.failures ?? []).map((f) => `[${f.index}] ${f.error}`).join('\n')
          throw new Error(details || 'the transaction could not be applied')
        }
        return result
      },
    },
    {
      name: 'save_deck',
      description:
        'Save the visible presentation to an absolute path and stop the editing session. ' +
        'Refuses to replace an existing file unless overwrite is true. This is the output step.',
      inputSchema: {
        path: z.string().describe('absolute output path for the .pptx file'),
        overwrite: z
          .boolean()
          .optional()
          .describe('allow replacing an existing file at `path`; default false'),
      },
      handler: async (args) => {
        const wc = requireActive()
        const filePath = String(args.path ?? '')
        if (!isAbsolute(filePath)) throw new Error('path must be absolute')
        const result = await slides.saveDeck(wc, filePath, args.overwrite === true)
        activeDeckWc = null
        return result
      },
    },
  ]
}
