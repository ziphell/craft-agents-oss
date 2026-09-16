import { describe, expect, it } from 'bun:test'
import { whyTabIsLocked, whyTabIsNotMineToClose, whyTabIsOutOfReach } from '../tab-access'

const prototype = { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' }

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

    expect(why).toContain('was opened by session-b')
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
