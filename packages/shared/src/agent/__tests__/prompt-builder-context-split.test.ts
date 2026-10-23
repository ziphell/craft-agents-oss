/**
 * Guards the volatile/stable context split (issue #862).
 *
 * The Pi adapter folded volatile context (date/time, session_state, sources)
 * into the cached system prefix, re-stamping it every turn and killing
 * prompt-cache reuse. The fix splits PromptBuilder.buildContextParts() into
 * buildVolatileContextParts() + buildStableContextParts() so the Pi path can
 * keep stable blocks in the system prompt and route volatile blocks to the user
 * tail (where the Claude path already puts everything).
 *
 * These tests pin three invariants:
 *  1. buildContextParts === [...volatile, ...stable] — the Claude path output is
 *     unchanged (same blocks, same order).
 *  2. Blocks are routed correctly: session_state + sources are volatile;
 *     workspace capabilities is stable.
 *  3. The one-shot mode-change signal is consumed exactly once, and only by the
 *     volatile builder — never by the stable builder.
 */
import { describe, it, expect, afterEach, beforeEach, setSystemTime } from 'bun:test'
import { TestAgent, createMockBackendConfig } from './test-utils.ts'
import { cleanupModeState, initializeModeState, setPermissionMode } from '../mode-manager.ts'
import {
  clearBrowserProfilePromptState,
  setBrowserProfilePromptState,
} from '../browser-profile-prompt-state.ts'
import {
  clearBrowserHostState,
  setBrowserHostState,
} from '../browser-host-state.ts'

// Matches createMockSession() in test-utils.ts
const SESSION_ID = 'test-session-id'
const OPTS = { plansFolderPath: '/tmp/plans', dataFolderPath: '/tmp/data' }
const SOURCE_BLOCK = '<sources>\nActive: none\n</sources>'

function makeBuilder() {
  return new TestAgent(createMockBackendConfig()).getPromptBuilder()
}

describe('PromptBuilder volatile/stable context split (issue #862)', () => {
  // Freeze the clock: getDateTimeContext() stamps a millisecond-precision ISO
  // timestamp on every call, so an unfrozen clock makes the byte-identical
  // comparison below flaky whenever the two builds straddle a millisecond.
  beforeEach(() => setSystemTime(new Date('2026-03-02T10:00:00.000Z')))
  afterEach(() => {
    setSystemTime()
    cleanupModeState(SESSION_ID)
    clearBrowserProfilePromptState(SESSION_ID)
    clearBrowserHostState(SESSION_ID)
  })

  it('buildContextParts equals [...volatile, ...stable] (Claude path stays byte-identical)', () => {
    // No pending one-shot signal → consume is a no-op → repeated calls are stable.
    cleanupModeState(SESSION_ID)
    const builder = makeBuilder()
    const composed = [
      ...builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK),
      ...builder.buildStableContextParts(),
    ]
    const combined = builder.buildContextParts(OPTS, SOURCE_BLOCK)
    expect(combined).toEqual(composed)
  })

  it('routes session_state + sources to volatile and workspace capabilities to stable', () => {
    cleanupModeState(SESSION_ID)
    const builder = makeBuilder()
    const volatileText = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    const stableText = builder.buildStableContextParts().join('\n')

    // session_state + source ride the volatile tail
    expect(volatileText).toContain('permissionMode:')
    expect(volatileText).toContain(SOURCE_BLOCK)
    // workspace capabilities is stable
    expect(stableText).toContain('<workspace_capabilities>')

    // The halves must not bleed into each other
    expect(volatileText).not.toContain('<workspace_capabilities>')
    expect(stableText).not.toContain('permissionMode:')
  })

  it('consumes the one-shot mode-change signal exactly once, only on the volatile path', () => {
    initializeModeState(SESSION_ID, 'safe')
    setPermissionMode(SESSION_ID, 'allow-all', {
      changedBy: 'user',
      changedAt: '2026-03-02T10:00:00.000Z',
    })
    const builder = makeBuilder()

    // Stable path never touches the one-shot signal.
    expect(builder.buildStableContextParts().join('\n')).not.toContain('modeChangeUserSignal:')

    // Volatile path emits it on the first call, then never again.
    const first = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    const second = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    expect(first).toContain('modeChangeUserSignal:')
    expect(second).not.toContain('modeChangeUserSignal:')
  })

  // Switching profiles must not touch the cached prefix: the profile is volatile state, and the
  // switch is announced once — on the first turn after it, not on every turn that follows.
  it('keeps the browser profile on the volatile tail, and announces a switch once', () => {
    setBrowserProfilePromptState(SESSION_ID, 'Default')
    const builder = makeBuilder()

    // The stable half (the system prefix on Pi) never carries it.
    expect(builder.buildStableContextParts().join('\n')).not.toContain('browserProfile')

    const first = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    expect(first).toContain('browserProfile: Default')
    expect(first).not.toContain('browserProfileChanged:')

    setBrowserProfilePromptState(SESSION_ID, 'Work', { announceFrom: 'Default' })
    const afterSwitch = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    expect(afterSwitch).toContain('browserProfile: Work')
    expect(afterSwitch).toContain('browserProfileChanged:')

    const nextTurn = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    expect(nextTurn).toContain('browserProfile: Work')
    expect(nextTurn).not.toContain('browserProfileChanged:')
  })

  // A headless hub has no `browser_tool` to learn from; the host has to say so, or the agent reads
  // the refusal as a broken setup and keeps retrying. Same volatile channel as the profile.
  it('tells a browser-less server that it has no browser, on the volatile tail only', () => {
    cleanupModeState(SESSION_ID)
    const builder = makeBuilder()

    expect(builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')).not.toContain('browserHost')

    setBrowserHostState(SESSION_ID, false)
    const volatileText = builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')
    expect(volatileText).toContain('browserHost: none')
    expect(volatileText).toContain('device_tool')
    expect(builder.buildStableContextParts().join('\n')).not.toContain('browserHost')

    // A server with its own browser needs no announcement.
    setBrowserHostState(SESSION_ID, true)
    expect(builder.buildVolatileContextParts(OPTS, SOURCE_BLOCK).join('\n')).not.toContain('browserHost')
  })
})
