/**
 * Who may touch which tab of the workspace's browser window.
 *
 * Two rules, and they are different rules — which is why they are two functions
 * rather than one "can I use this" predicate:
 *
 * - **In reach**: may this conversation work here at all? A tab says which **work** it
 *   is part of (`belongsTo`), and the same work is the only thing that may work in it.
 *   A tab that belongs to **nobody's work** is open to whoever the person is talking to —
 *   see {@link whyTabIsOutOfReach}. Another conversation's tab is a wall, not a queue.
 * - **Mine to close**: closing is housekeeping, and housekeeping is the whole **task**'s —
 *   a node's tab, a node that was re-run and left one behind, and the orchestrator's own
 *   are all the same task's to clean up, while the user's tabs and another task's are not.
 *
 * The difference is deliberate: reach is precise (the same node of the same run) and close
 * is loose (the same task, whatever node). A conversation that is allowed to *work* in a
 * tab must not be the only one allowed to tidy it away, or a finished DAG's tabs stay in
 * the window forever — nobody who opened them is still running.
 *
 * Both are here rather than inline in the pane manager because the manager knows
 * windows and tabs but not conversations' task identity, and here rather than
 * inline in `SessionManager` because these are the rules the tool layer is judged on and
 * they deserve to be readable and tested on their own. They return the *reason* rather
 * than a boolean: the answer is always "no, because …", and the agent reads it.
 */

import { sameTask, sameWork, type BrowserTabSummary, type TabBelongsTo } from '@craft-agent/shared/protocol'

/** The part of a tab the reach rule reads. */
type ReachableTab = Pick<BrowserTabSummary, 'id' | 'belongsTo'>

/**
 * A tab's work in words, for a refusal that has to say whose tab it is.
 *
 * Never a bare session id for a task tab: a DAG's tabs are named by their task and node,
 * and the session that opened one is provenance — often a session that has already stopped.
 * Only ever asked about a tab that **has** work — every tab without it is in reach
 * ({@link whyTabIsOutOfReach}) — so there is no wording here for a tab that is nobody's.
 */
function whosePage(work: TabBelongsTo): string {
  if (work.kind === 'task') {
    return work.nodeId
      ? `the tab task ${work.taskSlug} opened for its node ${work.nodeId}`
      : `the tab task ${work.taskSlug} opened for itself`
  }
  return `${work.sessionId}'s task`
}

/**
 * Why this conversation may not act on this tab, or `null` when it may.
 *
 * Two ways a tab is in reach:
 *
 * - it is **this conversation's work** — the same conversation, or the same node of the same
 *   run of the same task. It opened the tab, the tab was assigned to it (`tab-assign`), or
 *   the tab was opened from one of its tabs;
 * - it is **nobody's work yet**: no `belongsTo`. A tab the person opened is one of these, and
 *   working in it is how "you open it, the agent carries on" works.
 *
 * Anything else belongs to another conversation or to another node of my own task, and that
 * is a wall: nodes of one DAG do not share tabs, because each of them working in its own is
 * what makes them parallel instead of interfering. A node that is **re-run** is the same work
 * as its predecessor (same node, same run), so it takes over the tab that was left rather
 * than opening a second one — and the tab stops being an orphan.
 *
 * **A cursor is not a claim**. This rule used to refuse a tab because
 * another conversation worked from it (`cursorOf`), and that made the person's own tab out of
 * reach for the conversation they had just handed it to: "you open it, the agent carries on"
 * worked once, and from then on the tab was somebody else's — for as long as that conversation
 * existed, which the person cannot see and cannot end. A cursor says where *that* conversation's
 * unnamed commands go; it says nothing about who else may work here. Whatever that conversation
 * was set up to do is not lost by another one working in the same tab: each keeps its own cursor,
 * and what keeps two of them out of the tab **at the same moment** is the hold
 * ({@link whyTabIsLocked}) — a wait, not a wall, and one that ends with its turn.
 *
 * The one tab this cannot give away is a tab that **is** somebody's work: another conversation's
 * tab, a task's node's tab. There the work is the wall, and it stays one.
 */
export function whyTabIsOutOfReach(
  tab: ReachableTab,
  me: TabBelongsTo,
): string | null {
  if (sameWork(tab.belongsTo, me)) return null
  if (tab.belongsTo === null) return null

  return (
    `Tab ${tab.id} is ${whosePage(tab.belongsTo)}, not yours. Work on a tab of your own — "tab-new" opens one, ` +
    `and a parent conversation can hand you one with "tab-assign <id> <session>" — then name it with ` +
    `"--tab <id>" ("tabs" lists them).`
  )
}

/**
 * Which tab a command from this conversation means, when it names none.
 *
 * The conversation's **own tab first** — the one it has been working from, its cursor
 * (`cursorOf`) — and only then the tab on screen. The order is the whole point of the
 * cursor: what the person is looking at is theirs to change at any
 * moment, and it must not move somebody else's command. The other way round is what made
 * "the user switched tabs" silently retarget a conversation's work — and it is why the
 * window model (one window or one per conversation) does not matter here: any window
 * with several tabs has this problem.
 *
 * Falling back to the tab on screen is not a compromise, it is the takeover case: a
 * conversation with no tab of its own acting on what the person has in front of them.
 *
 * The cursor is sticky across turns, unlike the driven-by mark: a conversation that comes
 * back after its turn ended is still working from the same tab. `null` only when the
 * window has no tabs at all.
 */
export function pickCommandTarget<T extends Pick<BrowserTabSummary, 'id' | 'cursorOf' | 'active'>>(
  tabs: T[],
  sessionId: string,
): { tab: T; because: 'cursor' | 'on-screen' } | null {
  const ownPage = tabs.find((tab) => tab.cursorOf.includes(sessionId))
  if (ownPage) return { tab: ownPage, because: 'cursor' }

  const onScreen = tabs.find((tab) => tab.active)
  return onScreen ? { tab: onScreen, because: 'on-screen' } : null
}

/**
 * Why this tab is not available to this conversation *at the moment*, or `null` when it is.
 *
 * A tab is locked while the conversation that claimed it is still working on it: the hold
 * (`lockedBy`), taken when a command lands on the tab while that session's
 * overlay is up and let go when its turn ends. A different question from reach, and the
 * difference is the clock: reach asks "is this tab your business at all", the lock asks "is
 * it free *right now*". So the answer here is "wait", not "never", and that is what it says.
 *
 * The conversation holding the lock is never locked out of its own tab: `lockedBy === sid`
 * is the one case that returns `null` immediately. A re-run of a node is a different session,
 * so a tab its predecessor is still holding says "wait" — which is right: that turn has to
 * end before the replacement takes the tab over.
 */
export function whyTabIsLocked(
  tab: Pick<BrowserTabSummary, 'id' | 'lockedBy'>,
  sessionId: string,
): string | null {
  if (!tab.lockedBy || tab.lockedBy === sessionId) return null

  return (
    `Tab ${tab.id} is locked while ${tab.lockedBy} works on it: a person cannot click or type ` +
    `there, and neither can this conversation, until that turn ends. Work on another tab ` +
    `("tabs" lists them), or wait for it to be released.`
  )
}

/**
 * Why this tab is not this conversation's to close, or `null` when it is.
 *
 * The task, not the node (see the note at the top): the orchestrator never opened its nodes'
 * tabs, so it is not told it has no business closing them — a finished run has to be
 * cleanable by the conversation that ran it. The user's tabs stay the user's, and another
 * task's tabs stay that task's.
 */
export function whyTabIsNotMineToClose(
  tab: Pick<BrowserTabSummary, 'id' | 'belongsTo'>,
  me: TabBelongsTo,
): string | null {
  if (sameWork(tab.belongsTo, me) || sameTask(tab.belongsTo, me)) return null

  if (!tab.belongsTo) {
    return `Tab ${tab.id} is the user's, so it is not yours to close. "tabs" lists the tabs you opened.`
  }
  if (tab.belongsTo.kind === 'task') {
    return (
      `Tab ${tab.id} belongs to the task ${tab.belongsTo.taskSlug}, which is not the task this ` +
      `conversation is working on, so it is not yours to close. "tabs" lists the tabs you opened.`
    )
  }
  return (
    `Tab ${tab.id} belongs to ${tab.belongsTo.sessionId}'s task, not to this conversation's, ` +
    `so it is not yours to close. "tabs" lists the tabs you opened.`
  )
}
