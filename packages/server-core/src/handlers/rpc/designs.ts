import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import { requestClientOpenFileDialog, requestClientSaveFileDialog } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { DesignActionRequest } from '@craft-agent/shared/designs'
import { getDesignConfigRelativePath } from '@craft-agent/shared/designs'
import type { DesignActionBroker, DesignActionExecutors } from '@craft-agent/shared/designs'
import type { DesignExportFormat } from '@craft-agent/shared/designs/types'
import { assertDesignSourceUsable } from '../../designs/source-gate'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.designs.GET,
  RPC_CHANNELS.designs.GET_ONE,
  RPC_CHANNELS.designs.CREATE,
  RPC_CHANNELS.designs.UPDATE,
  RPC_CHANNELS.designs.DELETE,
  RPC_CHANNELS.designs.GET_CONTENT,
  RPC_CHANNELS.designs.SET_CONTENT,
  RPC_CHANNELS.designs.GET_DATA,
  RPC_CHANNELS.designs.LIST_GRANTS,
  RPC_CHANNELS.designs.ISSUE_GRANT,
  RPC_CHANNELS.designs.REVOKE_GRANT,
  RPC_CHANNELS.designs.CREATE_LEASE,
  RPC_CHANNELS.designs.RELEASE_LEASE,
  RPC_CHANNELS.designs.EXECUTE_ACTION,
  RPC_CHANNELS.designs.CANCEL_ACTION,
  RPC_CHANNELS.designs.GET_SHARE_CAPABILITIES,
  RPC_CHANNELS.designs.GET_SHARE_DATA_SCAN,
  RPC_CHANNELS.designs.PUBLISH,
  RPC_CHANNELS.designs.SET_PUBLICATION_PASSWORD,
  RPC_CHANNELS.designs.UNPUBLISH,
  RPC_CHANNELS.designs.GET_THUMBNAIL,
  RPC_CHANNELS.designs.REGENERATE_THUMBNAIL,
  RPC_CHANNELS.designs.EXPORT,
] as const

/** Cap on action response bodies returned to the renderer */
const ACTION_BODY_MAX_CHARS = 512 * 1024

export function registerDesignsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // One broker per workspace: render leases and in-flight actions are
  // in-memory state scoped to the hosting process.
  const brokers = new Map<string, DesignActionBroker>()

  // One MCP client pool per workspace, shared by all of its designs and
  // independent of session pools. Clients live until the process exits
  // (same lifetime as the brokers above).
  const mcpPools = new Map<string, import('@craft-agent/shared/mcp').McpClientPool>()

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceDesigns } = await import('@craft-agent/shared/designs')
    const designs = loadWorkspaceDesigns(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.designs.CHANGED, { to: 'workspace', workspaceId }, workspaceId, designs)
  }

  /**
   * API executor for the action bridge. Resolves the source + credential
   * lazily per call (same seams sessions use), so tokens refresh correctly
   * and never leave the host process.
   */
  function buildApiExecutor(workspaceRootPath: string): NonNullable<DesignActionExecutors['executeApi']> {
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
      assertDesignSourceUsable(source)

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
        // very call already tells the design (and matches the banner).
        const fresh = loadSource(workspaceRootPath, invocation.sourceSlug)
        if (fresh) assertDesignSourceUsable(fresh)
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

  async function getBroker(workspaceId: string, workspaceRootPath: string): Promise<DesignActionBroker> {
    const existing = brokers.get(workspaceRootPath)
    if (existing) return existing

    const { DesignActionBroker } = await import('@craft-agent/shared/designs')
    const { loadWorkspaceSources } = await import('@craft-agent/shared/sources')

    let activeSourceSlugs: string[] = []
    try {
      activeSourceSlugs = loadWorkspaceSources(workspaceRootPath).map((source) => source.config.slug)
    } catch {
      // Policy annotation degrades gracefully without per-source permissions
    }

    const { McpClientPool } = await import('@craft-agent/shared/mcp')
    const { createDesignsMcpExecutor } = await import('../../designs/mcp-executor')
    const { createDesignsScriptExecutor } = await import('../../designs/script-executor-bridge')
    let mcpPool = mcpPools.get(workspaceRootPath)
    if (!mcpPool) {
      mcpPool = new McpClientPool({
        debug: (msg) => log.debug(`[designs] ${msg}`),
        workspaceRootPath,
      })
      mcpPools.set(workspaceRootPath, mcpPool)
    }

    const broker = new DesignActionBroker({
      executors: {
        executeApi: buildApiExecutor(workspaceRootPath),
        executeMcp: createDesignsMcpExecutor({ workspaceRootPath, pool: mcpPool, log }),
        executeScript: createDesignsScriptExecutor({ workspaceRootPath, log }),
      },
      permissionsContext: { workspaceRootPath, activeSourceSlugs },
    })
    brokers.set(workspaceRootPath, broker)
    log.info(`Created design action broker for workspace ${workspaceId}`)
    return broker
  }

  // List all designs for a workspace
  server.handle(RPC_CHANNELS.designs.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PAGES_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceDesigns } = await import('@craft-agent/shared/designs')
    return loadWorkspaceDesigns(workspace.rootPath)
  })

  // Get one design (by slug or id)
  server.handle(RPC_CHANNELS.designs.GET_ONE, async (_ctx, workspaceId: string, designIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadDesign, loadDesignById } = await import('@craft-agent/shared/designs')
    return loadDesign(workspace.rootPath, designIdOrSlug)
      ?? loadDesignById(workspace.rootPath, designIdOrSlug)
  })

  // Create a new design
  server.handle(RPC_CHANNELS.designs.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/designs').CreateDesignInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createDesign } = await import('@craft-agent/shared/designs')
    const design = createDesign(workspace.rootPath, {
      name: input.name?.trim() || 'New Design',
      description: input.description,
      projectId: input.projectId,
      content: input.content,
      refresh: input.refresh,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(design.slug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    // A design created with inline content gets a poster; empty designs wait for content.
    if (input.content !== undefined) {
      deps.sessionManager.enqueueDesignThumbnail(workspaceId, workspace.rootPath, design.slug)
    }
    log.info(`Created design: ${design.slug}`)
    return design
  })

  // Update design metadata/refresh spec (managed fields excluded). Slug stays stable.
  server.handle(RPC_CHANNELS.designs.UPDATE, async (
    _ctx,
    workspaceId: string,
    designSlug: string,
    patch: import('@craft-agent/shared/designs').UpdateDesignPatch,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateDesign } = await import('@craft-agent/shared/designs')
    const updated = updateDesign(workspace.rootPath, designSlug, patch)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a design (content, data, and grants go with the folder). A published
  // design is unpublished first (best effort) so the public copy does not
  // silently outlive the local design — deleteDesignWithUnpublish is shared
  // verbatim with the delete_design session tool.
  server.handle(RPC_CHANNELS.designs.DELETE, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteDesignWithUnpublish } = await import('@craft-agent/shared/designs')
    const { publicCopyMayRemain } = await deleteDesignWithUnpublish(workspace.rootPath, workspace.id, designSlug, {
      log: (message: string) => log.warn(message),
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted design ${designSlug}`)
    return { publicCopyMayRemain }
  })

  // Read design content (for editing/inspection — rendering should use CREATE_LEASE)
  server.handle(RPC_CHANNELS.designs.GET_CONTENT, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { content: null }
    const { loadDesignContent, loadDesignConfig } = await import('@craft-agent/shared/designs')
    return {
      content: loadDesignContent(workspace.rootPath, designSlug),
      contentDigest: loadDesignConfig(workspace.rootPath, designSlug)?.contentDigest,
    }
  })

  // Write design content (updates contentDigest; existing grants go stale by design)
  server.handle(RPC_CHANNELS.designs.SET_CONTENT, async (_ctx, workspaceId: string, designSlug: string, content: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { saveDesignContent } = await import('@craft-agent/shared/designs')
    const updated = saveDesignContent(workspace.rootPath, designSlug, content)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    deps.sessionManager.enqueueDesignThumbnail(workspaceId, workspace.rootPath, designSlug)
    return updated
  })

  // Read the design's data snapshot (cross-process contract written by refresh scripts)
  server.handle(RPC_CHANNELS.designs.GET_DATA, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { readDesignDataSnapshot } = await import('@craft-agent/shared/designs')
    return readDesignDataSnapshot(workspace.rootPath, designSlug)
  })

  // List persisted grants (validity — digest/expiry — is enforced at execution time)
  server.handle(RPC_CHANNELS.designs.LIST_GRANTS, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { loadDesignConfig } = await import('@craft-agent/shared/designs')
    return loadDesignConfig(workspace.rootPath, designSlug)?.grants ?? []
  })

  // Persist a user-approved grant (approval UX happens in the caller)
  server.handle(RPC_CHANNELS.designs.ISSUE_GRANT, async (
    _ctx,
    workspaceId: string,
    designSlug: string,
    input: import('@craft-agent/shared/designs').AddDesignGrantInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { addDesignGrant } = await import('@craft-agent/shared/designs')
    const grant = addDesignGrant(workspace.rootPath, designSlug, input)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    const target = grant.action.kind === 'script' ? grant.action.script : grant.action.sourceSlug
    log.info(`Issued design grant ${grant.id} on ${designSlug} (${grant.action.kind}:${target})`)
    return grant
  })

  // Revoke a grant
  server.handle(RPC_CHANNELS.designs.REVOKE_GRANT, async (_ctx, workspaceId: string, designSlug: string, grantId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { revokeDesignGrant } = await import('@craft-agent/shared/designs')
    const removed = revokeDesignGrant(workspace.rootPath, designSlug, grantId)
    if (removed) {
      deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
      await broadcastChanged(workspaceId, workspace.rootPath)
      log.info(`Revoked design grant ${grantId} on ${designSlug}`)
    }
    return removed
  })

  // Issue a render lease. Returns the lease AND the exact content it is bound
  // to — the renderer must render THIS content string (not a separately
  // fetched copy), closing the read/lease race.
  server.handle(RPC_CHANNELS.designs.CREATE_LEASE, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { loadDesignContent, computeDesignContentDigest } = await import('@craft-agent/shared/designs')

    const content = loadDesignContent(workspace.rootPath, designSlug)
    if (content === null) throw new Error(`Design has no content: ${designSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    const lease = broker.createLease({ designSlug, contentDigest: computeDesignContentDigest(content) })
    // The address the frame loads instead of the string above: served from the
    // design's own folder, so relative assets resolve and the fragment is real
    // (see design-preview-host for what that changes, and what it does not).
    const { designPreviewUrl, getDesignPath } = await import('@craft-agent/shared/designs')
    const previewUrl = designPreviewUrl(designSlug, getDesignPath(workspace.rootPath, designSlug))
    return { lease, content, previewUrl }
  })

  // Release a render lease (design unmounted)
  server.handle(RPC_CHANNELS.designs.RELEASE_LEASE, async (_ctx, workspaceId: string, leaseId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return
    const broker = await getBroker(workspaceId, workspace.rootPath)
    broker.releaseLease(leaseId)
  })

  // Execute a granted source action. Design config is re-read from disk per
  // request so revocations and content changes apply immediately.
  server.handle(RPC_CHANNELS.designs.EXECUTE_ACTION, async (_ctx, workspaceId: string, request: DesignActionRequest) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { loadDesignConfig } = await import('@craft-agent/shared/designs')

    const design = loadDesignConfig(workspace.rootPath, request.designSlug)
    if (!design) throw new Error(`Design not found: ${request.designSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    return broker.executeAction(design, request)
  })

  // Cancel an in-flight action
  server.handle(RPC_CHANNELS.designs.CANCEL_ACTION, async (_ctx, workspaceId: string, requestId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    const broker = await getBroker(workspaceId, workspace.rootPath)
    return broker.cancelAction(requestId)
  })

  // ------------------------------------------------------------------
  // Sharing (Cloudflare publication) — server-evaluated feature flag.
  // Publish/password are gated; unpublish never is, so disabling the flag
  // cannot strand a published design.
  // ------------------------------------------------------------------

  async function buildPublisher() {
    const { DesignPublisher, createCredentialDesignPublishTokenStore } = await import('@craft-agent/shared/designs')
    return new DesignPublisher({
      tokenStore: createCredentialDesignPublishTokenStore(),
      log: (msg: string) => log.info(msg),
    })
  }

  // Whether the renderer may offer publish/update UI (unpublish is always allowed)
  server.handle(RPC_CHANNELS.designs.GET_SHARE_CAPABILITIES, async () => {
    const { isDesignsSharingEnabled } = await import('@craft-agent/shared/feature-flags')
    return { sharingEnabled: isDesignsSharingEnabled() }
  })

  // What would `includeData` publish, and does any of it look like a secret?
  // Best-effort warning input for the Share dialog — never blocks publishing.
  server.handle(RPC_CHANNELS.designs.GET_SHARE_DATA_SCAN, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { scanDesignShareData } = await import('@craft-agent/shared/designs')
    return scanDesignShareData(workspace.rootPath, designSlug)
  })

  // Publish (create) or republish (upload a new revision) a design
  server.handle(RPC_CHANNELS.designs.PUBLISH, async (
    _ctx,
    workspaceId: string,
    designSlug: string,
    options: { includeData: boolean; password?: string; viewOnlyAcknowledged?: boolean },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const updated = await publisher.publish(workspace.rootPath, workspace.id, designSlug, {
      includeData: options.includeData === true,
      password: options.password,
      viewOnlyAcknowledged: options.viewOnlyAcknowledged,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Set or clear the viewer password on an existing publication
  server.handle(RPC_CHANNELS.designs.SET_PUBLICATION_PASSWORD, async (
    _ctx,
    workspaceId: string,
    designSlug: string,
    password: string | null,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const updated = await publisher.setPassword(workspace.rootPath, workspace.id, designSlug, password)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Unpublish (revoke the public copy, clear the local pointer + vault token)
  server.handle(RPC_CHANNELS.designs.UNPUBLISH, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const result = await publisher.unpublish(workspace.rootPath, workspace.id, designSlug)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, getDesignConfigRelativePath(designSlug))
    await broadcastChanged(workspaceId, workspace.rootPath)
    return { config: result.config, warning: result.warning }
  })

  // ------------------------------------------------------------------
  // Thumbnails (cached poster). Generation is Electron-main-only; these
  // handlers serve the stored file and enqueue regeneration (a no-op on hosts
  // without an injected capturer).
  // ------------------------------------------------------------------

  // Read a design's poster as a data URL, but ONLY when it is fresh (the stored
  // digest matches the current content). Stale/missing → null → tile falls back.
  server.handle(RPC_CHANNELS.designs.GET_THUMBNAIL, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadDesignConfig, getDesignThumbnailPath, isThumbnailFresh } = await import('@craft-agent/shared/designs')
    const config = loadDesignConfig(workspace.rootPath, designSlug)
    if (!config || !isThumbnailFresh(config)) return null
    const path = getDesignThumbnailPath(workspace.rootPath, designSlug)
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
  server.handle(RPC_CHANNELS.designs.REGENERATE_THUMBNAIL, async (_ctx, workspaceId: string, designSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    deps.sessionManager.enqueueDesignThumbnail(workspaceId, workspace.rootPath, designSlug)
    return true
  })

  // ------------------------------------------------------------------
  // Export — pick a destination on the client, then write.
  //
  // HTML and ZIP are written here from the design's files. PDF, per-slide PNG,
  // motion video, and editable PPTX need a real renderer, so they go through the
  // injected `designExportRender` seam (the desktop app's hidden window); a host
  // without one refuses them.
  // ------------------------------------------------------------------
  server.handle(RPC_CHANNELS.designs.EXPORT, async (
    ctx,
    workspaceId: string,
    designSlug: string,
    format: DesignExportFormat,
  ): Promise<import('@craft-agent/shared/designs/types').DesignExportResult> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const {
      loadDesignConfig,
      designExportFileName,
      designExportFilters,
      designMotionFileName,
      designMotionFilters,
      resolveMotionSettings,
      writeDesignHtmlExport,
      writeDesignZipExport,
    } = await import('@craft-agent/shared/designs')

    const config = loadDesignConfig(workspace.rootPath, designSlug)
    if (!config) throw new Error(`Design not found: ${designSlug}`)
    // Defined iff the design is a deck — an authored aspect, or the 16:9 default.
    const aspect = config.deck ? (config.deck.aspect ?? '16:9') : undefined
    // Defined iff the design is a motion composition — defaults/bounds applied.
    const motion = config.motion ? resolveMotionSettings(config.motion) : undefined

    // Per-slide PNGs only make sense for a deck, video only for a motion
    // composition, and every engine-backed format needs the desktop renderer —
    // refuse before opening a picker we can't honor.
    if (format !== 'html' && format !== 'zip' && !deps.designExportRender) {
      throw new Error(`${format.toUpperCase()} export is only available in the desktop app.`)
    }
    // PNG is "one image per page", and a page is a convention the document follows: a deck's
    // `.slide`, or a prototype's canvas `.artboard`. Both are rendered by the same walk (see
    // design-exporter.ts), so both may ask for it — a webpage or a motion composition has no
    // pages, and is refused with the reason.
    if (format === 'png' && !config.deck && config.kind !== 'prototype') {
      throw new Error(
        'PNG export needs pages: a deck\'s slides (`<section class="slide">`) or a prototype\'s artboards (`.artboard`).',
      )
    }
    if (format === 'video' && !motion) {
      throw new Error('Video export is only available for motion designs.')
    }

    if (format === 'png') {
      const picked = await requestClientOpenFileDialog(server, ctx.clientId, {
        title: 'Choose a folder for the page images',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true, paths: [] }
      const paths = await deps.designExportRender!({
        format: 'png',
        workspaceRootPath: workspace.rootPath,
        slug: designSlug,
        destPath: picked.filePaths[0],
        aspect,
      })
      log.info(`Exported design ${designSlug} as ${paths.length} PNG(s)`)
      return { canceled: false, paths }
    }

    const picked = await requestClientSaveFileDialog(server, ctx.clientId, {
      title: `Export ${designSlug}`,
      ...(format === 'video'
        ? { defaultPath: designMotionFileName(designSlug), filters: designMotionFilters() }
        : { defaultPath: designExportFileName(designSlug, format), filters: designExportFilters(format) }),
    })
    if (picked.canceled || !picked.filePath) return { canceled: true, paths: [] }
    const destPath = picked.filePath

    let paths: string[]
    if (format === 'html') paths = [writeDesignHtmlExport(workspace.rootPath, designSlug, destPath)]
    else if (format === 'zip') paths = [writeDesignZipExport(workspace.rootPath, designSlug, destPath)]
    else if (format === 'video') paths = await deps.designExportRender!({
      format: 'video',
      workspaceRootPath: workspace.rootPath,
      slug: designSlug,
      destPath,
      aspect: motion!.aspect,
      motion: motion!,
    })
    else if (format === 'pptx') paths = await deps.designExportRender!({
      format: 'pptx',
      workspaceRootPath: workspace.rootPath,
      slug: designSlug,
      destPath,
      aspect,
    })
    else paths = await deps.designExportRender!({
      format: 'pdf',
      workspaceRootPath: workspace.rootPath,
      slug: designSlug,
      destPath,
      aspect,
    })

    log.info(`Exported design ${designSlug} as ${format}`)
    return { canceled: false, paths }
  })
}
