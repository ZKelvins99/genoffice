import { lexer, type Token, type Tokens } from 'marked'
import {
  BLANK_BULLET_NUM_ID,
  TABLE_HEADER_FILL,
  generateTableModelXml,
  type GeneratedBlock,
  type ParaFormat,
  type Run,
  type SaveBlock,
  type SaveOptions,
  type TableCell,
  type TableModel,
  type TableParagraph,
} from '@genoffice/docx-engine'

/**
 * Markdown -> docx-engine SaveBlock[] (MCP generation path).
 *
 * Pure and DOM-free: it runs in the Electron main process, and is the phase-1
 * answer to "an external agent sends markdown, GenOffice returns a .docx". It
 * mirrors the formatting choices of the Markdown app's exporter
 * (apps/markdown/src/renderer/export/docxExport.ts) so both paths produce the
 * same look, but consumes marked tokens instead of Tiptap JSON.
 *
 * The engine's blank template supplies the styles and the bullet/decimal
 * numbering definitions; ordered lists get a fresh numId each so every list
 * restarts at 1 (see `restartNums` in the returned options).
 */

const MAX_LIST_LEVEL = 4
const INDENT_STEP = 360
/** decimal abstractNum of the blank template (blank.ts: numId 2 -> abstractNumId 1) */
const DECIMAL_ABSTRACT_NUM_ID = '1'
const CODE_FONT = 'Consolas'
const CODE_FILL = 'F2F3F5'

export interface MarkdownMapping {
  blocks: SaveBlock[]
  options: SaveOptions
}

interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  /** run carries the code font */
  code?: boolean
  /** hex without '#', e.g. the image-placeholder grey */
  color?: string
  link?: { href: string; tooltip?: string }
}

interface WalkContext {
  blocks: SaveBlock[]
  restartNums: NonNullable<NonNullable<SaveOptions['numbering']>['restartNums']>
  nextOrderedNumId: number
}

function mergeFormat(base: ParaFormat | undefined, extra: ParaFormat): ParaFormat {
  return { ...base, ...extra, indentLeft: (base?.indentLeft ?? 0) + (extra.indentLeft ?? 0) }
}

function styledRun(text: string, style: InlineStyle): Run {
  const run: Run = { text }
  if (style.bold) run.bold = true
  if (style.italic) run.italic = true
  if (style.strike) run.strike = true
  if (style.code) run.font = CODE_FONT
  if (style.color) run.color = style.color
  if (style.link)
    run.link = {
      href: style.link.href,
      ...(style.link.tooltip ? { tooltip: style.link.tooltip } : {}),
    }
  return run
}

/** inline token list -> styled Run[] (recursive over strong/em/del/link) */
function inlineToRuns(tokens: Token[] | undefined, style: InlineStyle = {}): Run[] {
  const runs: Run[] = []
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const text = token.text
        if (text) runs.push(styledRun(text, style))
        // a text token may itself wrap inline tokens (list-item content)
        if ('tokens' in token && token.tokens) runs.push(...inlineToRuns(token.tokens, style))
        break
      }
      case 'strong':
        runs.push(...inlineToRuns(token.tokens, { ...style, bold: true }))
        break
      case 'em':
        runs.push(...inlineToRuns(token.tokens, { ...style, italic: true }))
        break
      case 'del':
        runs.push(...inlineToRuns(token.tokens, { ...style, strike: true }))
        break
      case 'codespan':
        runs.push(styledRun(token.text, { ...style, code: true }))
        break
      case 'link':
        runs.push(
          ...inlineToRuns(token.tokens, {
            ...style,
            link: { href: token.href, tooltip: token.title ?? undefined },
          }),
        )
        break
      case 'br':
        runs.push({ text: '\n' })
        break
      case 'image':
        // phase 1 does not fetch images: keep the alt text visible (same fallback
        // the Markdown exporter uses when an image cannot be loaded)
        runs.push(styledRun(`[${token.text || token.href}]`, { italic: true, color: '888888' }))
        break
      case 'html':
        if (token.text) runs.push(styledRun(token.text, style))
        break
      default: {
        const text = (token as { text?: string }).text
        if (text) runs.push(styledRun(text, style))
      }
    }
  }
  return runs
}

function pushParagraph(ctx: WalkContext, block: GeneratedBlock): void {
  ctx.blocks.push({ kind: 'generated', block })
}

function allocOrderedNumId(ctx: WalkContext): string {
  const numId = String(ctx.nextOrderedNumId++)
  ctx.restartNums.push({
    numId,
    abstractNumId: DECIMAL_ABSTRACT_NUM_ID,
    startOverrides: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1 },
  })
  return numId
}

/** cell content -> rich paragraphs (bold/italic inline preserved) */
function cellParagraphs(tokens: Token[] | undefined): TableParagraph[] {
  const runs = inlineToRuns(tokens)
  return [{ runs }]
}

function mapTable(token: Tokens.Table): TableModel {
  const cellsFor = (row: Tokens.TableCell[], header: boolean): TableCell[] =>
    row.map((cell, i) => {
      const rich = cellParagraphs(cell.tokens)
      const align = token.align?.[i] ?? undefined
      return {
        paras: rich.map((p) => p.runs.map((r) => r.text).join('')),
        richParas: rich,
        ...(align ? { align } : {}),
        ...(header ? { bold: true, fill: TABLE_HEADER_FILL } : {}),
      }
    })

  const rows: TableCell[][] = [cellsFor(token.header, true)]
  for (const row of token.rows) rows.push(cellsFor(row, false))
  return { rows }
}

/** block tokens (list item children / blockquote children) -> blocks */
function walkBlocks(ctx: WalkContext, tokens: Token[] | undefined, base?: ParaFormat): void {
  for (const token of tokens ?? []) walkBlock(ctx, token, base)
}

function walkList(ctx: WalkContext, token: Tokens.List, ilvl: number, base?: ParaFormat): void {
  const level = Math.min(ilvl, MAX_LIST_LEVEL)
  const ordered = token.ordered
  // one numId per ordered list so separate lists each restart at 1
  const numId = ordered ? allocOrderedNumId(ctx) : BLANK_BULLET_NUM_ID
  const kind = ordered ? ('ordered' as const) : ('bullet' as const)

  for (const item of token.items) {
    let firstBlock = true
    for (const child of item.tokens) {
      if (child.type === 'list') {
        walkList(ctx, child as Tokens.List, level + 1, base)
        firstBlock = false
        continue
      }
      if (child.type === 'space') continue

      // the item's own text becomes the list paragraph; anything else nests under it
      const childRuns =
        child.type === 'text'
          ? inlineToRuns('tokens' in child && child.tokens ? child.tokens : undefined)
          : child.type === 'paragraph'
            ? inlineToRuns(child.tokens)
            : undefined

      if (firstBlock && childRuns) {
        const runs = item.task ? [{ text: item.checked ? '☑ ' : '☐ ' }, ...childRuns] : childRuns
        pushParagraph(ctx, {
          type: 'listItem',
          list: { kind, numId, ilvl: level },
          runs,
          format: base,
        })
        firstBlock = false
      } else if (childRuns) {
        pushParagraph(ctx, {
          type: 'paragraph',
          runs: childRuns,
          format: mergeFormat(base, { indentLeft: INDENT_STEP * (level + 1) }),
        })
      } else {
        walkBlock(ctx, child, mergeFormat(base, { indentLeft: INDENT_STEP * (level + 1) }))
      }
    }
    // an empty item still needs a marker so the list does not collapse
    if (firstBlock) {
      pushParagraph(ctx, {
        type: 'listItem',
        list: { kind, numId, ilvl: level },
        runs: [],
        format: base,
      })
    }
  }
}

function walkBlock(ctx: WalkContext, token: Token, base?: ParaFormat): void {
  switch (token.type) {
    case 'heading': {
      const level = Math.min(Math.max(token.depth || 1, 1), 6)
      pushParagraph(ctx, { type: 'heading', level, runs: inlineToRuns(token.tokens), format: base })
      break
    }
    case 'paragraph':
      pushParagraph(ctx, { type: 'paragraph', runs: inlineToRuns(token.tokens), format: base })
      break
    case 'text':
      // loose-list item content
      pushParagraph(ctx, { type: 'paragraph', runs: inlineToRuns(token.tokens), format: base })
      break
    case 'list':
      walkList(ctx, token as Tokens.List, 0, base)
      break
    case 'blockquote':
      walkBlocks(ctx, token.tokens, mergeFormat(base, { indentLeft: INDENT_STEP, borders: 'l' }))
      break
    case 'code': {
      const text = token.text.replace(/\n$/, '')
      pushParagraph(ctx, {
        type: 'paragraph',
        runs: [{ text, font: CODE_FONT, sizeHalfPoints: 19 }],
        format: mergeFormat(base, { shadingFill: CODE_FILL }),
      })
      break
    }
    case 'hr':
      pushParagraph(ctx, {
        type: 'paragraph',
        runs: [],
        format: mergeFormat(base, { borders: 'b' }),
      })
      break
    case 'table':
      ctx.blocks.push({ kind: 'xml', xml: generateTableModelXml(mapTable(token as Tokens.Table)) })
      break
    case 'space':
      break
    default: {
      // unknown block: keep its text so nothing silently disappears
      const text = (token as { text?: string }).text
      if (text?.trim()) pushParagraph(ctx, { type: 'paragraph', runs: [{ text }], format: base })
    }
  }
}

/** Markdown source -> SaveBlock[] plus the numbering options saveDocx needs. */
export function markdownToSaveBlocks(markdown: string): MarkdownMapping {
  const ctx: WalkContext = { blocks: [], restartNums: [], nextOrderedNumId: 100 }
  const tokens = lexer(markdown, { gfm: true })
  walkBlocks(ctx, tokens)

  // an empty document still needs one paragraph so the file opens with a caret
  if (ctx.blocks.length === 0) {
    ctx.blocks.push({ kind: 'generated', block: { type: 'paragraph', runs: [] } })
  }

  const options: SaveOptions =
    ctx.restartNums.length > 0 ? { numbering: { restartNums: ctx.restartNums } } : {}
  return { blocks: ctx.blocks, options }
}
