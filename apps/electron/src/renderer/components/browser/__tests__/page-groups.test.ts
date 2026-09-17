import { describe, expect, it } from 'bun:test'
import { groupTabsByWork, shouldShowGroupHeaders } from '../page-groups'
import type { BrowserTabSummary, TabBelongsTo } from '../../../../shared/types'

function tab(id: string, belongsTo: TabBelongsTo | null): BrowserTabSummary {
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
    belongsTo,
    driverSessionId: belongsTo?.sessionId ?? null,
    cursorOf: null,
    lockedBy: null,
  }
}

/** A conversation's own work, and a DAG node's. */
const session = (sessionId: string): TabBelongsTo => ({ kind: 'session', sessionId })
const node = (taskSlug: string, nodeId: string, sessionId: string): TabBelongsTo => ({
  kind: 'task',
  taskSlug,
  runId: 'r1',
  nodeId,
  sessionId,
})

describe('groupTabsByWork', () => {
  // A section appears where its first page is, and pages keep their order inside it:
  // the list still reads in the order the pages were opened, which is what `tabs`
  // reports and what the rail showed before it grouped anything.
  it('sections in first-appearance order, pages in their own order', () => {
    const groups = groupTabsByWork([tab('a', null), tab('b', session('session-1')), tab('c', null)])

    expect(groups.map((group) => group.work)).toEqual([null, session('session-1')])
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b'])
  })

  // A page nobody's conversation asked for is a person's page, and that is a group like
  // any other — it is not the "default" the others are escaped from.
  it('puts pages a person opened in their own group, wherever they sit', () => {
    const groups = groupTabsByWork([tab('a', session('session-1')), tab('b', null)])

    expect(groups.map((group) => group.work)).toEqual([session('session-1'), null])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b'])
  })

  // One task is one section, its nodes included: a DAG running four nodes in parallel is one
  // piece of work, and four sections would read as four unrelated things in the rail — which
  // is exactly what a person reading a board expects *not* to see (plan §22).
  it('keeps a task\'s nodes in one section, under the task', () => {
    const groups = groupTabsByWork([
      tab('a', node('checkout-flow', 'cart', 'child-1')),
      tab('b', node('checkout-flow', 'pay', 'child-2')),
      tab('c', node('other-task', 'report', 'child-3')),
    ])

    expect(groups.map((group) => group.key)).toEqual(['task:checkout-flow', 'task:other-task'])
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('does not invent a section for a work no page names', () => {
    expect(groupTabsByWork([])).toEqual([])
    expect(groupTabsByWork([tab('a', session('session-2'))])).toEqual([
      { key: 'session:session-2', work: session('session-2'), tabs: [expect.objectContaining({ id: 'a' })] },
    ])
  })
})

describe('shouldShowGroupHeaders', () => {
  // One group is the whole list: "you opened these" over all of it is a row that says
  // nothing. Two is the answer worth having — whose pages are whose.
  it('is true only when there is more than one group', () => {
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', null), tab('b', null)]))).toBe(false)
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', null), tab('b', session('session-1'))]))).toBe(true)
    expect(shouldShowGroupHeaders(groupTabsByWork([]))).toBe(false)
  })
})
