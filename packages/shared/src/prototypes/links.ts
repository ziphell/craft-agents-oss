/**
 * Prototype links — how the documents point at each other.
 *
 * A specification is rarely one document. The one a `create` seeds is an entry point, and a
 * spec that outgrows a paragraph gets its own document beside it: a glossary, a flow as it
 * stands today, the detail behind one complex spec. What was missing was the *edge between
 * documents* — a note that says "the detail is over there" was a bare filename, unclickable, and
 * naming a document that had been renamed failed in silence.
 *
 * The syntax is **ordinary markdown**, deliberately:
 *
 * ```md
 * # Checkout, in detail
 *
 * The flow, the states and the error cases are in [the checkout document](docs/checkout.md).
 * ```
 *
 * A custom syntax (`[[…]]`, say) would be this app's own construct, and a specification carrying one
 * is a document only this app can read: everywhere else — a colleague, GitHub, an editor — the link
 * would be a pair of literal brackets, exactly the failure the diagrams in these documents were
 * switched away from (`![]()` rather than a preview-only fence, see `docs/prototypes.md`). Markdown
 * links read as links in every reader, and this app already knows how to open one.
 *
 * So what this module adds is only what markdown itself does not say:
 *
 * - **a relative destination is resolved against the document it is written in**, then the
 *   prototype's own folder — so `docs/checkout.md` from `spec.md` and `../spec.md` from a document
 *   under `docs/` both resolve;
 * - **a link that resolves to nothing is reported** — a missing target is the silent failure of an
 *   index, and the one thing a reader cannot see for themselves;
 * - **backlinks are the other half**, and the reason this is not the pointer list this workbench
 *   deliberately removed: a one-way reference can only report a typo, while a link read from both
 *   ends says which document to read next from either one.
 *
 * A link is **navigation, and nothing more**: it says where to read next. It never carries a claim
 * about the work — a paragraph that links to a document has not, by that act, said anything about
 * what exists.
 *
 * Only the prototype's own markdown is read. A link to a document names the file (with its
 * extension) — a destination the browser fetches on its own, an absolute path, a fragment, or a
 * relative destination that names no file is not this module's business, and is left alone.
 */

import { readFileSync } from 'fs'
import { isMarkdownFile, listPrototypeFiles } from './storage.ts'

/** One document pointing at another. */
export interface PrototypeLink {
  /** The document the link is written in — prototype-relative, e.g. `spec.md`, `docs/features.md`. */
  from: string
  /** What the link points at, as written minus its `#fragment`: `docs/checkout.md`. */
  target: string
  /** The prototype-relative path that resolves to, or null when it resolves to nothing. */
  to: string | null
}

export interface PrototypeLinks {
  /** In reading order: file path order, and each document's own order within it. */
  links: PrototypeLink[]
}

/**
 * An inline markdown link: `[text](destination)`, `[text](<destination>)`, with an optional title.
 * The text may not contain an unescaped bracket; the destination is either pointy-bracketed (how a
 * path with a space is written) or a run without whitespace or parentheses.
 */
const MARKDOWN_LINK_RE =
  /\[(?:[^[\]\\]|\\.)*\]\(\s*(<[^<>\n]*>|[^()\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g

/** Spans of the source that are code, where a link is an example rather than a link. */
function codeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  // Fenced blocks (` ``` ` or `~~~`), then inline spans outside them — the same reading the
  // renderer's own linkifier does.
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

/**
 * Whether a destination names a file beside the document.
 *
 * A link to a document names the file, extension and all. False for everything a browser fetches on
 * its own (`https:`, `data:`, `mailto:`, …), for an absolute path (`/…`, `C:\…`, `\\server\…`), and
 * for a fragment or a relative destination that names no file: none of them is "a document in this
 * folder", so none of them is this module's business.
 */
function isRelativeFileTarget(destination: string): boolean {
  if (!destination) return false
  if (destination.startsWith('/') || destination.startsWith('\\')) return false
  if (destination.startsWith('#')) return false
  if (/^[A-Za-z]:[\\/]/.test(destination)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination)) return false
  return /\.[A-Za-z0-9]{1,8}$/.test(destination)
}

/** Percent-decode a destination so `a%20file.md` resolves to the file the author meant. */
function decode(destination: string): string {
  if (!destination.includes('%')) return destination
  try {
    return decodeURIComponent(destination)
  } catch {
    return destination
  }
}

/**
 * The targets a document links to, in order and once each.
 *
 * Only relative destinations that name a file are read, and a `#fragment` is set aside — it names a
 * place inside the target, not a second file. A link inside a code span or a fenced block is an
 * example, not a link: the guide that explains this convention is written that way.
 */
export function extractLinkTargets(source: string): string[] {
  const ranges = codeRanges(source)
  const targets: string[] = []
  const seen = new Set<string>()

  for (const match of source.matchAll(MARKDOWN_LINK_RE)) {
    const at = match.index ?? 0
    if (ranges.some(([from, to]) => at >= from && at < to)) continue
    // `![alt](src)` is a picture, not a link: the `!` makes it an image, and an image is not a
    // document pointing at another one. Without this, every diagram in a specification would be
    // read as a reference to itself.
    if (source[at - 1] === '!') continue

    const raw = match[1] ?? ''
    const destination = (raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw).split('#')[0] ?? ''
    const target = decode(destination)

    if (!isRelativeFileTarget(target) || seen.has(target)) continue
    seen.add(target)
    targets.push(target)
  }

  return targets
}

/** The folder a document sits in, prototype-relative (`docs/features.md` → `docs`); empty at the root. */
function directoryOf(file: string): string {
  const index = file.lastIndexOf('/')
  return index === -1 ? '' : file.slice(0, index)
}

/**
 * Collapse `.` and `..` in a prototype-relative path, so a document in a subfolder can point back
 * past its own level (`../spec.md`) and mean it. Anything above the prototype's own folder is simply
 * dropped: a link cannot address anything outside the folder, and a path that climbs out is reported
 * as pointing at nothing rather than followed.
 */
function normalizeRelative(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * The file a target names, or null — the document's own folder first, then the prototype's.
 *
 * Deliberately narrow and unambiguous: a path, resolved, or nothing. There is no search and no
 * guess, because a link that stopped resolving is a fact to report rather than something to repair
 * from a resemblance.
 */
function resolveLink(target: string, from: string, known: Set<string>): string | null {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '')
  const directory = directoryOf(from)

  const candidates = directory
    ? [normalizeRelative(`${directory}/${normalized}`), normalizeRelative(normalized)]
    : [normalizeRelative(normalized)]

  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate
  }
  return null
}

/**
 * Read every link between a prototype's documents, and what could not be resolved.
 *
 * Never throws: a document that cannot be read is skipped (its absence from the report is a fact
 * about the disk), and a link is resolved only against files that are actually there.
 */
export function readPrototypeLinks(workspaceRootPath: string, slug: string): PrototypeLinks {
  const files = listPrototypeFiles(workspaceRootPath, slug)
  const known = new Set(files.map((file) => file.name))
  const links: PrototypeLink[] = []

  for (const file of files) {
    if (!isMarkdownFile(file.name)) continue

    let source: string
    try {
      source = readFileSync(file.path, 'utf-8')
    } catch {
      continue
    }

    for (const target of extractLinkTargets(source)) {
      // A target that resolves to nothing is left in the list as it is (`to: null`) rather than
      // reported here: the gate is where a link that points at nothing becomes a sentence
      // (`gate.linkBroken`), so naming it a second time here would print one fact twice.
      links.push({ from: file.name, target, to: resolveLink(target, file.name, known) })
    }
  }

  return { links }
}
