import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.websites.GET,
  RPC_CHANNELS.websites.GET_ONE,
  RPC_CHANNELS.websites.CREATE,
  RPC_CHANNELS.websites.UPDATE,
  RPC_CHANNELS.websites.DELETE,
  RPC_CHANNELS.websites.GET_CONTENT,
  RPC_CHANNELS.websites.SET_CONTENT,
  RPC_CHANNELS.websites.GET_DATA,
  RPC_CHANNELS.websites.GET_ORIGIN,
  RPC_CHANNELS.websites.EXPORT,
  RPC_CHANNELS.websites.GET_THUMBNAIL,
  RPC_CHANNELS.websites.REGENERATE_THUMBNAIL,
] as const

export function registerWebsitesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceWebsites } = await import('@craft-agent/shared/websites')
    const websites = loadWorkspaceWebsites(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.websites.CHANGED, { to: 'workspace', workspaceId }, workspaceId, websites)
  }

  // List all websites for a workspace
  server.handle(RPC_CHANNELS.websites.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PAGES_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceWebsites } = await import('@craft-agent/shared/websites')
    return loadWorkspaceWebsites(workspace.rootPath)
  })

  // Get one website (by slug or id)
  server.handle(RPC_CHANNELS.websites.GET_ONE, async (_ctx, workspaceId: string, websiteIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadWebsite, loadWebsiteById } = await import('@craft-agent/shared/websites')
    return loadWebsite(workspace.rootPath, websiteIdOrSlug)
      ?? loadWebsiteById(workspace.rootPath, websiteIdOrSlug)
  })

  // Create a new website
  server.handle(RPC_CHANNELS.websites.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/websites').CreateWebsiteInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createWebsite } = await import('@craft-agent/shared/websites')
    const website = createWebsite(workspace.rootPath, {
      name: input.name?.trim() || 'New Website',
      description: input.description,
      projectId: input.projectId,
      content: input.content,
      refresh: input.refresh,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${website.slug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    // A website created with inline content gets a poster; empty websites wait for content.
    if (input.content !== undefined) {
      deps.sessionManager.enqueueWebsiteThumbnail(workspaceId, workspace.rootPath, website.slug)
    }
    log.info(`Created website: ${website.slug}`)
    return website
  })

  // Update website metadata/refresh spec (managed fields excluded). Slug stays stable.
  server.handle(RPC_CHANNELS.websites.UPDATE, async (
    _ctx,
    workspaceId: string,
    websiteSlug: string,
    patch: import('@craft-agent/shared/websites').UpdateWebsitePatch,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateWebsite } = await import('@craft-agent/shared/websites')
    const updated = updateWebsite(workspace.rootPath, websiteSlug, patch)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a website (content and data go with the folder). The storage
  // primitive is shared verbatim with the delete_website session tool.
  server.handle(RPC_CHANNELS.websites.DELETE, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteWebsite } = await import('@craft-agent/shared/websites')
    deleteWebsite(workspace.rootPath, websiteSlug)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted website ${websiteSlug}`)
  })

  // Read website content (for editing/inspection — rendering should use CREATE_LEASE)
  server.handle(RPC_CHANNELS.websites.GET_CONTENT, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { content: null }
    const { loadWebsiteContent, loadWebsiteConfig } = await import('@craft-agent/shared/websites')
    return {
      content: loadWebsiteContent(workspace.rootPath, websiteSlug),
      contentDigest: loadWebsiteConfig(workspace.rootPath, websiteSlug)?.contentDigest,
    }
  })

  // Write website content (updates contentDigest)
  server.handle(RPC_CHANNELS.websites.SET_CONTENT, async (_ctx, workspaceId: string, websiteSlug: string, content: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { saveWebsiteContent } = await import('@craft-agent/shared/websites')
    const updated = saveWebsiteContent(workspace.rootPath, websiteSlug, content)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    deps.sessionManager.enqueueWebsiteThumbnail(workspaceId, workspace.rootPath, websiteSlug)
    return updated
  })

  // Read the website's data snapshot (cross-process contract written by refresh scripts)
  server.handle(RPC_CHANNELS.websites.GET_DATA, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { readWebsiteDataSnapshot } = await import('@craft-agent/shared/websites')
    return readWebsiteDataSnapshot(workspace.rootPath, websiteSlug)
  })

  // The address a website is rendered at, on a host that serves one.
  //
  // Handing it out **registers** the website with that host, which is also the
  // security boundary: only a website the app has actually shown is reachable, and
  // an address from a previous run answers 404 until this run names it again.
  //
  // Both ways of having no address are errors rather than null, because either one
  // means the renderer has nothing to show and a blank frame says less than a
  // sentence: the host may not be able to serve origins at all (a standalone
  // server), or the website's directory may be gone.
  server.handle(RPC_CHANNELS.websites.GET_ORIGIN, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!deps.websiteOrigin) {
      throw new Error('This host cannot serve a website’s own origin, so there is nowhere to render it.')
    }
    const origin = deps.websiteOrigin(workspace.rootPath, websiteSlug)
    if (!origin) throw new Error(`Website not found: ${websiteSlug}`)
    return origin
  })

  // ------------------------------------------------------------------
  // Export — the directory is the artifact, so this copies it out
  // ------------------------------------------------------------------

  // The destination comes from the picker rather than from here, because "where do you
  // want it" is a question only a person can answer — and in remote mode that folder is
  // on the host that holds the website, which is exactly where the copy has to happen.
  server.handle(
    RPC_CHANNELS.websites.EXPORT,
    async (_ctx, workspaceId: string, websiteSlug: string, destParent: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
      if (!destParent) throw new Error('Choose a folder to export into.')
      const { exportWebsite } = await import('@craft-agent/shared/websites')
      return exportWebsite(workspace.rootPath, websiteSlug, destParent)
    },
  )

  // ------------------------------------------------------------------
  // Thumbnails (cached poster). Generation is Electron-main-only; these
  // handlers serve the stored file and enqueue regeneration (a no-op on hosts
  // without an injected capturer).
  // ------------------------------------------------------------------

  // Read a website's poster as a data URL, but ONLY when it is fresh (the stored
  // digest matches the current content). Stale/missing → null → tile falls back.
  server.handle(RPC_CHANNELS.websites.GET_THUMBNAIL, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadWebsiteConfig, getWebsiteThumbnailPath, isThumbnailFresh } = await import('@craft-agent/shared/websites')
    const config = loadWebsiteConfig(workspace.rootPath, websiteSlug)
    if (!config || !isThumbnailFresh(config)) return null
    const path = getWebsiteThumbnailPath(workspace.rootPath, websiteSlug)
    const { readFileSync, existsSync } = await import('node:fs')
    if (!existsSync(path)) return null
    try {
      const b64 = readFileSync(path).toString('base64')
      return { dataUrl: `data:image/jpeg;base64,${b64}`, digest: config.contentDigest! }
    } catch {
      return null
    }
  })

  // Manually request a (re)capture (e.g. an agent/user "refresh preview"). Forced:
  // the person asked for the poster to be shot again, so an existing fresh one is
  // not an answer.
  server.handle(RPC_CHANNELS.websites.REGENERATE_THUMBNAIL, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    deps.sessionManager.enqueueWebsiteThumbnail(workspaceId, workspace.rootPath, websiteSlug, { force: true })
    return true
  })
}
