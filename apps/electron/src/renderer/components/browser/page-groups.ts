/**
 * The pages of one window, cut into the groups a person reads them by.
 *
 * A page says who opened it as a **session id** (`openedBySessionId`), and that is
 * the whole of what is known about ownership — so the only grouping there is to
 * make is by that field. Two surfaces draw this list (the window's page rail and
 * the badge's page list in the top bar) and they must agree about it, which is why
 * the rule lives here rather than twice in JSX.
 *
 * Two decisions worth naming:
 *
 * - **A section sits where its first page is.** Pages keep their order, and a group
 *   appears at the position of the first page that belongs to it, so the list still
 *   reads in the order the pages were opened (which is the order `tabs` reports and
 *   the order the rail has always shown). Sorting "yours first" would be a second
 *   order, invented here, and a list that lies about position is worse than a list
 *   that groups.
 * - **Grouping is a view, not an owner.** Nothing here changes what a page is or who
 *   may touch it: `openedBySessionId` is read, never written, and the model's rules
 *   (reach, close, the lease in `driverSessionId`) are untouched. That is the line
 *   between this and the "tab group" that would give a group an owner of its own.
 */

import type { BrowserTabSummary } from '../../../shared/types'

export interface PageGroup {
  /**
   * The conversation that opened these pages, or `null` for pages a person opened
   * (nobody's session asked for them — which is also what an agent-less page says).
   */
  sessionId: string | null
  tabs: BrowserTabSummary[]
}

/**
 * Cut a window's pages into sections, one per opener, in first-appearance order.
 *
 * Never returns an empty group: an opener that no page names produces no section.
 */
export function groupTabsByOpener(tabs: BrowserTabSummary[]): PageGroup[] {
  const groups: PageGroup[] = []
  const bySession = new Map<string | null, PageGroup>()

  for (const tab of tabs) {
    const sessionId = tab.openedBySessionId
    let group = bySession.get(sessionId)
    if (!group) {
      group = { sessionId, tabs: [] }
      bySession.set(sessionId, group)
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
