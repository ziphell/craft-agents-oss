/**
 * Creations RPC — a read, a poster, and a watch. There is still nothing to write.
 *
 * Three things a library needs and a document store gets for free:
 *
 * - **the list** — derived from session transcripts + the filesystem (`creations:list`);
 * - **a picture** — made on demand by the host's own renderer, one at a time, cached under the
 *   app's data folder (`creations:thumbnail`);
 * - **a signal** — a work appears when a turn writes a file, which is a change to a transcript, so
 *   the watcher below follows `<workspace>/sessions` and re-broadcasts the list
 *   (`creations:changed`).
 *
 * The watcher deliberately watches *transcripts*, not the documents: a session's log growing is the
 * one event that means "the agent produced something". A file edited by some other program is
 * picked up by the next scan (the renderer also re-asks while it is on screen), and a poster is
 * keyed by `(path, mtime, size)`, so an edit invalidates it without anyone having to notice.
 */

import { watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, requestClientSaveFileDialog, type RpcServer } from '@craft-agent/server-core/transport'
import {
  createCreationsCache,
  formatOfPath,
  knownCreationPaths,
  listVersions,
  loadCache,
  readVersion,
  recordIfChanged,
  refreshCreations,
  saveCache,
  suggestedVersionName,
  type CreationVersion,
  type CreationsCache,
} from '@craft-agent/shared/creations'
import type { CreationsQuery, CreationsSnapshot } from '@craft-agent/shared/creations/types'
import { statSync } from 'node:fs'
import { canExportTo, defaultExportName } from '@craft-agent/shared/office/creation-export'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.creations.LIST,
  RPC_CHANNELS.creations.THUMBNAIL,
  RPC_CHANNELS.creations.EXPORT,
  RPC_CHANNELS.creations.VERSIONS,
  RPC_CHANNELS.creations.SAVE_VERSION,
] as const

const EMPTY = (workspaceRootPath: string): CreationsSnapshot => ({
  generatedAt: Date.now(),
  workspaceRootPath,
  stats: { sessions: 0, parsed: 0, toolRecords: 0, hits: 0, shown: 0, hidden: 0, discovered: 0 },
  creations: [],
})

/** How long to wait after a transcript write before re-reading: a turn writes many lines. */
const WATCH_DEBOUNCE_MS = 1200

/** How often posters may be collected. A readdir per refresh would be work for its own sake. */
const PRUNE_INTERVAL_MS = 60_000

/**
 * How long a parse waits before its index is written down.
 *
 * A turn appends to a transcript every second or two, and each of those is a refresh that parses one
 * session — writing 100 KB of index at that rate would be a file written twenty times a minute for a
 * state the next refresh replaces. One trailing write says the same thing after the turn settles.
 */
const SAVE_DEBOUNCE_MS = 5_000

export function registerCreationsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const caches = new Map<string, CreationsCache>()
  /** Caches still being read from disk, so two callers at once do not both load one. */
  const loading = new Map<string, Promise<CreationsCache>>()
  const saveTimers = new Map<string, NodeJS.Timeout>()
  const watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>()
  const lastPrune = new Map<string, number>()

  /**
   * The workspace's index: in memory, or read from the folder the host keeps for it.
   *
   * Read once per process per workspace. What comes back is **keyed by `(size, mtimeMs)` of every
   * transcript**, and the refresh below stats all of them anyway, so a remembered entry that no
   * longer matches is re-parsed rather than trusted — which is the whole reason this is safe to keep
   * on disk (see `cache-file.ts`).
   */
  const cacheFor = async (workspaceRootPath: string): Promise<CreationsCache> => {
    const ready = caches.get(workspaceRootPath)
    if (ready) return ready
    const inFlight = loading.get(workspaceRootPath)
    if (inFlight) return inFlight

    const load = (async () => {
      const dir = deps.creationsIndex?.dir(workspaceRootPath)
      let cache: CreationsCache | null = null
      if (dir) {
        try {
          cache = await loadCache(dir)
        } catch (error) {
          // A cache that cannot be read is a cold scan, and a cold scan is the old behaviour.
          log.error(`CREATIONS_INDEX_LOAD: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const settled = cache ?? createCreationsCache()
      caches.set(workspaceRootPath, settled)
      loading.delete(workspaceRootPath)
      return settled
    })()
    loading.set(workspaceRootPath, load)
    return load
  }

  /**
   * Write the index down once the transcript has stopped growing.
   *
   * Only when a session was actually parsed: a refresh that re-used every entry has nothing new to
   * remember, and a library that is only being polled should not touch the disk at all.
   */
  function scheduleSave(workspaceRootPath: string, parsed: number): void {
    const dir = deps.creationsIndex?.dir(workspaceRootPath)
    if (!dir || parsed === 0) return
    if (saveTimers.has(workspaceRootPath)) return
    const timer = setTimeout(() => {
      saveTimers.delete(workspaceRootPath)
      const cache = caches.get(workspaceRootPath)
      if (!cache) return
      void saveCache(dir, cache).catch((error: unknown) => {
        // A cache that cannot be written is a cold scan next launch, not a failure of this one.
        log.error(`CREATIONS_INDEX_SAVE: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, SAVE_DEBOUNCE_MS)
    // A pending write must not keep the process alive on its own.
    timer.unref?.()
    saveTimers.set(workspaceRootPath, timer)
  }

  /**
   * Follow a workspace's session logs.
   *
   * `recursive` is what makes one watcher enough: sessions are `<sessions>/<id>/session.jsonl`, and
   * Node supports recursive watching on the platforms this app ships on (Windows and macOS); Linux
   * gets no recursion, but it also gets no failed call — the watch is simply shallower, and the
   * renderer's own polling covers it.
   */
  function watchWorkspace(workspaceId: string, workspaceRootPath: string): void {
    if (watchers.has(workspaceRootPath)) return
    const sessionsRoot = join(workspaceRootPath, 'sessions')
    let watcher: FSWatcher
    try {
      watcher = watch(sessionsRoot, { recursive: true, persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        // The path is relative to `sessions/`, so the log of any session ends with this.
        if (!name.endsWith('session.jsonl')) return
        const entry = watchers.get(workspaceRootPath)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = null
          void broadcast(workspaceId, workspaceRootPath)
        }, WATCH_DEBOUNCE_MS)
      })
      watcher.on('error', () => {
        // A watch that dies must not take the library with it: the list still answers on demand.
        watchers.delete(workspaceRootPath)
      })
    } catch {
      return
    }
    watchers.set(workspaceRootPath, { watcher, timer: null })
  }

  /**
   * Collect posters whose document the index no longer has.
   *
   * A rename, a delete or a move leaves a picture with nothing to show. The list is the only place
   * that knows the difference between "gone" and "filtered out", so the collection happens here —
   * against **every** path the index holds, not the visible ones.
   */
  function prunePosters(workspaceRootPath: string, cache: CreationsCache): void {
    if (!deps.creationThumbnail) return
    const last = lastPrune.get(workspaceRootPath) ?? 0
    if (Date.now() - last < PRUNE_INTERVAL_MS) return
    lastPrune.set(workspaceRootPath, Date.now())
    deps.creationThumbnail.prune(workspaceRootPath, knownCreationPaths(cache))
  }

  async function broadcast(workspaceId: string, workspaceRootPath: string): Promise<void> {
    try {
      const cache = await cacheFor(workspaceRootPath)
      const snapshot = await refreshCreations(workspaceRootPath, cache)
      scheduleSave(workspaceRootPath, snapshot.stats.parsed)
      prunePosters(workspaceRootPath, cache)
      void recordVersions(workspaceRootPath, snapshot)
      pushTyped(server, RPC_CHANNELS.creations.CHANGED, { to: 'workspace', workspaceId }, workspaceId, snapshot)
    } catch (error) {
      log.error(`CREATIONS_CHANGED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  server.handle(
    RPC_CHANNELS.creations.LIST,
    async (_ctx, workspaceId: string, query?: CreationsQuery): Promise<CreationsSnapshot> => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        log.error(`CREATIONS_LIST: Workspace not found: ${workspaceId}`)
        return EMPTY('')
      }
      watchWorkspace(workspaceId, workspace.rootPath)
      const cache = await cacheFor(workspace.rootPath)
      try {
        const snapshot = await refreshCreations(workspace.rootPath, cache, query ?? {})
        scheduleSave(workspace.rootPath, snapshot.stats.parsed)
        prunePosters(workspace.rootPath, cache)
        // The view is what the person is looking at; the unfiltered refresh in `broadcast` covers
        // works a filter hides, so recording here does not need a second scan.
        void recordVersions(workspace.rootPath, snapshot)
        return snapshot
      } catch (error) {
        // A library that cannot be derived must not take the window down with it.
        log.error(`CREATIONS_LIST: ${error instanceof Error ? error.message : String(error)}`)
        return EMPTY(workspace.rootPath)
      }
    },
  )

  /**
   * A poster for one file, as a data URL.
   *
   * The caller names only the path: the size, the modification time and the format are read here,
   * because they are the cache key and the client must not be able to make a stale one look fresh.
   */
  /**
   * Write a work out as another format, where the person says.
   *
   * The destination is theirs to choose — an export is a file they are about to hand on, not a
   * cache entry — so a dialog is asked first, and a cancelled one answers without writing anything.
   * Which pairs are possible comes from `exportTargetsFor`, the same table the menu reads.
   */
  server.handle(
    RPC_CHANNELS.creations.EXPORT,
    async (ctx, workspaceId: string, path: string, target: 'pdf' | 'docx' | 'md' | 'html') => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) return { canceled: false, error: `No such workspace: ${workspaceId}` }
      if (!deps.creationExport) return { canceled: false, error: 'This host cannot export a document.' }
      if (typeof path !== 'string' || !path || !canExportTo(path, target)) {
        return { canceled: false, error: `This file cannot be exported as ${target}.` }
      }

      const picked = await requestClientSaveFileDialog(server, ctx.clientId, {
        title: `Export as ${target.toUpperCase()}`,
        defaultPath: join(dirname(path), defaultExportName(path, target)),
        filters: [{ name: target.toUpperCase(), extensions: [target] }],
      })
      if (picked.canceled || !picked.filePath) return { canceled: true }

      try {
        const written = await deps.creationExport({
          workspaceRootPath: workspace.rootPath,
          path,
          target,
          outPath: picked.filePath,
        })
        return { canceled: false, path: written }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`CREATIONS_EXPORT: ${message}`)
        return { canceled: false, error: message }
      }
    },
  )

  /**
   * Keep a copy of every work that changed, so the library can answer "what did this say before".
   *
   * Called with each refresh: `recordIfChanged` compares `(mtime, size)` with what it last saw and
   * only reads a file that moved. The first refresh records a baseline, which is what makes the
   * *next* change comparable rather than the first.
   */
  async function recordVersions(workspaceRootPath: string, snapshot: CreationsSnapshot): Promise<void> {
    const dir = deps.creationVersions?.dir(workspaceRootPath)
    if (!dir) return
    for (const creation of snapshot.creations) {
      if (!creation.exists) continue
      try {
        await recordIfChanged(dir, creation.path, {
          mtimeMs: creation.mtimeMs,
          size: creation.bytes,
          read: async () => new Uint8Array(await readFile(creation.path)),
        })
      } catch (error) {
        // A version is a convenience; a file that cannot be read must not fail the list.
        log.error(`CREATIONS_VERSIONS: ${creation.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  server.handle(RPC_CHANNELS.creations.VERSIONS, async (_ctx, workspaceId: string, path: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    const dir = workspace ? deps.creationVersions?.dir(workspace.rootPath) : null
    if (!dir || typeof path !== 'string' || !path) return []
    return listVersions(dir, path)
  })

  /**
   * One version, written where the person says.
   *
   * **A copy, never an overwrite.** Restoring over the current file would write under an editor
   * that may have it open — the one thing this app refuses to do — so a version leaves the library
   * as a file of its own, named after the minute it was made.
   */
  server.handle(
    RPC_CHANNELS.creations.SAVE_VERSION,
    async (ctx, workspaceId: string, path: string, id: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      const dir = workspace ? deps.creationVersions?.dir(workspace.rootPath) : null
      if (!dir || typeof path !== 'string' || typeof id !== 'string') {
        return { canceled: false, error: 'No versions for this file.' }
      }
      const versions = await listVersions(dir, path)
      const version = versions.find((candidate) => candidate.id === id)
      if (!version) return { canceled: false, error: 'That version is gone.' }
      const picked = await requestClientSaveFileDialog(server, ctx.clientId, {
        title: 'Save this version',
        defaultPath: join(dirname(path), suggestedVersionName(path, version)),
      })
      if (picked.canceled || !picked.filePath) return { canceled: true }
      const bytes = await readVersion(dir, path, id)
      if (!bytes) return { canceled: false, error: 'That version could not be read.' }
      try {
        await writeFile(picked.filePath, bytes)
        return { canceled: false, path: picked.filePath }
      } catch (error) {
        return { canceled: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  server.handle(RPC_CHANNELS.creations.THUMBNAIL, async (_ctx, workspaceId: string, path: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace || !deps.creationThumbnail || typeof path !== 'string') return null
    const format = formatOfPath(path)
    if (!format) return null

    let stat
    try {
      stat = statSync(path)
      if (!stat.isFile()) return null
    } catch {
      return null
    }

    try {
      const file = await deps.creationThumbnail.ensure({
        workspaceRootPath: workspace.rootPath,
        path,
        format,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      })
      if (!file) return null
      const base64 = readFileSync(file).toString('base64')
      return { dataUrl: `data:image/jpeg;base64,${base64}` }
    } catch (error) {
      log.error(`CREATIONS_THUMBNAIL: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })
}
