import { describe, expect, it } from 'bun:test'
import { groupTabsByOpener, shouldShowGroupHeaders } from '../page-groups'
import type { BrowserTabSummary } from '../../../../shared/types'

function tab(id: string, openedBySessionId: string | null): BrowserTabSummary {
  return {
    id,
    url: `https://${id}.example.com/`,
    title: id,
    favicon: null,
    isLoading: false,
    active: false,
    prototype: null,
    prototypePage: null,
    disposition: null,
    openedBySessionId,
    driverSessionId: openedBySessionId,
    cursorOf: null,
    lockedBy: null,
  }
}

describe('groupTabsByOpener', () => {
  // A section appears where its first page is, and pages keep their order inside it:
  // the list still reads in the order the pages were opened, which is what `tabs`
  // reports and what the rail showed before it grouped anything.
  it('sections in first-appearance order, pages in their own order', () => {
    const groups = groupTabsByOpener([tab('a', null), tab('b', 'session-1'), tab('c', null)])

    expect(groups.map((group) => group.sessionId)).toEqual([null, 'session-1'])
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b'])
  })

  // A page nobody's session asked for is a person's page, and that is a group like
  // any other — it is not the "default" the others are escaped from.
  it('puts pages a person opened in their own group, wherever they sit', () => {
    const groups = groupTabsByOpener([tab('a', 'session-1'), tab('b', null)])

    expect(groups.map((group) => group.sessionId)).toEqual(['session-1', null])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b'])
  })

  it('does not invent a section for an opener no page names', () => {
    expect(groupTabsByOpener([])).toEqual([])
    expect(groupTabsByOpener([tab('a', 'session-2')])).toEqual([
      { sessionId: 'session-2', tabs: [expect.objectContaining({ id: 'a' })] },
    ])
  })
})

describe('shouldShowGroupHeaders', () => {
  // One group is the whole list: "you opened these" over all of it is a row that says
  // nothing. Two is the answer worth having — whose pages are whose.
  it('is true only when there is more than one group', () => {
    expect(shouldShowGroupHeaders(groupTabsByOpener([tab('a', null), tab('b', null)]))).toBe(false)
    expect(shouldShowGroupHeaders(groupTabsByOpener([tab('a', null), tab('b', 'session-1')]))).toBe(true)
    expect(shouldShowGroupHeaders(groupTabsByOpener([]))).toBe(false)
  })
})
