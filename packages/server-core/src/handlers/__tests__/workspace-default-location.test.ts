import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
const HANDLERS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'rpc', 'workspace.ts')).href
const WORKSPACES_MODULE = pathToFileURL(join(repoRoot, 'packages', 'shared', 'src', 'workspaces', 'index.ts')).href
const PROTOCOL_MODULE = pathToFileURL(join(repoRoot, 'packages', 'shared', 'src', 'protocol', 'index.ts')).href

/**
 * Ask the real handler and the real path helper where a "default location" workspace would go.
 *
 * A subprocess, because the config directory is resolved once at import time (`config/paths.ts`) —
 * the same isolation the neighbouring handler tests use for the same reason. Nothing is mocked.
 */
function askWhereWorkspacesGo(configDir: string, slug: string): { defaultDir: string; checkSlugPath: string } {
  const source = `
    import { registerWorkspaceCoreHandlers } from ${JSON.stringify(HANDLERS_MODULE)};
    import { getDefaultWorkspacesDir } from ${JSON.stringify(WORKSPACES_MODULE)};
    import { RPC_CHANNELS } from ${JSON.stringify(PROTOCOL_MODULE)};
    const handlers = new Map();
    registerWorkspaceCoreHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      platform: { logger: { info() {}, warn() {}, error() {} } },
    });
    const answer = await handlers.get(RPC_CHANNELS.workspaces.CHECK_SLUG)(null, ${JSON.stringify(slug)});
    console.log('ANSWER=' + JSON.stringify({ defaultDir: getDefaultWorkspacesDir(), checkSlugPath: answer.path }));
  `

  const run = Bun.spawnSync([process.execPath, '--eval', source], {
    cwd: repoRoot,
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const line = run.stdout
    .toString()
    .split('\n')
    .find((entry) => entry.startsWith('ANSWER='))
  if (!line) {
    throw new Error(`no answer from the slug handler (exit ${run.exitCode}): ${run.stderr.toString()}`)
  }
  return JSON.parse(line.slice('ANSWER='.length))
}

describe('the default workspace location', () => {
  /**
   * `CRAFT_CONFIG_DIR` exists so an instance can own its configuration. A workspace created at the
   * "default location" is data that instance owns too, and the client does not get to decide it:
   * the renderer used to build `${homeDir}/.craft-agent/workspaces` itself, which put a remote
   * server's workspaces in the operator's home directory — where the instance's own discovery
   * (`getDefaultWorkspacesDir`) would never look.
   */
  it('follows the instance config directory instead of the machine home directory', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'craft-workspace-location-'))
    try {
      const answer = askWhereWorkspacesGo(configDir, 'remote-check')

      expect(answer.defaultDir).toBe(join(configDir, 'workspaces'))
      // The path the slug check answers with is the one the UI creates at, so the two cannot disagree.
      expect(answer.checkSlugPath).toBe(join(configDir, 'workspaces', 'remote-check'))
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
