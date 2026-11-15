/**
 * The lineage, read off the notes rather than stored as a graph.
 *
 * There is no edges file and nothing to keep in step: a record names what it was built from, so
 * "what came before this" is that record's `references`, and "what came after this" is every record
 * that names this file. Delete one note and the graph loses exactly one edge — which is the truth.
 *
 * Pure, so the panel and any future tool answer the same question the same way.
 */

import type { GenerationRecord } from './types.ts'
import { toPosix } from './paths.ts'

/** Newest first. Ties are broken by name so the order never flickers between reads. */
export function newestFirst(records: GenerationRecord[]): GenerationRecord[] {
  return [...records].sort((a, b) => (b.at - a.at) || a.file.localeCompare(b.file))
}

/** The note about this file, if this file was generated. */
export function generationOf(records: readonly GenerationRecord[], file: string): GenerationRecord | null {
  const wanted = toPosix(file)
  return records.find((record) => toPosix(record.file) === wanted) ?? null
}

/**
 * The rows whose own facts mention this text — the prompt, the file's path, the channel, the model.
 *
 * One substring, case-insensitive, against what a row already shows. Results keep the order they
 * came in, because that order is the timeline's and searching must not reorder history. An empty
 * query is not a filter: it is the timeline, untouched.
 */
export function searchGenerations(records: GenerationRecord[], query: string): GenerationRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return records
  return records.filter((record) =>
    [record.prompt, record.file, record.channel ?? '', record.model ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  )
}

/** What this file was built from. One hop: a chain is read step by step. */
export function sourcesOf(records: GenerationRecord[], file: string): string[] {
  return generationOf(records, file)?.references.map(toPosix) ?? []
}

/** What was built from this file, oldest first — the order the process happened in. */
export function usedBy(records: GenerationRecord[], file: string): GenerationRecord[] {
  const wanted = toPosix(file)
  return records
    .filter((record) => record.references.some((reference) => toPosix(reference) === wanted))
    .sort((a, b) => a.at - b.at)
}

/** One file reached from another, and how many hops away it is. */
export interface LineageNode {
  file: string
  /** 1 for a direct reference or a direct user, 2 for its reference, and so on. */
  depth: number
  /** The note that made it — absent when the file came from outside (an upload, a file on disk). */
  record: GenerationRecord | null
}

export interface Lineage {
  /** Everything this file was built from, breadth first. */
  upstream: LineageNode[]
  /** Everything built from it, breadth first. */
  downstream: LineageNode[]
}

/**
 * The lineage, several hops out — "find references" rather than "the one reference".
 *
 * Breadth first, so the nearest hop always comes first and a row's `depth` says what it is. The
 * start file is in the visited set before the walk begins, which is what makes a cycle (a picture
 * that was re-drawn from its own output) stop instead of looping: the graph is a graph, not a tree.
 */
export function relatedOf(
  records: GenerationRecord[],
  file: string,
  depth = 3,
): Lineage {
  const walk = (next: (at: string) => string[]): LineageNode[] => {
    const seen = new Set<string>([toPosix(file)])
    const reached: LineageNode[] = []
    let frontier = [toPosix(file)]
    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const following: string[] = []
      for (const at of frontier) {
        for (const candidate of next(at)) {
          const id = toPosix(candidate)
          if (seen.has(id)) continue
          seen.add(id)
          reached.push({ file: id, depth: level, record: generationOf(records, id) })
          following.push(id)
        }
      }
      frontier = following
    }
    return reached
  }

  return {
    upstream: walk((at) => sourcesOf(records, at)),
    downstream: walk((at) => usedBy(records, at).map((item) => item.file)),
  }
}
