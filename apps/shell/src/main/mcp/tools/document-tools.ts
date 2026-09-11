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
  ]
}

/** exported for tests */
export const __internal = { resolveTargetPath }
