/**
 * Prototype links — how the documents point at each other.
 *
 * A specification is rarely one document. The one a `create` seeds is an entry point, and a
 * requirement that outgrows a paragraph gets its own document beside it: a glossary, a flow as it
 * stands today, the detail behind one complex requirement. What was missing was the *edge between
 * documents* — a note that says "the detail is over there" was a bare filename, unclickable, and
 * naming a document that had been renamed failed in silence.
 *
 * So a document may point at another with `[[…]]`:
 *
 * ```md
 * ## R-003 Checkout, in detail
 *
 * The flow, the states and the error cases live in [[docs/checkout.md]].
 * ```
 *
 * - a **path** (`[[docs/checkout.md]]`, `[[docs/checkout]]`) is read relative to the document it is
 *   written in first, then from the prototype's own folder;
 * - a **name** (`[[checkout]]`) matches a document by its file name, wherever it is — and is
 *   reported rather than guessed at when more than one file has that name.
 *
 * The backlink is the other half, and the reason this is not the pointer list this workbench
 * deliberately removed: a one-way reference can only report a typo, while a link read from both ends
 * says which document a reader should look at next from either one. `status` and the detail page
 * read the same `links` for both directions, so the two cannot disagree about who points at whom.
 *
 * What a link is **not** is a claim about the work: it is navigation. Whether a requirement is
 * implemented is still only `@requirement R-00x` (`coverage.ts`), or a link to a document would let
 * any paragraph quietly mark its own requirement done.
 *
 * Only markdown is read for links. `[[…]]` in a script is an array literal, and a link that exists
 * only because a file happens to contain brackets is the kind of false report this module is meant
 * to prevent rather than produce.
 */

import { readFileSync } from 'fs'
import { isMarkdownFile, listPrototypeFiles } from './storage.ts'
import { extractLinkTargets } from './wiki-links.ts'

/** One document pointing at another. */
export interface PrototypeLink {
  /** The document the link is written in — prototype-relative, e.g. `PRD.md`, `docs/features.md`. */
  from: string
  /**
   * The target as written, with a `|label` and a `#anchor` stripped: `docs/checkout.md`,
   * `docs/checkout`, `checkout`.
   */
  target: string
  /**
   * The prototype-relative path the target resolves to, or null when it resolves to nothing — the
   * broken link the report names.
   */
  to: string | null
}

export interface PrototypeLinks {
  /** In reading order: file path order, and each document's own order within it. */
  links: PrototypeLink[]
  /** Read problems, in their own words: a link that points at nothing, a name that matches two files. */
  issues: string[]
}

/**
 * The file names a target could name, extension included when the target does not carry one.
 *
 * `checkout` is a markdown document's name — that is the convention linking follows — while a target
 * that already has an extension (`checkout.md`, `cart.png`) is taken as itself.
 */
function extensionVariants(target: string): string[] {
  const last = target.slice(target.lastIndexOf('/') + 1)
  return last.includes('.') ? [target] : [`${target}.md`, `${target}.mdx`]
}

/** The folder a document sits in, prototype-relative (`docs/features.md` → `docs`); empty at the root. */
function directoryOf(file: string): string {
  const index = file.lastIndexOf('/')
  return index === -1 ? '' : file.slice(0, index)
}

/**
 * Collapse `.` and `..` in a prototype-relative path, so a document in a subfolder can point back
 * past its own level (`[[../PRD.md]]`) and mean it. Anything above the prototype's own folder is
 * simply dropped: a link cannot address anything outside the folder, and a path that climbs out is
 * reported as pointing at nothing rather than followed.
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
 * Where a target points, and — when a bare name is not unique — the files it could have meant.
 *
 * Deliberately narrow: the document's own folder, then the prototype's folder, then a unique file
 * name. No search, no fuzzy matching, and no guess: a name that matches two files is reported, not
 * resolved, because which one was meant is not something this can know.
 */
function resolveLink(
  target: string,
  from: string,
  files: readonly string[],
): { to: string | null; ambiguous: string[] | null } {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '')
  const directory = directoryOf(from)
  const known = new Set(files)

  for (const variant of extensionVariants(normalized)) {
    const relative = normalizeRelative(directory ? `${directory}/${variant}` : variant)
    if (known.has(relative)) return { to: relative, ambiguous: null }
    const fromRoot = normalizeRelative(variant)
    if (known.has(fromRoot)) return { to: fromRoot, ambiguous: null }
  }

  // A bare name is matched across the folder when no path does — Obsidian's habit, kept only where
  // it is unambiguous.
  if (!normalized.includes('/')) {
    const name = normalized.replace(/\.(?:md|mdx)$/i, '')
    const matches = files.filter(
      (file) => file.slice(file.lastIndexOf('/') + 1).replace(/\.(?:md|mdx)$/i, '') === name,
    )
    if (matches.length === 1) return { to: matches[0]!, ambiguous: null }
    if (matches.length > 1) return { to: null, ambiguous: matches }
  }

  return { to: null, ambiguous: null }
}

/**
 * Read every link in a prototype's markdown, and what could not be resolved.
 *
 * Never throws: a document that cannot be read is skipped (its absence from the report is a fact
 * about the disk), and a link is resolved only against files that are actually there.
 */
export function readPrototypeLinks(workspaceRootPath: string, slug: string): PrototypeLinks {
  const files = listPrototypeFiles(workspaceRootPath, slug)
  const names = files.map((file) => file.name)
  const links: PrototypeLink[] = []
  const issues: string[] = []

  for (const file of files) {
    if (!isMarkdownFile(file.name)) continue

    let source: string
    try {
      source = readFileSync(file.path, 'utf-8')
    } catch {
      continue
    }

    for (const target of extractLinkTargets(source)) {
      const { to, ambiguous } = resolveLink(target, file.name, names)
      links.push({ from: file.name, target, to })

      if (ambiguous) {
        issues.push(
          `${file.name} links to ${target}, which matches more than one file (${ambiguous.join(', ')}); say which one.`,
        )
      } else if (!to) {
        issues.push(`${file.name} links to ${target}, which is not in this prototype.`)
      }
    }
  }

  return { links, issues }
}
