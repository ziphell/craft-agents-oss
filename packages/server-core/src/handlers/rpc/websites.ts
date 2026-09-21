import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { WebsiteActionRequest } from '@craft-agent/shared/websites'
import type { WebsiteActionBroker, WebsiteActionExecutors } from '@craft-agent/shared/websites'
import { assertWebsiteSourceUsable } from '../../websites/source-gate'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.websites.GET,
  RPC_CHANNELS.websites.GET_ONE,
  RPC_CHANNELS.websites.CREATE,
  RPC_CHANNELS.websites.UPDATE,
  RPC_CHANNELS.websites.DELETE,
  RPC_CHANNELS.websites.GET_CONTENT,
  RPC_CHANNELS.websites.SET_CONTENT,
  RPC_CHANNELS.websites.GET_DATA,
  RPC_CHANNELS.websites.LIST_GRANTS,
  RPC_CHANNELS.websites.ISSUE_GRANT,
  RPC_CHANNELS.websites.REVOKE_GRANT,
  RPC_CHANNELS.websites.CREATE_LEASE,
  RPC_CHANNELS.websites.RELEASE_LEASE,
  RPC_CHANNELS.websites.EXECUTE_ACTION,
  RPC_CHANNELS.websites.CANCEL_ACTION,
  RPC_CHANNELS.websites.GET_SHARE_CAPABILITIES,
  RPC_CHANNELS.websites.GET_SHARE_DATA_SCAN,
  RPC_CHANNELS.websites.PUBLISH,
  RPC_CHANNELS.websites.SET_PUBLICATION_PASSWORD,
  RPC_CHANNELS.websites.UNPUBLISH,
  RPC_CHANNELS.websites.GET_THUMBNAIL,
  RPC_CHANNELS.websites.REGENERATE_THUMBNAIL,
] as const

/** Cap on action response bodies returned to the renderer */
const ACTION_BODY_MAX_CHARS = 512 * 1024

export function registerWebsitesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // One broker per workspace: render leases and in-flight actions are
  // in-memory state scoped to the hosting process.
  const brokers = new Map<string, WebsiteActionBroker>()

  // One MCP client pool per workspace, shared by all of its websites and
  // independent of session pools. Clients live until the process exits
  // (same lifetime as the brokers above).
  const mcpPools = new Map<string, import('@craft-agent/shared/mcp').McpClientPool>()

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceWebsites } = await import('@craft-agent/shared/websites')
    const websites = loadWorkspaceWebsites(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.websites.CHANGED, { to: 'workspace', workspaceId }, workspaceId, websites)
  }

  /**
   * API executor for the action bridge. Resolves the source + credential
   * lazily per call (same seams sessions use), so tokens refresh correctly
   * and never leave the host process.
   */
  function buildApiExecutor(workspaceRootPath: string): NonNullable<WebsiteActionExecutors['executeApi']> {
    // One refresh manager per workspace executor so failed-refresh cooldowns
    // survive across calls instead of resetting on every action.
    let refreshManager: import('@craft-agent/shared/sources').TokenRefreshManager | undefined
    return async (invocation, { signal }) => {
      const {
        loadSource,
        getSourceCredentialManager,
        getSourceServerBuilder,
        isApiOAuthProvider,
        hasRenewEndpoint,
        TokenRefreshManager,
        createTokenGetter,
        executeApiRequest,
      } = await import('@craft-agent/shared/sources')

      const source = loadSource(workspaceRootPath, invocation.sourceSlug)
      if (!source || source.config.type !== 'api') {
        throw new Error(`API source not found: ${invocation.sourceSlug}`)
      }
      // Fail fast with the stable source-auth-required error instead of
      // letting the request die on a 401 or a refresh timeout downstream.
      assertWebsiteSourceUsable(source)

      const credManager = getSourceCredentialManager()
      const apiConfig = getSourceServerBuilder().buildApiConfig(source)

      // Credential resolution mirrors SessionManager.buildServersFromSources:
      // refreshable sources get a TokenRefreshManager-backed getter, plain
      // API sources read the vault per request, 'none' uses no credential.
      let credentialSource: import('@craft-agent/shared/sources').ApiCredentialSource
      if (isApiOAuthProvider(source.config.provider) || source.config.api?.authType === 'oauth' || hasRenewEndpoint(source)) {
        refreshManager ??= new TokenRefreshManager(credManager, { log: (msg: string) => log.info(msg) })
        credentialSource = createTokenGetter(refreshManager, source)
      } else if (source.config.api?.authType === 'none' || !source.config.api?.authType) {
        credentialSource = ''
      } else {
        credentialSource = async () => credManager.getApiCredential(source)
      }

      let outcome: Awaited<ReturnType<typeof executeApiRequest>>
      try {
        outcome = await executeApiRequest(
          apiConfig,
          credentialSource,
          { path: invocation.path, method: invocation.method, params: invocation.params },
          { signal },
        )
      } catch (err) {
        // A failed token refresh inside the request marks the source
        // needs_auth — reload and surface the stable auth error so this
        // very call already tells the website (and matches the banner).
        const fresh = loadSource(workspaceRootPath, invocation.sourceSlug)
        if (fresh) assertWebsiteSourceUsable(fresh)
        throw err
      }

      // Shape the body for the renderer: parse JSON when it is JSON, cap size.
      let text = outcome.buffer.toString('utf-8')
      const truncated = text.length > ACTION_BODY_MAX_CHARS
      if (truncated) {
        text = `${text.slice(0, ACTION_BODY_MAX_CHARS)}…[truncated]`
      }
      let body: unknown = text
      if (!truncated && outcome.contentType?.toLowerCase().includes('json')) {
        try { body = JSON.parse(text) } catch { /* leave as text */ }
      }
      return { status: outcome.status, ok: outcome.ok, body }
    }
  }

  async function getBroker(workspaceId: string, workspaceRootPath: string): Promise<WebsiteActionBroker> {
    const existing = brokers.get(workspaceRootPath)
    if (existing) return existing

    const { WebsiteActionBroker } = await import('@craft-agent/shared/websites')
    const { loadWorkspaceSources } = await import('@craft-agent/shared/sources')

    let activeSourceSlugs: string[] = []
    try {
      activeSourceSlugs = loadWorkspaceSources(workspaceRootPath).map((source) => source.config.slug)
    } catch {
      // Policy annotation degrades gracefully without per-source permissions
    }

    const { McpClientPool } = await import('@craft-agent/shared/mcp')
    const { createWebsitesMcpExecutor } = await import('../../websites/mcp-executor')
    const { createWebsitesScriptExecutor } = await import('../../websites/script-executor-bridge')
    let mcpPool = mcpPools.get(workspaceRootPath)
    if (!mcpPool) {
      mcpPool = new McpClientPool({
        debug: (msg) => log.debug(`[websites] ${msg}`),
        workspaceRootPath,
      })
      mcpPools.set(workspaceRootPath, mcpPool)
    }

    const broker = new WebsiteActionBroker({
      executors: {
        executeApi: buildApiExecutor(workspaceRootPath),
        executeMcp: createWebsitesMcpExecutor({ workspaceRootPath, pool: mcpPool, log }),
        executeScript: createWebsitesScriptExecutor({ workspaceRootPath, log }),
      },
      permissionsContext: { workspaceRootPath, activeSourceSlugs },
    })
    brokers.set(workspaceRootPath, broker)
    log.info(`Created website action broker for workspace ${workspaceId}`)
    return broker
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
      kind: input.kind,
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

  // Delete a website (content, data, and grants go with the folder). A published
  // website is unpublished first (best effort) so the public copy does not
  // silently outlive the local website — deleteWebsiteWithUnpublish is shared
  // verbatim with the delete_website session tool.
  server.handle(RPC_CHANNELS.websites.DELETE, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteWebsiteWithUnpublish } = await import('@craft-agent/shared/websites')
    const { publicCopyMayRemain } = await deleteWebsiteWithUnpublish(workspace.rootPath, workspace.id, websiteSlug, {
      log: (message: string) => log.warn(message),
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted website ${websiteSlug}`)
    return { publicCopyMayRemain }
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

  // Write website content (updates contentDigest; existing grants go stale by design)
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

  // List persisted grants (validity — digest/expiry — is enforced at execution time)
  server.handle(RPC_CHANNELS.websites.LIST_GRANTS, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { loadWebsiteConfig } = await import('@craft-agent/shared/websites')
    return loadWebsiteConfig(workspace.rootPath, websiteSlug)?.grants ?? []
  })

  // Persist a user-approved grant (approval UX happens in the caller)
  server.handle(RPC_CHANNELS.websites.ISSUE_GRANT, async (
    _ctx,
    workspaceId: string,
    websiteSlug: string,
    input: import('@craft-agent/shared/websites').AddWebsiteGrantInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { addWebsiteGrant } = await import('@craft-agent/shared/websites')
    const grant = addWebsiteGrant(workspace.rootPath, websiteSlug, input)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    const target = grant.action.kind === 'script' ? grant.action.script : grant.action.sourceSlug
    log.info(`Issued website grant ${grant.id} on ${websiteSlug} (${grant.action.kind}:${target})`)
    return grant
  })

  // Revoke a grant
  server.handle(RPC_CHANNELS.websites.REVOKE_GRANT, async (_ctx, workspaceId: string, websiteSlug: string, grantId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { revokeWebsiteGrant } = await import('@craft-agent/shared/websites')
    const removed = revokeWebsiteGrant(workspace.rootPath, websiteSlug, grantId)
    if (removed) {
      deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
      await broadcastChanged(workspaceId, workspace.rootPath)
      log.info(`Revoked website grant ${grantId} on ${websiteSlug}`)
    }
    return removed
  })

  // Issue a render lease. Returns the lease AND the exact content it is bound
  // to — the renderer must render THIS content string (not a separately
  // fetched copy), closing the read/lease race.
  server.handle(RPC_CHANNELS.websites.CREATE_LEASE, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { loadWebsiteContent, computeWebsiteContentDigest } = await import('@craft-agent/shared/websites')

    const content = loadWebsiteContent(workspace.rootPath, websiteSlug)
    if (content === null) throw new Error(`Website has no content: ${websiteSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    const lease = broker.createLease({ websiteSlug, contentDigest: computeWebsiteContentDigest(content) })
    return { lease, content }
  })

  // Release a render lease (website unmounted)
  server.handle(RPC_CHANNELS.websites.RELEASE_LEASE, async (_ctx, workspaceId: string, leaseId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return
    const broker = await getBroker(workspaceId, workspace.rootPath)
    broker.releaseLease(leaseId)
  })

  // Execute a granted source action. Website config is re-read from disk per
  // request so revocations and content changes apply immediately.
  server.handle(RPC_CHANNELS.websites.EXECUTE_ACTION, async (_ctx, workspaceId: string, request: WebsiteActionRequest) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { loadWebsiteConfig } = await import('@craft-agent/shared/websites')

    const website = loadWebsiteConfig(workspace.rootPath, request.websiteSlug)
    if (!website) throw new Error(`Website not found: ${request.websiteSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    return broker.executeAction(website, request)
  })

  // Cancel an in-flight action
  server.handle(RPC_CHANNELS.websites.CANCEL_ACTION, async (_ctx, workspaceId: string, requestId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    const broker = await getBroker(workspaceId, workspace.rootPath)
    return broker.cancelAction(requestId)
  })

  // ------------------------------------------------------------------
  // Sharing (Cloudflare publication) — server-evaluated feature flag.
  // Publish/password are gated; unpublish never is, so disabling the flag
  // cannot strand a published website.
  // ------------------------------------------------------------------

  async function buildPublisher() {
    const { WebsitePublisher, createCredentialWebsitePublishTokenStore } = await import('@craft-agent/shared/websites')
    return new WebsitePublisher({
      tokenStore: createCredentialWebsitePublishTokenStore(),
      log: (msg: string) => log.info(msg),
    })
  }

  // Whether the renderer may offer publish/update UI (unpublish is always allowed)
  server.handle(RPC_CHANNELS.websites.GET_SHARE_CAPABILITIES, async () => {
    const { isWebsitesSharingEnabled } = await import('@craft-agent/shared/feature-flags')
    return { sharingEnabled: isWebsitesSharingEnabled() }
  })

  // What would `includeData` publish, and does any of it look like a secret?
  // Best-effort warning input for the Share dialog — never blocks publishing.
  server.handle(RPC_CHANNELS.websites.GET_SHARE_DATA_SCAN, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { scanWebsiteShareData } = await import('@craft-agent/shared/websites')
    return scanWebsiteShareData(workspace.rootPath, websiteSlug)
  })

  // Publish (create) or republish (upload a new revision) a website
  server.handle(RPC_CHANNELS.websites.PUBLISH, async (
    _ctx,
    workspaceId: string,
    websiteSlug: string,
    options: { includeData: boolean; password?: string; viewOnlyAcknowledged?: boolean },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const updated = await publisher.publish(workspace.rootPath, workspace.id, websiteSlug, {
      includeData: options.includeData === true,
      password: options.password,
      viewOnlyAcknowledged: options.viewOnlyAcknowledged,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Set or clear the viewer password on an existing publication
  server.handle(RPC_CHANNELS.websites.SET_PUBLICATION_PASSWORD, async (
    _ctx,
    workspaceId: string,
    websiteSlug: string,
    password: string | null,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const updated = await publisher.setPassword(workspace.rootPath, workspace.id, websiteSlug, password)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Unpublish (revoke the public copy, clear the local pointer + vault token)
  server.handle(RPC_CHANNELS.websites.UNPUBLISH, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const result = await publisher.unpublish(workspace.rootPath, workspace.id, websiteSlug)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `websites/${websiteSlug}/website.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return { config: result.config, warning: result.warning }
  })

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

  // Manually request a (re)capture (e.g. an agent/user "refresh preview").
  server.handle(RPC_CHANNELS.websites.REGENERATE_THUMBNAIL, async (_ctx, workspaceId: string, websiteSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    deps.sessionManager.enqueueWebsiteThumbnail(workspaceId, workspace.rootPath, websiteSlug)
    return true
  })
}
