import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parseDocx } from '@genoffice/docx-engine'
import { McpServerService } from '../../src/main/mcp/mcp-server'
import {
  createDocumentTools,
  resolveTargetPath,
  sanitizeFileBase,
} from '../../src/main/mcp/tools/document-tools'

/**
 * M3: the docx tool surface over a real MCP session. Files are written to a
 * temp dir that stands in for the app default save folder.
 */

let service: McpServerService | undefined
let dir: string
let client: Client | undefined
let opened: string[]

async function freePort(): Promise<number> {
  const { createServer } = await import('node:http')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'genoffice-mcp-'))
  opened = []
  const port = await freePort()
  service = new McpServerService({
    port,
    tools: createDocumentTools({
      version: '0.9.0-test',
      defaultSaveDir: () => dir,
      openInTab: (filePath) => {
        opened.push(filePath)
      },
    }),
  })
  await service.start()
  client = new Client({ name: 'm3-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
})

afterEach(async () => {
  await client?.close()
  client = undefined
  await service?.stop()
  service = undefined
  await rm(dir, { recursive: true, force: true })
})

function text(content: unknown): string {
  const arr = content as Array<{ type: string; text?: string }>
  return arr.map((c) => c.text ?? '').join('')
}

describe('M3 docx tools', () => {
  it('exposes exactly the phase-1 tools', async () => {
    const { tools } = await client!.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_docx',
      'get_app_info',
      'open_in_genoffice',
      'read_docx',
    ])
  })

  it('create_docx writes a reparsable file into the default dir', async () => {
    const result = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Meeting Notes', content: '# Agenda\n\n- item one\n- item two' },
    })
    expect(result.isError).toBeFalsy()

    const payload = JSON.parse(text(result.content)) as { path: string }
    expect(existsSync(payload.path)).toBe(true)
    expect(payload.path.startsWith(dir)).toBe(true)

    const parsed = await parseDocx(new Uint8Array(await readFile(payload.path)))
    const visible = parsed.blocks.filter((b) => !b.hidden)
    expect(visible[0].type).toBe('heading')
    expect(visible[1].type).toBe('listItem')
  })

  it('create_docx avoids clobbering an existing file', async () => {
    const first = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Report', content: 'one' },
    })
    const second = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Report', content: 'two' },
    })
    const p1 = JSON.parse(text(first.content)).path as string
    const p2 = JSON.parse(text(second.content)).path as string
    expect(p1).not.toBe(p2)
    expect(p2).toContain('Report-2')
  })

  it('create_docx rejects overwriting an explicit path unless asked', async () => {
    const target = join(dir, 'explicit.docx')
    await writeFile(target, 'placeholder')

    const refused = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'x', content: 'hi', path: target },
    })
    expect(refused.isError).toBe(true)
    expect(text(refused.content)).toContain('already exists')

    const allowed = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'x', content: 'hi', path: target, overwrite: true },
    })
    expect(allowed.isError).toBeFalsy()
    const parsed = await parseDocx(new Uint8Array(await readFile(target)))
    expect(parsed.blocks.filter((b) => !b.hidden).length).toBeGreaterThan(0)
  })

  it('create_docx accepts blocks JSON', async () => {
    const blocks = JSON.stringify([
      { kind: 'generated', block: { type: 'heading', level: 1, runs: [{ text: 'Blocks title' }] } },
    ])
    const result = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Blocks', content: blocks, format: 'blocks' },
    })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(text(result.content)) as { path: string }
    const parsed = await parseDocx(new Uint8Array(await readFile(payload.path)))
    expect(parsed.blocks.filter((b) => !b.hidden)[0].type).toBe('heading')
  })

  it('create_docx reports malformed blocks JSON as a tool error', async () => {
    const result = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Bad', content: '{not json', format: 'blocks' },
    })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('JSON')
  })

  it('read_docx returns the text of a generated file', async () => {
    const created = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Readable', content: '# Title\n\nBody text here.' },
    })
    const { path } = JSON.parse(text(created.content)) as { path: string }

    const result = await client!.callTool({ name: 'read_docx', arguments: { path } })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(text(result.content)) as { text: string }
    expect(payload.text).toContain('Title')
    expect(payload.text).toContain('Body text here.')
  })

  it('read_docx rejects a missing file and a non-docx extension', async () => {
    const missing = await client!.callTool({
      name: 'read_docx',
      arguments: { path: join(dir, 'nope.docx') },
    })
    expect(missing.isError).toBe(true)

    const wrongExt = await client!.callTool({
      name: 'read_docx',
      arguments: { path: join(dir, 'x.txt') },
    })
    expect(wrongExt.isError).toBe(true)
  })

  it('open_in_genoffice calls the injected opener', async () => {
    const created = await client!.callTool({
      name: 'create_docx',
      arguments: { title: 'Open', content: 'x' },
    })
    const { path } = JSON.parse(text(created.content)) as { path: string }

    const result = await client!.callTool({ name: 'open_in_genoffice', arguments: { path } })
    expect(result.isError).toBeFalsy()
    expect(opened).toEqual([path])
  })

  it('get_app_info reports version, save dir and formats', async () => {
    const result = await client!.callTool({ name: 'get_app_info', arguments: {} })
    const payload = JSON.parse(text(result.content)) as {
      version: string
      defaultSaveDir: string
      formats: string[]
    }
    expect(payload.version).toBe('0.9.0-test')
    expect(payload.defaultSaveDir).toBe(dir)
    expect(payload.formats).toEqual(['docx'])
  })
})

describe('path policy helpers', () => {
  it('sanitizes illegal filename characters', () => {
    expect(sanitizeFileBase('a/b:c*d?')).toBe('a_b_c_d_')
    expect(sanitizeFileBase('   ')).toBe('Untitled')
    expect(sanitizeFileBase('...')).toBe('Untitled')
  })

  it('rejects a relative explicit path', () => {
    expect(() =>
      resolveTargetPath({ version: 'x', defaultSaveDir: () => dir }, 't', 'relative.docx'),
    ).toThrow(/absolute/)
  })
})
