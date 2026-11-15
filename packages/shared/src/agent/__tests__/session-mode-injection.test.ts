/**
 * Guards the injection of the session work mode (`goal`/`spec`/`plan`).
 *
 * The mode used to be rendered into the system prompt. That is the cached prefix, so switching
 * mode re-stamped it and dropped prompt-cache reuse — the same problem date/time and safe-mode
 * context already solve by riding user messages (issue #862). The mode block now does the same:
 * it is appended to the user message, once, when the mode is set or changed (and once more after
 * compaction, which rolls the earlier injection into a summary).
 *
 * These tests pin:
 *  1. the system prompt is byte-identical when the mode changes — the whole reason for the move;
 *  2. the block is announced on the turn the mode is set, then stays quiet on later turns;
 *  3. a change re-announces, and clearing the mode says nothing;
 *  4. compaction re-arms the block for the current mode.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { TestAgent, createMockBackendConfig, createMockSession } from './test-utils.ts'
import { getSystemPrompt } from '../../prompts/system.ts'
import { cleanupModeState } from '../mode-manager.ts'

// Matches createMockSession() in test-utils.ts
const SESSION_ID = 'test-session-id'
const FOLDER = '/tmp/projects/acme'
const OPTS = { plansFolderPath: '/tmp/plans', dataFolderPath: '/tmp/data', projectFolderPath: FOLDER }

function makeAgent(session: Parameters<typeof createMockSession>[0] = {}) {
  return new TestAgent(createMockBackendConfig({ session: createMockSession(session) }))
}

/** The system-prompt prefix as the Pi path builds it: static prompt + stable (cacheable) blocks. */
function systemPrefix(agent: TestAgent): string {
  return [
    getSystemPrompt(
      undefined, // pinnedPreferencesPrompt
      undefined, // debugMode
      '/tmp/workspace',
      '/tmp/workspace',
      undefined, // preset
      'Craft Agents Backend',
      true, // includeCoAuthoredBy
      undefined, // projectContext
    ),
    ...agent.getPromptBuilder().buildStableContextParts(),
  ].filter(Boolean).join('\n\n')
}

describe('session mode injection (user message, not system prompt)', () => {
  afterEach(() => cleanupModeState(SESSION_ID))

  it('keeps the system prompt byte-identical when the session mode changes', () => {
    const agent = makeAgent({ mode: undefined })
    const builder = agent.getPromptBuilder()

    const before = systemPrefix(agent)

    // Same session: turn a mode on, let the user message go out, then change the mode.
    agent.setSessionMode('goal')
    builder.buildVolatileContextParts(OPTS, undefined)
    agent.setSessionMode('plan')
    builder.buildVolatileContextParts(OPTS, undefined)

    const after = systemPrefix(agent)

    expect(after).toBe(before)
    // The mode must not appear in the cached prefix by any route.
    expect(after).not.toContain('<work ')
  })

  it('announces the mode on one user message when it is set, then stays quiet', () => {
    const builder = makeAgent({ mode: 'spec' }).getPromptBuilder()

    const first = builder.buildVolatileContextParts(OPTS, undefined).join('\n')
    const second = builder.buildVolatileContextParts(OPTS, undefined).join('\n')

    expect(first).toContain('<work mode="spec"')
    expect(first).toContain(`folder="${FOLDER}"`)
    expect(second).not.toContain('<work ')
  })

  it('says nothing when no mode is set', () => {
    const builder = makeAgent({ mode: undefined }).getPromptBuilder()

    const parts = builder.buildVolatileContextParts(OPTS, undefined).join('\n')

    expect(parts).not.toContain('<work ')
  })

  it('announces a changed mode once, and says nothing when the mode is cleared', () => {
    const agent = makeAgent({ mode: 'goal' })
    const builder = agent.getPromptBuilder()

    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).toContain('<work mode="goal"')

    // Change: the next user message carries the new mode…
    agent.setSessionMode('plan')
    const afterChange = builder.buildVolatileContextParts(OPTS, undefined).join('\n')
    expect(afterChange).toContain('<work mode="plan"')
    // …and only that one.
    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).not.toContain('<work ')

    // Cleared: nothing is announced.
    agent.setSessionMode(null)
    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).not.toContain('<work ')
  })

  it('re-announces the current mode after compaction', () => {
    const agent = makeAgent({ mode: 'spec' })
    const builder = agent.getPromptBuilder()

    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).toContain('<work mode="spec"')
    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).not.toContain('<work ')

    // Both agents call resetPrerequisiteState() on compaction; it re-arms the mode block.
    agent.resetPrerequisiteState()

    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).toContain('<work mode="spec"')
  })

  it('names no mode on a session with no project folder, and still announces one once bound', () => {
    const builder = makeAgent({ mode: 'spec' }).getPromptBuilder()

    // No project folder → the block would name nowhere, so it is not emitted…
    expect(builder.buildVolatileContextParts({ plansFolderPath: '/tmp/plans' }, undefined).join('\n')).not.toContain('<work ')
    // …and it is not swallowed: once a folder exists it goes out.
    expect(builder.buildVolatileContextParts(OPTS, undefined).join('\n')).toContain('<work mode="spec"')
  })
})
