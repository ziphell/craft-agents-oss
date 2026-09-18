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
import { exportPrototype, createPrototype, deletePrototype, duplicatePrototype, listPrototypeStatuses, resolvePrototypeEntry, setPrototypePageUrl, updatePrototypePages } from '@craft-agent/shared/prototypes'
import type { PrototypePagesChange } from '@craft-agent/shared/prototypes'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import {
  applyPrototypeToBrowser,
  replayPrototypeInBrowser,
} from '../../domain/apply-prototype'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.prototypes.WATCH,
  RPC_CHANNELS.prototypes.UNWATCH,
  RPC_CHANNELS.prototypes.LIST,
  RPC_CHANNELS.prototypes.ENTRY,
  RPC_CHANNELS.prototypes.EXPORT,
  RPC_CHANNELS.prototypes.CREATE,
  RPC_CHANNELS.prototypes.DUPLICATE,
  RPC_CHANNELS.prototypes.DELETE,
  RPC_CHANNELS.prototypes.APPLY,
  RPC_CHANNELS.prototypes.SET_PAGES,
  RPC_CHANNELS.prototypes.SET_TARGET,
  RPC_CHANNELS.prototypes.REPLAY,
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
  // address it was made against and needs its patches injected into that page; a
  // page of ours opens at the host's address for that document, with its patches
  // already inlined; with no entry page the root shows the generated index. A named
  // page resolves to that page — the address bar's own answer, which the caller
  // loads rather than being redirected to (the bar and the view are two things).
  // Never the exported deliverable — that is a stale copy from an earlier export,
  // not a page you can go on editing. Throws with what is missing named when there
  // is nothing to open, so the panel surfaces that message instead of a failed page
  // load.
  server.handle(
    RPC_CHANNELS.prototypes.ENTRY,
    async (_ctx, workspaceId: string, slug: string, page?: string | null) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_ENTRY: Workspace not found: ${workspaceId}`)
      return resolvePrototypeEntry(workspace.rootPath, slug, page)
    },
  )

  // Write dist/* for a prototype so it can be handed to developers.
  server.handle(RPC_CHANNELS.prototypes.EXPORT, async (_ctx, workspaceId: string, slug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`PROTOTYPES_EXPORT: Workspace not found: ${workspaceId}`)
    const result = exportPrototype(workspace.rootPath, slug)
    log.info(`PROTOTYPES_EXPORT: ${slug} → ${result.extensionDir} (${result.applied} patches)`)
    return result
  })

  // Create a prototype (the panel's "New Prototype"). It is a container for pages
  // and gets none: a page is either a document of ours or a live page added
  // afterwards, so creation asks for nothing but a name (plan §19.8).
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
      // The page this apply is about: the one on screen, which is the page the caller is
      // looking at — this endpoint has no conversation to route by, it has a window (第十二轮).
      const page = (await deps.browserPaneManager.listTabsAsync(instanceId).catch(() => []))
        .find((tab) => tab.active) ?? null
      const result = await applyPrototypeToBrowser(
        deps.browserPaneManager,
        instanceId,
        workspace.rootPath,
        slug,
        page,
      )
      log.info(`PROTOTYPES_APPLY: ${slug} → ${result.applied} patch(es) into ${instanceId}`)
      return result
    },
  )

  // Replay one prototype into every **page** showing it, after its files changed
  // (plan §21.4). No instance id: the caller knows *what* changed (the watcher
  // named the file), the main process knows *which pages* are on it — and the
  // decision of what a replay means (reload, or inject) is made per page, from
  // the document itself, in `replayPrototypeInBrowser`.
  //
  // Per page rather than per window, which is what "a window showing it" means once
  // a window holds several pages (第十二轮): the page of the prototype is usually *behind* the
  // one the person is reading, so asking the window would answer about the wrong page — and
  // an auto-replay that reloads the person's page instead of the prototype's is worse than no
  // replay at all.
  server.handle(
    RPC_CHANNELS.prototypes.REPLAY,
    async (_ctx, workspaceId: string, slug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_REPLAY: Workspace not found: ${workspaceId}`)
      if (!deps.browserPaneManager) {
        throw new Error('PROTOTYPES_REPLAY: this host has no browser pane manager.')
      }

      // A window with no workspace recorded passes the filter, exactly as the
      // renderer's own tab strip does: a window we cannot place must not be
      // silently skipped. Which *tabs* of it show the prototype is asked per window, because
      // that is a tab-level fact: `prototypeSlug` on the window is the tab on screen's, and
      // with the agent working in the background that is not where the prototype is.
      const wanted = new Set([workspaceId, workspace.id])
      const instances = (await deps.browserPaneManager.listInstancesAsync()).filter(
        (instance) => !instance.workspaceId || wanted.has(instance.workspaceId),
      )

      const results = []
      for (const instance of instances) {
        let pages
        try {
          pages = (await deps.browserPaneManager.listTabsAsync(instance.id))
            .filter((tab) => tab.prototype?.slug === slug)
        } catch (error) {
          log.warn(`PROTOTYPES_REPLAY: could not list the pages of ${instance.id}: ${String(error)}`)
          continue
        }

        for (const page of pages) {
          try {
            results.push(
              await replayPrototypeInBrowser(
                deps.browserPaneManager,
                instance.id,
                workspace.rootPath,
                slug,
                page,
              ),
            )
          } catch (error) {
            // One page failing to reload must not stop the others: the remaining
            // pages are still showing a prototype whose files changed.
            log.warn(`PROTOTYPES_REPLAY: ${slug} failed in ${instance.id}/${page.id}: ${String(error)}`)
          }
        }
      }

      log.info(`PROTOTYPES_REPLAY: ${slug} → ${results.length} page(s)`)
      return { slug, pages: results.length, results }
    },
  )

  // Copy a prototype into a new one — the panel's "Duplicate". Two prototypes
  // stop sharing anything the moment the copy exists; the caller is told the new
  // slug so it can open it. `fold` collapses the copy's change layer on the way out
  // (plan §21.3), which is the only place a fold is reachable from.
  server.handle(
    RPC_CHANNELS.prototypes.DUPLICATE,
    async (_ctx, workspaceId: string, slug: string, options?: { name?: string; fold?: boolean }) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_DUPLICATE: Workspace not found: ${workspaceId}`)
      const copied = duplicatePrototype(workspace.rootPath, slug, options)
      log.info(
        `PROTOTYPES_DUPLICATE: ${slug} → ${copied.slug} (${copied.copiedPatches.length} patches` +
          `${copied.folded && !copied.folded.nothingToFold ? ', folded' : ''})`,
      )
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

  // Change one prototype's page table: add a page, remove one, rename one, or mark
  // which page the address root opens (plan §19). File work only, and one operation
  // at a time so the caller can say what it meant — and so the answer can name it
  // back without guessing from a diff.
  server.handle(
    RPC_CHANNELS.prototypes.SET_PAGES,
    async (_ctx, workspaceId: string, slug: string, change: PrototypePagesChange) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_SET_PAGES: Workspace not found: ${workspaceId}`)
      const result = updatePrototypePages(workspace.rootPath, slug, change)
      log.info(`PROTOTYPES_SET_PAGES: ${slug} — ${result.note}`)
      return result
    },
  )

  // Repoint one live page at the same page in another environment. File work only,
  // and no confirmation step: the address is a fact about where the page is, not a
  // rule of its kind. The two things that go stale silently (windows open on the
  // old page, selectors written against the old DOM) are said by whoever asks —
  // the command says them, and the panel puts them next to the field.
  server.handle(
    RPC_CHANNELS.prototypes.SET_TARGET,
    async (_ctx, workspaceId: string, slug: string, targetUrl: string, page?: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`PROTOTYPES_SET_TARGET: Workspace not found: ${workspaceId}`)
      const config = setPrototypePageUrl(workspace.rootPath, slug, targetUrl, page)
      log.info(`PROTOTYPES_SET_TARGET: ${slug}${page ? ` page "${page}"` : ''} → ${targetUrl}`)
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
