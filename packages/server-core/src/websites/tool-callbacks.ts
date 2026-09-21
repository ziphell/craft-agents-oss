/**
 * Websites Tool Callbacks
 *
 * Backend implementation of the agent-facing websites tools (list_websites,
 * get_website, create_website, update_website, write_website_data,
 * delete_website). SessionManager wires one instance per session, bound to the
 * invoking session's workspace, into the session-scoped tool callback registry.
 *
 * Storage flows are the SAME primitives the websites RPC handlers use
 * (@craft-agent/shared/websites) — including deleteWebsiteWithUnpublish, shared
 * verbatim with the websites:delete RPC so the two delete paths cannot drift.
 * Every mutation calls deps.onWebsitesMutated so the host can poke the config
 * watcher and broadcast `websites:changed`, exactly like the RPC handlers do.
 */

import { existsSync, statSync } from 'node:fs'
import type {
  WebsiteToolCallbacks,
  WebsiteToolSummary,
  WebsiteToolDetails,
  WebsiteToolDataSummary,
  CreateWebsiteToolInput,
  UpdateWebsiteToolPatch,
  WebsiteDataToolPatch,
} from '@craft-agent/session-tools-core'
import type { LoadedWebsite, WebsiteConfig, WebsiteDataSnapshot, WebsiteKind, WebsiteRefreshSpec, UpdateWebsitePatch } from '@craft-agent/shared/websites'
import { isWebsiteGrantUsable } from '@craft-agent/shared/websites/types'

export interface WebsitesToolCallbacksDeps {
  workspaceId: string
  workspaceRootPath: string
  log?: (message: string) => void
  /**
   * Called after every successful mutation (create/update/write/delete) with
   * the website slug. The host notifies the config watcher and broadcasts
   * `websites:changed` here.
   */
  onWebsitesMutated?: (websiteSlug: string) => void | Promise<void>
  /**
   * Called specifically when a website's HTML content changed (create-with-content
   * or update-with-content) so the host can enqueue a thumbnail (re)capture.
   * Not fired for data-only writes (those don't change the content digest).
   */
  onContentChanged?: (websiteSlug: string) => void
}

const WEBSITE_KINDS: readonly string[] = ['static', 'interactive', 'live']

function assertKind(kind: string | undefined): WebsiteKind | undefined {
  if (kind === undefined) return undefined
  if (!WEBSITE_KINDS.includes(kind)) {
    throw new Error(`Invalid website kind "${kind}" — expected static | interactive | live`)
  }
  return kind as WebsiteKind
}

function toSummary(website: LoadedWebsite): WebsiteToolSummary {
  const config = website.config
  return {
    slug: config.slug,
    name: config.name,
    description: config.description,
    kind: config.kind,
    projectId: config.projectId,
    originSessionId: config.originSessionId,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    hasContent: existsSync(website.contentPath),
    refresh: config.refresh,
    lastRefresh: config.lastRefresh,
    shared: config.share !== undefined,
    folderPath: website.folderPath,
  }
}

function toDataSummary(website: LoadedWebsite, snapshot: WebsiteDataSnapshot | null): WebsiteToolDataSummary | null {
  if (!snapshot) return null
  return {
    generatedAt: snapshot.generatedAt,
    kvKeys: Object.keys(snapshot.kv),
    series: Object.entries(snapshot.series).map(([name, points]) => ({
      name,
      points: points.length,
      // Snapshot series are ascending by t — the last point is the newest.
      latest: points.length > 0 ? points[points.length - 1] : undefined,
    })),
    snapshotPath: website.snapshotPath,
  }
}

function toDetails(
  website: LoadedWebsite,
  options: { includeContent: boolean },
  helpers: {
    readSnapshot: () => WebsiteDataSnapshot | null
    loadContent: () => string | null
  },
): WebsiteToolDetails {
  const config = website.config
  const summary = toSummary(website)

  let contentLength: number | undefined
  if (summary.hasContent) {
    try {
      contentLength = statSync(website.contentPath).size
    } catch {
      contentLength = undefined
    }
  }

  const now = Date.now()
  const grants = (config.grants ?? []).map((grant) => ({
    id: grant.id,
    kind: grant.action.kind,
    ...(grant.action.kind === 'script'
      ? { script: grant.action.script }
      : { sourceSlug: grant.action.sourceSlug }),
    description: grant.description,
    expiresAt: grant.expiresAt,
    stale: !isWebsiteGrantUsable(grant, config.contentDigest, now),
  }))

  return {
    ...summary,
    id: config.id,
    contentDigest: config.contentDigest,
    contentLength,
    contentPath: website.contentPath,
    data: toDataSummary(website, helpers.readSnapshot()),
    grants,
    shareUrl: config.share?.url,
    ...(options.includeContent ? { content: helpers.loadContent() ?? undefined } : {}),
  }
}

export function buildWebsitesToolCallbacks(deps: WebsitesToolCallbacksDeps): WebsiteToolCallbacks {
  const { workspaceId, workspaceRootPath } = deps

  async function loadDetails(slug: string, includeContent = false): Promise<WebsiteToolDetails | null> {
    const { loadWebsite, loadWebsiteById, readWebsiteDataSnapshot, loadWebsiteContent } = await import('@craft-agent/shared/websites')
    const website = loadWebsite(workspaceRootPath, slug) ?? loadWebsiteById(workspaceRootPath, slug)
    if (!website) return null
    return toDetails(website, { includeContent }, {
      readSnapshot: () => readWebsiteDataSnapshot(workspaceRootPath, website.config.slug),
      loadContent: () => loadWebsiteContent(workspaceRootPath, website.config.slug),
    })
  }

  async function mutated(websiteSlug: string): Promise<void> {
    try {
      await deps.onWebsitesMutated?.(websiteSlug)
    } catch (error) {
      deps.log?.(`websites tool: post-mutation notify failed for ${websiteSlug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async listWebsites(): Promise<WebsiteToolSummary[]> {
      const { loadWorkspaceWebsites } = await import('@craft-agent/shared/websites')
      return loadWorkspaceWebsites(workspaceRootPath).map(toSummary)
    },

    async getWebsite(slug: string, options?: { includeContent?: boolean }): Promise<WebsiteToolDetails | null> {
      return loadDetails(slug, options?.includeContent === true)
    },

    async createWebsite(input: CreateWebsiteToolInput): Promise<WebsiteToolDetails> {
      const { createWebsite } = await import('@craft-agent/shared/websites')
      const config = createWebsite(workspaceRootPath, {
        name: input.name.trim(),
        description: input.description,
        kind: assertKind(input.kind),
        projectId: input.projectId,
        content: input.content,
        refresh: input.refresh as WebsiteRefreshSpec | undefined,
      })
      await mutated(config.slug)
      if (input.content !== undefined) deps.onContentChanged?.(config.slug)
      deps.log?.(`websites tool: created website ${config.slug} in workspace ${workspaceId}`)
      const details = await loadDetails(config.slug)
      if (!details) throw new Error(`Created website ${config.slug} but failed to reload it`)
      return details
    },

    async updateWebsite(slug: string, patch: UpdateWebsiteToolPatch): Promise<WebsiteToolDetails> {
      const { updateWebsite, saveWebsiteContent, loadWebsite } = await import('@craft-agent/shared/websites')
      const existing = loadWebsite(workspaceRootPath, slug)
      if (!existing) throw new Error(`Website not found: ${slug}`)

      // Config patch: only include provided keys. Explicit null passes
      // through — "null clears" is normalized once, inside shared updateWebsite,
      // so this path and the websites:update RPC cannot drift.
      const configPatch: UpdateWebsitePatch = {}
      if (patch.name !== undefined) configPatch.name = patch.name.trim()
      if (patch.kind !== undefined) configPatch.kind = assertKind(patch.kind)
      if (patch.description !== undefined) configPatch.description = patch.description
      if (patch.projectId !== undefined) configPatch.projectId = patch.projectId
      if (patch.refresh !== undefined) configPatch.refresh = patch.refresh as WebsiteRefreshSpec | null

      if (Object.keys(configPatch).length > 0) {
        updateWebsite(workspaceRootPath, existing.config.slug, configPatch)
      }
      if (patch.content !== undefined) {
        saveWebsiteContent(workspaceRootPath, existing.config.slug, patch.content)
      }

      await mutated(existing.config.slug)
      if (patch.content !== undefined) deps.onContentChanged?.(existing.config.slug)
      const details = await loadDetails(existing.config.slug)
      if (!details) throw new Error(`Updated website ${slug} but failed to reload it`)
      return details
    },

    async writeWebsiteData(slug: string, patch: WebsiteDataToolPatch) {
      const { writeWebsiteData } = await import('@craft-agent/shared/websites')
      const { result } = await writeWebsiteData(workspaceRootPath, slug, patch)
      await mutated(slug)
      return {
        slug: result.websiteSlug,
        kvCount: result.kvCount,
        seriesCount: result.seriesCount,
        generatedAt: result.generatedAt,
        snapshotPath: result.snapshotPath,
        durationMs: result.durationMs,
      }
    },

    async deleteWebsite(slug: string) {
      const { deleteWebsiteWithUnpublish, loadWebsite } = await import('@craft-agent/shared/websites')
      const existing = loadWebsite(workspaceRootPath, slug)
      if (!existing) throw new Error(`Website not found: ${slug}`)
      const outcome = await deleteWebsiteWithUnpublish(workspaceRootPath, workspaceId, existing.config.slug, { log: deps.log })
      await mutated(existing.config.slug)
      deps.log?.(`websites tool: deleted website ${existing.config.slug}`)
      return { deleted: true as const, publicCopyMayRemain: outcome.publicCopyMayRemain }
    },
  }
}
