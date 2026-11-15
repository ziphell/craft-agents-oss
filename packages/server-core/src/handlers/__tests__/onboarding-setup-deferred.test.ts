import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
const HANDLER_MODULE = pathToFileURL(join(import.meta.dir, '..', 'rpc', 'onboarding.ts')).href
const PROTOCOL_MODULE = pathToFileURL(join(repoRoot, 'packages', 'shared', 'src', 'protocol', 'index.ts')).href

/**
 * Ask the real `onboarding:getAuthState` handler what it reports for one config dir.
 *
 * A subprocess, because the config dir is resolved once at import time (`paths.ts`) — the same
 * isolation `storage-update-llm-connection.test.ts` uses for the same reason. Nothing here is
 * mocked: the handler, the config reader and `getSetupNeeds` are the ones the server runs.
 */
function readSetupNeeds(setupDeferred: boolean): { isFullyConfigured: boolean } {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-deferred-'))
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ workspaces: [], llmConnections: [], ...(setupDeferred ? { setupDeferred: true } : {}) }),
    'utf-8',
  )

  const source = `
    import { registerOnboardingHandlers } from ${JSON.stringify(HANDLER_MODULE)};
    import { RPC_CHANNELS } from ${JSON.stringify(PROTOCOL_MODULE)};
    const handlers = new Map();
    registerOnboardingHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      platform: { logger: { info() {}, warn() {}, error() {} } },
    });
    const answer = await handlers.get(RPC_CHANNELS.onboarding.GET_AUTH_STATE)();
    console.log('SETUP_NEEDS=' + JSON.stringify(answer.setupNeeds));
  `

  try {
    const run = Bun.spawnSync([process.execPath, '--eval', source], {
      cwd: repoRoot,
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const line = run.stdout
      .toString()
      .split('\n')
      .find((entry) => entry.startsWith('SETUP_NEEDS='))
    if (!line) {
      throw new Error(`auth-state handler produced no answer (exit ${run.exitCode}): ${run.stderr.toString()}`)
    }
    return JSON.parse(line.slice('SETUP_NEEDS='.length))
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

describe('the server-side auth-state handler', () => {
  /**
   * The "Set up later" choice is written by `onboarding:deferSetup` and has to be read back here.
   * The Electron main-process copy of this handler passes the flag; this one is what answers a
   * remote client, so without it a server with no provider sends the user back through the wizard
   * on every page load — the flag would be persisted and read by nobody.
   */
  it('counts a deferred setup as configured, so a remote client is not sent back to the wizard', () => {
    expect(readSetupNeeds(false).isFullyConfigured).toBe(false)
    expect(readSetupNeeds(true).isFullyConfigured).toBe(true)
  })
})
