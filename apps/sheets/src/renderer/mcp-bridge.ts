import type { McpCommandMessage } from '../shared/desktop-api'
import type { WorkbookOperation } from '../domain/workbook-dsl'

/**
 * Renderer half of the MCP → sheets-grid bridge.
 *
 * The shell main process pushes one command at a time (`sheets:mcp-command`);
 * each command runs against the live Univer workbook through the same executors
 * the built-in AI uses (readers from ai/workbook-readers.ts, the op planner and
 * apply path from op-executor.ts, the save pipeline from save-actions.ts), so
 * external edits land in the edit journal and undo history exactly like
 * in-app/AI ones. Results are reported back correlated by requestId
 * (`sheets:mcp-result`), and once the workbook is mounted the bridge announces
 * `sheets:mcp-ready` — the shell waits for it before accepting a session.
 *
 * No-op when the preload lacks the bridge channels (standalone/dev builds
 * without MCP wiring).
 */

const READY_TIMEOUT_MS = 20_000

export interface McpSheetHandlers {
  /** workbook mounted and editable? (drives the ready announce) */
  hasWorkbook: () => boolean
  /** workbook overview: sheets with ids/names/extents, active sheet */
  context: () => unknown
  /** values + formulas for the requested A1 addresses */
  readCells: (addresses: string[], sheetId?: string) => unknown
  /** apply a workbook DSL batch (planFromOps + applyChangePlan) */
  applyOps: (ops: WorkbookOperation[], dryRun: boolean) => Promise<unknown>
  /** save to an explicit absolute path (dialog-free) */
  saveTo: (path: string, overwrite: boolean) => Promise<{ ok: boolean; path?: string }>
}

export function installSheetsMcpBridge(handlers: McpSheetHandlers): () => void {
  const api = window.desktopApi
  if (typeof api?.onMcpCommand !== 'function') return () => {}

  /** one command at a time, in arrival order — applies and saves must not interleave */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const readyTimer = setInterval(() => {
    if (disposed) {
      clearInterval(readyTimer)
      return
    }
    if (handlers.hasWorkbook()) {
      clearInterval(readyTimer)
      api.signalMcpReady()
    }
  }, 50)
  setTimeout(() => clearInterval(readyTimer), READY_TIMEOUT_MS)

  const off = api.onMcpCommand((message: McpCommandMessage) => {
    queue = queue.then(() => runCommand(message)).catch(() => undefined)
  })

  return () => {
    disposed = true
    off()
  }

  async function runCommand(message: McpCommandMessage): Promise<void> {
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      api.reportMcpResult({
        requestId: message.requestId,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      })
    }
    try {
      const payload = (message.payload ?? {}) as Record<string, unknown>
      switch (message.command) {
        case 'read_sheet': {
          const addresses = Array.isArray(payload.addresses)
            ? payload.addresses.filter((a): a is string => typeof a === 'string')
            : []
          const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : undefined
          if (addresses.length > 0) {
            reply(true, { cells: handlers.readCells(addresses, sheetId) })
          } else {
            reply(true, { context: handlers.context() })
          }
          return
        }
        case 'apply_ops': {
          const ops = Array.isArray(payload.ops) ? (payload.ops as WorkbookOperation[]) : []
          if (ops.length === 0) {
            reply(false, undefined, 'ops must be a non-empty array')
            return
          }
          reply(true, await handlers.applyOps(ops, payload.dryRun === true))
          return
        }
        case 'save_sheet': {
          const path = typeof payload.path === 'string' ? payload.path : ''
          const overwrite = payload.overwrite === true
          if (!path) {
            reply(false, undefined, 'save_sheet needs an absolute path')
            return
          }
          reply(true, await handlers.saveTo(path, overwrite))
          return
        }
        default:
          reply(false, undefined, `unknown command: ${String(message.command)}`)
      }
    } catch (error: unknown) {
      reply(false, undefined, error instanceof Error ? error.message : String(error))
    }
  }
}
