/**
 * Tweaks Tool Callbacks
 *
 * Backend implementation of the agent-facing tweak tools (list_tweaks, get_tweak,
 * create_tweak, update_tweak, delete_tweak). SessionManager wires one
 * instance per session, bound to the invoking session's workspace, into the
 * session-scoped tool callback registry.
 *
 * Everything is the same primitive the rest of the app uses
 * (`@craft-agent/shared/tweaks`): the tools write `tweak.css`/`tweak.js` and let
 * `createTweak` own the config, so a tweak made by the agent and one written by hand are
 * the same object. Every mutation calls `onTweaksMutated` so the host can poke the config
 * watcher — files are the truth here too, and an agent edit is an out-of-band edit as far
 * as the watcher is concerned.
 */

import { writeFileSync } from 'node:fs'
import type {
  TweakToolCallbacks,
  TweakToolSummary,
  TweakToolDetails,
  CreateTweakToolInput,
  UpdateTweakToolPatch,
  DeleteTweakToolResult,
} from '@craft-agent/session-tools-core'
import {
  createTweak,
  deleteTweak,
  getTweakCssPath,
  getTweakJsPath,
  loadTweak,
  loadWorkspaceTweaks,
  toTweakDetails,
  toTweakSummary,
  updateTweak,
  type LoadedTweak,
} from '@craft-agent/shared/tweaks'

export interface TweaksToolCallbacksDeps {
  workspaceRootPath: string
  log?: (message: string) => void
  /** Called after every successful mutation, so the host can tell the watcher. */
  onTweaksMutated?: (tweakSlug: string) => void | Promise<void>
}

function requireTweak(workspaceRootPath: string, slug: string): LoadedTweak {
  const tweak = loadTweak(workspaceRootPath, slug)
  if (!tweak) throw new Error(`Tweak not found: ${slug}`)
  return tweak
}

export function buildTweaksToolCallbacks(deps: TweaksToolCallbacksDeps): TweakToolCallbacks {
  const { workspaceRootPath } = deps

  const mutated = async (slug: string): Promise<void> => {
    await deps.onTweaksMutated?.(slug)
  }

  return {
    listTweaks(): TweakToolSummary[] {
      return loadWorkspaceTweaks(workspaceRootPath).map(toTweakSummary)
    },

    getTweak(slug: string): TweakToolDetails | null {
      const tweak = loadTweak(workspaceRootPath, slug)
      return tweak ? toTweakDetails(workspaceRootPath, tweak) : null
    },

    async createTweak(input: CreateTweakToolInput): Promise<TweakToolDetails> {
      const config = createTweak(workspaceRootPath, {
        name: input.name,
        description: input.description,
        matches: input.matches,
        enabled: input.enabled,
      })

      // The code is written here rather than handed to `createTweak`, because the
      // storage layer's job is the record and the files are the author's.
      if (input.css !== undefined) writeFileSync(getTweakCssPath(workspaceRootPath, config.slug), input.css, 'utf-8')
      if (input.js !== undefined) writeFileSync(getTweakJsPath(workspaceRootPath, config.slug), input.js, 'utf-8')

      await mutated(config.slug)
      return toTweakDetails(workspaceRootPath, requireTweak(workspaceRootPath, config.slug))
    },

    async updateTweak(slug: string, patch: UpdateTweakToolPatch): Promise<TweakToolDetails> {
      updateTweak(workspaceRootPath, slug, patch)
      await mutated(slug)
      return toTweakDetails(workspaceRootPath, requireTweak(workspaceRootPath, slug))
    },

    async deleteTweak(slug: string): Promise<DeleteTweakToolResult> {
      requireTweak(workspaceRootPath, slug)
      deleteTweak(workspaceRootPath, slug)
      await mutated(slug)
      return { deleted: true }
    },
  }
}
