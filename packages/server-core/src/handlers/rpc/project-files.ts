/**
 * Project file watch handlers.
 *
 * Watches the workspace's project tree so the app can react to a spec changing on disk —
 * whoever wrote it: the agent, the control plane, or an external editor. A spec is a file in
 * the project folder now, so the probe lives here: the editors that follow external edits
 * (`useFileWriter`, `MarkdownDrawioBlock`) depend on this signal, and watching anything but the
 * project's folder would make them silently stop following changes.
 *
 * Mirrors the session file watcher (see ./sessions.ts): per-client state,
 * recursive fs.watch, 100ms debounce, pushed as `projects:filesChanged`.
 */
import { watch } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { ensureProjectsDir, getWorkspaceProjectsPath } from '@craft-agent/shared/projects'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.WATCH_FILES,
  RPC_CHANNELS.projects.UNWATCH_FILES,
] as const

/** Batch rapid changes before notifying (matches the session file watcher). */
const WATCH_DEBOUNCE_MS = 100

interface ClientProjectFilesWatchState {
  watcher: import('fs').FSWatcher
  workspaceId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client watcher state (supports concurrent windows/clients safely)
const clientProjectFilesWatches = new Map<string, ClientProjectFilesWatchState>()

/** Ignore hidden files (.DS_Store, editor swap files, …) */
function isIgnoredFile(filename: string | null): boolean {
  if (!filename) return false
  return filename.startsWith('.') || filename.includes('/.') || filename.includes('\\.')
}

export function cleanupProjectFilesWatchForClient(clientId: string): void {
  const state = clientProjectFilesWatches.get(clientId)
  if (!state) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.watcher.close()
  clientProjectFilesWatches.delete(clientId)
}

export function registerProjectFilesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Start watching the workspace project tree for spec changes
  server.handle(RPC_CHANNELS.projects.WATCH_FILES, async (ctx) => {
    const clientId = ctx.clientId
    cleanupProjectFilesWatchForClient(clientId)

    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const workspace = getWorkspaceByNameOrId(workspaceId ?? '')
    if (!workspace) return

    try {
      // The projects folder is a system-created container; make sure it exists
      // before watching so the first watch call cannot fail with ENOENT.
      ensureProjectsDir(workspace.rootPath)
      const projectsPath = getWorkspaceProjectsPath(workspace.rootPath)

      const state: ClientProjectFilesWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        workspaceId: workspace.id,
        debounceTimer: null,
      }

      state.watcher = watch(projectsPath, { recursive: true }, (_eventType, filename) => {
        if (isIgnoredFile(filename)) return

        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }
        state.debounceTimer = setTimeout(() => {
          pushTyped(
            server,
            RPC_CHANNELS.projects.FILES_CHANGED,
            { to: 'client', clientId },
            state.workspaceId,
            filename ?? null,
          )
        }, WATCH_DEBOUNCE_MS)
      })

      clientProjectFilesWatches.set(clientId, state)
    } catch (error) {
      deps.platform.logger.error('Failed to start project files watcher:', error)
    }
  })

  // Stop watching project files for the calling client
  server.handle(RPC_CHANNELS.projects.UNWATCH_FILES, async (ctx) => {
    cleanupProjectFilesWatchForClient(ctx.clientId)
  })
}
