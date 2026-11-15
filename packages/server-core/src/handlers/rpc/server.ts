import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { addWorkspace, removeWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, ensureDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import type { ServerStatus, ServerHealth } from '@craft-agent/core/types'
import type { DeviceTokenInfo } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
import { generateDeviceToken, type TokenScope, type TokenSummary } from '../../transport/tokens'
import { scopePermits } from '../../transport/capabilities'

function toDeviceTokenInfo(token: TokenSummary): DeviceTokenInfo {
  return {
    id: token.id,
    label: token.label,
    scope: token.scope,
    deviceId: token.deviceId,
    token: token.token,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.REMOVE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.GET_DEVICES,
  RPC_CHANNELS.server.LIST_DEVICE_TOKENS,
  RPC_CHANNELS.server.CREATE_DEVICE_TOKEN,
  RPC_CHANNELS.server.REMOVE_DEVICE_TOKEN,
  RPC_CHANNELS.server.SET_DEVICE_TOKEN_SCOPE,
  RPC_CHANNELS.server.HOME_DIR,
] as const

export function registerServerHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  ctx: ServerHandlerContext,
): void {
  const { sessionManager } = deps

  // -----------------------------------------------------------------------
  // Workspace discovery (moved from workspace.ts — server-level, no workspace context)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    deps.platform.logger.info(`[server:getWorkspaces] returning ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })))}`)
    return workspaces
  })

  server.handle(RPC_CHANNELS.server.CREATE_WORKSPACE, async (_ctx, name: string) => {
    if (!name?.trim()) throw new Error('Workspace name is required')
    const trimmed = name.trim()

    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'

    ensureDefaultWorkspacesDir()
    const baseDir = getDefaultWorkspacesDir()
    let rootPath = join(baseDir, slug)
    let uniqueSlug = slug
    let counter = 1
    while (existsSync(rootPath)) {
      uniqueSlug = `${slug}-${counter++}`
      rootPath = join(baseDir, uniqueSlug)
    }

    const workspace = addWorkspace({ name: trimmed, rootPath })
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${trimmed}" at ${rootPath} (server:createWorkspace)`)

    const { rootPath: _rp, createdAt: _ca, ...info } = workspace
    return info
  })

  server.handle(RPC_CHANNELS.server.REMOVE_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!workspaceId?.trim()) throw new Error('Workspace id is required')
    const removed = await removeWorkspace(workspaceId.trim())
    deps.platform.logger.info(`[server:removeWorkspace] ${removed ? 'removed' : 'not found'} ${workspaceId}`)
    return removed
  })

  // -----------------------------------------------------------------------
  // Server Status
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_STATUS, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    const workspaceStatuses = workspaces.map(ws => {
      const summary = sessionManager.getWorkspaceAutomationSummary(ws.id)
      return {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        activeSessions: sessionManager.getActiveSessionCount(ws.id),
        automationCount: summary.automationCount,
        schedulerRunning: summary.schedulerRunning,
      }
    })

    const mem = process.memoryUsage()
    const status: ServerStatus = {
      serverId: ctx.serverId,
      version: deps.platform.appVersion,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      connectedClients: ctx.getConnectedClientCount(),
      workspaces: workspaceStatuses,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
    }

    return status
  })

  // -----------------------------------------------------------------------
  // Server Health
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_HEALTH, async () => {
    return getHealthCheck(deps)
  })

  // -----------------------------------------------------------------------
  // Active Session Discovery
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_ACTIVE_SESSIONS, async () => {
    return sessionManager.getActiveSessionsInfo()
  })

  // -----------------------------------------------------------------------
  // Devices (the machines this hub can drive; its own tools are the default)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_DEVICES, async () => {
    return sessionManager.getConnectedDevices()
  })

  server.handle(RPC_CHANNELS.server.SET_DEVICE_ALIAS, async (_ctx, deviceId: string, alias: string | null) => {
    return sessionManager.setDeviceAlias(deviceId, alias)
  })

  server.handle(RPC_CHANNELS.server.FORGET_DEVICE, async (_ctx, deviceId: string) => {
    sessionManager.forgetDevice(deviceId)
    // Revoke the pairing's own slots: their sockets are closed and cannot reconnect. Nothing else
    // is swept by device id — a window on the same machine that connected with the server token
    // is remote control, not the pairing being deleted, and must stay connected.
    for (const token of ctx.tokens.list()) {
      if (token.kind === 'device' && token.deviceId === deviceId) {
        ctx.tokens.remove(token.id)
        ctx.disconnectTokenClients(token.id, 'Device removed from this server')
      }
    }
  })

  // -----------------------------------------------------------------------
  // Device slots — the tokens a machine connects with
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.LIST_DEVICE_TOKENS, async () => {
    return ctx.tokens
      .list()
      .filter((token) => token.kind === 'device')
      .map(toDeviceTokenInfo)
  })

  /**
   * Create a slot and hand back its token.
   *
   * The token stays copyable in the device list while the slot is pending; claiming it clears the
   * plaintext and keeps only the hash. The slot stays unbound until a machine presents it.
   */
  server.handle(RPC_CHANNELS.server.CREATE_DEVICE_TOKEN, async (
    _ctx,
    label?: string,
    scope?: TokenScope,
  ) => {
    const token = generateDeviceToken()
    const grant = ctx.tokens.register({
      token,
      label: label?.trim() || 'Device',
      scope: scope === 'client' || scope === 'device' ? scope : 'both',
      kind: 'device',
    })
    const entry = ctx.tokens.list().find((candidate) => candidate.id === grant.tokenId)
    if (!entry) throw new Error('The device slot could not be created')
    return { token, entry: toDeviceTokenInfo(entry) }
  })

  server.handle(RPC_CHANNELS.server.REMOVE_DEVICE_TOKEN, async (_ctx, tokenId: string) => {
    const removed = ctx.tokens.remove(tokenId)
    if (removed) ctx.disconnectTokenClients(tokenId)
    return removed
  })

  /**
   * Change what one device slot may do — the hub-side half of "revoke remote access".
   *
   * One credential serves two different jobs (a window driving this hub, and this machine lending
   * itself to it), so the change is applied per connection, not per credential: each connection is
   * asked whether the new scope still permits what it declared, and only the ones that fail are
   * dropped. Closing remote access therefore leaves the machine's device link untouched, and
   * closing device access leaves its windows untouched.
   */
  server.handle(RPC_CHANNELS.server.SET_DEVICE_TOKEN_SCOPE, async (_ctx, tokenId: string, scope: TokenScope) => {
    if (scope !== 'client' && scope !== 'device' && scope !== 'both') throw new Error('Invalid device slot scope')
    if (!ctx.tokens.setScope(tokenId, scope)) throw new Error('Unknown device slot')
    // The sockets already open carry the old scope; widening (turning remote control back on) has
    // to reach them or the machine keeps being refused until it happens to reconnect.
    ctx.applyTokenScope(tokenId, scope)
    ctx.revalidateTokenClients(
      tokenId,
      ({ capabilities, role }) => scopePermits(scope, role, capabilities),
      scope === 'device'
        ? 'Remote access revoked: this credential may no longer open windows here.'
        : 'Device access revoked: this credential may no longer lend this machine.',
    )
    return true
  })

  // -----------------------------------------------------------------------
  // Server Home Directory (REMOTE_ELIGIBLE — returns this server's home)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.HOME_DIR, async () => {
    return homedir()
  })
}

// ---------------------------------------------------------------------------
// Health check logic (reusable by both RPC handler and HTTP endpoint)
// ---------------------------------------------------------------------------

export function getHealthCheck(deps: Pick<HandlerDeps, 'sessionManager'>): ServerHealth {
  const checks: ServerHealth['checks'] = []

  // Check 1: SessionManager is operational (has loaded workspaces)
  try {
    const workspaces = deps.sessionManager.getWorkspaces()
    checks.push({
      name: 'session_manager',
      status: 'pass',
      message: `${workspaces.length} workspace(s) loaded`,
    })
  } catch {
    checks.push({
      name: 'session_manager',
      status: 'fail',
      message: 'SessionManager not initialized',
    })
  }

  // Check 2: Memory usage (warn if heap exceeds 1.5GB)
  const mem = process.memoryUsage()
  const heapGB = mem.heapUsed / (1024 * 1024 * 1024)
  checks.push({
    name: 'memory',
    status: heapGB < 1.5 ? 'pass' : 'fail',
    message: `Heap: ${Math.round(heapGB * 100) / 100} GB`,
  })

  // Aggregate status
  const allPass = checks.every(c => c.status === 'pass')
  const anyFail = checks.some(c => c.status === 'fail')

  return {
    status: allPass ? 'ok' : anyFail ? 'unhealthy' : 'degraded',
    checks,
  }
}
