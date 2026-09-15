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
import { exportPrototype, createPrototype, importPrototype, linkPrototypeReference, listPrototypeStatuses, resolvePrototypeEntry, setPrototypeTargetUrl, unlinkPrototypeReference } from '@craft-agent/shared/prototypes'
import type { PrototypeKind } from '@craft-agent/shared/prototypes'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import {
  applyPrototypeToBrowser,
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
  RPC_CHANNELS.prototypes.LINK_REFERENCE,
  RPC_CHANNELS.prototypes.UNLINK_REFERENCE,
  RPC_CHANNELS.prototypes.IMPORT,
  RPC_CHANNELS.prototypes.SET_TARGET,
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

  // Resolve what to open. Two kinds, two answers: an overlay opens the live
  // address it was made against and needs its patches injected into that page,
  // a from-scratch prototype opens the host rendering its own base.html with
  // every patch already inlined. Never the exported deliverable — that is a
  // stale copy from an earlier export, not a page you can go on editing. Throws
  // with what is missing named when there is nothing to open, so the panel
  // surfaces that message instead of a failed page load.
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

  // Create a prototype (the panel's "New Prototype").
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

  // Copy another prototype's page and patches in. The counterpart of a reference,
  // and deliberately not the same thing: a reference keeps the other prototype's
  // patches out of this one, an import moves them in.
  server.handle(
    RPC_CHANNELS.prototypes.IMPORT,
    async (_ctx, workspaceId: string, slug: string, sourceSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_IMPORT: Workspace not found: ${workspaceId}`)
      const imported = importPrototype(workspace.rootPath, slug, sourceSlug)
      log.info(
        `PROTOTYPES_IMPORT: ${slug} ← ${sourceSlug} (${imported.copiedPatches.length} patches, ` +
          `${imported.skippedPatches.length} left as they were)`,
      )
      return imported
    },
  )

  // Repoint an overlay at the same page in another environment. File work only,
  // and no confirmation step: the address is a fact about where the page is, not a
  // rule of the kind. The two things that go stale silently (windows open on the
  // old page, selectors written against the old DOM) are said by whoever asks —
  // the command says them, and the panel puts them next to the field.
  server.handle(
    RPC_CHANNELS.prototypes.SET_TARGET,
    async (_ctx, workspaceId: string, slug: string, targetUrl: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_SET_TARGET: Workspace not found: ${workspaceId}`)
      const config = setPrototypeTargetUrl(workspace.rootPath, slug, targetUrl)
      log.info(`PROTOTYPES_SET_TARGET: ${slug} → ${config.targetUrl}`)
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
