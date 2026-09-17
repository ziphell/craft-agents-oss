import { describe, expect, it } from 'bun:test'
import type { TabBelongsTo } from '@craft-agent/shared/protocol'
import { pickCommandTarget, whyTabIsLocked, whyTabIsNotMineToClose, whyTabIsOutOfReach } from '../tab-access'

/** A page as the target rule sees it: what it is, who works from it, what is on screen. */
function page(id: string, cursorOf: string | null, active = false) {
  return { id, cursorOf, active }
}

/** A conversation's own work, and a DAG node's — the two kinds `belongsTo` has. */
const session = (sessionId: string): TabBelongsTo => ({ kind: 'session', sessionId })
const node = (taskSlug: string, nodeId: string | null, sessionId: string): TabBelongsTo => ({
  kind: 'task',
  taskSlug,
  runId: 'r1',
  nodeId,
  sessionId,
})

describe('pickCommandTarget', () => {
  // The conversation's own page wins, even though the person is looking at another one:
  // what they are looking at is theirs to change at any moment, and it must not move
  // somebody else's command (plan §22, 第十轮).
  it("prefers the conversation's own page over the one on screen", () => {
    const target = pickCommandTarget([page('tab-1', null, true), page('tab-2', 'session-a')], 'session-a')

    expect(target?.tab.id).toBe('tab-2')
    expect(target?.because).toBe('cursor')
  })

  it('does not answer with a page that merely happens to be on screen', () => {
    // The person clicking through the window does not change the answer.
    const before = pickCommandTarget([page('tab-1', null, true), page('tab-2', 'session-a')], 'session-a')
    const after = pickCommandTarget([page('tab-1', null), page('tab-2', 'session-a', true)], 'session-a')

    expect(before?.tab.id).toBe('tab-2')
    expect(after?.tab.id).toBe('tab-2')
  })

  // …and with no page of its own, the page in front is the takeover case: a person opens
  // something, the conversation starts there.
  it('falls back to the page on screen when the conversation has none', () => {
    const target = pickCommandTarget([page('tab-1', null), page('tab-2', null, true)], 'session-a')

    expect(target?.tab.id).toBe('tab-2')
    expect(target?.because).toBe('on-screen')
  })

  it("does not read another conversation's page as its own", () => {
    // Whose page it is, is not this rule's question: another session's page is simply not
    // *mine*, and with nothing on screen there is no target at all.
    expect(pickCommandTarget([page('tab-1', 'session-b')], 'session-a')).toBeNull()
  })

  it('has no answer for a window with no pages', () => {
    expect(pickCommandTarget([], 'session-a')).toBeNull()
  })
})

describe('whyTabIsOutOfReach', () => {
  it('lets anyone take over a page nobody has claimed', () => {
    // The case the shared window is for: a person opens a page, the agent takes over.
    expect(whyTabIsOutOfReach({ id: 'tab-1', belongsTo: null, cursorOf: null }, session('session-a'))).toBeNull()
  })

  it('lets a conversation work on a page it opened itself, whatever it is bound to', () => {
    // Otherwise `prototype-open <slug>` from an unbound conversation would open a page
    // it could not then read.
    expect(whyTabIsOutOfReach({ id: 'tab-2', belongsTo: session('session-a'), cursorOf: null }, session('session-a'))).toBeNull()
  })

  it("refuses a page another conversation's task owns, and says what to do about it", () => {
    const why = whyTabIsOutOfReach({ id: 'tab-2', belongsTo: session('session-b'), cursorOf: null }, session('session-a'))

    expect(why).toContain("Page tab-2 is session-b's task")
    expect(why).toContain('tab-new')
    expect(why).toContain('tab-assign')
  })

  it('refuses a page another conversation works from, even though nobody opened it', () => {
    // The claim is what matters, not who opened it: a child session that took a free page
    // keeps it while it works, and a sibling does not get to slide onto it (plan §22,
    // Conductor).
    const why = whyTabIsOutOfReach({ id: 'tab-3', belongsTo: null, cursorOf: 'session-b' }, session('session-a'))

    expect(why).toContain("Page tab-3 is session-b's to work from")
  })

  it('does not let two conversations bound to one prototype share its pages', () => {
    // The wall this rule replaced: same prototype used to mean "in reach", which made a
    // parent and its children interfere page for page.
    const why = whyTabIsOutOfReach({ id: 'tab-4', belongsTo: session('session-b'), cursorOf: null }, session('session-a'))

    expect(why).not.toBeNull()
  })

  // The DAG's own case, and the reason the owner is a *work* and not a session (plan §22):
  // a node that is re-run is a new session for the same node, and it has to inherit the page
  // its predecessor was working in rather than leaving it orphaned.
  it('lets a re-run of a node take over the page its predecessor left', () => {
    const left = { id: 'tab-5', belongsTo: node('checkout-flow', 'pay', 'child-old'), cursorOf: null }

    expect(whyTabIsOutOfReach(left, node('checkout-flow', 'pay', 'child-new'))).toBeNull()
  })

  it('does not let one node of a task work in another node of it', () => {
    const why = whyTabIsOutOfReach({ id: 'tab-6', belongsTo: node('checkout-flow', 'pay', 'child-a'), cursorOf: null }, node('checkout-flow', 'cart', 'child-b'))

    expect(why).toContain("the page task checkout-flow opened for its node pay")
  })

  it('does not let two runs of one task share its pages', () => {
    const other = { kind: 'task', taskSlug: 'checkout-flow', runId: 'r2', nodeId: 'pay', sessionId: 'child-b' } as const

    expect(whyTabIsOutOfReach({ id: 'tab-7', belongsTo: node('checkout-flow', 'pay', 'child-a'), cursorOf: null }, other)).not.toBeNull()
  })
})

describe('whyTabIsNotMineToClose', () => {
  it('lets a conversation close a page it opened', () => {
    expect(whyTabIsNotMineToClose({ id: 'tab-1', belongsTo: session('session-a') }, session('session-a'))).toBeNull()
  })

  it("refuses the user's page", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-1', belongsTo: null }, session('session-a'))

    expect(why).toContain("is the user's")
    expect(why).toContain('"tabs" lists the pages you opened')
  })

  it("refuses another conversation's page, naming it", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-3', belongsTo: session('session-b') }, session('session-a'))

    expect(why).toContain("belongs to session-b's task")
    expect(why).toContain('not yours to close')
  })

  // Housekeeping is the whole task's, which is what lets a finished run be tidied away: the
  // orchestrator never opened its nodes' pages, and the nodes themselves have stopped (plan
  // §22). Reach stays precise — see the two tests above it.
  it('lets the orchestrator close its own task\'s pages, node pages included', () => {
    expect(whyTabIsNotMineToClose({ id: 'tab-4', belongsTo: node('checkout-flow', 'pay', 'child-a') }, node('checkout-flow', null, 'orchestrator'))).toBeNull()
  })

  it('refuses another task\'s page', () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-5', belongsTo: node('other-task', 'pay', 'child-a') }, node('checkout-flow', null, 'orchestrator'))

    expect(why).toContain('belongs to the task other-task')
    expect(why).toContain('not yours to close')
  })
})

describe('whyTabIsLocked', () => {
  it('lets a conversation work on a page nobody has locked', () => {
    expect(whyTabIsLocked({ id: 'tab-1', lockedBy: null }, 'session-a')).toBeNull()
  })

  it('never locks a conversation out of the page it is working on', () => {
    expect(whyTabIsLocked({ id: 'tab-1', lockedBy: 'session-a' }, 'session-a')).toBeNull()
  })

  // A different answer from reach, and the difference is the clock: reach is "not yours,
  // ever", this is "not free, now" — so what it says is how long, not how to qualify.
  it('refuses the page while another conversation holds it, and says it is temporary', () => {
    const why = whyTabIsLocked({ id: 'tab-2', lockedBy: 'session-b' }, 'session-a')

    expect(why).toContain('Page tab-2 is locked while session-b works on it')
    expect(why).toContain('until that turn ends')
    expect(why).not.toContain('prototype-bind')
  })
})
