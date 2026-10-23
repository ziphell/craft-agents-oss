import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
const SERVER_HANDLERS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'rpc', 'server.ts')).href
const PROTOCOL_MODULE = pathToFileURL(join(repoRoot, 'packages', 'shared', 'src', 'protocol', 'index.ts')).href

/**
 * Run `server:removeWorkspace` against a temp config directory.
 *
 * A subprocess, because the config directory is resolved once at import time — the same isolation
 * the neighbouring handler tests use for the same reason.
 */
function removeWorkspace(configDir: string, workspaceId: string): { first: boolean; second: boolean } {
  const source = `
    import { registerServerHandlers } from ${JSON.stringify(SERVER_HANDLERS_MODULE)};
    import { RPC_CHANNELS } from ${JSON.stringify(PROTOCOL_MODULE)};
    const handlers = new Map();
    registerServerHandlers(
      { handle: (channel, fn) => handlers.set(channel, fn) },
      { platform: { logger: { info() {}, warn() {}, error() {} } }, sessionManager: {} },
      { serverId: 'test', startedAt: Date.now(), getConnectedClientCount: () => 0 },
    );
    const remove = handlers.get(RPC_CHANNELS.server.REMOVE_WORKSPACE);
    const first = await remove(null, ${JSON.stringify(workspaceId)});
    const second = await remove(null, ${JSON.stringify(workspaceId)});
    console.log('ANSWER=' + JSON.stringify({ first, second }));
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
    throw new Error(`no answer from the remove handler (exit ${run.exitCode}): ${run.stderr.toString()}`)
  }
  return JSON.parse(line.slice('ANSWER='.length))
}

function writeWorkspace(rootPath: string, id: string, name: string): void {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(
    join(rootPath, 'config.json'),
    JSON.stringify({ id: `cfg-${id}`, name, slug: id, createdAt: 1, updatedAt: 1 }, null, 2),
    'utf-8',
  )
}

describe('server:removeWorkspace', () => {
  it('removes the workspace from the server that owns it and reports a second try as a miss', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'craft-remove-workspace-'))
    const configPath = join(configDir, 'config.json')
    try {
      const roots = join(configDir, 'roots')
      writeWorkspace(join(roots, 'ws-a'), 'ws-a', 'Alpha')
      writeWorkspace(join(roots, 'ws-b'), 'ws-b', 'Beta')
      writeFileSync(
        configPath,
        JSON.stringify({
          workspaces: [
            { id: 'ws-a', name: 'Alpha', rootPath: join(roots, 'ws-a'), createdAt: 1 },
            { id: 'ws-b', name: 'Beta', rootPath: join(roots, 'ws-b'), createdAt: 1 },
          ],
          activeWorkspaceId: 'ws-a',
          activeSessionId: null,
        }, null, 2),
        'utf-8',
      )

      const answer = removeWorkspace(configDir, 'ws-a')

      expect(answer).toEqual({ first: true, second: false })
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.workspaces.map((workspace: any) => workspace.id)).toEqual(['ws-b'])
      // The removed workspace was the active one, so the server falls back to what is left.
      expect(config.activeWorkspaceId).toBe('ws-b')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
