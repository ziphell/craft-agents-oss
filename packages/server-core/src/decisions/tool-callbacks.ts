/**
 * Decision Tool Callbacks
 *
 * Backend implementation of the agent-facing `decide` session tool. One
 * instance per session, wired by SessionManager into the session-scoped tool
 * callback registry (next to `pages`). Every call:
 *
 *   1. resolves a client from settings + credentials (flag → enabled → feature
 *      toggle → key), failing closed with a message the agent can relay. The
 *      resolution is reused for a short window so a 200-item batch does not
 *      re-read config.json and the credential vault 200 times;
 *   2. runs the decision under the caller's deadline;
 *   3. writes a decision record (feature `decide_tool`) — digest only, never
 *      the state.
 *
 * Nothing here grants authority: the result is advice for the agent.
 */

import type { DecisionToolCallbacks, DecisionToolRequest, DecisionToolResult } from '@craft-agent/session-tools-core'
import {
  getDecisionRecorder,
  resolveDecisionClient,
  toDecisionFailure,
  type DecisionClientResolution,
  type DecisionRecorder,
  type DecisionRequest,
  type ResolveDecisionClientOptions,
} from '@craft-agent/shared/decisions'

export interface DecisionToolCallbacksDeps {
  sessionId: string
  log?: (message: string) => void
  /** Injectable for tests; defaults to the shared resolver. */
  resolveClient?: (options: ResolveDecisionClientOptions) => Promise<DecisionClientResolution>
  /** Injectable for tests; defaults to the process-wide recorder. */
  recorder?: DecisionRecorder
  /** How long one resolution (settings + key) is reused across calls. */
  resolutionTtlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/** Long enough to cover a batch, short enough that a Settings toggle applies within a second. */
export const DECISION_RESOLUTION_TTL_MS = 1_000

export function buildDecisionToolCallbacks(deps: DecisionToolCallbacksDeps): DecisionToolCallbacks {
  const resolveClient = deps.resolveClient ?? resolveDecisionClient
  const recorder = deps.recorder ?? getDecisionRecorder()
  const ttlMs = deps.resolutionTtlMs ?? DECISION_RESOLUTION_TTL_MS
  const now = deps.now ?? (() => Date.now())

  let cached: { at: number; promise: Promise<DecisionClientResolution> } | null = null
  const resolveCached = (): Promise<DecisionClientResolution> => {
    if (cached && now() - cached.at < ttlMs) return cached.promise
    const promise = resolveClient({ feature: 'decideTool' })
    cached = { at: now(), promise }
    // Never cache a rejected resolution
    promise.catch(() => { if (cached?.promise === promise) cached = null })
    return promise
  }

  return {
    async decide(request: DecisionToolRequest): Promise<DecisionToolResult> {
      let resolution: DecisionClientResolution
      try {
        resolution = await resolveCached()
      } catch (error) {
        // Fail closed even when settings/credential access itself blows up.
        const failure = toDecisionFailure(error)
        deps.log?.(`[decide] resolver failed: ${failure.message}`)
        return { ok: false, error: failure }
      }
      if (!resolution.ok) {
        deps.log?.(`[decide] unavailable: ${resolution.failure.kind} — ${resolution.failure.message}`)
        return { ok: false, error: resolution.failure }
      }

      const { client, provider, endpoint } = resolution.value
      // The tool schema is a looser mirror of the shared types; the client
      // validates the request before anything leaves the process.
      const decisionRequest: DecisionRequest = {
        state: request.state,
        questions: request.questions as DecisionRequest['questions'],
        deadlineMs: request.deadlineMs,
      }
      const startedAt = performance.now()
      try {
        const result = await client.decide(decisionRequest)
        void recorder.record({
          feature: 'decide_tool',
          provider,
          model: endpoint.model,
          questions: decisionRequest.questions,
          result,
          sessionId: deps.sessionId,
          meta: request.meta,
        })
        return {
          ok: true,
          model: result.model,
          answers: result.answers,
          usage: result.usage,
          latencyMs: result.latencyMs,
          truncated: result.state.truncated,
        }
      } catch (error) {
        const failure = toDecisionFailure(error)
        void recorder.record({
          feature: 'decide_tool',
          provider,
          model: endpoint.model,
          questions: decisionRequest.questions,
          error,
          latencyMs: Math.round(performance.now() - startedAt),
          sessionId: deps.sessionId,
          meta: request.meta,
        })
        deps.log?.(`[decide] failed: ${failure.kind} — ${failure.message}`)
        return { ok: false, error: failure }
      }
    },
  }
}
