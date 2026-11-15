/**
 * The files one node has shown.
 *
 * A node points at one file (`src`); this is the chain behind it — every result the node produced,
 * newest first. Nothing is deleted: switching moves `src` to another entry, so a run is never lost
 * to the next one. Capped because a canvas is a file, and a node is not an archive.
 */

const LIMIT = 24

export function nextVersions(options: {
  previous?: string[]
  /** The file the node points at before this run. */
  current?: string
  /** The file this run produced. */
  added: string
  limit?: number
}): string[] {
  const limit = options.limit ?? LIMIT
  const all = [options.added, options.current, ...(options.previous ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return [...new Set(all)].slice(0, limit)
}
