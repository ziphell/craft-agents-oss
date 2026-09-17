import { describe, expect, it } from 'bun:test'
import { pickCommandTarget, whyTabIsLocked, whyTabIsNotMineToClose, whyTabIsOutOfReach } from '../tab-access'

const prototype = { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' }

/** A page as the target rule sees it: what it is, who works from it, what is on screen. */
function page(id: string, cursorOf: string | null, active = false) {
  return { id, cursorOf, active }
}

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
  it('lets anyone work on a page that belongs to no prototype', () => {
    // The case the shared window is for: a person opens a page, the agent takes over.
    expect(whyTabIsOutOfReach({ id: 'tab-1', prototype: null, openedBySessionId: null }, 'session-a', undefined)).toBeNull()
  })

  it('lets a conversation work on the prototype it works on', () => {
    expect(whyTabIsOutOfReach({ id: 'tab-1', prototype, openedBySessionId: null }, 'session-a', 'checkout-flow')).toBeNull()
  })

  it('refuses another prototype\'s page, and says what to do about it', () => {
    const why = whyTabIsOutOfReach({ id: 'tab-2', prototype, openedBySessionId: null }, 'session-a', 'rival-checkout')

    expect(why).toContain('Page tab-2 is "checkout-flow"\'s')
    expect(why).toContain('works on "rival-checkout"')
    expect(why).toContain('prototype-bind checkout-flow')
  })

  it('refuses a prototype\'s page to a conversation that works on none', () => {
    const why = whyTabIsOutOfReach({ id: 'tab-2', prototype, openedBySessionId: null }, 'session-a', undefined)

    expect(why).toContain('works on no prototype')
  })

  it('lets a conversation work on a page it opened itself, whatever it is bound to', () => {
    // Otherwise `prototype-open <slug>` from an unbound conversation would open a page
    // it could not then read.
    expect(whyTabIsOutOfReach({ id: 'tab-2', prototype, openedBySessionId: 'session-a' }, 'session-a', undefined)).toBeNull()
  })

  it('does not exempt a page another conversation opened', () => {
    expect(whyTabIsOutOfReach({ id: 'tab-2', prototype, openedBySessionId: 'session-b' }, 'session-a', undefined)).toContain('Page tab-2')
  })
})

describe('whyTabIsNotMineToClose', () => {
  it('lets a conversation close a page it opened', () => {
    expect(whyTabIsNotMineToClose({ id: 'tab-1', openedBySessionId: 'session-a' }, 'session-a')).toBeNull()
  })

  it("refuses the user's page", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-1', openedBySessionId: null }, 'session-a')

    expect(why).toContain("is the user's")
    expect(why).toContain('"tabs" lists the pages you opened')
  })

  it("refuses another conversation's page, naming it", () => {
    const why = whyTabIsNotMineToClose({ id: 'tab-3', openedBySessionId: 'session-b' }, 'session-a')

    expect(why).toContain("belongs to session-b's task")
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
