/**
 * Who may touch which page of the workspace's browser window (plan §22).
 *
 * Two rules, and they are different rules — which is why they are two functions
 * rather than one "can I use this" predicate:
 *
 * - **In reach**: may this conversation work here at all? A page carries the
 *   prototype it is for, and a conversation works on one prototype, so together
 *   they answer it. Acting on another conversation's prototype is refused.
 * - **Mine to close**: closing is housekeeping, and housekeeping is only the pages
 *   *this* conversation opened. The user's pages, and another conversation's, are
 *   not ours to close.
 *
 * Both are here rather than inline in the pane manager because the manager knows
 * windows and pages but not conversations (plan §22), and here rather than inline in
 * `SessionManager` because these are the rules the tool layer is judged on and they
 * deserve to be readable and tested on their own. They return the *reason* rather
 * than a boolean: the answer is always "no, because …", and the agent reads it.
 */

import type { BrowserTabSummary } from '@craft-agent/shared/protocol'

/** The part of a page the reach rule reads. */
type ReachableTab = Pick<BrowserTabSummary, 'id' | 'prototype' | 'openedBySessionId'>

/**
 * Why this conversation may not act on this page, or `null` when it may.
 *
 * Three ways a page is in reach:
 *
 * - it belongs to no prototype — an ordinary page, anybody's to use, which is what
 *   makes "you open it, the agent takes over" work for a page that has nothing to do
 *   with prototypes;
 * - it belongs to the prototype this conversation works on;
 * - this conversation opened it — an explicit `prototype-open <slug>` from a
 *   conversation that is not bound to it still gets to work on what it opened.
 */
export function whyTabIsOutOfReach(
  tab: ReachableTab,
  sessionId: string,
  ownPrototypeSlug: string | undefined,
): string | null {
  if (!tab.prototype) return null
  if (tab.openedBySessionId === sessionId) return null
  if (ownPrototypeSlug && ownPrototypeSlug === tab.prototype.slug) return null

  return (
    `Page ${tab.id} is "${tab.prototype.slug}"'s, and this conversation works on ` +
    `${ownPrototypeSlug ? `"${ownPrototypeSlug}"` : 'no prototype'}. Name a page of your own with ` +
    `"--tab <id>" ("tabs" lists them), or work on this one with "prototype-bind ${tab.prototype.slug}".`
  )
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
 * is the one case that returns `null` immediately.
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
 * Nothing about reach helps here: a page of *my* prototype that another
 * conversation opened is still that conversation's page, and closing it would take
 * away work somebody else was doing.
 */
export function whyTabIsNotMineToClose(
  tab: Pick<BrowserTabSummary, 'id' | 'openedBySessionId'>,
  sessionId: string,
): string | null {
  if (tab.openedBySessionId === sessionId) return null

  return tab.openedBySessionId
    ? `Page ${tab.id} was opened by ${tab.openedBySessionId}, not by this conversation, so it is not yours to close. "tabs" lists the pages you opened.`
    : `Page ${tab.id} is the user's, so it is not yours to close. "tabs" lists the pages you opened.`
}
