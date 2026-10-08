/**
 * Designs script action executor.
 *
 * Backs DesignActionBroker.executors.executeScript for script-kind grants: runs
 * the grant's pinned workspace-relative script through the SAME hardened runner
 * design refreshes use (executeScriptAction) — argv/no-shell, workspace-contained
 * (symlink-aware), CRAFT_*-only env, SIGTERM→SIGKILL timeout. The broker has
 * already validated the lease, nonce, replay cache, and grant before this runs,
 * and enforces the per-action timeout by aborting `signal`.
 *
 * Contract with the broker: resolve with the process outcome even on a non-zero
 * exit (the design still wants stdout/stderr); throw only when the script could
 * not run at all (path escape, missing runtime, spawn failure) — which the
 * broker turns into an `ok:false` action result.
 *
 * NOTE: this deliberately does NOT set `ScriptAction.design`. That field makes the
 * runner overwrite the design's scheduled-refresh completion marker
 * (recordDesignRefresh); an on-demand run a user clicks must not masquerade as a
 * refresh. CRAFT_DESIGN_* env is still injected via buildBaseScriptEnv so the
 * script can find its own data dir.
 */

import {
  executeScriptAction,
  buildBaseScriptEnv,
  type ScriptAction,
  type ScriptActionResult,
} from '@craft-agent/shared/automations'
import type { DesignScriptRuntime } from '@craft-agent/core'
import type { Logger } from '@craft-agent/server-core/runtime'

export interface DesignsScriptExecutorDeps {
  workspaceRootPath: string
  log: Logger
  /** Test seam — defaults to the real runner. */
  runScript?: (
    action: ScriptAction,
    ctx: { workspaceRootPath: string; env: Record<string, string>; signal?: AbortSignal },
  ) => Promise<ScriptActionResult>
}

export function createDesignsScriptExecutor(deps: DesignsScriptExecutorDeps) {
  const runScript = deps.runScript ?? executeScriptAction

  return async (
    invocation: { designSlug: string; script: string; runtime?: DesignScriptRuntime; args?: string[] },
    options: { signal: AbortSignal },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
    const action: ScriptAction = {
      type: 'script',
      script: invocation.script,
      ...(invocation.runtime ? { runtime: invocation.runtime } : {}),
      ...(invocation.args ? { args: invocation.args } : {}),
      // No `design` — see file header (must not clobber the refresh marker).
    }

    const env = buildBaseScriptEnv({
      workspaceRootPath: deps.workspaceRootPath,
      design: invocation.designSlug,
    })

    // Forward the broker's abort signal so its per-action deadline / cancel
    // actually kills the subprocess (the runner SIGTERMs then SIGKILLs).
    const result = await runScript(action, {
      workspaceRootPath: deps.workspaceRootPath,
      env,
      signal: options.signal,
    })

    if (result.blocked) {
      // Could not run at all (path escape / runtime missing) — surface as a
      // throw so the broker reports ok:false with this message.
      deps.log.warn(`[designs] script blocked for ${invocation.designSlug}: ${result.stderr}`)
      throw new Error(result.stderr || `Script could not run: ${invocation.script}`)
    }

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}
