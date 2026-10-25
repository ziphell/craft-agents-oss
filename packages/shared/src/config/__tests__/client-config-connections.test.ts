import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

interface WorkspaceFixture {
  id: string
  name: string
  remoteServer?: { url: string; token?: string; remoteWorkspaceId?: string }
}

function setupConfigDir(workspaces: WorkspaceFixture[], activeWorkspaceId: string, clientConfig: unknown) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-connections-'))
  const configPath = join(configDir, 'config.json')

  const stored = workspaces.map((workspace) => {
    const rootPath = join(configDir, 'workspaces', workspace.id)
    mkdirSync(rootPath, { recursive: true })
    writeFileSync(
      join(rootPath, 'config.json'),
      JSON.stringify(
        {
          id: `cfg-${workspace.id}`,
          name: workspace.name,
          slug: workspace.id,
          createdAt: 1,
          updatedAt: 1,
        },
        null,
        2,
      ),
      'utf-8',
    )
    return {
      id: workspace.id,
      name: workspace.name,
      rootPath,
      createdAt: 1,
      ...(workspace.remoteServer ? { remoteServer: workspace.remoteServer } : {}),
    }
  })

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaces: stored,
        activeWorkspaceId,
        activeSessionId: null,
        clientConfig,
      },
      null,
      2,
    ),
    'utf-8',
  )

  return { configDir, configPath }
}

function runMigration(configDir: string) {
  runStorage(configDir, `import { migrateLegacyRemoteWorkspaces } from '${STORAGE_MODULE_PATH}'; migrateLegacyRemoteWorkspaces();`)
}

/** Run a snippet against one temp config dir — the storage module reads CRAFT_CONFIG_DIR. */
function runStorage(configDir: string, code: string) {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    code,
  ], {
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

function readConfig(configPath: string): any {
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

describe('remote connections (legacy shape)', () => {
  it('folds the old single-hub config and a matching remote workspace into one connection', () => {
    const { configDir, configPath } = setupConfigDir(
      [
        { id: 'ws-local', name: 'Local' },
        {
          id: 'ws-remote',
          name: 'Remote',
          remoteServer: { url: 'ws://hub.example:4321', token: 'workspace-token', remoteWorkspaceId: 'remote-ws-9' },
        },
      ],
      'ws-remote',
      { serverUrl: 'ws://hub.example:4321', enabled: true },
    )

    runMigration(configDir)

    const config = readConfig(configPath)
    expect(config.workspaces.map((workspace: any) => workspace.id)).toEqual(['ws-local'])
    expect(config.activeWorkspaceId).toBe('ws-local')

    // One server, not one per place that mentioned it — and its id is now a real one, not the
    // `legacy:` placeholder the reader derives from the URL.
    expect(config.clientConfig.connections).toHaveLength(1)
    const [connection] = config.clientConfig.connections
    expect(connection.url).toBe('ws://hub.example:4321')
    expect(connection.name).toBe('hub.example')
    expect(connection.token).toBe('workspace-token')
    expect(connection.lastWorkspaceId).toBe('remote-ws-9')
    expect(connection.id.startsWith('legacy:')).toBe(false)
    expect(config.migrationsApplied).toContain('workspace-level-remote-removed')
  })

  it('keeps a second server as its own connection', () => {
    const { configDir, configPath } = setupConfigDir(
      [
        { id: 'ws-local', name: 'Local' },
        {
          id: 'ws-remote',
          name: 'Remote',
          remoteServer: { url: 'wss://other.example:8443', token: 'other-token' },
        },
      ],
      'ws-local',
      { serverUrl: 'ws://hub.example:4321', token: 'hub-token', enabled: true },
    )

    runMigration(configDir)

    const config = readConfig(configPath)
    const connections = config.clientConfig.connections
    expect(connections.map((connection: any) => connection.url).sort()).toEqual([
      'ws://hub.example:4321',
      'wss://other.example:8443',
    ])
    expect(connections.find((connection: any) => connection.url === 'wss://other.example:8443').token)
      .toBe('other-token')
    expect(config.workspaces.map((workspace: any) => workspace.id)).toEqual(['ws-local'])
  })

  it('runs once: a second pass changes nothing', () => {
    const { configDir, configPath } = setupConfigDir(
      [
        { id: 'ws-local', name: 'Local' },
        {
          id: 'ws-remote',
          name: 'Remote',
          remoteServer: { url: 'ws://hub.example:4321', token: 'workspace-token' },
        },
      ],
      'ws-local',
      { serverUrl: 'ws://hub.example:4321', enabled: true },
    )

    runMigration(configDir)
    const first = readConfig(configPath)
    runMigration(configDir)
    const second = readConfig(configPath)

    expect(second.clientConfig).toEqual(first.clientConfig)
    expect(second.workspaces).toEqual(first.workspaces)
    expect(second.migrationsApplied.filter((marker: string) => marker === 'workspace-level-remote-removed'))
      .toHaveLength(1)
  })

  it('leaves a config without any remote entries alone', () => {
    const { configDir, configPath } = setupConfigDir([{ id: 'ws-local', name: 'Local' }], 'ws-local', undefined)

    runMigration(configDir)

    const config = readConfig(configPath)
    expect(config.workspaces.map((workspace: any) => workspace.id)).toEqual(['ws-local'])
    expect(config.activeWorkspaceId).toBe('ws-local')
    expect(config.clientConfig).toEqual({ connections: [] })
    expect(existsSync(configPath)).toBe(true)
  })
})

describe('adding a server', () => {
  it('refuses an address that already belongs to another saved server', () => {
    const { configDir, configPath } = setupConfigDir([{ id: 'ws-local', name: 'Local' }], 'ws-local', {
      connections: [
        { id: 'conn-1', name: 'Hub', url: 'ws://hub.example:4321', token: 'tok' },
      ],
    })

    // The Add form sends a fresh id; the address is what collides. Refusing keeps the existing
    // entry intact instead of quietly renaming it.
    runStorage(configDir, `
      import { saveRemoteConnection } from '${STORAGE_MODULE_PATH}';
      try {
        saveRemoteConnection({ id: 'conn-2', name: 'Hub again', url: 'ws://hub.example:4321', token: 'tok' });
        throw new Error('expected the save to be refused');
      } catch (err) {
        if (!/already saved/.test(String(err))) throw err;
      }
    `)

    const config = readConfig(configPath)
    expect(config.clientConfig.connections).toEqual([
      { id: 'conn-1', name: 'Hub', url: 'ws://hub.example:4321', token: 'tok' },
    ])
  })
})

describe('editing a saved server', () => {
  it('keeps its id and its last workspace', () => {
    const { configDir, configPath } = setupConfigDir([{ id: 'ws-local', name: 'Local' }], 'ws-local', {
      connections: [
        { id: 'conn-1', name: 'Hub', url: 'ws://hub.example:4321', token: 'old-token', lastWorkspaceId: 'ws-7', deviceAccess: true },
      ],
    })

    // What the Connect to Server… dialog sends when an existing server is edited: the same id,
    // a new address/name/token, and no lastWorkspaceId — the save path must keep the old one.
    runStorage(configDir, `import { saveRemoteConnection } from '${STORAGE_MODULE_PATH}';
      saveRemoteConnection({ id: 'conn-1', name: 'Hub renamed', url: 'wss://hub.example:4321', token: 'new-token' });`)

    const config = readConfig(configPath)
    expect(config.clientConfig.connections).toEqual([
      { id: 'conn-1', name: 'Hub renamed', url: 'wss://hub.example:4321', token: 'new-token', lastWorkspaceId: 'ws-7', deviceAccess: true },
    ])
  })
})
