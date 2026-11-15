/**
 * The clock behind asynchronous generations.
 *
 * A task that is waiting for a provider has nobody in the request: the panel that started it closed
 * the call long ago, and the tool call that asked for it returned. So one loop, per process, asks
 * the due tasks how they are — and pushes what it learned to whoever is looking.
 *
 * Three decisions worth knowing:
 *
 * - **It reads the folders.** There is no table of running jobs; a task is a file beside the
 *   artifact it will become, and a project folder is the unit. Restarting the app loses nothing.
 * - **Only what is due.** A task carries `nextPollAt`, so a 30-second video is not asked about every
 *   three seconds. A task with no due time is either terminal or `submission_unknown` — the first is
 *   done, the second is waiting for a person, and neither is this loop's business.
 * - **One pass at a time.** A slow provider must not pile ticks on top of each other.
 */

import type { RpcServer } from '@craft-agent/server-core/transport'
import { pushTyped } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaces } from '@craft-agent/shared/config'
import { loadWorkspaceProjects } from '@craft-agent/shared/projects'
import {
  advanceMediaTask,
  listMediaTasks,
  readMediaChannels,
  withStoredKeys,
  type MediaChannel,
  type MediaTask,
} from '@craft-agent/shared/media'

/** Fast enough that a picture feels immediate, slow enough to leave the disk alone. */
const TICK_MS = 3000

export interface MediaTaskDriver {
  /** One pass. Exported so a test can drive it without a timer. */
  tick(): Promise<void>
  stop(): void
}

export function startMediaTaskDriver(
  server: RpcServer,
  log: { error: (...args: unknown[]) => void },
): MediaTaskDriver {
  let busy = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (busy || stopped) return
    busy = true
    try {
      const now = Date.now()
      // Reading the channels decrypts one key per account, so it happens only when a task is
      // actually due — most ticks have nothing to ask, and most machines have nothing running.
      let channels: MediaChannel[] | null = null
      for (const workspace of getWorkspaces()) {
        for (const project of loadWorkspaceProjects(workspace.rootPath)) {
          for (const task of dueTasks(project.folderPath, now)) {
            const active = (channels ??= await withStoredKeys(readMediaChannels().channels))
            const step = await advanceMediaTask(task, { channels: active })
            pushTyped(
              server,
              RPC_CHANNELS.media.TASK_CHANGED,
              { to: 'workspace', workspaceId: workspace.id },
              workspace.id,
              step,
            )
          }
        }
      }
    } catch (error) {
      log.error('media tasks: a pass failed:', error instanceof Error ? error.message : String(error))
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS)
  // A clock must not be the reason a process stays alive.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return {
    tick,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Tasks that are waiting for the provider and whose moment has come. */
function dueTasks(projectDir: string, now: number): MediaTask[] {
  return listMediaTasks(projectDir).filter(
    (task) =>
      (task.status === 'queued' || task.status === 'running') &&
      (task.nextPollAt === undefined || task.nextPollAt <= now),
  )
}
