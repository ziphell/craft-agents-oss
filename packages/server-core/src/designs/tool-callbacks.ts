/**
 * Designs Tool Callbacks
 *
 * Backend implementation of the agent-facing designs tools (list_designs,
 * get_design, create_design, update_design, write_design_data, delete_design).
 * SessionManager wires one instance per session, bound to the invoking
 * session's workspace, into the session-scoped tool callback registry.
 *
 * Storage flows are the SAME primitives the designs RPC handlers use
 * (@craft-agent/shared/designs) — including deleteDesignWithUnpublish, shared
 * verbatim with the designs:delete RPC so the two delete paths cannot drift.
 * Every mutation calls deps.onDesignsMutated so the host can poke the config
 * watcher and broadcast `designs:changed`, exactly like the RPC handlers do.
 */

import { existsSync, statSync } from 'node:fs'
import type {
  DesignsToolCallbacks,
  DesignToolSummary,
  DesignToolDetails,
  DesignToolDataSummary,
  CreateDesignToolInput,
  UpdateDesignToolPatch,
  DesignDataToolPatch,
  DesignToolDeckSpec,
  DesignToolMotionSpec,
} from '@craft-agent/session-tools-core'
import {
  MOTION_DURATION_MS_MAX,
  MOTION_DURATION_MS_MIN,
  MOTION_FPS_MAX,
  MOTION_FPS_MIN,
  designPreviewUrl,
  getDesignPath,
  isDesignKind,
  type LoadedDesign,
  type DesignConfig,
  type DesignDataSnapshot,
  type DesignKind,
  type DesignRefreshSpec,
  type DesignDeckSpec,
  type DesignMotionSpec,
  type UpdateDesignPatch,
} from '@craft-agent/shared/designs'
import { isDesignGrantUsable } from '@craft-agent/shared/designs/types'

export interface DesignsToolCallbacksDeps {
  workspaceId: string
  workspaceRootPath: string
  log?: (message: string) => void
  /**
   * Called after every successful mutation (create/update/write/delete) with
   * the design slug. The host notifies the config watcher and broadcasts
   * `designs:changed` here.
   */
  onDesignsMutated?: (designSlug: string) => void | Promise<void>
  /**
   * Called specifically when a design's HTML content changed (create-with-content
   * or update-with-content) so the host can enqueue a thumbnail (re)capture.
   * Not fired for data-only writes (those don't change the content digest).
   */
  onContentChanged?: (designSlug: string) => void
}

const DECK_ASPECTS: readonly string[] = ['16:9', '4:3', '16:10', '9:16']

/**
 * The tool surface takes `kind` as a string (this package must stay free of the
 * core types), so an unknown one is refused here rather than written. Whether
 * the kind and its settings agree is decided by the storage layer, which is the
 * one place both paths pass through.
 */
function assertKind(kind: string | undefined): DesignKind | undefined {
  if (kind === undefined) return undefined
  if (!isDesignKind(kind)) {
    throw new Error(`Invalid design kind "${kind}" — expected webpage | prototype | deck | motion`)
  }
  return kind
}

/**
 * Validate a deck hint from the tool boundary. `aspect` arrives as free-form
 * text (the context package mirrors the shape without the union), so an unknown
 * ratio is rejected here rather than written to design.json. `null` clears.
 */
function assertDeckSpec(deck: DesignToolDeckSpec | null | undefined): DesignDeckSpec | null | undefined {
  if (deck === undefined) return undefined
  if (deck === null) return null
  if (deck.aspect !== undefined && !DECK_ASPECTS.includes(deck.aspect)) {
    throw new Error(`Invalid deck aspect "${deck.aspect}" — expected one of ${DECK_ASPECTS.join(' | ')}`)
  }
  return {
    ...(deck.aspect !== undefined ? { aspect: deck.aspect as DesignDeckSpec['aspect'] } : {}),
    ...(deck.theme !== undefined ? { theme: deck.theme } : {}),
  }
}

/**
 * Validate a motion hint from the tool boundary. Mirrors assertDeckSpec: the
 * context package mirrors the shape without the unions, so an unknown aspect
 * ratio or an out-of-bounds fps/duration is rejected here rather than written
 * to design.json. `null` clears. The aspect union is the deck's (same ratios).
 */
function assertMotionSpec(motion: DesignToolMotionSpec | null | undefined): DesignMotionSpec | null | undefined {
  if (motion === undefined) return undefined
  if (motion === null) return null
  if (motion.aspect !== undefined && !DECK_ASPECTS.includes(motion.aspect)) {
    throw new Error(`Invalid motion aspect "${motion.aspect}" — expected one of ${DECK_ASPECTS.join(' | ')}`)
  }
  if (motion.fps !== undefined && (!Number.isInteger(motion.fps) || motion.fps < MOTION_FPS_MIN || motion.fps > MOTION_FPS_MAX)) {
    throw new Error(`Invalid motion fps "${motion.fps}" — expected an integer ${MOTION_FPS_MIN}–${MOTION_FPS_MAX}`)
  }
  if (
    motion.durationMs !== undefined &&
    (!Number.isInteger(motion.durationMs) || motion.durationMs < MOTION_DURATION_MS_MIN || motion.durationMs > MOTION_DURATION_MS_MAX)
  ) {
    throw new Error(`Invalid motion durationMs "${motion.durationMs}" — expected an integer ${MOTION_DURATION_MS_MIN}–${MOTION_DURATION_MS_MAX}`)
  }
  return {
    ...(motion.fps !== undefined ? { fps: motion.fps } : {}),
    ...(motion.durationMs !== undefined ? { durationMs: motion.durationMs } : {}),
    ...(motion.aspect !== undefined ? { aspect: motion.aspect as DesignMotionSpec['aspect'] } : {}),
  }
}

function toSummary(design: LoadedDesign): DesignToolSummary {
  const config = design.config
  return {
    slug: config.slug,
    name: config.name,
    description: config.description,
    kind: config.kind,
    projectId: config.projectId,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    hasContent: existsSync(design.contentPath),
    refresh: config.refresh,
    ...(config.deck ? { deck: config.deck } : {}),
    ...(config.motion ? { motion: config.motion } : {}),
    lastRefresh: config.lastRefresh,
    shared: config.share !== undefined,
    folderPath: design.folderPath,
  }
}

function toDataSummary(design: LoadedDesign, snapshot: DesignDataSnapshot | null): DesignToolDataSummary | null {
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
    snapshotPath: design.snapshotPath,
  }
}

function toDetails(
  design: LoadedDesign,
  options: { includeContent: boolean },
  helpers: {
    readSnapshot: () => DesignDataSnapshot | null
    loadContent: () => string | null
  },
): DesignToolDetails {
  const config = design.config
  const summary = toSummary(design)

  let contentLength: number | undefined
  if (summary.hasContent) {
    try {
      contentLength = statSync(design.contentPath).size
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
    stale: !isDesignGrantUsable(grant, config.contentDigest, now),
  }))

  return {
    ...summary,
    id: config.id,
    contentDigest: config.contentDigest,
    contentLength,
    contentPath: design.contentPath,
    // Where the design lives as a page — what `browser_tool` opens to read or drive it.
    previewUrl: designPreviewUrl(config.slug, getDesignPath(design.workspaceRootPath, config.slug)),
    data: toDataSummary(design, helpers.readSnapshot()),
    grants,
    shareUrl: config.share?.url,
    ...(options.includeContent ? { content: helpers.loadContent() ?? undefined } : {}),
  }
}

export function buildDesignsToolCallbacks(deps: DesignsToolCallbacksDeps): DesignsToolCallbacks {
  const { workspaceId, workspaceRootPath } = deps

  async function loadDetails(slug: string, includeContent = false): Promise<DesignToolDetails | null> {
    const { loadDesign, loadDesignById, readDesignDataSnapshot, loadDesignContent } = await import('@craft-agent/shared/designs')
    const design = loadDesign(workspaceRootPath, slug) ?? loadDesignById(workspaceRootPath, slug)
    if (!design) return null
    return toDetails(design, { includeContent }, {
      readSnapshot: () => readDesignDataSnapshot(workspaceRootPath, design.config.slug),
      loadContent: () => loadDesignContent(workspaceRootPath, design.config.slug),
    })
  }

  async function mutated(designSlug: string): Promise<void> {
    try {
      await deps.onDesignsMutated?.(designSlug)
    } catch (error) {
      deps.log?.(`designs tool: post-mutation notify failed for ${designSlug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async listDesigns(): Promise<DesignToolSummary[]> {
      const { loadWorkspaceDesigns } = await import('@craft-agent/shared/designs')
      return loadWorkspaceDesigns(workspaceRootPath).map(toSummary)
    },

    async getDesign(slug: string, options?: { includeContent?: boolean }): Promise<DesignToolDetails | null> {
      return loadDetails(slug, options?.includeContent === true)
    },

    async createDesign(input: CreateDesignToolInput): Promise<DesignToolDetails> {
      const { createDesign } = await import('@craft-agent/shared/designs')
      const config = createDesign(workspaceRootPath, {
        name: input.name.trim(),
        description: input.description,
        kind: assertKind(input.kind),
        projectId: input.projectId,
        deck: assertDeckSpec(input.deck) ?? undefined,
        motion: assertMotionSpec(input.motion) ?? undefined,
        content: input.content,
        refresh: input.refresh as DesignRefreshSpec | undefined,
      })
      await mutated(config.slug)
      if (input.content !== undefined) deps.onContentChanged?.(config.slug)
      deps.log?.(`designs tool: created design ${config.slug} in workspace ${workspaceId}`)
      const details = await loadDetails(config.slug)
      if (!details) throw new Error(`Created design ${config.slug} but failed to reload it`)
      return details
    },

    async updateDesign(slug: string, patch: UpdateDesignToolPatch): Promise<DesignToolDetails> {
      const { updateDesign, saveDesignContent, loadDesign } = await import('@craft-agent/shared/designs')
      const existing = loadDesign(workspaceRootPath, slug)
      if (!existing) throw new Error(`Design not found: ${slug}`)

      // Config patch: only include provided keys. Explicit null passes
      // through — "null clears" is normalized once, inside shared updateDesign,
      // so this path and the designs:update RPC cannot drift.
      const configPatch: UpdateDesignPatch = {}
      if (patch.name !== undefined) configPatch.name = patch.name.trim()
      if (patch.kind !== undefined) configPatch.kind = assertKind(patch.kind)
      if (patch.description !== undefined) configPatch.description = patch.description
      if (patch.projectId !== undefined) configPatch.projectId = patch.projectId
      if (patch.refresh !== undefined) configPatch.refresh = patch.refresh as DesignRefreshSpec | null
      if (patch.deck !== undefined) configPatch.deck = assertDeckSpec(patch.deck)
      if (patch.motion !== undefined) configPatch.motion = assertMotionSpec(patch.motion)

      if (Object.keys(configPatch).length > 0) {
        updateDesign(workspaceRootPath, existing.config.slug, configPatch)
      }
      if (patch.content !== undefined) {
        saveDesignContent(workspaceRootPath, existing.config.slug, patch.content)
      }

      await mutated(existing.config.slug)
      if (patch.content !== undefined) deps.onContentChanged?.(existing.config.slug)
      const details = await loadDetails(existing.config.slug)
      if (!details) throw new Error(`Updated design ${slug} but failed to reload it`)
      return details
    },

    async writeDesignData(slug: string, patch: DesignDataToolPatch) {
      const { writeDesignData } = await import('@craft-agent/shared/designs')
      const { result } = await writeDesignData(workspaceRootPath, slug, patch)
      await mutated(slug)
      return {
        slug: result.designSlug,
        kvCount: result.kvCount,
        seriesCount: result.seriesCount,
        generatedAt: result.generatedAt,
        snapshotPath: result.snapshotPath,
        durationMs: result.durationMs,
      }
    },

    async deleteDesign(slug: string) {
      const { deleteDesignWithUnpublish, loadDesign } = await import('@craft-agent/shared/designs')
      const existing = loadDesign(workspaceRootPath, slug)
      if (!existing) throw new Error(`Design not found: ${slug}`)
      const outcome = await deleteDesignWithUnpublish(workspaceRootPath, workspaceId, existing.config.slug, { log: deps.log })
      await mutated(existing.config.slug)
      deps.log?.(`designs tool: deleted design ${existing.config.slug}`)
      return { deleted: true as const, publicCopyMayRemain: outcome.publicCopyMayRemain }
    },
  }
}
