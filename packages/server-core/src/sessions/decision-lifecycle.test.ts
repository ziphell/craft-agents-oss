import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession } from '../../../shared/src/sessions/storage.ts'
import * as midTurnMessages from '../decisions/mid-turn-messages.ts'
import * as suggestions from '../decisions/suggestions.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

// Session-lifecycle guarantees around the decision points: ordering, no aborts from a decided
// steer, no turn after a stop, merges by reference, and user renames win over refreshes.
describe('decision points in the session lifecycle', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-decision-lifecycle-'))
    sm = new SessionManager()
    // Hermetic: never read the developer's decision-layer settings.
    ;(sm as any).decisionFeatureActive = () => false
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    sm.setEventSink(() => {})
  })

  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function session(id: string) {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'lifecycle test' }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    await saveSession({ id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    return managed
  }

  describe('mid-turn continuation merge', () => {
    // The composer always queues; the decision model only decides whether two
    // waiting halves are one request, so they replay as a single turn.
    const FIRST = 'when you create the calendar event later,'
    const SECOND = 'call it "Balaton team day" and don\'t invite anyone yet'

    async function splitSend() {
      const managed = await session('split')
      managed.isProcessing = true
      ;(sm as any).decisionFeatureActive = (feature: string) => feature === 'midTurnMessages'
      const continuations: Array<(same: boolean) => void> = []
      spyOn(midTurnMessages, 'isContinuation').mockImplementation(() => new Promise(resolve => continuations.push(resolve)))
      await sm.sendMessage(managed.id, FIRST)
      await sm.sendMessage(managed.id, SECOND)
      return { managed, continuations }
    }

    it('queues both halves, then merges them into one replay when the model calls them one request', async () => {
      const { managed, continuations } = await splitSend()
      expect(managed.messageQueue.map(entry => entry.message)).toEqual([FIRST, SECOND])
      expect(managed.messages.filter(m => m.role === 'user').every(m => m.isQueued)).toBe(true)

      continuations[0]!(true)
      await tick()
      expect(managed.messageQueue[1]!.mergeWith).toBe(managed.messageQueue[0])

      const replays: string[] = []
      ;(sm as any).sendMessage = async (_id: string, message: string) => { replays.push(message) }
      ;(sm as any).processNextQueuedMessage(managed.id)
      await tick()
      expect(replays).toEqual([`${FIRST}\n\n${SECOND}`])
    })

    it('keeps the halves separate when the model calls them different requests', async () => {
      const { managed, continuations } = await splitSend()
      continuations[0]!(false)
      await tick()
      expect(managed.messageQueue[1]!.mergeWith).toBeUndefined()
    })
  })

  it('records whether the request used the suggested source once it is over, across an activation retry', async () => {
    const managed = await session('suggestion-use')
    const followUps: Array<{ used: string[] }> = []
    spyOn(suggestions, 'suggestionFollowUp').mockImplementation((_trace, used) => { followUps.push({ used: [...used] }) })
    const calendar = { kind: 'source' as const, slug: 'google-calendar', name: 'Google Calendar', description: 'Calendar', path: '/ws/sources/google-calendar' }
    managed.suggestionTrace = { trace: { result: {} as never, choice: calendar, hinted: false, candidates: [calendar] }, used: new Set() }

    await (sm as any).processEvent(managed, { type: 'tool_start', toolName: 'mcp__session__source_test', toolUseId: 't1', input: { sourceSlug: 'google-calendar' } })
    // The activation schedules a hidden re-send of the request: not over yet.
    managed.autoRetryTimer = setTimeout(() => {}, 60_000)
    await (sm as any).onProcessingStopped(managed.id, 'complete')
    expect(followUps).toEqual([])
    clearTimeout(managed.autoRetryTimer)
    managed.autoRetryTimer = undefined

    await (sm as any).onProcessingStopped(managed.id, 'complete')
    expect(followUps).toEqual([{ used: ['source:google-calendar'] }])
    expect(managed.suggestionTrace).toBeUndefined()
  })

  it('does not start a turn that was stopped during the pre-turn checks', async () => {
    const managed = await session('stop-before-start')
    const chats: string[] = []
    ;(sm as any).getOrCreateAgent = async () => ({
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* (message: string) { chats.push(message); yield { type: 'complete' } },
    })
    let answer!: (value: { thinkingOverride: null; suggestionHint: null }) => void
    ;(sm as any).startPreTurnDecisions = () => new Promise(resolve => { answer = resolve })

    const sending = sm.sendMessage(managed.id, 'hello')
    await waitFor(() => typeof answer === 'function', 'the pre-turn checks')
    await sm.cancelProcessing(managed.id)
    answer({ thinkingOverride: null, suggestionHint: null })
    await sending

    expect(chats).toEqual([])
    expect(managed.isProcessing).toBe(false)
  })

  it('starts the next turn despite a stop flag a handoff left behind', async () => {
    const managed = await session('stale-stop')
    managed.stopRequested = true  // plan submission / auth handoffs end the turn without clearing it
    const chats: string[] = []
    ;(sm as any).getOrCreateAgent = async () => ({
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* (message: string) { chats.push(message); yield { type: 'complete' } },
    })
    await sm.sendMessage(managed.id, 'go ahead')
    expect(chats).toEqual(['go ahead'])
  })

  it('merges queued continuations by reference, not by position', async () => {
    const managed = await session('merge')
    const replays: string[] = []
    ;(sm as any).sendMessage = async (_id: string, message: string) => { replays.push(message) }
    const a = { message: 'A', messageId: 'a' }
    const steer = { message: 'S', messageId: 's' }
    const b = { message: 'B', messageId: 'b', mergeWith: a }
    managed.messageQueue = [a, steer, b]
    ;(sm as any).processNextQueuedMessage(managed.id)
    ;(sm as any).processNextQueuedMessage(managed.id)
    await tick()
    expect(replays).toEqual(['A', 'S'])

    const c = { message: 'C', messageId: 'c' }
    const d = { message: 'D', messageId: 'd', mergeWith: c }
    managed.messageQueue = [c, d]
    ;(sm as any).processNextQueuedMessage(managed.id)
    await tick()
    expect(replays.at(-1)).toBe('C\n\nD')
    expect(managed.replayMergedIds?.get('c')).toEqual(['c', 'd'])
  })

  it('keeps a title the user set while an automatic refresh was generating', async () => {
    const managed = await session('rename')
    managed.name = 'Old automatic title'
    managed.messages.push({ id: 'u1', role: 'user', content: 'plan the release', timestamp: 1 } as any)
    managed.agent = {
      regenerateTitle: async () => {
        managed.name = 'My own title'
        return 'New automatic title'
      },
    } as any
    const result = await sm.refreshTitle(managed.id, { onlyIfName: 'Old automatic title' })
    expect(result.success).toBe(false)
    expect(managed.name).toBe('My own title')
  })
})
