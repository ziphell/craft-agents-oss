/**
 * The Web UI's credentials are its own: saved with the server config, minted on first enable,
 * and its signing key rotates with the password so a reset ends browser sessions.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-server-config-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }, null, 2),
    'utf-8',
  )
  return { configDir, configPath }
}

function runStorage(configDir: string, code: string) {
  const run = Bun.spawnSync([process.execPath, '--eval', code], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(
      `storage subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
    )
  }
}

function saveConfig(configDir: string, config: Record<string, unknown>) {
  runStorage(
    configDir,
    `import { setServerConfig } from '${STORAGE_MODULE_PATH}'; setServerConfig(${JSON.stringify(config)});`,
  )
}

function readServerConfig(configPath: string): any {
  return JSON.parse(readFileSync(configPath, 'utf-8')).serverConfig
}

describe('server config — Web UI password', () => {
  it('mints a password the first time Server Mode is enabled', () => {
    const { configDir, configPath } = setupConfigDir()

    saveConfig(configDir, { enabled: true, port: 9100, allowExternal: true, token: 'token-1' })

    const saved = readServerConfig(configPath)
    expect(typeof saved.webuiPassword).toBe('string')
    expect(saved.webuiPassword.length).toBeGreaterThan(0)
    expect(saved.webuiPassword).not.toBe('token-1')
  })

  it('keeps the stored password when an edit omits it', () => {
    const { configDir, configPath } = setupConfigDir()
    const base = { enabled: true, port: 9100, allowExternal: true, token: 'token-1' }

    saveConfig(configDir, base)
    const first = readServerConfig(configPath)
    saveConfig(configDir, { ...base, port: 9101 })
    const second = readServerConfig(configPath)

    expect(second.webuiPassword).toBe(first.webuiPassword)
  })

  it('takes a new password without touching the server token', () => {
    const { configDir, configPath } = setupConfigDir()
    const base = { enabled: true, port: 9100, allowExternal: true, token: 'token-1' }

    saveConfig(configDir, base)
    saveConfig(configDir, { ...base, webuiPassword: 'a-new-password' })
    const second = readServerConfig(configPath)

    expect(second.webuiPassword).toBe('a-new-password')
    // The token remote machines use is untouched by a Web UI password reset.
    expect(second.token).toBe('token-1')
  })

  it('leaves the Web UI password alone while Server Mode is off', () => {
    const { configDir, configPath } = setupConfigDir()

    saveConfig(configDir, { enabled: false, port: 9100, allowExternal: true })

    const saved = readServerConfig(configPath)
    expect(saved.webuiPassword).toBeUndefined()
  })
})

describe('server config — server token', () => {
  it('mints a token on the first enable when the form sends none', () => {
    const { configDir, configPath } = setupConfigDir()

    saveConfig(configDir, { enabled: true, port: 9100, allowExternal: true })

    expect(typeof readServerConfig(configPath).token).toBe('string')
  })

  it('keeps the stored token when an edit omits it', () => {
    const { configDir, configPath } = setupConfigDir()

    saveConfig(configDir, { enabled: true, port: 9100, allowExternal: true, token: 'token-1' })
    saveConfig(configDir, { enabled: true, port: 9101, allowExternal: true })

    expect(readServerConfig(configPath).token).toBe('token-1')
  })

  it('keeps the token when Server Mode is turned off', () => {
    const { configDir, configPath } = setupConfigDir()

    saveConfig(configDir, { enabled: true, port: 9100, allowExternal: true, token: 'token-1' })
    saveConfig(configDir, { enabled: false, port: 9100, allowExternal: true })

    expect(readServerConfig(configPath).token).toBe('token-1')
  })
})

