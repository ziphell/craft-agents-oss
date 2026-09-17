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
 * *Which* section a tab falls in is `tabSectionOf` in the protocol rather than a rule of this
 * file, because it is not only the lists that need it: the window reads the same thing when a
 * tab closes — the tab that takes over is a neighbour in the closed tab's own section when that
 * section has one left (`closeTab` on the host). One definition, so the handover follows what
 * the rail drew and not a second opinion about it.
 *
 * Three decisions worth naming:
 *
 * - **A task's tabs are one section**, nodes included: a DAG running four nodes in parallel
 *   is one piece of work by one task, and cutting it into four sections would read as four
 *   unrelated things in the rail. The node each tab belongs to is still on the tab itself.
 * - **The person's own section is pinned first; every other section sits where its first
 *   tab is.** A window is read as "what I am looking at" before it is read as "what somebody
 *   else is doing in it", and which of those two comes first should not depend on the order
 *   tabs happened to be opened in. The rest keep first-appearance order — a section appears
 *   at the position of its first tab — so only this one section moves, and the tabs inside
 *   every section still read in the order `tabs` reports.
 * - **Grouping is a view, not an owner.** Nothing here changes what a tab is or who
 *   may touch it: `belongsTo` is read, never written, and the model's rules
 *   (reach, close, the lease in `driverSessionId`) are untouched. That is the line
 *   between this and the "tab group" that would give a group an owner of its own.
 */

import {
  PERSON_TAB_SECTION,
  tabSectionOf,
  type BrowserTabSummary,
  type TabBelongsTo,
} from '../../../shared/types'

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

/**
 * Cut a window's tabs into sections, one per work, the person's own section first.
 *
 * Never returns an empty group: a work that no tab names produces no section.
 */
export function groupTabsByWork(tabs: BrowserTabSummary[]): TabGroup[] {
  const groups: TabGroup[] = []
  const byKey = new Map<string, TabGroup>()

  for (const tab of tabs) {
    const key = tabSectionOf(tab.belongsTo)
    let group = byKey.get(key)
    if (!group) {
      group = { key, work: tab.belongsTo, tabs: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.tabs.push(tab)
  }

  // The person's section moves to the front, and nothing else does: the sections somebody
  // else is working in are what a person looks *past* their own tabs for, and which of the
  // two comes first is not something the order tabs were opened in should decide (see the
  // note at the top). Only the sections after it are in first-appearance order.
  const person = groups.findIndex((group) => group.key === PERSON_TAB_SECTION)
  if (person > 0) groups.unshift(...groups.splice(person, 1))

  return groups
}

/**
 * Whether the sections are worth drawing headers for.
 *
 * More than one, so the header is what tells the sections apart — and **one section that is
 * somebody's work**, because then it is saying something the rows cannot: *whose* tabs these
 * are. The person's own section is the one case a header can say nothing about ("you opened
 * these" over all of them), and the one that needs it least: nobody's tabs are what a window
 * reads as by default.
 *
 * The single agent section is also the case that has to keep its header for another reason:
 * the header is where its `+` lives, and a window holding only a conversation's tabs is
 * exactly where somebody would want to open one more for it (plan §22).
 */
export function shouldShowGroupHeaders(groups: TabGroup[]): boolean {
  if (groups.length > 1) return true
  return groups.length === 1 && groups[0].work !== null
}
