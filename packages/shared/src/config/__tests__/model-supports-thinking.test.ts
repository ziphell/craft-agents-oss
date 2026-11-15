import { describe, expect, it } from 'bun:test'
import { modelSupportsThinking } from '../llm-connections.ts'

/**
 * Capability flags are only ever turned OFF: an explicit `false` disables,
 * anything else means supported. This must match what the SDK is told
 * (`buildCustomEndpointModelDef` defaults `reasoning` to true).
 */
describe('modelSupportsThinking', () => {
  it('defaults to true when the entry does not write it', () => {
    expect(modelSupportsThinking({ id: 'qwen3-coder' })).toBe(true)
  })

  it('defaults to true for a bare string entry (no parameters at all)', () => {
    expect(modelSupportsThinking('qwen3-coder')).toBe(true)
  })

  it('defaults to true when the model is not in the list at all', () => {
    expect(modelSupportsThinking(undefined)).toBe(true)
  })

  it('honours an explicit true', () => {
    expect(modelSupportsThinking({ id: 'deepseek-r1', supportsThinking: true })).toBe(true)
  })

  it('honours an explicit false', () => {
    expect(modelSupportsThinking({ id: 'qwen3-coder', supportsThinking: false })).toBe(false)
  })
})
