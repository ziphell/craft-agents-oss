/**
 * A fresh snapshot, with the objects the client already had kept where nothing changed.
 *
 * The list is derived, so every answer is a new array of new objects — which is right for the
 * host (it has no client state to protect) and wrong for the screen: React compares props by
 * identity, so a push that changed one work re-rendered every card in the grid. The host pushes
 * often, too: a transcript grows while a turn runs, which is a push every second or two, and a
 * grid of a hundred cards reconciles ten thousand nodes to show the same hundred pictures.
 *
 * Reusing an unchanged `Creation` makes the comparison in `React.memo` mean what it says. Nothing
 * is *hidden* by this: the snapshot's own header (`generatedAt`, `stats`) is always the fresh one
 * unless every single work matched, in which case the previous snapshot is returned unchanged and
 * a state library that compares by identity will not even notify.
 *
 * The comparison is a `JSON.stringify` of both objects, deliberately: it is total. A field-by-field
 * compare is the fast version of this and the one that goes stale when a field is added, and the
 * cost here is under a millisecond for a hundred works of the size this index produces (~0.8 KB
 * each). Key order comes from the same constructor on both sides; if it ever differs, the compare
 * simply answers "different" and the card is re-rendered — the old behaviour, never a wrong card.
 */

import type { Creation, CreationsSnapshot } from './types'

function sameCreation(a: Creation, b: Creation): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * `next`, with every work identical to the one the caller already has swapped for that instance.
 *
 * `previous` may belong to another workspace (the atom outlives a switch). Two works from different
 * workspaces cannot share a path, so the check is belt and braces rather than a correctness need —
 * but a stale list from elsewhere should never lend its objects to this one.
 */
export function mergeSnapshot(
  previous: CreationsSnapshot | null | undefined,
  next: CreationsSnapshot,
): CreationsSnapshot {
  if (!previous || previous.workspaceRootPath !== next.workspaceRootPath) return next

  const before = new Map(previous.creations.map((creation) => [creation.id, creation]))
  let reused = 0
  const creations = next.creations.map((creation) => {
    const old = before.get(creation.id)
    if (old && sameCreation(old, creation)) {
      reused++
      return old
    }
    return creation
  })

  if (reused === creations.length && reused === previous.creations.length) return previous
  return { ...next, creations }
}
