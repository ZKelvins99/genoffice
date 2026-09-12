import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpLogger } from '../../src/main/mcp/mcp-logger'

/** the MCP server's local log: bounded ring + append-only file under userData */

let dir: string
let logPath: string
let logger: McpLogger

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'genoffice-mcp-log-'))
  logPath = join(dir, 'mcp-log.txt')
  logger = new McpLogger(logPath)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('McpLogger', () => {
  it('appends timestamped lines to the file and returns them from recent()', () => {
    logger.append('[mcp] listening on http://127.0.0.1:3093')
    logger.append('[mcp] tool create_docx ok (12ms)')

    const lines = logger.recent()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('[mcp] tool create_docx ok (12ms)')
    // local-time timestamp prefix (YYYY-MM-DD HH:mm:ss.SSS)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/)

    const onDisk = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    expect(onDisk).toHaveLength(2)
  })

  it('timestamps are device-local wall-clock time, not UTC', () => {
    logger.append('tz check')
    const line = logger.recent()[0] ?? ''
    const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line)
    expect(m, line).not.toBeNull()
    // interpreting the stamp in the device timezone lands ~now; a UTC ISO
    // stamp (the old format) drifts by the timezone offset here
    const parsed = new Date(
      Number(m![1]),
      Number(m![2]) - 1,
      Number(m![3]),
      Number(m![4]),
      Number(m![5]),
      Number(m![6]),
      Number(m![7]),
    )
    expect(Math.abs(parsed.getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('recent() prefers the file contents and caps the tail', () => {
    for (let i = 0; i < 30; i++) logger.append(`line ${i}`)
    const tail = logger.recent(10)
    expect(tail).toHaveLength(10)
    expect(tail[0]).toContain('line 20')
    expect(tail[9]).toContain('line 29')
  })

  it('recent() falls back to the ring when the file is missing', () => {
    logger.append('[mcp] only in memory')
    const stale = new McpLogger(join(dir, 'other.txt'))
    expect(stale.recent()).toEqual([])
  })

  it('clear() truncates the file and the ring', () => {
    logger.append('one')
    logger.clear()
    expect(logger.recent()).toEqual([])
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toBe('')
  })

  it('ensureFile() creates an empty file so reveal has a target', () => {
    expect(existsSync(logPath)).toBe(false)
    logger.ensureFile()
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toBe('')
  })
})
