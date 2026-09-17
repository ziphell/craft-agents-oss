import { describe, expect, it } from 'bun:test'
import { groupTabsByWork, shouldShowGroupHeaders } from '../tab-groups'
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
  // Every section but the person's appears where its first tab is, and tabs keep their order
  // inside it: those sections still read in the order the tabs were opened.
  it('sections in first-appearance order, tabs in their own order', () => {
    const groups = groupTabsByWork([
      tab('a', null),
      tab('b', session('session-1')),
      tab('c', null),
      tab('d', session('session-2')),
    ])

    expect(groups.map((group) => group.work)).toEqual([null, session('session-1'), session('session-2')])
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b'])
    expect(groups[2].tabs.map((t) => t.id)).toEqual(['d'])
  })

  // A tab nobody's conversation asked for is a person's tab, and that is a group like
  // any other — it is not the "default" the others are escaped from. It is the one section
  // that is *pinned*, though: a window reads as yours first whatever order it was opened in.
  it('pins tabs a person opened to the top, wherever they sit', () => {
    const groups = groupTabsByWork([tab('a', session('session-1')), tab('b', null)])

    expect(groups.map((group) => group.work)).toEqual([null, session('session-1')])
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['b'])
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['a'])
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

  it('does not invent a section for a work no tab names', () => {
    expect(groupTabsByWork([])).toEqual([])
    expect(groupTabsByWork([tab('a', session('session-2'))])).toEqual([
      { key: 'session:session-2', work: session('session-2'), tabs: [expect.objectContaining({ id: 'a' })] },
    ])
  })
})

describe('shouldShowGroupHeaders', () => {
  // More than one section is where a header earns its row — it is what tells the sections
  // apart. A single section of the person's own tabs is the whole list, and "you opened
  // these" over all of it says nothing. A single section that is an agent's is the opposite:
  // the rows cannot say whose tabs they are, and the header is also where that section's `+`
  // lives, so it keeps its header.
  it('is true for more than one group, and for one group that is somebody\'s work', () => {
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', null), tab('b', null)]))).toBe(false)
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', session('session-1'))]))).toBe(true)
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', node('checkout-flow', 'cart', 'child-1'))]))).toBe(true)
    expect(shouldShowGroupHeaders(groupTabsByWork([tab('a', null), tab('b', session('session-1'))]))).toBe(true)
    expect(shouldShowGroupHeaders(groupTabsByWork([]))).toBe(false)
  })
})
