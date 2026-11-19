/**
 * Bridge configuration: one JSON file per device.
 *
 * `deviceId` is generated on first run and saved back — the hub binds the device slot to it on the
 * first handshake, so a regenerated id makes the same machine a stranger the token no longer
 * accepts.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, dirname, join, resolve } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'

export interface BridgeGrants {
  shell?: boolean
  files?: boolean
}

/** Proxy settings applied to the commands the hub runs on this device. */
export interface BridgeProxy {
  /** Exported as HTTP_PROXY/http_proxy. */
  http?: string
  /** Exported as HTTPS_PROXY/https_proxy. */
  https?: string
  /** Exported as NO_PROXY/no_proxy. */
  noProxy?: string
}

export interface BridgeConfig {
  hub: string
  token: string
  deviceId?: string
  name?: string
  /** Folders the hub may touch, in addition to the bridge's own scratch directory. */
  allowedRoots?: string[]
  grants?: BridgeGrants
  proxy?: BridgeProxy
  tlsRejectUnauthorized?: boolean
}

export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, 'bridge.json')

export function loadConfigFile(path: string): Partial<BridgeConfig> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as Partial<BridgeConfig>
}

/** Write the config atomically, keeping the token/deviceId readable only by its owner. */
export function saveConfig(path: string, config: BridgeConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort on filesystems without modes */ }
}

export function normalizeHubUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('The hub URL is required.')
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
  if (!/^wss?:\/\//i.test(trimmed)) {
    throw new Error(`The hub must be ws://, wss://, http:// or https:// — got ${raw}`)
  }
  return trimmed
}

export function normalizeRoots(roots: readonly string[]): string[] {
  const result: string[] = []
  for (const root of roots) {
    const value = root.trim()
    if (!value) continue
    if (!isAbsolute(value)) throw new Error(`--allow must be an absolute path: ${value}`)
    const absolute = resolve(value)
    if (!result.includes(absolute)) result.push(absolute)
  }
  return result
}

export interface ConfigOverrides {
  hub?: string
  token?: string
  name?: string
  allow?: string[]
  noShell?: boolean
  noFiles?: boolean
  insecure?: boolean
  /** One URL for both HTTP and HTTPS. */
  proxy?: string
  noProxy?: string
}

/**
 * The proxy block in effect.
 *
 * A flag replaces the fields it names (`--proxy` sets both HTTP and HTTPS); the file supplies
 * whatever the flags did not. Empty values are dropped so a cleared field stays cleared.
 */
function resolveProxy(file: BridgeProxy | undefined, overrides: ConfigOverrides): BridgeProxy | undefined {
  const http = overrides.proxy?.trim() || file?.http?.trim() || undefined
  const https = overrides.proxy?.trim() || file?.https?.trim() || undefined
  const noProxy = overrides.noProxy?.trim() || file?.noProxy?.trim() || undefined
  if (!http && !https && !noProxy) return undefined
  return {
    ...(http ? { http } : {}),
    ...(https ? { https } : {}),
    ...(noProxy ? { noProxy } : {}),
  }
}

/** Merge file + flags into the effective config, deriving the values the CLI did not supply. */
export function resolveConfig(file: Partial<BridgeConfig>, overrides: ConfigOverrides): BridgeConfig {
  const hubRaw = overrides.hub ?? file.hub
  const token = (overrides.token ?? file.token)?.trim()
  if (!hubRaw) throw new Error(`No hub configured. Pass --hub or add "hub" to the config file.`)
  if (!token) {
    throw new Error(
      'No device token configured. Create one in the hub\'s Settings → Server → Add device, ' +
        'then pass --token or add "token" to the config file.',
    )
  }

  const shell = overrides.noShell ? false : file.grants?.shell !== false
  const files = overrides.noFiles ? false : file.grants?.files !== false
  if (!shell && !files) throw new Error('Both grants are off — nothing to offer the hub.')

  return {
    hub: normalizeHubUrl(hubRaw),
    token,
    deviceId: file.deviceId ?? randomUUID(),
    name: (overrides.name ?? file.name)?.trim() || undefined,
    allowedRoots: normalizeRoots([...(file.allowedRoots ?? []), ...(overrides.allow ?? [])]),
    grants: { shell, files },
    proxy: resolveProxy(file.proxy, overrides),
    tlsRejectUnauthorized: overrides.insecure || file.tlsRejectUnauthorized === false ? false : undefined,
  }
}
