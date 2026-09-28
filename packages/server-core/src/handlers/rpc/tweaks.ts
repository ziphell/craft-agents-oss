/**
 * Tweaks RPC — the app's own read of the tweaks an agent writes.
 *
 * A tweak is authored by the agent (there is no create in the UI), so everything here is
 * a view onto the same primitives `@craft-agent/shared/tweaks` exposes, or the one
 * mutation a person owns: **the switch**. `tweaks:update` is why this exists at all — a
 * tweak injects into pages somebody is signed in to, and turning it on is their consent
 * to run that code there, not the agent's.
 *
 * Every mutation broadcasts `tweaks:changed` with the fresh summaries, the same way the
 * websites handlers do, so an open page follows the folder rather than a stale list.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.tweaks.GET,
  RPC_CHANNELS.tweaks.GET_ONE,
  RPC_CHANNELS.tweaks.UPDATE,
  RPC_CHANNELS.tweaks.DELETE,
  RPC_CHANNELS.tweaks.EXPORT,
] as const

export function registerTweaksHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceTweaks, toTweakSummary } = await import('@craft-agent/shared/tweaks')
    const tweaks = loadWorkspaceTweaks(workspaceRootPath).map(toTweakSummary)
    pushTyped(server, RPC_CHANNELS.tweaks.CHANGED, { to: 'workspace', workspaceId }, workspaceId, tweaks)
    // Every path that changes the tweaks also tells whoever is *running* them: a page that is
    // already open must not wait for a reload to see a switch flip (see `HandlerDeps`).
    deps.onTweaksChanged?.(workspaceId)
  }

  // List all tweaks for a workspace, as summaries
  server.handle(RPC_CHANNELS.tweaks.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`TWEAKS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceTweaks, toTweakSummary } = await import('@craft-agent/shared/tweaks')
    return loadWorkspaceTweaks(workspace.rootPath).map(toTweakSummary)
  })

  // One tweak in full (by slug), or null
  server.handle(RPC_CHANNELS.tweaks.GET_ONE, async (_ctx, workspaceId: string, slug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadTweak, toTweakDetails } = await import('@craft-agent/shared/tweaks')
    const tweak = loadTweak(workspace.rootPath, slug)
    return tweak ? toTweakDetails(workspace.rootPath, tweak) : null
  })

  // The switch — and the fields the page may edit. The agent's tool writes the code; a
  // patch here never touches tweak.css/tweak.js.
  server.handle(RPC_CHANNELS.tweaks.UPDATE, async (
    _ctx,
    workspaceId: string,
    slug: string,
    patch: import('@craft-agent/shared/tweaks').UpdateTweakPatch,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { loadTweak, toTweakDetails, updateTweak } = await import('@craft-agent/shared/tweaks')
    updateTweak(workspace.rootPath, slug, patch)
    // The folder is the truth, so the host has to be told this write happened — the
    // watcher's own fs events are unreliable for atomic renames on some platforms.
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `tweaks/${slug}/tweak.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    const tweak = loadTweak(workspace.rootPath, slug)
    return tweak ? toTweakDetails(workspace.rootPath, tweak) : null
  })

  // Delete a tweak (its sources and hit record go with the folder)
  server.handle(RPC_CHANNELS.tweaks.DELETE, async (_ctx, workspaceId: string, slug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteTweak } = await import('@craft-agent/shared/tweaks')
    deleteTweak(workspace.rootPath, slug)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `tweaks/${slug}/tweak.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted tweak ${slug}`)
  })

  // Export — build the loadable extension into the folder the person picked. Where it
  // lands is a question only a person can answer, and on a remote host that folder is
  // beside the tweaks, which is where the build has to happen.
  server.handle(RPC_CHANNELS.tweaks.EXPORT, async (_ctx, workspaceId: string, destParent: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!destParent) throw new Error('Choose a folder to export into.')
    const { exportTweaksExtension } = await import('@craft-agent/shared/tweaks')
    return exportTweaksExtension(workspace.rootPath, destParent)
  })
}
