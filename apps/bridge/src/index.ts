#!/usr/bin/env bun
/**
 * Craft Agent device bridge.
 *
 *   craft-bridge run      --config ~/.craft-agent/bridge.json      # foreground (systemd ExecStart)
 *   craft-bridge install  --hub wss://... --token ... --allow ~/work [--user]
 *   craft-bridge start | stop | restart | status | logs [-f]
 *   craft-bridge token set <token>
 *   craft-bridge doctor
 *   craft-bridge uninstall [--purge-config]
 *
 * A hub already knows how to drive a device (`device_tool`, device slots, capability dispatch).
 * This process is the other half: it connects out to the hub as a device, answers
 * `client:device:exec` / `client:device:fs`, and reconnects on its own. It opens no listening
 * socket, so no port has to be allowed on this machine.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { currentUser, enableLinger, homeForUser, isRoot, journalctl, readUnitConfigPath, removeUnit, systemctl, UNIT_NAME, writeUnit, type ServiceMode } from './systemd'
import { DEFAULT_CONFIG_PATH, loadConfigFile, resolveConfig, saveConfig, type BridgeConfig } from './config'
import { startBridge, log, probeHub } from './daemon'

const CONFIG_DIR_NAME = '.craft-agent'

const COMMON_OPTIONS = {
  config: { type: 'string', short: 'c' },
  hub: { type: 'string' },
  token: { type: 'string' },
  name: { type: 'string' },
  allow: { type: 'string', multiple: true },
  'no-shell': { type: 'boolean' },
  'no-files': { type: 'boolean' },
  insecure: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function printHelp(): void {
  console.log(`Craft Agent device bridge

Usage:
  craft-bridge run [options]                 Foreground process (systemd runs this)
  craft-bridge install [options]             Write the config and a systemd unit
  craft-bridge start | stop | restart        Control the installed service
  craft-bridge status                        Service state and config summary
  craft-bridge logs [-f] [--lines N]         journalctl for the service
  craft-bridge token set <token>             Replace the device token (restarts if running)
  craft-bridge doctor                        Validate config and probe the hub
  craft-bridge uninstall [--purge-config]    Disable and remove the service

Options (run / install / doctor):
  --config, -c <path>   Config file (default: ~/.craft-agent/bridge.json)
  --hub <url>           Hub WebSocket URL (ws://, wss://, http:// or https://)
  --token <token>       Device slot token from the hub's Settings → Server → Add device
  --name <name>         Device name on the hub (default: hostname)
  --allow <dir>         Folder the hub may use; repeat for several folders
  --no-shell            Refuse client:device:exec
  --no-files            Refuse client:device:fs
  --insecure            Accept a self-signed hub certificate

Install options:
  --user                Install as a user service instead of /etc/systemd/system
  --service-user <u>    Account that runs the service (default: \$SUDO_USER or current user)
  --binary <path>       Compiled binary to install (default: this executable)
  --start               Start the service after enabling it

Service options:
  --user                Operate the user service instead of the system one

Configuration
  1. In the hub, open Settings → Server → Add device and copy the token.
  2. Install the bridge on this machine (install writes the config for you):

       sudo craft-bridge install --hub wss://hub.example.com:9100 \\
         --token <token> --allow /home/me/work --start

     Or run it in the foreground with the same flags:

       craft-bridge run --hub ws://192.168.1.20:9100 --token <token> --allow /home/me/work

  3. Or edit the JSON by hand (default ~/.craft-agent/bridge.json, mode 0600):

       {
         "hub": "ws://192.168.1.20:9100",
         "token": "<device slot token>",
         "name": "build-box",
         "deviceId": "<generated on first run — do not copy between machines>",
         "allowedRoots": ["/home/me/work"],
         "grants": { "shell": true, "files": true },
         "tlsRejectUnauthorized": true
       }

     hub                    Hub address; http(s):// is converted to ws(s)://.
     token                  Device slot token. Binds to "deviceId" on first connect.
     deviceId               Generated on first run. Regenerating it makes the token
                            reject this machine, so leave it alone.
     name                   Name shown in the hub's device list (default: hostname).
     allowedRoots           Absolute folders the hub may use. Empty = only the
                            bridge's own scratch directory in the workspace.
     grants.shell           false = refuse client:device:exec.
     grants.files           false = refuse client:device:fs.
     tlsRejectUnauthorized  false = accept a self-signed hub certificate.
                            Prefer the --insecure flag on run/install.

  Check the setup:      craft-bridge doctor
  Change the token:     craft-bridge token set <token>

Notes:
  The bridge opens no port: it connects out to the hub and reconnects with exponential backoff
  (1s, 2s, 4s … capped at 30s), including across hub restarts. A rejected token stops it until
  the token is replaced.`);
}

function die(message: string): never {
  console.error(`craft-bridge: ${message}`)
  process.exit(1)
}

/** Path used by `run` / `doctor`: explicit flag, or the current user's default. */
function currentConfigPath(values: { config?: string }): string {
  return values.config ? resolve(values.config) : DEFAULT_CONFIG_PATH
}

function buildFromFile(configPath: string, values: {
  hub?: string
  token?: string
  name?: string
  allow?: string[]
  'no-shell'?: boolean
  'no-files'?: boolean
  insecure?: boolean
}): { config: BridgeConfig; changed: boolean } {
  const file = loadConfigFile(configPath)
  const config = resolveConfig(file, {
    hub: values.hub,
    token: values.token,
    name: values.name,
    allow: values.allow,
    noShell: values['no-shell'],
    noFiles: values['no-files'],
    insecure: values.insecure,
  })
  const changed = file.deviceId !== config.deviceId || !existsSync(configPath)
  return { config, changed }
}

async function commandRun(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: COMMON_OPTIONS, allowPositionals: false })
  if (values.help) { printHelp(); return }
  const configPath = currentConfigPath(values)
  const { config, changed } = buildFromFile(configPath, values)
  if (changed) {
    saveConfig(configPath, config)
    log(`Saved device identity to ${configPath}`)
  }
  await startBridge(config)
}

function commandInstall(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      ...COMMON_OPTIONS,
      'service-user': { type: 'string' },
      binary: { type: 'string' },
      user: { type: 'boolean' },
      start: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values.help) { printHelp(); return }
  const mode: ServiceMode = values.user ? 'user' : 'system'
  if (mode === 'system' && !isRoot()) {
    die('install without --user needs root (sudo). Use --user for a user service.')
  }

  const serviceUser = mode === 'user'
    ? currentUser()
    : String(values['service-user'] ?? process.env.SUDO_USER ?? currentUser())
  const home = homeForUser(serviceUser)
  const configPath = values.config
    ? resolve(String(values.config))
    : join(home, CONFIG_DIR_NAME, 'bridge.json')

  const { config, changed } = buildFromFile(configPath, values)
  if (changed) saveConfig(configPath, config)

  const binary = String(values.binary ?? process.execPath)
  if (!existsSync(binary)) die(`binary not found: ${binary}`)
  if (['bun', 'bun.exe', 'node', 'node.exe'].includes(basename(binary))) {
    die('install needs the compiled bridge binary. Build it with `bun run bridge:dist:linux`, or pass --binary <path>.')
  }

  const unitFile = writeUnit({
    mode,
    binary,
    configPath,
    user: mode === 'system' ? serviceUser : undefined,
    home,
  })

  if (mode === 'system') {
    const uid = spawnSync('id', ['-u', serviceUser], { encoding: 'utf8' }).stdout.trim()
    const gid = spawnSync('id', ['-g', serviceUser], { encoding: 'utf8' }).stdout.trim()
    const chown = spawnSync('chown', ['-R', `${uid}:${gid}`, join(home, CONFIG_DIR_NAME)], { stdio: 'inherit' })
    if (chown.status !== 0) log(`warning: could not chown ${join(home, CONFIG_DIR_NAME)} to ${serviceUser}`)
  }

  systemctl(mode, ['daemon-reload'])
  systemctl(mode, ['enable', UNIT_NAME])
  if (mode === 'user') {
    if (!enableLinger(serviceUser)) {
      log(`warning: loginctl enable-linger ${serviceUser} failed — the service stops at logout`)
    }
  }

  log(`unit written: ${unitFile}`)
  log(`config: ${configPath}`)
  if (values.start) {
    systemctl(mode, ['restart', UNIT_NAME])
    log('service started')
  } else {
    log(`start it with: craft-bridge start${mode === 'user' ? ' --user' : ''}`)
  }
}

function commandService(action: 'start' | 'stop' | 'restart' | 'status' | 'logs', args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      user: { type: 'boolean' },
      lines: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) { printHelp(); return }
  const mode: ServiceMode = values.user ? 'user' : 'system'

  if (action === 'logs') {
    const journalArgs = ['-u', UNIT_NAME, '-n', String(values.lines ?? '100'), '--no-pager']
    if (values.follow) journalArgs.push('-f')
    process.exit(journalctl(mode, journalArgs))
  }
  if (action === 'status') {
    const code = systemctl(mode, ['status', UNIT_NAME, '--no-pager'])
    const home = homeForUser(currentUser())
    const configPath = readUnitConfigPath(mode, home)
      ?? (mode === 'user' ? join(home, CONFIG_DIR_NAME, 'bridge.json') : DEFAULT_CONFIG_PATH)
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as BridgeConfig
        log(`config: ${configPath}`)
        log(`hub: ${config.hub}  device: ${config.name ?? '(hostname)'}  id: ${config.deviceId ?? '(none)'}`)
      } catch { /* status is still useful without the summary */ }
    }
    process.exit(code)
  }
  process.exit(systemctl(mode, [action, UNIT_NAME]))
}

function commandToken(args: string[]): void {
  const [sub, token, ...rest] = args
  if (sub !== 'set') die('usage: craft-bridge token set <token>')
  if (!token) die('usage: craft-bridge token set <token>')
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string', short: 'c' },
      user: { type: 'boolean' },
      'service-user': { type: 'string' },
      'no-restart': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) { printHelp(); return }

  const mode: ServiceMode = values.user ? 'user' : 'system'
  const targetUser = mode === 'user' ? currentUser() : String(values['service-user'] ?? process.env.SUDO_USER ?? currentUser())
  const configPath = values.config
    ? resolve(String(values.config))
    : join(homeForUser(targetUser), CONFIG_DIR_NAME, 'bridge.json')
  if (!existsSync(configPath)) die(`config not found: ${configPath}`)

  const file = loadConfigFile(configPath)
  file.token = token
  saveConfig(configPath, file as BridgeConfig)
  log(`token updated in ${configPath}`)

  if (!values['no-restart']) {
    systemctl(mode, ['restart', UNIT_NAME])
  }
}

async function commandDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: COMMON_OPTIONS, allowPositionals: false })
  if (values.help) { printHelp(); return }
  const configPath = currentConfigPath(values)
  let config: BridgeConfig
  try {
    config = buildFromFile(configPath, values).config
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }

  log(`config: ${configPath} ${existsSync(configPath) ? '' : '(not written yet)'}`)
  log(`hub: ${config.hub}`)
  log(`device: ${config.name ?? '(hostname)'}  id: ${config.deviceId}`)
  log(`roots: ${(config.allowedRoots ?? []).join(', ') || '(scratch directory only)'}`)

  let failures = 0
  for (const root of config.allowedRoots ?? []) {
    if (!existsSync(root)) {
      log(`✗ root does not exist: ${root}`)
      failures++
    }
  }

  const probe = await probeHub(config)
  if (probe.ok) {
    log(`✓ hub reachable, token scope: ${probe.scope ?? 'unknown'}`)
  } else {
    log(`✗ hub probe failed: ${probe.error}`)
    failures++
  }
  process.exit(failures === 0 ? 0 : 1)
}

function commandUninstall(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      user: { type: 'boolean' },
      'service-user': { type: 'string' },
      config: { type: 'string', short: 'c' },
      'purge-config': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) { printHelp(); return }
  const mode: ServiceMode = values.user ? 'user' : 'system'
  if (mode === 'system' && !isRoot()) die('uninstall without --user needs root (sudo).')

  systemctl(mode, ['stop', UNIT_NAME])
  systemctl(mode, ['disable', UNIT_NAME])
  const targetUser = mode === 'user' ? currentUser() : String(values['service-user'] ?? process.env.SUDO_USER ?? currentUser())
  const home = homeForUser(targetUser)
  const unitConfig = readUnitConfigPath(mode, home)
  if (removeUnit(mode, home)) log('unit removed')
  systemctl(mode, ['daemon-reload'])

  if (values['purge-config']) {
    const configPath = values.config
      ? resolve(String(values.config))
      : (unitConfig ?? join(home, CONFIG_DIR_NAME, 'bridge.json'))
    if (existsSync(configPath)) {
      unlinkSync(configPath)
      log(`config removed: ${configPath}`)
    } else {
      log(`no config to remove: ${configPath}`)
    }
  } else {
    log('config kept (use --purge-config to delete it)')
  }
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2)
  if (!first || first === '--help' || first === '-h' || first === 'help') { printHelp(); return }
  // Backward compatible: `craft-bridge --hub ...` means `run --hub ...`.
  if (first.startsWith('-')) { await commandRun([first, ...rest]); return }

  switch (first) {
    case 'run': await commandRun(rest); return
    case 'install': commandInstall(rest); return
    case 'start':
    case 'stop':
    case 'restart':
    case 'status':
    case 'logs': commandService(first, rest); return
    case 'token': commandToken(rest); return
    case 'doctor': await commandDoctor(rest); return
    case 'uninstall': commandUninstall(rest); return
    default: die(`unknown command "${first}" (try --help)`)
  }
}

main().catch((error) => {
  console.error(`craft-bridge: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
