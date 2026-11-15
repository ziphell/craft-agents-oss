import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * Create isolated config dir with a root config containing the given connections.
 * Returns paths needed by tests plus a runner to call updateLlmConnection in a subprocess.
 */
function setup(llmConnections: any[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      defaultLlmConnection: llmConnections[0]?.slug ?? null,
      llmConnections,
    }, null, 2),
    'utf-8',
  )

  function runUpdate(slug: string, updates: Record<string, unknown>): boolean {
    const updatesJson = JSON.stringify(updates)
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { updateLlmConnection } from '${STORAGE_MODULE_PATH}'; const ok = updateLlmConnection(${JSON.stringify(slug)}, ${updatesJson}); process.exit(ok ? 0 : 1);`,
    ], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0 && run.stderr.toString().trim()) {
      throw new Error(`update subprocess failed:\n${run.stderr.toString()}`)
    }
    return run.exitCode === 0
  }

  function readConnection(slug: string): any {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config.llmConnections.find((c: any) => c.slug === slug)
  }

  return { configDir, configPath, runUpdate, readConnection }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'custom-compat',
    name: 'My Custom Endpoint',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    createdAt: Date.now(),
    baseUrl: 'http://localhost:8085',
    piAuthProvider: 'anthropic',
    ...overrides,
  }
}

describe('updateLlmConnection – customEndpoint', () => {
  it('preserves customEndpoint when provided in updates', () => {
    const { runUpdate, readConnection } = setup([makeConnection()])
    const customEndpoint = { api: 'anthropic-messages' }

    const ok = runUpdate('custom-compat', { customEndpoint })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual(customEndpoint)
  })

  it('preserves existing customEndpoint when updates do not include it', () => {
    const customEndpoint = { api: 'openai-completions' }
    const { runUpdate, readConnection } = setup([makeConnection({ customEndpoint })])

    // Update an unrelated field
    const ok = runUpdate('custom-compat', { name: 'Renamed Endpoint' })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual(customEndpoint)
    expect(conn.name).toBe('Renamed Endpoint')
  })

  it('overwrites customEndpoint protocol when updated', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ customEndpoint: { api: 'openai-completions' } }),
    ])

    const ok = runUpdate('custom-compat', { customEndpoint: { api: 'anthropic-messages' } })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.customEndpoint).toEqual({ api: 'anthropic-messages' })
  })
})

describe('updateLlmConnection – merge semantics', () => {
  /**
   * The whole point of the merge contract: the UI is a view over the same file
   * a user can hand-edit, so a save must not destroy what the UI never saw.
   * See docs/custom-endpoint-plan.md §6 阶段 1.
   */
  it('keeps connection keys the code does not know about', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ headers: { 'X-Gateway-Token': 'abc' }, vendorOption: { nested: true } }),
    ])

    const ok = runUpdate('custom-compat', { name: 'Renamed Endpoint' })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.name).toBe('Renamed Endpoint')
    expect(conn.headers).toEqual({ 'X-Gateway-Token': 'abc' })
    expect(conn.vendorOption).toEqual({ nested: true })
  })

  it('keeps per-model params when the update only carries bare ids (the connection form path)', () => {
    const stored = { id: 'qwen3-coder', name: 'Qwen3 Coder', contextWindow: 262_144, maxTokens: 32_768 }
    const { runUpdate, readConnection } = setup([makeConnection({ models: [stored] })])

    const ok = runUpdate('custom-compat', { models: ['qwen3-coder', 'qwen3-coder-mini'] })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.models[0]).toEqual(stored)
    expect(conn.models[1]).toBe('qwen3-coder-mini')
  })

  it('lets an object entry replace the stored params for that id', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ models: [{ id: 'qwen3-coder', contextWindow: 262_144 }] }),
    ])

    const ok = runUpdate('custom-compat', { models: [{ id: 'qwen3-coder' }] })
    expect(ok).toBe(true)

    expect(readConnection('custom-compat').models).toEqual([{ id: 'qwen3-coder' }])
  })

  it('drops models that are no longer listed', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ models: ['keep-me', 'drop-me'] }),
    ])

    const ok = runUpdate('custom-compat', { models: ['keep-me'] })
    expect(ok).toBe(true)

    expect(readConnection('custom-compat').models).toEqual(['keep-me'])
  })

  it('shallow-merges customEndpoint so the other endpoint keys survive a protocol edit', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ customEndpoint: { api: 'openai-completions', headers: { 'X-Gateway-Token': 'abc' } } }),
    ])

    const ok = runUpdate('custom-compat', { customEndpoint: { api: 'anthropic-messages' } })
    expect(ok).toBe(true)

    expect(readConnection('custom-compat').customEndpoint).toEqual({
      api: 'anthropic-messages',
      headers: { 'X-Gateway-Token': 'abc' },
    })
  })

  it('deletes a key when the update passes null', () => {
    const { runUpdate, readConnection } = setup([makeConnection()])

    const ok = runUpdate('custom-compat', { baseUrl: null })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect('baseUrl' in conn).toBe(false)
  })
})

describe('updateLlmConnection – fastModel', () => {
  it('persists the picked small/fast model', () => {
    const { runUpdate, readConnection } = setup([makeConnection()])

    const ok = runUpdate('custom-compat', { fastModel: 'qwen-turbo' })
    expect(ok).toBe(true)

    expect(readConnection('custom-compat').fastModel).toBe('qwen-turbo')
  })

  it('preserves fastModel across an unrelated update', () => {
    const { runUpdate, readConnection } = setup([makeConnection({ fastModel: 'qwen-turbo' })])

    const ok = runUpdate('custom-compat', { name: 'Renamed Endpoint' })
    expect(ok).toBe(true)

    const conn = readConnection('custom-compat')
    expect(conn.name).toBe('Renamed Endpoint')
    expect(conn.fastModel).toBe('qwen-turbo')
  })

  it('deletes the key when the update passes null (back to not picked)', () => {
    const { runUpdate, readConnection } = setup([makeConnection({ fastModel: 'qwen-turbo' })])

    const ok = runUpdate('custom-compat', { fastModel: null })
    expect(ok).toBe(true)

    expect('fastModel' in readConnection('custom-compat')).toBe(false)
  })
})

describe('updateLlmConnection – Anthropic OAuth identity (issue #838)', () => {
  const identity = {
    oauthAccountUuid: 'acct-uuid-123',
    oauthAccountEmail: 'gyula@craft.do',
    oauthOrganizationUuid: 'org-uuid-456',
    oauthOrganizationName: 'Craft',
    oauthProfileVerifiedAt: 1_700_000_000_000,
  }

  it('persists identity fields when provided in updates', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ slug: 'claude-max', authType: 'oauth' }),
    ])

    const ok = runUpdate('claude-max', identity)
    expect(ok).toBe(true)

    const conn = readConnection('claude-max')
    expect(conn.oauthAccountUuid).toBe(identity.oauthAccountUuid)
    expect(conn.oauthAccountEmail).toBe(identity.oauthAccountEmail)
    expect(conn.oauthOrganizationUuid).toBe(identity.oauthOrganizationUuid)
    expect(conn.oauthOrganizationName).toBe(identity.oauthOrganizationName)
    expect(conn.oauthProfileVerifiedAt).toBe(identity.oauthProfileVerifiedAt)
  })

  it('preserves identity across an unrelated update (the allowlist-rebuild bug guard)', () => {
    const { runUpdate, readConnection } = setup([
      makeConnection({ slug: 'claude-max', authType: 'oauth', ...identity }),
    ])

    // An update that touches none of the identity fields must not drop them.
    const ok = runUpdate('claude-max', { name: 'Renamed Claude Max' })
    expect(ok).toBe(true)

    const conn = readConnection('claude-max')
    expect(conn.name).toBe('Renamed Claude Max')
    expect(conn.oauthAccountUuid).toBe(identity.oauthAccountUuid)
    expect(conn.oauthAccountEmail).toBe(identity.oauthAccountEmail)
    expect(conn.oauthOrganizationUuid).toBe(identity.oauthOrganizationUuid)
    expect(conn.oauthOrganizationName).toBe(identity.oauthOrganizationName)
    expect(conn.oauthProfileVerifiedAt).toBe(identity.oauthProfileVerifiedAt)
  })
})
