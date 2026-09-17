/**
 * The tabs of one window, cut into the groups a person reads them by.
 *
 * A tab says which **work** it is part of (`belongsTo`), and that is the whole of what is
 * known about whose tab it is — so the only grouping there is to make is by that field.
 * Two surfaces draw this list (the window's tab rail and the badge's tab list in the top
 * bar) and they must agree about it, which is why the rule lives here rather than twice in
 * JSX. A section is named where it is drawn: a conversation from the session labels, a task
 * from its own slug — the two have different sources, but only one place decides which
 * tabs go together.
 *
 * Three decisions worth naming:
 *
 * - **A task's tabs are one section**, nodes included: a DAG running four nodes in parallel
 *   is one piece of work by one task, and cutting it into four sections would read as four
 *   unrelated things in the rail. The node each tab belongs to is still on the tab itself.
 * - **A section sits where its first tab is.** Tabs keep their order, and a group
 *   appears at the position of the first tab that belongs to it, so the list still
 *   reads in the order the tabs were opened (which is the order `tabs` reports and
 *   the order the rail has always shown). Sorting "yours first" would be a second
 *   order, invented here, and a list that lies about position is worse than a list
 *   that groups.
 * - **Grouping is a view, not an owner.** Nothing here changes what a tab is or who
 *   may touch it: `belongsTo` is read, never written, and the model's rules
 *   (reach, close, the lease in `driverSessionId`) are untouched. That is the line
 *   between this and the "tab group" that would give a group an owner of its own.
 */

import type { BrowserTabSummary, TabBelongsTo } from '../../../shared/types'

/** The key of the section for tabs a person opened — nobody's work. */
const PERSON_KEY = 'person'

export interface TabGroup {
  /**
   * Identity of the section, for React keys and lookups: `person`, `session:<id>`, or
   * `task:<slug>`.
   */
  key: string
  /**
   * Whose tabs these are — one of the window's first-section tabs' own `belongsTo`, so
   * which conversation (or which task) the section is about is read off the tab rather
   * than recomputed here. `null` for the person's own tabs.
   */
  work: TabBelongsTo | null
  tabs: BrowserTabSummary[]
}

/** Which section a tab falls in — see the note above on task tabs being one section. */
function tabGroupKey(work: TabBelongsTo | null): string {
  if (!work) return PERSON_KEY
  return work.kind === 'session' ? `session:${work.sessionId}` : `task:${work.taskSlug}`
}

/**
 * Cut a window's tabs into sections, one per work, in first-appearance order.
 *
 * Never returns an empty group: a work that no tab names produces no section.
 */
export function groupTabsByWork(tabs: BrowserTabSummary[]): TabGroup[] {
  const groups: TabGroup[] = []
  const byKey = new Map<string, TabGroup>()

  for (const tab of tabs) {
    const key = tabGroupKey(tab.belongsTo)
    let group = byKey.get(key)
    if (!group) {
      group = { key, work: tab.belongsTo, tabs: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.tabs.push(tab)
  }

  return groups
}

/**
 * Whether the sections are worth drawing headers for.
 *
 * One group is every tab in the list, and a header over all of them ("you opened
 * these") says nothing while taking a row to say it — the same reason the badge
 * leaves a one-tab window's tab list out. Two or more is the answer worth having.
 */
export function shouldShowGroupHeaders(groups: TabGroup[]): boolean {
  return groups.length > 1
}
