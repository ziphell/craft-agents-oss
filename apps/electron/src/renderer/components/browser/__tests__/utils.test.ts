import { describe, expect, it } from 'bun:test'
import { getHostname, openTargetOfActiveTab } from '../utils'
import type { TabBelongsTo } from '../../../../shared/types'

describe('getHostname', () => {
  it('returns stripped hostname for https URLs', () => {
    expect(getHostname('https://www.example.com/path?q=1')).toBe('example.com')
  })

  it('returns New Tab for about:blank', () => {
    expect(getHostname('about:blank')).toBe('New Tab')
  })

  it('returns filename for file URLs', () => {
    expect(getHostname('file:///Users/tester/report.html')).toBe('report.html')
  })

  it('returns Local File for file URLs without basename', () => {
    expect(getHostname('file:///Users/tester/folder/')).toBe('Local File')
  })

  it('returns protocol token for custom schemes with empty hostname', () => {
    expect(getHostname('data:text/html,hello')).toBe('data')
  })

  it('falls back to original input for malformed URLs', () => {
    expect(getHostname('not a url')).toBe('not a url')
  })
})

/** One tab, with only the facts the menu's target rule reads. */
function tab(fields: {
  active?: boolean
  lockedBy?: string | null
  cursorOf?: string | null
  belongsTo?: TabBelongsTo | null
}) {
  return { active: false, lockedBy: null, cursorOf: null, belongsTo: null, ...fields }
}

/** Sessions as the rule reads them: which task each carries, and whether something spawned it. */
function sessions(map: Record<string, { taskSlug?: string; parentSessionId?: string; taskDraft?: boolean }>) {
  return Object.entries(map)
}

const nodeWork = (taskSlug: string, nodeId: string, sessionId: string): TabBelongsTo => ({
  kind: 'task',
  taskSlug,
  runId: 'r1',
  nodeId,
  sessionId,
})

describe('openTargetOfActiveTab', () => {
  const ORCHESTRATOR = { taskSlug: 'checkout-flow' }
  const CHILD = { taskSlug: 'checkout-flow', parentSessionId: 'orch' }

  // Who is working on the tab on screen is the first answer, whoever the tab belongs to: that is
  // "what is this agent doing right now", which is what somebody clicking from the window wants.
  it('opens the conversation working on the tab on screen', () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, lockedBy: 'child-1', belongsTo: nodeWork('checkout-flow', 'pay', 'child-1') })],
      sessions({ orch: ORCHESTRATOR, 'child-1': CHILD }),
    )

    expect(target).toEqual({ kind: 'session', sessionId: 'child-1' })
  })

  it('falls back to the conversation that works from the tab', () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, cursorOf: 'session-a' })],
      sessions({ 'session-a': {} }),
    )

    expect(target).toEqual({ kind: 'session', sessionId: 'session-a' })
  })

  it("opens the conversation a conversation's own tab belongs to", () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, belongsTo: { kind: 'session', sessionId: 'session-a' } })],
      sessions({}),
    )

    expect(target).toEqual({ kind: 'session', sessionId: 'session-a' })
  })

  // A task's tab opens the **task**, not the session that opened the tab: that one is provenance,
  // and once its node has been re-run it has stopped — opening it would land on a dead conversation.
  it("opens the task for a task's tab, not the session that opened it", () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, belongsTo: nodeWork('checkout-flow', 'pay', 'child-1') })],
      sessions({ orch: ORCHESTRATOR, 'child-1': CHILD }),
    )

    expect(target).toEqual({ kind: 'task', sessionId: 'orch' })
  })

  it('has nothing to open when only the spawned node sessions remain', () => {
    // Not falling back to them is the point: the one that opened this tab has stopped, and a dead
    // conversation is worse than a greyed-out item.
    const target = openTargetOfActiveTab(
      [tab({ active: true, belongsTo: nodeWork('checkout-flow', 'pay', 'child-1') })],
      sessions({ 'child-1': CHILD }),
    )

    expect(target).toBeNull()
  })

  it('skips a generate-time draft orchestrator, which is off the board', () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, belongsTo: nodeWork('checkout-flow', 'pay', 'child-1') })],
      sessions({ draft: { taskSlug: 'checkout-flow', taskDraft: true }, 'child-1': CHILD }),
    )

    expect(target).toBeNull()
  })

  it("does not borrow another task's session", () => {
    const target = openTargetOfActiveTab(
      [tab({ active: true, belongsTo: nodeWork('checkout-flow', 'pay', 'child-1') })],
      sessions({ other: { taskSlug: 'other-task' } }),
    )

    expect(target).toBeNull()
  })

  it("has nothing to open for a person's tab", () => {
    expect(openTargetOfActiveTab([tab({ active: true })], sessions({ orch: ORCHESTRATOR }))).toBeNull()
  })

  it('has nothing to open when no tab is on screen', () => {
    const behind = tab({ active: false, belongsTo: { kind: 'session', sessionId: 'session-a' } })

    expect(openTargetOfActiveTab([behind], sessions({}))).toBeNull()
    expect(openTargetOfActiveTab([], sessions({}))).toBeNull()
    expect(openTargetOfActiveTab(undefined, sessions({}))).toBeNull()
  })
})
