/**
 * The pages of one window, cut into the groups a person reads them by.
 *
 * A page says which **work** it is part of (`belongsTo`), and that is the whole of what is
 * known about whose page it is — so the only grouping there is to make is by that field.
 * Two surfaces draw this list (the window's page rail and the badge's page list in the top
 * bar) and they must agree about it, which is why the rule lives here rather than twice in
 * JSX. A section is named where it is drawn: a conversation from the session labels, a task
 * from its own slug — the two have different sources, but only one place decides which
 * pages go together.
 *
 * Three decisions worth naming:
 *
 * - **A task's pages are one section**, nodes included: a DAG running four nodes in parallel
 *   is one piece of work by one task, and cutting it into four sections would read as four
 *   unrelated things in the rail. The node each page belongs to is still on the page itself.
 * - **A section sits where its first page is.** Pages keep their order, and a group
 *   appears at the position of the first page that belongs to it, so the list still
 *   reads in the order the pages were opened (which is the order `tabs` reports and
 *   the order the rail has always shown). Sorting "yours first" would be a second
 *   order, invented here, and a list that lies about position is worse than a list
 *   that groups.
 * - **Grouping is a view, not an owner.** Nothing here changes what a page is or who
 *   may touch it: `belongsTo` is read, never written, and the model's rules
 *   (reach, close, the lease in `driverSessionId`) are untouched. That is the line
 *   between this and the "tab group" that would give a group an owner of its own.
 */

import type { BrowserTabSummary, TabBelongsTo } from '../../../shared/types'

/** The key of the section for pages a person opened — nobody's work. */
const PERSON_KEY = 'person'

export interface PageGroup {
  /**
   * Identity of the section, for React keys and lookups: `person`, `session:<id>`, or
   * `task:<slug>`.
   */
  key: string
  /**
   * Whose pages these are — one of the window's first-section pages' own `belongsTo`, so
   * which conversation (or which task) the section is about is read off the page rather
   * than recomputed here. `null` for the person's own pages.
   */
  work: TabBelongsTo | null
  tabs: BrowserTabSummary[]
}

/** Which section a page falls in — see the note above on task pages being one section. */
function pageGroupKey(work: TabBelongsTo | null): string {
  if (!work) return PERSON_KEY
  return work.kind === 'session' ? `session:${work.sessionId}` : `task:${work.taskSlug}`
}

/**
 * Cut a window's pages into sections, one per work, in first-appearance order.
 *
 * Never returns an empty group: a work that no page names produces no section.
 */
export function groupTabsByWork(tabs: BrowserTabSummary[]): PageGroup[] {
  const groups: PageGroup[] = []
  const byKey = new Map<string, PageGroup>()

  for (const tab of tabs) {
    const key = pageGroupKey(tab.belongsTo)
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
 * One group is every page in the list, and a header over all of them ("you opened
 * these") says nothing while taking a row to say it — the same reason the badge
 * leaves a one-page window's page list out. Two or more is the answer worth having.
 */
export function shouldShowGroupHeaders(groups: PageGroup[]): boolean {
  return groups.length > 1
}
