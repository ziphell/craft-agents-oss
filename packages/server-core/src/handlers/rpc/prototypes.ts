/**
 * Prototype Workbench RPC handlers.
 *
 * Watches the workspace-level prototypes directory so the app can react to
 * artifact changes (patches, API contract fragments, fixtures) regardless of
 * who wrote them — the agent, the control plane, or an external editor.
 *
 * Mirrors the session file watcher (see ./sessions.ts): per-client state,
 * recursive fs.watch, 100ms debounce, pushed as `prototypes:changed`.
 *
 * @see docs/prototype-workbench-plan.md §1.4
 */
import { watch } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { ensureWorkspacePrototypesPath } from '@craft-agent/shared/workspaces'
import { exportPrototype, createPrototype, linkPrototypeReference, listPrototypeStatuses, resolvePrototypeEntry, unlinkPrototypeReference, writePrototypeBase } from '@craft-agent/shared/prototypes'
import type { PrototypeKind } from '@craft-agent/shared/prototypes'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import {
  applyPrototypeToBrowser,
  captureRenderedDocument,
} from '../../domain/apply-prototype'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.prototypes.WATCH,
  RPC_CHANNELS.prototypes.UNWATCH,
  RPC_CHANNELS.prototypes.LIST,
  RPC_CHANNELS.prototypes.ENTRY,
  RPC_CHANNELS.prototypes.EXPORT,
  RPC_CHANNELS.prototypes.CREATE,
  RPC_CHANNELS.prototypes.APPLY,
  RPC_CHANNELS.prototypes.CAPTURE,
  RPC_CHANNELS.prototypes.LINK_REFERENCE,
  RPC_CHANNELS.prototypes.UNLINK_REFERENCE,
] as const

/** Batch rapid changes before notifying (matches the session file watcher). */
const WATCH_DEBOUNCE_MS = 100

interface ClientPrototypesWatchState {
  watcher: import('fs').FSWatcher
  workspaceId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client watcher state (supports concurrent windows/clients safely)
const clientPrototypesWatches = new Map<string, ClientPrototypesWatchState>()

/** Ignore hidden files (.DS_Store, editor swap files, …) */
function isIgnoredFile(filename: string | null): boolean {
  if (!filename) return false
  return filename.startsWith('.') || filename.includes('/.') || filename.includes('\\.')
}

export function cleanupPrototypesWatchForClient(clientId: string): void {
  const state = clientPrototypesWatches.get(clientId)
  if (!state) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.watcher.close()
  clientPrototypesWatches.delete(clientId)
}

export function registerPrototypesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // List every prototype in the workspace, with its derived status.
  server.handle(RPC_CHANNELS.prototypes.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PROTOTYPES_LIST: Workspace not found: ${workspaceId}`)
      return []
    }
    return listPrototypeStatuses(workspace.rootPath)
  })

  // Resolve what to open (the exported deliverable, else base.html). Throws with
  // both remedies named when a project has neither — the panel surfaces that
  // message directly instead of showing a failed page load.
  server.handle(RPC_CHANNELS.prototypes.ENTRY, async (_ctx, workspaceId: string, slug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`PROTOTYPES_ENTRY: Workspace not found: ${workspaceId}`)
    return resolvePrototypeEntry(workspace.rootPath, slug)
  })

  // Write dist/* for a prototype so it can be handed to developers.
  server.handle(RPC_CHANNELS.prototypes.EXPORT, async (_ctx, workspaceId: string, slug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`PROTOTYPES_EXPORT: Workspace not found: ${workspaceId}`)
    const result = exportPrototype(workspace.rootPath, slug)
    log.info(`PROTOTYPES_EXPORT: ${slug} → ${result.htmlPath} (${result.applied} patches)`)
    return result
  })

  // Create a prototype project (the panel's "New Prototype").
  server.handle(
    RPC_CHANNELS.prototypes.CREATE,
    async (_ctx, workspaceId: string, input: { name?: string; kind?: PrototypeKind; targetUrl?: string }) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_CREATE: Workspace not found: ${workspaceId}`)
      const created = createPrototype(workspace.rootPath, {
        name: input?.name ?? '',
        kind: input?.kind,
        targetUrl: input?.targetUrl,
      })
      log.info(`PROTOTYPES_CREATE: ${created.slug} (${created.kind})`)
      return created
    },
  )

  // Replay a prototype's patches into a live browser instance. The instance id
  // comes from the caller because it owns the browser window it is looking at.
  server.handle(
    RPC_CHANNELS.prototypes.APPLY,
    async (_ctx, workspaceId: string, instanceId: string, slug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_APPLY: Workspace not found: ${workspaceId}`)
      if (!deps.browserPaneManager) {
        throw new Error('PROTOTYPES_APPLY: this host has no browser pane manager.')
      }
      const result = await applyPrototypeToBrowser(
        deps.browserPaneManager,
        instanceId,
        workspace.rootPath,
        slug,
      )
      log.info(`PROTOTYPES_APPLY: ${slug} → ${result.applied} patch(es) into ${instanceId}`)
      return result
    },
  )

  // Replace base.html with the rendered document of a live page. Going through
  // the browser (rather than fetching the URL) is what makes this work for
  // client-rendered apps and authenticated sessions.
  server.handle(
    RPC_CHANNELS.prototypes.CAPTURE,
    async (_ctx, workspaceId: string, instanceId: string, slug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_CAPTURE: Workspace not found: ${workspaceId}`)
      if (!deps.browserPaneManager) {
        throw new Error('PROTOTYPES_CAPTURE: this host has no browser pane manager.')
      }
      const markup = await captureRenderedDocument(deps.browserPaneManager, instanceId)
      const captured = writePrototypeBase(workspace.rootPath, slug, markup)
      log.info(`PROTOTYPES_CAPTURE: ${slug} ← ${captured.bytes} bytes from ${instanceId}`)
      return captured
    },
  )

  // References are a relation between two prototypes, not a third kind: the
  // reader keeps its own patches and the reference keeps its own, which is what
  // stops reference selectors from being inlined into the reader's deliverable.
  server.handle(
    RPC_CHANNELS.prototypes.LINK_REFERENCE,
    async (_ctx, workspaceId: string, slug: string, referenceSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_LINK_REFERENCE: Workspace not found: ${workspaceId}`)
      const config = linkPrototypeReference(workspace.rootPath, slug, referenceSlug)
      log.info(`PROTOTYPES_LINK_REFERENCE: ${slug} ← reference ${referenceSlug}`)
      return config
    },
  )

  server.handle(
    RPC_CHANNELS.prototypes.UNLINK_REFERENCE,
    async (_ctx, workspaceId: string, slug: string, referenceSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_UNLINK_REFERENCE: Workspace not found: ${workspaceId}`)
      const config = unlinkPrototypeReference(workspace.rootPath, slug, referenceSlug)
      log.info(`PROTOTYPES_UNLINK_REFERENCE: ${slug} ↛ reference ${referenceSlug}`)
      return config
    },
  )

  // Start watching the workspace prototypes directory for artifact changes
  server.handle(RPC_CHANNELS.prototypes.WATCH, async (ctx) => {
    const clientId = ctx.clientId
    cleanupPrototypesWatchForClient(clientId)

    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const workspace = getWorkspaceByNameOrId(workspaceId ?? '')
    if (!workspace) return

    try {
      // The prototypes folder is a system-created container; make sure it exists
      // before watching so the first watch call cannot fail with ENOENT.
      const prototypesPath = ensureWorkspacePrototypesPath(workspace.rootPath)

      const state: ClientPrototypesWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        workspaceId: workspace.id,
        debounceTimer: null,
      }

      state.watcher = watch(prototypesPath, { recursive: true }, (_eventType, filename) => {
        if (isIgnoredFile(filename)) return

        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }
        state.debounceTimer = setTimeout(() => {
          pushTyped(
            server,
            RPC_CHANNELS.prototypes.CHANGED,
            { to: 'client', clientId },
            state.workspaceId,
            filename ?? null,
          )
        }, WATCH_DEBOUNCE_MS)
      })

      clientPrototypesWatches.set(clientId, state)
    } catch (error) {
      deps.platform.logger.error('Failed to start prototypes watcher:', error)
    }
  })

  // Stop watching prototypes for the calling client
  server.handle(RPC_CHANNELS.prototypes.UNWATCH, async (ctx) => {
    cleanupPrototypesWatchForClient(ctx.clientId)
  })
}
