/**
 * Wiki links — `[[…]]`, read and rewritten.
 *
 * The shape of a link between documents: what one looks like in the text, and how to turn one into
 * something a reader can click. Kept apart from `links.ts` (which resolves a target against the
 * disk, and therefore reaches the filesystem) because this half is pure text and both sides need
 * it: the workbench reads links out of a document to report them, and the panel rewrites the same
 * links as it draws that document. One parser, so what is reported and what is clickable cannot
 * disagree about which brackets are a link.
 *
 * **This module imports nothing, on purpose** — like `types.ts`, it is a leaf the renderer can take
 * a value from without dragging the node-only runtime into the browser bundle
 * (`docs/renderer-imports.md`).
 */

/** `[[target]]` or `[[target|label]]`; the inner text cannot cross a line or a bracket. */
const WIKI_LINK_RE = /\[\[([^[\]\n]+)\]\]/g

/** Spans of a source that are code, where `[[…]]` is text and not a link. */
function codeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  // Fenced blocks (` ``` ` or `~~~`), then inline spans outside them — the same reading the
  // renderer's own linkifier does, so a document shows and reports the same links.
  for (const match of source.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~/g)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
  }
  for (const match of source.matchAll(/(?<!`)`(?!`)([^`\n]+)`(?!`)/g)) {
    const start = match.index ?? 0
    if (!ranges.some(([from, to]) => start >= from && start < to)) {
      ranges.push([start, start + match[0].length])
    }
  }

  return ranges
}

interface ParsedWikiLink {
  /** Offset of the `[[` in the source. */
  at: number
  /** Length of the whole `[[…]]`. */
  length: number
  /** The target, with a `|label` and a `#anchor` stripped. */
  target: string
  /** The text to show (`[[target|label]]`), or null when the link has no label. */
  label: string | null
}

/**
 * Every wiki link in the source, in order.
 *
 * A literal `[[…]]` inside a code span or a fenced block is skipped: the guide that explains this
 * convention is written that way, and it should not create the links it is describing.
 */
function parseWikiLinks(source: string): ParsedWikiLink[] {
  const ranges = codeRanges(source)
  const parsed: ParsedWikiLink[] = []

  for (const match of source.matchAll(WIKI_LINK_RE)) {
    const at = match.index ?? 0
    if (ranges.some(([from, to]) => at >= from && at < to)) continue

    const inner = match[1] ?? ''
    const pipe = inner.indexOf('|')
    const rawTarget = pipe === -1 ? inner : inner.slice(0, pipe)
    // A `#heading` inside the target is an anchor: it names a place in the target, not a file, so it
    // is not part of what the link resolves to.
    const target = rawTarget.split('#')[0]?.trim() ?? ''
    if (!target) continue

    const rawLabel = pipe === -1 ? null : inner.slice(pipe + 1).trim()
    parsed.push({ at, length: match[0].length, target, label: rawLabel || null })
  }

  return parsed
}

/** The targets a document links to, in order and once each. */
export function extractLinkTargets(source: string): string[] {
  const targets: string[] = []
  const seen = new Set<string>()

  for (const link of parseWikiLinks(source)) {
    if (seen.has(link.target)) continue
    seen.add(link.target)
    targets.push(link.target)
  }

  return targets
}

/**
 * Rewrite each `[[…]]` into an ordinary markdown link, so a reader can click it.
 *
 * `destination` answers where a target points, in whatever shape the caller's renderer routes as a
 * file — and **null means the link resolves to nothing**, in which case it is left exactly as it was
 * written. A broken link is reported where it is reported; drawing it as a live-looking link to
 * somewhere invented would be worse than showing it plainly.
 *
 * The destination is wrapped in `<>` because a wiki link's target is a path, and a path may carry a
 * backslash (Windows) or a space: pointy brackets are the one markdown destination that takes both
 * literally.
 */
export function rewriteWikiLinks(
  source: string,
  destination: (target: string) => string | null,
): string {
  const links = parseWikiLinks(source)
  if (links.length === 0) return source

  let out = ''
  let cursor = 0
  for (const link of links) {
    out += source.slice(cursor, link.at)
    const to = destination(link.target)
    out +=
      to === null
        ? source.slice(link.at, link.at + link.length)
        : `[${link.label ?? link.target}](<${to}>)`
    cursor = link.at + link.length
  }

  return out + source.slice(cursor)
}
