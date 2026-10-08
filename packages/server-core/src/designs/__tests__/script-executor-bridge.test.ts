/**
 * Designs script executor: builds a ScriptAction from the grant invocation,
 * injects CRAFT_* env, never sets `design` (so it can't clobber the refresh
 * marker), returns process outcome on run, and throws on a blocked run.
 * The runner itself is injected — spawn behavior is covered by the automations
 * script-executor tests.
 */

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { createDesignsScriptExecutor } from '../script-executor-bridge'
import type { ScriptAction, ScriptActionResult } from '@craft-agent/shared/automations'
import type { Logger } from '@craft-agent/server-core/runtime'

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger
const signal = new AbortController().signal

function makeExecutor(result: Partial<ScriptActionResult>) {
  const seen: Array<{ action: ScriptAction; ctx: { workspaceRootPath: string; env: Record<string, string> } }> = []
  const executor = createDesignsScriptExecutor({
    workspaceRootPath: '/tmp/ws',
    log,
    runScript: async (action, ctx) => {
      seen.push({ action, ctx })
      return {
        type: 'script',
        script: action.script,
        success: (result.exitCode ?? 0) === 0,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        ...result,
      }
    },
  })
  return { executor, seen }
}

describe('createDesignsScriptExecutor', () => {
  test('runs the pinned script and returns exit/stdout/stderr', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0, stdout: 'done', stderr: '' })
    const out = await executor(
      { designSlug: 'dash', script: 'designs/dash/run.sh', runtime: 'bun', args: ['--once'] },
      { signal },
    )
    expect(out).toEqual({ exitCode: 0, stdout: 'done', stderr: '' })
    expect(seen[0].action).toEqual({ type: 'script', script: 'designs/dash/run.sh', runtime: 'bun', args: ['--once'] })
  })

  test('never sets ScriptAction.design (must not clobber the refresh marker)', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ designSlug: 'dash', script: 'designs/dash/run.sh' }, { signal })
    expect(seen[0].action.design).toBeUndefined()
  })

  test('injects CRAFT_ workspace + design env for the triggering design', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ designSlug: 'dash', script: 'designs/dash/run.sh' }, { signal })
    const env = seen[0].ctx.env
    expect(env.CRAFT_WORKSPACE_PATH).toBe('/tmp/ws')
    expect(env.CRAFT_DESIGN_SLUG).toBe('dash')
    // Platform-correct: the design dir is built with path.join, so it carries the
    // host separator (POSIX `/`, Windows `\`).
    expect(env.CRAFT_DESIGN_DIR).toBe(join('/tmp/ws', 'designs', 'dash'))
    expect(env.CRAFT_DESIGN_DATA_DIR).toBe(join('/tmp/ws', 'designs', 'dash', 'data'))
    // never leaks non-CRAFT secrets
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('omits runtime/args when not pinned', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ designSlug: 'dash', script: 'designs/dash/run.ts' }, { signal })
    expect(seen[0].action).toEqual({ type: 'script', script: 'designs/dash/run.ts' })
  })

  test('surfaces a non-zero exit as a resolved outcome (not a throw)', async () => {
    const { executor } = makeExecutor({ exitCode: 3, stdout: '', stderr: 'nope' })
    const out = await executor({ designSlug: 'dash', script: 'designs/dash/run.sh' }, { signal })
    expect(out).toEqual({ exitCode: 3, stdout: '', stderr: 'nope' })
  })

  test('throws when the run is blocked (path escape / missing runtime)', async () => {
    const { executor } = makeExecutor({ blocked: true, exitCode: null, stderr: 'Script path escapes the workspace' })
    await expect(
      executor({ designSlug: 'dash', script: '../evil.sh' }, { signal }),
    ).rejects.toThrow(/escapes the workspace/)
  })
})
