/**
 * The hub's own record of devices that have connected to it.
 *
 * A live connection is not a device record: it disappears when the transport drops and it cannot
 * carry a decision the person made about that machine. This registry is the durable side — one row
 * per `deviceId`, created the first time any client from that device connects, kept while it is
 * offline, and removed only when someone forgets it.
 *
 * `hubUses` is the hub-side half of the device relationship: "my agent may use this machine".
 * The device-side half (`deviceAccess`) lives in the client's saved-server config. Neither side can
 * grant the other's permission.
 *
 * The file is deliberately separate from `config.json`: a connection updates `lastSeenAt`, and
 * rewriting the main config on every connect would churn a file that everything else watches.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config'

export interface HubDeviceRecord {
  /** Stable client device id (`clientInfo.deviceId`). */
  deviceId: string
  name: string
  platform: string | null
  version: string | null
  firstSeenAt: number
  /** Last time a client from this device connected. While online this is refreshed lazily. */
  lastSeenAt: number
  /** Hub-side switch: this server's agent may use the device. Default false. */
  hubUses: boolean
}

export interface HubDeviceIdentity {
  deviceId: string
  name: string
  platform?: string | null
  version?: string | null
}

interface RegistryFile {
  version: 1
  devices: HubDeviceRecord[]
}

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

export class HubDeviceRegistry {
  private readonly records = new Map<string, HubDeviceRecord>()
  private loaded = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param filePath where the registry lives. `null` keeps it in memory — tests use that so they
   * never touch the person's real config directory.
   */
  constructor(private readonly filePath: string | null = join(CONFIG_DIR, 'devices.json')) {}

  /** All known devices, online or not. Callers decide how to display them. */
  list(): HubDeviceRecord[] {
    this.load()
    return [...this.records.values()]
  }

  get(deviceId: string): HubDeviceRecord | undefined {
    this.load()
    return this.records.get(deviceId)
  }

  /**
   * Create the record on first sight, refresh its metadata on every later connection, and keep
   * `hubUses` exactly as the person left it.
   */
  ensure(input: HubDeviceIdentity): HubDeviceRecord {
    this.load()
    const now = Date.now()
    const existing = this.records.get(input.deviceId)
    if (existing) {
      let changed = false
      const name = input.name.trim() || input.deviceId
      if (name !== existing.name) {
        existing.name = name
        changed = true
      }
      if ((input.platform ?? null) !== existing.platform) {
        existing.platform = input.platform ?? null
        changed = true
      }
      if ((input.version ?? null) !== existing.version) {
        existing.version = input.version ?? null
        changed = true
      }
      if (now - existing.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
        existing.lastSeenAt = now
        changed = true
      }
      if (changed) this.scheduleWrite()
      return existing
    }

    const record: HubDeviceRecord = {
      deviceId: input.deviceId,
      name: input.name.trim() || input.deviceId,
      platform: input.platform ?? null,
      version: input.version ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      hubUses: false,
    }
    this.records.set(record.deviceId, record)
    // First sight is the point of the record. Write it now rather than in a second, so a crash
    // right after a device connects does not lose the row the person will look for later.
    this.flush()
    return record
  }

  /** Set the hub-side switch. Returns null when the device is unknown. */
  setUse(deviceId: string, use: boolean): HubDeviceRecord | null {
    this.load()
    const record = this.records.get(deviceId)
    if (!record) return null
    if (record.hubUses !== use) {
      record.hubUses = use
      this.flush()
    }
    return record
  }

  /** Remove a device record. A currently connected device is added back on its next connection. */
  forget(deviceId: string): boolean {
    this.load()
    const removed = this.records.delete(deviceId)
    if (removed) this.flush()
    return removed
  }

  /** Write pending changes now — tests and shutdown paths. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeNow()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.filePath || !existsSync(this.filePath)) return

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
      const devices = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { devices?: unknown })?.devices)
          ? (raw as { devices: unknown[] }).devices
          : []
      for (const item of devices) {
        if (!item || typeof item !== 'object') continue
        const value = item as Partial<HubDeviceRecord>
        if (typeof value.deviceId !== 'string' || !value.deviceId) continue
        const firstSeenAt = typeof value.firstSeenAt === 'number' ? value.firstSeenAt : Date.now()
        const lastSeenAt = typeof value.lastSeenAt === 'number' ? value.lastSeenAt : firstSeenAt
        this.records.set(value.deviceId, {
          deviceId: value.deviceId,
          name: typeof value.name === 'string' && value.name.trim() ? value.name : value.deviceId,
          platform: typeof value.platform === 'string' ? value.platform : null,
          version: typeof value.version === 'string' ? value.version : null,
          firstSeenAt,
          lastSeenAt,
          hubUses: value.hubUses === true,
        })
      }
    } catch (error) {
      // A malformed registry must not stop the hub from starting. The next successful write
      // replaces it.
      console.warn('[hub-devices] could not read devices.json:', error)
    }
  }

  private scheduleWrite(delayMs = 1_000): void {
    if (!this.filePath || this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeNow()
    }, delayMs)
    this.writeTimer.unref?.()
  }

  private writeNow(): void {
    if (!this.filePath) return
    const payload: RegistryFile = { version: 1, devices: [...this.records.values()] }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (error) {
      console.warn('[hub-devices] could not write devices.json:', error)
    }
  }
}
