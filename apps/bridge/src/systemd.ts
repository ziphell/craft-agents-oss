/**
 * systemd plumbing — the bridge has no daemon mode of its own.
 *
 * Installation writes a unit; start/stop/status/logs are thin wrappers around systemctl and
 * journalctl, so crash recovery, boot start and log rotation stay where the OS already does them.
 */

import { spawnSync } from 'node:child_process'
import { chownSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userInfo } from 'node:os'

export type ServiceMode = 'system' | 'user'

export const UNIT_NAME = 'craft-bridge.service'

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

export function currentUser(): string {
  return userInfo().username
}

/** Home directory for `user`; the package-free way, without pulling in /etc/passwd parsing. */
export function homeForUser(user: string): string {
  if (user === currentUser()) return userInfo().homedir
  const result = spawnSync('getent', ['passwd', user], { encoding: 'utf8' })
  const home = result.status === 0 ? result.stdout.trim().split(':')[5] : undefined
  if (!home) throw new Error(`Cannot resolve the home directory of user "${user}"`)
  return home
}

export function unitPath(mode: ServiceMode, home: string): string {
  return mode === 'system'
    ? `/etc/systemd/system/${UNIT_NAME}`
    : join(home, '.config', 'systemd', 'user', UNIT_NAME)
}

function quote(path: string): string {
  return /[\s"\\]/.test(path) ? `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : path
}

export interface UnitOptions {
  mode: ServiceMode
  binary: string
  configPath: string
  /** Only for system units. */
  user?: string
  home: string
}

export function renderUnit(options: UnitOptions): string {
  const header = [
    '[Unit]',
    'Description=Craft Agent device bridge',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ]
  if (options.mode === 'system' && options.user) header.push(`User=${options.user}`)
  header.push(
    `WorkingDirectory=${options.home}`,
    `ExecStart=${quote(options.binary)} run --config ${quote(options.configPath)}`,
    'Restart=always',
    'RestartSec=3',
    `Environment=HOME=${options.home}`,
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    `WantedBy=${options.mode === 'system' ? 'multi-user.target' : 'default.target'}`,
    '',
  )
  return header.join('\n')
}

export function writeUnit(options: UnitOptions): string {
  const path = unitPath(options.mode, options.home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderUnit(options), { encoding: 'utf8', mode: 0o644 })
  if (options.mode === 'system' && options.user) {
    try { chownSync(path, 0, 0) } catch { /* not fatal */ }
  }
  return path
}

/** The `--config` path from an installed unit, so `status` can summarise the config in use. */
export function readUnitConfigPath(mode: ServiceMode, home: string): string | null {
  const path = unitPath(mode, home)
  if (!existsSync(path)) return null
  const match = /--config\s+(?:"([^"]*)"|(\S+))/.exec(readFileSync(path, 'utf8'))
  return match ? (match[1] ?? match[2] ?? null) : null
}

export function removeUnit(mode: ServiceMode, home: string): boolean {
  const path = unitPath(mode, home)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export function systemctl(mode: ServiceMode, args: string[]): number {
  const full = mode === 'user' ? ['--user', ...args] : args
  const result = spawnSync('systemctl', full, { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function journalctl(mode: ServiceMode, args: string[]): number {
  const full = mode === 'user' ? ['--user', ...args] : args
  const result = spawnSync('journalctl', full, { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

/** User services stop at logout unless lingering is on. Best effort: polkit may refuse. */
export function enableLinger(user: string): boolean {
  const result = spawnSync('loginctl', ['enable-linger', user], { stdio: 'ignore' })
  return (result.status ?? 1) === 0
}
