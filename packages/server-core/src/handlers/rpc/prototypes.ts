/**
 * Prototype Workbench RPC handlers.
 *
 * Watches the workspace-level prototypes directory so the app can react to
 * artifact changes (the entry `spec.md`, contract fragments, the files an author keeps
 * beside them) regardless of who wrote them — the agent, the control plane, or
 * an external editor.
 *
 * Mirrors the session file watcher (see ./sessions.ts): per-client state,
 * recursive fs.watch, 100ms debounce, pushed as `prototypes:changed`.
 */
import { watch } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { ensureWorkspacePrototypesPath } from '@craft-agent/shared/workspaces'
import { createPrototype, deletePrototype, duplicatePrototype, listPrototypeStatuses } from '@craft-agent/shared/prototypes'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.prototypes.WATCH,
  RPC_CHANNELS.prototypes.UNWATCH,
  RPC_CHANNELS.prototypes.LIST,
  RPC_CHANNELS.prototypes.CREATE,
  RPC_CHANNELS.prototypes.DUPLICATE,
  RPC_CHANNELS.prototypes.DELETE,
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

  // Create a prototype (the panel's "New Prototype"). It is a folder plus a starter
  // `spec.md`, so creation asks for nothing but a name — there is no kind, no address
  // and no layout to ask about.
  server.handle(
    RPC_CHANNELS.prototypes.CREATE,
    async (_ctx, workspaceId: string, input: { name?: string }) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_CREATE: Workspace not found: ${workspaceId}`)
      const created = createPrototype(workspace.rootPath, { name: input?.name ?? '' })
      log.info(`PROTOTYPES_CREATE: ${created.slug}`)
      return created
    },
  )

  // Copy a prototype into a new one — the panel's "Duplicate". Two prototypes
  // stop sharing anything the moment the copy exists; the caller is told the new
  // slug so it can open it.
  server.handle(
    RPC_CHANNELS.prototypes.DUPLICATE,
    async (_ctx, workspaceId: string, slug: string, options?: { name?: string }) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_DUPLICATE: Workspace not found: ${workspaceId}`)
      const copied = duplicatePrototype(workspace.rootPath, slug, options)
      log.info(`PROTOTYPES_DUPLICATE: ${slug} → ${copied.slug}`)
      return copied
    },
  )

  // Delete a prototype. No confirmation here: this is the layer that does what
  // it is told, and the panel has already asked (the agent has no command that
  // reaches this).
  server.handle(
    RPC_CHANNELS.prototypes.DELETE,
    async (_ctx, workspaceId: string, slug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_DELETE: Workspace not found: ${workspaceId}`)
      const deleted = deletePrototype(workspace.rootPath, slug)
      log.info(`PROTOTYPES_DELETE: ${slug}`)
      return deleted
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
