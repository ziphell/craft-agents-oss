/**
 * Stable per-install device identity.
 *
 * A client's connection id changes on every reconnect, so it cannot be used to
 * say "run this conversation's browser on *that* machine". This id is written
 * once into the config directory and advertised on the WS handshake; session
 * settings can then keep pointing at a device across reconnects and restarts.
 *
 * Kept in its own small file rather than in `config.json`: the id is needed
 * before onboarding has created a config, and it must survive a config reset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { CONFIG_DIR } from './paths.ts'

const DEVICE_ID_FILE = join(CONFIG_DIR, 'device-id')

/**
 * Where this install keeps the working directory it gives each hub.
 *
 * `<hub root base>/<hub device id>/<workspace id>`: one directory per (hub, workspace), so two
 * hubs pointing at the same machine never share files, and a hub's workspace gets its own place
 * even when this machine has no local workspace for it.
 */
export const HUB_ROOT_BASE = join(CONFIG_DIR, '.hub')

/** An id used as a directory name, refusing anything that could leave the base. */
function safeSegment(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    throw new Error(`Invalid hub or workspace id: ${value}`)
  }
  return trimmed
}

/** The directory a hub's workspace works in on this machine (not created here). */
export function hubWorkspaceRoot(hubDeviceId: string, workspaceId: string): string {
  return join(HUB_ROOT_BASE, safeSegment(hubDeviceId), safeSegment(workspaceId))
}

let cached: string | null = null

/** The device id for this install, creating and persisting one on first use. */
export function getDeviceId(): string {
  if (cached) return cached
  try {
    if (existsSync(DEVICE_ID_FILE)) {
      const existing = readFileSync(DEVICE_ID_FILE, 'utf-8').trim()
      if (existing) {
        cached = existing
        return existing
      }
    }
  } catch {
    // Unreadable file — fall through and mint a fresh id.
  }

  const id = randomUUID()
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(DEVICE_ID_FILE, id, 'utf-8')
  } catch {
    // A read-only config dir costs stability across restarts, not this launch.
  }
  cached = id
  return id
}
