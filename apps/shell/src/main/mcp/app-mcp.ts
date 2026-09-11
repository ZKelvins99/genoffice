import { McpServerService, DEFAULT_MCP_PORT, type McpToolDefinition } from './mcp-server'
import { createDocumentTools } from './tools/document-tools'

/**
 * Main-process wiring for the MCP server.
 *
 * Owns the single service instance, reads the enable/port settings, and exposes
 * the small surface the shell's IPC handlers and lifecycle hooks need. Deps are
 * injected (`configureMcpRuntime`) so this module never imports `index.ts`
 * back, and stays testable.
 */

export interface McpRuntimeDeps {
  /** app version reported by get_app_info */
  version: string
  /** default folder for generated files */
  defaultSaveDir: () => string
  /** open a file in the UI (routed to the matching tab) */
  openPath: (filePath: string) => boolean
  logger?: (message: string) => void
}

export interface McpSettings {
  enabled: boolean
  port: number
}

export interface McpStatus {
  running: boolean
  enabled: boolean
  port: number
  url: string | null
}

let deps: McpRuntimeDeps | null = null
let service: McpServerService | null = null
let currentSettings: McpSettings = { enabled: false, port: DEFAULT_MCP_PORT }

export function configureMcpRuntime(runtimeDeps: McpRuntimeDeps): void {
  deps = runtimeDeps
}

function buildTools(): McpToolDefinition[] {
  if (!deps) throw new Error('MCP runtime not configured')
  return createDocumentTools({
    version: deps.version,
    defaultSaveDir: deps.defaultSaveDir,
    // open_in_genoffice reports ok only when the file routed to a tab
    openInTab: (filePath) => {
      if (!deps) return
      const opened = deps.openPath(filePath)
      if (!opened) throw new Error(`could not open ${filePath} in GenOffice`)
    },
  })
}

function ensureService(): McpServerService {
  if (!deps) throw new Error('MCP runtime not configured')
  if (!service) {
    service = new McpServerService({
      port: currentSettings.port,
      tools: buildTools(),
      logger: deps.logger,
    })
  }
  return service
}

/** Start the server if settings say it should be on. Safe to call at boot. */
export async function startMcpFromSettings(settings: McpSettings): Promise<void> {
  currentSettings = normalize(settings)
  if (!currentSettings.enabled) return
  await ensureService().start(currentSettings.port)
}

/**
 * Apply a settings change: persist semantics are the caller's job (index.ts
 * writes app-settings.json); here we reconcile the running server with the new
 * values — start, stop, or restart on a port change.
 */
export async function applyMcpSettings(settings: McpSettings): Promise<McpStatus> {
  const next = normalize(settings)
  const wasRunning = service?.isRunning() ?? false
  const portChanged = next.port !== currentSettings.port
  currentSettings = next

  if (!next.enabled) {
    await service?.stop()
    return mcpStatus()
  }
  if (!wasRunning) {
    await ensureService().start(next.port)
  } else if (portChanged) {
    await service?.stop()
    service = null
    await ensureService().start(next.port)
  }
  return mcpStatus()
}

export async function stopMcp(): Promise<void> {
  await service?.stop()
}

export function stopMcpSync(): void {
  service?.stopSync()
}

export function mcpStatus(): McpStatus {
  const running = service?.isRunning() ?? false
  return {
    running,
    enabled: currentSettings.enabled,
    port: currentSettings.port,
    url: running ? service!.getUrl() : null,
  }
}

function normalize(settings: McpSettings): McpSettings {
  const port =
    Number.isInteger(settings.port) && settings.port > 0 && settings.port < 65536
      ? settings.port
      : DEFAULT_MCP_PORT
  return { enabled: settings.enabled === true, port }
}
