import { describe, expect, it } from 'vitest'
import { parseDocx } from '@genoffice/docx-engine'
import { createDocxBytes, readDocxText } from '../../src/main/mcp/doc-generation'

/**
 * M1: markdown -> docx bytes, verified by reparsing. Every assertion goes
 * through parseDocx, so it checks what Word would actually see, not the
 * intermediate SaveBlock shape.
 */

const MD = [
  '# Quarterly Report',
  '',
  'A paragraph with **bold**, *italic*, ~~strike~~ and `code`, plus a [link](https://example.com).',
  '',
  '## Details',
  '',
  '- first bullet',
  '- second bullet',
  '  - nested bullet',
  '',
  '1. step one',
  '2. step two',
  '',
  '> A quoted line.',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '---',
  '',
  '| Metric | Value |',
  '| --- | ---: |',
  '| Revenue | 100 |',
  '| Cost | 60 |',
].join('\n')

async function generate(md: string) {
  const bytes = await createDocxBytes({ content: md })
  const parsed = await parseDocx(bytes)
  return { bytes, visible: parsed.blocks.filter((b) => !b.hidden) }
}

describe('markdown -> docx generation', () => {
  it('produces a non-empty docx that reparses', async () => {
    const { bytes, visible } = await generate(MD)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(visible.length).toBeGreaterThan(0)
  })

  it('maps headings with their level', async () => {
    const { visible } = await generate(MD)
    const headings = visible.filter((b) => b.type === 'heading')
    expect(headings.map((h) => h.level)).toEqual([1, 2])
    expect(headings[0].runs?.map((r) => r.text).join('')).toBe('Quarterly Report')
  })

  it('applies bold / italic / strike / inline-code marks', async () => {
    const { visible } = await generate(MD)
    const para = visible.find(
      (b) => b.type === 'paragraph' && b.runs?.some((r) => r.text === 'bold'),
    )
    expect(para).toBeDefined()
    const runs = para!.runs!
    expect(runs.some((r) => r.bold && r.text === 'bold')).toBe(true)
    expect(runs.some((r) => r.italic && r.text === 'italic')).toBe(true)
    expect(runs.some((r) => r.strike && r.text === 'strike')).toBe(true)
    expect(runs.some((r) => r.font === 'Consolas' && r.text === 'code')).toBe(true)
  })

  it('keeps link text with its href', async () => {
    const { visible } = await generate(MD)
    const linkRun = visible.flatMap((b) => ('runs' in b ? (b.runs ?? []) : [])).find((r) => r.link)
    expect(linkRun?.text).toBe('link')
    expect(linkRun?.link?.href).toBe('https://example.com')
  })

  it('maps bullet and ordered lists, with nesting', async () => {
    const { visible } = await generate(MD)
    const bullets = visible.filter((b) => b.type === 'listItem' && b.list?.kind === 'bullet')
    const ordered = visible.filter((b) => b.type === 'listItem' && b.list?.kind === 'ordered')
    expect(bullets.length).toBe(3) // two top-level + one nested
    expect(ordered.length).toBe(2)
    expect(bullets.some((b) => (b.list?.ilvl ?? 0) > 0)).toBe(true)
  })

  it('maps a code block with the monospace font', async () => {
    const { visible } = await generate(MD)
    const code = visible.find((b) =>
      b.runs?.some((r) => r.font === 'Consolas' && r.text.includes('const x')),
    )
    expect(code).toBeDefined()
  })

  it('maps a blockquote and a horizontal rule', async () => {
    const { visible } = await generate(MD)
    expect(visible.some((b) => b.format?.borders === 'l')).toBe(true)
    expect(visible.some((b) => b.format?.borders === 'b')).toBe(true)
  })

  it('maps a GFM table into a table block', async () => {
    const { visible } = await generate(MD)
    const table = visible.find((b) => b.type === 'table')
    expect(table).toBeDefined()
    const flat = JSON.stringify(table)
    expect(flat).toContain('Metric')
    expect(flat).toContain('Revenue')
  })

  it('falls back to a single empty paragraph for empty markdown', async () => {
    const { visible } = await generate('')
    expect(visible.length).toBeGreaterThanOrEqual(1)
  })

  it('round-trips text through readDocxText', async () => {
    const bytes = await createDocxBytes({ content: '# Hello\n\nWorld paragraph.' })
    const text = await readDocxText(bytes)
    expect(text).toContain('Hello')
    expect(text).toContain('World paragraph.')
  })

  it('accepts pre-built SaveBlock JSON', async () => {
    const bytes = await createDocxBytes({
      format: 'blocks',
      content: [
        {
          kind: 'generated',
          block: { type: 'heading', level: 1, runs: [{ text: 'From blocks' }] },
        },
        { kind: 'generated', block: { type: 'paragraph', runs: [{ text: 'body', bold: true }] } },
      ],
    })
    const parsed = await parseDocx(bytes)
    const visible = parsed.blocks.filter((b) => !b.hidden)
    expect(visible[0].type).toBe('heading')
    expect(visible[1].runs?.some((r) => r.bold && r.text === 'body')).toBe(true)
  })
})
