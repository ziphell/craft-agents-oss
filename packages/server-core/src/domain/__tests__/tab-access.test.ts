import { describe, expect, it } from 'bun:test'
import type { TabBelongsTo } from '@craft-agent/shared/protocol'
import {
  pickCommandTarget,
  whyTabIsLocked,
  whyTabIsNotMineToClose,
  whyTabIsOutOfReach,
} from '../tab-access'

/** A tab as the target rule sees it: what it is, who works from it, what is on screen. */
function page(id: string, cursorOf: string[], active = false) {
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
  // The conversation's own tab wins, even though the person is looking at another one:
  // what they are looking at is theirs to change at any moment, and it must not move
  // somebody else's command.
  it("prefers the conversation's own tab over the one on screen", () => {
    const target = pickCommandTarget([page('tab-1', [], true), page('tab-2', ['session-a'])], 'session-a')

    expect(target?.tab.id).toBe('tab-2')
    expect(target?.because).toBe('cursor')
  })

  it('does not answer with a tab that merely happens to be on screen', () => {
    // The person clicking through the window does not change the answer.
    const before = pickCommandTarget([page('tab-1', [], true), page('tab-2', ['session-a'])], 'session-a')
    const after = pickCommandTarget([page('tab-1', []), page('tab-2', ['session-a'], true)], 'session-a')

    expect(before?.tab.id).toBe('tab-2')
    expect(after?.tab.id).toBe('tab-2')
  })

  // …and with no tab of its own, the tab in front is the takeover case: a person opens
  // something, the conversation starts there.
  it('falls back to the tab on screen when the conversation has none', () => {
    const target = pickCommandTarget([page('tab-1', []), page('tab-2', [], true)], 'session-a')

    expect(target?.tab.id).toBe('tab-2')
    expect(target?.because).toBe('on-screen')
  })

  // Several conversations may work from one tab (第二十四轮), so "mine" is a question about my
  // own entry, not about who else's is there.
  it("answers with the tab the conversation works from even when others work from it too", () => {
    const target = pickCommandTarget(
      [page('tab-1', ['session-b'], true), page('tab-2', ['session-b', 'session-a'])],
      'session-a',
    )

    expect(target?.tab.id).toBe('tab-2')
    expect(target?.because).toBe('cursor')
  })

  it("does not read another conversation's tab as its own", () => {
    // Whose tab it is, is not this rule's question: another session's cursor on a tab is simply
    // not *mine*, and with nothing on screen there is no target at all.
    expect(pickCommandTarget([page('tab-1', ['session-b'])], 'session-a')).toBeNull()
  })

  it('has no answer for a window with no tabs', () => {
    expect(pickCommandTarget([], 'session-a')).toBeNull()
  })
})

describe('whyTabIsOutOfReach', () => {
  it('lets anyone take over a tab nobody’s work claims', () => {
    // The case the shared window is for: a person opens a tab, the agent takes over.
    expect(whyTabIsOutOfReach({ id: 'tab-1', belongsTo: null }, session('session-a'))).toBeNull()
  })

  it('lets a conversation work on a tab it opened itself, whatever else it is doing', () => {
    // Otherwise a tab a conversation opened itself would be out of reach to the very
    // conversation that opened it.
    expect(whyTabIsOutOfReach({ id: 'tab-2', belongsTo: session('session-a') }, session('session-a'))).toBeNull()
  })

  it("refuses a tab another conversation's task owns, and says what to do about it", () => {
    const why = whyTabIsOutOfReach({ id: 'tab-2', belongsTo: session('session-b') }, session('session-a'))

    expect(why).toContain("Tab tab-2 is session-b's task")
    expect(why).toContain('tab-new')
    expect(why).toContain('tab-assign')
  })

  // A cursor used to be a wall, and this is the case that made it one: a tab somebody works from
  // was refused to everyone else, for as long as that conversation existed (第二十四轮). It is not
  // a claim — the tab is the **person's**, and the conversation they hand it to has to be able to
  // work there. Nothing is taken from the first one by that: each keeps its own cursor.
  it('lets another conversation work on a tab somebody works from, because a cursor is not a claim', () => {
    const theirs = { id: 'tab-3', belongsTo: null, cursorOf: ['session-b'] }

    expect(whyTabIsOutOfReach(theirs, session('session-a'))).toBeNull()
  })

  // …and what keeps two conversations out of one tab at the same moment is the lock, which is a
  // wait rather than a wall: it says when, not never (whyTabIsLocked).
  it('leaves the moment two conversations want one tab to the lock', () => {
    const why = whyTabIsLocked({ id: 'tab-3', lockedBy: 'session-b' }, 'session-a')

    expect(why).toContain('locked while session-b works on it')
    expect(why).toContain('wait for it to be released')
  })

  it('lets a conversation work from a free tab it has claimed itself', () => {
    // The takeover, one command later: the person's tab is nobody's, the conversation's first
    // command made it the tab it works from (`cursorOf`), and its **second** command has to be
    // allowed in it — refusing that is how an agent gets told to `tab-new` and walks off to a tab
    // of its own, leaving what the person had set up.
    const claimed = { id: 'tab-1', belongsTo: null, cursorOf: ['session-a'] }

    expect(whyTabIsOutOfReach(claimed, session('session-a'))).toBeNull()
  })

  it('does not let two conversations share the *work* in one tab', () => {
    // The wall this rule replaced: two conversations working on the same thing used to mean
    // "in reach", which made a parent and its children interfere tab for tab. The wall that
    // remains is whose work the tab is — a conversation's own tab is still not another
    // conversation's to work in.
    const why = whyTabIsOutOfReach({ id: 'tab-4', belongsTo: session('session-b') }, session('session-a'))

    expect(why).not.toBeNull()
  })

  // The DAG's own case, and the reason the owner is a *work* and not a session:
  // a node that is re-run is a new session for the same node, and it has to inherit the tab
  // its predecessor was working in rather than leaving it orphaned.
  it('lets a re-run of a node take over the tab its predecessor left', () => {
    const left = { id: 'tab-5', belongsTo: node('checkout-flow', 'pay', 'child-old'), cursorOf: [] }

    expect(whyTabIsOutOfReach(left, node('checkout-flow', 'pay', 'child-new'))).toBeNull()
  })

  it('does not let one node of a task work in another node of it', () => {
    const why = whyTabIsOutOfReach({ id: 'tab-6', belongsTo: node('checkout-flow', 'pay', 'child-a') }, node('checkout-flow', 'cart', 'child-b'))

    expect(why).toContain("the tab task checkout-flow opened for its node pay")
  })

  it('does not let two runs of one task share its tabs', () => {
    const other = { kind: 'task', taskSlug: 'checkout-flow', runId: 'r2', nodeId: 'pay', sessionId: 'child-b' } as const

    expect(whyTabIsOutOfReach({ id: 'tab-7', belongsTo: node('checkout-flow', 'pay', 'child-a') }, other)).not.toBeNull()
  })
})

describe('whyTabIsNotMineToClose', () => {
  it('lets a conversation close a tab it opened', () => {
    expect(whyTabIsNotMineToClose({ id: 'tab-1', belongsTo: session('session-a') }, session('session-a'))).toBeNull()
  })

  it("refuses the user's tab", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-1', belongsTo: null }, session('session-a'))

    expect(why).toContain("is the user's")
    expect(why).toContain('"tabs" lists the tabs you opened')
  })

  it("refuses another conversation's tab, naming it", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-3', belongsTo: session('session-b') }, session('session-a'))

    expect(why).toContain("belongs to session-b's task")
    expect(why).toContain('not yours to close')
  })

  // Housekeeping is the whole task's, which is what lets a finished run be tidied away: the
  // orchestrator never opened its nodes' tabs, and the nodes themselves have stopped.
  // Reach stays precise — see the two tests above it.
  it('lets the orchestrator close its own task\'s tabs, node tabs included', () => {
    expect(whyTabIsNotMineToClose({ id: 'tab-4', belongsTo: node('checkout-flow', 'pay', 'child-a') }, node('checkout-flow', null, 'orchestrator'))).toBeNull()
  })

  it('refuses another task\'s tab', () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-5', belongsTo: node('other-task', 'pay', 'child-a') }, node('checkout-flow', null, 'orchestrator'))

    expect(why).toContain('belongs to the task other-task')
    expect(why).toContain('not yours to close')
  })
})

describe('whyTabIsLocked', () => {
  it('lets a conversation work on a tab nobody has locked', () => {
    expect(whyTabIsLocked({ id: 'tab-1', lockedBy: null }, 'session-a')).toBeNull()
  })

  it('never locks a conversation out of the tab it is working on', () => {
    expect(whyTabIsLocked({ id: 'tab-1', lockedBy: 'session-a' }, 'session-a')).toBeNull()
  })

  // A different answer from reach, and the difference is the clock: reach is "not yours,
  // ever", this is "not free, now" — so what it says is how long, not how to qualify.
  it('refuses the tab while another conversation holds it, and says it is temporary', () => {
    const why = whyTabIsLocked({ id: 'tab-2', lockedBy: 'session-b' }, 'session-a')

    expect(why).toContain('Tab tab-2 is locked while session-b works on it')
    expect(why).toContain('until that turn ends')
    expect(why).not.toContain('bind')
  })
})
