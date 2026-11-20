/**
 * One bridge per config file.
 *
 * systemd already keeps a single unit running, but nothing stops a second process: a forgotten
 * foreground `run`, or a system service and a user service on the same machine. Each of them
 * would connect with the same device identity, so the hub would see one device with two
 * connections and commands would race.
 *
 * The lock is a pid file created with `O_EXCL` next to the config (`bridge.json.lock`), so two
 * different configs — two device identities — still run side by side. A pid that is no longer
 * alive is treated as stale and replaced; nothing else needs to clean up after a crash.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

/** Exit code for "another bridge owns this config"; the unit does not restart on it. */
export const ALREADY_RUNNING_EXIT = 78

interface LockRecord {
  pid: number
  startedAt: string
  config: string
}

export interface InstanceLock {
  path: string
  release: () => void
}

function readRecord(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof (parsed as LockRecord).pid === 'number') {
      return parsed as LockRecord
    }
  } catch {
    // Missing, half-written, or not ours — handled as stale.
  }
  return null
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another account.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function create(path: string, record: LockRecord): boolean {
  try {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** Take the lock or fail with an `exitCode` the CLI can hand back. */
export function acquireInstanceLock(configPath: string): InstanceLock {
  const path = `${configPath}.lock`
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), config: configPath }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (create(path, record)) return lockFor(path)

    const holder = readRecord(path)
    if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
      const error = new Error(
        `Another craft-bridge is already running for ${configPath} ` +
          `(pid ${holder.pid}, started ${holder.startedAt}). Stop it first, or use a different --config.`,
      ) as Error & { exitCode: number }
      error.exitCode = ALREADY_RUNNING_EXIT
      throw error
    }

    // Stale (dead pid) or unreadable: drop it and try once more.
    try {
      unlinkSync(path)
    } catch {
      // Another process may have removed it; the retry settles the race.
    }
  }

  throw new Error(`Could not acquire ${path}: another process keeps recreating it`)
}

function lockFor(path: string): InstanceLock {
  let released = false
  return {
    path,
    release: () => {
      if (released) return
      released = true
      try {
        // Only remove a file that still names this process.
        if (readRecord(path)?.pid === process.pid) unlinkSync(path)
      } catch {
        // Best effort: a leftover file with a dead pid is replaced on next start.
      }
    },
  }
}
