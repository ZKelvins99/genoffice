import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
} from '@genoffice/docx-engine'
import { markdownToSaveBlocks } from './markdown-to-blocks'

/**
 * Headless docx generation for the MCP server.
 *
 * Everything here is a pure function over bytes: no DOM, no Electron, no
 * filesystem. The MCP tool layer owns path policy and disk writes, so this
 * module stays trivially testable (see apps/shell/tests/mcp).
 */

export type DocxSourceFormat = 'markdown' | 'blocks'

export interface CreateDocxInput {
  /** markdown by default; 'blocks' accepts docx-engine SaveBlock-shaped JSON */
  format?: DocxSourceFormat
  content: string | SaveBlock[]
}

/**
 * Build a fresh .docx from markdown (default) or pre-built SaveBlock[].
 *
 * The recipe is the engine's own: parse the blank template, then append
 * generated blocks. `buildBlankDocx` provides the styles and the bullet and
 * decimal numbering definitions the markdown mapper references.
 */
export async function createDocxBytes(input: CreateDocxInput): Promise<Uint8Array> {
  const parsed = await parseDocx(await buildBlankDocx())

  let blocks: SaveBlock[]
  let options: SaveOptions = {}
  if (input.format === 'blocks') {
    blocks = Array.isArray(input.content) ? input.content : []
  } else {
    const mapped = markdownToSaveBlocks(typeof input.content === 'string' ? input.content : '')
    blocks = mapped.blocks
    options = mapped.options
  }

  return saveDocx(parsed, blocks, options)
}

/** Extract the visible text of a .docx (one paragraph per line). */
export async function readDocxText(bytes: Uint8Array): Promise<string> {
  const parsed: ParsedDocFull = await parseDocx(bytes)
  const lines: string[] = []
  for (const block of parsed.blocks) {
    if (block.hidden) continue
    const runs = ('runs' in block ? block.runs : undefined) ?? []
    const text = runs.map((run) => run.text).join('')
    if (text) lines.push(text)
  }
  return lines.join('\n')
}
