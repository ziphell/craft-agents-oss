/**
 * How to travel from where the reader is to the newest content.
 *
 * Kept pure — and out of `ChatDisplay.tsx` — so the rule can be tested without
 * React or a real scroller. `ChatDisplay.tsx` imports it; do not duplicate the
 * logic there.
 *
 * The rule exists because "scroll to the bottom" is two different actions that
 * used to look like one:
 *
 * - **following** — a streaming line, a new bubble, a code block that finished
 *   highlighting. The reader is already watching the end of the conversation,
 *   the new content lands just below them, and animating it is what makes the
 *   conversation feel alive;
 * - **relocating** — opening a conversation, or content that resolved its
 *   height long after the panel opened (images, diagrams, syntax highlighting
 *   for every block at once). The end of the transcript is thousands of pixels
 *   away, and animating *that* is a several-hundred-millisecond blur through
 *   the entire history: it reads as "the app scrolls itself from the first
 *   message to the last" instead of "it opened where I expect".
 *
 * A jump longer than the viewport is therefore never animated: it is not motion
 * anyone can follow, it is a relocation. Nothing here decides *whether* to
 * follow — that is the sticky-bottom flag; this only decides how.
 */

/** Which `ScrollBehavior` the follow should use. */
export type FollowBehavior = 'instant' | 'smooth'

export interface FollowContext {
  /** Pixels between the current position and the newest content (may be ≤ 0). */
  distance: number
  /** Height of the scroll viewport, in pixels. */
  viewportHeight: number
  /** Current time on the same clock as `quietUntil` — `Date.now()`. */
  now: number
  /**
   * Until this instant, motion is suppressed: the panel has just opened (or a
   * session switch already jumped), and anything that resolves afterwards
   * belongs to the same open, not to a new message.
   */
  quietUntil: number
}

/**
 * Is the newest content further away than the reader can see?
 *
 * That is the case worth reacting to *immediately*, without waiting out the
 * debounce meant for settling increments: it is the transcript arriving (the
 * turn window mounting, a wall of highlighting, images resolving), not a
 * message growing a line.
 */
export function isRelocation(distance: number, viewportHeight: number): boolean {
  return distance > viewportHeight
}

export function chooseFollowBehavior({
  distance,
  viewportHeight,
  now,
  quietUntil,
}: FollowContext): FollowBehavior {
  // Already at (or past) the end: nothing to animate, and asking the scroller
  // for a smooth scroll of 0px leaves a pending animation that the next
  // appended block then hijacks.
  if (distance <= 0) return 'instant'
  // The panel is still settling from its own open.
  if (now < quietUntil) return 'instant'
  // Further away than the reader can see: a relocation, not a follow.
  if (isRelocation(distance, viewportHeight)) return 'instant'
  return 'smooth'
}
