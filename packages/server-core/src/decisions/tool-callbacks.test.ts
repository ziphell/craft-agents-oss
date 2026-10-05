import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDecisionToolCallbacks } from './tool-callbacks'
import {
  DecisionError,
  DecisionRecorder,
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@craft-agent/shared/decisions'

const QUESTIONS = {
  topic: { type: 'choice' as const, instructions: 'Which topic?', criteria: { billing: 'money', shipping: 'delivery' } },
}

function resolutionWith(fetchImpl: typeof fetch): DecisionClientResolution {
  const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'typesafe' })
  const endpoint = resolveDecisionEndpoint(settings)
  const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
  return { ok: true, value: { client, settings, provider: 'typesafe', endpoint, keySource: 'provider' } }
}

describe('decision tool callbacks', () => {
  it('fails closed with the resolver failure when the layer is unavailable', async () => {
    const logs: string[] = []
    const callbacks = buildDecisionToolCallbacks({
      sessionId: 's1',
      log: m => logs.push(m),
      resolveClient: async () => ({ ok: false, failure: { kind: 'unconfigured', message: 'no key' } }),
      recorder: new DecisionRecorder({ path: join(mkdtempSync(join(tmpdir(), 'craft-decide-')), 'd.jsonl') }),
    })
    const result = await callbacks.decide({ state: 'x', questions: QUESTIONS })
    expect(result).toEqual({ ok: false, error: { kind: 'unconfigured', message: 'no key' } })
    expect(logs[0]).toContain('unconfigured')
  })

  it('runs the decision and records it with the session id and meta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-decide-'))
    try {
      const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
      let requested: { url: string; body: unknown } | undefined
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        requested = { url: String(url), body: JSON.parse(String(init?.body)) }
        return new Response(JSON.stringify({
          model: 'jev-1.13.0',
          answers: { topic: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.95, shipping: 0.05 } } },
          usage: { input_tokens: 10, output_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch

      const callbacks = buildDecisionToolCallbacks({ sessionId: 'sess-42', resolveClient: async () => resolutionWith(fetchImpl), recorder })
      const result = await callbacks.decide({ state: 'Card charged twice', questions: QUESTIONS, deadlineMs: 5000, meta: { batch: true, index: 3, total: 9 } })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.model).toBe('jev-1.13.0')
      expect(result.answers.topic).toMatchObject({ type: 'choice', choice: 'billing' })
      expect(result.truncated).toBe(false)
      expect(requested?.url).toBe('https://api.typesafe.ai/v1/systemone')
      expect((requested?.body as { model: string }).model).toBe('jev-1.13.0')

      // recorder writes are fire-and-forget; wait for the queue
      await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
      const lines = readFileSync(recorder.path, 'utf8').trim().split('\n')
      const record = JSON.parse(lines[0]!)
      expect(record.feature).toBe('decide_tool')
      expect(record.sessionId).toBe('sess-42')
      expect(record.meta).toEqual({ batch: true, index: 3, total: 9 })
      expect(record.answers.topic.choice).toBe('billing')
      expect(lines[0]).not.toContain('Card charged twice')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps client errors to tool errors and records the failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-decide-'))
    try {
      const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
      const fetchImpl = (async () => new Response('{"error":{"message":"nope"}}', { status: 429 })) as unknown as typeof fetch
      const callbacks = buildDecisionToolCallbacks({ sessionId: 's', resolveClient: async () => resolutionWith(fetchImpl), recorder })
      const result = await callbacks.decide({ state: 'x', questions: QUESTIONS })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.kind).toBe('rate_limited')
      expect(result.error.status).toBe(429)

      await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
      const record = JSON.parse(readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!)
      expect(record.ok).toBe(false)
      expect(record.error.kind).toBe('rate_limited')
      expect(typeof record.latencyMs).toBe('number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses one resolution across a batch and re-resolves after the TTL', async () => {
    let clock = 1_000
    let resolutions = 0
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { topic: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.95, shipping: 0.05 } } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const callbacks = buildDecisionToolCallbacks({
      sessionId: 's',
      resolveClient: async () => { resolutions += 1; return resolutionWith(fetchImpl) },
      recorder: new DecisionRecorder({ path: join(mkdtempSync(join(tmpdir(), 'craft-decide-')), 'd.jsonl') }),
      resolutionTtlMs: 1_000,
      now: () => clock,
    })
    await Promise.all(Array.from({ length: 5 }, () => callbacks.decide({ state: 'x', questions: QUESTIONS })))
    expect(resolutions).toBe(1)
    clock += 1_001
    await callbacks.decide({ state: 'x', questions: QUESTIONS })
    expect(resolutions).toBe(2)
  })

  it('fails closed when the resolver itself throws, and does not cache the failure', async () => {
    let attempts = 0
    const callbacks = buildDecisionToolCallbacks({
      sessionId: 's',
      resolveClient: async () => { attempts += 1; throw new Error('vault locked') },
      recorder: new DecisionRecorder({ path: join(mkdtempSync(join(tmpdir(), 'craft-decide-')), 'd.jsonl') }),
    })
    const first = await callbacks.decide({ state: 'x', questions: QUESTIONS })
    const second = await callbacks.decide({ state: 'x', questions: QUESTIONS })
    expect(first).toEqual({ ok: false, error: { kind: 'unavailable', message: 'vault locked' } })
    expect(second.ok).toBe(false)
    expect(attempts).toBe(2)
  })

  it('turns client-side validation errors into invalid_request without a network call', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    const callbacks = buildDecisionToolCallbacks({
      sessionId: 's',
      resolveClient: async () => resolutionWith(fetchImpl),
      recorder: new DecisionRecorder({ path: join(mkdtempSync(join(tmpdir(), 'craft-decide-')), 'd.jsonl') }),
    })
    const result = await callbacks.decide({ state: 'x', questions: { bad: { type: 'choice', instructions: 'pick', criteria: { only: null } } } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_request')
    expect(called).toBe(false)
    expect(new DecisionError('timeout', 'x').kind).toBe('timeout')
  })
})
