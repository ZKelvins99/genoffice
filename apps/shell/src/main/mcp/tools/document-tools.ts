import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../../../../docs/src/main/atomic-write'
import { createDocxBytes, readDocxText, type DocxSourceFormat } from '../doc-generation'
import type { McpToolDefinition } from '../mcp-server'

/**
 * Phase-1 MCP tool surface: docx generation and reading.
 *
 * The tool layer owns path policy and disk I/O; generation itself lives in
 * doc-generation.ts. Dependencies are injected so this module stays free of
 * Electron and is unit-testable in a plain Node environment (M4 wires the real
 * default save dir and the "open in a tab" action).
 */

export interface DocToolDeps {
  version: string
  /** directory generated files land in when the caller gives no path */
  defaultSaveDir: () => string
  /** open a file in the GenOffice UI; wired in M4 (optional in tests) */
  openInTab?: (filePath: string) => Promise<void> | void
  /** visible-editor control for the MCP-driven document session (optional in tests) */
  docs?: DocsControl
}

/** editor commands the docs renderer bridge understands (see docs shared/ipc.ts) */
export type McpEditorCommandName =
  'insert_content' | 'replace_blocks' | 'apply_ops' | 'read_document' | 'save_document'

/**
 * Visible-editor control: opens a docs tab and pushes editor commands into it,
 * so an external agent builds/edits a document the user can watch instead of
 * writing bytes behind the UI. Implemented in the shell main process
 * (`apps/shell/src/main/mcp/docs-bridge.ts`).
 */
export interface DocsControl {
  /** open a fresh blank docs tab; resolves to its webContents id */
  openBlankTab: () => Promise<number>
  /** run one editor command in that tab and resolve its result */
  runCommand: (wcId: number, command: McpEditorCommandName, payload: unknown) => Promise<unknown>
}

const DOCX_EXT = '.docx'

/** sanitize a title into a file base name (mirrors docs' sanitizeAiDocFileBase) */
export function sanitizeFileBase(title: string): string {
  const cleaned = String(title ?? '')
    // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80)
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Untitled'
}

/** first free path for fileName inside dir: name.docx, name-2.docx, … */
export function uniquePathIn(dir: string, fileName: string): string {
  const ext = extname(fileName)
  const base = fileName.slice(0, fileName.length - ext.length)
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`)
  return candidate
}

export function resolveTargetPath(
  deps: DocToolDeps,
  title: string,
  requestedPath?: string,
  overwrite = false,
): string {
  const fileName = `${sanitizeFileBase(title)}${DOCX_EXT}`
  if (!requestedPath) return uniquePathIn(deps.defaultSaveDir(), fileName)

  if (!isAbsolute(requestedPath)) {
    throw new Error('path must be absolute')
  }
  const finalPath =
    extname(requestedPath).toLowerCase() === DOCX_EXT
      ? requestedPath
      : `${requestedPath}${DOCX_EXT}`
  if (existsSync(finalPath) && !overwrite) {
    throw new Error(`file already exists: ${finalPath} (pass overwrite:true to replace it)`)
  }
  return finalPath
}

export function createDocumentTools(deps: DocToolDeps): McpToolDefinition[] {
  return [
    {
      name: 'create_docx',
      description:
        'Create a Word .docx file from content and save it to disk. By default `content` is Markdown ' +
        "(headings, lists, bold/italic, links, code blocks, tables) and is converted by GenOffice's own " +
        'docx engine. Use format:"blocks" to pass docx-engine SaveBlock objects instead. ' +
        'Returns the absolute path of the written file.',
      inputSchema: {
        title: z.string().describe('document title, used as the file name'),
        content: z
          .string()
          .describe(
            'Markdown source (default) or a JSON string of SaveBlock[] when format is "blocks"',
          ),
        format: z
          .enum(['markdown', 'blocks'])
          .optional()
          .describe('content format; default markdown'),
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

        const format: DocxSourceFormat = args.format === 'blocks' ? 'blocks' : 'markdown'
        let content: string | unknown[]
        if (format === 'blocks') {
          try {
            const parsed =
              typeof args.content === 'string' ? JSON.parse(args.content) : args.content
            if (!Array.isArray(parsed)) throw new Error('blocks content must be an array')
            content = parsed
          } catch (error) {
            throw new Error(
              `format "blocks" requires content to be a JSON array: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
        } else {
          content = String(args.content ?? '')
        }

        const targetPath = resolveTargetPath(
          deps,
          title,
          typeof args.path === 'string' ? args.path : undefined,
          args.overwrite === true,
        )
        const bytes = await createDocxBytes({ format, content: content as string })
        await atomicWriteFile(targetPath, Buffer.from(bytes))
        return { path: targetPath, bytes: bytes.byteLength }
      },
    },
    {
      name: 'read_docx',
      description: 'Read a Word .docx file and return its visible text (one paragraph per line).',
      inputSchema: {
        path: z.string().describe('absolute path to a .docx file'),
      },
      handler: async (args) => {
        const filePath = String(args.path ?? '')
        if (!isAbsolute(filePath)) throw new Error('path must be absolute')
        if (extname(filePath).toLowerCase() !== DOCX_EXT)
          throw new Error('path must point to a .docx file')
        if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`)
        const text = await readDocxText(new Uint8Array(await readFile(filePath)))
        return { path: filePath, name: basename(filePath), text }
      },
    },
    {
      name: 'open_in_genoffice',
      description: 'Open an existing file in the running GenOffice app, focusing its tab.',
      inputSchema: {
        path: z.string().describe('absolute path to the file to open'),
      },
      handler: async (args) => {
        const filePath = String(args.path ?? '')
        if (!isAbsolute(filePath)) throw new Error('path must be absolute')
        if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`)
        if (!deps.openInTab) throw new Error('opening files is not available in this build')
        await deps.openInTab(filePath)
        return { ok: true, path: filePath }
      },
    },
    {
      name: 'get_app_info',
      description:
        'Report GenOffice version, the default save folder, and the document formats this server can generate.',
      inputSchema: {},
      handler: () => ({
        name: 'GenOffice',
        version: deps.version,
        defaultSaveDir: deps.defaultSaveDir(),
        formats: ['docx'],
      }),
    },
    ...createVisibleTools(deps),
  ]
}

/**
 * Visible-editing tools: build a document inside a real GenOffice tab so the
 * user watches it take shape, then write it to a chosen path. These reuse the
 * built-in agent's editor pipeline (the same restricted-HTML parser, ops
 * executor and save path), so the result matches what the in-app AI produces.
 *
 * Only registered when the shell wired a DocsControl — headless/unit runs keep
 * the phase-1 file-only surface.
 */
function createVisibleTools(deps: DocToolDeps): McpToolDefinition[] {
  const docs = deps.docs
  if (!docs) return []

  /** the tab the current visible session edits; one session at a time */
  let activeDocWc: number | null = null

  const requireActive = (): number => {
    if (activeDocWc === null) {
      throw new Error('no document is open — call create_document first')
    }
    return activeDocWc
  }

  return [
    {
      name: 'create_document',
      description:
        'Open a new empty Word document in a visible GenOffice tab and start an editing session. ' +
        'Follow it with insert_content / replace_blocks / apply_ops to write and format the document, ' +
        'then save_document to write it to a path. The user sees each step happen in the app.',
      inputSchema: {},
      handler: async () => {
        activeDocWc = await docs.openBlankTab()
        return {
          ok: true,
          documentId: activeDocWc,
          message:
            'A new empty document is open in GenOffice. Add content, then call save_document.',
        }
      },
    },
    {
      name: 'insert_content',
      description:
        'Insert content into the visible document as HTML (headings, paragraphs, bold/italic, lists, ' +
        'tables, links). Appends at the end unless afterBlockIndex is given.',
      inputSchema: {
        html: z.string().describe('restricted HTML fragment to insert'),
        afterBlockIndex: z
          .number()
          .int()
          .optional()
          .describe('insert after this block index; default appends at the end'),
      },
      handler: async (args) => {
        const wc = requireActive()
        return docs.runCommand(wc, 'insert_content', args)
      },
    },
    {
      name: 'replace_blocks',
      description:
        'Replace a range of blocks in the visible document with new HTML content. ' +
        'Use read_document to learn block indexes.',
      inputSchema: {
        startBlockIndex: z.number().int().describe('first block index to replace (inclusive)'),
        endBlockIndex: z.number().int().describe('last block index to replace (inclusive)'),
        html: z.string().describe('restricted HTML fragment the range is replaced with'),
      },
      handler: async (args) => {
        const wc = requireActive()
        return docs.runCommand(wc, 'replace_blocks', args)
      },
    },
    {
      name: 'apply_ops',
      description:
        'Apply formatting commands to the visible document (font, paragraph format, heading level, ' +
        'find/replace, list/indent, etc.). `ops` is the same batch format the built-in AI editor accepts; ' +
        'the whole batch is atomic. Use read_document for block indexes.',
      inputSchema: {
        ops: z.array(z.any()).describe('array of op objects'),
        dryRun: z
          .boolean()
          .optional()
          .describe('validate and plan the batch without changing the document'),
      },
      handler: async (args) => {
        const wc = requireActive()
        return docs.runCommand(wc, 'apply_ops', {
          ops: args.ops,
          dryRun: args.dryRun === true,
        })
      },
    },
    {
      name: 'read_document',
      description:
        'Read the visible document: its blocks with indexes, text and current formatting, so you can ' +
        'target follow-up edits.',
      inputSchema: {},
      handler: async () => {
        const wc = requireActive()
        return docs.runCommand(wc, 'read_document', {})
      },
    },
    {
      name: 'save_document',
      description:
        'Save the visible document to an absolute path and stop the editing session. ' +
        'Refuses to replace an existing file unless overwrite is true. This is the output step.',
      inputSchema: {
        path: z.string().describe('absolute output path for the .docx file'),
        overwrite: z
          .boolean()
          .optional()
          .describe('allow replacing an existing file at `path`; default false'),
      },
      handler: async (args) => {
        const wc = requireActive()
        const payload = { path: String(args.path ?? ''), overwrite: args.overwrite === true }
        const result = await docs.runCommand(wc, 'save_document', payload)
        activeDocWc = null
        return result
      },
    },
  ]
}

/** exported for tests */
export const __internal = { resolveTargetPath }
