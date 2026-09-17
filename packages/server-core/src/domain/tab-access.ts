/**
 * Who may touch which page of the workspace's browser window (plan §22).
 *
 * Two rules, and they are different rules — which is why they are two functions
 * rather than one "can I use this" predicate:
 *
 * - **In reach**: may this conversation work here at all? A page says which **work** it
 *   is part of (`belongsTo`), and the same work is the only thing that may work in it.
 *   Another conversation's page is a wall, not a queue.
 * - **Mine to close**: closing is housekeeping, and housekeeping is the whole **task**'s —
 *   a node's page, a node that was re-run and left one behind, and the orchestrator's own
 *   are all the same task's to clean up, while the user's pages and another task's are not.
 *
 * The difference is deliberate: reach is precise (the same node of the same run) and close
 * is loose (the same task, whatever node). A conversation that is allowed to *work* in a
 * page must not be the only one allowed to tidy it away, or a finished DAG's pages stay in
 * the window forever — nobody who opened them is still running.
 *
 * Both are here rather than inline in the pane manager because the manager knows
 * windows and pages but not conversations' task identity (plan §22), and here rather than
 * inline in `SessionManager` because these are the rules the tool layer is judged on and
 * they deserve to be readable and tested on their own. They return the *reason* rather
 * than a boolean: the answer is always "no, because …", and the agent reads it.
 */

import { sameTask, sameWork, type BrowserTabSummary, type TabBelongsTo } from '@craft-agent/shared/protocol'

/** The part of a page the reach rule reads. */
type ReachableTab = Pick<BrowserTabSummary, 'id' | 'belongsTo' | 'cursorOf'>

/**
 * A page's work in words, for a refusal that has to say whose page it is.
 *
 * Never a bare session id for a task page: a DAG's pages are named by their task and node,
 * and the session that opened one is provenance — often a session that has already stopped.
 */
function whosePage(tab: ReachableTab): string {
  const work = tab.belongsTo
  if (work?.kind === 'task') {
    return work.nodeId
      ? `the page task ${work.taskSlug} opened for its node ${work.nodeId}`
      : `the page task ${work.taskSlug} opened for itself`
  }
  if (work) return `${work.sessionId}'s task`
  return `${tab.cursorOf}'s to work from`
}

/**
 * Why this conversation may not act on this page, or `null` when it may.
 *
 * Two ways a page is in reach (plan §22):
 *
 * - it is **this conversation's work** — the same conversation, or the same node of the same
 *   run of the same task. It opened the page, the page was assigned to it (`tab-assign`), or
 *   the page was opened from one of its pages;
 * - it is **nobody's yet**: no work, and no conversation working from it. A page the person
 *   opened is one of these, and taking it over is how "you open it, the agent carries on"
 *   works — for ordinary pages and for a prototype's alike.
 *
 * Anything else belongs to another conversation or to another node of my own task, and that
 * is a wall: nodes of one DAG do not share pages, because each of them working in its own is
 * what makes them parallel instead of interfering. A node that is **re-run** is the same work
 * as its predecessor (same node, same run), so it takes over the page that was left rather
 * than opening a second one — and the page stops being an orphan.
 *
 * The clock is separate: a page nobody's yet can still be **held** for the moment
 * ({@link whyTabIsLocked}) — own it, or take it while it is free.
 */
export function whyTabIsOutOfReach(
  tab: ReachableTab,
  me: TabBelongsTo,
): string | null {
  if (sameWork(tab.belongsTo, me)) return null
  if (tab.belongsTo === null && tab.cursorOf === null) return null

  return (
    `Page ${tab.id} is ${whosePage(tab)}, not yours. Work on a page of your own — "tab-new" opens one, ` +
    `and a parent conversation can hand you one with "tab-assign <id> <session>" — then name it with ` +
    `"--tab <id>" ("tabs" lists them).`
  )
}

/**
 * Which page a command from this conversation means, when it names none.
 *
 * The conversation's **own page first** — the one it has been working from, its cursor
 * (`cursorOf`) — and only then the page on screen. The order is the whole point of the
 * cursor (plan §22, 第十轮): what the person is looking at is theirs to change at any
 * moment, and it must not move somebody else's command. The other way round is what made
 * "the user switched pages" silently retarget a conversation's work — and it is why the
 * window model (one window or one per conversation) does not matter here: any window
 * with several pages has this problem.
 *
 * Falling back to the page on screen is not a compromise, it is the takeover case: a
 * conversation with no page of its own acting on what the person has in front of them
 * (plan §22's opening move, "you open it, the agent takes over").
 *
 * The cursor is sticky across turns, unlike the lease: a conversation that comes back
 * after its turn ended is still working from the same page. `null` only when the window
 * has no pages at all.
 */
export function pickCommandTarget<T extends Pick<BrowserTabSummary, 'id' | 'cursorOf' | 'active'>>(
  tabs: T[],
  sessionId: string,
): { tab: T; because: 'cursor' | 'on-screen' } | null {
  const ownPage = tabs.find((tab) => tab.cursorOf === sessionId)
  if (ownPage) return { tab: ownPage, because: 'cursor' }

  const onScreen = tabs.find((tab) => tab.active)
  return onScreen ? { tab: onScreen, because: 'on-screen' } : null
}

/**
 * Why this page is not available to this conversation *at the moment*, or `null` when it is.
 *
 * A page is locked while the conversation working on it has its overlay up: the lease on
 * that page (`driverSessionId`) plus the window's engaged state, which the page reports as
 * `lockedBy` (plan §22, 第九轮). A different question from reach, and the difference is the
 * clock: reach asks "is this page your business at all", the lock asks "is it free *right
 * now*". So the answer here is "wait", not "never", and that is what it says.
 *
 * The conversation holding the lock is never locked out of its own page: `lockedBy === sid`
 * is the one case that returns `null` immediately. A re-run of a node is a different session,
 * so a page its predecessor is still holding says "wait" — which is right: that turn has to
 * end before the replacement takes the page over.
 */
export function whyTabIsLocked(
  tab: Pick<BrowserTabSummary, 'id' | 'lockedBy'>,
  sessionId: string,
): string | null {
  if (!tab.lockedBy || tab.lockedBy === sessionId) return null

  return (
    `Page ${tab.id} is locked while ${tab.lockedBy} works on it: a person cannot click or type ` +
    `there, and neither can this conversation, until that turn ends. Work on another page ` +
    `("tabs" lists them), or wait for it to be released.`
  )
}

/**
 * Why this page is not this conversation's to close, or `null` when it is.
 *
 * The task, not the node (see the note at the top): the orchestrator never opened its nodes'
 * pages, so it is not told it has no business closing them — a finished run has to be
 * cleanable by the conversation that ran it. The user's pages stay the user's, and another
 * task's pages stay that task's.
 */
export function whyTabIsNotMineToClose(
  tab: Pick<BrowserTabSummary, 'id' | 'belongsTo'>,
  me: TabBelongsTo,
): string | null {
  if (sameWork(tab.belongsTo, me) || sameTask(tab.belongsTo, me)) return null

  if (!tab.belongsTo) {
    return `Page ${tab.id} is the user's, so it is not yours to close. "tabs" lists the pages you opened.`
  }
  if (tab.belongsTo.kind === 'task') {
    return (
      `Page ${tab.id} belongs to the task ${tab.belongsTo.taskSlug}, which is not the task this ` +
      `conversation is working on, so it is not yours to close. "tabs" lists the pages you opened.`
    )
  }
  return (
    `Page ${tab.id} belongs to ${tab.belongsTo.sessionId}'s task, not to this conversation's, ` +
    `so it is not yours to close. "tabs" lists the pages you opened.`
  )
}
